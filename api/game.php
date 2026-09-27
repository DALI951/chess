<?php
declare(strict_types=1);

/**
 * api/game.php - everything about a game: create, seat, watch, move, resign, draw, chat.
 *
 * The whole multiplayer surface is one endpoint. Every action returns the same
 * shape - {ok, game, state} - so the client has one code path for "the server
 * said something new about this game" and no way to get them out of step.
 *
 * Polling is the transport. A game in progress is polled about twice a second by
 * the two players and about once a second by anyone watching, which on any host
 * this is ever going to run on is cheaper and far less breakable than a
 * websocket - and it survives the hosting being a shared PHP box that kills idle
 * connections.
 *
 * @author DALI951
 */

require_once __DIR__ . '/includes/bootstrap.php';

/**
 * The two players of a game, shaped for GameState::publicState().
 *
 * @param  array<string,mixed> $game
 * @return array<int,array<string,mixed>>
 */
function gamePlayers(array $game, ?int $nowMs = null): array
{
    $ids = [];
    foreach (['white_user', 'black_user'] as $side) {
        $id = $game[$side] ?? null;
        if ($id === null) { $ids[$side] = null; continue; }
        $ids[$side] = Db::one(
            'SELECT id, username, display_name, rating, last_seen_ms FROM users WHERE id = :id',
            ['id' => (int)$id]
        );
    }
    return array_values(array_filter($ids, static fn($r) => $r !== null));
}

/**
 * Stamp "which seat is the requester in" onto a public state.
 *
 * The client must not work this out for itself. A player who reloads mid-game
 * has two player objects and no way to be certain which one is them, and
 * guessing wrong means playing the opponent's pieces. The server knows, because
 * the server has the session; so the server says, and 'me' is null for a
 * spectator, which is a real answer rather than a default.
 *
 * @param  array<string,mixed> $state
 * @param  array<string,mixed>|null $me
 * @return array<string,mixed>
 */
function gameStampMe(array $state, ?array $me): array
{
    $uid = $me === null ? null : (int)$me['id'];
    $state['me'] = null;
    if ($uid !== null) {
        if (($state['white'] ?? null) && (int)$state['white']['id'] === $uid) $state['me'] = 'white';
        elseif (($state['black'] ?? null) && (int)$state['black']['id'] === $uid) $state['me'] = 'black';
    }
    return $state;
}

