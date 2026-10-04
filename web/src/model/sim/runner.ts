/**
 * Lane L11 (sim) — the node-side runner that writes a candidate `run/` tree for the parity harness
 * (`./oracle/run_parity.sh <scenario> --candidate <tree>`).
 *
 * What it does, in native's own order (the browser shell's boot does the same four artifacts):
 *
 *   original.wf / original.wfs   <- the recorded scenario's own copies of the worldfile + schema
 *   converted.wf / normalized.wf <- lane W1b's converter (before / after `apply()`)
 *   run/…                        <- `new Simulation( … )`, then `step()` until `End()`, then the
 *                                   destructor's `DR_SIMEND` kills
 *
 * Usage:
 *   npx tsx src/model/sim/runner.ts <scenario> <outDir> [--max-steps N] [--keep]
 *
 * `--max-steps` stops the loop early (it does **not** call `End`, so the artifacts are the ones a
 * run of that length would produce — useful for localizing a divergence to a step).
 *
 * PORT-NOTE(sim/runner-inputs): the runner boots from the *recorded* `run/original.wf`, not from the
 * native `worldfiles/tests/...` path, because `oracle/**` is the frozen input the harness compares
 * against and the recorded tree carries its own byte-exact copy. The scenario's CLI parameters
 * (`--Vision False`) are re-applied through lane W1b's parameter map, exactly as the native ctor
 * does, so `run/converted.wf` and `run/normalized.wf` are the port's own output, not copies.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assertUsableStagingRoot } from '../../oracle/guard';
import { Config } from '../types';
import { emitNormalizedWorldfile, type ExpressionEvaluator, type ParameterMap } from '../proplib';
import { monitorDocumentEvaluator } from '../monitor/monitorDocument';
import {
  MonitorManager,
  loadMonitorDocument,
  monitorDocumentPath,
  processEnvironment,
  type StatusTextStore,
} from '../monitor';
import { nodeRecordFileSystem } from '../logs/nodeFiles';
import { readAbstractFileBytes } from '../datalib/nodeFile';
import { ConcreteFileType } from '../types';
import { Simulation } from './simulation';
import {
  emptyCppProperties,
  monitorSimView,
  nullMovieWriter,
  nullSceneRenderer,
  unavailableFarmRunner,
} from './bindings';

/** Native `( worldfilePath, parameters )` as the runner passes them (the oracle's argv). */
export interface RunnerOptions {
  readonly scenario: string;
  readonly outDir: string;
  readonly maxSteps?: number;
  readonly parameters?: ParameterMap;
  /** The repo root (defaults to `process.cwd()`). */
  readonly repoRoot?: string;
  /**
   * Where the *document* the sim reads comes from:
   *
   *  - `'port-boot'` (default): the port boots the recorded `original.wf` itself. This is the
   *    end-to-end path and it needs lane L4's expression evaluator, because the *original*
   *    worldfile is full of expressions (`MaxAgents` is one) — until L4 lands, this mode stops with
   *    a lane-L4 error, which is the honest report.
   *  - `'recorded-normalized'`: the port reads the oracle's own `run/normalized.wf` (the document
   *    the native run actually used, post-`apply()`). It is a **diagnostic** mode: it exercises the
   *    init phases and the step loop against the recorded world, and it writes the run tree, but the
   *    `converted.wf`/`normalized.wf` in that tree are the recorded ones, so a parity check of those
   *    two artifacts is meaningless in this mode.
   */
  readonly documentFrom?: 'port-boot' | 'recorded-normalized';
  /**
   * The expression evaluator the document builder uses. Defaults to lane L14's
   * `monitorDocumentEvaluator`, which since lane L4 landed **is** the real language
   * (`interpreterEvaluator`, native's `python3`): the recorded worldfiles' expressions
   * (`InitAgents MaxAgents`, the barrier/duration arithmetic, the schema's defaults) all
   * evaluate. Kept as an option so a caller can drive the seam with a scripted evaluator.
   */
  readonly evaluator?: ExpressionEvaluator;
  /**
   * The native tree the **monitor documents** come from (`etc/monitors.mfs` + `etc/<ui>.mf`).
   * Native's cwd *is* that tree (`../polyworld`), the same layout `tests/monitor.test.ts` and the
   * native probes already read from; the runner defaults to `<repoRoot>/../polyworld`.
   */
  readonly nativeRoot?: string;
  /** Native `--ui` (default `'term'`, the recorded runs' value) — picks `./etc/<ui>.mf`. */
  readonly ui?: string;
}

