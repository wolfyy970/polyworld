/**
 * Lane L12 (logs) — the golden replay corpus.
 *
 * `replayCorpus( scenario )` reconstructs the recorded run's event stream from the golden
 * artifacts themselves (see `logsReplay.ts` for the rules and why each one is derivable) and
 * drives the *real* recorders (`new Logs(...)`, `logs.postEvent(...)`, `logs.dispose()`) with
 * it, writing a candidate `run/` tree.
 *
 * What that proves: given the same values, the recorders emit the same bytes — paths, table
 * names, column names/types/formats, header variants, per-agent file lifecycle, row order,
 * gzip framing and the `step 0` rows the `SimInited` handlers write. What it does **not**
 * prove: that the values are right (that is lane L11/L8/L10's contract) or that the brain and
 * genome *contents* are right (L6/L5's). Those files are excluded from the byte comparison and
 * covered structurally instead (`tests/logs.test.ts`).
 */

import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { BirthReason, DeathReason, globals, Event_AgentBirth, Event_AgentDeath, Event_AgentGrown, Event_BodyUpdated, Event_Carry, Event_Collision, Event_ContactEnd, Event_Energy, Event_SimEnd, Event_SimInited, Event_StepEnd, EnergyAction, GObjectType, type AgentContactEndInfo, type AgentBirthEvent, type SimEvent } from '../src/model/types';
import { Logs } from '../src/model/logs';
import { installLogsStagingCleanup } from '../src/oracle/logsStaging';
import { separationCache } from '../src/model/genome';
import { ConcreteFileType } from '../src/model/types/datalib';
import { nodeRecordFileSystem } from '../src/model/logs/nodeFiles';
import { rmSync } from 'node:fs';
import { resetRegistry } from '../src/model/logs/registry';
import type { LogContext } from '../src/model/logs/seams';
import {
  FakeAgent,
  FakeGeneSchema,
  RecordedSeparations,
  FakeFittestList,
  FakeFood,
  FakeFoodTypes,
  FakeGeneStats,
  FakeGenomeUtil,
  FakeObject,
  FakeSimulation,
  FakeWorld,
  Golden,
  agentEnergyRows,
  agentPositionRows,
  carryActionIndex,
  carryObjectTypeBit,
  deriveFlags,
  flagsToConfig,
  foodEnergyRows,
  foodTypeNames,
  freshDir,
  genestatsRows,
  goldenCarryRows,
  goldenCollisionRows,
  goldenConsumptionRows,
  goldenContactRows,
  goldenEnergyEvents,
  goldenRows,
  readLifespans,
  separationsTables,
  type ScenarioFlags,
} from './logsReplay';

/**
 * The default logs staging root: **one directory per worker process** (t_37bf7212 review).
 *
 * It used to be one fixed path — `<cwd>/oracle/_t_logs_candidates` — shared by every vitest
 * process on the checkout, and `freshDir` wipes a scenario's tree (`rmSync(recursive)` + mkdir)
 * while the recorders write as they go. Two lanes verifying in parallel therefore wiped and
 * rebuilt each other's trees: `ENOTEMPTY … rmdir '<root>/microtest_voff/run/brain'` raised inside
 * `freshDir`, `EEXIST` on the hard link a brain recorder makes, `ENOENT` on its rename, and a
 * wrong artifact count (`expected 61 to be 62`) — the false-red class this card exists to remove,
 * in the two files it names. Nothing outside this module reads the default path, so keying it by
 * pid isolates parallel runs without changing a caller; the vitest worker thread is appended too,
 * so a `pool: 'threads'` run (all workers in one pid) is isolated as well.
 *
 * Still under `oracle/_t_*` — the prefix `.gitignore` reserves and the guard allows — so a failed
 * replay's tree is inspectable and, if it is ever installed at all, it is installed by a
 * stage → verify → move rather than built over a golden. `POLYWORLD_LOGS_CANDIDATE_ROOT` still
 * pins the root for a caller that wants a known path (PARITY.md).
 *
 * **The root does not leak (t_2821ab7f).** Keying the root by pid isolated parallel runs but left
 * every tree behind: measured 57 dirs / 274 MB in 17 minutes of fleet testing, nothing ever
 * removing them. `installLogsStagingCleanup` (see `src/oracle/logsStaging.ts`) is wired below, so
 * the process removes its own `pid-*` dirs on exit and reaps the dead pids' dirs once — skipping a
 * live pid, a non-`pid-*` entry, and a pinned root. `POLYWORLD_KEEP_LOGS_CANDIDATES=1` keeps the
 * tree of a failed replay for inspection.
 */
