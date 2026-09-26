/**
 * PERFT DIVIDE — print the node count of every legal first move.
 *
 * The sum of the divide MUST equal perft(depth) exactly. When it doesn't, the
 * bug is in move generation rather than in the recursion, and the divide tells
 * you which root move is responsible.
 *
 *   node tools/perft-divide.mjs "<fen>" [depth]
 *   node tools/perft-divide.mjs                       # defaults: startpos d4
 *
 * @author DALI951
 */
import { Chess } from '../assets/js/engine.js';

const fen = process.argv[2] || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const depth = Number(process.argv[3] || 4);

const chess = new Chess(fen);
const started = process.hrtime.bigint();
const divide = chess.perftDivideFast(depth);
const ms = Number(process.hrtime.bigint() - started) / 1e6;
const total = chess.perftFast(depth);
const sum = divide.reduce((acc, d) => acc + d.nodes, 0);

console.log(`FEN   : ${fen}`);
console.log(`depth : ${depth}`);
console.log(`moves : ${divide.length}`);
console.log('');
for (const d of divide) {
  console.log(`${d.move.padEnd(8)} ${String(d.nodes).padStart(12)}  ${((d.nodes / sum) * 100).toFixed(2)}%`);
}
console.log('');
console.log(`sum       ${String(sum).padStart(12)}`);
console.log(`perft(${depth})${''.padEnd(4)}${String(total).padStart(12)}`);
console.log(`${ms.toFixed(0)}ms  ${Math.round(sum / (ms / 1000)).toLocaleString('en-US')} nps`);

if (sum !== total) {
  console.error('\nMISMATCH: divide does not sum to perft — move generation is inconsistent');
  process.exit(1);
}