export interface RunnerResult {
  readonly scenario: string;
  readonly outDir: string;
  readonly steps: number;
  readonly endReason: string | null;
  readonly ok: boolean;
  readonly error: string | null;
}

/** Native argv `--Key value` pairs -> proplib's `ParameterMap`. */
export function parameterMapFromArgs(args: readonly string[]): ParameterMap {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < args.length; i += 2) {
    const key = args[i]!;
    if (!key.startsWith('--')) continue;
    map.set(key.slice(2), args[i + 1]!);
  }
  return map;
}

/**
 * Lane L14's `StatusTextStore` as native implements it (`Monitor.cc:303-320`): `makeParentDir`
 * then `fopen( path, "w" )` and one `fprintf( "%s\n", line )` per line. Native's paths are
 * relative to the run's cwd (`run/stats/stat.<t>`); the runner resolves them against the run tree
 * it is writing, so a `process.chdir` in between cannot move them. The bytes are written as
 * latin-1 because the status text carries the `\xb1` byte of the `±` statistics.
 *
 * PORT-NOTE(sim/runner-status-store): the browser has no `fopen`, which is why lane L14 injects
 * the store at all (`statusTextMonitor.ts`, PORT-NOTE(monitor/status-text-file-write)); this is the
 * node implementation of that seam.
 */
export function nodeStatusTextStore(root: string): StatusTextStore {
  return {
    writeTextFile: (path, text) => {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, 'latin1');
    },
  };
}

/** One scenario of the *merged* registry (see PORT-NOTE(sim/runner-scenario-registry)). */
export interface ScenarioEntry {
  readonly name: string;
  /** The native-tree-relative worldfile the native run was invoked with (`worldfiles/hello.wf`). */
  readonly worldfile: string | null;
  readonly args: readonly string[];
  /** The registry document this entry came from (the overlay, when one shadows the base). */
  readonly source: string;
}

/** The shape both registry documents share (`oracle/scenarios/scenarios.json`, lane overlays). */
interface RegistryDocument {
  scenarios?: readonly { name?: string; worldfile?: string; args?: readonly string[] }[];
}

/**
 * PORT-NOTE(sim/runner-scenario-registry): the scenario registry is **two** documents, not one.
 * The read-only base is `oracle/scenarios/scenarios.json`; lanes register their own scenarios as
 * overlays in `tools/scenarios.d/*.json` (one file per scenario, so 10–20 lanes never edit one
 * JSON), and `tools/parity_common.py`'s `load_registry()` merges the overlays **over** the base,
 * in sorted-filename order, so a lane file may shadow a base scenario name. The runner read only
 * the base document until this note, which is wrong in both directions: it missed the
 * lane-registered scenarios (`hello`, `microtest_von` — `./oracle/run_parity.sh list` showed five
 * scenarios and the runner four, and `hello` — a registered Tier-A golden — could not be run at
 * all: `runner: scenario 'hello' is not in oracle/scenarios/scenarios.json`). This is the port's
 * transcription of that merge; the *recorder* is the authority for the file list, and both sides
 * now read the same two sources in the same order.
 *
 * NOTE the merge is name-keyed, last-writer-wins, exactly as `load_registry()` does it — a lane
 * overlay replaces the whole base entry rather than field-merging it.
 */
