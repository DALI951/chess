/**
 * CHESS RULES ENGINE — canonical JavaScript implementation.
 *
 * Board representation: 0x88 mailbox (128-entry Uint8Array).
 *   square index = rank * 16 + file, rank 0 = rank "1", file 0 = file "a"
 *   A1 = 0, H1 = 7, A8 = 112, H8 = 119
 *   on-board test: (sq & 0x88) === 0
 *
 * Pieces are integers 0..12:
 *   0 empty | 1 P 2 N 3 B 4 R 5 Q 6 K (white) | 7 p 8 n 9 b 10 r 11 q 12 k (black)
 *   color(p) = p <= 6 ? WHITE : BLACK      type(p) = ((p - 1) % 6) + 1
 *
 * This file is mirrored 1:1 by api/includes/Engine.php, which is the
 * SERVER-AUTHORITATIVE copy. Both are proven by the same perft vectors in
 * tests/js/perft.test.mjs and tests/php/EnginePerftTest.php — if they ever
 * disagree, the tests fail.
 *
 * @author DALI951
 */

export const EMPTY = 0;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const WHITE = 0, BLACK = 1;

export const N = 16, S = -16, E = 1, W = -1;
export const NE = 17, NW = 15, SE = -15, SW = -17;

export const KNIGHT_OFFSETS = [33, 31, 18, 14, -14, -18, -31, -33];
export const BISHOP_OFFSETS = [NE, NW, SE, SW];
export const ROOK_OFFSETS = [N, S, E, W];
export const KING_OFFSETS = [N, S, E, W, NE, NW, SE, SW];
export const QUEEN_OFFSETS = KING_OFFSETS;

export const SLIDER_OFFSETS = {
  [BISHOP]: BISHOP_OFFSETS,
  [ROOK]: ROOK_OFFSETS,
  [QUEEN]: QUEEN_OFFSETS,
};

export const PIECE_LETTERS = ['', 'p', 'n', 'b', 'r', 'q', 'k'];
export const PIECE_LETTERS_UPPER = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];
export const PIECE_VALUES = [0, 100, 320, 330, 500, 900, 20000];

// Castling right bits
export const CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;

/** Per-square bitmask of castling rights that are REMOVED when this square is touched. */
const CASTLE_MASK = new Uint8Array(128);
CASTLE_MASK[0] = CASTLE_WQ;                 // a1
CASTLE_MASK[4] = CASTLE_WK | CASTLE_WQ;     // e1
CASTLE_MASK[7] = CASTLE_WK;                 // h1
CASTLE_MASK[112] = CASTLE_BQ;               // a8
CASTLE_MASK[116] = CASTLE_BK | CASTLE_BQ;   // e8
CASTLE_MASK[119] = CASTLE_BK;               // h8

// Move flags
export const FLAG_NORMAL = 'n';
export const FLAG_CAPTURE = 'c';
export const FLAG_BIG_PAWN = 'b';           // double pawn push
export const FLAG_EP_CAPTURE = 'e';
export const FLAG_PROMOTION = 'p';
export const FLAG_WK_CASTLE = 'k';
export const FLAG_WQ_CASTLE = 'q';
export const FLAG_BK_CASTLE = 'K';
export const FLAG_BQ_CASTLE = 'Q';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const PIECE_FROM_LETTER = {
  p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING,
  P: PAWN, N: KNIGHT, B: BISHOP, R: ROOK, Q: QUEEN, K: KING,
};
const LETTER_FROM_TYPE = ['', 'p', 'n', 'b', 'r', 'q', 'k'];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 0x88 square -> "e4" (or null when off-board). */
export function toAlgebraic(sq) {
  if (sq < 0 || sq > 119 || (sq & 0x88)) return null;
  return 'abcdefgh'[sq & 7] + String((sq >> 4) + 1);
}

/** "e4" -> 0x88 square (or -1). */
export function fromAlgebraic(str) {
  if (typeof str !== 'string' || str.length < 2) return -1;
  const f = 'abcdefgh'.indexOf(str[0]);
  const r = '12345678'.indexOf(str[1]);
  if (f < 0 || r < 0) return -1;
  return r * 16 + f;
}

export const colorOf = (p) => (p === EMPTY ? -1 : p <= KING ? WHITE : BLACK);
export const typeOf = (p) => (p === EMPTY ? 0 : ((p - 1) % 6) + 1);
export const isColorPiece = (p, c) => p !== EMPTY && colorOf(p) === c;
const opp = (c) => c ^ 1;
const pieceOf = (type, color) => (color === WHITE ? type : type + 6);

