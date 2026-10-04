/**
 * Lane L12 (logs) — shared test helpers: reading a recorded golden tree and reconstructing a
 * plausible event stream from it.
 *
 * The lane cannot re-run the simulation (lane L11 is not landed yet), so the recorder layer is
 * verified by *replaying* the recorded run: every value the recorders write is taken from the
 * golden artifact that carries it (an agent's energy row, a collision row, a lifespans row…)
 * and everything else — which event opens which file, the table and column schemas, the
 * formats, the per-agent file lifecycle, the row order, the link/rename tree — comes from the
 * port under test. If the port's structure differs from native's by one byte, the comparison
 * fails, and the diff names the file and the row (the checker is step-localized by design).
 *
 * PORT-NOTE(l12-replay/values-are-inputs): the *values* in these reconstructions are inputs,
 * not results: they were computed by the simulation in the native run, and recomputing them is
 * lane L11's job. What this harness establishes is that given the same values, the recorders
 * emit the same bytes — which is exactly the L12 contract.
 *
 * PORT-NOTE(l12-replay/event-order-from-goldens): the reconstruction follows the event order
 * the goldens themselves prove: a per-agent energy file holds one row per step from its birth
 * step to its death step, the death step's row being the death handler's (a non-`SIMEND` death
 * writes a row and the agent is gone before that step's `StepEnd`), while `SIMEND` deaths leave
 * the last `StepEnd` row in place and write nothing. Position files hold one row per step from
 * the step *after* birth through the death step. See `replayCorpus()`.
 */

import { DataLibReader } from '../src/model/datalib';
import {
  BirthReason,
  DeathReason,
  Event_AgentBirth,
  Event_AgentDeath,
  Event_AgentGrown,
  Event_BodyUpdated,
  Event_BrainAnalysisBegin,
  Event_BrainGrown,
  Event_BrainUpdated,
  Event_Carry,
  Event_Collision,
  Event_ContactEnd,
  Event_EpochEnd,
  Event_Energy,
  Event_SimEnd,
  Event_SimInited,
  Event_StepEnd,
  EnergyAction,
  GObjectType,
  MATE_PREVENTED_CARRY,
  MATE_PREVENTED_EAT_MATE_MIN_DISTANCE,
  MATE_PREVENTED_EAT_MATE_SPAN,
  MATE_PREVENTED_ENERGY,
  MATE_PREVENTED_MATE_WAIT,
  MATE_PREVENTED_MAX_DOMAIN,
  MATE_PREVENTED_MAX_METABOLISM,
  MATE_PREVENTED_MAX_VELOCITY,
  MATE_PREVENTED_MAX_WORLD,
  MATE_PREVENTED_MISC,
  MATE_PREVENTED_PARTNER,
  MATE_PREVENTED_WORLDFILE,
  FIGHT_PREVENTED_CARRY,
  FIGHT_PREVENTED_POWER,
  FIGHT_PREVENTED_SHIELD,
  GIVE_PREVENTED_CARRY,
  GIVE_PREVENTED_ENERGY,
  type AgentContactEndInfo,
  type Config,
  type SimEvent,
} from '../src/model/types';
import { documentFromJs, createConfig } from '../src/model/types';
import {
  CARRY_ACTION_NAMES,
  CARRY_OBJECT_TYPE_TOKENS,
  ENERGY_ACTION_NAMES,
  FitnessScope,
  type LogAgent,
  type LogBrain,
  type LogContext,
  type LogEnergy,
  type LogFitStruct,
  type LogFittestList,
  type LogFood,
  type LogFoodType,
  type LogFoodTypeRegistry,
  type LogGeneStats,
  type LogGameObject,
  type LogGenome,
  type LogLifeSpan,
  type LogSimulation,
  type LogSortedObjectList,
  type LogGeneSchema,
  type LogGenomeUtil,
  type Ref,
  type TextOutput,
  type TextSink,
} from '../src/model/logs';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { assertUsableStagingRoot } from '../src/oracle/guard';

//===========================================================================
// Golden tree
//===========================================================================

/** A recorded `run/` tree, read-only. */
export class Golden {
  private readonly cache = new Map<string, Uint8Array>();

  constructor(readonly root: string) {}

