<?php
declare(strict_types=1);

/**
 * The schema lives here and nowhere else.
 *
 * Two things are worth saying about how a move is saved.
 *
 * First, the game row is locked FOR UPDATE before it is read. Without that, two
 * players clicking at the same moment both read ply 5, both play a legal move,
 * and both write ply 6 - and the second one silently erases the first. This is
 * the only reason a chess server needs a transaction, and it is why every write
 * path here goes through tx().
 *
 * Second, moves are stored as SAN in their own table rather than as a string on
 * the game row. Replay needs them, repetition detection needs them, and a PGN is
 * them. Keeping them in one place means there is exactly one answer to "what
 * moves were played in this game".
 *
 * @author DALI951
 */
final class GameRepo
{
    /** Elo K-factor. 32 is the classic value: ~16 games to settle a new player. */
    private const K = 32;

    private const COLUMNS = 'id, code, status, white_user, black_user, fen, ply, sans, pgn,
                             tc_base_ms, tc_increment_ms, white_ms, black_ms,
                             turn_started_at_ms, turn_started_ms, result, reason,
                             winner_user, ended_at_ms, created_ms, updated_ms';

    /** Games nobody has touched in this long are over as far as anybody cares. */
    private const STALE_MS = 1000 * 60 * 60 * 24 * 30;

    /**
     * @return array<string,mixed>|null
     */
    public static function byId(int $id): ?array
    {
        $row = Db::one('SELECT ' . self::COLUMNS . ' FROM games WHERE id = :id', ['id' => $id]);
        return $row === null ? null : self::cast($row);
    }

    /** @return array<string,mixed>|null */
    public static function byCode(string $code): ?array
    {
        $code = strtoupper(trim($code));
        if (!preg_match('/^[A-Z0-9]{6}$/', $code)) return null;
        $row = Db::one('SELECT ' . self::COLUMNS . ' FROM games WHERE code = :c', ['c' => $code]);
        return $row === null ? null : self::cast($row);
    }

    /**
     * Look a game up by code OR id, so the client can paste either.
     *
     * @return array<string,mixed>|null
     */
    public static function find(string $handle): ?array
    {
        $handle = trim($handle);
        if ($handle === '') return null;
        if (ctype_digit($handle)) {
            $byId = self::byId((int)$handle);
            if ($byId !== null) return $byId;
        }
        return self::byCode($handle);
    }

    /**
     * The moves of a game, oldest first.
     *
     * @return array<int,string>
     */
    public static function sans(int $gameId): array
    {
        $rows = Db::all('SELECT san FROM game_moves WHERE game_id = :g ORDER BY ply', ['g' => $gameId]);
        return array_map(static fn(array $r): string => (string)$r['san'], $rows);
    }