const onBoard = (sq) => sq >= 0 && sq <= 119 && (sq & 0x88) === 0;

/** Rank index 0..7 of a 0x88 square. */
const rankOf = (sq) => sq >> 4;
const fileOf = (sq) => sq & 7;

// ---------------------------------------------------------------------------
// Chess
// ---------------------------------------------------------------------------

export class Chess {
  constructor(fen = START_FEN) {
    this._board = new Uint8Array(128);
    this._turn = WHITE;
    this._castling = 0;
    this._ep = -1;              // 0x88 square or -1
    this._halfmove = 0;
    this._fullmove = 1;
    this._kingSq = [-1, -1];
    this._history = [];         // undo stack
    this._keys = [];            // position keys, index = ply
    this._headers = {};
    // Position keys are FEN strings — cheap in a game, ruinous in perft
    // (tens of millions of nodes). perft() turns tracking off.
    this._trackKeys = true;
    this.load(fen);
  }

  // -- state ---------------------------------------------------------------

  load(fen) {
    const parts = String(fen).trim().split(/\s+/);
    if (parts.length < 4) throw new Error(`Invalid FEN: ${fen}`);

    this._board.fill(EMPTY);
    const rows = parts[0].split('/');
    if (rows.length !== 8) throw new Error(`Invalid FEN board: ${parts[0]}`);

    for (let r = 0; r < 8; r++) {
      const row = rows[r];
      let file = 0;
      for (const ch of row) {
        const digit = Number(ch);
        if (!Number.isNaN(digit) && ch >= '1' && ch <= '8') {
          file += digit;
          continue;
        }
        const type = PIECE_FROM_LETTER[ch];
        if (!type) throw new Error(`Invalid FEN piece '${ch}'`);
        if (file > 7) throw new Error(`FEN rank overflow: ${row}`);
        // FEN case defines the colour of EACH piece — never infer it from the
        // row. Row 0 is rank 8, but a position can put a white king on rank 5.
        const color = ch === ch.toUpperCase() ? WHITE : BLACK;
        const sq = (7 - r) * 16 + file;
        this._board[sq] = pieceOf(type, color);
        if (type === KING) this._kingSq[color] = sq;
        file++;
      }
    }

    this._turn = parts[1] === 'b' ? BLACK : WHITE;

    this._castling = 0;
    if (parts[2].includes('K')) this._castling |= CASTLE_WK;
    if (parts[2].includes('Q')) this._castling |= CASTLE_WQ;
    if (parts[2].includes('k')) this._castling |= CASTLE_BK;
    if (parts[2].includes('q')) this._castling |= CASTLE_BQ;

    this._ep = parts[3] === '-' ? -1 : fromAlgebraic(parts[3]);

    this._halfmove = parts.length > 4 ? Number(parts[4]) || 0 : 0;
    this._fullmove = parts.length > 5 ? Number(parts[5]) || 1 : 1;

    if (this._kingSq[WHITE] < 0 || this._kingSq[BLACK] < 0) {
      throw new Error('Invalid FEN: both kings must be present');
    }

    this._history = [];
    this._keys = this._trackKeys ? [this._positionKey()] : [];
    return true;
  }

  reset() { return this.load(START_FEN); }