  /** Every file under the tree, relative to it, sorted. */
  files(): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else out.push(rel);
      }
    };
    walk(this.root, '');
    return out.sort();
  }

  exists(rel: string): boolean {
    return this.bytes(rel) !== undefined;
  }

  /** The recorded bytes; transparently inflated when native wrote a `.gz`. */
  bytes(rel: string): Uint8Array | undefined {
    const cached = this.cache.get(rel);
    if (cached) return cached;

    const plain = path.join(this.root, rel);
    const gz = `${plain}.gz`;
    let data: Uint8Array | undefined;
    if (existsSync(gz)) data = gunzipSync(readFileSync(gz));
    else if (existsSync(plain)) data = readFileSync(plain);
    if (data) this.cache.set(rel, data);
    return data;
  }

  /** The bytes *as recorded* — the `.gz` container when native wrote one. */
  rawBytes(rel: string): Uint8Array {
    const plain = path.join(this.root, rel);
    const gz = `${plain}.gz`;
    if (existsSync(gz)) return readFileSync(gz);
    if (existsSync(plain)) return readFileSync(plain);
    throw new Error(`golden: no such file '${rel}'`);
  }

  /** The recorded bytes as latin-1 text (native `char *` semantics). */
  text(rel: string): string {
    const data = this.bytes(rel);
    if (!data) throw new Error(`golden: no such file '${rel}'`);
    return Buffer.from(data).toString('latin1');
  }

  /** Lines of a plain text file, with the trailing empty line dropped. */
  lines(rel: string): string[] {
    const lines = this.text(rel).split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** A parsed datalib file. */
  datalib(rel: string): DataLibReader {
    const data = this.bytes(rel);
    if (!data) throw new Error(`golden: no such file '${rel}'`);
    return new DataLibReader(data);
  }

  /** Directory listing (non-recursive). */
  list(rel: string): string[] {
    const dir = path.join(this.root, rel);
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }
}

//===========================================================================
// The collaborating lanes, as fakes the replay can drive
//===========================================================================

/** Native `Energy` over one value (the recorded scenarios have `NumEnergyTypes 1`). */
export class FakeEnergy implements LogEnergy {
  constructor(private value = 0) {}

  set(value: number): void {
    this.value = value;
  }

  sum(): number {
    return this.value;
  }

  at(index: number): number {
    if (index !== 0) throw new Error(`FakeEnergy: only one energy type (asked for ${index})`);
    return this.value;
  }
}

/** Native `LifeSpan`. */
export class FakeLifeSpan implements LogLifeSpan {
  birth: { step: number; reason: BirthReason } = { step: 0, reason: BirthReason.SIMINIT };
  death: { step: number; reason: DeathReason } = { step: 0, reason: DeathReason.SIMEND };
}

/**
 * The recorded genetic separations, indexed by the *ordered* pair of agent numbers.
 *
 * `SeparationCache::createEntry` stores the value under the smaller-numbered agent, so the
 * recorded `run/genome/separations.txt` table for agent A holds exactly the pairs `(A, Y)` with
 * `Y > A`. Feeding those values back as the genome's `separation` makes the replay exercise the
 * whole cache path — and an unknown pair means the replay raised a birth or a step-end the
 * native run did not, which the fake reports instead of inventing a value.
 */
export class RecordedSeparations {
  private readonly values = new Map<string, number>();

  set(a: number, b: number, value: number): void {
    this.values.set(`${Math.min(a, b)}:${Math.max(a, b)}`, value);
  }

  separation(a: number, b: number): number {
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    const value = this.values.get(key);
    if (value === undefined) {
      throw new Error(`RecordedSeparations: the golden has no separation for (${a}, ${b})`);
    }
    return value;
  }

  size(): number {
    return this.values.size;
  }
}

/** Native `Genome` as the loggers read it. */
export class FakeGenome implements LogGenome {
  constructor(
    private readonly label = 'genome',
    private readonly number = 0,
    private readonly separations: RecordedSeparations | null = null,
  ) {}

  dump(file: TextSink): void {
    file.printf(`${this.label}\n`);
  }

  getRawUint(index: number): number {
    return index & 0xff;
  }

  separation(other: LogGenome): number {
    if (!this.separations) return 0;
    return this.separations.separation(this.number, (other as FakeGenome).number);
  }

  /** The agent number this genome belongs to (for the separation lookup). */
  get agentNumber(): number {
    return this.number;
  }
}

/** A `Brain` whose dumps are deterministic text (this lane owns the paths, not the contents). */
export class FakeBrain implements LogBrain {
  constructor(private readonly agentNumber: number) {}

  dumpAnatomical(file: TextSink, n: number, fitness: number): void {
    file.printf(`anatomy ${n} ${fitness}\n`);
  }

  dumpSynapses(file: TextSink, n: number): void {
    file.printf(`synapses ${n}\n`);
  }

