/**
 * DEEP TEST RUNNER — runs `node --test` with DEEP=1 so perft.test.mjs picks
 * its deep depths. Written as a Node wrapper instead of a shell one-liner
 * because `DEEP=1 node ...` is not valid on Windows cmd and `cross-env` is
 * not a dependency we want just for this.
 *
 *   node tools/deep-test.mjs [test paths...]
 *
 * @author DALI951
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const result = spawnSync(process.execPath, ['--test', ...args], {
  stdio: 'inherit',
  env: { ...process.env, DEEP: '1' },
});

process.exit(result.status ?? 1);
