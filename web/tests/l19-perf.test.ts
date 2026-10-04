/**
 * Lane L19 (WASM/perf) — the measurement entry point.
 *
 * Two kinds of test live here:
 *
 *   1. **instrument self-checks** that run in every `npm test` and need no simulation: the
 *      192-agent perf scaling the plan measured (`--MaxAgents 192` through the worldfile
 *      parameter path), the profile ranking (`topFunctions`), the native baseline citations, the
 *      parity-verdict plumbing, and the phase combiner. So the number the card reads is produced
 *      by a checked instrument, not by an ad-hoc script.
 *   2. **the measurement itself**, one *phase* per process, opt-in with `L19_RUN=1` and driven by
 *      `tools/perf/l19-bench.sh` (`L19_PHASE=boot|steps|profile|contract|report`).
 *
 * PORT-NOTE(L19/one-run-per-process): the phases are not decoration. The port keeps native's
 * model registries as *process-global* statics (`FoodType.foodTypes`, the nerve table), so a
 * second `runScenario` in one process dies at `processWorldFile` with
 * `sim: duplicate FoodType name 'Standard'` — exactly what this file used to do when it measured
 * the boot and the step loop as two runs in one vitest worker, which made every measurement read
 * as "the model cannot produce a run tree". Each timed run is therefore its own process, and the
 * `report` phase never simulates: it combines the phase JSONs and asks the parity harness for a
 * verdict.
 *
 * The benchmark is opt-in because once the run tree reproduces the oracle it costs real seconds
 * per step and `npm test` must stay fast.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Config } from '../src/model/types';
import { emitNormalizedWorldfile } from '../src/model/proplib';
import {
  candidateKernelShare,
  checkParity,
  combineReport,
  measuredNativeStepCosts,
  nativeBaseline,
  phaseJsonPath,
  pickNativeMeasurement,
  profileSummary,
  readNativeRuns,
  readPhase,
  recordedConfigMatches,
  runPhase,
  topFunctions,
  writeReport,
  type BenchReport,
  type NativeRun,
  type ParityVerdict,
  type PhaseResult,
} from '../tools/perf/l19Perf';

/** Native argv `--Key value` pairs as lane L11's runner takes them. */
function parametersFromArgs(args: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < args.length; i += 2) {
    const key = args[i]!;
    if (key.startsWith('--')) map.set(key.slice(2), args[i + 1]!);
  }
  return map;
}

const repoRoot = process.cwd();
const perDir = join(repoRoot, '.candidate', 'l19-perf');
const phaseDir = join(perDir, 'phases');
const treesDir = join(perDir, 'trees');
/** The native runs `tools/perf/l19-native.sh` recorded on this host (empty if it never ran). */
const nativeRunsPath = join(perDir, 'native-runs.jsonl');

const scenario = process.env.L19_SCENARIO ?? 'minitest_voff';
/** `boot` | `steps` | `profile` | `contract` | `report` (default). */
const phase = process.env.L19_PHASE ?? 'report';
/** The steps the benchmark asks for; `full` = the recorded configuration (no `maxSteps`). */
const stepsArg = process.env.L19_STEPS ?? 'full';
const requestedSteps: number | null =
  stepsArg === 'full' ? null : Number.isFinite(Number(stepsArg)) ? Number(stepsArg) : null;
/** `l19-bench.sh --agents N` — the plan's big-world size; unset = the scenario's own MaxAgents. */
const agents = process.env.L19_AGENTS === undefined ? null : Number(process.env.L19_AGENTS);
/** Timed repetitions of the measured phase (median reported). */
const reps = Math.max(1, Number(process.env.L19_REPS ?? '1'));
/** The scenario whose recorded run demonstrates the byte-parity contract. */
const contractScenario = process.env.L19_CONTRACT_SCENARIO ?? 'microtest_voff';
const runBenchmark = process.env.L19_RUN === '1';

const recorded = join(repoRoot, 'oracle', scenario, 'run');
const worldfilePath = `worldfiles/tests/low-spec-pc/${scenario.split('_')[0]}.wf`;
const schemaPath = './etc/worldfile.wfs';

