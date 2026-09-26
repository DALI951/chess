<?php
declare(strict_types=1);

/**
 * The rules of an online game, with no database anywhere in sight.
 *
 * This class exists because it is the part that is hard to get right and easy to
 * test. Everything it decides is a decision about a plain array, so the test
 * suite can drive a whole game — turn order, increments, flag falls, mate,
 * every draw reason — without MySQL, without HTTP and without a browser. The
 * SQL layer's only job is to load a row, hand it here, and write back what comes
 * out.
 *
 * TIME IS AN INTEGER NUMBER OF MILLISECONDS SINCE THE EPOCH, everywhere.
 *
 * That is a deliberate choice over a DATETIME. A chess clock is the one thing in
 * this app where a timezone bug is catastrophic and invisible: the rows would
 * look fine, the SQL would be fine, and the clocks would be wrong by hours. An
 * integer has no timezone to get wrong, needs no conversion, and is directly
 * comparable. The client gets `now_ms` in the response and interpolates against
 * its own performance clock, so nobody's wall clock is ever trusted.
 *
 * @author DALI951
 */
final class GameState
{
    public const WAITING  = 'waiting';
    public const ACTIVE   = 'active';
    public const ENDED    = 'ended';
    public const ABANDONED = 'abandoned';

    public const UNLIMITED = 0;   // tc_base_ms of 0 means "do not run a clock"

    /**
     * Room codes are read aloud, typed by hand and read off a shared screen, so
     * the alphabet drops every character that is confusable with another:
     * I/1, L/1, O/0, S/5, Z/2, B/8, G/6, Y/7. What is left cannot be misread
     * twice in the same way, which matters more than the tiny loss of entropy.
     */
    public const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';

    /**
     * A fresh game row. $side is 'white' | 'black' | null (random, decided by
     * the creator's request) — the creator's colour is stored immediately so a
     * challenge link can be sent before anybody else arrives.
     */
    public static function create(array $opts = []): array
    {
        $base     = max(0, (int)($opts['tc_base_ms'] ?? 600000));
        $incr     = max(0, (int)($opts['tc_increment_ms'] ?? 0));
        $white    = $opts['white_user'] ?? null;
        $black    = $opts['black_user'] ?? null;
        $now      = (int)($opts['now_ms'] ?? (int)(microtime(true) * 1000));

        // With one player waiting there is nobody to run a clock for. The stored
        // time is still the full base so the second player starts with a full
        // clock, and turn_started_at_ms stays null until the game is actually
        // claimed, so an hour spent waiting for an opponent is not charged to
        // anybody's clock.
        $started = ($white !== null && $black !== null);

        return [
            'id'                => (int)($opts['id'] ?? 0),
            'code'              => (string)($opts['code'] ?? ''),
            'status'            => $started ? self::ACTIVE : self::WAITING,
            'white_user'        => $white === null ? null : (int)$white,
            'black_user'        => $black === null ? null : (int)$black,
            'fen'               => (string)($opts['fen'] ?? Chess::START_FEN),
            'pgn'               => '',
            'tc_base_ms'        => $base,
            'tc_increment_ms'   => $incr,
            'rated'             => (bool)($opts['rated'] ?? true),
            'ply'               => 0,
            'result'            => null,   // from White's point of view: -1, 0, 1
            'reason'            => null,   // 'checkmate' | 'stalemate' | ... | 'resign' | 'flag' | 'timeout'
            'white_ms'          => $base,
            'black_ms'          => $base,
            'turn_started_at_ms' => $started ? $now : null,
            'turn_started_ms'   => $started ? $base : null,  // side-to-move's time when the clock started
            'winner_user'       => null,
            'created_at_ms'     => $now,
            'started_at_ms'     => $started ? $now : null,
            'ended_at_ms'       => null,
            'updated_at_ms'     => $now,
        ];
    }

    /** A 6-character room code from the unambiguous alphabet. */
    public static function code(int $len = 6): string
    {
        $alpha = self::CODE_ALPHABET;
        $max   = strlen($alpha);
        $out   = '';
        for ($i = 0; $i < $len; $i++) $out .= $alpha[random_int(0, $max - 1)];
        return $out;
    }

