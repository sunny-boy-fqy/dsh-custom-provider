/**
 * Test entry point: run every `test/*.test.mjs` in one process.
 *
 * Discovery rather than a hard-coded list, for two reasons. The suites are
 * independent files with no shared fixtures, so naming them one by one buys
 * nothing; and a list drifts — a new suite that nobody remembers to append runs
 * nowhere, which is the one failure mode a test command must not have.
 *
 * @module @local/dsh-custom-provider/test/run
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

if (suites.length === 0) {
  process.stderr.write('no test suites found\n');
  process.exit(1);
}

let failed = 0;
for (const suite of suites) {
  process.stdout.write(`\n── ${suite} ${'─'.repeat(Math.max(0, 60 - suite.length))}\n`);
  // `node:test` writes its report and sets a non-zero status on failure, so the
  // child's exit code is the only signal needed here.
  const result = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit' });
  if (result.status !== 0) failed += 1;
}

process.stdout.write(`\n${suites.length - failed}/${suites.length} suites passed\n`);
process.exit(failed === 0 ? 0 : 1);