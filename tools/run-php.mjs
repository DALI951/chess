/**
 * RUN THE PHP TEST SUITES with whatever PHP this machine has.
 *
 *   node tools/run-php.mjs              # tests/php/run.php
 *   node tools/run-php.mjs --quick      # perft at the quick depths
 *   node tools/run-php.mjs -v           # print the interpreter and exit
 *
 * Resolution order, because `php` is NOT on this box's PATH:
 *   1. $PHP_BIN
 *   2. tools/php/php.exe  (a portable install kept inside the repo)
 *   3. C:/Users/dali/tools/php85/php.exe
 *   4. `php` from PATH
 *
 * @author DALI951
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const CANDIDATES = [
  process.env.PHP_BIN,
  join(ROOT, 'tools', 'php', 'php.exe'),
  'C:/Users/dali/tools/php85/php.exe',
  'php',
].filter(Boolean);

function findPhp() {
  for (const c of CANDIDATES) {
    if (c.includes('/') || c.includes('\\')) {
      if (existsSync(c)) return c;
      continue;
    }
    const probe = spawnSync(c, ['-v'], { stdio: 'ignore', shell: true });
    if (probe.status === 0) return c;
  }
  return null;
}

const php = findPhp();
if (!php) {
  console.error('No PHP interpreter found.');
  console.error('Set PHP_BIN, or drop one at tools/php/php.exe, or put php on PATH.');
  process.exit(1);
}

if (process.argv.includes('-v')) {
  const out = spawnSync(php, ['-v'], { encoding: 'utf8', shell: php === 'php' });
  console.log(php);
  console.log((out.stdout || '').split('\n')[0]);
  process.exit(0);
}

const args = process.argv.slice(2);
const res = spawnSync(php, [join(ROOT, 'tests', 'php', 'run.php'), ...args], {
  stdio: 'inherit',
  shell: php === 'php',
});
process.exit(res.status ?? 1);