    /**
     * Rebuild the engine by replaying the stored moves.
     *
     * The FEN column alone is not enough: repetition detection needs the history,
     * and a game reconstructed from its final position would happily declare a
     * draw the players never agreed to. Replaying is cheap and it means the PGN
     * and the repetition rules come out of the same proven code path the tests
     * use.
     *
     * The one exception is ply 0 of a game that was created from a FEN: there are
     * no moves to replay, so the stored FEN IS the position. From ply 1 onward
     * the replay is authoritative and the column is a cache - which is why
     * doctoring that column mid-game changes nothing.
     *
     * @param array<int,string> $sans
     */
    public static function engine(array $game, array $sans): Chess
    {
        $start = ((int)($game['ply'] ?? 0) === 0 && !empty($sans) === false && ($game['fen'] ?? '') !== Chess::START_FEN)
            ? (string)$game['fen']
            : Chess::START_FEN;
        $e = new Chess($start);
        foreach ($sans as $san) {
            if ($e->moveSan($san) === null) {
                throw new RuntimeException("stored move '{$san}' does not replay in game {$game['id']}");
            }
        }
        return $e;
    }

    /**
     * Apply a move. This is the only function allowed to end a game.
     *
     * Order matters here and it is not arbitrary:
     *   1. is the game even playing
     *   2. is this user the side to move
     *   3. has their clock already run out   <- BEFORE the move is played
     *   4. play the move
     *   5. add the increment to the MOVER, not the opponent
     *   6. has the game ended by the rules
     *
     * Step 3 before step 4 is the whole ballgame. A player who sits on the clock
     * until it hits zero and then plays a mating move has not mated anyone; the
     * flag fell first, the game is over, and the move does not count. Doing it
     * the other way round lets anyone win on time by moving one millisecond
     * after the flag, which is the single most valuable thing to get wrong here.
     *
     * The clock is computed from $nowMs, which the CALLER must take from the
     * server. Nothing in this function reads a client-supplied timestamp.
     *
     * @return array{ok:bool,error:?string,game:array,move:?array}
     */
    public static function applyMove(array $game, array $move, int $userId, int $nowMs): array
    {
        $fail = static fn(string $e): array => ['ok' => false, 'error' => $e, 'game' => $game, 'move' => null];

        if (($game['status'] ?? '') !== self::ACTIVE) {
            return $fail('not_playing');
        }
        $isWhite  = $game['white_user'] === $userId;
        $isBlack  = $game['black_user'] === $userId;
        if (!$isWhite && !$isBlack) {
            return $fail('not_a_player');
        }

        $sans  = $move['sans'] ?? [];
        $engine = self::engine($game, $sans);
        if ($engine->isGameOver()) {
            return $fail('already_over');
        }

        $moverIsWhite = $engine->turnColor() === Chess::WHITE;
        if ($moverIsWhite !== $isWhite) {
            return $fail('not_your_turn');
        }

        // -- the clock ---------------------------------------------------------
        $timed = (int)$game['tc_base_ms'] > 0;
        if ($timed) {
            $key      = $moverIsWhite ? 'white_ms' : 'black_ms';
            $elapsed  = $nowMs - (int)($game['turn_started_at_ms'] ?? $nowMs);
            $left     = (int)$game[$key] - max(0, $elapsed);
            if ($left <= 0) {
                // Flag fell. The game ends, the move never happened, and the
                // side that ran out of time is the one that lost.
                $game[$key] = 0;
                return [
                    'ok'    => true,          // the request succeeded; the game ended
                    'error' => 'flag',
                    'game'  => self::endByTimeout($game, $moverIsWhite ? 'white' : 'black', $nowMs),
                    'move'  => null,
                ];
            }
            $game[$key] = $left + (int)$game['tc_increment_ms'];
        }

        // -- the move ----------------------------------------------------------
        // Two ways in, because there are two callers: the client sends algebraic
        // from/to, and the tests (and any replay) speak SAN. Both end up in the
        // same Chess::move() call, so neither can be more permissive than the
        // other.
        if (isset($move['san'])) {
            $played = $engine->moveSan((string)$move['san']);
        } else {
            $played = $engine->move([
                'from'      => (string)($move['from'] ?? ''),
                'to'        => (string)($move['to'] ?? ''),
                'promotion' => $move['promotion'] ?? null,
            ]);
        }
        if ($played === null) {
            return $fail('illegal_move');
        }

        $san = (string)$played['san'];
        // The engine reports from/to/promotion, not UCI, so the long-algebraic
        // form is assembled here. The promotion is lowercased on the way: the
        // engine's own letters are PGN-case ('bxa8=Q', correct in a PGN) but UCI
        // is lower-case everywhere ('b7a8q'), and this string is what goes to
        // Stockfish and what the browser's own engine reads back.
        $uci = strtolower((string)$played['from'] . (string)$played['to'] . (string)($played['promotion'] ?? ''));
        $game['fen']   = $engine->fen();
        $game['ply']   = (int)$game['ply'] + 1;
        $game['pgn']   = $engine->pgn();
        $game['turn_started_at_ms'] = $nowMs;
        // the side to move's remaining time, frozen at the moment the clock
        // starts, so the next move can subtract exactly the right interval
        $game['turn_started_ms']   = $moverIsWhite ? (int)$game['black_ms'] : (int)$game['white_ms'];
        $game['updated_at_ms']     = $nowMs;

        $result = [
            'ok'   => true,
            'error'=> null,
            'game' => $game,
            'move' => [
                'ply'  => $game['ply'],
                'san'  => $san,
                'uci'  => $uci,
                'fen'  => $game['fen'],
                'white_ms' => (int)$game['white_ms'],
                'black_ms' => (int)$game['black_ms'],
            ],
        ];

        if ($engine->isGameOver()) {
            $reason = $engine->endReason();
            $result['game'] = self::endByRules($game, $engine, $reason, $nowMs);
        }
        return $result;
    }

