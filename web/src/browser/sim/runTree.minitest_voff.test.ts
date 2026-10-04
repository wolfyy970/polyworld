/**
 * Lane L18 (browser wiring) — `minitest_voff`'s candidate run tree (one run per process; see
 * `runTreeSuite.ts` for why this is a file of its own).
 *
 *   ./oracle/run_parity.sh minitest_voff --candidate <POLYWORLD_BROWSER_CANDIDATE_ROOT>/minitest_voff
 *
 * t_1ce9957f: without that env var the candidate root is keyed per worker process
 * (`$TMPDIR/polyworld-browser-candidates/pid-<pid>[-t<thread>]`), because two concurrent
 * `npx vitest run` used to write and read the same shared tree; the keyed tree names itself in a
 * `PROVENANCE.txt` beside `run/` and prints its path on stderr. Pinning the env var, as above,
 * keeps the tree where you asked for it.
 *
 * Expected (this machine, 2026-09-28, after the monitor mount):
 *   `match 1368/1369  differing=0  missing=0  extra=0` (`ignored=1` = `run/movie.pmv`), verdict
 *   `parity: PASS (1369/1369 files)`. The page's own sink writes every other file, the monitor's
 *   `run/stats/stat.{1,100,200,300}` included.
 */

import { runTreeSuite } from './runTreeSuite';

runTreeSuite({
  scenario: 'minitest_voff',
  steps: 301,
  pageExcluded: 2,
  // 301 steps finish the analyses: the file has been renamed off `incomplete_…`.
  alsoWritten: ['run/brain/function/brainFunction_1.txt.gz'],
});