function worldfileTexts(): (path: string) => string {
  const original = readFileSync(join(recorded, 'original.wf'), 'utf8');
  const schema = readFileSync(join(recorded, 'original.wfs'), 'utf8');
  return (path: string) => {
    if (path === worldfilePath) return original;
    if (path === schemaPath) return schema;
    throw new Error(`l19-perf: no source text for '${path}'`);
  };
}

/**
 * The benchmark's parameters: the scenario's *recorded* argv (lane L11's merged registry, which
 * is what `runScenario` merges too) plus the perf overrides — so "did this benchmark run the
 * recorded world?" is a comparison, not a guess.
 *
 * The registry is imported lazily: a tree that does not compile must not stop this file from
 * collecting, and an unavailable registry only costs the parity claim (which needs a tree that
 * loads anyway).
 */
async function benchmarkParameters(): Promise<ReadonlyMap<string, string>> {
  let recordedParams: ReadonlyMap<string, string> | null = null;
  try {
    const runner = (await import('../src/model/sim/runner')) as {
      scenarioParameters(root: string, scenario: string): ReadonlyMap<string, string>;
    };
    recordedParams = runner.scenarioParameters(repoRoot, scenario);
  } catch {
    recordedParams = null;
  }
  const params = new Map<string, string>(recordedParams ?? [['Vision', 'False']]);
  if (agents !== null) params.set('MaxAgents', String(agents));
  return params;
}

function stepLabels(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `steps-rep${i + 1}`);
}

function failedRep(label: string, error: string): PhaseResult {
  return {
    label,
    scenario,
    tree: '',
    phasePath: phaseJsonPath(phaseDir, label),
    requestedSteps,
    steps: 0,
    ok: false,
    error,
    wallMs: 0,
    maxAgents: null,
    parameters: {},
    profilePath: null,
    hotFunctions: [],
    profileSummary: null,
  };
}

function readReps(): PhaseResult[] {
  const found: PhaseResult[] = [];
  for (const label of stepLabels(reps)) {
    const read = readPhase(phaseDir, label);
    if (read !== null) found.push(read);
  }
  return found;
}

/** A report-shaped object for the combiner self-check (no simulation). */
function phaseResult(over: Partial<PhaseResult>): PhaseResult {
  return {
    label: 'steps-rep1',
    scenario: 'minitest_voff',
    tree: '/tmp/tree',
    phasePath: '/tmp/phase.json',
    requestedSteps: null,
    steps: 301,
    ok: true,
    error: null,
    wallMs: 1000,
    maxAgents: 25,
    parameters: { Vision: 'False' },
    profilePath: null,
    hotFunctions: [],
    profileSummary: null,
    ...over,
  };
}

