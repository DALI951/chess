import { Chess } from '../assets/js/engine.js';

const GAME = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O'];

const c = new Chess();
for (const san of GAME) {
  const mv = c.moveSan(san);
  if (!mv) throw new Error(`illegal ${san}`);
}
const fenBefore = c.fen();
const hist = c.history();
const sans = hist.map((m) => m.san);
const nonVerbose = c.history({ verbose: false }).map((m) => m.san);
const pgn = c.pgn();
const fenAfterPgn = c.fen();
const fenAfterHistory = c.fen();
const pgnBody = pgn.split('\n').filter((l) => !l.startsWith('[')).join('\n').trim();

// undo all the way back
let undos = 0;
while (c.undo()) undos++;
const fenAfterUndos = c.fen();

console.log(JSON.stringify({
  game: GAME,
  sans,
  nonVerbose,
  fen: fenBefore,
  pgnBody,
  restore: { fenAfterPgn, fenAfterHistory, fenAfterUndos },
  undos,
  perft1: c.perftFast(1),
}, null, 2));