export function defaultLogsCandidateRoot(cwd: string, pid: number, thread: number): string {
  return path.join(cwd, 'oracle', '_t_logs_candidates', thread === 0 ? `pid-${pid}` : `pid-${pid}-t${thread}`);
}

/** Where the corpus writes its candidate trees (the harness reads the same paths). */
export const CANDIDATE_ROOT =
  process.env.POLYWORLD_LOGS_CANDIDATE_ROOT ?? defaultLogsCandidateRoot(process.cwd(), process.pid, threadId);

/** The root the per-process dirs live in — the one tree the exit cleanup owns (t_2821ab7f). */
export const LOGS_CANDIDATE_ROOT_BASE = path.dirname(CANDIDATE_ROOT);

/**
 * The exit-path cleanup, installed as this module is imported (**at most once per process**).
 *
 * `pinned` mirrors the `CANDIDATE_ROOT` pin above: a caller-chosen root is the caller's to manage.
 * `keep` is the debug override for a failed replay. Nothing here runs before exit, so the tests'
 * verdicts are the same with the overrides unset — only the disk is smaller afterwards.
 */
export const LOGS_STAGING_CLEANUP = installLogsStagingCleanup({
  dir: CANDIDATE_ROOT,
  root: LOGS_CANDIDATE_ROOT_BASE,
  pinned: process.env.POLYWORLD_LOGS_CANDIDATE_ROOT !== undefined,
  keep: process.env.POLYWORLD_KEEP_LOGS_CANDIDATES === '1',
});

/** The golden `run/` tree of a scenario in this repo. */
export function goldenRunRoot(scenario: string): string {
  const oracleRoot = process.env.POLYWORLD_ORACLE_ROOT ?? path.join(process.cwd(), 'oracle');
  return path.join(oracleRoot, scenario, 'run');
}

/** The artifacts whose *content* lane L12 decides — the corpus compares these byte-for-byte. */
export function l12Artifacts(golden: Golden): string[] {
  return golden
    .files()
    .filter((rel) => {
      if (rel.startsWith('brain/')) return false;
      if (rel.startsWith('genome/agents/')) return false;
      if (rel.startsWith('genome/meta/')) return false;
      if (rel.startsWith('stats/')) return false;
      if (rel === 'movie.pmv' || rel === 'manifest.sha256') return false;
      if (rel === 'normalized.wf' || rel === 'converted.wf') return false;
      if (rel === 'original.wf' || rel === 'original.wfs') return false;
      if (rel === 'endReason.txt' || rel === 'endStep.txt') return false;
      if (rel === 'gitrevision.txt') return false;
      return true;
    })
    .sort();
}

/** The byte-exact subset actually produced by the replay (everything `l12Artifacts` names). */
export interface CorpusResult {
  scenario: string;
  golden: Golden;
  /** `<dir>/run` — the tree `oracle/run_parity.sh --candidate <dir>` reads. */
  runDir: string;
  /** Relative paths written by the replay, sorted. */
  produced: string[];
  flags: ScenarioFlags;
  sim: FakeSimulation;
}

/** Results are deterministic; a test file that wants the same tree twice gets the same run. */
const corpusCache = new Map<string, CorpusResult>();

/**
 * Replay a recorded scenario through the recorders. Writes `<CANDIDATE_ROOT>/<scenario>/run/**`
 * and returns the tree's identity plus the simulation double (so a test can inspect what the
 * recorders asked of it).
 */
export function replayCorpus(scenario: string): CorpusResult {
  const cached = corpusCache.get(scenario);
  if (cached) return cached;
  const result = replayCorpusUncached(scenario);
  corpusCache.set(scenario, result);
  return result;
}