describe('L19 perf instrument', () => {
  it("scales a recorded scenario to the plan's big-world size through the parameter path", () => {
    // PORT_PLAN.md's native baseline is published at 25 and 192 agents; the recorded scenarios
    // are both 25-agent worlds. The instrument therefore has to be able to ask for 192 agents
    // the way native's argv does (`--MaxAgents 192`) — and to be sure the *worldfile* resolved
    // it, not the CLI map alone: `InitAgents MaxAgents` must follow.
    const built = emitNormalizedWorldfile(worldfileTexts(), {
      worldfilePath,
      schemaPath,
      parameters: parametersFromArgs(['--Vision', 'False', '--MaxAgents', '192']),
      validate: false,
    });
    const doc = new Config(built.worldfileDocument);
    expect(doc.getInt('MaxAgents')).toBe(192);
    // The expression follows the overridden property: `InitAgents MaxAgents` is what the
    // worldfile *text* keeps (the goldens keep it too — `normalized.wf` is the schema's tokens),
    // so the instrument asserts the value the *model* reads, which is what the boot's
    // `MaxAgents`-driven agent creation actually uses.
    expect(built.normalized).toMatch(/^\s*InitAgents\s+MaxAgents\s*$/m);
    expect(doc.getInt('InitAgents')).toBe(192);

    // The unmodified scenario still resolves to its recorded 25: the perf knob changed the
    // *benchmark's* world, never the parity world.
    const recorded25 = emitNormalizedWorldfile(worldfileTexts(), {
      worldfilePath,
      schemaPath,
      parameters: parametersFromArgs(['--Vision', 'False']),
      validate: false,
    });
    expect(new Config(recorded25.worldfileDocument).getInt('MaxAgents')).toBe(25);
  });

  it('ranks hot functions by self time (flame-profile reduction)', () => {
    // The shape `Profiler.stop` actually returns: the frame is **nested** under `callFrame`.
    // PORT-NOTE(L19/callframe-is-the-shape): the first fixture here carried flat
    // `functionName`/`url` fields, so it passed while every real profile reduced to zero hot
    // functions — the fixture now mirrors V8, which is what the instrument reads.
    const url = 'file:///Users/x/Developer/polyworld-web/src/model/brain/core/groupsBrain.ts';
    const frame = (functionName: string, u: string, lineNumber: number): object => ({
      callFrame: { functionName, url: u, lineNumber, columnNumber: 0 },
    });
    const profile = {
      timeDeltas: Array.from({ length: 100 }, () => 1000),
      samples: [],
      nodes: [
        { id: 1, ...frame('updateNeurons', url, 41), hitCount: 60 },
        { id: 2, ...frame('maintainFood', 'file:///Users/x/Developer/polyworld-web/src/model/sim/maintain.ts', 9), hitCount: 30 },
        { id: 3, ...frame('mt19937', 'file:///Users/x/Developer/polyworld-web/src/model/rng/mt19937.ts', 3), hitCount: 10 },
        // The synthetic buckets V8 adds: real samples, but not kernels a boundary could replace.
        { id: 4, ...frame('(garbage collector)', '', -1), hitCount: 111 },
        { id: 5, ...frame('(program)', '', -1), hitCount: 97 },
        { id: 6, ...frame('(root)', '', -1), hitCount: 0 },
      ],
    };
    const hot = topFunctions(profile, 3);
    expect(hot.map((h) => h.name)).toEqual(['updateNeurons', 'maintainFood', 'mt19937']);
    expect(hot[0]!.selfMs).toBe(60);
    expect(hot[0]!.selfPct).toBe(60);
    expect(hot[0]!.location).toBe('src/model/brain/core/groupsBrain.ts:42');

    // The attribution the decision needs next to the ranking: how much of the run is model work
    // at all (a compiled kernel cannot touch GC or `(program)`).
    const summary = profileSummary(profile);
    expect(summary.attributedPct).toBe(32.47); // 100 ms in real functions of 308 ms sampled
    expect(summary.garbageCollectorPct).toBe(36.04);
    expect(summary.otherSyntheticPct).toBe(31.49);
  });

  it('publishes the native comparison basis the decision is made against', () => {
    const baseline = nativeBaseline();
    expect(baseline.map((b) => b.agents)).toEqual([25, 192]);
    for (const b of baseline) expect(b.source.length).toBeGreaterThan(0);
  });

  it('computes ms/step from the boot-subtracted step loop, not from the whole run', () => {
    // 301 steps, walls 4000/4300/4150 ms, 235 ms of boot -> 12.508 / 13.505 / 13.007 ms/step. The
    // reported number is the **best** sample (the machine is shared); the median and the worst are
    // recorded next to it so the noise is visible rather than hidden behind one number.
    const report = combineReport({
      scenario: 'minitest_voff',
      repoRoot,
      outDir: perDir,
      boot: phaseResult({ label: 'boot', steps: 0, wallMs: 235 }),
      reps: [
        phaseResult({ label: 'steps-rep1', wallMs: 4000 }),
        phaseResult({ label: 'steps-rep2', wallMs: 4300 }),
        phaseResult({ label: 'steps-rep3', wallMs: 4150 }),
      ],
      profile: null,
      recordedConfiguration: true,
    });
    expect(report.repetitions).toBe(3);
    expect(report.msPerStep).toBe(12.508); // best of 12.508 / 13.505 / 13.007
    expect(report.msPerStepMedian).toBe(13.007);
    expect(report.msPerStepMax).toBe(13.505);
    expect(report.msPerStepMin).toBe(12.508);
    expect(report.stepsPerSecond).toBe(79.95);
    expect(report.steps).toBe(301);
    expect(report.maxAgents).toBe(25);
    // 12.508 ms/step at 25 agents against native's 15 ms/step wall: 0.83x -> the card's step 2.
    expect(report.ratioToNative?.wallRatio).toBe(0.83);
    expect(report.decision.startsWith('DO NOT ADD WASM')).toBe(true);
    expect(report.notes.join(' ')).toContain('spread');
  });

  it('reports NO DECISION with the blocker when the step loop did not run', () => {
    // `steps=0` is a measurement result, not a skip: the report keeps the seam that stopped it,
    // so a red tree cannot be read as "the port is infinitely fast".
    const report: BenchReport = combineReport({
      scenario: 'minitest_voff',
      repoRoot,
      outDir: perDir,
      boot: null,
      reps: [failedRep('steps-rep1', 'sim: duplicate FoodType name \'Standard\'')],
      profile: null,
      recordedConfiguration: false,
    });
    expect(report.steps).toBe(0);
    expect(report.ok).toBe(false);
    expect(report.decision.startsWith('NO DECISION')).toBe(true);
    expect(report.decision).toContain('duplicate FoodType');
  });

  it('prices the card\'s candidate kernels against the measured hot path', () => {
    // The card's step 3 names three kernel families. This is the instrument's answer to "are they
    // hot?", so the classification of a location into RNG / libm / neural / other is pinned here.
    const share = candidateKernelShare([
      { name: 'iterate', location: 'src/model/rng/drand48.ts:51', selfMs: 221.5, selfPct: 8.09, samples: 70 },
      { name: 'pow', location: 'src/model/rng/libm.ts:20', selfMs: 68.5, selfPct: 2.5, samples: 22 },
      { name: 'update', location: 'src/model/brain/core/firingRateModel.ts:80', selfMs: 41.1, selfPct: 1.5, samples: 13 },
      { name: 'sprintfC', location: 'src/model/brain/core/cformat.ts:240', selfMs: 47.5, selfPct: 1.73, samples: 15 },
      { name: 'formatFixed', location: 'src/model/datalib/printf.ts:76', selfMs: 575.9, selfPct: 21.04, samples: 182 },
    ]);
    expect(share.rngPct).toBe(8.09);
    expect(share.libmPct).toBe(2.5);
    expect(share.neuralPct).toBe(1.5);
    expect(share.totalPct).toBe(12.09);
    expect(share.ranked).toEqual([
      'iterate (src/model/rng/drand48.ts:51)',
      'pow (src/model/rng/libm.ts:20)',
      'update (src/model/brain/core/firingRateModel.ts:80)',
    ]);
    // `cformat` is native's C-`printf`, kept under `brain/core`: a path-prefix rule would count
    // it as a neural kernel and inflate the candidate share the decision rests on.
    expect(share.excludedHelpers).toEqual(['sprintfC (src/model/brain/core/cformat.ts:240, 1.73 %)']);
  });

  it('derives the native step cost from a boot-equivalent and a long run, per world and agent count', () => {
    // The native basis has to be produced the same way the TS number is: subtract a
    // boot-equivalent run from a long one. Runs with no counterpart, failed runs and short spans
    // must not silently become a basis.
    const run = (over: Partial<NativeRun>): NativeRun => ({
      worldfile: 'worldfiles/tests/low-spec-pc/minitest.wf',
      maxSteps: 301,
      maxAgents: 25,
      repetition: 1,
      exitCode: 0,
      wallSec: 3.2,
      endReason: 'MaxSteps',
      endStep: '301',
      ...over,
    });
    const runs: NativeRun[] = [
      run({ maxSteps: 1, wallSec: 2.3, endStep: '1' }),
      run({ maxSteps: 1, wallSec: 2.1, repetition: 2, endStep: '1' }),
      run({ maxSteps: 301, wallSec: 3.2 }),
      run({ maxSteps: 301, wallSec: 3.4, repetition: 2 }),
      // A different agent count needs its own pair; one long run alone is not a basis.
      run({ maxSteps: 301, maxAgents: 192, wallSec: 6.5 }),
      // A failed run is not evidence.
      run({ maxSteps: 1, wallSec: 0.1, exitCode: 1, endStep: '1' }),
      // A span that is too short to subtract a fixed cost out of.
      run({ maxSteps: 3, wallSec: 2.3, endStep: '3' }),
    ];
    const measurements = measuredNativeStepCosts(runs);
    expect(measurements.map((m) => m.agents)).toEqual([25]);
    expect(measurements[0]!.msPerStep).toBe(3.667); // (3.2 - 2.1) s / 300 steps, min wall each
    expect(measurements[0]!.shortRepetitions).toBe(2);
    expect(measurements[0]!.longRepetitions).toBe(2);
    expect(measurements[0]!.shortWallSec).toBe(2.1);
    expect(pickNativeMeasurement(measurements, 25)?.agents).toBe(25);
    // With no counterpart for 192 agents, the nearest published-size measurement is returned
    // rather than a null basis: the report says which agents it compared against.
    expect(pickNativeMeasurement(measurements, 192)?.agents).toBe(25);
  });

  it("claims byte-parity only for the scenario's recorded configuration", () => {
    // A 192-agent benchmark or a truncated run is a different world by construction; claiming a
    // parity verdict for it would be a false contract claim.
    const recorded = new Map([['Vision', 'False']]);
    expect(recordedConfigMatches(recorded, { Vision: 'False' }, null)).toBe(true);
    expect(recordedConfigMatches(recorded, { Vision: 'False' }, 301)).toBe(false);
    expect(recordedConfigMatches(recorded, { Vision: 'False', MaxAgents: '192' }, null)).toBe(false);
    expect(recordedConfigMatches(recorded, { Vision: 'True' }, null)).toBe(false);
  });

  it('captures a parity verdict instead of throwing (the contract path)', () => {
    // The card's step 3 has to prove byte-parity *survives* any WASM boundary, so the harness
    // has to be able to report a failing verdict. A candidate tree that does not exist is the
    // cheapest deterministic failure: the checker must run and come back non-zero with a
    // summary, never throw out of the harness.
    const verdict = checkParity(scenario, join(perDir, 'does-not-exist'), repoRoot, 60_000);
    expect(verdict.ok).toBe(false);
    expect(verdict.exitCode).not.toBe(0);
    expect(verdict.summary.length).toBeGreaterThan(0);
    expect(verdict.command).toContain('oracle/run_parity.sh');
  });
});