  startFunctional(file: TextSink, n: number): void {
    file.printf(`function ${n}\n`);
  }

  writeFunctional(file: TextSink): void {
    file.printf('step\n');
  }

  endFunctional(file: TextSink, fitness: number): void {
    file.printf(`end ${fitness}\n`);
  }
}

/** Native `agent`. */
export class FakeAgent implements LogAgent {
  readonly energyStore = new FakeEnergy();
  readonly foodEnergyStore = new FakeEnergy();
  readonly maxEnergyStore = new FakeEnergy();
  readonly lifeSpanValue = new FakeLifeSpan();
  readonly genesValue: FakeGenome;
  readonly brainValue: FakeBrain;
  readonly brainAnalysisParms = { functionPath: '' };
  fitness = 0;
  complexityValue = 0;
  posX = 0;
  posZ = 0;

  constructor(
    private readonly num: number,
    private readonly typeNum = num,
    separations: RecordedSeparations | null = null,
  ) {
    this.brainValue = new FakeBrain(num);
    this.genesValue = new FakeGenome(`agent ${num}`, num, separations);
  }

  /** Native `agent::Number()`. */
  number(): number {
    return this.num;
  }

  /** Native `gobject::getTypeNumber()`. */
  typeNumber(): number {
    return this.typeNum;
  }

  x(): number {
    return this.posX;
  }

  y(): number {
    return 0;
  }

  z(): number {
    return this.posZ;
  }

  /** Native `agent::GetEnergy()`. */
  energy(): LogEnergy {
    return this.energyStore;
  }

  /** Native `agent::GetFoodEnergy()`. */
  foodEnergy(): LogEnergy {
    return this.foodEnergyStore;
  }

  /** Native `agent::GetMaxEnergy()`. */
  maxEnergy(): LogEnergy {
    return this.maxEnergyStore;
  }

  /** Native `agent::GetLifeSpan()`. */
  lifeSpan(): LogLifeSpan {
    return this.lifeSpanValue;
  }

  /** Native `agent::Genes()`. */
  genes(): LogGenome {
    return this.genesValue;
  }

  /** Native `agent::GetBrain()`. */
  brain(): LogBrain {
    return this.brainValue;
  }

  heuristicFitness(): number {
    return this.fitness;
  }

  complexity(): number {
    return this.complexityValue;
  }
}

/**
 * Native `food`. A food is a `gobject`, so it also answers the type-number question
 * `EnergyLog` asks of every event's object (`e.obj->getTypeNumber()`), and it knows its own
 * position in the food list (`objectXSortedList`'s index), which `FoodEnergyLog` uses to bucket.
 */
export class FakeFood implements LogFood {
  constructor(
    private readonly foodType: LogFoodType,
    private readonly energy: number,
    private readonly typeNum = 0,
  ) {}

  type(): LogFoodType {
    return this.foodType;
  }

  energySum(): number {
    return this.energy;
  }

  /** Native `gobject::getTypeNumber()`. */
  typeNumber(): number {
    return this.typeNum;
  }
}

/** A `FoodType` table built from the golden's `energy/food.txt` column names. */
export class FakeFoodTypes implements LogFoodTypeRegistry {
  private readonly types: LogFoodType[];

  constructor(names: readonly string[]) {
    this.types = names.map((name, index) => ({ index, name }));
  }

  getNumberDefinitions(): number {
    return this.types.length;
  }

  get(index: number): LogFoodType {
    const type = this.types[index];
    if (!type) throw new Error(`FakeFoodTypes: no definition ${index}`);
    return type;
  }
}

/** Native `objectxsortedlist::gXSortedObjects` — a list the replay fills per step. */
export class FakeWorld implements LogSortedObjectList {
  objects: { type: number; obj: unknown }[] = [];
  private at = -1;

  reset(): void {
    this.at = -1;
  }

  next(type: number, out: Ref<unknown>): boolean {
    while (++this.at < this.objects.length) {
      const entry = this.objects[this.at]!;
      if (entry.type === type) {
        out.value = entry.obj;
        return true;
      }
    }
    return false;
  }
}

/** Native `FittestList` (L11's spelling of `size()` — see the seam PORT-NOTE). */
export class FakeFittestList implements LogFittestList {
  constructor(private readonly entries: LogFitStruct[] = []) {}

  getSize(): number {
    return this.entries.length;
  }

  get(rank: number): LogFitStruct {
    const entry = this.entries[rank];
    if (!entry) throw new Error(`FakeFittestList: no rank ${rank}`);
    return entry;
  }
}

