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

export const POSITIONS = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R b KQkq - 0 1',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 b - - 0 1',
  'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
  'r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1',
  'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
  'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
  // hand-picked nasties
  '4k3/8/8/2pP4/8/8/8/4K3 w - c6 0 2',                    // ep that is legal
  '8/8/8/8/k1p4R/8/2P5/4K3 w - - 0 1',                    // ep pin along the rank
  '8/8/8/8/K1p4R/8/2P5/4k3 b - - 0 1',                    // same, mirrored
  'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',                // castling both ways
  'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1',
  'r3k2r/8/8/8/8/8/6b1/R3K2R w KQkq - 0 1',              // castling through a attacked square
  '8/5k2/8/8/8/8/5K2/6R1 w - - 0 1',                       // rook + king
  '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',                       // pawn vs king
  'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2',
  'n1n5/PPPk4/8/8/8/8/4Kppp/5N1N b - - 0 1',              // promotion torture
  'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
  '8/2p5/8/1P6/8/8/6k1/4K2R w K - 0 1',                    // castle out of danger
  '5k2/8/8/8/8/8/8/4K2R w K - 0 1',
  '3k4/8/8/8/8/8/8/R3K3 w Q - 0 1',
];

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
