/**
 * The end-to-end parity **phase** — the vitest half of `tools/parity_candidate.sh`.
 *
 * It does exactly one thing: hand the scenario to lane L11's node runner and let it write a
 * candidate run tree. Grading is *not* here — `tools/parity_candidate.sh` runs the frozen entry
 * point (`./oracle/run_parity.sh <scenario> --candidate <tree>`) over the tree afterwards and
 * prints its verdict verbatim. The split is deliberate: this file's exit code means "the port
 * produced a tree", the harness's means "the tree matches the oracle".
 *
 * Why vitest and not `npx tsx src/model/sim/runner.ts` (which is what PARITY.md's status prose
 * documents): this repo pins no TypeScript runner (`package.json` has `vite`/`vitest` only, and
 * the sources import extensionlessly), so `npx tsx` fetches an unpinned package from the network
 * on every call. A parity verdict has to be reproducible from the lockfile.
 * `PORT-NOTE(parity-candidate/why-vitest)`.
 *
 * `PORT-NOTE(parity-candidate/one-run-per-process)`: exactly **one** `runScenario` per process,
 * which is why the entry point drives one vitest process per scenario. The port keeps native's
 * model registries as process-global statics (`src/model/environment/foodType.ts`), so a second
 * run in the same process dies at `processWorldFile` with
 * `sim: duplicate FoodType name 'Standard'` — the same constraint lane L19's phase split exists
 * for (`PORT-NOTE(L19/one-run-per-process)`).
 *
 * `PORT-NOTE(parity-candidate/refuse-root-before-wipe)`: the candidate root is refused **before**
 * it is wiped. `runScenario`'s own ownership check is `assertUsableStagingRoot`
 * (`src/model/sim/runner.ts`), but that runs *after* this file's `rmSync` — and the `rmSync` walk
 * is engine-dependent (node ≤ 22 re-enters the wrapped per-entry calls, node ≥ 24 removes through
 * internal bindings), so "the tripwire will catch it" is not a property of the tool. A
 * `PARITY_CANDIDATE_OUT=<oracle>/<scenario>` misuse therefore has to be refused by the same
 * predicate the runner uses, one line above the wipe, on every engine.
 *
 * `PORT-NOTE(parity-candidate/root-keyed-per-process)`: the **default** root is keyed per process
 * (`…/.candidate/parity/pid-<pid>/<scenario>`), because a root shared by two graded runs of one
 * scenario is not a candidate root at all — the same false-red class `t_1ce9957f` closed for the
 * browser lane. Measured at `a962806`: two concurrent default-root `minitest_voff` runs, 3 of 4
 * rounds false-red (one graded the other's half-built tree, `EXTRA
 * run/brain/function/incomplete_brainFunction_<n>.txt.gz`; the other died mid-rename with `ENOENT
 * … rename 'run/brain/function/incomplete_brainFunction_20.txt.gz'`, so the tool refused to grade).
 * `PARITY_CANDIDATE_OUT` still pins a caller's own root **verbatim** — and the caller then owns
 * exclusivity: two concurrent runs of one scenario must not be given the same `--out`.
 *
 * Opt-in, like L19's: with `PARITY_CANDIDATE_SCENARIO` unset the suite collects nothing, so
 * `npm test` neither simulates nor changes shape.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertUsableStagingRoot } from '../src/oracle/guard';
import { runScenario } from '../src/model/sim/runner';

const repoRoot = process.cwd();
const scenario = process.env.PARITY_CANDIDATE_SCENARIO;
const outDir =
  scenario === undefined
    ? undefined
    : resolve(
        process.env.PARITY_CANDIDATE_OUT ??
          // Keyed per process, exactly like the tool's own default and for the same reason
          // (PORT-NOTE(parity-candidate/root-keyed-per-process)): this default is the one a bare
          // `npx vitest run tests/parity-candidate.test.ts` gets, and two of those must not share a
          // root any more than two `tools/parity_candidate.sh` runs may.
          join(repoRoot, '.candidate', 'parity', `pid-${process.pid}`, scenario),
      );
const stepsArg = process.env.PARITY_CANDIDATE_STEPS ?? 'full';
/** `full` = the recorded configuration (no `maxSteps`): the tree a graded run must produce. */
const requestedSteps: number | null =
  stepsArg === 'full' ? null : Number.isFinite(Number(stepsArg)) ? Number(stepsArg) : null;