/** Native `GeneStats`. */
export class FakeGeneStats implements LogGeneStats {
  mean: number[] = [];
  stddev: number[] = [];
  maxAgents = 0;

  init(maxAgents: number): void {
    this.maxAgents = maxAgents;
  }

  getMean(): readonly number[] {
    return this.mean;
  }

  getStddev(): readonly number[] {
    return this.stddev;
  }
}

/** Native `TSimulation`. */
export class FakeSimulation implements LogSimulation {
  stepValue = 0;
  epochValue = 0;
  numAgentsValue = 0;
  readonly geneStatsValue = new FakeGeneStats();
  complexityEnabled = false;
  fittestLists = new Map<FitnessScope, LogFittestList>();

  step(): number {
    return this.stepValue;
  }

  epoch(): number {
    return this.epochValue;
  }

  numAgents(): number {
    return this.numAgentsValue;
  }

  maxAgents(): number {
    return this.numAgentsValue;
  }

  geneStats(): LogGeneStats {
    return this.geneStatsValue;
  }

  fittest(scope: FitnessScope): LogFittestList {
    return this.fittestLists.get(scope) ?? new FakeFittestList();
  }

  enableComplexityCalculations(): void {
    this.complexityEnabled = true;
  }
}

/**
 * Native `gene::GeneSchema`, as the three recorders that read it need it. `mutableSize` is the
 * one number they take from the schema (the `genestats.txt` header); the printers are given
 * pre-rendered text by the caller, because the *rendering* is lane L5's contract.
 */
export class FakeGeneSchema implements LogGeneSchema {
  constructor(
    private readonly mutableSize: number,
    private readonly rendered: { geneindex?: string; genelayout?: string; genetitle?: string; generange?: string } = {},
    private readonly indexes: Map<string, number> = new Map(),
  ) {}

  getMutableSize(): number {
    return this.mutableSize;
  }

  getIndexes(geneNames: readonly string[]): number[] {
    return geneNames.map((name) => this.indexes.get(name) ?? -1);
  }

  printIndexes(out: TextOutput, layout?: unknown): void {
    out.write((layout === undefined ? this.rendered.geneindex : this.rendered.genelayout) ?? '');
  }

  printTitles(out: TextOutput): void {
    out.write(this.rendered.genetitle ?? '');
  }

  printRanges(out: TextOutput): void {
    out.write(this.rendered.generange ?? '');
  }
}

/** Native `GenomeUtil` — the recorders read `schema`/`layout` through `LogContext`. */
export class FakeGenomeUtil implements LogGenomeUtil {
  readonly layout: unknown = null;

  constructor(readonly schema: LogGeneSchema | null = null) {}
}

//===========================================================================
// The reconstruction
//===========================================================================

/** One recorded agent, as `run/lifespans.txt` describes it. */
export interface GoldenAgent {
  number: number;
  birthStep: number;
  birthReason: number;
  deathStep: number;
  deathReason: number;
}

/** `run/lifespans.txt` -> per-agent life records. */
export function readLifespans(golden: Golden): Map<number, GoldenAgent> {
  const reader = golden.datalib('lifespans.txt');
  reader.seekTable('LifeSpans');

  const out = new Map<number, GoldenAgent>();
  for (const row of reader.allRows()) {
    const number = Number(row[0]);
    out.set(number, {
      number,
      birthStep: Number(row[1]),
      birthReason: birthReasonIndex(String(row[2])),
      deathStep: Number(row[3]),
      deathReason: deathReasonIndex(String(row[4])),
    });
  }
  return out;
}

function birthReasonIndex(name: string): number {
  const index = ['INVALID', 'SIMINIT', 'CREATE', 'NATURAL', 'LOCKSTEP', 'VIRTUAL'].indexOf(name);
  if (index < 0) throw new Error(`unknown birth reason ${name}`);
  return index;
}

function deathReasonIndex(name: string): number {
  const index = ['INVALID', 'SIMEND', 'SMITE', 'PATCH', 'NATURAL', 'FIGHT', 'EAT', 'LOCKSTEP', 'RANDOM'].indexOf(name);
  if (index < 0) throw new Error(`unknown death reason ${name}`);
  return index;
}

/**
 * The recorders' worldfile flags for a recorded scenario, derived from the artifacts the run
 * actually produced (each flag is evidenced by a file) and cross-checked against the worldfile
 * text by the caller. See `assertRecordFlagsForScenario`.
 */
