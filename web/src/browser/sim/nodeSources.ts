/**
 * Lane L18 (browser wiring) — the node-side half of the boot: read the recorded sources off
 * disk, drive the model world, and write the run tree back out.
 *
 * Imported by this lane's tests (and by anything running under node). It is deliberately
 * **not** reachable from `main.ts`: `node:fs` must stay out of the browser bundle, exactly
 * like lane W1c's `nodeFile.ts` sink (`src/model/datalib/index.ts` does not re-export it).
 *
 * PORT-NOTE (L18/candidate-tree): `writeCandidateTree` is the browser lane's equivalent of
 * what a native run does to `run/` — it writes the boot's four artifacts and then everything
 * the run itself produced (`world.runFileSystem()`, the page's in-memory sink), under their
 * run-tree paths, so `./oracle/run_parity.sh <scenario> --candidate <dir>` can compare them
 * with the golden. The bytes come from the *same* code the page runs: nothing is re-derived for
 * the harness.
 *
 * PORT-NOTE (L18/one-run-per-process): a run tree can only be written by constructing the world
 * **once** in a process — the model's `FoodType` table and RNG surfaces are process-wide (as
 * native's are), so a second `TSimulation` in the same process fails loudly
 * (`sim: duplicate FoodType name 'Standard'`). That is why the lane's two tree-writing tests are
 * two files: vitest isolates test files in separate workers, which is what a run needs.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createModelWorld } from './modelWorld';
import { bootWorld, type BootedWorld, type WorldSources } from './worldBoot';
import { scenarioByName, type Scenario, type ScenarioName } from './scenarios';
import { assertNotGoldenWrite, assertUsableCandidateRoot, assertUsableStagingRoot } from '../../oracle/guard';
// `candidateRoot` is used here (the default root of `runModelIntoTree`) and re-exported below.
import { candidateRoot, writeCandidateProvenance } from './candidateRoots';

/** Repo root, from this file's location (`src/browser/sim/`). */
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Where the goldens live; `POLYWORLD_ORACLE_ROOT` overrides (git-worktree lanes). */
export function oracleRoot(): string {
  return process.env.POLYWORLD_ORACLE_ROOT ?? path.join(REPO_ROOT, 'oracle');
}

/**
 * The scenario's sources as the native run recorded them: `run/original.wf` (a byte copy of
 * the worldfile it ran) and `run/original.wfs` (the schema — `Simulation.cc:450-451`).
 */
export function oracleSources(scenario: Scenario | ScenarioName): WorldSources {
  const resolved = typeof scenario === 'string' ? scenarioByName(scenario) : scenario;
  const run = path.join(oracleRoot(), resolved.name, 'run');
  return {
    scenario: resolved,
    worldfilePath: resolved.worldfilePath,
    schemaPath: resolved.schemaPath,
    worldfileText: readFileSync(path.join(run, 'original.wf'), 'utf8'),
    schemaText: readFileSync(path.join(run, 'original.wfs'), 'utf8'),
  };
}

/** The bundled copies (`src/browser/worldfiles/**`) — the same bytes, for the drift test. */
export function bundledSourceTexts(scenario: Scenario): { worldfile: string; schema: string } {
  const dir = path.join(REPO_ROOT, 'src', 'browser', 'worldfiles');
  // The bundled copy is named after the native worldfile's own basename (`worldfiles/hello.wf` →
  // `hello.wf`), which is the one name `bundledWorlds.ts`'s `?raw` imports use.
  const worldfile = path.basename(scenario.worldfilePath);
  return {
    worldfile: readFileSync(path.join(dir, worldfile), 'utf8'),
    schema: readFileSync(path.join(dir, 'worldfile.wfs'), 'utf8'),
  };
}

/**
 * The lane's candidate root and its lifecycle live in `./candidateRoots` (t_1ce9957f): it imports
 * `node:*` and `src/oracle/*` only, so a plain TS runtime can load it, while this file pulls the
 * boot chain. Re-exported here because this is where callers have always imported `candidateRoot`
 * from (and `writeCandidateTree` below writes the keyed tree's `PROVENANCE.txt`).
 */
export * from './candidateRoots';

/** Anything that can hand back the files a run wrote (`MemoryRecordFileSystem`, tests). */
export interface RunFileSource {
  paths(): readonly string[];
  bytes(path: string): Uint8Array | undefined;
}

/**
 * Write the candidate run tree the parity harness reads: the boot's artifacts first (text), then
 * what the run itself wrote (bytes) — for the four `*.wf` files that is the same content twice,
 * which is what makes "the boot and the run agree" visible in the tree instead of assumed.
 */
