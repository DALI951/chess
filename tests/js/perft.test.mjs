/**
 * PERFT — the correctness proof for a chess move generator.
 *
 * perft(depth) counts the leaf nodes of the legal move tree. The expected
 * numbers below are the industry-standard vectors (Chess Programming Wiki,
 * "Perft Results"), reproduced by every serious engine. If our numbers differ,
 * the move generator has a bug — full stop.
 *
 *   node --test tests/js/            (quick set, ~4M nodes)
 *   DEEP=1 node --test tests/js/     (~44M nodes, run in CI)
 *
 * @author DALI951
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../../assets/js/engine.js';

const DEEP = process.env.DEEP === '1';

const SUITE = [
  {
    name: 'startpos',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    quick: 4,
    deep: 5,
    expect: { 1: 20, 2: 400, 3: 8902, 4: 197281, 5: 4865609, 6: 119060324 },
  },
  {
    name: 'kiwipete',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    quick: 3,
    deep: 4,
    expect: { 1: 48, 2: 2039, 3: 97862, 4: 4085603, 5: 193690690 },
  },
  {
    name: 'position-3 (ep + pins)',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    quick: 5,
    deep: 6,
    expect: { 1: 14, 2: 191, 3: 2812, 4: 43238, 5: 674624, 6: 11030083 },
  },
  {
    // vertical flip of position-3 (ranks reversed, colours swapped, files
    // kept) — the correct way to mirror a position while keeping castling legal
    name: 'position-3-mirror',
    fen: '8/4p1p1/8/1r3P1K/kp5R/3P4/2P5/8 b - - 0 1',
    quick: 5,
    deep: 6,
    expect: { 1: 14, 2: 191, 3: 2812, 4: 43238, 5: 674624, 6: 11030083 },
  },
  {
    name: 'position-4 (promotions)',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    quick: 4,
    deep: 5,
    expect: { 1: 6, 2: 264, 3: 9467, 4: 422333, 5: 15833292, 6: 706006033 },
  },
  {
    name: 'position-4-mirror',
    fen: 'r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1',
    quick: 4,
    deep: 5,
    expect: { 1: 6, 2: 264, 3: 9467, 4: 422333, 5: 15833292, 6: 706006033 },
  },
  {
    name: 'position-5',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    quick: 4,
    deep: 4,
    expect: { 1: 44, 2: 1486, 3: 62379, 4: 2103487, 5: 89841194 },
  },
  {
    // "Steven Edwards alternative" position 6 — the CPW vector verbatim
    name: 'position-6',
    fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
    quick: 3,
    deep: 4,
    expect: { 1: 46, 2: 2079, 3: 89890, 4: 3894594, 5: 164075551 },
  },
];

for (const pos of SUITE) {
  const depth = DEEP ? pos.deep : pos.quick;

  test(`perft ${pos.name} depth ${depth} = ${pos.expect[depth].toLocaleString('en-US')}`, () => {
    const chess = new Chess(pos.fen);
    const started = process.hrtime.bigint();
    const nodes = chess.perftFast(depth);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const nps = Math.round(nodes / (ms / 1000));
    console.log(
      `      ${pos.name.padEnd(22)} d${depth}  ${String(nodes).padStart(11)} nodes  ` +
      `${ms.toFixed(0).padStart(6)}ms  ${nps.toLocaleString('en-US')} nps`
    );
    assert.equal(nodes, pos.expect[depth], `${pos.name} d${depth}`);
  });

  // every depth from 1..depth must match too, so a shallow regression is caught fast
  for (let d = 1; d < depth; d++) {
    test(`perft ${pos.name} depth ${d} = ${pos.expect[d].toLocaleString('en-US')}`, () => {
      assert.equal(new Chess(pos.fen).perftFast(d), pos.expect[d]);
    });
  }
}

test('perft divide on kiwipete sums to the total', () => {
  const chess = new Chess('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const divide = chess.perftDivideFast(3);
  const sum = divide.reduce((a, b) => a + b.nodes, 0);
  assert.equal(sum, 97862);
  assert.equal(divide.length, 48, 'kiwipete has 48 legal first moves');
  // kiwipete has no promotions (no white pawn on the 7th reaches an 8th-rank
  // black piece); both castlings are there though
  assert.ok(divide.some((d) => d.move.startsWith('O-O')), 'O-O is missing from the divide');
  assert.ok(divide.some((d) => d.move.startsWith('O-O-O')), 'O-O-O is missing from the divide');
});

test('perft divide on position-5 shows all four capture-promotions', () => {
  // the d7 pawn captures the c8 bishop and may promote to any of the four
  // pieces, so the divide must contain exactly four such moves
  const divide = new Chess('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8')
    .perftDivideFast(2);
  const promos = divide.filter((d) => /^dxc8=[QRBN]/.test(d.move));
  assert.equal(promos.length, 4, `expected 4 capture-promotions, got ${promos.map((p) => p.move).join(' ')}`);
  assert.equal(divide.length, 44, 'position 5 has 44 legal first moves');
});

test('perft divide lists LEGAL moves only (no zero-count pseudo moves)', () => {
  // position-4 is a check: white has only 6 legal replies out of 38 pseudo-legal
  // ones. A divide must not pad itself with illegal rows.
  const fen = 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1';
  const divide = new Chess(fen).perftDivideFast(2);
  assert.equal(divide.length, 6, `divide listed ${divide.length} rows, expected 6 legal moves`);
  assert.ok(
    divide.every((d) => d.nodes > 0),
    'divide contains a zero-count row, i.e. an illegal move'
  );
  assert.equal(divide.reduce((a, b) => a + b.nodes, 0), 264);
});

test('king is never left in check after a legal move (invariant, d<=2 on all positions)', () => {
  for (const pos of SUITE) {
    const chess = new Chess(pos.fen);
    const walk = (depth) => {
      for (const mv of chess.moves({ verbose: true })) {
        const mover = mv.color;
        chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
        // the side that just moved must NOT be attacking itself
        assert.equal(
          chess.isAttacked(chess.kingSq(mover), mover ^ 1),
          false,
          `${pos.name}: ${mv.san} left ${mover === 0 ? 'white' : 'black'} king in check`
        );
        if (depth > 1) walk(depth - 1);
        chess.undo();
      }
    };
    walk(2);
  }
});