export interface ScenarioFlags {
  RecordAgentEnergy: boolean;
  RecordPosition: string;
  RecordBirthsDeaths: boolean;
  RecordCarry: boolean;
  RecordCollisions: boolean;
  RecordContacts: boolean;
  RecordEnergy: boolean;
  RecordFoodConsumption: boolean;
  RecordFoodEnergy: boolean;
  RecordGeneStats: boolean;
  RecordGenomes: boolean;
  RecordBrainAnatomy: boolean;
  RecordBrainFunction: boolean;
  RecordBrainRecent: boolean;
  RecordBrainBestRecent: boolean;
  RecordBrainBestSoFar: boolean;
  RecordSynapses: boolean;
  RecordSeparations: string;
  RecordPopulation: boolean;
  RecordComplexity: boolean;
  RecordAdamiComplexity: boolean;
  RecordGitRevision: boolean;
  GenomeSubsetLogRecord: boolean;
  InitAgents: number;
  ComplexityType: string;
}

export function deriveFlags(golden: Golden): ScenarioFlags {
  const agents = readLifespans(golden);
  const positionFile = firstFile(golden, 'motion/position/agents');

  return {
    RecordAgentEnergy: golden.exists('energy/agents/max.txt'),
    RecordPosition: positionFile
      ? positionColumnCount(golden, positionFile) === 3
        ? 'Approximate'
        : 'Precise'
      : 'False',
    RecordBirthsDeaths: golden.exists('BirthsDeaths.log'),
    RecordCarry: golden.exists('events/carry.log'),
    RecordCollisions: golden.exists('events/collisions.log'),
    RecordContacts: golden.exists('events/contacts.log'),
    RecordEnergy: golden.exists('events/energy.log'),
    RecordFoodConsumption: golden.exists('energy/consumption.txt'),
    RecordFoodEnergy: golden.exists('energy/food.txt'),
    RecordGeneStats: golden.exists('genome/genestats.txt'),
    RecordGenomes: firstFile(golden, 'genome/agents') !== undefined,
    RecordBrainAnatomy: firstFile(golden, 'brain/anatomy') !== undefined,
    RecordBrainFunction: firstFile(golden, 'brain/function') !== undefined,
    RecordBrainRecent: golden.list('brain/Recent').length > 0,
    RecordBrainBestRecent: golden.list('brain/bestRecent').length > 0,
    RecordBrainBestSoFar: golden.list('brain/bestSoFar').length > 0,
    RecordSynapses: firstFile(golden, 'brain/synapses') !== undefined,
    RecordSeparations: golden.exists('genome/separations.txt') ? 'All' : 'False',
    RecordPopulation: golden.exists('population.txt'),
    RecordComplexity: firstFile(golden, 'brain/Recent/complexity') !== undefined || golden.list('brain/Recent').some((d) => firstFile(golden, `brain/Recent/${d}`)?.endsWith('.plt') === true),
    RecordAdamiComplexity: firstFile(golden, 'genome')?.startsWith('genome/AdamiComplexity') === true,
    RecordGitRevision: golden.exists('gitrevision.txt'),
    GenomeSubsetLogRecord: golden.exists('genome/subset.log'),
    // `InitAgents` is the number of agents alive at step 0 — the SIMINIT births.
    InitAgents: [...agents.values()].filter((a) => a.birthStep === 0).length,
    ComplexityType: 'None',
  };
}

/** Extra worldfile content a unit test needs to set (`GenomeSubsetLog.GeneNames`). */
export interface ConfigOptions {
  geneNames?: readonly string[];
}

/** The worldfile `Config` the recorders read, built from derived flags. */
export function flagsToConfig(flags: ScenarioFlags, options: ConfigOptions = {}): Config {
  const bool = (value: boolean) => (value ? 'True' : 'False');
  return createConfig(
    documentFromJs({
      RecordAgentEnergy: bool(flags.RecordAgentEnergy),
      RecordPosition: flags.RecordPosition,
      RecordBirthsDeaths: bool(flags.RecordBirthsDeaths),
      RecordCarry: bool(flags.RecordCarry),
      RecordCollisions: bool(flags.RecordCollisions),
      RecordContacts: bool(flags.RecordContacts),
      RecordEnergy: bool(flags.RecordEnergy),
      RecordFoodConsumption: bool(flags.RecordFoodConsumption),
      RecordFoodEnergy: bool(flags.RecordFoodEnergy),
      RecordGeneStats: bool(flags.RecordGeneStats),
      RecordGenomes: bool(flags.RecordGenomes),
      RecordBrainAnatomy: bool(flags.RecordBrainAnatomy),
      RecordBrainFunction: bool(flags.RecordBrainFunction),
      RecordBrainRecent: bool(flags.RecordBrainRecent),
      RecordBrainBestRecent: bool(flags.RecordBrainBestRecent),
      RecordBrainBestSoFar: bool(flags.RecordBrainBestSoFar),
      RecordSynapses: bool(flags.RecordSynapses),
      RecordSeparations: flags.RecordSeparations,
      RecordPopulation: bool(flags.RecordPopulation),
      RecordComplexity: bool(flags.RecordComplexity),
      RecordAdamiComplexity: bool(flags.RecordAdamiComplexity),
      AdamiComplexityRecordFrequency: '200',
      RecordGitRevision: bool(flags.RecordGitRevision),
      GenomeSubsetLog: {
        Record: bool(flags.GenomeSubsetLogRecord),
        GeneNames: [...(options.geneNames ?? [])],
      },
      InitAgents: String(flags.InitAgents),
      MaxSteps: '301',
      NumEnergyTypes: '1',
      CompressFiles: 'True',
      ComplexityType: flags.ComplexityType,
    }),
  );
}

