/**
 * REFERENCE CHESS GENERATOR â€” deliberately naive, 8x8, no shared code with
 * assets/js/engine.js. Used as the oracle for the differential test.
 *
 *   index = rank*8 + file, rank 0 = rank 1, file 0 = 'a'
 *   pieces use the same 0..12 encoding as engine.js (0 empty, 1-6 white
 *   P N B R Q K, 7-12 black) so the two can be compared move-for-move
 *
 * @author DALI951
 */

export const T = { P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6 };
export const KNIGHT_J = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
export const KING_J = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
export const DIAG = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
export const ORTH = [[0, 1], [1, 0], [0, -1], [-1, 0]];

const ok = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const rf = (sq) => sq & 7;      // FILE
const rk = (sq) => sq >> 3;     // RANK
const mkSq = (f, r) => r * 8 + f;
const sq8 = (s) => mkSq('abcdefgh'.indexOf(s[0]), Number(s[1]) - 1);
const alg = (sq) => 'abcdefgh'[rf(sq)] + (rk(sq) + 1);
const colorOf = (p) => (p === 0 ? -1 : p <= 6 ? 0 : 1);
const typeOf = (p) => (p === 0 ? 0 : ((p - 1) % 6) + 1);
const PROMO_LETTER = { 2: 'n', 3: 'b', 4: 'r', 5: 'q' };

export function parseFen(fen) {
  const [placement, turn, rights, ep] = fen.trim().split(/\s+/);
  const b = new Array(64).fill(0);
  placement.split('/').forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') { f += Number(ch); continue; }
      const type = T[ch.toUpperCase()];
      const color = ch === ch.toUpperCase() ? 0 : 1;   // UPPERCASE = white
      b[mkSq(f, 7 - i)] = type + (color ? 6 : 0);
      f++;
    }
  });
  return { b, turn: turn === 'w' ? 0 : 1, rights: rights || '', ep: ep && ep !== '-' ? sq8(ep) : -1 };
}

export function toFen8(state) {
  let out = '';
  for (let r = 7; r >= 0; r--) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = state.b[mkSq(f, r)];
      if (!p) { empty++; continue; }
      if (empty) { out += empty; empty = 0; }
      out += colorOf(p) === 0 ? 'PNBRQK'[typeOf(p) - 1] : 'pnbrqk'[typeOf(p) - 1];
    }
    if (empty) out += empty;
    if (r > 0) out += '/';
  }
  return out;
}

export function findKing(b, color) {
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (p && typeOf(p) === T.K && colorOf(p) === color) return s;
  }
  return -1;
}

/** Is 8x8 square `sq` attacked by any piece of colour `byColor`? */
export function attacked(b, sq, byColor) {
  const targetF = rf(sq), targetR = rk(sq);
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!p || colorOf(p) !== byColor) continue;
    const type = typeOf(p);
    const f = rf(s), r = rk(s);
    const df = targetF - f, dr = targetR - r;

    if (type === T.P) {
      const fwd = byColor === 0 ? 1 : -1;      // white pawns advance up the board
      if (dr === fwd && Math.abs(df) === 1) return true;
    } else if (type === T.N) {
      if (KNIGHT_J.some(([a, c]) => a === df && c === dr)) return true;
    } else if (type === T.K) {
      if (KING_J.some(([a, c]) => a === df && c === dr)) return true;
    } else {
      const dirs = type === T.B ? DIAG : type === T.R ? ORTH : [...DIAG, ...ORTH];
      for (const [dx, dy] of dirs) {
        if (dx === df && dy === dr) return true;      // adjacent = attack
        let nf = f + dx, nr = r + dy;
        while (ok(nf, nr)) {
          if (nf === targetF && nr === targetR) return true;
          if (b[mkSq(nf, nr)]) break;                  // blocked
          nf += dx; nr += dy;
        }
      }
    }
  }
  return false;
}

