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

Http::endpoint(static function (): void {
    $action = Http::str('action', 20) ?: 'state';
    $me     = Auth::user();
    $now    = Db::nowMs();
    $gameId = Http::int('game');

    $loadGame = static function () use ($gameId): array {
        $g = $gameId > 0 ? GameRepo::byId($gameId) : GameRepo::find(Http::str('code', 12));
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
        if ($game['status'] === GameState::ACTIVE) {
            $c = GameState::clock($game, $now);
            if ($c['white'] <= 0 || $c['black'] <= 0) {
                $fresh = GameState::endByTimeout($game, $c['white'] <= 0 ? 'white' : 'black', $now);
                GameRepo::save($fresh);
                $changed = true;
            } else {
                $fresh['white_ms'] = $c['white'];
                $fresh['black_ms'] = $c['black'];
            }
        }
        if (count($moves) !== $since) $changed = true;

        Http::done([
            'game'            => GameState::publicState($fresh, gamePlayers($fresh, $now), $moves, $now),
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
            $game['id'] = GameRepo::insert($game);
            GameRepo::expireStale($now);
            Http::done([
                'game'   => GameState::publicState($game, gamePlayers($game, $now), [], $now),
                'code'   => $game['code'],
                'now_ms' => $now,
            ]);

        case 'join':
            Http::throttle('join', 20, 10);
            $game   = $loadGame();
            $seated = GameRepo::seat($game['id'], (int)$me['id'], $now);
            Http::done([
                'game'   => GameState::publicState($seated['game'], gamePlayers($seated['game'], $now), GameRepo::sans($game['id']), $now),
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
                'game'   => GameState::publicState($after, gamePlayers($after), GameRepo::sans($after['id']), $now),
                'move'   => $result['move'],
                'error'  => $result['error'],
                'now_ms' => $now,
            ]);

        case 'resign':
            Http::throttle('resign', 6, 3);
            $game  = $loadGame();
            $after = GameRepo::resign($game['id'], (int)$me['id'])['game'];
            Http::done([
                'game'   => GameState::publicState($after, gamePlayers($after), GameRepo::sans($after['id']), $now),
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
                'game'            => GameState::publicState($out['game'], gamePlayers($out['game']), GameRepo::sans($game['id']), $now),
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
