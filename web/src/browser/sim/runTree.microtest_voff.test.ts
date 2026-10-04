/**
 * Lane L18 (browser wiring) — `microtest_voff`'s candidate run tree (one run per process; see
 * `runTreeSuite.ts` for why this is a file of its own).
 *
 *   ./oracle/run_parity.sh microtest_voff --candidate <POLYWORLD_BROWSER_CANDIDATE_ROOT>/microtest_voff
 *
 * t_1ce9957f: without that env var the candidate root is keyed per worker process
 * (`$TMPDIR/polyworld-browser-candidates/pid-<pid>[-t<thread>]`), because two concurrent
 * `npx vitest run` used to write and read the same shared tree; the keyed tree names itself in a
 * `PROVENANCE.txt` beside `run/` and prints its path on stderr. Pinning the env var, as above,
 * keeps the tree where you asked for it.
 *
 * Expected (this machine, 2026-09-28, after the monitor mount):
 *   `match 224/225  differing=0  missing=0  extra=0` (`ignored=1` = `run/movie.pmv`), verdict
 *   `parity: PASS (225/225 files)`. The page's own sink writes every other file, `run/stats/stat.1`
 *   (the monitor's) included.
 */

import { runTreeSuite } from './runTreeSuite';

runTreeSuite({
  scenario: 'microtest_voff',
  steps: 1,
  pageExcluded: 2,
  // The recorded run analyses one agent, which leaves the file under its pre-analysis name.
  alsoWritten: ['run/brain/function/incomplete_brainFunction_1.txt.gz'],
});