/** Column count of a datalib file (the reader needs a table selected first). */
function positionColumnCount(golden: Golden, rel: string): number {
  const reader = golden.datalib(rel);
  const table = reader.tableNames()[0];
  if (!table) return 0;
  reader.seekTable(table);
  return reader.columnNames().length;
}

export function firstFile(golden: Golden, dir: string): string | undefined {
  return golden.files().find((f) => f.startsWith(`${dir}/`));
}

/** Datalib rows of a golden artifact, as typed values. */
export function goldenRows(golden: Golden, rel: string, table?: string): (number | string | boolean)[][] {
  const reader = golden.datalib(rel);
  const name = table ?? reader.tableNames()[0]!;
  if (!reader.seekTable(name)) throw new Error(`golden: '${rel}' has no table '${name}'`);
  return reader.allRows();
}

/** One row of `energy/food.txt` as `{ typeName: energy }`. */
export function foodEnergyRows(golden: Golden): { step: number; values: number[] }[] {
  const reader = golden.datalib('energy/food.txt');
  reader.seekTable('FoodEnergy');
  const names = reader.columnNames().slice(1);
  if (names.length === 0) throw new Error('golden: food.txt has no food-type columns');
  return reader.allRows().map((row) => ({
    step: Number(row[0]),
    values: row.slice(1).map((v) => Number(v)),
  }));
}

/** The food-type names (`energy/food.txt`'s columns, minus `Timestep`). */
export function foodTypeNames(golden: Golden): string[] {
  const reader = golden.datalib('energy/food.txt');
  reader.seekTable('FoodEnergy');
  return reader.columnNames().slice(1);
}

/** The recorded `energy/agents/agent_<n>.txt` rows, per agent number. */
export function agentEnergyRows(golden: Golden): Map<number, { step: number; energy: number; foodEnergy: number }[]> {
  const out = new Map<number, { step: number; energy: number; foodEnergy: number }[]>();
  for (const file of golden.files()) {
    const match = /^energy\/agents\/agent_(\d+)\.txt$/.exec(file);
    if (!match) continue;
    const reader = golden.datalib(file);
    reader.seekTable('AgentEnergy');
    out.set(
      Number(match[1]),
      reader.allRows().map((row) => ({
        step: Number(row[0]),
        energy: Number(row[1]),
        foodEnergy: Number(row[2]),
      })),
    );
  }
  return out;
}

/** The recorded `motion/position/agents/position_<n>.txt` rows, per agent number. */
export function agentPositionRows(golden: Golden): Map<number, { step: number; x: number; z: number }[]> {
  const out = new Map<number, { step: number; x: number; z: number }[]>();
  for (const file of golden.files()) {
    const match = /^motion\/position\/agents\/position_(\d+)\.txt$/.exec(file);
    if (!match) continue;
    const reader = golden.datalib(file);
    reader.seekTable('Positions');
    out.set(
      Number(match[1]),
      reader.allRows().map((row) => ({
        step: Number(row[0]),
        x: Number(row[1]),
        z: Number(row[2]),
      })),
    );
  }
  return out;
}

/** `events/energy.log` rows (the fixed columns plus one per energy type). */
export interface GoldenEnergyEvent {
  step: number;
  agent: number;
  action: EnergyAction;
  objectNumber: number;
  neuralActivation: number;
  energy: number[];
}