function replayCorpusUncached(scenario: string): CorpusResult {
  const golden = new Golden(goldenRunRoot(scenario));
  const flags = deriveFlags(golden);
  const doc = flagsToConfig(flags);

  const candidateDir = freshDir(path.join(CANDIDATE_ROOT, scenario));
  const runDir = path.join(candidateDir, 'run');

  // The recorders use native's relative paths ("run/..."), exactly as the native build does
  // from its own tree root.
  const previousCwd = process.cwd();
  resetRegistry();

  const sim = new FakeSimulation();
  const world = new FakeWorld();
  const foodTypes = new FakeFoodTypes(foodTypeNames(golden));
  const env: LogContext = {
    fs: nodeRecordFileSystem(ConcreteFileType.TYPE_GZIP_FILE), // the recorded `CompressFiles True`
    world,
    // The one number `GeneStatsLog` takes from the schema is the `genestats.txt` header, which
    // the golden carries; the `meta/*` renderers are lane L5's and are exercised by its own
    // test, so this lane's corpus writes those files empty and prunes them afterwards (see
    // `pruneNonL12Artifacts`).
    genomeUtil: new FakeGenomeUtil(new FakeGeneSchema(genestatsHeader(golden))),
    foodTypes,
    computeAdamiComplexity: () => {
      throw new Error('corpus: RecordAdamiComplexity is off in the recorded scenarios');
    },
  };

  let logs: Logs | null = null;

  // `TSimulation::processWorldFile` publishes the worldfile's energy-type count on the
  // `globals` singleton before the loggers are built (`Simulation.cc:3861`); `EnergyLog` sizes
  // its dynamic `Energy0..N` columns from it.
  globals.numEnergyTypes = doc.getInt('NumEnergyTypes');

  try {
    process.chdir(candidateDir);

    logs = new Logs(sim, doc, env);

    // ------------------------------------------------------------------
    // data derived from the goldens
    // ------------------------------------------------------------------
    const agents = readLifespans(golden);
    const energy = agentEnergyRows(golden);
    const positions = agentPositionRows(golden);
    const maxEnergy = goldenRows(golden, 'energy/agents/max.txt');
    const food = foodEnergyRows(golden);
    const genestats = genestatsRows(golden);
    const separations = separationsTables(golden);
    const population = new Map(
      goldenRows(golden, 'population.txt').map((row) => [Number(row[0]), Number(row[1])] as const),
    );

    /**
     * The step's birth/death events, in the order the run raised them.
     *
     * When two events happen in one step, their relative order is the simulation's (it depends
     * on the order the agents are processed in), so the replay takes that order from
     * `BirthsDeaths.log` itself — a step's `DEATH` line can precede its `BIRTH` line
     * (step 28) or follow it (step 231). Which handler writes what, and in which file, is
     * this lane's contract; the interleaving is lane L11's.
     */
    const lifeEvents = golden
      .lines('BirthsDeaths.log')
      .slice(1)
      .map((line) => line.split(' '))
      .map((parts) => ({
        step: Number(parts[0]),
        kind: parts[1]!,
        agent: Number(parts[2]),
        parent1: parts.length > 3 ? Number(parts[3]) : 0,
        parent2: parts.length > 4 ? Number(parts[4]) : 0,
      }))
      .filter((event) => event.kind === 'BIRTH' || event.kind === 'DEATH');

    /** The recorded genetic separations, fed back through `Genome::separation`. */
    const recordedSeparations = new RecordedSeparations();
    for (const [agent, entries] of separations) {
      for (const [other, value] of entries) recordedSeparations.set(agent, other, value);
    }

    // `TSimulation::TSimulation` calls `SeparationCache::init()` before anything else.
    separationCache.init();

    /** Agent objects, created from `lifespans.txt` (birth/death step + reason). */
    const fakeAgents = new Map<number, FakeAgent>();
    const agentFor = (number: number): FakeAgent => {
      let agent = fakeAgents.get(number);
      if (!agent) {
        agent = new FakeAgent(number, number, recordedSeparations);
        const life = agents.get(number);
        if (!life) throw new Error(`corpus: no lifespans row for agent ${number}`);
        agent.lifeSpanValue.birth = { step: life.birthStep, reason: life.birthReason as BirthReason };
        agent.lifeSpanValue.death = { step: life.deathStep, reason: life.deathReason as DeathReason };
        fakeAgents.set(number, agent);
      }
      return agent;
    };
    for (const number of agents.keys()) agentFor(number);

    /**
     * Per-agent rows, split into the step-end rows and the death row.
     *
     * A non-`SIMEND` death writes the agent's final row *before* that step's `StepEnd` (the
     * agent is already gone from the world), so the last recorded row is the death row; a
     * `SIMEND` death writes nothing, so every row belongs to a `StepEnd`.
     */
    const stepEndRows = new Map<number, Map<number, { energy: number; foodEnergy: number }>>();
    const deathRows = new Map<number, { energy: number; foodEnergy: number }>();
    for (const [number, rows] of energy) {
      const life = agents.get(number)!;
      const simend = life.deathReason === DeathReason.SIMEND;
      const body = simend ? rows : rows.slice(0, -1);
      stepEndRows.set(number, new Map(body.map((row) => [row.step, row])));
      const last = rows[rows.length - 1];
      if (!simend && last) deathRows.set(number, { energy: last.energy, foodEnergy: last.foodEnergy });
    }

    const bodyUpdates = new Map<number, Map<number, { x: number; z: number }>>();
    for (const [number, rows] of positions) {
      bodyUpdates.set(number, new Map(rows.map((row) => [row.step, row])));
    }

    const collisions = goldenCollisionRows(golden);
    const carries = goldenCarryRows(golden);
    const contacts = goldenContactRows(golden);
    const energyEvents = goldenEnergyEvents(golden);
    const consumption = goldenConsumptionRows(golden);

    // The `Eat` events' `energyRaw` is not in `events/energy.log`; `energy/consumption.txt`
    // carries it, one row per `Eat` event, in the same order.
    const eatPairs = consumption.map((row) => row.energyRaw);
    let eatIndex = 0;

    const emit = (event: SimEvent) => logs!.postEvent(event);

    const birthAt = (step: number, number: number, reason: BirthReason, parent1: number, parent2: number) => {
      const born = agentFor(number);
      // `SeparationCache::birth( birthEvent )` — the simulation maintains the cache, the log
      // lane only reads it (`genome/SeparationCache.cc`).
      separationCache.birth(born);
      emit({ type: Event_AgentBirth, a: born, reason, parent1: agentFor(parent1), parent2: agentFor(parent2) } as AgentBirthEvent<FakeAgent>);
      emit({ type: Event_AgentGrown, a: agentFor(number) } as SimEvent);
      void step;
    };

    // ------------------------------------------------------------------
    // the reconstructed run
    // ------------------------------------------------------------------
    sim.stepValue = 0;

    // Every agent's max energy is an input (the value `run/energy/agents/max.txt` records).
    for (const row of maxEnergy) agentFor(Number(row[0])).maxEnergyStore.set(Number(row[1]));

    // The initial population: `BR_SIMINIT` births (no parents) then each agent's `AgentGrown`,
    // in creation order — which for the recorded runs is agent-number order.
    for (const number of [...agents.keys()].sort((a, b) => a - b)) {
      const life = agents.get(number)!;
      if (life.birthStep !== 0) continue;
      const born = agentFor(number);
      separationCache.birth(born);
      emit({ type: Event_AgentBirth, a: born, reason: BirthReason.SIMINIT, parent1: null, parent2: null } as SimEvent);
      emit({ type: Event_AgentGrown, a: born } as SimEvent);
    }

    // `SimInited` writes the genome meta files and the step-0 row of `energy/food.txt`.
    world.objects = foodRowObjects(foodTypes, food, 0);
    sim.numAgentsValue = population.get(0) ?? 0;
    emit({ type: Event_SimInited } as SimEvent);

    const maxStep = Math.max(...[...population.keys()]);
    for (let step = 1; step <= maxStep; step++) {
      sim.stepValue = step;

      // world events, in the order their own logs record them
      for (const row of collisions.filter((r) => r.step === step)) {
        emit({
          type: Event_Collision,
          a: agentFor(row.agent),
          ot: OBJECT_TYPE_BY_NAME[row.type]!,
        } as SimEvent);
      }

      for (const row of carries.filter((r) => r.step === step)) {
        emit({
          type: Event_Carry,
          a: agentFor(row.agent),
          action: carryActionIndex(row.action),
          obj: new FakeObject(carryObjectTypeBit(row.objectType), row.objectNumber),
        } as SimEvent);
      }

      for (const row of contacts.filter((r) => r.step === step)) {
        emit({ type: Event_ContactEnd, c: row.c, d: row.d } as SimEvent);
      }

      for (const row of energyEvents.filter((r) => r.step === step)) {
        const agent = agentFor(row.agent);
        const energyValue = row.energy[0] ?? 0;

        if (row.action === EnergyAction.Eat) {
          const foodType = foodTypes.get(0);
          const raw = eatPairs[eatIndex++] ?? 0;
          emit({
            type: Event_Energy,
            a: agent,
            obj: new FakeFood(foodType, energyValue, row.objectNumber),
            neuralActivation: row.neuralActivation,
            energy: energyRow(energyValue),
            energyRaw: energyRow(raw),
            action: row.action,
          } as SimEvent);
        } else {
          const other = agentFor(row.objectNumber);
          emit({
            type: Event_Energy,
            a: agent,
            obj: other,
            neuralActivation: row.neuralActivation,
            energy: energyRow(energyValue),
            energyRaw: energyRow(energyValue),
            action: row.action,
          } as SimEvent);
        }
      }

      // Body updates (every agent with a position row at this step — including one that dies
      // at the end of it, which is why the position logs run through the death step).
      for (const [number, agent] of fakeAgents) {
        const update = bodyUpdates.get(number)?.get(step);
        if (!update) continue;
        agent.posX = update.x;
        agent.posZ = update.z;
        emit({ type: Event_BodyUpdated, a: agent, energyUsed: 0, energyUsedRaw: 0 } as SimEvent);
      }

      // Births and deaths, in the recorded order.
      for (const line of lifeEvents.filter((l) => l.step === step)) {
        const number = line.agent;

        if (line.kind === 'BIRTH') {
          birthAt(step, number, BirthReason.NATURAL, line.parent1, line.parent2);
          continue;
        }

        const agent = agentFor(number);
        const death = deathRows.get(number);
        if (death) {
          agent.energyStore.set(death.energy);
          agent.foodEnergyStore.set(death.foodEnergy);
        }
        emit({ type: Event_AgentDeath, a: agent, reason: agents.get(number)!.deathReason as DeathReason } as SimEvent);
        separationCache.death(agent);
      }

      // The step-end walk: the agents with a step-end row at this step, plus this step's foods.
      const liveAgents: FakeAgent[] = [];
      for (const [number, agent] of fakeAgents) {
        const end = stepEndRows.get(number)?.get(step);
        if (!end) continue;
        agent.energyStore.set(end.energy);
        agent.foodEnergyStore.set(end.foodEnergy);
        liveAgents.push(agent);
      }

      world.objects = [
        ...liveAgents.map((agent) => ({ type: GObjectType.AGENT, obj: agent })),
        ...foodRowObjects(foodTypes, food, step),
      ];

      const stats = genestats.get(step);
      const geneStats = sim.geneStatsValue as FakeGeneStats;
      if (stats) {
        geneStats.mean = stats.mean;
        geneStats.stddev = stats.stddev;
      }
      sim.numAgentsValue = population.get(step) ?? 0;

      emit({ type: Event_StepEnd } as SimEvent);
    }

    // The run ends: every still-live agent dies of `DR_SIMEND` (which writes no row and
    // closes its per-agent files), then `SimEnd`.
    world.objects = [...fakeAgents.values()].map((agent) => ({ type: GObjectType.AGENT, obj: agent }));
    for (const [number, agent] of fakeAgents) {
      if (agents.get(number)!.deathReason === DeathReason.SIMEND) {
        emit({ type: Event_AgentDeath, a: agent, reason: DeathReason.SIMEND } as SimEvent);
        separationCache.death(agent);
      }
    }
    emit({ type: Event_SimEnd } as SimEvent);

    logs.dispose();
    logs = null;

    pruneNonL12Artifacts(runDir);

    return {
      scenario,
      golden,
      runDir,
      produced: listFiles(runDir),
      flags,
      sim,
    };
  } finally {
    if (logs) logs.dispose();
    process.chdir(previousCwd);
  }
}