export function scenarioRegistry(repoRoot: string): Map<string, ScenarioEntry> {
  const sources = [join(repoRoot, 'oracle', 'scenarios', 'scenarios.json')];
  const overlayDir = join(repoRoot, 'tools', 'scenarios.d');
  if (existsSync(overlayDir)) {
    for (const name of readdirSync(overlayDir).sort()) {
      if (name.endsWith('.json')) sources.push(join(overlayDir, name));
    }
  }

  const merged = new Map<string, ScenarioEntry>();
  for (const source of sources) {
    if (!existsSync(source)) continue;
    let doc: RegistryDocument;
    try {
      doc = JSON.parse(readFileSync(source, 'utf8')) as RegistryDocument;
    } catch (thrown) {
      throw new Error(`runner: scenario registry ${source} is not valid JSON: ${String(thrown)}`);
    }
    for (const candidate of doc.scenarios ?? []) {
      if (!candidate.name) throw new Error(`runner: ${source} declares a scenario without a name`);
      merged.set(candidate.name, {
        name: candidate.name,
        worldfile: candidate.worldfile ?? null,
        args: candidate.args ?? [],
        source,
      });
    }
  }
  return merged;
}

/** The scenario's entry in the merged registry, or a loud error naming what *is* registered. */
export function scenarioEntry(repoRoot: string, scenario: string): ScenarioEntry {
  const registry = scenarioRegistry(repoRoot);
  const entry = registry.get(scenario);
  if (!entry) {
    const known = [...registry.keys()].sort().join(', ') || '(none)';
    throw new Error(
      `runner: scenario '${scenario}' is not in the merged scenario registry ` +
        `(oracle/scenarios/scenarios.json + tools/scenarios.d/*.json). Registered: ${known}`,
    );
  }
  return entry;
}

/**
 * PORT-NOTE(sim/runner-scenario-args): native is invoked with the scenario's own argv
 * (`--Vision False` for every recorded Tier-A scenario — the registry entry's `args`, which is
 * the same merged list `tools/parity_common.py` hands the recorder), and `TSimulation`'s ctor
 * applies those parameters *before* the worldfile's own values. The runner therefore defaults its
 * parameters to the registry's `args` (the caller can override with `RunnerOptions.parameters`):
 * booting the port without them turns vision back on and diverges in every artifact that depends
 * on `agent::config.vision` (`agent::UpdateVision`, the retina's per-step refresh, …). Measured
 * before this: `run/converted.wf` line 2 — golden `  Vision False`, candidate empty.
 */
export function scenarioParameters(repoRoot: string, scenario: string): ParameterMap {
  return parameterMapFromArgs(scenarioEntry(repoRoot, scenario).args);
}

