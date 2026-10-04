/**
 * Lane L18 (browser wiring) — the run-tree suite both tree tests share.
 *
 * One scenario per *file* (`runTree.microtest_voff.test.ts`, `runTree.minitest_voff.test.ts`) is a
 * hard requirement, not a style choice: the model's `FoodType` table and RNG surfaces are
 * process-wide, exactly as native's are, so a second `TSimulation` in one process throws
 * (`sim: duplicate FoodType name 'Standard' (native errs)` — `worldfile.ts:256`). Native's own
 * binary runs one simulation per process; vitest isolates test files in separate workers, so one
 * file per scenario is one process per run.
 *
 * What the suite pins:
 *   1. the run goes to its own end (`MaxSteps`), through the page's factory and the page's sink;
 *   2. the four boot artifacts in the tree are byte-for-byte the recorded ones;
 *   3. the tree carries the **model's** artifacts (`run/motion/**`, `run/genome/**`,
 *      `run/brain/**`, `run/lifespans.txt`, …) — not just the boot's four;
 *   4. the tree carries the **monitor's** artifact too (`run/stats/stat.<t>`, lane L14's
 *      `MonitorManager` mounted off `stepEnding` — PORT-NOTE (L18/monitors-in-the-page));
 *   5. everything the golden has that the page is *known* not to write is exactly the movie and the
 *      harness's own manifest (`isPageExcluded`), and the tree has nothing the golden lacks. That
 *      last pair is the honest gap statement: it fails loudly if the run loses an artifact, and it
 *      cannot silently pass by missing things.
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
import type { ScenarioName } from './scenarios';

/** Generous: the model run is seconds, but the first construction pays the boot + JIT. */
const TIMEOUT_MS = 300_000;

const BOOT_ARTIFACTS = ['original.wf', 'original.wfs', 'converted.wf', 'normalized.wf'] as const;

/** Artifacts that only a real run can produce — one from every writer the lane depends on. */
const MODEL_ARTIFACTS = [
  'run/motion/position/agents/position_1.txt',
  'run/BirthsDeaths.log',
  'run/lifespans.txt',
  'run/population.txt',
  'run/endStep.txt',
  'run/endReason.txt',
  'run/genome/genestats.txt',
  'run/genome/agents/genome_1.txt.gz',
  'run/energy/agents/agent_1.txt',
  'run/brain/anatomy/brainAnatomy_10_incept.txt.gz',
  'run/brain/synapses/synapses_10_incept.txt.gz',
  // The monitor's own artifact: written by lane L14's `MonitorManager` off `stepEnding`, through
  // this lane's status-text store (PORT-NOTE (L18/monitors-in-the-page)).
  'run/stats/stat.1',
] as const;

export function runTreeSuite(options: {
  readonly scenario: ScenarioName;
  readonly steps: number;
  /** How many golden files the page is known not to write (`movie.pmv` + the harness's manifest). */
  readonly pageExcluded: number;
  /** Scenario-specific artifacts on top of {@link MODEL_ARTIFACTS} (the brain-function naming
   * differs: a finished run renames `incomplete_…` to `brainFunction_…`). */
  readonly alsoWritten: readonly string[];
}): void {
  const golden = path.join(oracleRoot(), options.scenario, 'run');
  const goldenAvailable = existsSync(path.join(golden, 'normalized.wf'));

  describe.skipIf(!goldenAvailable)(`L18 ${options.scenario} run tree`, () => {
    let cached: RunTreeReport | null = null;
    const run = (): RunTreeReport => (cached ??= runModelIntoTree(options.scenario));

    it('runs the scenario to its own end, through the page’s factory', () => {
      const report = run();
      expect(report.ended).toBe(true);
      expect(report.steps).toBe(options.steps);
      expect(report.seed).toBe(42); // the worldfile's InitSeed, untouched
      expect(report.notice).toContain('MaxSteps');
    }, TIMEOUT_MS);

    it('carries the four boot artifacts byte-for-byte', () => {
      const dir = run().dir;
      for (const file of BOOT_ARTIFACTS) {
        const recorded = readFileSync(path.join(golden, file), 'utf8');
        const written = readFileSync(path.join(dir, 'run', file), 'utf8');
        expect(written, file).toBe(recorded);
      }
    }, TIMEOUT_MS);

    it('carries the model’s own artifacts, not just the boot’s', () => {
      const written = new Set(run().runFiles);
      for (const relative of [...MODEL_ARTIFACTS, ...options.alsoWritten]) {
        expect(written.has(relative), relative).toBe(true);
      }
      expect(written.size).toBeGreaterThan(200);
    }, TIMEOUT_MS);

    it('misses only what the page is known not to write, and invents nothing', () => {
      const written = new Set(run().runFiles);
      const goldenFiles = goldenRunFiles(options.scenario);
      const missing = goldenFiles.filter((file) => !written.has(file));
      const missingNotExcluded = missing.filter((file) => !isPageExcluded(file));
      expect(missingNotExcluded, `unexpectedly missing: ${missingNotExcluded.join(', ')}`).toEqual([]);
      expect(missing.length).toBe(options.pageExcluded);

      const extra = [...written].filter((file) => !goldenFiles.includes(file));
      expect(extra, `not in the golden: ${extra.join(', ')}`).toEqual([]);
    }, TIMEOUT_MS);
  });
}
