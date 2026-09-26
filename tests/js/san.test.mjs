/**
 * SAN TEST SUITE — the axis perft cannot see.
 *
 * Perft proves MOVE GENERATION. It says nothing about how a move is written
 * down. That gap let three real bugs through a fully green engine:
 *
 *   1. `m !== mv` compared object references across two _legalMoves() calls, so
 *      every move disambiguated against ITSELF: Nf3 printed as "Ng1f3".
 *   2. Pawn captures printed a doubled separator: "exxd5" instead of "exd5".
 *   3. pgn() re-made the whole game before printing it, so _san() applied every
 *      move on top of the finished position — wrong SAN and a scrambled board.
 *
 * Rule for this project: if a feature is not asserted here, it is unproven.
 * Every expected string below was produced by a human-verified reading of the
 * position, not by copying the engine's own output.
 *
 * @author DALI951
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../../assets/js/engine.js';
import { POSITIONS } from './positions.mjs';

const sans = (fen, opts) => new Chess(fen).moves(opts).map((m) => m.san);
const pick = (fen, re) => sans(fen).filter((s) => re.test(s)).sort();

test('SAN: an open queen writes one plain form per square', () => {
  // start position: the knights have four moves, all undisambiguated
  assert.deepEqual(pick('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', /^N/), ['Na3', 'Nc3', 'Nf3', 'Nh3']);
  // lone white queen a1, black king g3. Every move hand-checked below:
  //   rank 3 (a3, c3) hits the king            -> +
  //   e5-f4-g3 and the g-file (g7) hit it      -> +
  //   a2, a4-a8, b1, b2, c1, d1, d4, f6, h8 do not
  assert.deepEqual(pick('8/8/8/8/8/6k1/8/Q3K3 w - - 0 1', /^Q/), [
    'Qa2', 'Qa3+', 'Qa4', 'Qa5', 'Qa6', 'Qa7', 'Qa8',
    'Qb1', 'Qb2', 'Qc1', 'Qc3+', 'Qd1', 'Qd4', 'Qe5+', 'Qf6', 'Qg7+', 'Qh8',
  ]);
});

test('SAN: file disambiguation when two knights reach the same square', () => {
  // knights on c3 and g1 both attack e2 -> Nce2 / Nge2, never bare "Ne2"
  const all = sans('4k3/8/8/8/8/2N5/8/4K1N1 w - - 0 1');
  const found = all.filter((s) => /^N.*e2$/.test(s)).sort();
  assert.deepEqual(found, ['Nce2', 'Nge2']);
  assert.ok(!all.includes('Ne2'), 'the ambiguous bare form must not be produced');
});

test('SAN: rank disambiguation when two rooks share a file', () => {
  // rooks on a1 and a5 both reach a3 -> R1a3 / R5a3
  const found = pick('4k3/8/8/R7/8/8/8/R3K3 w - - 0 1', /^R.*a3$/);
  assert.deepEqual(found, ['R1a3', 'R5a3']);
});

test('SAN: no disambiguation when the path is blocked', () => {
  // the h1 rook cannot reach d1 (the white king on e1 blocks it) -> plain "Rd1"
  const found = pick('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', /^R.*d1$/);
  assert.deepEqual(found, ['Rd1']);
});

test('SAN: pawn capture uses the origin file and ONE x', () => {
  assert.deepEqual(pick('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', /d6$/), ['exd6']);
  assert.deepEqual(pick('4k3/8/8/3r4/4P3/8/8/4K3 w - - 0 1', /d5$/), ['exd5']);
  // the regression: this used to print "exxd5"
  for (const s of sans('4k3/8/8/3r4/4P3/8/8/4K3 w - - 0 1')) {
    assert.ok(!/xx/.test(s), `no move may contain a doubled x: ${s}`);
  }
});

test('SAN: en passant is a normal pawn capture', () => {
  const found = pick('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', /d6$/);
  assert.deepEqual(found, ['exd6']);
  const c = new Chess('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
  c.moveSan('exd6');
  assert.equal(c.fen(), '4k3/8/3P4/8/8/8/8/4K3 b - - 0 2');
});

test('SAN: promotion carries the piece and a check when it gives one', () => {
  // a8=Q and a8=R attack the black king on e8 along the 8th rank; B and N do not
  assert.deepEqual(pick('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', /^a8=/), ['a8=B', 'a8=N', 'a8=Q+', 'a8=R+']);
});

test('SAN: promotion by capture', () => {
  // a queen or rook on b8 hits the king on e8 along the 8th rank; a bishop
  // (b8-c7-d6...) and a knight do not. Verified by reading the position.
  const found = pick('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1', /^axb8=/);
  assert.deepEqual(found, ['axb8=B', 'axb8=N', 'axb8=Q+', 'axb8=R+']);
});

test('SAN: castling, including the check suffix when it gives one', () => {
  assert.deepEqual(pick('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', /^O/), ['O-O', 'O-O-O']);
  // with a black king on f8, O-O opens the f-file onto it -> check
  assert.deepEqual(pick('5k2/8/8/8/8/8/8/R3K2R w KQ - 0 1', /^O/), ['O-O+', 'O-O-O']);
});

test('SAN: check and mate suffixes', () => {
  // scholar's mate: 1.f3 e5 2.g4 Qh4#
  const c = new Chess();
  for (const s of ['f3', 'e5', 'g4']) c.moveSan(s);
  assert.ok(c.moves().map((m) => m.san).includes('Qh4#'), 'Qh4 must be written as mate');
  assert.equal(c.moveSan('Qh4').san, 'Qh4#');

  // a plain check keeps a single '+'
  const ruy = new Chess();
  for (const s of ['e4', 'e5', 'Qh5', 'Nc6', 'Qxe5+']) {
    assert.ok(ruy.moveSan(s) !== null, `${s} must be playable`);
  }
  assert.ok(ruy.inCheck(), 'Qxe5+ must actually be check');
});

test('SAN: moveSan parses what _san writes, for every position', () => {
  // 508 moves. Self-consistency is necessary but NOT sufficient — the parser and
  // the writer shared the "exxd5" bug, so they agreed with each other and were
  // both wrong. The literal assertions above are what actually pin the format.
  let checked = 0;
  for (const fen of POSITIONS) {
    for (const san of new Chess(fen).moves().map((m) => m.san)) {
      const probe = new Chess(fen);
      assert.notEqual(probe.moveSan(san), null, `cannot re-parse ${san} in ${fen}`);
      checked++;
    }
  }
  assert.ok(checked > 400, `expected the whole corpus, got ${checked}`);
});

test('SAN: a full game round trips through history() without touching the position', () => {
  const game = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O'];
  const c = new Chess();
  for (const san of game) assert.notEqual(c.moveSan(san), null, `${san} must be playable`);

  assert.deepEqual(c.history().map((m) => m.san), game);
  assert.deepEqual(c.history({ verbose: false }).map((m) => m.san), game);
  assert.equal(c.fen(), 'r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N2/PP1P1PPP/RNBQR1K1 w - - 1 9');
});

test('PGN: export is non-destructive and prints legal SAN', () => {
  const c = new Chess();
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O']) {
    c.moveSan(san);
  }
  const before = c.fen();
  const pgn = c.pgn();
  assert.equal(c.fen(), before, 'pgn() must leave the position untouched');
  assert.equal(
    pgn.split('\n').filter((l) => !l.startsWith('[')).join('\n').trim(),
    '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O *'
  );
  // a game from the standard start must NOT carry a FEN tag: loadPgn would load
  // the final position and then try to replay the whole game on top of it
  assert.ok(!/\[FEN /.test(pgn), 'no FEN tag for a standard-start game');
});

test('PGN: a game from a setup position DOES carry the FEN tag', () => {
  const c = new Chess('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
  c.moveSan('e4');
  const pgn = c.pgn();
  assert.match(pgn, /\[FEN "4k3\/8\/8\/8\/8\/8\/4P3\/4K3 w - - 0 1"\]/);
  const back = new Chess();
  back.loadPgn(pgn);
  assert.equal(back.fen(), c.fen(), 'a setup game must survive its own round trip');
});

test('PGN: an unfinished game (result "*") can be imported', () => {
  // /\b\*\b/ can never match, so this used to throw "Invalid PGN move '*'"
  const c = new Chess();
  c.loadPgn('1. e4 e5 2. Nf3 Nc6 *');
  // halfmove clock 2: the last two plies were knight moves
  assert.equal(c.fen(), 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
});

test('PGN: import replays to the same position, tolerating noise', () => {
  const c = new Chess();
  c.loadPgn('[Event "Test"]\n\n1. e4 {best by test} e5 2. Nf3 $1 Nc6 (2... Nf6 3. Bb5) 3. Bb5 a6 1/2-1/2\n');
  assert.equal(c.fen(), 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4');
  assert.equal(c.getHeaders().Event, 'Test');
});

test('PGN: a full game can be replayed from its own export', () => {
  const c = new Chess();
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O']) c.moveSan(san);
  const reloaded = new Chess();
  reloaded.loadPgn(c.pgn());
  assert.equal(reloaded.fen(), c.fen());
  assert.deepEqual(reloaded.history().map((m) => m.san), c.history().map((m) => m.san));
});

test('SAN: nonsense is rejected, not silently accepted', () => {
  const c = new Chess();
  for (const bad of ['Nf6', 'e9', 'O-O', 'Kz1', 'xx', 'e4 e5', '']) {
    assert.equal(c.moveSan(bad), null, `"${bad}" must not be playable`);
  }
});
