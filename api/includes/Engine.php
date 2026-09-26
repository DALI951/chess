<?php
declare(strict_types=1);

/**
 * CHESS RULES ENGINE — canonical PHP implementation (SERVER-AUTHORITATIVE).
 *
 * Board representation: 0x88 mailbox (128-entry array).
 *   square index = rank * 16 + file, rank 0 = rank "1", file 0 = file "a"
 *   A1 = 0, H1 = 7, A8 = 112, H8 = 119
 *   on-board test: ($sq & 0x88) === 0
 *
 * Pieces are integers 0..12:
 *   0 empty | 1 P 2 N 3 B 4 R 5 Q 6 K (white) | 7 p 8 n 9 b 10 r 11 q 12 k (black)
 *   color(p) = p <= 6 ? WHITE : BLACK      type(p) = ((p - 1) % 6) + 1
 *
 * This file is mirrored 1:1 by assets/js/engine.js, the browser copy. Both are
 * proven by the same perft vectors and the SAME move-list fixtures:
 *   tests/js/perft.test.mjs + tests/js/differential.test.mjs  (JS)
 *   tests/php/EnginePerftTest.php + tests/php/ParityTest.php  (PHP)
 * If the two ever disagree, the fixtures fail — which is the point: the server
 * must never accept a move the browser would not allow, or the other way round.
 *
 * @author DALI951
 */

final class Chess
{
    public const EMPTY = 0;
    public const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
    public const WHITE = 0, BLACK = 1;

    public const N = 16, S = -16, E = 1, W = -1;
    public const NE = 17, NW = 15, SE = -15, SW = -17;

    public const KNIGHT_OFFSETS = [33, 31, 18, 14, -14, -18, -31, -33];
    public const BISHOP_OFFSETS = [self::NE, self::NW, self::SE, self::SW];
    public const ROOK_OFFSETS = [self::N, self::S, self::E, self::W];
    public const KING_OFFSETS = [self::N, self::S, self::E, self::W, self::NE, self::NW, self::SE, self::SW];