export function goldenEnergyEvents(golden: Golden): GoldenEnergyEvent[] {
  const reader = golden.datalib('events/energy.log');
  reader.seekTable('Energy');
  return reader.allRows().map((row) => {
    const token = String(row[2]);
    const action = ENERGY_ACTION_NAMES.indexOf(token);
    if (action < 0) throw new Error(`golden: unknown EnergyEvent token '${token}'`);
    return {
      step: Number(row[0]),
      agent: Number(row[1]),
      action: action as EnergyAction,
      objectNumber: Number(row[3]),
      neuralActivation: Number(row[4]),
      energy: row.slice(5).map((v) => Number(v)),
    };
  });
}

/** `energy/consumption.txt` rows — the `Eat` events' energy/energyRaw pair. */
export function goldenConsumptionRows(golden: Golden): { step: number; agent: number; foodType: string; energy: number; energyRaw: number }[] {
  const reader = golden.datalib('energy/consumption.txt');
  reader.seekTable('FoodConsumption');
  return reader.allRows().map((row) => ({
    step: Number(row[0]),
    agent: Number(row[1]),
    foodType: String(row[2]),
    energy: Number(row[3]),
    energyRaw: Number(row[4]),
  }));
}

/** `events/collisions.log` rows. */
export function goldenCollisionRows(golden: Golden): { step: number; agent: number; type: string }[] {
  const reader = golden.datalib('events/collisions.log');
  reader.seekTable('Collisions');
  return reader.allRows().map((row) => ({ step: Number(row[0]), agent: Number(row[1]), type: String(row[2]) }));
}

/** `events/carry.log` rows. */
export function goldenCarryRows(golden: Golden): { step: number; agent: number; action: string; objectType: string; objectNumber: number }[] {
  const reader = golden.datalib('events/carry.log');
  reader.seekTable('Carry');
  return reader.allRows().map((row) => ({
    step: Number(row[0]),
    agent: Number(row[1]),
    action: String(row[2]),
    objectType: String(row[3]),
    objectNumber: Number(row[4]),
  }));
}

/** `events/contacts.log` rows, with the `Events` string decoded back into the flag words. */
export function goldenContactRows(golden: Golden): { step: number; agent1: number; agent2: number; c: AgentContactEndInfo; d: AgentContactEndInfo; raw: string }[] {
  const reader = golden.datalib('events/contacts.log');
  reader.seekTable('Contacts');
  return reader.allRows().map((row) => {
    const raw = String(row[3]);
    const [left, right] = splitContactText(raw);
    return {
      step: Number(row[0]),
      agent1: Number(row[1]),
      agent2: Number(row[2]),
      c: decodeContactInfo(left, Number(row[1])),
      d: decodeContactInfo(right, Number(row[2])),
      raw,
    };
  });
}

/** `Logs::ContactLog::processEvent` emits `encode( c ) + 'C' + encode( d )`; the 'C' splits it. */
function splitContactText(raw: string): [string, string] {
  // An 'F'/'G'/'M' can never be the separator and a side never contains a capital 'C'
  // (the carry flag is lowercase), so the first 'C' is the separator.
  const at = raw.indexOf('C');
  if (at < 0) throw new Error(`golden: contacts.log row without a separator: '${raw}'`);
  return [raw.slice(0, at), raw.slice(at + 1)];
}

/** The inverse of `Logs::ContactLog::encode` — used to feed the replay. */
export function decodeContactInfo(text: string, number: number): AgentContactEndInfo {
  let mate = 0;
  let fight = 0;
  let give = 0;
  let index = 0;

  if (text[index] === 'M') {
    index++;
    mate = MATE_DESIRED_ONLY;
    while (index < text.length && text[index] !== 'F' && text[index] !== 'G') {
      const flag = text[index++]!;
      const bit = MATE_LETTERS[flag];
      if (bit === undefined) throw new Error(`golden: unknown mate flag '${flag}' in '${text}'`);
      mate |= bit;
    }
  }

  if (text[index] === 'F') {
    index++;
    fight = 1; // FIGHT__DESIRED: the word is non-zero, the desired bit is what makes it so
    while (index < text.length && text[index] !== 'G') {
      const flag = text[index++]!;
      const bit = FIGHT_LETTERS[flag];
      if (bit === undefined) throw new Error(`golden: unknown fight flag '${flag}' in '${text}'`);
      fight |= bit;
    }
  }

  if (text[index] === 'G') {
    index++;
    give = 1; // GIVE__DESIRED
    while (index < text.length) {
      const flag = text[index++]!;
      const bit = GIVE_LETTERS[flag];
      if (bit === undefined) throw new Error(`golden: unknown give flag '${flag}' in '${text}'`);
      give |= bit;
    }
  }

  return { number, mate, fight, give };
}