    /**
     * @param  array<string,mixed> $game
     * @return array{id:int,code:string} the id AND the code that was actually used
     */
    public static function insert(array $game): array
    {
        // The code space is 23^6, about 148 million rooms, so a clash is rare -
        // and rare is not never. A collision used to be a 500 for the player who
        // hit it, on the one request that mattered. Five tries puts it far past
        // any birthday bound, and the give-up path is an honest error rather
        // than a crash.
        //
        // The code that ends up in the row is returned ALONGSIDE the id, because
        // a retry may have replaced it. This function used to return only the id
        // and set $game['code'] on its own local copy, which PHP does not hand
        // back to the caller - so after a collision the caller still held the
        // code that was ALREADY TAKEN, and cheerfully showed it to the player as
        // the room to invite somebody into. A room they did not have.
        for ($attempt = 1; $attempt <= 5; $attempt++) {
            $code = $game['code'] !== '' && $attempt === 1 ? (string)$game['code'] : GameState::code();
            try {
                $id = Db::tx(static function () use ($game, $code): int {
                    Db::run(
                        'INSERT INTO games (code, status, white_user, black_user, fen, ply, sans, pgn,
                                            tc_base_ms, tc_increment_ms, white_ms, black_ms,
                                            turn_started_at_ms, turn_started_ms, created_ms, updated_ms)
                              VALUES (:code, :status, :white, :black, :fen, 0, :sans, :pgn,
                                      :base, :incr, :white_ms, :black_ms,
                                      :tsat, :tsm, :now, :now)',
                        [
                            'code'      => $code,
                            'status'    => $game['status'],
                            'white'     => $game['white_user'],
                            'black'     => $game['black_user'],
                            'fen'       => $game['fen'],
                            'sans'      => $game['sans'],
                            'pgn'       => $game['pgn'],
                            'base'      => $game['tc_base_ms'],
                            'incr'      => $game['tc_increment_ms'],
                            'white_ms'  => $game['white_ms'],
                            'black_ms'  => $game['black_ms'],
                            'tsat'      => $game['turn_started_at_ms'],
                            'tsm'       => $game['turn_started_ms'],
                            'now'       => Db::nowMs(),
                        ]
                    );
                    return (int)Db::conn()->lastInsertId();
                });
                return ['id' => $id, 'code' => $code];
            } catch (PDOException $e) {
                // 23000 is any integrity violation. uq_code is the only one this
                // INSERT can hit that a retry could fix; a foreign key problem is
                // a real bug and must not be hidden by retrying it five times.
                if ($e->getCode() !== '23000' || !str_contains($e->getMessage(), 'uq_code')) {
                    throw $e;
                }
                error_log("chess: room code {$code} was taken, trying again ({$attempt})");
            }
        }
        throw new HttpError('code_exhausted', 'Could not find a free room code. Try again.', 503);
    }

    /**
     * @param array<string,mixed> $game
     */
    public static function save(array $game): void
    {
        Db::run(
            'UPDATE games SET status = :status, fen = :fen, ply = :ply, sans = :sans, pgn = :pgn,
                              white_ms = :white_ms, black_ms = :black_ms,
                              turn_started_at_ms = :tsat, turn_started_ms = :tsm,
                              result = :result, reason = :reason, winner_user = :winner,
                              ended_at_ms = :ended, updated_ms = :now
                    WHERE id = :id',
            [
                'id'        => (int)$game['id'],
                'status'    => $game['status'],
                'fen'       => $game['fen'],
                'ply'       => (int)$game['ply'],
                'sans'      => $game['sans'],
                'pgn'       => $game['pgn'],
                'white_ms'  => (int)$game['white_ms'],
                'black_ms'  => (int)$game['black_ms'],
                'tsat'      => $game['turn_started_at_ms'],
                'tsm'       => $game['turn_started_ms'],
                'result'    => $game['result'],
                'reason'    => $game['reason'],
                'winner'    => $game['winner_user'],
                'ended'     => $game['ended_at_ms'],
                'now'       => Db::nowMs(),
            ]
        );
    }

    /** @param array<string,mixed> $game */
    public static function addMove(int $gameId, array $game, array $move): void
    {
        Db::run(
            'INSERT INTO game_moves (game_id, ply, san, uci, fen_after, white_ms, black_ms, made_ms)
                  VALUES (:g, :ply, :san, :uci, :fen, :white_ms, :black_ms, :now)',
            [
                'g'         => $gameId,
                'ply'       => (int)$move['ply'],
                'san'       => (string)$move['san'],
                'uci'       => (string)($move['uci'] ?? ''),
                'fen'       => (string)$move['fen'],
                'white_ms'  => (int)$move['white_ms'],
                'black_ms'  => (int)$move['black_ms'],
                'now'       => Db::nowMs(),
            ]
        );
    }

    /**
     * Play a move. The whole thing is one transaction, and the game row is locked
     * for the duration: read, decide, write, or not at all.
     *
     * @param  array<string,mixed> $move  {from,to,promotion?} or {san}
     * @return array<string,mixed> {ok, error, game, move}
     */
    public static function play(int $gameId, int $userId, array $move): array
    {
        $now = Db::nowMs();
        return Db::tx(static function () use ($gameId, $userId, $move, $now): array {
            $row = Db::one('SELECT ' . self::COLUMNS . ' FROM games WHERE id = :id FOR UPDATE', ['id' => $gameId]);
            if ($row === null) {
                throw new HttpError('no_such_game', 'That game does not exist.', 404);
            }
            $game = self::cast($row);
            $sans = self::sans($gameId);
            $result = GameState::applyMove($game, $move, $userId, $now);

            if ($result['error'] === 'not_playing' || $result['error'] === 'not_your_turn'
                || $result['error'] === 'not_a_player' || $result['error'] === 'already_over') {
                // nothing changed, so nothing is written; the client is told why
                return $result;
            }
            $game = $result['game'];
            if ($result['error'] === 'flag') {
                self::save($game);
                // A flag fall is an ending like any other: the player who ran out
                // of time loses, and their rating says so. It is easy to leave
                // this one out because the move itself was never made.
                self::settleRatings($game);
                return $result;
            }
            if ($result['error'] === 'illegal_move') {
                throw new HttpError('illegal_move', 'That move is not legal.', 422);
            }
            self::save($game);
            self::addMove($gameId, $game, $result['move']);
            // A game that ended on this move (mate, stalemate, a fifty-move
            // counter, a flag) settles the ratings HERE, inside the same
            // transaction that wrote the result. Doing it in the endpoint instead
            // would leave a result with no rating whenever the second write
            // failed, and nobody would notice until a player wondered why their
            // win did not count.
            self::settleRatings($game);
            return $result;
        });
    }

    /**
     * Move the two ratings, and the two records, once a game is over.
     *
     * Plain Elo, K=32, expected score from the two ratings. Deliberately not
     * Glicko: a rating system that is subtly wrong is worse than a simple one,
     * because the wrongness is invisible. This one is four lines you can check.
     *
     * @param array<string,mixed> $game a game row whose status is already ENDED
     */
    public static function settleRatings(array $game): void
    {
        $rated = !empty($game['rated']);
        $white = (int)($game['white_user'] ?? 0);
        $black = (int)($game['black_user'] ?? 0);
        // Both seats must be real accounts. A game against a guest, or one that
        // has not been given a black seat yet, is not rated - and half-applying
        // a rating to the one player who has an account is worse than not rating.
        if (!$rated || $white === 0 || $black === 0) {
            return;
        }
        $result = $game['result'] === null ? null : (int)$game['result'];
        if ($result === null) {
            return;
        }

        $rows = Db::all(
            'SELECT id, rating FROM users WHERE id IN (:w, :b)',
            ['w' => $white, 'b' => $black]
        );
        $rating = [];
        foreach ($rows as $r) {
            $rating[(int)$r['id']] = (int)$r['rating'];
        }
        if (!isset($rating[$white], $rating[$black])) {
            return;                     // an account was deleted mid-game
        }

        // score is from this seat's point of view. result is from WHITE's, which
        // is the single most bug-prone number in this file: getting it wrong
        // makes the loser climb the leaderboard.
        $scoreWhite = $result === 1 ? 1.0 : ($result === 0 ? 0.5 : 0.0);
        $scoreBlack = 1.0 - $scoreWhite;
        $expectedWhite = 1.0 / (1.0 + 10 ** (($rating[$black] - $rating[$white]) / 400.0));
        $expectedBlack = 1.0 - $expectedWhite;

        $whiteGain = (int)round(self::K * ($scoreWhite - $expectedWhite));
        $blackGain = (int)round(self::K * ($scoreBlack - $expectedBlack));

        $upd = static function (int $userId, int $gain, string $outcome): void {
            Db::run(
                'UPDATE users
                    SET rating = GREATEST(100, rating + :gain),
                        games_played = games_played + 1,
                        wins   = wins   + (CASE WHEN :o = \'w\' THEN 1 ELSE 0 END),
                        draws  = draws  + (CASE WHEN :o = \'d\' THEN 1 ELSE 0 END),
                        losses = losses + (CASE WHEN :o = \'l\' THEN 1 ELSE 0 END)
                  WHERE id = :id',
                ['gain' => $gain, 'o' => $outcome, 'id' => $userId]
            );
        };
        // GREATEST(100, ...) is a floor, not a rule about the algorithm: Elo is
        // unbounded downward and a beginner who keeps losing would otherwise
        // grind to a rating that reads like a different person.
        $upd($white, $whiteGain, $result === 1 ? 'w' : ($result === 0 ? 'd' : 'l'));
        $upd($black, $blackGain, $result === -1 ? 'w' : ($result === 0 ? 'd' : 'l'));
    }

    /**
     * End a game that ran out of time, but only if it is still going.
     *
     * A flag can fall between two requests, so every poll asks the clock the same
     * question the next move would ask - which means BOTH players' browsers
     * discover the same timeout, microseconds apart. Ending the game from the
     * endpoint made that a double write, and settling ratings there made it a
     * double rating: one game counted twice, one player's win worth 32 points.
     *
     * So the write is conditional on the row still being ACTIVE, and only the
     * call whose UPDATE actually changed the row is the one that settles. The
     * other one is told the game is over and changes nothing.
     *
     * @param  array<string,mixed> $game
     * @return bool true if THIS call is the one that ended the game
     */
    public static function endByTimeoutIfActive(array $game, string $loserColor, int $now): bool
    {
        $fresh = GameState::endByTimeout($game, $loserColor, $now);
        $st = Db::run(
            'UPDATE games SET status = :status, result = :result, reason = :reason, winner_user = :winner,
                              turn_started_at_ms = NULL, ended_at_ms = :ended, updated_ms = :ended
              WHERE id = :id AND status = :active',
            [
                'status' => $fresh['status'],
                'result' => $fresh['result'],
                'reason' => $fresh['reason'],
                'winner' => $fresh['winner_user'],
                'ended'  => $now,
                'id'     => (int)$game['id'],
                'active' => GameState::ACTIVE,
            ]
        );
        if ($st->rowCount() === 0) {
            return false;               // somebody else got here first
        }
        self::settleRatings($fresh);
        return true;
    }

    /**
     * @param  array<string,mixed> $game
     * @return array<string,mixed>
     */
    public static function resign(int $gameId, int $userId): array
    {
        $now = Db::nowMs();
        return Db::tx(static function () use ($gameId, $userId, $now): array {
            $row = Db::one('SELECT ' . self::COLUMNS . ' FROM games WHERE id = :id FOR UPDATE', ['id' => $gameId]);
            if ($row === null) throw new HttpError('no_such_game', 'That game does not exist.', 404);
            $game = self::cast($row);
            if ($game['status'] === GameState::ENDED) {
                throw new HttpError('already_over', 'This game is already over.', 409);
            }
            $game = GameState::endByResign($game, $userId, $now);
            self::save($game);
            self::settleRatings($game);
            return ['ok' => true, 'error' => null, 'game' => $game, 'move' => null];
        });
    }

    /**
     * Agree a draw. Both players have to press it, and the offer is the first
     * press: one player cannot end a game on their own by asking nicely.
     *
     * @return array<string,mixed>
     */
    public static function offerDraw(int $gameId, int $userId): array
    {
        $now = Db::nowMs();
        return Db::tx(static function () use ($gameId, $userId, $now): array {
            $row = Db::one('SELECT ' . self::COLUMNS . ' FROM games WHERE id = :id FOR UPDATE', ['id' => $gameId]);
            if ($row === null) throw new HttpError('no_such_game', 'That game does not exist.', 404);
            $game = self::cast($row);
            if ($game['status'] !== GameState::ACTIVE) {
                throw new HttpError('already_over', 'This game is not playing.', 409);
            }
            // Only somebody SITTING in this game may touch the draw. Moves and
            // resignations both check this; the draw offer did not, so any logged-in
            // account could walk up to a stranger's game, offer a draw, accept it
            // themselves, and end it. The second press below treats "the other
            // side" as whoever is not the offerer, so a non-player passing
            // themselves off as the opponent ends the game without a second
            // person ever agreeing to anything.
            if ((int)($game['white_user'] ?? 0) !== $userId && (int)($game['black_user'] ?? 0) !== $userId) {
                throw new HttpError('not_a_player', 'You are not playing in this game.', 403);
            }
            $offered = self::drawOfferedBy($gameId);
            if ($offered === null) {
                Db::run(
                    'INSERT INTO game_draw_offers (game_id, user_id, created_ms) VALUES (:g, :u, :now)
                     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), created_ms = VALUES(created_ms)',
                    ['g' => $gameId, 'u' => $userId, 'now' => $now]
                );
                return ['ok' => true, 'error' => 'offered', 'game' => $game];
            }
            if ($offered === $userId) {
                return ['ok' => true, 'error' => 'already_offered', 'game' => $game];
            }
            Db::run('DELETE FROM game_draw_offers WHERE game_id = :g', ['g' => $gameId]);
            $game = GameState::endByAgreement($game, $now);
            self::save($game);
            self::settleRatings($game);
            return ['ok' => true, 'error' => 'agreed', 'game' => $game];
        });
    }

    public static function declineDraw(int $gameId, int $userId): void
    {
        $offered = self::drawOfferedBy($gameId);
        if ($offered !== null && $offered !== $userId) {
            Db::run('DELETE FROM game_draw_offers WHERE game_id = :g', ['g' => $gameId]);
        }
    }

    public static function drawOfferedBy(int $gameId): ?int
    {
        $v = Db::value('SELECT user_id FROM game_draw_offers WHERE game_id = :g', ['g' => $gameId]);
        return $v === null ? null : (int)$v;
    }

    /**
     * Accept a challenge: fill the empty seat.
     *
     * @return array<string,mixed>
     */
    public static function seat(int $gameId, int $userId, int $now): array
    {
        return Db::tx(static function () use ($gameId, $userId, $now): array {
            $row = Db::one('SELECT ' . self::COLUMNS . ' FROM games WHERE id = :id FOR UPDATE', ['id' => $gameId]);
            if ($row === null) throw new HttpError('no_such_game', 'That game does not exist.', 404);
            $game = self::cast($row);

            if ($game['status'] !== GameState::WAITING) {
                throw new HttpError('not_waiting', 'That game is not waiting for an opponent.', 409);
            }
            if ($game['white_user'] === $userId) {
                return ['ok' => true, 'error' => 'already_seated', 'game' => $game];
            }
            if ($game['black_user'] === $userId) {
                return ['ok' => true, 'error' => 'already_seated', 'game' => $game];
            }
            if ($game['white_user'] !== null) {
                throw new HttpError('seat_taken', 'Somebody already took that seat.', 409);
            }
            // the challenger is black, and the clock starts NOW: not when the game
            // was created, not when the link was made, now
            $game['black_user']     = $userId;
            $game['status']         = GameState::ACTIVE;
            $game['turn_started_at_ms'] = $now;
            $game['turn_started_ms']    = (int)$game['white_ms'];
            $game['updated_at_ms']  = $now;
            self::save($game);
            return ['ok' => true, 'error' => null, 'game' => $game];
        });
    }

    /**
     * Games a player should see, newest first.
     *
     * @return array<int,array<string,mixed>>
     */
    public static function forUser(int $userId, int $limit = 30): array
    {
        $rows = Db::all(
            'SELECT ' . self::COLUMNS . ' FROM games
              WHERE white_user = :u OR black_user = :u
              ORDER BY updated_ms DESC LIMIT ' . max(1, min(100, $limit)),
            ['u' => $userId]
        );
        return array_map([self::class, 'cast'], $rows);
    }

    /**
     * Games anyone can watch, newest first. Spectating is not a feature that
     * needs a database: finished games are public by definition.
     *
     * @return array<int,array<string,mixed>>
     */
    public static function publicRecent(int $limit = 25): array
    {
        // Both seats filled, so nobody can watch a half-made game. Parens on
        // purpose: without them AND binds tighter than OR and the lobby ends up
        // showing a different set of games than the comment above promises.
        $rows = Db::all(
            'SELECT ' . self::COLUMNS . ' FROM games
              WHERE (white_user IS NOT NULL AND black_user IS NOT NULL)
              ORDER BY updated_ms DESC LIMIT ' . max(1, min(100, $limit))
        );
        return array_map([self::class, 'cast'], $rows);
    }

    /** Mark games nobody came back to, so the lobby is not full of ghosts. */
    public static function expireStale(int $now): int
    {
        $st = Db::run(
            "UPDATE games SET status = 'ended', reason = 'abandoned', updated_ms = :now
              WHERE status IN ('waiting','active') AND updated_ms < :cut",
            ['now' => $now, 'cut' => $now - self::STALE_MS]
        );
        return $st->rowCount();
    }

    /**
     * @param  array<string,mixed> $row
     * @return array<string,mixed>
     */
    public static function cast(array $row): array
    {
        // Everything that reaches PHP as a string leaves as the type the rules
        // code expects. A "0" that arrives as the string "0" is truthy in PHP,
        // and a game that thinks it is finished because its result is truthy is
        // the sort of thing that only shows up for the player who resigned.
        foreach (['id', 'ply', 'tc_base_ms', 'tc_increment_ms', 'white_ms', 'black_ms',
                  'turn_started_at_ms', 'turn_started_ms', 'result', 'winner_user',
                  'ended_at_ms', 'created_ms', 'updated_ms', 'white_user', 'black_user'] as $k) {
            if (array_key_exists($k, $row)) {
                $row[$k] = $row[$k] === null ? null : (int)$row[$k];
            }
        }
        return $row;
    }
}