/** Run one recorded scenario into `outDir`, writing the same tree the native binary writes. */
export function runScenario(options: RunnerOptions): RunnerResult {
  const repoRoot = options.repoRoot ?? process.cwd();
  const recorded = join(repoRoot, 'oracle', options.scenario, 'run');
  const outDir = assertUsableStagingRoot(resolve(options.outDir), `runScenario('${options.scenario}') outDir`);
  mkdirSync(join(outDir, 'run'), { recursive: true });

  const originalWorldfileText = readFileSync(join(recorded, 'original.wf'), 'utf8');
  const originalSchemaText = readFileSync(join(recorded, 'original.wfs'), 'utf8');
  const recordedNormalizedText = readFileSync(join(recorded, 'normalized.wf'), 'utf8');

  // The scenario's merged-registry entry, read **once**, so its `worldfile` and its `args` cannot
  // come from two different registry states.
  //
  // PORT-NOTE(sim/runner-scenario-worldfile): the worldfile path the run was booted with is *data*
  // — the entry's own `worldfile` field — not something derivable from the scenario name. Native's
  // argv is `Polyworld --ui term --Vision False worldfiles/hello.wf` (`oracle/hello/meta.json` →
  // `command`), recorded per scenario by `tools/record_oracle.py`. The runner used to rebuild it as
  // `worldfiles/tests/low-spec-pc/<name-before-first-underscore>.wf`, which is right for the two
  // `low-spec-pc` test worlds by coincidence (`microtest_voff` → `microtest.wf`, `minitest_voff` →
  // `minitest.wf`) and wrong for everything else — `hello`'s world is `worldfiles/hello.wf`, so
  // even with the registry fixed the boot would have read the wrong file. The derivation is gone;
  // a scenario whose entry has no `worldfile` is refused rather than guessed at.
  const entry = scenarioEntry(repoRoot, options.scenario);
  if (entry.worldfile === null) {
    throw new Error(`runner: scenario '${options.scenario}' has no \`worldfile\` in ${entry.source}`);
  }
  const worldfilePath = entry.worldfile;
  const schemaPath = './etc/worldfile.wfs';

  // The scenario's recorded argv, then any explicit override (see PORT-NOTE(sim/runner-scenario-args)).
  const params: ParameterMap = new Map([
    ...parameterMapFromArgs(entry.args),
    ...(options.parameters ?? new Map<string, string>()),
  ]);
  const documentFromPortBoot = (options.documentFrom ?? 'port-boot') === 'port-boot';

  // Native `main.cc:98-103` + `MonitorManager`'s own three document steps. `--ui term` is the
  // recorded runs' value (`oracle/<scenario>/meta.json`); the documents themselves are native's
  // `etc/`, which is the same tree the oracle's records came from.
  const ui = options.ui ?? 'term';
  const nativeRoot = resolve(options.nativeRoot ?? join(repoRoot, '..', 'polyworld'));
  const monitorSchemaPath = join(nativeRoot, 'etc', 'monitors.mfs');
  if (!existsSync(monitorSchemaPath)) {
    throw new Error(
      `runner: no monitor schema at ${monitorSchemaPath} — native's \`etc/monitors.mfs\` is what ` +
        `resolves \`StatusText\`/\`Scene\` defaults, and native's cwd is the native tree ` +
        `(pass \`nativeRoot\`)`,
    );
  }
  const monitorPath = monitorDocumentPath(ui, (path) => existsSync(join(nativeRoot, path)));
  // The schema path stays native's own relative `./etc/monitors.mfs`
  // (`monitorDocument.ts`'s default) — the reader below resolves every path against `nativeRoot`.
  const monitorDocument = loadMonitorDocument(
    (path) => readFileSync(join(nativeRoot, path), 'latin1'),
    monitorPath,
  );

  const built = emitNormalizedWorldfile(
    (path: string) => {
      if (path === worldfilePath) return documentFromPortBoot ? originalWorldfileText : recordedNormalizedText;
      if (path === schemaPath) return originalSchemaText;
      throw new Error(`runner: no source text for '${path}'`);
    },
    {
      worldfilePath,
      schemaPath,
      parameters: documentFromPortBoot ? params : new Map(),
      validate: false,
      evaluator: options.evaluator ?? monitorDocumentEvaluator,
    },
  );

  // The run tree is written relative to the process's directory (native uses relative paths).
  const previousCwd = process.cwd();
  process.chdir(outDir);

  let sim: Simulation | null = null;
  let steps = 0;
  let error: string | null = null;

  try {
    const doc = new Config(built.worldfileDocument);
    sim = new Simulation({
      doc,
      worldfilePath,
      schemaPath,
      convertedWorldfileText: built.converted,
      normalizedWorldfileText: built.normalized,
      originalWorldfileText,
      originalSchemaText,
      // Native `globals::recordFileType` (`Simulation.cc:4555`) — the `AbstractFile` backend every
      // `createFile` in the run picks per file. PORT-NOTE(sim/runner-record-file-type): the port's
      // `RecordFileSystem` binds the type at construction, so the runner resolves it from the same
      // document value native does; without it the compressed recorders write plain bytes and 75
      // files land uncompressed (measured: `run/brain/anatomy/**`, `run/brain/synapses/**`,
      // `run/genome/agents/*.txt(.gz)`).
      fs: nodeRecordFileSystem(
        doc.getBool('CompressFiles') ? ConcreteFileType.TYPE_GZIP_FILE : ConcreteFileType.TYPE_FILE,
      ),
      // Native `AbstractFile::open( path, "r" )` for lane L13's reads
      // (`run/brain/function/brainFunction_<n>.txt`) — the same auto-detecting open the run's own
      // recorders write through, i.e. `.gz` first. Without it a run with `CalcComplexity`/
      // `ComplexityFitnessWeight` set refuses at the first analysis instead of scoring zero.
      brainFunctionBytes: readAbstractFileBytes,
      keepRunDirectory: true,
    });

    // Native `main.cc:160` + `SimulationController.cc:26`:
    //
    //   MonitorManager *monitorManager = new MonitorManager( simulation, monitorPath );
    //   simulation->stepEnding += [=]{ monitorManager->step(); };
    //
    // i.e. the *app* constructs the manager and drives it off the simulation's `stepEnding` signal —
    // which is what writes `run/stats/stat.<timestep>` (native `Monitor.cc:299-320`) at step 21 of
    // `Step()`. Without this mount the signal fires into nothing and the artifact is missing.
    //
    // PORT-NOTE(sim/runner-monitor-mount): the renderer and movie writer are the graphics lanes'
    // (see PORT-NOTE(sim/null-scene-renderer)); `MonitorManager`'s scene *selection* still runs, and
    // `run/movie.pmv` — outside PORT_SPEC's frozen surface at every tier — is not produced.
    const monitor = new MonitorManager(monitorSimView(sim), monitorDocument, {
      createSceneRenderer: () => nullSceneRenderer(),
      createMovieWriter: () => nullMovieWriter(),
      statusTextStore: nodeStatusTextStore(outDir),
      cppProperties: emptyCppProperties,
      farmRunner: unavailableFarmRunner,
      farmEnvironment: processEnvironment,
    });
    sim.stepEnding = () => monitor.step();

    if (options.maxSteps === undefined) {
      // Native's driver (`SimulationController::execStep`) calls `Step()` until the simulation ends
      // itself, and `Step()`'s *first* act is the `fMaxSteps` check (`Simulation.cc:575-579`), which
      // calls `End( "MaxSteps" )` and returns **without** incrementing `fStep`. A run of N steps is
      // therefore N+1 calls; stopping at `getStepNumber() < N` leaves `End()` unrun and the tree
      // without `run/endReason.txt` / without the `DR_SIMEND` kills.
      const maxSteps = sim.getMaxSteps();
      const callLimit = maxSteps > 0 ? maxSteps + 2 : 10_000_000;
      for (let call = 0; !sim.fEnded && call < callLimit; call++) sim.step();
    } else {
      while (!sim.fEnded && sim.getStepNumber() < options.maxSteps) sim.step();
    }
    steps = sim.getStepNumber();

    // The destructor (`~TSimulation`) always runs: its `DR_SIMEND` kills are logged model events.
    sim.dispose();
  } catch (thrown) {
    error = thrown instanceof Error ? `${thrown.message}\n${thrown.stack ?? ''}` : String(thrown);
  } finally {
    process.chdir(previousCwd);
  }

  if (error !== null) {
    try {
      writeFileSync(join(outDir, 'PORT-RUN-ERROR.txt'), `${error}\n`);
    } catch {
      /* the tree may not exist if the failure was before mkdir */
    }
  }

  return { scenario: options.scenario, outDir, steps, endReason: null, ok: error === null, error };
}

// --- CLI ---------------------------------------------------------------------------------------

function main(argv: readonly string[]): void {
  const [scenario, outDir, ...rest] = argv;
  if (!scenario || !outDir) {
    console.error('usage: runner.ts <scenario> <outDir> [--max-steps N] [--arg Key value ...]');
    process.exit(2);
  }

  let maxSteps: number | undefined;
  const argPairs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--max-steps') {
      maxSteps = Number(rest[++i]);
    } else if (rest[i] === '--arg') {
      argPairs.push(`--${rest[++i]}`, rest[++i]!);
    }
  }

  const result = runScenario({
    scenario,
    outDir,
    ...(maxSteps === undefined ? {} : { maxSteps }),
    parameters: parameterMapFromArgs(argPairs),
    repoRoot: process.cwd(),
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('runner.ts')) {
  main(process.argv.slice(2));
}