/**
 * Remove the artifacts whose *content* another lane owns: `run/genome/agents/**` (L5's
 * `Genome::dump`), `run/genome/meta/**` (L5's renderers) and `run/brain/**` (L6's dumps).
 * The replay writes them so the recorder paths and event plumbing run, but a candidate tree
 * handed to `oracle/run_parity.sh` must not contain bytes this lane cannot vouch for.
 * `run/brain/**` is never written by the corpus because the corpus never raises brain events.
 */
function pruneNonL12Artifacts(runDir: string): void {
  for (const dir of ['genome/agents', 'genome/meta', 'brain']) {
    rmSync(path.join(runDir, dir), { recursive: true, force: true });
  }
}

/** `genome/genestats.txt`'s first line — the schema's mutable size. */
function genestatsHeader(golden: Golden): number {
  const header = Number(golden.lines('genome/genestats.txt')[0]);
  if (!Number.isFinite(header)) throw new Error('corpus: genestats.txt has no size header');
  return header;
}

/** The `sim::ObjectType` enumeration by the token `collisions.log` writes. */
const OBJECT_TYPE_BY_NAME: Record<string, number> = {
  agent: 0,
  food: 1,
  brick: 2,
  barrier: 3,
  edge: 4,
};

function energyRow(value: number) {
  return { sum: () => value, at: () => value };
}