export function writeCandidateTree(
  root: string,
  scenario: ScenarioName,
  artifacts: ReadonlyMap<string, string>,
  run?: RunFileSource,
): string {
  const dir = path.join(root, scenario);
  // t_37bf7212: a candidate tree is written file-by-file into `<root>/<scenario>/run/**`, so a
  // root that resolves into the frozen oracle would rebuild the golden in place. Refuse loudly
  // before the first byte; both the root and every individual target are checked.
  assertUsableCandidateRoot(root, `writeCandidateTree(${scenario}) root`);
  assertUsableStagingRoot(dir, `writeCandidateTree(${scenario}) tree`);
  for (const [relative, text] of artifacts) {
    const target = path.join(dir, relative);
    assertNotGoldenWrite(target, `writeCandidateTree(${scenario})`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  if (run !== undefined) {
    for (const relative of run.paths()) {
      const bytes = run.bytes(relative);
      if (bytes === undefined) continue;
      const target = path.join(dir, relative);
      assertNotGoldenWrite(target, `writeCandidateTree(${scenario})`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
  }
  // t_1ce9957f: the default root is keyed per process, so the tree names its own path — a human
  // following PARITY.md's `--candidate <root>/<scenario>` recipe must be able to find it. The
  // manifest sits beside `run/`, never inside it: the harness compares `run/**` byte-for-byte.
  // A caller-pinned root is written verbatim, with nothing beside its `run/`.
  writeCandidateProvenance(dir, scenario, root);
  return dir;
}

/** What one browser-lane run produced, for the test to assert and the card to quote. */
export interface RunTreeReport {
  readonly scenario: ScenarioName;
  readonly boot: BootedWorld;
  readonly dir: string;
  readonly steps: number;
  readonly ended: boolean;
  readonly runFiles: readonly string[];
  readonly notice: string | null;
  readonly seed: number;
}

/** Every file the recorded golden run tree holds, as `run/…` paths (`[]` without a golden). */
export function goldenRunFiles(scenario: ScenarioName): readonly string[] {
  const run = path.join(oracleRoot(), scenario, 'run');
  if (!existsSync(run)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${next}/`);
      else out.push(`run/${next}`);
    }
  };
  walk(run, '');
  return out.sort();
}

/**
 * The golden files a browser run *cannot* produce, and why.
 *
 * `run/manifest.sha256` is the harness's own listing of the golden, not an artifact of any run.
 * `run/movie.pmv` is the Tier-C movie: `PORT_SPEC` declares it free and the harness reports it as
 * `IGNORED` at every tier, because the unpinned sampling path means two native runs of the same
 * scenario can already disagree (`PORT-NOTE(parity-runner/movie-is-free)`, t_588c28e1) — the page
 * mounts the same null movie writer lane L11's node runner does
 * (PORT-NOTE(sim/null-scene-renderer)), so it produces none.
 *
 * Everything else in the golden tree is now written, `run/stats/**` included: the page mounts lane
 * L14's `MonitorManager` off `stepEnding` exactly as native's app does (PORT-NOTE
 * (L18/monitors-in-the-page)). This list is the *whole* honest gap, so a newly-lost artifact cannot
 * hide inside a count — `runTreeSuite.ts` compares it file by file.
 */
export const NOT_WRITTEN_BY_THE_PAGE: readonly string[] = [
  'run/manifest.sha256',
  'run/movie.pmv',
];

/** Is `path` (a `run/…` path) one of the files the page is known not to write? */
export function isPageExcluded(path: string): boolean {
  return NOT_WRITTEN_BY_THE_PAGE.includes(path);
}

/**
 * Boot, step and dump one scenario through the browser's own factory and sink, and write the
 * result where `./oracle/run_parity.sh <scenario> --candidate <dir>` looks.
 *
 * Call this **once per process** (PORT-NOTE (L18/one-run-per-process) in this file's header).
 */
export function runModelIntoTree(
  scenario: ScenarioName | Scenario,
  root: string = candidateRoot(),
  stepSeconds = 1 / 30,
): RunTreeReport {
  const resolved = typeof scenario === 'string' ? scenarioByName(scenario) : scenario;
  const booted = bootWorld(oracleSources(resolved));
  const world = createModelWorld({ boot: booted, stepSeconds });

  // Native's driver (`SimulationController::execStep`) calls `Step()` until the simulation ends
  // itself; `Step()`'s first act is the `fMaxSteps` check, which ends the run *without*
  // incrementing `fStep`, so a budget of N steps costs N+1 calls (L11's runner note).
  let calls = 0;
  const limit = world.maxSteps > 0 ? world.maxSteps + 4 : 1_000_000;
  while (!world.ended && calls < limit) {
    world.step();
    calls++;
  }

  // Native's destructor is part of a run: its `DR_SIMEND` kills are the last rows of
  // `lifespans.txt`, and it writes `run/endStep.txt`.
  world.dispose();

  const fs = world.runFileSystem;
  if (fs === null) throw new Error('runModelIntoTree: the world has no run file system');
  const dir = writeCandidateTree(root, resolved.name, booted.artifacts, fs);

  return {
    scenario: resolved.name,
    boot: booted,
    dir,
    steps: world.stepIndex,
    ended: world.ended,
    runFiles: fs.paths(),
    notice: world.notice,
    seed: world.seed,
  };
}
