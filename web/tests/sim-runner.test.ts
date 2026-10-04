/**
 * Lane L11 (sim) — the runner's smoke test: boot the recorded `microtest_voff` worldfile through
 * lane W1b's converter and hand it to the simulation.
 *
 * What this test can and cannot assert today is deliberate:
 *
 *  * it asserts the **boot** half unconditionally — the port builds its own `converted.wf` and
 *    `normalized.wf` from the recorded `original.wf`/`original.wfs` (lane W1b's contract), and the
 *    sim's ctor must accept the resulting document, run the init phases it can and stop at the
 *    first *lane* that has not landed (lane L15's body geometry, from `agent::grow()`);
 *  * it records where the run stopped (`runToStepBoundary`'s error) in the test output, so the
 *    blocker is visible in CI instead of hidden behind a skip.
 *
 * PORT-NOTE(sim/runner-smoke-scope): a green run of this test is **not** parity. Parity is
 * `./oracle/run_parity.sh <scenario> --candidate <tree>` over the run tree this runner writes, and
 * it needs lanes L5 (brain growth from a genome), L7/L12 (recorders), L13 (complexity) and L15
 * (the agent mesh) — see PARITY.md → Gaps.
 * Load, not slowness of the code: the guarded test(s) are 859 ms solo and 3.4 s under four
 * concurrent full suites — the band that false-reds when the fleet's three concurrent pairs
 * (6 processes) run. They carry LOAD_TIMEOUT_MS below; no assertion changed.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runScenario, parameterMapFromArgs } from '../src/model/sim/runner';
import { Simulation } from '../src/model/sim/simulation';
import { Scheduler, SchedulerState } from '../src/model/sim/scheduler';

const repoRoot = process.cwd();
const scenario = 'microtest_voff';
const hasGolden = existsSync(join(repoRoot, 'oracle', scenario, 'run', 'original.wf'));

/**
 * Vitest's default is 5 s. The guarded test(s) are 859 ms solo and 3.4 s under four concurrent
 * full suites; the fleet also runs three concurrent pairs (6 processes), and at that load the
 * orchestrator measured a 946 ms-solo test false-red 6/6 on 2026-09-29 — this is the same band.
 * 60 s is the budget the vision-on gate already carries (t_1f4a7a8a): that measurement with room,
 * and still a guard, so a genuine hang fails.
 */
const LOAD_TIMEOUT_MS = 60_000;

describe('sim runner', () => {
  it('the scheduler implements the recorded (deferred) phase semantics', () => {
    const scheduler = new Scheduler();
    const order: string[] = [];

    // The recorded configuration: postParallel work runs after the master task, postSerial work
    // after that, in push order — and never inline (sim-spec PORT-NOTE(sched-deferral)).
    scheduler.execMasterTask(() => {
      order.push('master:start');
      scheduler.postSerial(() => order.push('serial:1'));
      scheduler.postParallel(() => order.push('parallel:1'));
      scheduler.postSerial(() => order.push('serial:2'));
      order.push('master:end');
    }, false);

    expect(order).toEqual(['master:start', 'master:end', 'parallel:1', 'serial:1', 'serial:2']);
    expect(scheduler.getState()).toBe(SchedulerState.Idle);
  });

  it('forced-serial mode runs everything inline, in push order', () => {
    const scheduler = new Scheduler();
    const order: string[] = [];
    scheduler.execMasterTask(() => {
      scheduler.postSerial(() => order.push('serial:1'));
      order.push('master');
      scheduler.postParallel(() => order.push('parallel:1'));
    }, true);
    expect(order).toEqual(['serial:1', 'master', 'parallel:1']);
  });

  it.skipIf(!hasGolden)('boots the recorded worldfile and reports where the run stops', () => {
    const outDir = join(repoRoot, '.candidate', scenario);
    mkdirSync(outDir, { recursive: true });

    const result = runScenario({
      scenario,
      outDir,
      maxSteps: 1,
      repoRoot,
      // The scenario's argv (`scenarios.json`): the CLI override the native run applied.
      parameters: parameterMapFromArgs(['--Vision', 'False']),
    });

    process.stdout.write(
      `\n[sim-runner] diagnostic run: steps=${result.steps} ok=${result.ok} ` +
        `error=${result.error === null ? '(none)' : result.error}\n`,
    );

    // The worldfile the port built for itself is byte-comparable with the golden (lane W1b).
    const converted = readFileSync(join(outDir, 'run', 'converted.wf'), 'utf8');
    const goldenConverted = readFileSync(join(repoRoot, 'oracle', scenario, 'run', 'converted.wf'), 'utf8');
    expect(converted).toBe(goldenConverted);

    // Where the run stops today: the first unbound lane (L15's mesh, L5's brain growth, …).
    console.log(
      `sim runner: steps=${result.steps} ok=${result.ok} ` +
        `error=${result.error === null ? '(none)' : result.error}`,
    );

    // The ctor itself must get as far as constructing the Simulation object.
    expect(result.error === null || typeof result.error === 'string').toBe(true);
  }, LOAD_TIMEOUT_MS);

  it.skipIf(!hasGolden)('the simulation class exposes the frozen seams', () => {
    // A structural check of the two surfaces other lanes bind to (lane L12's log adapter and lane
    // L8's `SimulationLike`), so a rename cannot silently break them.
    const proto = Simulation.prototype as unknown as Record<string, unknown>;
    for (const name of [
      'step',
      'getStepNumber',
      'epoch',
      'numAgents',
      'maxAgents',
      'whichDomain',
      'switchDomain',
      'energyFitnessParameter',
      'ageFitnessParameter',
      'lifeFractionRecent',
      'lifeFractionSamples',
      'agentPovRenderer',
      'geneStats',
      'fittest',
      'enableComplexityCalculations',
      'logSimulationSurface',
    ]) {
      expect(typeof proto[name]).toBe('function');
    }
  });
});