describe('L19 step-loop benchmark', () => {
  it(`runs the '${phase}' phase`, async () => {
    if (!runBenchmark) {
      process.stdout.write(
        '\n[l19-perf] benchmark not run (set L19_RUN=1, or use tools/perf/l19-bench.sh); ' +
          'the instrument self-checks above are the part that stays in `npm test`.\n',
      );
      return;
    }
    mkdirSync(perDir, { recursive: true });

    if (phase === 'boot') {
      const boot = await runPhase({
        scenario,
        label: 'boot',
        treeDir: join(treesDir, 'boot'),
        phaseDir,
        repoRoot,
        steps: 0,
        parameters: await benchmarkParameters(),
      });
      process.stdout.write(`\n[l19-perf] boot: ${boot.wallMs} ms (steps=${boot.steps})\n`);
      expect(boot.phasePath.length).toBeGreaterThan(0);
      return;
    }

    if (phase === 'contract') {
      // The byte-parity contract, taken on the scenario whose recorded run reproduces the oracle.
      const runner = (await import('../src/model/sim/runner')) as {
        scenarioParameters(root: string, scenario: string): ReadonlyMap<string, string>;
      };
      const contract = await runPhase({
        scenario: contractScenario,
        label: 'contract',
        treeDir: join(treesDir, 'contract'),
        phaseDir,
        repoRoot,
        parameters: new Map(runner.scenarioParameters(repoRoot, contractScenario)),
      });
      process.stdout.write(
        `\n[l19-perf] contract run ${contractScenario}: steps=${contract.steps} ok=${contract.ok}\n`,
      );
      return;
    }

    if (phase === 'profile' || phase === 'steps') {
      // One run per process: `steps` is the timed phase (repeated), `profile` is the same run
      // under the V8 profiler — deliberately separate, because a profile has overhead and its
      // wall time is not the number the card asks for.
      const label = phase === 'profile' ? 'profile' : stepLabels(reps)[Number(process.env.L19_REP ?? '1') - 1]!;
      const result = await runPhase({
        scenario,
        label,
        treeDir: join(treesDir, label),
        phaseDir,
        repoRoot,
        ...(requestedSteps === null ? {} : { steps: requestedSteps }),
        parameters: await benchmarkParameters(),
        profile: phase === 'profile',
      });
      process.stdout.write(
        `\n[l19-perf] ${label}: steps=${result.steps} ok=${result.ok} wall=${result.wallMs} ms ` +
          `agents=${result.maxAgents ?? 'unknown'}\n` +
          (result.error === null ? '' : `[l19-perf] stopped at: ${result.error.split('\n')[0]}\n`),
      );
      expect(result.phasePath.length).toBeGreaterThan(0);
      return;
    }

    // phase === 'report': combine, ask the parity harness, write the report. No simulation.
    const boot = readPhase(phaseDir, 'boot');
    const measured = readReps();
    const profile = readPhase(phaseDir, 'profile');
    let recordedParams: ReadonlyMap<string, string> | null = null;
    try {
      const runner = (await import('../src/model/sim/runner')) as {
        scenarioParameters(root: string, scenario: string): ReadonlyMap<string, string>;
      };
      recordedParams = runner.scenarioParameters(repoRoot, scenario);
    } catch {
      recordedParams = null;
    }
    const recordedConfiguration =
      recordedParams !== null &&
      recordedConfigMatches(
        recordedParams,
        measured[0]?.parameters ?? {},
        measured[0]?.requestedSteps ?? requestedSteps,
      );

    const report = combineReport({
      scenario,
      repoRoot,
      outDir: perDir,
      boot,
      reps: measured,
      profile,
      recordedConfiguration,
      nativeRuns: readNativeRuns(nativeRunsPath),
      nativeRunsPath,
      notes: [
        `phases: boot=${boot === null ? 'missing' : `${boot.wallMs} ms`}, ` +
          `timed=${measured.map((r) => `${r.label}:${r.steps} steps/${r.wallMs} ms`).join(', ') || 'missing'}, ` +
          `profile=${profile === null ? 'missing' : `${profile.hotFunctions.length} hot functions`}`,
        ...(recordedConfiguration
          ? []
          : [
              `no parity claim for the benchmark tree: it is not ${scenario}'s recorded ` +
                'configuration (perf overrides and/or a truncated step count), so its artifacts ' +
                'are not the golden ones.',
            ]),
      ],
    });

    // The parity contract: the recorded configuration of `contractScenario` (the scenario the
    // supervisor verified whole-run byte-exact), plus this benchmark's own tree when it *is* the
    // recorded configuration. A perf world is not the golden world, so it never gets a verdict.
    const verdicts: ParityVerdict[] = [];
    const contractPhaseResult = readPhase(phaseDir, 'contract');
    if (contractPhaseResult !== null && contractPhaseResult.ok) {
      verdicts.push(checkParity(contractScenario, contractPhaseResult.tree, repoRoot));
    }
    if (recordedConfiguration && report.tree.length > 0) {
      verdicts.push(checkParity(scenario, report.tree, repoRoot));
    }

    // The epoch keeps measurement *windows* apart: on a shared machine two runs of the same
    // configuration differ by ~15 %, and a later run overwriting the earlier JSON would hide that.
    const label = `${scenario}-${report.maxAgents ?? 'na'}-${report.steps}steps-${stepsArg}-${Math.floor(Date.now() / 1000)}`;
    const written = writeReport(report, verdicts, perDir, label);
    process.stdout.write(
      `\n[l19-perf] ${scenario}: steps=${report.steps} ok=${report.ok} ` +
        `agents=${report.maxAgents ?? 'unknown'} perStep=${report.msPerStep ?? 'n/a'} ms ` +
        `stepsPerSecond=${report.stepsPerSecond ?? 'n/a'}\n` +
        `[l19-perf] ${report.decision}\n` +
        `[l19-perf] report: ${written.jsonPath}\n`,
    );
    for (const note of report.notes) process.stdout.write(`[l19-perf] note: ${note}\n`);
    for (const verdict of verdicts) {
      process.stdout.write(
        `[l19-perf] parity ${verdict.scenario}: exit ${verdict.exitCode} ` +
          `(${verdict.summary.split('\n').slice(-1)[0]})\n`,
      );
    }
    if (report.error !== null) {
      process.stdout.write(`[l19-perf] stopped at: ${report.error.split('\n')[0]}\n`);
    }

    expect(written.jsonPath.length).toBeGreaterThan(0);
    // The contract is the one thing that must hold: the recorded configuration of
    // `contractScenario` has to grade byte-exact against the oracle.
    const contractVerdict = verdicts.find((v) => v.scenario === contractScenario && v.candidate.includes('contract'));
    if (contractVerdict !== undefined) expect(contractVerdict.ok).toBe(true);
  }, 60 * 60 * 1000);
});