/** All pseudo-legal moves. */
export function refPseudo(b, turn, ep, rights = '') {
  const out = [];
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!p || colorOf(p) !== turn) continue;
    const type = typeOf(p);
    const f = rf(s), r = rk(s);

    const push = (tf, tr, promo) => {
      if (!ok(tf, tr)) return;
      const to = mkSq(tf, tr);
      const target = b[to];
      if (target && colorOf(target) === turn) return;
      // ONLY a pawn may capture onto the en-passant square. A king walking
      // onto g3 is just a king move — treating it as ep would delete the
      // wrong piece.
      if (type === T.P && to === ep && !target) { out.push({ from: s, to, type, piece: p, promo: 0, ep: true }); return; }
      if (target) out.push({ from: s, to, type: target, piece: p, promo, cap: true });
      else out.push({ from: s, to, type, piece: p, promo });
    };

    if (type === T.P) {
      const fwd = turn === 0 ? 1 : -1;
      const startR = turn === 0 ? 1 : 6;
      const promoR = turn === 0 ? 7 : 0;
      const nr = r + fwd;
      if (ok(f, nr) && !b[mkSq(f, nr)]) {
        if (nr === promoR) { for (const pr of [T.Q, T.R, T.B, T.N]) push(f, nr, pr); }
        else {
          push(f, nr, 0);
          if (r === startR && ok(f, r + 2 * fwd) && !b[mkSq(f, r + 2 * fwd)]) {
            out.push({ from: s, to: mkSq(f, r + 2 * fwd), type, piece: p, promo: 0, dbl: true, epSet: mkSq(f, nr) });
          }
        }
      }
      for (const df of [-1, 1]) {
        const tf = f + df;
        if (!ok(tf, nr)) continue;
        const to = mkSq(tf, nr);
        const target = b[to];
        if (target && colorOf(target) !== turn) {
          if (nr === promoR) { for (const pr of [T.Q, T.R, T.B, T.N]) push(tf, nr, pr); }
          else push(tf, nr, 0);
        } else if (to === ep && !target) {
          out.push({ from: s, to, type, piece: p, promo: 0, ep: true });
        }
      }
    } else if (type === T.N) {
      for (const [df, dr] of KNIGHT_J) push(f + df, r + dr, 0);
    } else if (type === T.K) {
      for (const [df, dr] of KING_J) push(f + df, r + dr, 0);
      const home = turn === 0 ? 0 : 7;
      const rook = T.R + (turn ? 6 : 0);
      if (s === mkSq(4, home) && !attacked(b, s, turn ^ 1)) {
        const kRight = turn === 0 ? 'K' : 'k';
        const qRight = turn === 0 ? 'Q' : 'q';
        if (rights.includes(kRight) &&
            !b[mkSq(5, home)] && !b[mkSq(6, home)] && b[mkSq(7, home)] === rook &&
            !attacked(b, mkSq(5, home), turn ^ 1) && !attacked(b, mkSq(6, home), turn ^ 1)) {
          out.push({ from: s, to: mkSq(6, home), type, piece: p, promo: 0, castle: 'K' });
        }
        if (rights.includes(qRight) &&
            !b[mkSq(1, home)] && !b[mkSq(2, home)] && !b[mkSq(3, home)] && b[mkSq(0, home)] === rook &&
            !attacked(b, mkSq(3, home), turn ^ 1) && !attacked(b, mkSq(2, home), turn ^ 1)) {
          out.push({ from: s, to: mkSq(2, home), type, piece: p, promo: 0, castle: 'Q' });
        }
      }
    } else {
      const dirs = type === T.B ? DIAG : type === T.R ? ORTH : [...DIAG, ...ORTH];
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (ok(nf, nr)) {
          const to = mkSq(nf, nr);
          const target = b[to];
          if (target) {
            if (colorOf(target) !== turn) out.push({ from: s, to, type: target, piece: p, promo: 0, cap: true });
            break;
          }
          out.push({ from: s, to, type, piece: p, promo: 0 });
          nf += df; nr += dr;
        }
      }
    }
  }
  return out;
}

export function rightsAfter(b, rights) {
  let r = rights;
  if (findKing(b, 0) !== mkSq(4, 0)) r = r.replace(/[KQ]/g, '');
  if (findKing(b, 1) !== mkSq(4, 7)) r = r.replace(/[kq]/g, '');
  if (b[mkSq(7, 0)] !== T.R) r = r.replace('K', '');
  if (b[mkSq(0, 0)] !== T.R) r = r.replace('Q', '');
  if (b[mkSq(7, 7)] !== T.R + 6) r = r.replace('k', '');
  if (b[mkSq(0, 7)] !== T.R + 6) r = r.replace('q', '');
  return r;
}

/** Apply a reference move to a board copy. */
export function refApply(b, mv, turn) {
  const nb = b.slice();
  const rook = T.R + (turn ? 6 : 0);
  if (mv.ep) nb[mkSq(rf(mv.to), rk(mv.from))] = 0;
  if (mv.castle === 'K') { nb[mkSq(7, rk(mv.to))] = 0; nb[mkSq(5, rk(mv.to))] = rook; }
  if (mv.castle === 'Q') { nb[mkSq(0, rk(mv.to))] = 0; nb[mkSq(3, rk(mv.to))] = rook; }
  nb[mv.from] = 0;
  nb[mv.to] = mv.promo ? mv.promo + (turn ? 6 : 0) : mv.piece;
  return nb;
}

export function moveToString(mv) {
  if (mv.castle) return mv.castle === 'K' ? 'O-O' : 'O-O-O';
  return alg(mv.from) + alg(mv.to) + (mv.promo ? '=' + PROMO_LETTER[mv.promo] : '');
}

/** Reference legal moves, as sorted strings. */
export function refLegal(state) {
  const list = [];
  for (const mv of refPseudo(state.b, state.turn, state.ep, state.rights)) {
    const b = refApply(state.b, mv, state.turn);
    if (!attacked(b, findKing(b, state.turn), state.turn ^ 1)) list.push(moveToString(mv));
  }
  return list.sort();
}

/** Reference perft. */
export function refPerft(state, depth) {
  if (depth === 0) return 1;
  let nodes = 0;
  for (const mv of refPseudo(state.b, state.turn, state.ep, state.rights)) {
    const b = refApply(state.b, mv, state.turn);
    if (!attacked(b, findKing(b, state.turn), state.turn ^ 1)) {
      nodes += refPerft({
        b,
        turn: state.turn ^ 1,
        ep: mv.dbl ? mv.epSet : -1,
        rights: rightsAfter(b, state.rights),
      }, depth - 1);
    }
  }
  return nodes;
}