/** One fake food per food type, with the recorded per-type totals for that step. */
function foodRowObjects(foodTypes: FakeFoodTypes, food: { step: number; values: number[] }[], step: number) {
  const row = food.find((entry) => entry.step === step);
  if (!row) return [];
  return row.values.map((value, index) => ({ type: GObjectType.FOOD, obj: new FakeFood(foodTypes.get(index), value) }));
}

/** Every file under a tree, relative to it. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}

/** Read a candidate file, inflated when the recorder wrote it gzipped. */
export function candidateBytes(runDir: string, rel: string): Uint8Array | undefined {
  const plain = path.join(runDir, rel);
  const gz = `${plain}.gz`;
  if (existsSync(gz)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { gunzipSync } = require('node:zlib') as typeof import('node:zlib');
    return gunzipSync(readFileSync(gz));
  }
  if (existsSync(plain)) return readFileSync(plain);
  return undefined;
}

/**
 * A step-localized byte comparison, mirroring what `tools/check_parity.py` reports: the first
 * differing byte, the line it lands on, and (for a datalib file) the step and the column the
 * `#@L` header names.
 */
export function firstDifference(expected: Uint8Array, actual: Uint8Array): string | undefined {
  const limit = Math.min(expected.length, actual.length);
  for (let i = 0; i < limit; i++) {
    if (expected[i] !== actual[i]) {
      return explain(expected, actual, i);
    }
  }
  if (expected.length !== actual.length) {
    return `byte length differs: golden ${expected.length}, candidate ${actual.length} (${explain(expected, actual, limit)})`;
  }
  return undefined;
}

