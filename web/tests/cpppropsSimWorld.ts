/**
 * Test harness for lane L11's cppprops work (`tests/cppprops-sim-engine*.test.ts`): boot one of
 * lane W1h's `dyn` fixture worldfiles through the port's own boot, drive the sim with the lane's
 * `UpdateContext` engine context, and read the same `[Title=value …]` line the native farm monitor
 * printed.
 *
 * Two rules this file exists to keep, both learned the hard way:
 *
 *  * **One `Simulation` per process.** The port's world state is module-level (`FoodType`'s
 *    registry, `Barrier.gBarriers`, the brain config, `gXSortedObjects`), so a second construction
 *    in one process is not the second sim a caller wants — `processWorldFile` throws on the
 *    duplicate `FoodType` name before anything else happens. Each test file therefore runs exactly
 *    one world, and the helpers here are shared instead.
 *  * **The recording is the arbiter.** Every expectation in these tests comes out of
 *    `tools/cppprops/fixtures/**` — the farm log (what `PropertyMetadata::toString()` printed),
 *    the state trace (`Simulation::getStatusText`'s own numbers) and `term.mf` (the monitor's
 *    property list, so the column names and their order are the recording's, not ours).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config, ConcreteFileType, GObjectType } from '../src/model/types';
import { emitNormalizedWorldfile } from '../src/model/proplib';
import { AgentStatics } from '../src/model/agent/agentConfig';
import { monitorDocumentEvaluator } from '../src/model/monitor/monitorDocument';
import { nodeRecordFileSystem } from '../src/model/logs/nodeFiles';
import { Simulation, type DynamicPropertySet } from '../src/model/sim/simulation';
import { createCppProperties, type SimCppProperties } from '../src/model/sim/cppProperties';
import { parameterMapFromArgs } from '../src/model/sim/runner';

export const REPO = fileURLToPath(new URL('..', import.meta.url));
export const TOOLS = join(REPO, 'tools', 'cppprops');
export const FIXTURES = join(TOOLS, 'fixtures');
export const NATIVE_ROOT = resolve(process.env['POLYWORLD_NATIVE'] ?? join(REPO, '..', 'polyworld'));
export const SCHEMA_PATH = './etc/worldfile.wfs';
export const NATIVE_SCHEMA = join(NATIVE_ROOT, 'etc', 'worldfile.wfs');
export const PYTHON = process.env['PYTHON'] ?? 'python3';
export const haveNativeTree = existsSync(NATIVE_SCHEMA);

/** `fixtures/state/<scenario>.state.json`'s per-step record. */
export interface StateRecord {
  readonly step: number;
  readonly agents: number;
  readonly food: number;
  readonly foodPatches?: Record<string, { agentInsideCount: number }>;
}

export function recordedState(scenario: string): StateRecord[] {
  const state = JSON.parse(
    readFileSync(join(FIXTURES, 'state', `${scenario}.state.json`), 'utf8'),
  ) as { steps: StateRecord[] };
  return state.steps;
}

