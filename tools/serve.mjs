/**
 * Local dev server: `npm run serve:php` then open http://127.0.0.1:8080/
 *
 * Same interpreter resolution as tools/run-php.mjs, so it works on a machine
 * where `php` is not on PATH. Serves the project root over PHP's built-in
 * server, which is enough for the SPA and api/*.php before any deploy.
 *
 * @author DALI951
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = process.env.PORT || '8080';

const CANDIDATES = [
  process.env.PHP_BIN,
  join(ROOT, 'tools', 'php', 'php.exe'),
  'C:/Users/dali/tools/php85/php.exe',
  'php',
].filter(Boolean);

const php = CANDIDATES.find((c) =>
  (c.includes('/') || c.includes('\\')) ? existsSync(c) : true
);

if (!php) {
  console.error('No PHP interpreter found. Set PHP_BIN or put php on PATH.');
  process.exit(1);
}

console.log(`chess dev server -> http://127.0.0.1:${PORT}/  (${php})`);
// tools/router.php is here only to give .wasm the right Content-Type; the built-in
// server otherwise serves Stockfish's binary as application/octet-stream, which
// WebAssembly.instantiateStreaming refuses. It returns false for every other path,
// so nothing else changes behaviour.
const srv = spawn(php, ['-S', `127.0.0.1:${PORT}`, '-t', ROOT, join(HERE, 'router.php')], {
  stdio: 'inherit',
  shell: php === 'php',
});
srv.on('exit', (code) => process.exit(code ?? 0));
