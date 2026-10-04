/**
 * Lane L19 (WASM/perf) — the measurement instrument.
 *
 * The card's protocol is "measure first, then compile the hot paths", and the measurement it
 * asks for is the one PORT_PLAN.md §"Measured facts" used on the native build: **steps/second
 * on a 25-agent and a 192-agent world, plus a flame profile naming the hot functions**.
 *
 * This module is that instrument, and nothing else — it does not touch the model. It:
 *
 *   1. boots a recorded scenario through lane L11's own runner (`src/model/sim/runner.ts`, so
 *      the *same* code path the parity harness grades) and times the step loop;
 *   2. profiles it with the V8 inspector (`node:inspector` + `Profiler.*`) and reduces the
 *      `.cpuprofile` to the top self-time functions — the flame profile;
 *   3. runs the parity harness (`./oracle/run_parity.sh <scenario> --candidate <tree>`) over
 *      the tree a run wrote, so any kernel that is later compiled to WASM is graded by the
 *      frozen contract and not by a feeling;
 *   4. compares steps/second against the native baseline and states the card's decision
 *      ("within ~2x of native -> do NOT add WASM").
 *
 * The native baseline numbers are the ones PORT_PLAN.md measured on this machine (native build,
 * term mode). They are constants here, not a promise: `nativeBaseline()` records where each
 * number came from, and re-measuring native is an explicit follow-up (`tools/perf/README.md`).
 *
 * PORT-NOTE(L19/baseline-is-published): the comparison basis is PORT_PLAN.md's measured native
 * cost (25 agents: ~15 ms/step; 192 agents: 1.14 s/step wall of which 0.41 s is work, the rest
 * GPU readback). The browser/TS run has no `glReadPixels` stall (vision-off is the byte-exact
 * tier), so the honest native comparator is the **work** number, and it is reported separately
 * rather than folded into one ratio.
 *
 * PORT-NOTE(L19/one-run-per-process): **one `runScenario` per process, enforced by the phase
 * split below.** Native boots exactly one worldfile per process, and the port transcribes that
 * faithfully: `FoodType.foodTypes`, the nerve table and the other model registries are
 * *process-global statics* (`src/model/environment/foodType.ts`), so a second `runScenario` in
 * the same process sees the first run's definitions and dies at `processWorldFile` with
 * `sim: duplicate FoodType name 'Standard'`. That is a property of the port, not a bug in it.
 *
 * The first version of this instrument did not respect it: it measured the boot with a
 * `maxSteps: 0` run and then the step loop with a second run *in the same process*, which made
 * every measurement report `steps=0` and "the run tree cannot be produced" — an instrument
 * artifact that read exactly like a model blocker. The phases (`boot`, `steps-repN`, `profile`,
 * `contract`, `report`) exist so that each timed run is its own process, driven by
 * `tools/perf/l19-bench.sh`; `report` never simulates, it only combines phase JSON and asks the
 * parity harness for the verdict.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { Session } from 'node:inspector';
import { performance } from 'node:perf_hooks';

/**
 * PORT-NOTE(L19/runner-is-imported-lazily): lane L11's runner is loaded *inside* a phase, not at
 * module scope. The instrument has to survive a tree that does not compile — many agents land
 * into this one working tree, and a half-landed lane makes `import runner` throw before the
 * measurement can report anything. Loaded lazily, the same failure becomes the phase's blocker
 * line ("the model tree does not load: Cannot find module './appleExpTable'") instead of a suite
 * that cannot even collect.
 */
import type { RunnerResult } from '../../src/model/sim/runner';

/** Lane L11's `runScenario` as this instrument calls it (the frozen parameter surface). */
export interface RunnerLike {
  (options: {
    readonly scenario: string;
    readonly outDir: string;
    /** Omitted = run to the worldfile's own `MaxSteps`/end, i.e. the recorded configuration. */
    readonly maxSteps?: number;
    readonly parameters: ReadonlyMap<string, string>;
    readonly repoRoot: string;
  }): RunnerResult;
}

// ---------------------------------------------------------------------------------------------
// the native baseline (PORT_PLAN.md -> "Measured facts this plan rests on", item 6)
// ---------------------------------------------------------------------------------------------

export interface NativeBaseline {
  readonly agents: number;
  /** Wall-clock milliseconds per step in the native build. */
  readonly msPerStepWall: number;
  /** Milliseconds per step that is model work (no GPU readback stall), when measured. */
  readonly msPerStepWork?: number;
  readonly source: string;
}

/**
 * Native, term mode, this machine — PORT_PLAN.md item 6. Fixed startup (~6 s) is excluded: it
 * is the run-time `clang++` + `dlopen` of the props library that lane W1h replaced with
 * build-time data, so it is not a step-loop cost in either implementation.
 */