Http::endpoint(static function (): void {
    $action = Http::str('action', 20) ?: 'state';
    $me     = Auth::user();
    $now    = Db::nowMs();

    // A game can be named two ways: the numeric row id, or the six-character
    // room code. BOTH have to work in the "game" field, because that is the only
    // field the client sends.
    //
    // publicState() deliberately does not include the numeric id - sequential ids
    // tell a stranger how many games the site has, which is nobody's business -
    // so the code is the only identifier a client ever receives. It then used to
    // do state.gameId = Number(code) on it, and Number("ABC123") is NaN, so every
    // poll went out as game=NaN and came back no_such_game, forever. The game
    // never updated and no error ever appeared on the page: the board just sat
    // there. Resolving the code as well as the id makes the endpoint work for
    // either spelling, so a client bug can never again be a dead board.
    $gameParam = Http::str('game', 12);
    $gameId    = ($gameParam !== '' && ctype_digit($gameParam)) ? (int)$gameParam : 0;

    $loadGame = static function () use ($gameId, $gameParam): array {
        $code = ($gameId === 0 && $gameParam !== '') ? $gameParam : Http::str('code', 12);
        $g = $gameId > 0
            ? GameRepo::byId($gameId)
            : ($code !== '' ? GameRepo::find($code) : null);
        if ($g === null) throw new HttpError('no_such_game', 'That game does not exist.', 404);
        return $g;
    };

    // -- reading: public, cheap, no account needed ----------------------------
    if ($action === 'state' || $action === 'poll') {
        $game   = $loadGame();
        $since  = Http::int('since_move', 0);
        $moves  = GameRepo::sans($game['id']);
        $fresh  = $game;
        $changed = false;

        // A flag can fall between two requests, so every poll asks the clock the
        // same question the next move would ask. Otherwise a player whose
        // opponent flagged keeps staring at a running clock until they happen to
        // try to move, and the game sits there ACTIVE forever.
        //
        // Both browsers discover the same timeout, so the write is conditional on
        // the game still being ACTIVE: exactly one of them ends it, and exactly
        // one settles the rating. The loser of that race is told the game is over
        // and writes nothing.
        if ($game['status'] === GameState::ACTIVE) {
            $c = GameState::clock($game, $now);
            if ($c['white'] <= 0 || $c['black'] <= 0) {
                GameRepo::endByTimeoutIfActive($game, $c['white'] <= 0 ? 'white' : 'black', $now);
                $fresh = GameRepo::byId((int)$game['id']) ?? $fresh;
                $changed = true;
            } else {
                $fresh['white_ms'] = $c['white'];
                $fresh['black_ms'] = $c['black'];
            }
        }
        if (count($moves) !== $since) $changed = true;

        Http::done([
            'game'            => gameStampMe(GameState::publicState($fresh, gamePlayers($fresh, $now), $moves, $now), $me),
            'ply'             => count($moves),
            'draw_offered_by' => GameRepo::drawOfferedBy($game['id']),
            'changed'         => $changed,
            'now_ms'          => $now,
        ]);
    }

    if ($action === 'chat') {
        Http::throttle('chat', 40, 20);
        $game = $loadGame();
        if (Http::str('body', 600) !== '' || Http::has('body')) {
            if ($me === null) throw new HttpError('not_logged_in', 'Log in to talk.', 401);
            $msg = Chat::post($game['id'], (int)$me['id'], Http::str('body', 600));
            Http::done(['message' => $msg, 'now_ms' => $now]);
        }
        Http::done([
            'messages' => Chat::history($game['id'], Http::int('after', 0), 100),
            'now_ms'   => $now,
        ]);
    }

    // -- writing: needs an account -------------------------------------------
    if ($me === null) throw new HttpError('not_logged_in', 'Log in first.', 401);

    switch ($action) {
        case 'create':
            Http::throttle('create', 12, 6);
            $base  = Http::int('tc_base_ms', 600_000);
            $incr  = Http::int('tc_increment_ms', 0);
            $fenIn = Http::str('fen', 120);
            if ($base < 0 || $base > 1000 * 60 * 60 * 6) {
                throw new HttpError('bad_time', 'Time control out of range.', 422);
            }
            if ($incr < 0 || $incr > 60_000) {
                throw new HttpError('bad_time', 'Increment out of range.', 422);
            }
            $game = GameState::create([
                'white_user'      => (int)$me['id'],
                'black_user'      => Http::bool('open') ? null : (int)$me['id'],
                'tc_base_ms'      => $base,
                'tc_increment_ms' => $incr,
                'fen'             => $fenIn !== '' ? gameSanitiseFen($fenIn) : Chess::START_FEN,
                'now_ms'          => $now,
            ]);
            // insert() decides the code: on a collision it tries another one, and
            // the code it settled on is the one in the row. Taking it from the
            // return value is what stops a retry handing the player a code that
            // belongs to somebody else's room.
            $inserted = GameRepo::insert($game);
            $game['id']   = $inserted['id'];
            $game['code'] = $inserted['code'];
            GameRepo::expireStale($now);
            Http::done([
                'game'   => gameStampMe(GameState::publicState($game, gamePlayers($game, $now), [], $now), $me),
                'code'   => $game['code'],
                'now_ms' => $now,
            ]);

        case 'quick':
            // Quick match. Matchmaking is a read of the open games plus a seat,
            // so the only cost worth limiting is the one that writes - and a
            // search that finds nobody writes one row.
            Http::throttle('quick', 15, 8);
            $base  = Http::int('tc_base_ms', 600_000);
            $incr  = Http::int('tc_increment_ms', 0);
            $fenIn = Http::str('fen', 120);
            if ($base < 0 || $base > 1000 * 60 * 60 * 6) {
                throw new HttpError('bad_time', 'Time control out of range.', 422);
            }
            if ($incr < 0 || $incr > 60_000) {
                throw new HttpError('bad_time', 'Increment out of range.', 422);
            }
            $found = GameRepo::match(
                (int)$me['id'],
                $base,
                $incr,
                $fenIn !== '' ? gameSanitiseFen($fenIn) : Chess::START_FEN,
                $now
            );
            GameRepo::expireStale($now);
            Http::done([
                'game'    => gameStampMe(GameState::publicState($found['game'], gamePlayers($found['game'], $now), [], $now), $me),
                'code'    => $found['code'],
                // false means "nobody was there, so you are the queue now" - the
                // client just keeps polling, which is the waiting-for-opponent UI
                'matched' => $found['matched'],
                'now_ms'  => $now,
            ]);

        case 'join':
            Http::throttle('join', 20, 10);
            $game   = $loadGame();
            $seated = GameRepo::seat($game['id'], (int)$me['id'], $now);
            Http::done([
                'game'   => gameStampMe(GameState::publicState($seated['game'], gamePlayers($seated['game'], $now), GameRepo::sans($game['id']), $now), $me),
                'error'  => $seated['error'],
                'now_ms' => $now,
            ]);

        case 'move':
            Http::throttle('move', 90, 30);
            $game   = $loadGame();
            $result = GameRepo::play($game['id'], (int)$me['id'], [
                'from'      => Http::str('from', 2),
                'to'        => Http::str('to', 2),
                'promotion' => Http::str('promotion', 1) ?: null,
            ]);
            $after = $result['game'];
            Http::done([
                'game'   => gameStampMe(GameState::publicState($after, gamePlayers($after), GameRepo::sans($after['id']), $now), $me),
                'move'   => $result['move'],
                'error'  => $result['error'],
                'now_ms' => $now,
            ]);

        case 'resign':
            Http::throttle('resign', 6, 3);
            $game  = $loadGame();
            $after = GameRepo::resign($game['id'], (int)$me['id'])['game'];
            Http::done([
                'game'   => gameStampMe(GameState::publicState($after, gamePlayers($after), GameRepo::sans($after['id']), $now), $me),
                'now_ms' => $now,
            ]);

        case 'draw':
            Http::throttle('draw', 12, 6);
            $game = $loadGame();
            if (Http::bool('decline')) {
                GameRepo::declineDraw($game['id'], (int)$me['id']);
                Http::done(['error' => 'declined', 'draw_offered_by' => null, 'now_ms' => $now]);
            }
            $out = GameRepo::offerDraw($game['id'], (int)$me['id']);
            Http::done([
                'game'            => gameStampMe(GameState::publicState($out['game'], gamePlayers($out['game']), GameRepo::sans($game['id']), $now), $me),
                'error'           => $out['error'],
                'draw_offered_by' => $out['error'] === 'offered' ? (int)$me['id'] : null,
                'now_ms'          => $now,
            ]);

        case 'list':
            Http::throttle('list', 60, 20);
            $shape = static function (array $g) use ($now): array {
                $s = GameState::publicState($g, gamePlayers($g, $now), GameRepo::sans($g['id']), $now);
                return [
                    'code' => $s['code'], 'status' => $s['status'],
                    'white' => $s['white'], 'black' => $s['black'],
                    'tc' => $s['tc'], 'ply' => $s['ply'],
                    'result' => $s['result'], 'reason' => $s['reason'],
                    'updated_ms' => $s['updated_ms'],
                ];
            };
            Http::done([
                'mine'   => array_map($shape, GameRepo::forUser((int)$me['id'], 30)),
                'recent' => array_map($shape, GameRepo::publicRecent(20)),
                'now_ms' => $now,
            ]);

        default:
            throw new HttpError('bad_action', 'Unknown action: ' . $action, 400);
    }
});

/**
 * A FEN from a client is only trusted after the engine has parsed it, and the
 * canonical one is stored rather than the one that was sent. A player who pastes
 * a FEN with six kings gets the position the engine can actually reason about,
 * or an error.
 */
function gameSanitiseFen(string $fen): string
{
    try {
        $e = new Chess($fen);
    } catch (Throwable) {
        throw new HttpError('bad_fen', 'That is not a position I understand.', 422);
    }
    if ($e->isGameOver()) {
        throw new HttpError('bad_fen', 'That position is already over.', 422);
    }
    return $e->fen();
}