    public const PIECE_LETTERS = ['', 'p', 'n', 'b', 'r', 'q', 'k'];
    public const PIECE_LETTERS_UPPER = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];
    public const PIECE_VALUES = [0, 100, 320, 330, 500, 900, 20000];

    // Castling right bits
    public const CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;

    // Move flags
    public const FLAG_NORMAL = 'n';
    public const FLAG_CAPTURE = 'c';
    public const FLAG_BIG_PAWN = 'b';      // double pawn push
    public const FLAG_EP_CAPTURE = 'e';
    public const FLAG_PROMOTION = 'p';
    public const FLAG_WK_CASTLE = 'k';
    public const FLAG_WQ_CASTLE = 'q';
    public const FLAG_BK_CASTLE = 'K';
    public const FLAG_BQ_CASTLE = 'Q';

    public const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    /** Per-square bitmask of castling rights REMOVED when this square is touched. */
    private const CASTLE_MASK = [
        0 => self::CASTLE_WQ,                 // a1
        4 => self::CASTLE_WK | self::CASTLE_WQ, // e1
        7 => self::CASTLE_WK,                 // h1
        112 => self::CASTLE_BQ,               // a8
        116 => self::CASTLE_BK | self::CASTLE_BQ, // e8
        119 => self::CASTLE_BK,               // h8
    ];

    private const PIECE_FROM_LETTER = [
        'p' => self::PAWN, 'n' => self::KNIGHT, 'b' => self::BISHOP,
        'r' => self::ROOK, 'q' => self::QUEEN, 'k' => self::KING,
        'P' => self::PAWN, 'N' => self::KNIGHT, 'B' => self::BISHOP,
        'R' => self::ROOK, 'Q' => self::QUEEN, 'K' => self::KING,
    ];

    /** @var array<int,int> 128-entry 0x88 mailbox */
    private array $board;
    private int $turn;
    private int $castling;
    private int $ep;
    private int $halfmove;
    private int $fullmove;
    /** @var array<int,int> */
    private array $kingSq;
    /** @var array<int,array> undo stack */
    private array $history = [];
    /** @var array<int,string> position keys, index = ply */
    private array $keys = [];
    private array $headers = [];
    /** Position keys are FEN strings — cheap in a game, ruinous in perft. */
    private bool $trackKeys = true;

    public function __construct(string $fen = self::START_FEN)
    {
        $this->board = array_fill(0, 128, self::EMPTY);
        $this->turn = self::WHITE;
        $this->castling = 0;
        $this->ep = -1;
        $this->halfmove = 0;
        $this->fullmove = 1;
        $this->kingSq = [-1, -1];
        $this->load($fen);
    }

    // -- state ---------------------------------------------------------------

    public function load(string $fen): bool
    {
        $parts = preg_split('/\s+/', trim($fen)) ?: [];
        if (count($parts) < 4) {
            throw new InvalidArgumentException("Invalid FEN: {$fen}");
        }

        $this->board = array_fill(0, 128, self::EMPTY);
        $this->kingSq = [-1, -1];
        $rows = explode('/', $parts[0]);
        if (count($rows) !== 8) {
            throw new InvalidArgumentException("Invalid FEN board: {$parts[0]}");
        }

        for ($r = 0; $r < 8; $r++) {
            $row = $rows[$r];
            $file = 0;
            $len = strlen($row);
            for ($i = 0; $i < $len; $i++) {
                $ch = $row[$i];
                if ($ch >= '1' && $ch <= '8') {
                    $file += (int) $ch;
                    continue;
                }
                if (!isset(self::PIECE_FROM_LETTER[$ch])) {
                    throw new InvalidArgumentException("Invalid FEN piece '{$ch}'");
                }
                if ($file > 7) {
                    throw new InvalidArgumentException("FEN rank overflow: {$row}");
                }
                $type = self::PIECE_FROM_LETTER[$ch];
                // FEN case defines the colour of EACH piece — never infer it from
                // the row. Row 0 is rank 8, but a position can put a white king
                // on rank 5. (The JS engine had exactly this bug.)
                $color = ($ch === strtoupper($ch)) ? self::WHITE : self::BLACK;
                $sq = (7 - $r) * 16 + $file;
                $this->board[$sq] = self::pieceOf($type, $color);
                if ($type === self::KING) {
                    $this->kingSq[$color] = $sq;
                }
                $file++;
            }
        }

        $this->turn = $parts[1] === 'b' ? self::BLACK : self::WHITE;

        $this->castling = 0;
        if (str_contains($parts[2], 'K')) $this->castling |= self::CASTLE_WK;
        if (str_contains($parts[2], 'Q')) $this->castling |= self::CASTLE_WQ;
        if (str_contains($parts[2], 'k')) $this->castling |= self::CASTLE_BK;
        if (str_contains($parts[2], 'q')) $this->castling |= self::CASTLE_BQ;

        $this->ep = $parts[3] === '-' ? -1 : self::fromAlgebraic($parts[3]);

        $this->halfmove = count($parts) > 4 ? ((int) $parts[4] ?: 0) : 0;
        $this->fullmove = count($parts) > 5 ? (max(1, (int) $parts[5])) : 1;

        if ($this->kingSq[self::WHITE] < 0 || $this->kingSq[self::BLACK] < 0) {
            throw new InvalidArgumentException('Invalid FEN: both kings must be present');
        }

        $this->history = [];
        $this->keys = $this->trackKeys ? [$this->positionKey()] : [];
        return true;
    }

    public function reset(): bool
    {
        return $this->load(self::START_FEN);
    }

    public function fen(): string
    {
        $out = '';
        for ($r = 7; $r >= 0; $r--) {
            $empty = 0;
            for ($f = 0; $f < 8; $f++) {
                $p = $this->board[$r * 16 + $f];
                if ($p === self::EMPTY) {
                    $empty++;
                    continue;
                }
                if ($empty) {
                    $out .= $empty;
                    $empty = 0;
                }
                $out .= self::colorOf($p) === self::WHITE
                    ? self::PIECE_LETTERS_UPPER[self::typeOf($p)]
                    : self::PIECE_LETTERS[self::typeOf($p)];
            }
            if ($empty) $out .= $empty;
            if ($r > 0) $out .= '/';
        }
        $rights = '';
        if ($this->castling & self::CASTLE_WK) $rights .= 'K';
        if ($this->castling & self::CASTLE_WQ) $rights .= 'Q';
        if ($this->castling & self::CASTLE_BK) $rights .= 'k';
        if ($this->castling & self::CASTLE_BQ) $rights .= 'q';

        return implode(' ', [
            $out,
            $this->turn === self::WHITE ? 'w' : 'b',
            $rights !== '' ? $rights : '-',
            $this->ep >= 0 ? self::toAlgebraic($this->ep) : '-',
            (string) $this->halfmove,
            (string) $this->fullmove,
        ]);
    }

    public function board(): array
    {
        return $this->board;
    }

    public function turn(): string
    {
        return $this->turn === self::WHITE ? 'w' : 'b';
    }

    public function turnColor(): int
    {
        return $this->turn;
    }

    public function castlingRights(): int
    {
        return $this->castling;
    }

    public function epSquare(): ?string
    {
        return $this->ep >= 0 ? self::toAlgebraic($this->ep) : null;
    }

    public function halfmoveClock(): int
    {
        return $this->halfmove;
    }

    public function fullmoveNumber(): int
    {
        return $this->fullmove;
    }

    public function moveNumber(): int
    {
        return $this->fullmove;
    }

    public function kingSquare(?int $color = null): ?string
    {
        return self::toAlgebraic($this->kingSq[$color ?? $this->turn]);
    }

    /** Internal 0x88 king square. */
    public function kingSq(?int $color = null): int
    {
        return $this->kingSq[$color ?? $this->turn];
    }

    public function get(int|string $sq): int
    {
        $s = is_string($sq) ? self::fromAlgebraic($sq) : $sq;
        return self::onBoard($s) ? $this->board[$s] : self::EMPTY;
    }

    public function remove(int|string $sq): ?int
    {
        $s = is_string($sq) ? self::fromAlgebraic($sq) : $sq;
        if (!self::onBoard($s) || $this->board[$s] === self::EMPTY) {
            return null;
        }
        $p = $this->board[$s];
        $this->board[$s] = self::EMPTY;
        $this->syncKeys();
        return $p;
    }

    // -- attack detection ----------------------------------------------------

    /** Is $sq attacked by any piece of color $byColor? */
    public function isAttacked(int $sq, int $byColor): bool
    {
        if (!self::onBoard($sq)) return false;
        $board = $this->board;

        // pawns: a white pawn on sq-15/sq-17 attacks sq, etc.
        $pawnDir = $byColor === self::WHITE ? -16 : 16;
        foreach ([-1, 1] as $side) {
            $from = $sq + $pawnDir + $side;
            if (self::onBoard($from) && $board[$from] === self::pieceOf(self::PAWN, $byColor)) {
                return true;
            }
        }

        foreach (self::KNIGHT_OFFSETS as $off) {
            $from = $sq + $off;
            if (self::onBoard($from) && $board[$from] === self::pieceOf(self::KNIGHT, $byColor)) {
                return true;
            }
        }

        foreach (self::KING_OFFSETS as $off) {
            $from = $sq + $off;
            if (self::onBoard($from) && $board[$from] === self::pieceOf(self::KING, $byColor)) {
                return true;
            }
        }

        $sliders = [
            self::BISHOP => self::BISHOP_OFFSETS,
            self::ROOK => self::ROOK_OFFSETS,
            self::QUEEN => self::KING_OFFSETS,
        ];
        foreach ($sliders as $t => $offsets) {
            foreach ($offsets as $off) {
                $from = $sq + $off;
                while (self::onBoard($from)) {
                    $p = $board[$from];
                    if ($p !== self::EMPTY) {
                        if (self::colorOf($p) === $byColor && self::typeOf($p) === $t) {
                            return true;
                        }
                        break;
                    }
                    $from += $off;
                }
            }
        }

        return false;
    }

    public function inCheck(): bool
    {
        return $this->isAttacked($this->kingSq[$this->turn], self::opp($this->turn));
    }

    public function isCheck(): bool
    {
        return $this->inCheck();
    }

    // -- move generation -----------------------------------------------------

    /**
     * All legal moves for the side to move.
     *
     * @param array{square?: int|string|null, verbose?: bool} $opts
     * @return array<int,array>
     */
    public function moves(array $opts = []): array
    {
        $verbose = ($opts['verbose'] ?? true) !== false;
        $fromSq = -1;
        if (isset($opts['square']) && $opts['square'] !== null) {
            $fromSq = is_string($opts['square']) ? self::fromAlgebraic($opts['square']) : (int) $opts['square'];
            if (!self::onBoard($fromSq)) return [];
        }

        $out = [];
        foreach ($this->legalMoves() as $mv) {
            if ($fromSq >= 0 && $mv['from'] !== $fromSq) continue;
            $out[] = $verbose
                ? $this->withSan($mv)
                : ['from' => self::toAlgebraic($mv['from']), 'to' => self::toAlgebraic($mv['to'])];
        }
        return $out;
    }

    /** @return array<int,array> every pseudo-legal move for the side to move */
    private function pseudoMoves(): array
    {
        $board = $this->board;
        $us = $this->turn;
        $them = self::opp($us);
        $moves = [];

        for ($sq = 0; $sq < 128; $sq++) {
            if ($sq & 0x88) {
                $sq += 7;
                continue;   // skip the off-board gap
            }
            $piece = $board[$sq];
            if ($piece === self::EMPTY || self::colorOf($piece) !== $us) continue;
            $type = self::typeOf($piece);

            if ($type === self::PAWN) {
                $dir = $us === self::WHITE ? self::N : self::S;
                $startRank = $us === self::WHITE ? 1 : 6;
                $promoRank = $us === self::WHITE ? 7 : 0;

                $one = $sq + $dir;
                if (self::onBoard($one) && $board[$one] === self::EMPTY) {
                    if (($one >> 4) === $promoRank) {
                        foreach ([self::QUEEN, self::ROOK, self::BISHOP, self::KNIGHT] as $t) {
                            $moves[] = $this->mk($sq, $one, $piece, self::EMPTY, $t, self::FLAG_PROMOTION);
                        }
                    } else {
                        $moves[] = $this->mk($sq, $one, $piece, self::EMPTY, 0, self::FLAG_NORMAL);
                        $two = $one + $dir;
                        if (($sq >> 4) === $startRank && self::onBoard($two) && $board[$two] === self::EMPTY) {
                            $moves[] = $this->mk($sq, $two, $piece, self::EMPTY, 0, self::FLAG_BIG_PAWN, $one);
                        }
                    }
                }

                foreach ([-1, 1] as $side) {
                    $to = $sq + $dir + $side;
                    if (!self::onBoard($to)) continue;
                    $target = $board[$to];
                    if ($target !== self::EMPTY && self::colorOf($target) === $them) {
                        if (($to >> 4) === $promoRank) {
                            foreach ([self::QUEEN, self::ROOK, self::BISHOP, self::KNIGHT] as $t) {
                                $moves[] = $this->mk($sq, $to, $piece, $target, $t, self::FLAG_PROMOTION);
                            }
                        } else {
                            $moves[] = $this->mk($sq, $to, $piece, $target, 0, self::FLAG_CAPTURE);
                        }
                    } elseif ($to === $this->ep && $target === self::EMPTY) {
                        $moves[] = $this->mk($sq, $to, $piece, self::EMPTY, 0, self::FLAG_EP_CAPTURE);
                    }
                }
                continue;
            }

            if ($type === self::KNIGHT || $type === self::KING) {
                $offsets = $type === self::KNIGHT ? self::KNIGHT_OFFSETS : self::KING_OFFSETS;
                foreach ($offsets as $off) {
                    $to = $sq + $off;
                    if (!self::onBoard($to)) continue;
                    $target = $board[$to];
                    if ($target === self::EMPTY) {
                        $moves[] = $this->mk($sq, $to, $piece, self::EMPTY, 0, self::FLAG_NORMAL);
                    } elseif (self::colorOf($target) === $them) {
                        $moves[] = $this->mk($sq, $to, $piece, $target, 0, self::FLAG_CAPTURE);
                    }
                }
                continue;
            }

            $offsets = $type === self::BISHOP ? self::BISHOP_OFFSETS : ($type === self::ROOK ? self::ROOK_OFFSETS : self::KING_OFFSETS);
            foreach ($offsets as $off) {
                $to = $sq + $off;
                while (self::onBoard($to)) {
                    $target = $board[$to];
                    if ($target === self::EMPTY) {
                        $moves[] = $this->mk($sq, $to, $piece, self::EMPTY, 0, self::FLAG_NORMAL);
                    } else {
                        if (self::colorOf($target) === $them) {
                            $moves[] = $this->mk($sq, $to, $piece, $target, 0, self::FLAG_CAPTURE);
                        }
                        break;
                    }
                    $to += $off;
                }
            }
        }

        // castling
        if (!$this->isAttacked($this->kingSq[$us], $them)) {
            $ksq = $this->kingSq[$us];
            if ($us === self::WHITE && $ksq === 4) {
                if (($this->castling & self::CASTLE_WK) &&
                    $board[5] === self::EMPTY && $board[6] === self::EMPTY &&
                    $board[7] === self::pieceOf(self::ROOK, self::WHITE) &&
                    !$this->isAttacked(5, $them) && !$this->isAttacked(6, $them)) {
                    $moves[] = $this->mk(4, 6, $board[4], self::EMPTY, 0, self::FLAG_WK_CASTLE);
                }
                if (($this->castling & self::CASTLE_WQ) &&
                    $board[1] === self::EMPTY && $board[2] === self::EMPTY && $board[3] === self::EMPTY &&
                    $board[0] === self::pieceOf(self::ROOK, self::WHITE) &&
                    !$this->isAttacked(3, $them) && !$this->isAttacked(2, $them)) {
                    $moves[] = $this->mk(4, 2, $board[4], self::EMPTY, 0, self::FLAG_WQ_CASTLE);
                }
            } elseif ($us === self::BLACK && $ksq === 116) {
                if (($this->castling & self::CASTLE_BK) &&
                    $board[117] === self::EMPTY && $board[118] === self::EMPTY &&
                    $board[119] === self::pieceOf(self::ROOK, self::BLACK) &&
                    !$this->isAttacked(117, $them) && !$this->isAttacked(118, $them)) {
                    $moves[] = $this->mk(116, 118, $board[116], self::EMPTY, 0, self::FLAG_BK_CASTLE);
                }
                if (($this->castling & self::CASTLE_BQ) &&
                    $board[113] === self::EMPTY && $board[114] === self::EMPTY && $board[115] === self::EMPTY &&
                    $board[112] === self::pieceOf(self::ROOK, self::BLACK) &&
                    !$this->isAttacked(115, $them) && !$this->isAttacked(114, $them)) {
                    $moves[] = $this->mk(116, 114, $board[116], self::EMPTY, 0, self::FLAG_BQ_CASTLE);
                }
            }
        }

        return $moves;
    }

    /** Pseudo-legal moves filtered for king safety. */
    private function legalMoves(): array
    {
        $us = $this->turn;
        $them = self::opp($us);
        $legal = [];
        foreach ($this->pseudoMoves() as $mv) {
            $this->make($mv);
            $ok = !$this->isAttacked($this->kingSq[$us], $them);
            $this->unmake();
            if ($ok) $legal[] = $mv;
        }
        return $legal;
    }

    private function mk(int $from, int $to, int $piece, int $captured, int $promotion, string $flag, int $epSet = -1): array
    {
        return [
            'from' => $from,
            'to' => $to,
            'piece' => $piece,
            'captured' => $captured,
            'promotion' => $promotion ?: 0,
            'flag' => $flag,
            'ep' => $flag === self::FLAG_BIG_PAWN ? $epSet : -1,
            'color' => self::colorOf($piece),
        ];
    }

    // -- make / unmake -------------------------------------------------------

    private function make(array $mv): void
    {
        $us = $this->turn;

        $state = [
            'move' => $mv,
            'castling' => $this->castling,
            'ep' => $this->ep,
            'halfmove' => $this->halfmove,
            'fullmove' => $this->fullmove,
            'kingSq' => $this->kingSq[$us],
            'capturedSq' => -1,
            'capturedPiece' => self::EMPTY,
        ];

        // remove the en-passant victim before writing the destination
        if ($mv['flag'] === self::FLAG_EP_CAPTURE) {
            $victimSq = $mv['to'] + ($us === self::WHITE ? self::S : self::N);
            $state['capturedSq'] = $victimSq;
            $state['capturedPiece'] = $this->board[$victimSq];
            $this->board[$victimSq] = self::EMPTY;
        }

        $this->board[$mv['from']] = self::EMPTY;
        $this->board[$mv['to']] = $mv['promotion'] ? self::pieceOf($mv['promotion'], $us) : $mv['piece'];

        if (self::typeOf($mv['piece']) === self::KING) $this->kingSq[$us] = $mv['to'];

        // rook hop for castling
        if ($mv['flag'] === self::FLAG_WK_CASTLE) { $this->board[5] = $this->board[7]; $this->board[7] = self::EMPTY; }
        if ($mv['flag'] === self::FLAG_WQ_CASTLE) { $this->board[3] = $this->board[0]; $this->board[0] = self::EMPTY; }
        if ($mv['flag'] === self::FLAG_BK_CASTLE) { $this->board[117] = $this->board[119]; $this->board[119] = self::EMPTY; }
        if ($mv['flag'] === self::FLAG_BQ_CASTLE) { $this->board[115] = $this->board[112]; $this->board[112] = self::EMPTY; }

        $this->castling &= ~(self::CASTLE_MASK[$mv['from']] ?? 0) & ~(self::CASTLE_MASK[$mv['to']] ?? 0);
        $this->ep = $mv['flag'] === self::FLAG_BIG_PAWN ? $mv['ep'] : -1;
        $this->halfmove = (self::typeOf($mv['piece']) === self::PAWN || $mv['captured'] !== self::EMPTY) ? 0 : $this->halfmove + 1;
        if ($us === self::BLACK) $this->fullmove++;

        $this->history[] = $state;
        $this->turn = self::opp($us);
        if ($this->trackKeys) $this->keys[] = $this->positionKey();
    }

    private function unmake(): ?array
    {
        $state = array_pop($this->history);
        if ($state === null) return null;
        $mv = $state['move'];
        $us = self::colorOf($mv['piece']);

        $this->turn = $us;
        if ($this->trackKeys) array_pop($this->keys);

        $this->board[$mv['to']] = self::EMPTY;
        $this->board[$mv['from']] = $mv['piece'];

        if ($state['capturedSq'] >= 0) {
            $this->board[$state['capturedSq']] = $state['capturedPiece'];
        } elseif ($mv['captured'] !== self::EMPTY) {
            $this->board[$mv['to']] = $mv['captured'];
        }

        if (self::typeOf($mv['piece']) === self::KING) $this->kingSq[$us] = $state['kingSq'];

        if ($mv['flag'] === self::FLAG_WK_CASTLE) $this->boardRestore(7, 5);
        if ($mv['flag'] === self::FLAG_WQ_CASTLE) $this->boardRestore(0, 3);
        if ($mv['flag'] === self::FLAG_BK_CASTLE) $this->boardRestore(119, 117);
        if ($mv['flag'] === self::FLAG_BQ_CASTLE) $this->boardRestore(112, 115);

        $this->castling = $state['castling'];
        $this->ep = $state['ep'];
        $this->halfmove = $state['halfmove'];
        $this->fullmove = $state['fullmove'];
        return $mv;
    }

    // -- playing moves -------------------------------------------------------

    /**
     * Play a move. Accepts ['from'=>..,'to'=>..,'promotion'=>..] with algebraic or
     * 0x88 squares.
     *
     * @return array|null the played move (with san + before/after FEN), or null if illegal
     */
    public function move(array $input): ?array
    {
        $from = is_string($input['from'] ?? null) ? self::fromAlgebraic($input['from']) : (int) ($input['from'] ?? -1);
        $to = is_string($input['to'] ?? null) ? self::fromAlgebraic($input['to']) : (int) ($input['to'] ?? -1);
        if (!self::onBoard($from) || !self::onBoard($to)) return null;

        $wantedPromo = 0;
        if (isset($input['promotion']) && $input['promotion'] !== '' && $input['promotion'] !== null) {
            $wantedPromo = is_string($input['promotion'])
                ? (self::PIECE_FROM_LETTER[strtolower($input['promotion'])] ?? 0)
                : (int) $input['promotion'];
        }

        $legal = array_values(array_filter(
            $this->legalMoves(),
            fn(array $m): bool => $m['from'] === $from && $m['to'] === $to
        ));
        if (!$legal) return null;

        if (count($legal) === 1) {
            $chosen = $legal[0];
        } else {
            // promotion (or a rare duplicate) — disambiguate
            $promoMoves = array_values(array_filter($legal, fn(array $m): bool => $m['flag'] === self::FLAG_PROMOTION));
            if ($wantedPromo) {
                $chosen = null;
                foreach ($promoMoves as $m) {
                    if ($m['promotion'] === $wantedPromo) { $chosen = $m; break; }
                }
                if ($chosen === null) {
                    foreach ($legal as $m) {
                        if ($m['promotion'] === $wantedPromo) { $chosen = $m; break; }
                    }
                }
            } else {
                $chosen = null;
                foreach ($promoMoves as $m) {
                    if ($m['promotion'] === self::QUEEN) { $chosen = $m; break; }
                }
                $chosen ??= $legal[0];
            }
            if ($chosen === null) return null;
        }

        $before = $this->fen();
        $decorated = $this->withSan($chosen);
        $this->make($chosen);
        $decorated['before'] = $before;
        $decorated['after'] = $this->fen();
        return $decorated;
    }

    /**
     * Play a move given in SAN ("e4", "Nf3", "exd5", "O-O", "e8=Q+").
     *
     * The check/mate suffix is OPTIONAL on input: real PGN files in the wild
     * write "Qh4" where the rules say "Qh4#", so a strict comparison would
     * refuse to import perfectly good games.
     */
    public function moveSan(string $san): ?array
    {
        $raw = trim($san);
        $bare = preg_replace('/[+#]+$/', '', $raw) ?? $raw;
        foreach ($this->legalMoves() as $mv) {
            $full = $this->san($mv);
            if ($full === $raw || (preg_replace('/[+#]+$/', '', $full) ?? $full) === $bare) {
                return $this->move([
                    'from' => $mv['from'],
                    'to' => $mv['to'],
                    'promotion' => self::pieceTypeToLetter($mv['promotion']),
                ]);
            }
        }
        return null;
    }

    public function undo(): ?array
    {
        $mv = $this->unmake();
        if ($mv === null) return null;
        return $this->withSan($mv);
    }

    /**
     * The moves of the game, oldest first. NON-DESTRUCTIVE: the position is
     * restored before returning, so the UI can render the move list at any time
     * without corrupting the live game.
     *
     * @return array<int,array|string>
     */
    public function history(array $opts = []): array
    {
        $verbose = ($opts['verbose'] ?? true) !== false;
        $moves = [];
        while ($this->history) {
            array_unshift($moves, $this->unmake());
        }

        $out = [];
        foreach ($moves as $mv) {
            $entry = $verbose ? $this->withSan($mv) : ['san' => $this->san($mv)];
            $this->make($mv);
            if ($verbose) $entry['after'] = $this->fen();
            $out[] = $entry;
        }
        return $out;
    }

    // -- SAN -----------------------------------------------------------------

    private function withSan(array $mv): array
    {
        return [
            'from' => self::toAlgebraic($mv['from']),
            'to' => self::toAlgebraic($mv['to']),
            'piece' => self::PIECE_LETTERS_UPPER[self::typeOf($mv['piece'])],
            'pieceType' => self::typeOf($mv['piece']),
            'color' => $mv['color'],
            'captured' => $mv['captured'] ? self::PIECE_LETTERS[self::typeOf($mv['captured'])] : null,
            'promotion' => $mv['promotion'] ? self::pieceTypeToLetter($mv['promotion']) : null,
            'flag' => $mv['flag'],
            'san' => $this->san($mv),
            'lan' => self::toAlgebraic($mv['from'])
                . ($mv['captured'] ? 'x' : '')
                . self::toAlgebraic($mv['to'])
                . ($mv['promotion'] ? '=' . self::pieceTypeToLetter($mv['promotion']) : ''),
            'before' => $this->fen(),
            'after' => null,
        ];
    }

    private function san(array $mv): string
    {
        $san = '';

        if ($mv['flag'] === self::FLAG_WK_CASTLE || $mv['flag'] === self::FLAG_BK_CASTLE) {
            $san = 'O-O';
        } elseif ($mv['flag'] === self::FLAG_WQ_CASTLE || $mv['flag'] === self::FLAG_BQ_CASTLE) {
            $san = 'O-O-O';
        } else {
            $type = self::typeOf($mv['piece']);
            $capture = $mv['captured'] !== self::EMPTY || $mv['flag'] === self::FLAG_EP_CAPTURE;

            if ($type === self::PAWN) {
                // Pawn SAN carries the ORIGIN FILE only; the shared capture 'x'
                // below adds the single separator. Adding it here too produced
                // "exxd5" (and the JS engine had exactly that bug).
                if ($capture) $san .= 'abcdefgh'[$mv['from'] & 7];
            } else {
                $san .= self::PIECE_LETTERS_UPPER[$type];
                // Disambiguation against other legal moves of the same piece
                // type. The current move must be excluded by IDENTITY OF THE
                // MOVE (from/to/promotion), not by array comparison: PHP `!==`
                // on arrays happens to work, but relying on it would hide a
                // divergence from the JS engine, which compares references.
                $isSelf = static fn(array $m): bool => $m['from'] === $mv['from']
                    && $m['to'] === $mv['to']
                    && $m['promotion'] === $mv['promotion'];
                $rivals = array_filter(
                    $this->legalMoves(),
                    static fn(array $m): bool => !$isSelf($m)
                        && self::typeOf($m['piece']) === $type
                        && $m['to'] === $mv['to']
                        && self::colorOf($m['piece']) === $mv['color']
                );
                if ($rivals) {
                    $sameFile = false;
                    $sameRank = false;
                    foreach ($rivals as $r) {
                        if (($r['from'] & 7) === ($mv['from'] & 7)) $sameFile = true;
                        if (($r['from'] >> 4) === ($mv['from'] >> 4)) $sameRank = true;
                    }
                    if (!$sameFile) {
                        $san .= 'abcdefgh'[$mv['from'] & 7];
                    } elseif (!$sameRank) {
                        $san .= (string) (($mv['from'] >> 4) + 1);
                    } else {
                        $san .= self::toAlgebraic($mv['from']);
                    }
                }
            }

            if ($capture) $san .= 'x';
            $san .= self::toAlgebraic($mv['to']);
            if ($mv['flag'] === self::FLAG_PROMOTION) $san .= '=' . self::PIECE_LETTERS_UPPER[$mv['promotion']];
        }

        // check / mate suffix
        $this->make($mv);
        if ($this->isAttacked($this->kingSq[$this->turn], self::opp($this->turn))) {
            $san .= $this->legalMoves() ? '+' : '#';
        }
        $this->unmake();

        return $san;
    }

    /** SAN without the check/mate suffix — used by the perft divide. */
    private function sanQuiet(array $mv): string
    {
        if ($mv['flag'] === self::FLAG_WK_CASTLE || $mv['flag'] === self::FLAG_BK_CASTLE) return 'O-O';
        if ($mv['flag'] === self::FLAG_WQ_CASTLE || $mv['flag'] === self::FLAG_BQ_CASTLE) return 'O-O-O';
        $type = self::typeOf($mv['piece']);
        $cap = $mv['captured'] !== self::EMPTY || $mv['flag'] === self::FLAG_EP_CAPTURE;
        $s = $type === self::PAWN ? '' : self::PIECE_LETTERS_UPPER[$type];
        if ($type === self::PAWN && $cap) $s .= 'abcdefgh'[$mv['from'] & 7];
        if ($cap) $s .= 'x';
        $s .= self::toAlgebraic($mv['to']);
        if ($mv['flag'] === self::FLAG_PROMOTION) $s .= '=' . self::PIECE_LETTERS_UPPER[$mv['promotion']];
        return $s;
    }

    // -- status --------------------------------------------------------------

    public function isCheckmate(): bool
    {
        if (!$this->inCheck()) return false;
        return $this->legalMoves() === [];
    }

    public function isStalemate(): bool
    {
        if ($this->inCheck()) return false;
        return $this->legalMoves() === [];
    }

    public function isInsufficientMaterial(): bool
    {
        $pieces = [];
        for ($sq = 0; $sq < 128; $sq++) {
            if ($sq & 0x88) {
                $sq += 7;
                continue;
            }
            $p = $this->board[$sq];
            if ($p !== self::EMPTY) $pieces[] = ['type' => self::typeOf($p), 'sq' => $sq];
        }
        if (count($pieces) <= 2) return true;                      // K vs K, K+minor vs K
        foreach ($pieces as $p) {
            if ($p['type'] === self::PAWN || $p['type'] === self::ROOK || $p['type'] === self::QUEEN) {
                return false;
            }
        }
        if (count($pieces) === 3) return true;                      // K + minor vs K

        // K+B vs K+B with same-coloured bishops only
        if (count($pieces) === 4) {
            foreach ($pieces as $p) {
                if ($p['type'] !== self::BISHOP) return false;
            }
            $light = static fn(int $sq): int => ((($sq & 7) + ($sq >> 4)) % 2 === 0) ? 0 : 1;
            return $light($pieces[0]['sq']) === $light($pieces[1]['sq']);
        }
        return false;
    }

    public function isThreefoldRepetition(): bool
    {
        $key = $this->positionKey();
        $count = 0;
        foreach ($this->keys as $k) {
            if ($k === $key) $count++;
        }
        return $count >= 3;
    }

    public function isDrawByFiftyMoves(): bool
    {
        return $this->halfmove >= 100;
    }

    public function isDraw(): bool
    {
        return $this->isStalemate()
            || $this->isInsufficientMaterial()
            || $this->isThreefoldRepetition()
            || $this->isDrawByFiftyMoves();
    }

    public function isGameOver(): bool
    {
        return $this->isCheckmate() || $this->isDraw();
    }

    /** 0 = ongoing, 1 = white win, -1 = black win, 2 = draw. */
    public function outcome(): int
    {
        if ($this->isCheckmate()) return $this->turn === self::WHITE ? -1 : 1;
        if ($this->isDraw()) return 2;
        return 0;
    }

    /** 'checkmate'|'stalemate'|'repetition'|'fifty'|'material'|'ongoing' */
    public function endReason(): string
    {
        if ($this->isCheckmate()) return 'checkmate';
        if ($this->isStalemate()) return 'stalemate';
        if ($this->isThreefoldRepetition()) return 'repetition';
        if ($this->isDrawByFiftyMoves()) return 'fifty';
        if ($this->isInsufficientMaterial()) return 'material';
        return 'ongoing';
    }

    // -- repetition key ------------------------------------------------------

    /**
     * FEN parts 1-4. The en-passant square is only included when the side to
     * move actually has a legal en-passant capture — otherwise two positions
     * that are NOT repetitions (FIDE 9.2.2) would hash the same.
     */
    private function positionKey(): string
    {
        $placement = '';
        for ($r = 7; $r >= 0; $r--) {
            $empty = 0;
            for ($f = 0; $f < 8; $f++) {
                $p = $this->board[$r * 16 + $f];
                if ($p === self::EMPTY) {
                    $empty++;
                    continue;
                }
                if ($empty) {
                    $placement .= $empty;
                    $empty = 0;
                }
                $placement .= self::colorOf($p) === self::WHITE
                    ? self::PIECE_LETTERS_UPPER[self::typeOf($p)]
                    : self::PIECE_LETTERS[self::typeOf($p)];
            }
            if ($empty) $placement .= $empty;
            if ($r > 0) $placement .= '/';
        }
        $rights = '';
        if ($this->castling & self::CASTLE_WK) $rights .= 'K';
        if ($this->castling & self::CASTLE_WQ) $rights .= 'Q';
        if ($this->castling & self::CASTLE_BK) $rights .= 'k';
        if ($this->castling & self::CASTLE_BQ) $rights .= 'q';
        if ($rights === '') $rights = '-';

        $ep = ($this->ep >= 0 && $this->hasLegalEpCapture()) ? self::toAlgebraic($this->ep) : '-';
        return $placement . ' ' . ($this->turn === self::WHITE ? 'w' : 'b') . ' ' . $rights . ' ' . $ep;
    }

    private function hasLegalEpCapture(): bool
    {
        if ($this->ep < 0) return false;
        $us = $this->turn;
        $dir = $us === self::WHITE ? self::N : self::S;
        foreach ([$this->ep + $dir - 1, $this->ep + $dir + 1] as $from) {
            if (!self::onBoard($from)) continue;
            if ($this->board[$from] !== self::pieceOf(self::PAWN, $us)) continue;
            $mv = $this->mk($from, $this->ep, $this->board[$from], self::EMPTY, 0, self::FLAG_EP_CAPTURE);
            $this->make($mv);
            $ok = !$this->isAttacked($this->kingSq[$us], self::opp($us));
            $this->unmake();
            if ($ok) return true;
        }
        return false;
    }

    // -- PGN -----------------------------------------------------------------

    public function setHeader(string $k, string $v): void
    {
        $this->headers[$k] = $v;
    }

    public function header(string ...$args): array
    {
        if (count($args) === 0) return $this->headers;
        if (count($args) === 1 && is_array($args[0])) {
            $this->headers = $args[0];
            return $this->headers;
        }
        $this->headers[$args[0]] = $args[1] ?? '';
        return $this->headers;
    }

    public function getHeaders(): array
    {
        return $this->headers;
    }

    public function pgn(array $opts = []): string
    {
        $maxWidth = (int) ($opts['maxWidth'] ?? 0);

        // The result describes the FINAL position, so read it before rewinding.
        $result = $this->pgnResult();

        // Rewind to the position the movetext starts from. The FEN tag is only
        // written when that is NOT the standard start: including it always made
        // our own export impossible to re-import, because loadPgn() would load
        // the final position and then replay the whole game on top of it.
        $moves = [];
        while ($this->history) {
            array_unshift($moves, $this->unmake());
        }
        $startFen = $this->fen();
        if ($startFen !== self::START_FEN) {
            $this->setHeader('FEN', $startFen);
        } else {
            unset($this->headers['FEN']);
        }
        $this->setHeader('Result', $result);

        // Step forward one move at a time: san() MUST see the position in which
        // the move is legal, so compute it BEFORE playing the move. Re-making the
        // whole game first and then walking the list makes san() apply each move
        // on top of the finished position — which both prints wrong SAN and
        // leaves the board scrambled.
        $body = '';
        $line = '';
        foreach ($moves as $i => $mv) {
            $prefix = $i % 2 === 0 ? (int) (floor($i / 2) + 1) . '. ' : '';
            $token = $prefix . $this->san($mv);
            if ($maxWidth && strlen($line) + strlen($token) + 1 > $maxWidth) {
                $body .= trim($line) . "\n";
                $line = '';
            }
            $line .= ($line !== '' ? ' ' : '') . $token;
            $this->make($mv);
        }
        if ($line !== '') $body .= $line;

        $headers = '';
        foreach ($this->headers as $k => $v) {
            $headers .= "[{$k} \"" . str_replace('"', '\"', (string) $v) . "\"]\n";
        }

        return $headers . "\n" . ($body !== '' ? $body . ' ' : '') . $this->pgnResult() . "\n";
    }

    private function pgnResult(): string
    {
        if ($this->isCheckmate()) return $this->turn === self::WHITE ? '0-1' : '1-0';
        if ($this->isDraw()) return '1/2-1/2';
        return '*';
    }

    /**
     * Load a game from PGN text. Tolerates headers, comments, NAGs, variations
     * (skipped) and move numbers. Throws on an illegal move.
     */
    public function loadPgn(string $pgn): array
    {
        $headers = [];
        $body = preg_replace_callback(
            '/\[\s*(\w+)\s*"([^"]*)"\s*\]/',
            function (array $m) use (&$headers): string {
                $headers[$m[1]] = $m[2];
                return ' ';
            },
            $pgn
        ) ?? $pgn;

        if (isset($headers['FEN'])) {
            $this->load($headers['FEN']);
        } else {
            $this->reset();
        }

        // strip comments, NAGs, recursive variations, semicolon comments, results
        $body = preg_replace('/\{[^}]*\}/', ' ', $body) ?? $body;
        $body = preg_replace('/;[^\n]*/', ' ', $body) ?? $body;
        $body = preg_replace('/\$\d+/', ' ', $body) ?? $body;
        $body = preg_replace('/\([^()]*\)/', ' ', $body) ?? $body;
        // The result markers: note there is NO \b around "*" — a word boundary
        // needs a word character on one side, and " *" has none, so /\b\*\b/ never
        // matched and importing any UNFINISHED game (result "*") threw.
        $body = preg_replace('/(\b1-0\b|\b0-1\b|\b1\/2-1\/2\b|\*)/', ' ', $body) ?? $body;

        $tokens = preg_split('/\s+/', trim($body)) ?: [];
        foreach ($tokens as $token) {
            if ($token === '') continue;
            if (preg_match('/^\d+\.+$/', $token)) continue;   // "1." / "1..."
            if (preg_match('/^\d+\.*$/', $token)) continue;    // "1"
            $token = preg_replace('/^\d+\.+/', '', $token) ?? $token;  // "1.e4" glued
            if ($token === '') continue;
            if ($this->moveSan($token) === null) {
                throw new InvalidArgumentException("Invalid PGN move '{$token}' at ply " . count($this->history));
            }
        }

        $this->headers = $headers;
        return $this->headers;
    }

    // -- debug ---------------------------------------------------------------

    public function ascii(): string
    {
        $s = "\n  +------------------------+\n";
        for ($r = 7; $r >= 0; $r--) {
            $s .= ($r + 1) . ' |';
            for ($f = 0; $f < 8; $f++) {
                $p = $this->board[$r * 16 + $f];
                $s .= ' ' . ($p === self::EMPTY ? '.'
                    : (self::colorOf($p) === self::WHITE ? self::PIECE_LETTERS_UPPER[self::typeOf($p)] : self::PIECE_LETTERS[self::typeOf($p)]));
            }
            $s .= " |\n";
        }
        $s .= "  +------------------------+\n   a  b  c  d  e  f  g  h\n";
        return $s;
    }

    public function __toString(): string
    {
        return $this->fen();
    }

    // -- perft ---------------------------------------------------------------

    /** Count leaf nodes at $depth. THE correctness proof for a move generator. */
    public function perft(int $depth): int
    {
        $us = $this->turn;
        $them = self::opp($us);
        if ($depth === 0) return 1;

        $nodes = 0;
        foreach ($this->pseudoMoves() as $mv) {
            $this->make($mv);
            if (!$this->isAttacked($this->kingSq[$us], $them)) {
                $nodes += $depth === 1 ? 1 : $this->perft($depth - 1);
            }
            $this->unmake();
        }
        return $nodes;
    }

    /**
     * Perft divide: one entry per LEGAL first move. Illegal (pseudo-legal only)
     * moves are dropped rather than reported with a count of 0.
     *
     * @return array<int,array{move:string,nodes:int}>
     */
    public function perftDivide(int $depth): array
    {
        $us = $this->turn;
        $them = self::opp($us);
        $out = [];
        foreach ($this->pseudoMoves() as $mv) {
            $this->make($mv);
            $legal = !$this->isAttacked($this->kingSq[$us], $them);
            $nodes = $legal ? ($depth === 1 ? 1 : $this->perft($depth - 1)) : 0;
            $this->unmake();
            if ($legal) $out[] = ['move' => $this->sanQuiet($mv), 'nodes' => $nodes];
        }
        return $out;
    }

    /** Perft with repetition tracking disabled (the keys cost more than the search). */
    public function perftFast(int $depth): int
    {
        $prev = $this->trackKeys;
        $this->trackKeys = false;
        try {
            return $this->perft($depth);
        } finally {
            $this->trackKeys = $prev;
        }
    }

    public function perftDivideFast(int $depth): array
    {
        $prev = $this->trackKeys;
        $this->trackKeys = false;
        try {
            return $this->perftDivide($depth);
        } finally {
            $this->trackKeys = $prev;
        }
    }

    // -- private helpers -----------------------------------------------------

    /** Board mutated outside of make(): drop repetition history to stay safe. */
    private function syncKeys(): void
    {
        $this->history = [];
        $this->keys = $this->trackKeys ? [$this->positionKey()] : [];
    }

    private function boardRestore(int $from, int $to): void
    {
        $this->board[$from] = $this->board[$to];
        $this->board[$to] = self::EMPTY;
    }

    // -- static helpers ------------------------------------------------------

    /** 0x88 square -> "e4" (or null when off-board). */
    public static function toAlgebraic(int $sq): ?string
    {
        if ($sq < 0 || $sq > 119 || ($sq & 0x88)) return null;
        return 'abcdefgh'[$sq & 7] . (string) (($sq >> 4) + 1);
    }

    /** "e4" -> 0x88 square (or -1). */
    public static function fromAlgebraic(string $str): int
    {
        if (strlen($str) < 2) return -1;
        $f = strpos('abcdefgh', $str[0]);
        $r = strpos('12345678', $str[1]);
        if ($f === false || $r === false) return -1;
        return $r * 16 + $f;
    }

    public static function colorOf(int $p): int
    {
        return $p === self::EMPTY ? -1 : ($p <= self::KING ? self::WHITE : self::BLACK);
    }

    public static function typeOf(int $p): int
    {
        return $p === self::EMPTY ? 0 : ((($p - 1) % 6) + 1);
    }

    public static function isColorPiece(int $p, int $c): bool
    {
        return $p !== self::EMPTY && self::colorOf($p) === $c;
    }

    public static function opp(int $c): int
    {
        return $c ^ 1;
    }

    public static function pieceOf(int $type, int $color): int
    {
        return $color === self::WHITE ? $type : $type + 6;
    }

    public static function onBoard(int $sq): bool
    {
        return $sq >= 0 && $sq <= 119 && ($sq & 0x88) === 0;
    }

    public static function rankOf(int $sq): int
    {
        return $sq >> 4;
    }

    public static function fileOf(int $sq): int
    {
        return $sq & 7;
    }

    public static function pieceTypeToLetter(int $type): ?string
    {
        if (!$type) return null;
        return strtoupper(self::PIECE_LETTERS[$type] ?? '');
    }
}