export function nativeBaseline(): readonly NativeBaseline[] {
  return [
    {
      agents: 25,
      msPerStepWall: 15,
      source: 'PORT_PLAN.md §Measured facts item 6 ("~15 ms/step at 25 agents")',
    },
    {
      agents: 192,
      msPerStepWall: 1140,
      msPerStepWork: 410,
      source:
        'PORT_PLAN.md §Measured facts item 6 ("1.14 s/step at 192 agents (0.41 s of work, ' +
        'the rest blocked on GPU readback - 64% of wall)")',
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// the profile (flame) reduction
// ---------------------------------------------------------------------------------------------

export interface HotFunction {
  readonly name: string;
  readonly location: string;
  readonly selfMs: number;
  readonly selfPct: number;
  readonly samples: number;
}

interface CpuProfileCallFrame {
  readonly functionName?: string;
  readonly url?: string;
  readonly lineNumber?: number;
}

interface CpuProfileNode {
  readonly id: number;
  /**
   * V8's own shape: `Profiler.stop` (and `--cpu-prof`) put the frame in a nested `callFrame`.
   * PORT-NOTE(L19/callframe-is-the-shape): the first version of this reduction read
   * `node.functionName`/`node.url` off the node itself and therefore ranked *nothing* — every
   * real profile came back as "0 hot functions" while the hand-built fixture (flat fields) passed.
   * The fixture below is now the shape the profiler actually emits. The flat fields are still
   * accepted, because some producers flatten the frame.
   */
  readonly callFrame?: CpuProfileCallFrame;
  readonly functionName?: string;
  readonly url?: string;
  readonly lineNumber?: number;
  readonly hitCount?: number;
  readonly children?: readonly number[];
}

interface CpuProfile {
  readonly nodes: readonly CpuProfileNode[];
  readonly samples?: readonly number[];
  readonly startTime?: number;
  readonly endTime?: number;
  readonly timeDeltas?: readonly number[];
}

function nodeName(node: CpuProfileNode): string {
  return node.callFrame?.functionName ?? node.functionName ?? '';
}

function nodeUrl(node: CpuProfileNode): string {
  return node.callFrame?.url ?? node.url ?? '';
}

function nodeLine(node: CpuProfileNode): number {
  return node.callFrame?.lineNumber ?? node.lineNumber ?? 0;
}

/** The synthetic buckets V8 reports; they are not kernels a WASM boundary could replace. */
const SYNTHETIC_BUCKETS = new Set([
  '(root)',
  '(program)',
  '(idle)',
  '(garbage collector)',
  '(native)',
  '(unresolved function)',
  '',
]);

/**
 * Self time per function from a V8 `.cpuprofile`. Self time is the number that ranks the
 * *kernels* — a WASM boundary only pays for the function that actually burns the CPU, not for
 * its callers (`hitCount` is the same quantity the DevTools flame chart's bottom-up view uses).
 */
export function topFunctions(profile: CpuProfile, limit = 25, minSamples = 3): HotFunction[] {
  const intervalMs = samplingIntervalMs(profile);
  const byFunction = new Map<string, { name: string; location: string; ms: number; samples: number }>();

  for (const node of profile.nodes) {
    const samples = node.hitCount ?? 0;
    // The root, GC/(program)/(idle) and unattributed buckets are not kernels: a WASM boundary
    // can only pay for a function that has a source location and actually samples.
    if (samples < minSamples) continue;
    const name = nodeName(node);
    const url = nodeUrl(node);
    if (url.length === 0 || SYNTHETIC_BUCKETS.has(name)) continue;
    const location = `${shortUrl(url)}:${nodeLine(node) + 1}`;
    const key = `${name}\u0000${location}`;
    const entry = byFunction.get(key) ?? { name, location, ms: 0, samples: 0 };
    entry.ms += samples * intervalMs;
    entry.samples += samples;
    byFunction.set(key, entry);
  }

  const totalMs = [...byFunction.values()].reduce((sum, e) => sum + e.ms, 0);
  return [...byFunction.values()]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit)
    .map((e) => ({
      name: e.name,
      location: e.location,
      selfMs: round(e.ms, 3),
      selfPct: totalMs > 0 ? round((100 * e.ms) / totalMs, 2) : 0,
      samples: e.samples,
    }));
}

export interface ProfileSummary {
  /** Samples inside real functions (the ones a kernel decision can act on). */
  readonly attributedMs: number;
  readonly attributedPct: number;
  /** Samples V8 attributes to its own buckets: GC, `(program)`, `(idle)`. */
  readonly garbageCollectorMs: number;
  readonly garbageCollectorPct: number;
  readonly otherSyntheticMs: number;
  readonly otherSyntheticPct: number;
  readonly totalMs: number;
}

/**
 * How much of the profile is *model work* at all. GC and `(program)` samples are real CPU but
 * no WASM boundary removes them, so a report that ranks only functions would overstate how much
 * of the run a compiled kernel could even touch. Recorded next to the ranking, not instead of it.
 */
export function profileSummary(profile: CpuProfile): ProfileSummary {
  const intervalMs = samplingIntervalMs(profile);
  let attributed = 0;
  let gc = 0;
  let other = 0;
  for (const node of profile.nodes) {
    const ms = (node.hitCount ?? 0) * intervalMs;
    const name = nodeName(node);
    if (name === '(garbage collector)') gc += ms;
    else if (nodeUrl(node).length > 0 && !SYNTHETIC_BUCKETS.has(name)) attributed += ms;
    else other += ms;
  }
  const total = attributed + gc + other;
  const pct = (value: number): number => (total > 0 ? round((100 * value) / total, 2) : 0);
  return {
    attributedMs: round(attributed, 3),
    attributedPct: pct(attributed),
    garbageCollectorMs: round(gc, 3),
    garbageCollectorPct: pct(gc),
    otherSyntheticMs: round(other, 3),
    otherSyntheticPct: pct(other),
    totalMs: round(total, 3),
  };
}

/** The profile's sample interval: `timeDeltas` when present, else 1000 us (V8's default). */
function samplingIntervalMs(profile: CpuProfile): number {
  const deltas = profile.timeDeltas;
  if (deltas && deltas.length > 0) {
    const total = deltas.reduce((sum, d) => sum + d, 0);
    return total / deltas.length / 1000;
  }
  const start = profile.startTime ?? 0;
  const end = profile.endTime ?? 0;
  const samples = profile.samples?.length ?? 0;
  if (end > start && samples > 0) return (end - start) / samples / 1000;
  return 1;
}

function shortUrl(url: string): string {
  const marker = '/polyworld-web/';
  const at = url.indexOf(marker);
  return at === -1 ? url : url.slice(at + marker.length);
}

// ---------------------------------------------------------------------------------------------
// the first-hand native measurement (`tools/perf/l19-native.sh` -> `native-runs.jsonl`)
// ---------------------------------------------------------------------------------------------

/**
 * One line of `tools/perf/l19-native.sh`'s output: the wall time of the *native* binary on this
 * host, run from a symlink farm so the shared native tree's `run/` is never touched.
 *
 * PORT-NOTE(L19/native-basis-must-be-measured): PORT_PLAN.md's published baseline (~15 ms/step at
 * 25 agents, 1.14 s/step at 192) is a planning number, and the same machine's recorded runs
 * already contradict it (`oracle/minitest_voff/meta.json`: 1.98 s wall for the whole 301-step run).
 * A port that lands anywhere near the card's ~2x line cannot be judged against a basis the host
 * contradicts, so the report carries the published basis *and*, when it exists, this measured one,
 * and the decision names which it used.
 */
export interface NativeRun {
  readonly worldfile: string;
  readonly maxSteps: number | null;
  readonly maxAgents: number | null;
  readonly repetition: number;
  readonly exitCode: number;
  readonly wallSec: number;
  readonly endReason: string;
  readonly endStep: string;
}

export function readNativeRuns(path: string): NativeRun[] {
  if (!existsSync(path)) return [];
  const runs: NativeRun[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const text = line.trim();
    if (text.length === 0) continue;
    try {
      runs.push(JSON.parse(text) as NativeRun);
    } catch {
      /* a torn line (the file is appended to live) is not evidence; skip it */
    }
  }
  return runs;
}

export interface NativeMeasurement {
  readonly worldfile: string;
  readonly agents: number | null;
  /** The boot-equivalent run (native's `--MaxSteps 1`), whose wall is subtracted. */
  readonly shortSteps: number;
  readonly shortWallSec: number;
  readonly shortRepetitions: number;
  readonly longSteps: number;
  readonly longWallSec: number;
  readonly longRepetitions: number;
  readonly msPerStep: number;
}

/**
 * The native step cost, derived exactly the way the TS side is: one near-empty run (the boot) and
 * one full run of the same world, same agent count, subtracted and divided by the step difference.
 * The *minimum* wall of each is used — the machine is shared, so the minimum is the least
 * contended sample; the repetition count is reported so the reader can see how thin it is.
 */
export function measuredNativeStepCosts(
  runs: readonly NativeRun[],
  minStepSpan = 50,
): NativeMeasurement[] {
  const groups = new Map<string, NativeRun[]>();
  for (const run of runs) {
    if (run.exitCode !== 0 || run.maxSteps === null) continue;
    const key = `${run.worldfile}\u0000${run.maxAgents ?? 'na'}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [run]);
    else group.push(run);
  }

  const measurements: NativeMeasurement[] = [];
  for (const group of groups.values()) {
    const bySteps = new Map<number, number[]>();
    for (const run of group) {
      const list = bySteps.get(run.maxSteps!) ?? [];
      list.push(run.wallSec);
      bySteps.set(run.maxSteps!, list);
    }
    const steps = [...bySteps.keys()].sort((a, b) => a - b);
    const shortSteps = steps[0]!;
    const longSteps = steps[steps.length - 1]!;
    // The subtraction needs a boot-equivalent run (1 step) and a long run, far enough apart that
    // the fixed cost does not swamp the difference.
    if (steps.length < 2 || shortSteps > 2 || longSteps - shortSteps < minStepSpan) continue;
    const shortList = bySteps.get(shortSteps)!;
    const longList = bySteps.get(longSteps)!;
    const shortWallSec = Math.min(...shortList);
    const longWallSec = Math.min(...longList);
    measurements.push({
      worldfile: group[0]!.worldfile,
      agents: group[0]!.maxAgents ?? null,
      shortSteps,
      shortWallSec,
      shortRepetitions: shortList.length,
      longSteps,
      longWallSec,
      longRepetitions: longList.length,
      msPerStep: round(((longWallSec - shortWallSec) * 1000) / (longSteps - shortSteps), 3),
    });
  }
  return measurements;
}

/** The measurement that speaks to this benchmark: nearest agent count, then the longest run. */
export function pickNativeMeasurement(
  measurements: readonly NativeMeasurement[],
  agents: number | null,
): NativeMeasurement | null {
  let best: NativeMeasurement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const measurement of measurements) {
    // An unknown agent count is not "distance zero": it can only be a fallback, so it ranks behind
    // any measurement whose world actually says how many agents ran. (The first version of this
    // compared `undefined - agents`, got NaN, and silently returned the first measurement in the
    // file — which priced a 192-agent benchmark against a 25-agent native run.)
    const distance =
      agents === null || measurement.agents === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(measurement.agents - agents);
    if (
      best === null ||
      distance < bestDistance ||
      (distance === bestDistance && measurement.longSteps > best.longSteps)
    ) {
      best = measurement;
      bestDistance = distance;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// what the card's candidate kernels are worth
// ---------------------------------------------------------------------------------------------

/**
 * Helper files that live under the kernel directories but are *not* kernels: native's `cformat`
 * is brain/core's C-`printf` implementation, and the port keeps it there
 * (`src/model/brain/core/cformat.ts`).
 *
 * PORT-NOTE(L19/formatting-is-not-a-kernel): counting those files as "neural update inner loops"
 * inflated the card's candidate share from ~2 % to 17.6 % of attributed self time on the 192-agent
 * profile — a 8x error in the premise of the card's step 3, in the direction that would have
 * justified compiling the wrong thing.
 */
const NON_KERNEL_HELPERS = /(^|\/)(cformat|printf)\.ts(:\d+)?$/;

export interface CandidateKernelShare {
  /** Percent of *attributed* self time inside the card's candidate kernels. */
  readonly rngPct: number;
  readonly libmPct: number;
  readonly neuralPct: number;
  readonly totalPct: number;
  /** The ranked candidate functions the profile actually found (name, location). */
  readonly ranked: readonly string[];
  /** Files that a path-prefix rule would have counted but that are formatting helpers. */
  readonly excludedHelpers: readonly string[];
}

/**
 * The card's step 3 names three candidate kernel families: the RNG streams, the bit-exact libm
 * `exp`/`pow`, and the neural update inner loops. This is how much of the profile they are worth —
 * a fraction, so the report can say whether compiling them could pay at all, instead of assuming
 * the card's candidate list is the hot list.
 */
export function candidateKernelShare(hot: readonly HotFunction[]): CandidateKernelShare {
  let rngPct = 0;
  let libmPct = 0;
  let neuralPct = 0;
  const ranked: string[] = [];
  const excludedHelpers: string[] = [];
  for (const fn of hot) {
    const isRng = fn.location.startsWith('src/model/rng/');
    const isNeural = fn.location.startsWith('src/model/brain/');
    if (!isRng && !isNeural) continue;
    if (NON_KERNEL_HELPERS.test(fn.location)) {
      excludedHelpers.push(`${fn.name} (${fn.location}, ${fn.selfPct} %)`);
      continue;
    }
    if (fn.location.startsWith('src/model/rng/libm')) libmPct += fn.selfPct;
    else if (isRng) rngPct += fn.selfPct;
    else neuralPct += fn.selfPct;
    ranked.push(`${fn.name} (${fn.location})`);
  }
  return {
    rngPct: round(rngPct, 2),
    libmPct: round(libmPct, 2),
    neuralPct: round(neuralPct, 2),
    totalPct: round(rngPct + libmPct + neuralPct, 2),
    ranked,
    excludedHelpers,
  };
}

// ---------------------------------------------------------------------------------------------
// the phases — each one is a process, and each process runs at most one `runScenario`
// ---------------------------------------------------------------------------------------------

export interface PhaseRequest {
  readonly scenario: string;
  /** `boot` | `steps-rep1` | `profile` | `contract` — also the phase JSON's file name. */
  readonly label: string;
  /** The run tree this phase writes. */
  readonly treeDir: string;
  /** Where the phase's JSON goes (`.candidate/l19-perf/phases`). */
  readonly phaseDir: string;
  readonly repoRoot: string;
  /** Omitted = to the worldfile's own end (the recorded configuration). */
  readonly steps?: number;
  readonly parameters: ReadonlyMap<string, string>;
  /** Start/stop a V8 CPU profile around this phase's run. */
  readonly profile?: boolean;
  readonly profilePath?: string;
}

export interface PhaseResult {
  readonly label: string;
  readonly scenario: string;
  /** The run tree this phase wrote (`<treeDir>`, containing `run/`). */
  readonly tree: string;
  readonly phasePath: string;
  /** The `maxSteps` asked of the run (`null` = to the worldfile's own end). */
  readonly requestedSteps: number | null;
  readonly steps: number;
  readonly ok: boolean;
  readonly error: string | null;
  readonly wallMs: number;
  readonly maxAgents: number | null;
  readonly parameters: Record<string, string>;
  readonly profilePath: string | null;
  readonly hotFunctions: readonly HotFunction[];
  /** Present only for the profiled phase; how much of the profile is model work at all. */
  readonly profileSummary: ProfileSummary | null;
}

const NOT_RUN = 'phase did not run';

/**
 * How many functions the flame profile ranks. The share the decision rests on ("the card's
 * candidate kernels are N % of self time") is a share of this ranked set, so the cut-off is part
 * of the number: a short list hides the long tail of per-neuron functions. 40 keeps the table
 * readable and the tail visible; `PORT-NOTE(L19/rank-cutoff-is-part-of-the-number)`.
 */
export const PROFILE_RANK_LIMIT = 40;

/**
 * Run **one** `runScenario` and time it. This is the only place in the instrument that
 * simulates, and the phase boundary around it is what keeps the port's process-global registries
 * honest (PORT-NOTE(L19/one-run-per-process)).
 *
 * A phase never throws for a model/tree failure: it records it (`ok: false`, `error`) and writes
 * its JSON, so the `report` phase has something to combine and the blocker is printed rather
 * than swallowed by a crashed worker.
 */
export async function runPhase(request: PhaseRequest): Promise<PhaseResult> {
  mkdirSync(request.treeDir, { recursive: true });
  mkdirSync(request.phaseDir, { recursive: true });
  const phasePath = phaseJsonPath(request.phaseDir, request.label);

  let runScenario: RunnerLike;
  try {
    const runner = (await import('../../src/model/sim/runner')) as { runScenario: RunnerLike };
    runScenario = runner.runScenario;
  } catch (thrown) {
    return writePhase(
      phasePath,
      failedPhase(request, `the model tree does not load: ${describeThrown(thrown)}`),
    );
  }

  const session = request.profile === true ? await startProfiler() : null;
  const started = performance.now();
  let result: RunnerResult | null = null;
  let error: string | null = null;
  try {
    result = runScenario({
      scenario: request.scenario,
      outDir: request.treeDir,
      ...(request.steps === undefined ? {} : { maxSteps: request.steps }),
      parameters: request.parameters,
      repoRoot: request.repoRoot,
    });
  } catch (thrown) {
    error = describeThrown(thrown);
  }
  const wallMs = performance.now() - started;

  let profilePath: string | null = null;
  let hotFunctions: readonly HotFunction[] = [];
  let summary: ProfileSummary | null = null;
  if (session !== null) {
    const profile = await session.stop();
    profilePath = request.profilePath ?? join(request.phaseDir, `${request.label}.cpuprofile.json`);
    writeFileSync(profilePath, JSON.stringify(profile));
    hotFunctions = topFunctions(profile as CpuProfile, PROFILE_RANK_LIMIT);
    summary = profileSummary(profile as CpuProfile);
  }

  return writePhase(phasePath, {
    label: request.label,
    scenario: request.scenario,
    tree: resolve(request.treeDir),
    phasePath,
    requestedSteps: request.steps ?? null,
    steps: result?.steps ?? 0,
    ok: result !== null && result.ok && error === null,
    error: error ?? result?.error ?? null,
    wallMs: round(wallMs, 2),
    maxAgents: readMaxAgentsFrom(join(request.treeDir, 'run', 'normalized.wf')),
    parameters: Object.fromEntries(request.parameters),
    profilePath,
    hotFunctions,
    profileSummary: summary,
  });
}

function failedPhase(request: PhaseRequest, error: string): PhaseResult {
  return {
    label: request.label,
    scenario: request.scenario,
    tree: resolve(request.treeDir),
    phasePath: phaseJsonPath(request.phaseDir, request.label),
    requestedSteps: request.steps ?? null,
    steps: 0,
    ok: false,
    error,
    wallMs: 0,
    maxAgents: null,
    parameters: Object.fromEntries(request.parameters),
    profilePath: null,
    hotFunctions: [],
    profileSummary: null,
  };
}

function describeThrown(thrown: unknown): string {
  return thrown instanceof Error ? `${thrown.message}\n${thrown.stack ?? ''}` : String(thrown);
}

export function phaseJsonPath(phaseDir: string, label: string): string {
  return join(phaseDir, `${label}.json`);
}

function writePhase(phasePath: string, phase: PhaseResult): PhaseResult {
  mkdirSync(dirname(phasePath), { recursive: true });
  writeFileSync(phasePath, `${JSON.stringify(phase, null, 2)}\n`);
  return phase;
}

/** Read back a phase a previous process wrote; `null` when the phase never ran. */
export function readPhase(phaseDir: string, label: string): PhaseResult | null {
  const path = phaseJsonPath(phaseDir, label);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PhaseResult;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// combining the phases into the report and the card's decision
// ---------------------------------------------------------------------------------------------

export interface BenchReport {
  readonly scenario: string;
  readonly outDir: string;
  /** The run tree the measured repetitions wrote (the tree the parity verdict grades). */
  readonly tree: string;
  /** The `maxSteps` the benchmark asked for (`null` = the recorded configuration). */
  readonly requestedSteps: number | null;
  readonly steps: number;
  readonly ok: boolean;
  readonly error: string | null;
  /** How many timed repetitions were combined. */
  readonly repetitions: number;
  /**
   * The reported numbers come from the **fastest** repetition, not the median: the machine is
   * shared with other lanes (and their native probes), so the best sample is the least contended
   * one — the same convention the native side uses (min wall). The median and the full range are
   * recorded next to it so nobody has to guess how noisy the window was.
   */
  readonly totalMs: number;
  readonly bootMs: number | null;
  readonly stepLoopMs: number | null;
  readonly msPerStep: number | null;
  readonly msPerStepMin: number | null;
  readonly msPerStepMedian: number | null;
  readonly msPerStepMax: number | null;
  readonly stepsPerSecond: number | null;
  readonly maxAgents: number | null;
  readonly parameters: Record<string, string>;
  /** True when the benchmark ran the scenario exactly as the oracle recorded it. */
  readonly recordedConfiguration: boolean;
  readonly profilePath: string | null;
  readonly hotFunctions: readonly HotFunction[];
  /** How much of the profiled run is model work at all (GC/`(program)` are not). */
  readonly profileSummary: ProfileSummary | null;
  readonly nativeBaseline: readonly NativeBaseline[];
  readonly ratioToNative: {
    readonly agents: number;
    readonly tsMsPerStep: number;
    readonly nativeMsPerStepWall: number;
    readonly nativeMsPerStepWork: number | null;
    readonly wallRatio: number;
    readonly workRatio: number | null;
  } | null;
  /**
   * The card's step-3 candidate kernels (RNG / libm / neural) as a share of attributed self time.
   * Present so the decision can be made against the *measured* hot path, not the card's guess.
   */
  readonly candidateKernels: CandidateKernelShare | null;
  /**
   * First-hand native timing on this host (`tools/perf/l19-native.sh`), when it exists — the
   * basis the decision prefers over PORT_PLAN.md's planning number.
   */
  readonly nativeMeasured: {
    readonly measurement: NativeMeasurement;
    readonly ratio: number;
    readonly source: string;
  } | null;
  /** The card's step-2 decision, stated with the numbers that produced it. */
  readonly decision: string;
  /** Facts the report must not hide (why a parity claim does or does not apply, spread, ...). */
  readonly notes: readonly string[];
}

export interface BenchInputs {
  readonly scenario: string;
  readonly repoRoot: string;
  readonly outDir: string;
  readonly boot: PhaseResult | null;
  /** The timed repetitions (`steps-rep1` ...). */
  readonly reps: readonly PhaseResult[];
  readonly profile: PhaseResult | null;
  /** Whether the benchmark ran the scenario's recorded configuration (see `recordedConfig`). */
  readonly recordedConfiguration: boolean;
  /** The first-hand native runs (`native-runs.jsonl`); empty when native was not timed here. */
  readonly nativeRuns?: readonly NativeRun[];
  readonly nativeRunsPath?: string;
  readonly notes?: readonly string[];
}

/**
 * Combine the phases into one report. Pure: no simulation, no I/O — the `report` phase is the
 * only place the numbers are allowed to be assembled, and it runs in its own process so a
 * mis-shaped phase cannot corrupt a measurement.
 */
export function combineReport(inputs: BenchInputs): BenchReport {
  const bootMs = inputs.boot !== null && inputs.boot.ok ? inputs.boot.wallMs : null;
  const measured = inputs.reps.filter((rep) => rep.steps > 0);
  const firstError =
    inputs.reps.find((rep) => rep.error !== null)?.error ??
    inputs.boot?.error ??
    (inputs.reps.length === 0 ? `${NOT_RUN}: no 'steps-repN' phase was recorded` : null);
  const primary = measured[0] ?? null;

  const perStep = measured.map((rep) =>
    round(Math.max(0, rep.wallMs - (bootMs ?? 0)) / rep.steps, 3),
  );
  const msPerStep = perStep.length === 0 ? null : Math.min(...perStep);
  const msPerStepMedian = median(perStep);
  const totalMs = measured.length === 0 ? 0 : Math.min(...measured.map((rep) => rep.wallMs));
  const stepLoopMs =
    msPerStep === null || primary === null ? null : round(msPerStep * primary.steps, 2);
  const maxAgents = primary?.maxAgents ?? inputs.boot?.maxAgents ?? null;
  const ratio = ratioToNative(maxAgents, msPerStep);

  const notes = [...(inputs.notes ?? [])];
  if (perStep.length > 1) {
    const spread = (Math.max(...perStep) - Math.min(...perStep)) / (msPerStep ?? 1);
    notes.push(
      `repetitions: ${perStep.length}, ms/step ${msPerStep} best / ${msPerStepMedian} median / ` +
        `${Math.max(...perStep)} worst (a ${(100 * spread).toFixed(1)} % spread — other lanes and ` +
        'their native probes share this machine); the reported number is the best sample, ' +
        'matching the native side\'s min-wall convention',
    );
  }
  if (bootMs === null) {
    notes.push('no boot phase: ms/step is the whole run divided by its steps, boot included');
  }
  const failedReps = inputs.reps.filter((rep) => rep.steps === 0 || !rep.ok);
  if (failedReps.length > 0) {
    notes.push(
      `${failedReps.length} of ${inputs.reps.length} repetitions did not run ` +
        `(${failedReps
          .map((rep) => `${rep.label}: ${rep.error?.split('\n')[0] ?? 'no error text'}`)
          .join('; ')}) — the reported number uses the repetitions that did, and the failure is ` +
        'printed below rather than averaged away',
    );
  }
  const hot = inputs.profile?.hotFunctions ?? [];
  const summary = inputs.profile?.profileSummary ?? null;
  if (hot.length > 0) {
    notes.push(
      `flame profile: the two hottest self-time functions are ${hot
        .slice(0, 2)
        .map((h) => `\`${h.name}\` (${h.selfPct} %)`)
        .join(' and ')} — see the table below and \`${inputs.profile?.profilePath ?? ''}\``,
    );
  }
  if (summary !== null) {
    notes.push(
      `profile attribution: ${summary.attributedPct} % of samples are inside real functions ` +
        `(the part a compiled kernel could touch at all), ${summary.garbageCollectorPct} % are ` +
        `V8 GC and ${summary.otherSyntheticPct} % are \`(program)\`/\`(idle)\``,
    );
  }

  // The card's candidate kernels vs the measured hot path, and the native basis the decision
  // prefers. Both are recorded even when they contradict the card, because that is the finding.
  const candidates = hot.length > 0 ? candidateKernelShare(hot) : null;
  if (candidates !== null) {
    const hottest = hot.find(
      (fn) =>
        !fn.location.startsWith('src/model/rng/') && !fn.location.startsWith('src/model/brain/'),
    );
    notes.push(
      `the card's step-3 candidate kernels are ${candidates.totalPct} % of the ${hot.length} ` +
        `ranked functions' self time (RNG streams ${candidates.rngPct} %, libm ${candidates.libmPct} %, ` +
        `neural ${candidates.neuralPct} %)` +
        (hottest === undefined
          ? ''
          : `; the biggest thing the profile ranks is \`${hottest.name}\` (${hottest.selfPct} %, ${hottest.location}), which is not one of them`) +
        (candidates.excludedHelpers.length === 0
          ? ''
          : `. Excluded as formatting helpers, not kernels: ${candidates.excludedHelpers.join(', ')}`),
    );
  }
  // How much of the ranked self time is my own harness (vitest/vite internals, the profiler)
  // rather than the model: a flame profile of a run *inside a test runner* includes the runner.
  if (hot.length > 0) {
    const harnessPct = round(
      hot
        .filter((fn) => fn.location.startsWith('node_modules/') || fn.location.startsWith('tools/'))
        .reduce((sum, fn) => sum + fn.selfPct, 0),
      2,
    );
    if (harnessPct > 0) {
      notes.push(
        `${harnessPct} % of the ranked self time is the harness itself (vitest/vite module ` +
          'resolution and this instrument), not the model — read the kernel shares with that in mind',
      );
    }
  }
  const nativeRuns = inputs.nativeRuns ?? [];
  const picked = pickNativeMeasurement(measuredNativeStepCosts(nativeRuns), maxAgents);
  const nativeMeasured =
    picked === null || msPerStep === null
      ? null
      : {
          measurement: picked,
          ratio: round(msPerStep / picked.msPerStep, 2),
          source: inputs.nativeRunsPath ?? '',
        };
  if (nativeMeasured !== null) {
    notes.push(
      `native, first-hand on this host (${nativeMeasured.source}): ` +
        `${picked!.msPerStep} ms/step at ${picked!.agents ?? 'unknown'} agents, from ` +
        `${picked!.shortWallSec}s for ${picked!.shortSteps} step and ${picked!.longWallSec}s for ` +
        `${picked!.longSteps} steps (${picked!.shortRepetitions}x / ${picked!.longRepetitions}x ` +
        `repetitions, min wall each) -> the port is ${nativeMeasured.ratio}x`,
    );
  } else if (nativeRuns.length === 0) {
    notes.push(
      'no first-hand native timing was recorded (`tools/perf/l19-native.sh`); the ratio below ' +
        'uses PORT_PLAN.md\'s published baseline only, which this host\'s own recorded runs ' +
        '(`oracle/<scenario>/meta.json` -> `wall_sec`) already contradict',
    );
  }

  return {
    scenario: inputs.scenario,
    outDir: inputs.outDir,
    tree: primary?.tree ?? '',
    requestedSteps: primary?.requestedSteps ?? null,
    steps: primary?.steps ?? 0,
    ok: measured.length > 0 && measured.every((rep) => rep.ok),
    error: firstError,
    repetitions: measured.length,
    totalMs: totalMs ?? 0,
    bootMs,
    stepLoopMs,
    msPerStep,
    msPerStepMin: perStep.length === 0 ? null : Math.min(...perStep),
    msPerStepMedian,
    msPerStepMax: perStep.length === 0 ? null : Math.max(...perStep),
    stepsPerSecond: msPerStep === null || msPerStep === 0 ? null : round(1000 / msPerStep, 2),
    maxAgents,
    parameters: primary?.parameters ?? inputs.boot?.parameters ?? {},
    recordedConfiguration: inputs.recordedConfiguration,
    profilePath: inputs.profile?.profilePath ?? null,
    hotFunctions: hot,
    profileSummary: summary,
    nativeBaseline: nativeBaseline(),
    ratioToNative: ratio,
    candidateKernels: candidates,
    nativeMeasured,
    decision: decide({
      steps: primary?.steps ?? 0,
      ok: measured.length > 0 && measured.every((rep) => rep.ok),
      error: firstError,
      msPerStep,
      ratio,
      maxAgents,
      hot,
      candidates,
      nativeMeasured,
    }),
    notes,
  };
}

export function ratioToNative(
  maxAgents: number | null,
  msPerStep: number | null,
): BenchReport['ratioToNative'] {
  if (maxAgents === null || msPerStep === null) return null;
  const baseline = nearestBaseline(maxAgents);
  if (baseline === null) return null;
  return {
    agents: baseline.agents,
    tsMsPerStep: round(msPerStep, 3),
    nativeMsPerStepWall: baseline.msPerStepWall,
    nativeMsPerStepWork: baseline.msPerStepWork ?? null,
    wallRatio: round(msPerStep / baseline.msPerStepWall, 2),
    workRatio:
      baseline.msPerStepWork === undefined ? null : round(msPerStep / baseline.msPerStepWork, 2),
  };
}

function nearestBaseline(agents: number): NativeBaseline | null {
  const baselines = nativeBaseline();
  let best: NativeBaseline | null = null;
  for (const b of baselines) {
    if (best === null || Math.abs(b.agents - agents) < Math.abs(best.agents - agents)) best = b;
  }
  return best;
}

interface DecisionInput {
  readonly steps: number;
  readonly ok: boolean;
  readonly error: string | null;
  readonly msPerStep: number | null;
  readonly ratio: BenchReport['ratioToNative'];
  readonly maxAgents: number | null;
  readonly hot: readonly HotFunction[];
  readonly candidates: CandidateKernelShare | null;
  readonly nativeMeasured: BenchReport['nativeMeasured'];
}

function decide(input: DecisionInput): string {
  if (input.steps === 0 || !input.ok) {
    return (
      'NO DECISION: the TS step loop did not run (steps=' +
      `${input.steps}, ok=${input.ok}) — there is nothing to compare against native. The blocker ` +
      'is recorded in `error`/`PORT-RUN-ERROR.txt`, not hidden behind a skip: ' +
      `${input.error?.split('\n')[0] ?? 'no error text'}`
    );
  }
  if (input.msPerStep === null) {
    return 'NO DECISION: the benchmark ran but produced no ms/step.';
  }

  // The two bases, stated separately: PORT_PLAN.md's planning numbers, and the first-hand native
  // timing on this host. They disagree by ~4x on this machine, and the decision must say which
  // one it used rather than picking the convenient one.
  const publishedBasis =
    input.ratio === null
      ? `no published baseline near ${input.maxAgents ?? 'unknown'} agents`
      : `PORT_PLAN.md's published baseline ${input.ratio.nativeMsPerStepWall} ms/step wall` +
        (input.ratio.workRatio === null
          ? ''
          : ` (${input.ratio.nativeMsPerStepWork} ms work-only)`) +
        ` -> ${input.ratio.wallRatio}x` +
        (input.ratio.workRatio === null ? '' : `/${input.ratio.workRatio}x work-only`);
  const measuredBasis =
    input.nativeMeasured === null
      ? 'no first-hand native timing on this host'
      : `native measured here ${input.nativeMeasured.measurement.msPerStep} ms/step at ` +
        `${input.nativeMeasured.measurement.agents ?? 'unknown'} agents ` +
        `(${input.nativeMeasured.measurement.shortSteps}- vs ${input.nativeMeasured.measurement.longSteps}-step ` +
        `runs) -> ${input.nativeMeasured.ratio}x`;

  const primary =
    input.nativeMeasured === null
      ? (input.ratio?.workRatio ?? input.ratio?.wallRatio ?? null)
      : input.nativeMeasured.ratio;
  if (primary === null) {
    return (
      `NO DECISION: ${input.msPerStep} ms/step at ${input.maxAgents ?? 'unknown'} agents, but ` +
      `there is no native basis to compare it against (${publishedBasis}).`
    );
  }

  const hottest =
    input.hot.length === 0 ? '' : ` The flame profile ranks \`${input.hot[0]!.name}\` first (${input.hot[0]!.selfPct} % of self time).`;
  const candidateCaveat =
    input.candidates === null || input.candidates.totalPct >= 25
      ? ''
      : ` BUT the profile does not back the card's candidate kernels: the RNG streams, libm and ` +
        `the neural update loops are together only ${input.candidates.totalPct} % of attributed ` +
        `self time (RNG ${input.candidates.rngPct} %, libm ${input.candidates.libmPct} %, neural ` +
        `${input.candidates.neuralPct} %), so compiling them cannot pay for a boundary. The ` +
        `profile's own hot path is elsewhere — that is where the port is losing, and it is not a ` +
        `kernel the card lists.`;

  if (primary <= 2) {
    return (
      `DO NOT ADD WASM: the port runs at ${input.msPerStep} ms/step; ${measuredBasis}; ` +
      `${publishedBasis}. The basis the card's ~2x line is judged on gives ${primary.toFixed(2)}x, ` +
      `inside the line, and PORT_PLAN.md §Risks warns a WASM boundary on a hot path can lose.` +
      `${hottest} Record this measurement and close the card with no WASM.`
    );
  }
  return (
    `WASM IS ON THE TABLE: the port runs at ${input.msPerStep} ms/step; ${measuredBasis}; ` +
    `${publishedBasis}. The basis the card's ~2x line is judged on gives ${primary.toFixed(2)}x, ` +
    `outside the line.${hottest}${candidateCaveat}`
  );
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : round((sorted[mid - 1]! + sorted[mid]!) / 2, 3);
}

/** `MaxAgents` as the run's own worldfile resolved it, so the report is not a guess. */
function readMaxAgentsFrom(worldfile: string): number | null {
  if (!existsSync(worldfile)) return null;
  const text = readFileSync(worldfile, 'utf8');
  const match = /^\s*MaxAgents\s+(\d+)\s*$/m.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Whether this benchmark ran the scenario *exactly* as the oracle recorded it — same parameters
 * as the recorded argv, no `maxSteps` truncation. Only then does a parity verdict over the run
 * tree mean anything: a 192-agent or truncated perf tree is a different world by construction,
 * and claiming byte-parity for it would be a false contract claim.
 */
export function recordedConfigMatches(
  expected: ReadonlyMap<string, string>,
  actual: Readonly<Record<string, string>>,
  requestedSteps: number | null,
): boolean {
  if (requestedSteps !== null) return false;
  const recorded = [...expected.entries()].sort();
  const benchmark = Object.entries(actual).sort();
  return (
    recorded.length === benchmark.length &&
    recorded.every(([key, value], i) => benchmark[i]?.[0] === key && benchmark[i]?.[1] === value)
  );
}

// ---------------------------------------------------------------------------------------------
// the profile session
// ---------------------------------------------------------------------------------------------

interface ProfilerSession {
  stop(): Promise<unknown>;
}

/**
 * Start a V8 CPU profile on the current process (the vitest worker running *one* timed run).
 *
 * The step loop is synchronous, so the profiler is started and stopped *outside* the timed
 * window's work: `Profiler.start` resolves before `runPhase` enters `runScenario`, and the loop
 * itself is deliberately not instrumented (instrumenting it would change the number it
 * measures). The profiled run is a *separate phase* from the timed repetitions for the same
 * reason — a profile has overhead, so its wall time is not the number the card asks for.
 */
export async function startProfiler(samplingIntervalUs = 1000): Promise<ProfilerSession> {
  const session = new Session();
  session.connect();
  const post = (method: string, params?: object): Promise<unknown> =>
    new Promise((resolvePromise, reject) => {
      session.post(method, (params ?? {}) as never, (err, result) => {
        if (err) reject(err);
        else resolvePromise(result);
      });
    });

  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: samplingIntervalUs });
  await post('Profiler.start');

  return {
    async stop(): Promise<unknown> {
      const result = (await post('Profiler.stop')) as { profile?: unknown };
      await post('Profiler.disable');
      session.disconnect();
      return result.profile ?? null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// parity + report
// ---------------------------------------------------------------------------------------------

export interface ParityVerdict {
  readonly scenario: string;
  readonly candidate: string;
  readonly command: string;
  readonly exitCode: number;
  readonly ok: boolean;
  readonly summary: string;
}

/**
 * The card's contract check: a run tree written by this harness, graded by the frozen oracle.
 * Any future WASM boundary has to keep this at exit 0 (PORT_SPEC.md: byte-parity is the
 * contract; a WASM kernel that changes one artifact byte is a failure, not a speedup).
 */
export function checkParity(
  scenario: string,
  candidateDir: string,
  repoRoot: string,
  timeoutMs = 1_800_000,
): ParityVerdict {
  const script = join(repoRoot, 'oracle', 'run_parity.sh');
  const command = `${script} ${scenario} --candidate ${candidateDir}`;
  try {
    const stdout = execFileSync(script, [scenario, '--candidate', candidateDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { scenario, candidate: candidateDir, command, exitCode: 0, ok: true, summary: lastLines(stdout) };
  } catch (thrown) {
    const err = thrown as { status?: number; stdout?: string; stderr?: string; message?: string };
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    return {
      scenario,
      candidate: candidateDir,
      command,
      exitCode: err.status ?? 1,
      ok: false,
      summary: text.length > 0 ? lastLines(text) : (err.message ?? 'parity check failed'),
    };
  }
}

function lastLines(text: string, count = 12): string {
  const lines = text.trimEnd().split('\n');
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

export function writeReport(
  report: BenchReport,
  parity: readonly ParityVerdict[],
  outDir: string,
  label: string,
): { jsonPath: string; markdownPath: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `report-${label}.json`);
  const markdownPath = join(outDir, 'latest.md');
  writeFileSync(jsonPath, `${JSON.stringify({ report, parity }, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(report, parity));
  return { jsonPath, markdownPath };
}

export function renderMarkdown(report: BenchReport, parity: readonly ParityVerdict[]): string {
  const lines: string[] = [];
  lines.push(`# L19 perf measurement — ${report.scenario}`);
  lines.push('');
  lines.push(`- steps run: **${report.steps}** (ok=${report.ok}, repetitions ${report.repetitions})`);
  lines.push(`- agents (worldfile \`MaxAgents\`): **${report.maxAgents ?? 'unknown'}**`);
  lines.push(`- parameters: \`${JSON.stringify(report.parameters)}\``);
  lines.push(
    `- wall: **${report.totalMs} ms**` +
      (report.bootMs === null ? '' : ` (boot ${report.bootMs} ms`) +
      (report.stepLoopMs === null ? (report.bootMs === null ? '' : ')') : `, step loop ${report.stepLoopMs} ms)`),
  );
  lines.push(
    `- per step: **${report.msPerStep ?? 'n/a'} ms**` +
      (report.msPerStepMedian === null
        ? ''
        : ` (best of ${report.repetitions}: median ${report.msPerStepMedian} ms, worst ${report.msPerStepMax} ms)`) +
      ` -> **${report.stepsPerSecond ?? 'n/a'} steps/s**`,
  );
  if (report.profileSummary !== null) {
    const p = report.profileSummary;
    lines.push(
      `- profile attribution: **${p.attributedPct} %** in real functions, ` +
        `${p.garbageCollectorPct} % GC, ${p.otherSyntheticPct} % \`(program)\`/\`(idle)\` ` +
        `(of ${p.totalMs} ms sampled)`,
    );
  }
  if (report.ratioToNative !== null) {
    const r = report.ratioToNative;
    lines.push(
      `- ratio to native (${r.agents} agents, PORT_PLAN.md): wall ${r.wallRatio}x` +
        (r.workRatio === null ? '' : `, work-only ${r.workRatio}x`),
    );
  }
  if (report.nativeMeasured !== null) {
    const m = report.nativeMeasured.measurement;
    lines.push(
      `- native, first-hand on this host: **${m.msPerStep} ms/step** at ${m.agents ?? 'unknown'} ` +
        `agents (${m.shortWallSec}s/${m.shortSteps} step vs ${m.longWallSec}s/${m.longSteps} steps) ` +
        `-> the port is **${report.nativeMeasured.ratio}x** (${report.nativeMeasured.source})`,
    );
  }
  if (report.candidateKernels !== null) {
    const c = report.candidateKernels;
    lines.push(
      `- the card's step-3 candidate kernels are **${c.totalPct} %** of the ` +
        `${report.hotFunctions.length} ranked functions' self time ` +
        `(RNG ${c.rngPct} %, libm ${c.libmPct} %, neural ${c.neuralPct} %)`,
    );
    if (c.excludedHelpers.length > 0) {
      lines.push(
        `- excluded from that share as formatting helpers (not kernels): ${c.excludedHelpers.join(', ')}`,
      );
    }
  }
  lines.push('');
  lines.push(`**Decision:** ${report.decision}`);
  if (report.notes.length > 0) {
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    for (const note of report.notes) lines.push(`- ${note}`);
  }
  if (report.error !== null) {
    lines.push('');
    lines.push('## Blocker reported by the run');
    lines.push('');
    lines.push('```');
    lines.push(report.error.trimEnd());
    lines.push('```');
  }
  if (report.hotFunctions.length > 0) {
    lines.push('');
    lines.push('## Hot functions (self time)');
    lines.push('');
    lines.push('| self ms | % | fn | where |');
    lines.push('|---:|---:|---|---|');
    for (const hot of report.hotFunctions) {
      lines.push(`| ${hot.selfMs} | ${hot.selfPct} | \`${hot.name}\` | ${hot.location} |`);
    }
  }
  for (const verdict of parity) {
    lines.push('');
    lines.push(`## Parity — ${verdict.scenario}`);
    lines.push('');
    lines.push(`- \`${verdict.command}\` -> exit ${verdict.exitCode}`);
    lines.push('');
    lines.push('```');
    lines.push(verdict.summary);
    lines.push('```');
  }
  lines.push('');
  return `${lines.join('\n')}`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