  fen() {
    let out = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this._board[r * 16 + f];
        if (p === EMPTY) { empty++; continue; }
        if (empty) { out += empty; empty = 0; }
        out += colorOf(p) === WHITE ? PIECE_LETTERS_UPPER[typeOf(p)] : PIECE_LETTERS[typeOf(p)];
      }
      if (empty) out += empty;
      if (r > 0) out += '/';
    }
    let rights = '';
    if (this._castling & CASTLE_WK) rights += 'K';
    if (this._castling & CASTLE_WQ) rights += 'Q';
    if (this._castling & CASTLE_BK) rights += 'k';
    if (this._castling & CASTLE_BQ) rights += 'q';
    return [
      out,
      this._turn === WHITE ? 'w' : 'b',
      rights || '-',
      this._ep >= 0 ? toAlgebraic(this._ep) : '-',
      this._halfmove,
      this._fullmove,
    ].join(' ');
  }

  board() { return Array.from(this._board); }
  turn() { return this._turn === WHITE ? 'w' : 'b'; }
  turnColor() { return this._turn; }
  castlingRights() { return this._castling; }
  epSquare() { return this._ep >= 0 ? toAlgebraic(this._ep) : undefined; }
  halfmoveClock() { return this._halfmove; }
  fullmoveNumber() { return this._fullmove; }
  moveNumber() { return this._fullmove; }
  kingSquare(color = this._turn) { return toAlgebraic(this._kingSq[color]); }

  /** Internal 0x88 king square. */
  kingSq(color = this._turn) { return this._kingSq[color]; }

  get(sq) {
    const s = typeof sq === 'string' ? fromAlgebraic(sq) : sq;
    return onBoard(s) ? this._board[s] : undefined;
  }

  put(piece, sq) {
    const s = typeof sq === 'string' ? fromAlgebraic(sq) : sq;
    if (!onBoard(s)) return null;
    this._board[s] = piece;
    if (typeOf(piece) === KING) this._kingSq[colorOf(piece)] = s;
    this._syncKeys();
    return s;
  }

  remove(sq) {
    const s = typeof sq === 'string' ? fromAlgebraic(sq) : sq;
    if (!onBoard(s) || this._board[s] === EMPTY) return null;
    const p = this._board[s];
    this._board[s] = EMPTY;
    this._syncKeys();
    return p;
  }

  _syncKeys() {
    // board mutated outside of make(); drop repetition history to stay safe
    this._history = [];
    this._keys = this._trackKeys ? [this._positionKey()] : [];
  }

  // -- attack detection ----------------------------------------------------

  /** Is `sq` attacked by any piece of color `byColor`? */
  isAttacked(sq, byColor) {
    if (!onBoard(sq)) return false;
    const board = this._board;

    // pawns: a white pawn on sq-15/sq-17 attacks sq, etc.
    const pawnDir = byColor === WHITE ? -16 : 16;
    for (const side of [-1, 1]) {
      const from = sq + pawnDir + side;
      if (onBoard(from) && board[from] === pieceOf(PAWN, byColor)) return true;
    }

    for (const off of KNIGHT_OFFSETS) {
      const from = sq + off;
      if (onBoard(from) && board[from] === pieceOf(KNIGHT, byColor)) return true;
    }

    for (const off of KING_OFFSETS) {
      const from = sq + off;
      if (onBoard(from) && board[from] === pieceOf(KING, byColor)) return true;
    }

    for (const [type, offsets] of Object.entries(SLIDER_OFFSETS)) {
      const t = Number(type);
      for (const off of offsets) {
        let from = sq + off;
        while (onBoard(from)) {
          const p = board[from];
          if (p !== EMPTY) {
            if (colorOf(p) === byColor && typeOf(p) === t) return true;
            break;
          }
          from += off;
        }
      }
    }

    return false;
  }

  inCheck() { return this.isAttacked(this._kingSq[this._turn], opp(this._turn)); }
  isCheck() { return this.inCheck(); }

  // -- move generation -----------------------------------------------------

  /**
   * All legal moves for the side to move.
   * @param {{square?: string|number, verbose?: boolean}} [opts]
   */
  moves(opts = {}) {
    const verbose = opts.verbose !== false;
    let fromSq = -1;
    if (opts.square !== undefined && opts.square !== null) {
      fromSq = typeof opts.square === 'string' ? fromAlgebraic(opts.square) : opts.square;
      if (!onBoard(fromSq)) return [];
    }

    const legal = this._legalMoves();
    const out = [];
    for (const mv of legal) {
      if (fromSq >= 0 && mv.from !== fromSq) continue;
      out.push(verbose ? this._withSan(mv) : { from: toAlgebraic(mv.from), to: toAlgebraic(mv.to) });
    }
    return out;
  }

  /** Every pseudo-legal move for the side to move, as raw move objects. */
  _pseudoMoves() {
    const board = this._board;
    const us = this._turn;
    const them = opp(us);
    const moves = [];

    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }  // skip the off-board gap
      const piece = board[sq];
      if (piece === EMPTY || colorOf(piece) !== us) continue;
      const type = typeOf(piece);

      if (type === PAWN) {
        const dir = us === WHITE ? N : S;
        const startRank = us === WHITE ? 1 : 6;
        const promoRank = us === WHITE ? 7 : 0;

        const one = sq + dir;
        if (onBoard(one) && board[one] === EMPTY) {
          if (rankOf(one) === promoRank) {
            for (const t of [QUEEN, ROOK, BISHOP, KNIGHT]) {
              moves.push(this._mk(sq, one, piece, EMPTY, t, FLAG_PROMOTION));
            }
          } else {
            moves.push(this._mk(sq, one, piece, EMPTY, 0, FLAG_NORMAL));
            const two = one + dir;
            if (rankOf(sq) === startRank && board[two] === EMPTY) {
              moves.push(this._mk(sq, two, piece, EMPTY, 0, FLAG_BIG_PAWN, one));
            }
          }
        }

        for (const side of [-1, 1]) {
          const to = sq + dir + side;
          if (!onBoard(to)) continue;
          const target = board[to];
          if (target !== EMPTY && colorOf(target) === them) {
            if (rankOf(to) === promoRank) {
              for (const t of [QUEEN, ROOK, BISHOP, KNIGHT]) {
                moves.push(this._mk(sq, to, piece, target, t, FLAG_PROMOTION));
              }
            } else {
              moves.push(this._mk(sq, to, piece, target, 0, FLAG_CAPTURE));
            }
          } else if (to === this._ep && target === EMPTY) {
            moves.push(this._mk(sq, to, piece, EMPTY, 0, FLAG_EP_CAPTURE));
          }
        }
        continue;
      }

      if (type === KNIGHT || type === KING) {
        const offsets = type === KNIGHT ? KNIGHT_OFFSETS : KING_OFFSETS;
        for (const off of offsets) {
          const to = sq + off;
          if (!onBoard(to)) continue;
          const target = board[to];
          if (target === EMPTY) {
            moves.push(this._mk(sq, to, piece, EMPTY, 0, FLAG_NORMAL));
          } else if (colorOf(target) === them) {
            moves.push(this._mk(sq, to, piece, target, 0, FLAG_CAPTURE));
          }
        }
        continue;
      }

      const offsets = SLIDER_OFFSETS[type];
      for (const off of offsets) {
        let to = sq + off;
        while (onBoard(to)) {
          const target = board[to];
          if (target === EMPTY) {
            moves.push(this._mk(sq, to, piece, EMPTY, 0, FLAG_NORMAL));
          } else {
            if (colorOf(target) === them) moves.push(this._mk(sq, to, piece, target, 0, FLAG_CAPTURE));
            break;
          }
          to += off;
        }
      }
    }

    // castling
    if (!this.isAttacked(this._kingSq[us], them)) {
      const ksq = this._kingSq[us];
      if (us === WHITE && ksq === 4) {
        if ((this._castling & CASTLE_WK) &&
            board[5] === EMPTY && board[6] === EMPTY &&
            board[7] === pieceOf(ROOK, WHITE) &&
            !this.isAttacked(5, them) && !this.isAttacked(6, them)) {
          moves.push(this._mk(4, 6, board[4], EMPTY, 0, FLAG_WK_CASTLE));
        }
        if ((this._castling & CASTLE_WQ) &&
            board[1] === EMPTY && board[2] === EMPTY && board[3] === EMPTY &&
            board[0] === pieceOf(ROOK, WHITE) &&
            !this.isAttacked(3, them) && !this.isAttacked(2, them)) {
          moves.push(this._mk(4, 2, board[4], EMPTY, 0, FLAG_WQ_CASTLE));
        }
      } else if (us === BLACK && ksq === 116) {
        if ((this._castling & CASTLE_BK) &&
            board[117] === EMPTY && board[118] === EMPTY &&
            board[119] === pieceOf(ROOK, BLACK) &&
            !this.isAttacked(117, them) && !this.isAttacked(118, them)) {
          moves.push(this._mk(116, 118, board[116], EMPTY, 0, FLAG_BK_CASTLE));
        }
        if ((this._castling & CASTLE_BQ) &&
            board[113] === EMPTY && board[114] === EMPTY && board[115] === EMPTY &&
            board[112] === pieceOf(ROOK, BLACK) &&
            !this.isAttacked(115, them) && !this.isAttacked(114, them)) {
          moves.push(this._mk(116, 114, board[116], EMPTY, 0, FLAG_BQ_CASTLE));
        }
      }
    }

    return moves;
  }

  /** Pseudo-legal moves filtered for king safety. */
  _legalMoves() {
    const us = this._turn;
    const them = opp(us);
    const legal = [];
    for (const mv of this._pseudoMoves()) {
      this._make(mv);
      const ok = !this.isAttacked(this._kingSq[us], them);
      this._unmake();
      if (ok) legal.push(mv);
    }
    return legal;
  }

  _mk(from, to, piece, captured, promotion, flag, epSet) {
    return {
      from, to, piece, captured, promotion: promotion || 0, flag,
      ep: flag === FLAG_BIG_PAWN ? (epSet ?? -1) : -1,
      color: colorOf(piece),
    };
  }

  // -- make / unmake -------------------------------------------------------

  _make(mv) {
    const board = this._board;
    const us = this._turn;

    const state = {
      move: mv,
      castling: this._castling,
      ep: this._ep,
      halfmove: this._halfmove,
      fullmove: this._fullmove,
      kingSq: this._kingSq[us],
      capturedSq: -1,
      capturedPiece: EMPTY,
    };

    // remove the en-passant victim before writing the destination
    if (mv.flag === FLAG_EP_CAPTURE) {
      const victimSq = mv.to + (us === WHITE ? S : N);
      state.capturedSq = victimSq;
      state.capturedPiece = board[victimSq];
      board[victimSq] = EMPTY;
    }

    board[mv.from] = EMPTY;
    board[mv.to] = mv.promotion ? pieceOf(mv.promotion, us) : mv.piece;

    if (typeOf(mv.piece) === KING) this._kingSq[us] = mv.to;

    // rook hop for castling
    if (mv.flag === FLAG_WK_CASTLE) { board[5] = board[7]; board[7] = EMPTY; }
    if (mv.flag === FLAG_WQ_CASTLE) { board[3] = board[0]; board[0] = EMPTY; }
    if (mv.flag === FLAG_BK_CASTLE) { board[117] = board[119]; board[119] = EMPTY; }
    if (mv.flag === FLAG_BQ_CASTLE) { board[115] = board[112]; board[112] = EMPTY; }

    this._castling &= ~(CASTLE_MASK[mv.from] | CASTLE_MASK[mv.to]);
    this._ep = mv.flag === FLAG_BIG_PAWN ? mv.ep : -1;
    this._halfmove = (typeOf(mv.piece) === PAWN || mv.captured !== EMPTY) ? 0 : this._halfmove + 1;
    if (us === BLACK) this._fullmove++;

    this._history.push(state);
    this._turn = opp(us);
    if (this._trackKeys) this._keys.push(this._positionKey());
  }

  _unmake() {
    const state = this._history.pop();
    if (!state) return null;
    const mv = state.move;
    const us = colorOf(mv.piece);

    this._turn = us;
    if (this._trackKeys) this._keys.pop();

    this._board[mv.to] = EMPTY;
    this._board[mv.from] = mv.piece;

    if (state.capturedSq >= 0) this._board[state.capturedSq] = state.capturedPiece;
    else if (mv.captured !== EMPTY) this._board[mv.to] = mv.captured;

    if (typeOf(mv.piece) === KING) this._kingSq[us] = state.kingSq;

    if (mv.flag === FLAG_WK_CASTLE) { board_restore(this._board, 7, 5); }
    if (mv.flag === FLAG_WQ_CASTLE) { board_restore(this._board, 0, 3); }
    if (mv.flag === FLAG_BK_CASTLE) { board_restore(this._board, 119, 117); }
    if (mv.flag === FLAG_BQ_CASTLE) { board_restore(this._board, 112, 115); }

    this._castling = state.castling;
    this._ep = state.ep;
    this._halfmove = state.halfmove;
    this._fullmove = state.fullmove;
    return mv;
  }

  // -- playing moves -------------------------------------------------------

  /**
   * Play a move. Accepts {from,to,promotion} with algebraic or 0x88 squares.
   * @returns {object|null} the played move (with san + before/after FEN), or null if illegal.
   */
  move(input) {
    const from = typeof input.from === 'string' ? fromAlgebraic(input.from) : input.from;
    const to = typeof input.to === 'string' ? fromAlgebraic(input.to) : input.to;
    if (!onBoard(from) || !onBoard(to)) return null;

    const wantedPromo = typeof input.promotion === 'string'
      ? PIECE_FROM_LETTER[input.promotion.toLowerCase()]
      : input.promotion;

    const legal = this._legalMoves().filter((m) => m.from === from && m.to === to);
    if (!legal.length) return null;

    let chosen;
    if (legal.length === 1) {
      chosen = legal[0];
    } else {
      // promotion (or a rare duplicate) — disambiguate
      const promoMoves = legal.filter((m) => m.flag === FLAG_PROMOTION);
      if (wantedPromo) {
        chosen = promoMoves.find((m) => m.promotion === wantedPromo)
              || legal.find((m) => m.promotion === wantedPromo);
      } else {
        chosen = promoMoves.find((m) => m.promotion === QUEEN) || legal[0];
      }
      if (!chosen) return null;
    }

    const before = this.fen();
    const decorated = this._withSan(chosen);
    this._make(chosen);
    decorated.before = before;
    decorated.after = this.fen();
    return decorated;
  }

  /** Play a move given in SAN ("e4", "Nf3", "exd5", "O-O", "e8=Q+"). */
  moveSan(san) {
    const target = String(san).trim();
    for (const mv of this._legalMoves()) {
      if (this._san(mv) === target) return this.move({ from: mv.from, to: mv.to, promotion: pieceTypeToLetter(mv.promotion) });
    }
    return null;
  }

  undo() {
    const mv = this._unmake();
    if (!mv) return null;
    return this._withSan(mv);
  }

  history(opts = {}) {
    const verbose = opts.verbose !== false;
    const undoCopy = this._undo;
    this._undo = false;
    const out = [];
    while (this._history.length) {
      const mv = this._unmake();
      out.unshift(verbose ? this._withSan(mv) : mv.san || this._san(mv));
    }
    this._undo = undoCopy;
    return out;
  }

  // -- SAN -----------------------------------------------------------------

  _withSan(mv) {
    const san = this._san(mv);
    return {
      from: toAlgebraic(mv.from),
      to: toAlgebraic(mv.to),
      piece: PIECE_LETTERS_UPPER[typeOf(mv.piece)],
      pieceType: typeOf(mv.piece),
      color: mv.color,
      captured: mv.captured ? PIECE_LETTERS[typeOf(mv.captured)] : undefined,
      promotion: mv.promotion ? pieceTypeToLetter(mv.promotion) : undefined,
      flag: mv.flag,
      san,
      lan: toAlgebraic(mv.from) + (mv.captured ? 'x' : '') + toAlgebraic(mv.to) + (mv.promotion ? '=' + pieceTypeToLetter(mv.promotion) : ''),
      before: this.fen(),
      after: null,
    };
  }

  _san(mv) {
    let san = '';

    if (mv.flag === FLAG_WK_CASTLE) san = 'O-O';
    else if (mv.flag === FLAG_WQ_CASTLE) san = 'O-O-O';
    else if (mv.flag === FLAG_BK_CASTLE) san = 'O-O';
    else if (mv.flag === FLAG_BQ_CASTLE) san = 'O-O-O';
    else {
      const type = typeOf(mv.piece);
      const capture = mv.captured !== EMPTY || mv.flag === FLAG_EP_CAPTURE;

      if (type === PAWN) {
        if (capture) san += 'abcdefgh'[fileOf(mv.from)] + 'x';
      } else {
        san += PIECE_LETTERS_UPPER[type];
        // disambiguation against other legal moves of the same piece type
        const rivals = this._legalMoves().filter((m) =>
          m !== mv &&
          typeOf(m.piece) === type &&
          m.to === mv.to &&
          colorOf(m.piece) === mv.color
        );
        if (rivals.length) {
          const sameFile = rivals.some((m) => fileOf(m.from) === fileOf(mv.from));
          const sameRank = rivals.some((m) => rankOf(m.from) === rankOf(mv.from));
          if (!sameFile) san += 'abcdefgh'[fileOf(mv.from)];
          else if (!sameRank) san += String(rankOf(mv.from) + 1);
          else san += toAlgebraic(mv.from);
        }
      }

      if (capture) san += 'x';
      san += toAlgebraic(mv.to);
      if (mv.flag === FLAG_PROMOTION) san += '=' + PIECE_LETTERS_UPPER[mv.promotion];
    }

    // check / mate suffix
    this._make(mv);
    if (this.isAttacked(this._kingSq[this._turn], opp(this._turn))) {
      san += this._legalMoves().length === 0 ? '#' : '+';
    }
    this._unmake();

    return san;
  }

  // -- status --------------------------------------------------------------

  isCheckmate() {
    if (!this.inCheck()) return false;
    return this._legalMoves().length === 0;
  }

  isStalemate() {
    if (this.inCheck()) return false;
    return this._legalMoves().length === 0;
  }

  isInsufficientMaterial() {
    const pieces = [];
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = this._board[sq];
      if (p !== EMPTY) pieces.push({ type: typeOf(p), sq });
    }
    if (pieces.length <= 2) return true;                       // K vs K, K+minor vs K
    if (pieces.some((p) => p.type === PAWN || p.type === ROOK || p.type === QUEEN)) return false;
    if (pieces.length === 3) return true;                       // K + minor vs K

    // K+B vs K+B with same-coloured bishops only
    if (pieces.length === 4 && pieces.every((p) => p.type === BISHOP)) {
      const light = (sq) => {
        const f = fileOf(sq) + rankOf(sq);
        return (f % 2 === 0) ? 0 : 1;   // 0 = dark, 1 = light
      };
      return light(pieces[0].sq) === light(pieces[1].sq);
    }
    return false;
  }

  isThreefoldRepetition() {
    const key = this._positionKey();
    let count = 0;
    for (const k of this._keys) if (k === key) count++;
    return count >= 3;
  }

  isDrawByFiftyMoves() { return this._halfmove >= 100; }

  isDraw() {
    return this.isStalemate()
      || this.isInsufficientMaterial()
      || this.isThreefoldRepetition()
      || this.isDrawByFiftyMoves();
  }

  isGameOver() { return this.isCheckmate() || this.isDraw(); }

  /** 0 = ongoing, 1 = white win, -1 = black win, 2 = draw. */
  outcome() {
    if (this.isCheckmate()) return this._turn === WHITE ? -1 : 1;
    if (this.isDraw()) return 2;
    return 0;
  }

  /** Why the game is over, for the UI: 'checkmate'|'stalemate'|'repetition'|'fifty'|'material'|'ongoing' */
  endReason() {
    if (this.isCheckmate()) return 'checkmate';
    if (this.isStalemate()) return 'stalemate';
    if (this.isThreefoldRepetition()) return 'repetition';
    if (this.isDrawByFiftyMoves()) return 'fifty';
    if (this.isInsufficientMaterial()) return 'material';
    return 'ongoing';
  }

  // -- repetition key ------------------------------------------------------

  /**
   * FEN parts 1-4. The en-passant square is only included when the side to move
   * actually has a legal en-passant capture — otherwise two positions that are
   * NOT repetitions (FIDE 9.2.2) would hash the same and fake a threefold.
   */
  _positionKey() {
    let placement = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this._board[r * 16 + f];
        if (p === EMPTY) { empty++; continue; }
        if (empty) { placement += empty; empty = 0; }
        placement += colorOf(p) === WHITE ? PIECE_LETTERS_UPPER[typeOf(p)] : PIECE_LETTERS[typeOf(p)];
      }
      if (empty) placement += empty;
      if (r > 0) placement += '/';
    }
    let rights = '';
    if (this._castling & CASTLE_WK) rights += 'K';
    if (this._castling & CASTLE_WQ) rights += 'Q';
    if (this._castling & CASTLE_BK) rights += 'k';
    if (this._castling & CASTLE_BQ) rights += 'q';
    if (!rights) rights = '-';

    const ep = this._ep >= 0 && this._hasLegalEpCapture() ? toAlgebraic(this._ep) : '-';
    return `${placement} ${this._turn === WHITE ? 'w' : 'b'} ${rights} ${ep}`;
  }

  _hasLegalEpCapture() {
    if (this._ep < 0) return false;
    const us = this._turn;
    const dir = us === WHITE ? N : S;
    const fromSquares = [this._ep + dir - 1, this._ep + dir + 1];
    for (const from of fromSquares) {
      if (!onBoard(from)) continue;
      if (this._board[from] !== pieceOf(PAWN, us)) continue;
      const mv = this._mk(from, this._ep, this._board[from], EMPTY, 0, FLAG_EP_CAPTURE);
      this._make(mv);
      const ok = !this.isAttacked(this._kingSq[us], opp(us));
      this._unmake();
      if (ok) return true;
    }
    return false;
  }

  // -- PGN -----------------------------------------------------------------

  header(...args) {
    if (args.length === 0) return { ...this._headers };
    if (args.length === 1 && typeof args[0] === 'object') {
      this._headers = { ...args[0] };
      return { ...this._headers };
    }
    this._headers[args[0]] = args[1];
    return { ...this._headers };
  }

  setHeader(k, v) { this._headers[k] = v; }
  getHeaders() { return { ...this._headers }; }

  pgn(opts = {}) {
    const maxWidth = opts.maxWidth || 0;
    this.header('Result', this._pgnResult());
    this.header('FEN', this.fen());

    const undoCopy = this._undo;
    this._undo = false;

    const moves = [];
    while (this._history.length) moves.unshift(this._unmake());

    this._undo = undoCopy;
    for (const mv of moves) this._make(mv);

    let body = '';
    let line = '';
    moves.forEach((mv, i) => {
      const prefix = i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : '';
      const token = prefix + this._san(mv);
      if (maxWidth && line.length + token.length + 1 > maxWidth) {
        body += line.trim() + '\n';
        line = '';
      }
      line += (line ? ' ' : '') + token;
    });
    if (line) body += line;

    const headers = Object.entries(this._headers)
      .map(([k, v]) => `[${k} "${String(v).replace(/"/g, '\\"')}"]`)
      .join('\n');

    return headers + '\n\n' + (body ? body + ' ' : '') + this._pgnResult() + '\n';
  }

  _pgnResult() {
    if (this.isCheckmate()) return this._turn === WHITE ? '0-1' : '1-0';
    if (this.isDraw()) return '1/2-1/2';
    return '*';
  }

  /**
   * Load a game from PGN text. Tolerates headers, comments, NAGs, variations
   * (skipped) and move numbers. Throws on an illegal move.
   */
  loadPgn(pgn) {
    const headerRegex = /\[\s*(\w+)\s*"([^"]*)"\s*\]/g;
    let m;
    const headers = {};
    let body = String(pgn).replace(headerRegex, (full, k, v) => { headers[k] = v; return ' '; });

    if (headers.FEN) this.load(headers.FEN);
    else this.reset();

    // strip comments, NAGs, recursive variations, semicolon comments, results
    body = body
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/;[^\n]*/g, ' ')
      .replace(/\$\d+/g, ' ')
      .replace(/\([^()]*\)/g, ' ')
      .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, ' ');

    const tokens = body.split(/\s+/).filter((t) => t.length && !/^\d+\.+$/.test(t) && !/^\d+\.{0,3}$/.test(t));
    for (let t = 0; t < tokens.length; t++) {
      let token = tokens[t];
      if (/^\d+\.+$/.test(token)) token = token.replace(/^\d+\.+/, '');   // "1." glued to move
      if (!token) continue;
      if (!this.moveSan(token)) {
        throw new Error(`Invalid PGN move '${token}' at ply ${this._history.length}`);
      }
    }

    this._headers = headers;
    return this._headers;
  }

  // -- debug ---------------------------------------------------------------

  ascii() {
    let s = '\n  +------------------------+\n';
    for (let r = 7; r >= 0; r--) {
      s += `${r + 1} |`;
      for (let f = 0; f < 8; f++) {
        const p = this._board[r * 16 + f];
        s += ' ' + (p === EMPTY ? '.' : colorOf(p) === WHITE ? PIECE_LETTERS_UPPER[typeOf(p)] : PIECE_LETTERS[typeOf(p)]);
      }
      s += ' |\n';
    }
    s += '  +------------------------+\n   a  b  c  d  e  f  g  h\n';
    return s;
  }

  toString() { return this.fen(); }

  // -- perft ---------------------------------------------------------------

  /** Count leaf nodes at `depth`. THE correctness proof for a move generator. */
  perft(depth) {
    const us = this._turn;
    const them = opp(us);
    if (depth === 0) return 1;

    let nodes = 0;
    for (const mv of this._pseudoMoves()) {
      this._make(mv);
      if (!this.isAttacked(this._kingSq[us], them)) {
        nodes += depth === 1 ? 1 : this.perft(depth - 1);
      }
      this._unmake();
    }
    return nodes;
  }

  /**
   * Perft divide: one entry per LEGAL first move.
   *
   * Pseudo-legal moves that leave the king in check are dropped entirely
   * rather than reported with a count of 0 — a divide that lists illegal
   * moves makes the sum look right while the row count lies about how many
   * moves the position actually has.
   */
  perftDivide(depth) {
    const us = this._turn;
    const them = opp(us);
    const out = [];
    for (const mv of this._pseudoMoves()) {
      this._make(mv);
      const legal = !this.isAttacked(this._kingSq[us], them);
      const nodes = legal ? (depth === 1 ? 1 : this.perft(depth - 1)) : 0;
      this._unmake();
      if (legal) out.push({ move: this._sanQuiet(mv), nodes });
    }
    return out;
  }

  /** Perft with repetition tracking disabled. Restores the flag afterwards. */
  perftFast(depth) {
    const prev = this._trackKeys;
    this._trackKeys = false;
    try {
      return this.perft(depth);
    } finally {
      this._trackKeys = prev;
    }
  }

  perftDivideFast(depth) {
    const prev = this._trackKeys;
    this._trackKeys = false;
    try {
      return this.perftDivide(depth);
    } finally {
      this._trackKeys = prev;
    }
  }

  _sanQuiet(mv) {
    if (mv.flag === FLAG_WK_CASTLE || mv.flag === FLAG_BK_CASTLE) return 'O-O';
    if (mv.flag === FLAG_WQ_CASTLE || mv.flag === FLAG_BQ_CASTLE) return 'O-O-O';
    const type = typeOf(mv.piece);
    const cap = mv.captured !== EMPTY || mv.flag === FLAG_EP_CAPTURE;
    let s = type === PAWN ? '' : PIECE_LETTERS_UPPER[type];
    if (type === PAWN && cap) s += 'abcdefgh'[fileOf(mv.from)];
    if (cap) s += 'x';
    s += toAlgebraic(mv.to);
    if (mv.flag === FLAG_PROMOTION) s += '=' + PIECE_LETTERS_UPPER[mv.promotion];
    return s;
  }
}

function board_restore(board, from, to) {
  board[from] = board[to];
  board[to] = EMPTY;
}

export function pieceTypeToLetter(type) {
  if (!type) return undefined;
  const l = LETTER_FROM_TYPE[type];
  return l ? l.toUpperCase() : undefined;
}