    /** A game the rules have ended: set the result, the reason and the stop time. */
    private static function endByRules(array $game, Chess $engine, string $reason, int $nowMs): array
    {
        $outcome = $engine->outcome();          // -1 black, 0 draw, 1 white, 2 draw
        $game['result']  = $outcome === 2 ? 0 : $outcome;
        $game['reason']  = $reason;
        $game['status']  = self::ENDED;
        $game['winner_user'] = $game['result'] === 1 ? $game['white_user']
                                  : ($game['result'] === -1 ? $game['black_user'] : null);
        $game['turn_started_at_ms'] = null;
        $game['ended_at_ms'] = $nowMs;
        $game['updated_at_ms'] = $nowMs;
        return $game;
    }

    /**
     * A clock that reached zero. $loserColor is the string 'white' or 'black'.
     *
     * `result` is from WHITE's point of view (1 white won, -1 black won, 0
     * draw), so a game where white flagged is a -1. Getting this backwards is
     * the sort of thing that hands the winner's own account the loss screen, and
     * it is why the two branches below are written as "who lost" rather than
     * "who won": naming the loser once and deriving both is the only way the two
     * cannot disagree with each other.
     */
    public static function endByTimeout(array $game, string $loserColor, int $nowMs): array
    {
        return self::endByLosing($game, $loserColor, 'flag', $nowMs);
    }

    public static function endByResign(array $game, int $userId, int $nowMs): array
    {
        // same rule as a flag: name the loser, derive the rest
        if ($game['white_user'] === $userId) {
            return self::endByLosing($game, 'white', 'resign', $nowMs);
        }
        if ($game['black_user'] === $userId) {
            return self::endByLosing($game, 'black', 'resign', $nowMs);
        }
        throw new InvalidArgumentException('only a player can resign');
    }

    /**
     * The shared tail of every ending: one place that sets result, reason,
     * status, winner and the timestamps, so a new ending cannot forget one of
     * them or set two of them inconsistently.
     */
    private static function endByLosing(array $game, string $loserColor, string $reason, int $nowMs): array
    {
        $game['result']  = $loserColor === 'white' ? -1 : 1;
        $game['reason']  = $reason;
        $game['status']  = self::ENDED;
        $game['winner_user'] = $loserColor === 'white' ? $game['black_user'] : $game['white_user'];
        $game['turn_started_at_ms'] = null;
        $game['ended_at_ms'] = $nowMs;
        $game['updated_at_ms'] = $nowMs;
        return $game;
    }