function explain(expected: Uint8Array, actual: Uint8Array, offset: number): string {
  const line = Buffer.from(expected).toString('latin1').slice(0, offset).split('\n').length;
  const goldenText = Buffer.from(expected).toString('latin1');
  const candidateText = Buffer.from(actual).toString('latin1');
  const goldenLine = goldenText.split('\n')[line - 1] ?? '';
  const candidateLine = candidateText.split('\n')[line - 1] ?? '';

  const headerMatch = /^#@L (.*)$/m.exec(goldenText);
  const column = headerMatch ? columnAt(headerMatch[1]!, offset - goldenText.indexOf(headerMatch[0]!)) : undefined;

  return [
    `first divergence at byte ${offset} (line ${line})`,
    column ? `column ${column}` : undefined,
    `golden:    ${JSON.stringify(goldenLine)}`,
    `candidate: ${JSON.stringify(candidateLine)}`,
  ]
    .filter(Boolean)
    .join('; ');
}

function columnAt(names: string, offsetIntoLine: number): string | undefined {
  if (offsetIntoLine < 0) return undefined;
  const width = 20;
  const index = Math.floor(offsetIntoLine / width);
  return names.slice(index * width, (index + 1) * width)?.trim() || undefined;
}

export {
  FakeAgent,
  FakeFittestList,
  FakeFoodTypes,
  FakeGeneStats,
  FakeGeneSchema,
  RecordedSeparations,
  FakeGenomeUtil,
  FakeObject,
  FakeSimulation,
  FakeWorld,
  Golden,
};
export type { AgentContactEndInfo };