const reportPath = process.env.PARITY_CANDIDATE_REPORT;

/**
 * The run is not bounded by a stopwatch here (a full `minitest_voff` is 301 steps of real model
 * time); it is bounded by being a *single* scenario written by a *single* process. Vitest's 5 s
 * default would fail every graded run, so the phase carries its own budget the way
 * `tests/l19-perf.test.ts` does.
 */
const RUN_TIMEOUT_MS = 1_800_000;

describe.runIf(scenario !== undefined)('parity candidate tree', () => {
  it(
    `writes the run tree for '${scenario}'`,
    () => {
      const out = outDir!;
      const name = scenario!;

      // A candidate root is per run and must start empty: `check_parity.py` reports a file the
      // golden does not have as `extra`, so a stale tree from an earlier run would be graded as
      // if this run had written it (the same reason `record_oracle.py` builds a fresh dir).
      //
      // Ownership is settled *before* the wipe, not after: the runner's own
      // `assertUsableStagingRoot` (`src/model/sim/runner.ts`) runs once this tree is already gone,
      // and whether the tripwire catches the `rmSync` walk first depends on the node engine
      // (PORT-NOTE(parity-candidate/refuse-root-before-wipe)). The same predicate, called here,
      // refuses a golden root (oracle root, `oracle/<scenario>`, a golden `run/`, or a root whose
      // `run/` resolves into one) while the tree is still intact — and leaves the default
      // `.candidate/parity/pid-<pid>/<scenario>` and `oracle/_t_*` untouched.
      assertUsableStagingRoot(out, `parity candidate root for '${name}'`);
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });

      const started = Date.now();
      const result = runScenario({
        scenario: name,
        outDir: out,
        // Spelled out rather than defaulted: `'recorded-normalized'` is the diagnostic mode, and a
        // change of the runner's default must not be able to turn a graded tree into one whose
        // `converted.wf`/`normalized.wf` are the oracle's own copies
        // (PORT-NOTE(sim/runner-inputs)). This is the end-to-end path.
        documentFrom: 'port-boot',
        ...(requestedSteps === null ? {} : { maxSteps: requestedSteps }),
        repoRoot,
      });
      const wallMs = Date.now() - started;

      const tree = {
        scenario: name,
        outDir: out,
        requestedSteps,
        steps: result.steps,
        ok: result.ok,
        error: result.error,
        wallMs,
        runDirExists: existsSync(join(out, 'run')),
        gitHead: gitHead(),
      };
      if (reportPath !== undefined) {
        mkdirSync(join(reportPath, '..'), { recursive: true });
        writeFileSync(reportPath, `${JSON.stringify(tree, null, 2)}\n`);
      }
      process.stdout.write(
        `\n[parity-candidate] ${name}: steps=${result.steps} ok=${result.ok} ` +
          `wall=${(wallMs / 1000).toFixed(1)}s tree=${out}\n` +
          (result.error === null ? '' : `[parity-candidate] stopped at: ${result.error.split('\n')[0]}\n`),
      );

      // The tree, not the verdict: a run that stopped early writes a partial tree and the harness
      // would report it as missing files without saying why — this is the honest failure.
      expect(result.ok, `the port did not complete '${name}': ${result.error ?? ''}`).toBe(true);
      expect(existsSync(join(out, 'run', 'original.wf')), 'the run tree was not written').toBe(true);
      expect(existsSync(join(out, 'run', 'endReason.txt')), 'the run never reached End()').toBe(true);
    },
    RUN_TIMEOUT_MS,
  );
});

/** The tree is evidence; the commit it was produced at is what makes it reproducible. */
function gitHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