    public static function endByAgreement(array $game, int $nowMs): array
    {
        $game['result']  = 0;
        $game['reason']  = 'agreement';
        $game['status']  = self::ENDED;
        $game['winner_user'] = null;
        $game['turn_started_at_ms'] = null;
        $game['ended_at_ms'] = $nowMs;
        $game['updated_at_ms'] = $nowMs;
        return $game;
    }

    /**
     * Live clock values, in ms, as of $nowMs.
     *
     * Only the side to move can be losing time. The opponent's number is a
     * stored fact until it becomes the mover's turn, which is why this is not a
     * symmetrical "subtract from both" loop.
     *
     * @return array{white:int,black:int,turn:?string,timed:bool}
     */
    public static function clock(array $game, int $nowMs): array
    {
        $white = (int)$game['white_ms'];
        $black = (int)$game['black_ms'];
        $timed = (int)$game['tc_base_ms'] > 0;

        if ($timed && ($game['status'] ?? '') === self::ACTIVE && ($game['turn_started_at_ms'] ?? null) !== null) {
            $engine = self::engine($game, []);
            $moverIsWhite = $engine->turnColor() === Chess::WHITE;
            $elapsed = max(0, $nowMs - (int)$game['turn_started_at_ms']);
            if ($moverIsWhite) $white = max(0, $white - $elapsed);
            else               $black = max(0, $black - $elapsed);
        }

        $turn = null;
        if (($game['status'] ?? '') === self::ACTIVE) {
            $turn = self::engine($game, [])->turnColor() === Chess::WHITE ? 'white' : 'black';
        }
        return ['white' => $white, 'black' => $black, 'turn' => $turn, 'timed' => $timed];
    }

    /**
     * The exact array the client receives. Deliberately narrow: no pass hashes,
     * no emails, no session ids, and the moves are SAN only. The client keeps
     * its own history, so shipping FENs it does not need would be a way to leak
     * another player's game to anyone holding a code.
     *
     * @param array<int,array{id:int,username:string,display_name:string,rating:int,last_seen_ms:int}> $players
     * @param array<int,string> $sans
     */
    public static function publicState(array $game, array $players, array $sans, int $nowMs): array
    {
        // $players AND $nowMs both have to be imported: a closure does not
        // inherit a function's parameters, and forgetting $nowMs here made
        // every player look permanently online.
        $who = static function (?int $id) use ($players, $nowMs): ?array {
            if ($id === null) return null;
            $p = $players[$id] ?? null;
            if ($p === null) return ['id' => $id, 'username' => '?', 'display_name' => '?', 'rating' => 0, 'online' => false];
            return [
                'id'           => (int)$p['id'],
                'username'     => (string)$p['username'],
                'display_name' => (string)($p['display_name'] ?? $p['username']),
                'rating'       => (int)($p['rating'] ?? 0),
                // presence is "seen recently", not a socket: see api/social.php
                'online'       => ($nowMs - (int)($p['last_seen_ms'] ?? 0)) < 30000,
            ];
        };

        $clock = self::clock($game, $nowMs);

        return [
            'code'        => (string)$game['code'],
            'status'      => (string)$game['status'],
            'white'       => $who($game['white_user'] ?? null),
            'black'       => $who($game['black_user'] ?? null),
            'fen'         => (string)$game['fen'],
            'ply'         => (int)$game['ply'],
            'moves'       => array_values($sans),
            'tc' => [
                'base_ms'      => (int)$game['tc_base_ms'],
                'increment_ms' => (int)$game['tc_increment_ms'],
            ],
            'rated'       => (bool)$game['rated'],
            'result'      => $game['result'],
            'reason'      => $game['reason'],
            'clock'       => $clock,
            'now_ms'      => $nowMs,      // so the client can interpolate, not guess
            'updated_at_ms' => (int)$game['updated_at_ms'],
        ];
    }
}
