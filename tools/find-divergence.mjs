/**
 * FIND DIVERGENCE — walk the fast engine and the reference generator in
 * parallel and report the FIRST position where they disagree, with the FEN
 * and the exact moves that differ.
 *
 *   node tools/find-divergence.mjs "<fen>" [depth]
 *
 * The reference is O(slow) because it clones the board, so keep depth <= 3-4.
 * The output is meant to be pasted straight into a new test case.
 *
 * @author DALI951
 */
import { Chess } from '../assets/js/engine.js';
import { parseFen, refLegal, refPerft } from '../tests/js/reference.mjs';

const fenArg = process.argv[2];
const depth = Number(process.argv[3] || 3);
if (!fenArg) {
  console.error('usage: node tools/find-divergence.mjs "<fen>" [depth]');
  process.exit(2);
}

function fastList(fen) {
  const out = [];
  for (const mv of new Chess(fen).moves({ verbose: true })) {
    if (/^O-O(-O)?[+#]?$/.test(mv.san)) out.push(mv.san.replace(/[+#]$/, ''));
    else out.push(mv.from + mv.to + (mv.promotion ? '=' + mv.promotion.toLowerCase() : ''));
  }
  return out.sort();
}

let checked = 0;

function walk(fen, depthLeft, path) {
  checked++;

  const fast = fastList(fen);
  const ref = refLegal(parseFen(fen));
  if (JSON.stringify(fast) !== JSON.stringify(ref)) {
    return {
      kind: 'move-list',
      fen,
      path,
      onlyFast: fast.filter((m) => !ref.includes(m)),
      onlyRef: ref.filter((m) => !fast.includes(m)),
    };
  }

  const f = new Chess(fen);
  const fastCount = f.perftFast(depthLeft);
  const refCount = refPerft(parseFen(fen), depthLeft);
  if (fastCount !== refCount) {
    if (depthLeft <= 1) {
      return { kind: 'count', fen, path, fastCount, refCount, moves: fast };
    }
    for (const mv of f.moves({ verbose: true })) {
      f.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      const child = f.fen();
      const found = walk(child, depthLeft - 1, [...path, mv.san]);
      f.undo();
      if (found) return found;
    }
    return { kind: 'count-no-child', fen, path, fastCount, refCount, moves: fast };
  }
  return null;
}

const started = Date.now();
const result = walk(fenArg, depth, []);

if (!result) {
  console.log(`NO DIVERGENCE — both generators agree for the whole tree (${checked} positions checked, ${Date.now() - started}ms)`);
  process.exit(0);
}

console.log(`\nDIVERGENCE (${result.kind}) after ${checked} positions:\n`);
console.log(`  FEN : ${result.fen}`);
if (result.path.length) console.log(`  path: ${result.path.join(' ')}`);
if (result.kind === 'move-list') {
  console.log(`  only in fast engine: ${result.onlyFast.join(' ') || '(none)'}`);
  console.log(`  only in reference  : ${result.onlyRef.join(' ') || '(none)'}`);
} else {
  console.log(`  fast=${result.fastCount} ref=${result.refCount}`);
  console.log(`  moves: ${result.moves.join(' ')}`);
}
console.log('');
process.exit(1);
