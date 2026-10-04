/**
 * Lane L18 (browser wiring) — `hello`'s candidate run tree, through the page's own factory and
 * sink. One scenario per *file* is the lane's rule (`runTreeSuite.ts` explains why: the model's
 * `FoodType` table and RNG surfaces are process-wide, so vitest's per-file worker isolation is what
 * gives a run a process of its own).
 *
 *   POLYWORLD_BROWSER_CANDIDATE_ROOT=<root> npx vitest run src/browser/sim/runTree.hello.test.ts
 *   ./oracle/run_parity.sh hello --candidate <root>/hello
 *
 * t_1ce9957f: without that env var the candidate root is keyed per worker process
 * (`$TMPDIR/polyworld-browser-candidates/pid-<pid>[-t<thread>]`), because two concurrent
 * `npx vitest run` used to write and read the same shared tree; the keyed tree names itself in a
 * `PROVENANCE.txt` beside `run/` and prints its path on stderr. Pinning the env var, as above,
 * keeps the tree where you asked for it.
 *
 * PORT-NOTE (L18/hello-tree-is-not-the-recordall-tree): this file does **not** reuse
 * `runTreeSuite.ts`'s shared artifact list, and that is deliberate rather than a convenience.
 * `hello.wf` pins one key (`MaxSteps 500`) and leaves recording at the schema's defaults
 * (`RecordAll False`, `RecordFrequency 1000`), so its recorded tree is 19 files — the four boot
 * artifacts, five `run/genome/meta/*.txt` tables, `run/lifespans.txt`, `run/endStep.txt`,
 * `run/endReason.txt`, six `run/stats/stat.*` and the free movie — where `microtest`/`minitest`
 * record 226/1369 files including per-agent `run/motion/**`, `run/energy/**`, `run/brain/**` and
 * `run/genome/agents/**`. Asserting the microtest list here would either fail or be weakened to a
 * subset check; instead this file states hello's own list, and the two structural assertions the
 * shared suite exists for are kept verbatim: *nothing the golden has is missing except the two
 * files the page is known not to write*, and *nothing is invented*.
 *
 * The set is asserted whole rather than sampled: every file this run writes is in the golden, every
 * golden file is written (bar `isPageExcluded`). A lost artifact therefore fails here even though
 * the tree is 20 files instead of 1369.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  goldenRunFiles,
  isPageExcluded,
  oracleRoot,
  runModelIntoTree,
  type RunTreeReport,
} from './nodeSources';

/** Generous: 500 steps at ~192 agents is a real run (native: 5.5 s; this path is the same model). */
const TIMEOUT_MS = 900_000;

const BOOT_ARTIFACTS = ['original.wf', 'original.wfs', 'converted.wf', 'normalized.wf'] as const;

/**
 * One artifact from every writer that writes in *this* scenario (RecordAll False): the run's own
 * logs, the genome's meta tables, the end phase, and the monitor's status text.
 */
const HELLO_ARTIFACTS = [
  'run/lifespans.txt',
  'run/endStep.txt',
  'run/endReason.txt',
  'run/genome/meta/geneindex.txt',
  'run/genome/meta/genelayout-sorted.txt',
  'run/genome/meta/genelayout.txt',
  'run/genome/meta/generange.txt',
  'run/genome/meta/genetitle.txt',
  'run/stats/stat.1',
  'run/stats/stat.500',
] as const;

describe.skipIf(!existsSync(path.join(oracleRoot(), 'hello', 'run', 'normalized.wf')))(
  'L18 hello run tree',
  () => {
    let cached: RunTreeReport | null = null;
    const run = (): RunTreeReport => (cached ??= runModelIntoTree('hello'));

    it('runs the scenario to its own end, through the page’s factory', () => {
      const report = run();
      expect(report.ended).toBe(true);
      expect(report.steps).toBe(500);
      expect(report.seed).toBe(42); // the worldfile's InitSeed, untouched
      expect(report.notice).toContain('MaxSteps');
    }, TIMEOUT_MS);

    it('carries the four boot artifacts byte-for-byte', () => {
      const dir = run().dir;
      for (const file of BOOT_ARTIFACTS) {
        const recorded = readFileSync(path.join(oracleRoot(), 'hello', 'run', file), 'utf8');
        const written = readFileSync(path.join(dir, 'run', file), 'utf8');
        expect(written, file).toBe(recorded);
      }
    }, TIMEOUT_MS);

    it('carries the run’s own artifacts and the monitor’s status files', () => {
      const written = new Set(run().runFiles);
      for (const relative of HELLO_ARTIFACTS) {
        expect(written.has(relative), relative).toBe(true);
      }
      // The schema's `RecordFrequency 1000` + the monitor's own `FrequencyStore 100`: the six
      // status files are the whole monitor record of a 500-step run.
      expect([...written].filter((file) => file.startsWith('run/stats/')).sort()).toEqual([
        'run/stats/stat.1',
        'run/stats/stat.100',
        'run/stats/stat.200',
        'run/stats/stat.300',
        'run/stats/stat.400',
        'run/stats/stat.500',
      ]);
    }, TIMEOUT_MS);

    it('misses only what the page is known not to write, and invents nothing', () => {
      const written = new Set(run().runFiles);
      const goldenFiles = goldenRunFiles('hello');
      expect(goldenFiles).toHaveLength(20); // 19 manifested + the harness's own manifest

      const missing = goldenFiles.filter((file) => !written.has(file));
      const missingNotExcluded = missing.filter((file) => !isPageExcluded(file));
      expect(missingNotExcluded, `unexpectedly missing: ${missingNotExcluded.join(', ')}`).toEqual([]);
      expect(missing).toEqual(['run/manifest.sha256', 'run/movie.pmv']);

      const extra = [...written].filter((file) => !goldenFiles.includes(file));
      expect(extra, `not in the golden: ${extra.join(', ')}`).toEqual([]);
      expect(written.size).toBe(18);
    }, TIMEOUT_MS);
  },
);