/** `MATE__DESIRED` — the bit that makes `mate` non-zero, so `encode` re-emits the `M`. */
const MATE_DESIRED_ONLY = 1;
const MATE_LETTERS: Record<string, number> = {
  p: MATE_PREVENTED_PARTNER,
  c: MATE_PREVENTED_CARRY,
  w: MATE_PREVENTED_MATE_WAIT,
  e: MATE_PREVENTED_ENERGY,
  f: MATE_PREVENTED_EAT_MATE_SPAN,
  i: MATE_PREVENTED_EAT_MATE_MIN_DISTANCE,
  d: MATE_PREVENTED_MAX_DOMAIN,
  x: MATE_PREVENTED_MAX_WORLD,
  t: MATE_PREVENTED_MAX_METABOLISM,
  m: MATE_PREVENTED_MISC,
  v: MATE_PREVENTED_MAX_VELOCITY,
  o: MATE_PREVENTED_WORLDFILE,
};
const FIGHT_LETTERS: Record<string, number> = {
  c: FIGHT_PREVENTED_CARRY,
  s: FIGHT_PREVENTED_SHIELD,
  p: FIGHT_PREVENTED_POWER,
};
const GIVE_LETTERS: Record<string, number> = {
  c: GIVE_PREVENTED_CARRY,
  e: GIVE_PREVENTED_ENERGY,
};

/** `events/carry.log`'s object-type tokens back to the `gobject` bit vocabulary. */
export function carryObjectTypeBit(token: string): number {
  const index = CARRY_OBJECT_TYPE_TOKENS.indexOf(token);
  if (index < 0) throw new Error(`golden: unknown carry object token '${token}'`);
  return [GObjectType.AGENT, GObjectType.FOOD, GObjectType.BRICK][index]!;
}

/** `events/carry.log`'s Action tokens back to `CarryEvent::Action`. */
export function carryActionIndex(token: string): number {
  const index = CARRY_ACTION_NAMES.indexOf(token);
  if (index < 0) throw new Error(`golden: unknown carry action token '${token}'`);
  return index;
}

/** A `gobject` whose type/typeNumber the replay controls. */
export class FakeObject implements LogGameObject {
  constructor(
    private readonly bit: number,
    private readonly typeNum: number,
  ) {}

  type(): number {
    return this.bit;
  }

  typeNumber(): number {
    return this.typeNum;
  }
}

/** `genome/genestats.txt`'s per-step mean/stddev pairs, keyed by step. */
export function genestatsRows(golden: Golden): Map<number, { mean: number[]; stddev: number[] }> {
  const lines = golden.lines('genome/genestats.txt');
  const out = new Map<number, { mean: number[]; stddev: number[] }>();
  const header = Number(lines[0]);
  if (!Number.isFinite(header)) throw new Error('golden: genestats.txt has no size header');

  for (const line of lines.slice(1)) {
    const parts = line.split(' ');
    const step = Number(parts[0]);
    const mean: number[] = [];
    const stddev: number[] = [];
    for (const pair of parts.slice(1)) {
      const [m, s] = pair.split(',');
      mean.push(Number(m));
      stddev.push(Number(s));
    }
    out.set(step, { mean, stddev });
  }
  return out;
}

/** `genome/separations.txt`'s tables: agent number -> cached separations (other agent -> value). */
export function separationsTables(golden: Golden): Map<number, Map<number, number>> {
  const reader = golden.datalib('genome/separations.txt');
  const out = new Map<number, Map<number, number>>();
  for (const name of reader.tableNames()) {
    reader.seekTable(name);
    const entries = new Map<number, number>();
    for (const row of reader.allRows()) entries.set(Number(row[0]), Number(row[1]));
    out.set(Number(name), entries);
  }
  return out;
}

/**
 * Stage a candidate run tree under `dir` (the tree `oracle/run_parity.sh` checks).
 *
 * t_37bf7212: this is the wipe the card is about — `rmSync(recursive)` then write-as-you-go. It
 * therefore refuses a staging root that resolves into a frozen golden (or the oracle's own
 * namespace): with `POLYWORLD_LOGS_CANDIDATE_ROOT=<oracle>` the replay's candidate *was* the
 * golden, wiped and rebuilt in place. Allowed: `$TMPDIR` and `oracle/_t_*`.
 */
export function freshDir(dir: string): string {
  assertUsableStagingRoot(dir, `freshDir (a candidate tree stages here)`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
