/**
 * DIFFERENTIAL TEST — assets/js/engine.js vs tests/js/reference.mjs
 *
 * The reference is a deliberately naive second implementation (8x8 array, its
 * own attack detector). It shares no code with the fast engine. If the two
 * ever disagree, one of them has a bug — and the failure prints the exact
 * moves where they first diverge.
 *
 * @author DALI951
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../../assets/js/engine.js';
import { parseFen, refLegal, refPerft, refPseudo, refApply, attacked, findKing, moveToString } from './reference.mjs';

/**
 * Fast-engine legal moves in the reference's string format.
 * Castling keeps its O-O / O-O-O form (note: it can carry a + or # suffix,
 * hence the regex — an exact `=== 'O-O'` test silently mislabels O-O+).
 */
function fastLegal(fen) {
  const out = [];
  for (const mv of new Chess(fen).moves({ verbose: true })) {
    if (/^O-O(-O)?[+#]?$/.test(mv.san)) out.push(mv.san.replace(/[+#]$/, ''));
    else out.push(mv.from + mv.to + (mv.promotion ? '=' + mv.promotion.toLowerCase() : ''));
  }
  return out.sort();
}

import { POSITIONS, moveKeys } from './positions.mjs';
export { POSITIONS };

for (const fen of POSITIONS) {
  const label = fen.split(' ')[0];

  test(`move lists agree: ${label}`, () => {
    const fast = fastLegal(fen);
    const ref = refLegal(parseFen(fen));
    assert.deepEqual(
      fast, ref,
      `move lists differ for ${fen}\n  only fast: ${fast.filter((x) => !ref.includes(x))}\n` +
      `  only ref:  ${ref.filter((x) => !fast.includes(x))}`
    );
  });

  test(`perft agrees d1-d3: ${label}`, () => {
    for (let d = 1; d <= 3; d++) {
      const fast = new Chess(fen).perftFast(d);
      const ref = refPerft(parseFen(fen), d);
      assert.equal(fast, ref, `perft(${d}) mismatch on ${fen}: fast=${fast} ref=${ref}`);
    }
  });
}

test('every legal move leaves the mover safe and produces a legal FEN', () => {
  for (const fen of POSITIONS) {
    const chess = new Chess(fen);
    for (const mv of chess.moves({ verbose: true })) {
      const mover = mv.color;
      chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      assert.equal(chess.isAttacked(chess.kingSq(mover), mover ^ 1), false, `${fen}: ${mv.san} left own king in check`);
      // the FEN must survive a load/save round trip
      const round = new Chess(chess.fen());
      assert.equal(round.fen(), chess.fen(), `${fen}: FEN round trip broke after ${mv.san}`);
      chess.undo();
    }
  }
});

const swapCase = (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase());

/** "2pP4" -> ['.','.','p','P','.','.','.','.'] */
const parseRow = (row) => {
  const cells = [];
  for (const ch of row) {
    if (ch >= '1' && ch <= '8') for (let i = 0; i < Number(ch); i++) cells.push('.');
    else cells.push(ch);
  }
  if (cells.length !== 8) throw new Error(`bad FEN rank '${row}'`);
  return cells;
};

/** ['.','.','p','P','.','.','.','.'] -> "2pP4" */
const encodeRow = (cells) => {
  let out = '';
  let empty = 0;
  for (const c of cells) {
    if (c === '.') { empty++; continue; }
    if (empty) { out += empty; empty = 0; }
    out += c;
  }
  if (empty) out += empty;
  return out;
};

/** Mirror one rank vertically: swap every piece's colour, keep the files. */
const flipRank = (row) => encodeRow(parseRow(row).map(swapCase));

test('legal move count is symmetric under colour swap (mirror check)', () => {
  // Chess is exactly symmetric under: reverse the rank order, swap piece
  // colours, swap side to move, swap castling rights and flip the rank of the
  // en-passant square. (A file mirror is NOT usable here: it would move the
  // king off the e-file and silently delete castling.)
  const flip = (fen) => {
    const [placement, turn, rights, ep, ...rest] = fen.trim().split(/\s+/);
    const rows = placement.split('/').map(flipRank).reverse();
    const flipSq = (s) => (s && s !== '-' ? s[0] + (9 - Number(s[1])) : '-');
    return [
      rows.join('/'),
      turn === 'w' ? 'b' : 'w',
      [...rights].map(swapCase).join(''),
      flipSq(ep),
      ...rest,
    ].join(' ');
  };

  for (const fen of POSITIONS) {
    const a = new Chess(fen).perftFast(3);
    const flipped = flip(fen);
    const b = new Chess(flipped).perftFast(3);
    assert.equal(b, a, `flip of ${fen} (${flipped}) gave ${b}, expected ${a}`);
  }
});
