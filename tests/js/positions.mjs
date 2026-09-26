/**
 * THE POSITION LIST — one source of truth for every test in the project.
 *
 * Used by:
 *   tests/js/differential.test.mjs      (JS engine vs the independent oracle)
 *   tools/gen-move-fixtures.mjs         (writes the fixture PHP must match)
 *
 * Keep it in its own module so the fixture generator can import the positions
 * WITHOUT importing a test file (which would run that suite as a side effect).
 *
 * @author DALI951
 */
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
  'r3k2r/8/8/8/8/8/6b1/R3K2R w KQkq - 0 1',              // castling through an attacked square
  '8/5k2/8/8/8/8/5K2/6R1 w - - 0 1',                       // rook + king
  '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',                       // pawn vs king
  'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2',
  'n1n5/PPPk4/8/8/8/8/4Kppp/5N1N b - - 0 1',              // promotion torture
  'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
  '8/2p5/8/1P6/8/8/6k1/4K2R w K - 0 1',                    // castle out of danger
  '5k2/8/8/8/8/8/8/4K2R w K - 0 1',
  '3k4/8/8/8/8/8/8/R3K3 w Q - 0 1',
];

/**
 * Canonical move identity: castling is "O-O"/"O-O-O", everything else is
 * from+to(+promotion). Deliberately NOT SAN, because two different positions
 * can produce the same SAN and a diff is then unreadable.
 */
export function moveKeys(chess) {
  const out = [];
  for (const mv of chess.moves({ verbose: true })) {
    if (/^O-O(-O)?[+#]?$/.test(mv.san)) out.push(mv.san.replace(/[+#]$/, ''));
    else out.push(mv.from + mv.to + (mv.promotion ? '=' + mv.promotion.toLowerCase() : ''));
  }
  return out.sort();
}