export function recordedFarmLines(scenario: string): string[] {
  return readFileSync(join(FIXTURES, 'native', `${scenario}.farm.log`), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/** The farm monitor's sampled properties, in the recording's own order (`term.mf`). */
export function farmColumns(): { name: string; title: string }[] {
  const term = readFileSync(join(FIXTURES, 'harness', 'term.mf'), 'utf8');
  const columns: { name: string; title: string }[] = [];
  for (const match of term.matchAll(/\{\s*Name\s+"([^"]+)"\s*;\s*Title\s+"([^"]+)"/g)) {
    columns.push({ name: match[1] as string, title: match[2] as string });
  }
  if (columns.length === 0) throw new Error('term.mf carried no Farm Properties');
  return columns;
}

/**
 * The build-time spec for a fixture worldfile, cross-checked against the *recorded* generated C++:
 * a spec that is not the native text fails here rather than producing plausible numbers.
 */
export function extractSpec(scenario: string, workdir: string): Record<string, unknown> {
  const specPath = join(workdir, `${scenario}.spec.json`);
  execFileSync(
    PYTHON,
    [
      join(TOOLS, 'extract_cppprops.py'),
      '--worldfile',
      join(FIXTURES, 'worldfiles', `${scenario}.wf`),
      '--schema',
      NATIVE_SCHEMA,
      '--out',
      specPath,
      '--crosscheck',
      join(FIXTURES, 'native', `${scenario}.generated.cc`),
    ],
    { stdio: 'pipe' },
  );
  return JSON.parse(readFileSync(specPath, 'utf8')) as Record<string, unknown>;
}

/** `runScenario`'s boot, for a cppprops fixture worldfile instead of an oracle scenario. */
export function newSim(
  scenario: string,
  properties: DynamicPropertySet | undefined,
  args: readonly string[] = ['--Vision', 'False'],
): Simulation {
  const worldfilePath = join(FIXTURES, 'worldfiles', `${scenario}.wf`);
  const worldfileText = readFileSync(worldfilePath, 'utf8');
  const schemaText = readFileSync(NATIVE_SCHEMA, 'utf8');

  const built = emitNormalizedWorldfile(
    (path: string) => {
      if (path === worldfilePath) return worldfileText;
      if (path === SCHEMA_PATH) return schemaText;
      throw new Error(`cppprops-sim: no source text for '${path}'`);
    },
    {
      worldfilePath,
      schemaPath: SCHEMA_PATH,
      parameters: parameterMapFromArgs([...args]),
      validate: false,
      evaluator: monitorDocumentEvaluator,
    },
  );

  const doc = new Config(built.worldfileDocument);
  return new Simulation({
    doc,
    worldfilePath,
    schemaPath: SCHEMA_PATH,
    convertedWorldfileText: built.converted,
    normalizedWorldfileText: built.normalized,
    originalWorldfileText: worldfileText,
    originalSchemaText: schemaText,
    fs: nodeRecordFileSystem(
      doc.getBool('CompressFiles') ? ConcreteFileType.TYPE_GZIP_FILE : ConcreteFileType.TYPE_FILE,
    ),
    keepRunDirectory: true,
    ...(properties === undefined ? {} : { dynamicProperties: properties }),
  });
}

/** The farm monitor's own line for one instant: sampled titles, in `term.mf` order. */
export function farmLine(properties: SimCppProperties): string {
  const table = new Map(properties.getMetadata().map((entry) => [entry.name, entry.toString()]));
  return `[${farmColumns()
    .filter((column) => table.has(column.name))
    .map((column) => `${column.title}=${table.get(column.name)}`)
    .join(' ')}]`;
}

/** `[Title=value …]` -> `{ Title: value }`. */
export function parseFarmLine(line: string): Map<string, string> {
  return new Map(
    line
      .replace(/^\[|\]$/g, '')
      .split(' ')
      .map((entry) => entry.split('=') as [string, string]),
  );
}

export interface WorldSnapshot {
  readonly step: number;
  readonly agents: number;
  readonly food: number;
  readonly alive0: number;
  readonly properties: readonly { name: string; type: number; value: string }[];
}

/**
 * The sim's own per-step counters — `Simulation::getStatusText`'s numbers (`Simulation.cc`), i.e.
 * the ones a native run prints per step and the ones that say *which* event moved a population.
 * A one-agent farm-log drift is a birth or a death landing a step off, and this is where the two
 * can be told apart without a run-tree recording.
 */
export interface StepCounters {
  readonly step: number;
  readonly agents: number;
  readonly food: number;
  readonly alive0: number;
  readonly created: number;
  readonly born: number;
  /** Cumulative `fNumberDied*`, in `getStatusText`'s order. */
  readonly died: number;
  readonly diedAge: number;
  readonly diedEnergy: number;
  readonly diedFight: number;
  readonly diedEat: number;
  readonly diedEdge: number;
  readonly diedSmite: number;
  readonly diedPatch: number;
}

export interface WorldRun {
  readonly lines: string[];
  readonly recorded: string[];
  /** The recorded state trace's per-step `foodPatches` counts, as the ring's read point sees them. */
  readonly readPointCounts: number[][];
  readonly readPointStep: number[];
  readonly onPattern: string[];
  readonly patchDeaths: number;
  /** The sim's own counters after each step (`StepCounters`) — the event-level trace. */
  readonly perStep: readonly StepCounters[];
  readonly unresolvedStorage: readonly string[];
  /** `<port line>\n  native: <recorded line>` of the first differing step, or null. */
  readonly firstDivergence: string | null;
  readonly divergenceCount: number;
  readonly divergentColumns: Map<string, number>;
  /** `getMetadata()` + the sim's own counters, at three points inside the one run. */
  readonly snapshots: { ctor: WorldSnapshot; step1: WorldSnapshot; step7: WorldSnapshot };
  /** The run tree's root — `<outDir>/run`, the one root the whole run writes under. */
  readonly runDir: string;
  /** Native `agent::agentsEver` at the end of the run: how many agents ever lived (1-based). */
  readonly agentsEver: number;
}

export interface RunOptions {
  /** Stop after N steps (the recordings are 300/301 steps long). */
  readonly steps?: number;
  /**
   * Zero every `FoodPatch::agentInsideCount` at the top of each step — the state a caller with no
   * engine context is in (`run_cppprops.mjs` without `--engine` reads 0 for every patch). The sim
   * accumulates the counts *during* a step, so this is exactly "every patch reads 0 at the ring's
   * read point".
   */
  readonly zeroPatchCounts?: boolean;
  /**
   * The worldfile parameters the boot applies, as native's argv (`--Key value …`). Defaults to
   * `['--Vision', 'False']` — the recorded fixtures' own args. Recording flags
   * (`--RecordEnergy True`, `--RecordPosition Precise`, …) go here: they change which artifacts the
   * run writes, never its dynamics.
   */
  readonly args?: readonly string[];
  /**
   * Called right after each `sim.step()`, with the live sim — the seam a probe needs to read the
   * model's own state (an agent's energy, position, the death counters) at the step it belongs to.
   */
  readonly onStep?: (sim: Simulation, step: number) => void;
}

/**
 * Run one fixture world through the sim, one `dynamicProperties` set, and compare its farm lines
 * to the recording.
 *
 * The run tree is rooted at `<outDir>/run` — one root for the whole run, like native's (whose cwd
 * never moves). The sim opens its `run/**` files relative to the *current* cwd, and not all of them
 * at the same moment: the `init`-time recorders (`BirthsDeaths.log`, `lifespans.txt`,
 * `population.txt`, `max.txt`) open while the `Simulation` is constructed, every per-agent file
 * opens later, during the run. A harness that chdirs between the two gets **two** trees — and that
 * is exactly what this one did until the L12/L8 follow-up card made it visible: with `cwd = the
 * repo` at construction and `cwd = outDir` while stepping, the 180 seeded agents' files landed in
 * the repo and the 312 born agents' files in `outDir/run`, so a measurement of the repo tree read
 * as "the per-agent recorders skip agents born during a run" (measured 2026-09-28 on `growers_dyn`:
 * 181 `run/energy/agents/*` in the repo + 314 of them in the harness's temp dir = native's 492
 * agents + `max.txt`). The fix is to chdir **before** constructing, so every relative path in the
 * run resolves against the same root.
 *
 * The run also ends the way native's does, because the recorded artifacts depend on it (see the
 * end-phase note in the body). The caller's cwd is restored before returning.
 */
export function runWorld(scenario: string, options: RunOptions = {}): WorldRun {
  const outDir = mkdtempSync(join(tmpdir(), 'cppprops-sim-'));
  mkdirSync(outDir, { recursive: true });
  const previous = process.cwd();
  const runDir = join(outDir, 'run');
  mkdirSync(runDir, { recursive: true });

  const lines: string[] = [];
  const onPattern: string[] = [];
  const readPointCounts: number[][] = [];
  const readPointStep: number[] = [];
  const perStep: StepCounters[] = [];
  let patchDeaths = 0;

  const snapshot = (sim: Simulation, properties: SimCppProperties): WorldSnapshot => ({
    step: sim.fStep,
    agents: sim.objects().getCount(GObjectType.AGENT),
    food: sim.objects().getCount(GObjectType.FOOD),
    alive0: sim.fNumberAliveWithMetabolism[0] ?? 0,
    properties: properties
      .getMetadata()
      .map((entry) => ({ name: entry.name, type: entry.type, value: entry.toString() })),
  });

  try {
    const properties = createCppProperties({ spec: extractSpec(scenario, outDir) });
    // The cwd must be the run root *before* the sim is constructed: `newSim` is where the
    // `init`-time recorders open their files (see the doc comment above).
    process.chdir(outDir);
    const sim = newSim(scenario, properties, options.args);
    const atCtor = snapshot(sim, properties);
    let step1: WorldSnapshot | null = null;
    let step7: WorldSnapshot | null = null;

    const recorded = recordedFarmLines(scenario);
    const steps = Math.min(options.steps ?? recorded.length, recorded.length);
    // Native's driver (`SimulationController::execStep`) calls `Step()` until the simulation ends
    // itself, and `Step()`'s *first* act is the `fMaxSteps` check, which calls `End( "MaxSteps" )`
    // and returns **without** incrementing `fStep`: a run of N recorded steps is N+1 calls. The
    // extra call is made after the loop below, and only when the budget really reached the
    // worldfile's `MaxSteps` (a caller that asked for fewer steps gets no `End`).
    const maxSteps = sim.getMaxSteps();

    for (let call = 0; call < steps && !sim.fEnded; call++) {
      if (options.zeroPatchCounts) {
        for (const patch of sim.fDomains[0]!.foodPatches) patch.agentInsideCount = 0;
      }
      // The ring reads its input at the start of the step (`CppProperties::update()`), i.e. before
      // this step touches anything — capture exactly what it will see.
      readPointCounts.push(sim.fDomains[0]!.foodPatches.map((patch) => patch.agentInsideCount));
      readPointStep.push(sim.fStep + 1);

      sim.step();
      // `Step()`'s first act is the `fMaxSteps` check, in which case it calls `End( "MaxSteps" )`
      // and returns **without** stepping: such a call is not a recorded step (native's farm monitor
      // never sees one either).
      if (sim.fEnded) break;
      options.onStep?.(sim, sim.fStep);
      lines.push(farmLine(properties));
      perStep.push({
        step: sim.fStep,
        agents: sim.objects().getCount(GObjectType.AGENT),
        food: sim.objects().getCount(GObjectType.FOOD),
        alive0: sim.fNumberAliveWithMetabolism[0] ?? 0,
        created: sim.fNumberCreated,
        born: sim.fNumberBorn,
        died: sim.fNumberDied,
        diedAge: sim.fNumberDiedAge,
        diedEnergy: sim.fNumberDiedEnergy,
        diedFight: sim.fNumberDiedFight,
        diedEat: sim.fNumberDiedEat,
        diedEdge: sim.fNumberDiedEdge,
        diedSmite: sim.fNumberDiedSmite,
        diedPatch: sim.fNumberDiedPatch,
      });
      onPattern.push(sim.fDomains[0]!.foodPatches.map((patch) => (patch.isOn() ? '1' : '0')).join(''));
      patchDeaths = sim.fNumberDiedPatch;
      if (sim.fStep === 1) step1 = snapshot(sim, properties);
      if (sim.fStep === 7) step7 = snapshot(sim, properties);
    }

    if (step1 === null || step7 === null) {
      throw new Error(`cppprops-sim: the run did not reach step 7 (got ${lines.length} steps)`);
    }

    // --- native's end phase -------------------------------------------------
    //
    // Every recorded artifact depends on this. Native's run ends at `MaxSteps` — `End( "MaxSteps" )`
    // posts the `SimEnd` event, which closes the still-open per-agent function files — and the
    // process then tears the `TSimulation` down (`~TSimulation`): the survivors are killed with
    // `DR_SIMEND` (logged events: 281 `SIMEND` rows in this world's `lifespans.txt`), and `delete
    // logs` runs every recorder's destructor, which is what `fclose`s the buffered sinks.
    //
    // Measured on `growers_dyn` without it (task t_1263719e): `run/BirthsDeaths.log` 0 bytes (native
    // 9,636), 121 of the 181 seeded agents' `run/energy/agents/agent_*.txt` 0 bytes (their buffered
    // rows never reached the descriptor) and the 281 survivors' `AbstractFile` dumps missing
    // entirely — `run/brain/function/incomplete_brainFunction_<n>.txt.gz` is written by the
    // deferred-gzip sink at `close()`, and nothing closed it.
    if (!sim.fEnded && maxSteps > 0 && sim.getStepNumber() >= maxSteps) sim.step();
    const agentsEver = AgentStatics.agentsEver;
    sim.dispose();

    const divergentColumns = new Map<string, number>();
    let firstDivergence: string | null = null;
    let divergenceCount = 0;
    for (let step = 0; step < lines.length; step++) {
      const got = parseFarmLine(lines[step] as string);
      const want = parseFarmLine(recorded[step] as string);
      if (lines[step] === recorded[step]) continue;
      divergenceCount++;
      for (const [title, value] of want) {
        if (got.get(title) !== value) {
          divergentColumns.set(title, (divergentColumns.get(title) ?? 0) + 1);
        }
      }
      if (firstDivergence === null) {
        firstDivergence = `${lines[step]}\n  native: ${recorded[step]}`;
      }
    }

    return {
      lines,
      recorded,
      readPointCounts,
      readPointStep,
      onPattern,
      patchDeaths,
      perStep,
      unresolvedStorage: properties.unresolvedStorage,
      firstDivergence,
      divergenceCount,
      divergentColumns,
      snapshots: { ctor: atCtor, step1, step7 },
      runDir,
      agentsEver,
    };
  } finally {
    process.chdir(previous);
  }
}
