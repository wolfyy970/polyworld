/**
 * Lane L12 (logs) — the *seams*: every cross-lane interface the recorders touch.
 *
 * `src/library/logs/**` is 2,797 lines of recorder code whose only job is to turn simulation
 * events into bytes. It reads a great deal of other lanes' state (`agent`, `brain`,
 * `genome::Genome`, `Energy`, `FoodType`, `TSimulation`, `objectxsortedlist`) and writes it
 * through `FILE *`, `AbstractFile` and `DataLibWriter`. Those reads are the lane boundary, so
 * they are declared here — as the *smallest* interface per collaborator that the recorders
 * actually use — instead of importing another lane's module. A lane that implements an
 * interface (`agent`, `sim`, `brain`, `genome`) or a test that fakes one binds it here.
 *
 * PORT-NOTE(l12/seam-not-import): native `Logs.cc` includes `agent/agent.h`,
 * `brain/Brain.h`, `genome/GenomeUtil.h`, `sim/Simulation.h`, `utils/datalib.h` and walks
 * concrete objects. The port keeps lane independence (PORT_PLAN "interface cuts"): the
 * recorders see `LogAgent`, `LogSimulation`, … and never a concrete class. Nothing here
 * *decides* model behaviour — the methods are named after the native call site
 * (`a->Number()` -> `number()`) so a reviewer can diff the recorder line by line with the
 * C++ still on screen.
 *
 * PORT-NOTE(l12/file-system-seam): native's three file kinds are `fopen` (FileLogger and
 * DataLibWriter), `AbstractFile::open( globals::recordFileType, … )` (AbstractFileLogger,
 * i.e. gzip when `CompressFiles True`) and the `::link`/`::rename`/`stat` statics of
 * `AbstractFile`. All of them become one `RecordFileSystem` seam, so the recorders hold no
 * `node:fs` (the browser lane supplies its own implementation, exactly like W1c's `ByteSink`)
 * and a test can record into memory. A browser implementation must write gzip through
 * `gzipContainer` (`src/model/compress/zlibDeflate.ts`), never `CompressionStream`
 * (`'gzip'`/`'deflate-raw'` are a different deflate): see
 * PORT-NOTE(zlib-deflate/upstream-transcription) in that module.
 */

import type { DataLibWriter } from '../datalib';
import type { EventType } from '../types';
import type { BirthReason, DeathReason } from '../types/lifespan';

//===========================================================================
// File system
//===========================================================================

/**
 * A value a native `printf`-style call can hand a sink. This is lane L6's `CValue`
 * (`brain/core/cformat.ts`) spelled structurally, so this seam file needs no lane's module for it;
 * the two are interchangeable and only ever meet at a `TextSink.printf` call.
 */
export type PrintfArg = number | string;

/** Native `FILE *` / `AbstractFile` as a text sink (native `fprintf`, `fflush`, `fclose`). */
export interface TextSink {
  /**
   * Native's two `fprintf` shapes:
   *
   *  - `fprintf( file, "%s", text )` — the recorder formats the text itself. Pass no extra
   *    arguments and the text is written verbatim (`%` is literal: `'% Timestep Event Agent# …'`
   *    is a real line of `BirthsDeaths.log`).
   *  - `fprintf( file, format, ...values )` — the writer supplies the values and the sink applies
   *    the C format (`complexity/adami.cc`, every `Brain::dump*`). Pass them and the sink formats;
   *    see PORT-NOTE(l12/text-sink-format) in `formatSink.ts`.
   *
   * A sink the lane's logger bases hand out accepts both shapes; one opened directly through
   * `RecordFileSystem.openPlain/openAbstract` is the raw backend sink and is only used by
   * pre-formatted call sites.
   */
  printf(text: string, ...args: readonly PrintfArg[]): void;
  /** Native `fflush( FILE * )` / `AbstractFile::flush( full )`. */
  flush(full?: boolean): void;
  /** Native `fclose( FILE * )` / `delete AbstractFile`. Idempotent. */
  close(): void;
}

/** Native `SYSTEM( cmd )` (`utils/misc.h:135`) — run a shell command, fail loudly. */
export type SystemCommand = (command: string) => void;

/**
 * The file side of the recorders. Native reaches these through `Logger`'s base classes and
 * `AbstractFile`'s statics; see PORT-NOTE(l12/file-system-seam).
 */
export interface RecordFileSystem {
  /** Native `makeParentDir( path )` (`utils/misc.cc`). */
  makeParentDir(path: string): void;
  /** Native `makeDirs( path )` (`utils/misc.cc`) — every level, not just the parent. */
  makeDirs(path: string): void;

  /** Native `fopen( path, mode )` — `FileLogger::createFile` and `DataLibWriter`. */
  openPlain(path: string, mode: 'w' | 'a'): TextSink;
  /**
   * Native `AbstractFile::open( globals::recordFileType, path, mode )` — plain or `.gz`
   * depending on the run's `CompressFiles`.
   */
  openAbstract(path: string, mode: 'w' | 'a'): TextSink;

  /** Native `new DataLibWriter( path, randomAccess, singleSchema )`. */
  openDataLib(path: string, randomAccess: boolean, singleSchema: boolean): DataLibWriter;

  /** Native `AbstractFile::exists( abstractPath )` — true for either backend. */
  exists(abstractPath: string): boolean;
  /** Native `AbstractFile::link( old, new )` — `::link`, refuses an existing target. */
  link(oldAbstractPath: string, newAbstractPath: string): number;
  /** Native `AbstractFile::rename( old, new )` — `::rename`, refuses an existing target. */
  rename(oldAbstractPath: string, newAbstractPath: string): number;
  /** Native `AbstractFile::unlink( abstractPath )`. */
  unlink(abstractPath: string): number;

  /** Native `SYSTEM( cmd )` (`utils/misc.h:135`). */
  system: SystemCommand;
}

//===========================================================================
// Energy / food
//===========================================================================

/** Native `Energy` (`environment/Energy.h`) as the recorders read it. */
export interface LogEnergy {
  /** Native `Energy::sum()`. */
  sum(): number;
  /** Native `Energy::operator[]( int )` — one energy-type slot. */
  at(index: number): number;
}

/** Native `FoodType` (`environment/FoodType.h`) — the two fields the recorders log. */
export interface LogFoodType {
  /** Native `FoodType::index` (`food.txt` column order, `consumption.txt` rows). */
  readonly index: number;
  /** Native `FoodType::name`. */
  readonly name: string;
}

/** Native `FoodType`'s static definition table (`getNumberDefinitions`/`get`). */
export interface LogFoodTypeRegistry {
  /** Native `FoodType::getNumberDefinitions()`. */
  getNumberDefinitions(): number;
  /** Native `FoodType::get( index )` — native asserts the index is in range. */
  get(index: number): LogFoodType;
}

/** Native `food` (`environment/Food.h`) as `FoodEnergyLog`/`FoodConsumptionLog` read it. */
export interface LogFood {
  /** Native `food::getType()`. */
  type(): LogFoodType;
  /** Native `food::getEnergy().sum()`. */
  energySum(): number;
}

//===========================================================================
// Agents and world objects
//===========================================================================

/** Native `LifeSpan::LifeSpanEvent` — one endpoint of an agent's life. */
export interface LogLifeSpanEvent {
  step: number;
  reason: BirthReason | DeathReason;
}

/** Native `LifeSpan` (`agent/LifeSpan.h`). */
export interface LogLifeSpan {
  readonly birth: LogLifeSpanEvent;
  readonly death: LogLifeSpanEvent;
}

/** Native `graphics/gobject` as `CarryLog`/`CollisionLog`/`EnergyLog` read it. */
export interface LogGameObject {
  /** Native `gobject::getType()` — the `AGENTTYPE`/`FOODTYPE`/`BRICKTYPE` **bit**. */
  type(): number;
  /** Native `gobject::getTypeNumber()`. */
  typeNumber(): number;
}

/** Native `brain/Brain.h` — the four recording entry points the brain loggers call. */
export interface LogBrain {
  /** Native `Brain::dumpAnatomical( AbstractFile *, long number, float fitness )`. */
  dumpAnatomical(file: TextSink, agentNumber: number, fitness: number): void;
  /** Native `Brain::dumpSynapses( AbstractFile *, long number )`. */
  dumpSynapses(file: TextSink, agentNumber: number): void;
  /** Native `Brain::startFunctional( AbstractFile *, long number )`. */
  startFunctional(file: TextSink, agentNumber: number): void;
  /** Native `Brain::writeFunctional( AbstractFile * )`. */
  writeFunctional(file: TextSink): void;
  /** Native `Brain::endFunctional( AbstractFile *, float fitness )`. */
  endFunctional(file: TextSink, fitness: number): void;
}

/** Native `genome::Genome` as the recorders read it (`GenomeLog`, `GenomeSubsetLog`). */
export interface LogGenome {
  /** Native `Genome::dump( AbstractFile * )` (`run/genome/agents/genome_N.txt`). */
  dump(file: TextSink): void;
  /** Native `Genome::get_raw_uint( int index )` — the `GenomeSubsetLog` gene values. */
  getRawUint(index: number): number;
  /** Native `Genome::separation( Genome & )` — the metric `SeparationCache` memoises. */
  separation(other: LogGenome): number;
}

/** `agent::brainAnalysisParms` (`agent/agent.h`) — the one field the log lane writes. */
export interface LogBrainAnalysisParms {
  /** Native `brainAnalysisParms.functionPath` — read back by the complexity lane. */
  functionPath: string;
}

/**
 * Native `agent` (`agent/agent.h`) as `logs/**` reads it. Every method is a native call
 * site; nothing here is invented.
 */
export interface LogAgent {
  /** Native `agent::Number()` — the agent's log identity. */
  number(): number;
  /** Native `gobject::getTypeNumber()` — the file name suffix (`agent_<n>.txt`). */
  typeNumber(): number;
  /** Native `gobject::x()` / `y()` / `z()`. */
  x(): number;
  y(): number;
  z(): number;
  /** Native `agent::GetEnergy()`. */
  energy(): LogEnergy;
  /** Native `agent::GetFoodEnergy()`. */
  foodEnergy(): LogEnergy;
  /** Native `agent::GetMaxEnergy()`. */
  maxEnergy(): LogEnergy;
  /** Native `agent::GetLifeSpan()`. */
  lifeSpan(): LogLifeSpan;
  /** Native `agent::Genes()`. */
  genes(): LogGenome;
  /** Native `agent::GetBrain()`. */
  brain(): LogBrain;
  /** Native `agent::CurrentHeuristicFitness()`. */
  heuristicFitness(): number;
  /** Native `agent::Complexity()` (`BrainComplexityLog`). */
  complexity(): number;
  /** Native `agent::brainAnalysisParms`. */
  readonly brainAnalysisParms: LogBrainAnalysisParms;
}

//===========================================================================
// Genome schema (lane L5) — the meta/genestats recorders
//===========================================================================

/** Where a genome printer writes (native `FILE *`); L5's printers take the same shape. */
export interface TextOutput {
  write(text: string): void;
}

/** Native `gene::GeneSchema` as `GeneStatsLog`/`GenomeMetaLog`/`GenomeSubsetLog` read it. */
export interface LogGeneSchema {
  /** Native `GeneSchema::getMutableSize()` — the `genestats.txt` header and column count. */
  getMutableSize(): number;
  /** Native `GeneSchema::getIndexes( geneNames )` — a gene index per name (-1 if unknown). */
  getIndexes(geneNames: readonly string[]): number[];
  /** Native `GeneSchema::printIndexes( out, layout )` — `geneindex.txt` / `genelayout.txt`. */
  printIndexes(out: TextOutput, layout?: unknown, prefix?: string): void;
  /** Native `GeneSchema::printTitles( out )` — `genetitle.txt`. */
  printTitles(out: TextOutput, prefix?: string): void;
  /** Native `GeneSchema::printRanges( out )` — `generange.txt`. */
  printRanges(out: TextOutput, prefix?: string): void;
}

/** Native `GenomeUtil`'s two statics that the loggers use. */
export interface LogGenomeUtil {
  /** Native `GenomeUtil::schema`. */
  readonly schema: LogGeneSchema | null;
  /** Native `GenomeUtil::layout` — `printIndexes`' second argument. */
  readonly layout: unknown;
}

//===========================================================================
// Simulation (lane L11)
//===========================================================================

/** Native `sim::FitnessScope` (`sim/simconst.h:18`). */
export const FitnessScope = {
  OVERALL: 0,
  RECENT: 1,
} as const;

export type FitnessScope = (typeof FitnessScope)[keyof typeof FitnessScope];

/** Native `FitStruct` (`sim/FittestList.h`) — the fields the loggers read. */
export interface LogFitStruct {
  agentID: number;
  complexity: number;
  fitness: number;
}

/**
 * Native `FittestList` (`sim/FittestList.h`).
 *
 * PORT-NOTE(l12/fittest-size-spelling): native's accessor is `size()`. Lane L11's `FittestList`
 * keeps a private `size` field, so it exposes the same value as `getSize()`; the fan-in lane
 * takes the sim lane's spelling rather than forcing a rename in a file it does not own, and
 * this is the only name the port has for it.
 */
export interface LogFittestList {
  getSize(): number;
  get(rank: number): LogFitStruct;
}

/**
 * Native `GeneStats` (`sim/GeneStats.h`) — the per-gene accumulator `genestats.txt` logs.
 * `ArrayLike<number>` rather than `number[]`: native hands out a `float *` and L11's port uses
 * a `Float64Array`, whose elements are already the f32 values.
 */
export interface LogGeneStats {
  /** Native `GeneStats::init( int maxAgents )`. */
  init(maxAgents: number): void;
  /** Native `GeneStats::getMean()` — one mean per mutable gene. */
  getMean(): ArrayLike<number>;
  /** Native `GeneStats::getStddev()`. */
  getStddev(): ArrayLike<number>;
}

/** Native `TSimulation` (`sim/Simulation.h`) as `logs/**` reads it. */
export interface LogSimulation {
  /** Native `TSimulation::getStep()`. */
  step(): number;
  /** Native `TSimulation::getEpoch()`. */
  epoch(): number;
  /** Native `TSimulation::getNumAgents()`. */
  numAgents(): number;
  /** Native `TSimulation::GetMaxAgents()`. */
  maxAgents(): number;
  /** Native `TSimulation::getGeneStats()`. */
  geneStats(): LogGeneStats;
  /** Native `TSimulation::getFittest( scope )`. */
  fittest(scope: FitnessScope): LogFittestList;
  /** Native `TSimulation::enableComplexityCalculations()`. */
  enableComplexityCalculations(): void;
}

/** A mutable single-slot box, i.e. the `gobject **` out-parameter of `nextObj`. */
export interface Ref<T> {
  value: T;
}

/**
 * Native `objectxsortedlist::gXSortedObjects`' walk idiom, as one helper:
 *
 *   gXSortedObjects.reset();
 *   while( gXSortedObjects.nextObj( type, (gobject **) &obj ) ) { ... }
 */
export function forEachSorted(list: LogSortedObjectList, type: number, visit: (obj: unknown) => void): void {
  list.reset();
  const out: Ref<unknown> = { value: null };
  while (list.next(type, out)) visit(out.value);
}

/**
 * Native `objectxsortedlist::gXSortedObjects` (the single global sorted object list).
 *
 * PORT-NOTE(l12/sorted-list-order): `AgentEnergyLog`/`FoodEnergyLog`/`BrainFunctionLog`'s
 * `SimEndEvent` handler walk the world in **x-sorted order** and the recorders therefore
 * write rows in that order — the order is model behaviour (PORT_SPEC rule 4). The port takes
 * the walk as a callback (`forEach(AGENTTYPE, …)`) rather than owning the container, so the
 * list stays the sim/environment lane's and the recorder cannot accidentally impose a
 * different order. `reset()` is native's `gXSortedObjects.reset()`.
 */
export interface LogSortedObjectList {
  /** Native `objectxsortedlist::gXSortedObjects.reset()`. */
  reset(): void;
  /**
   * Native `nextObj( type, (gobject **) &obj )` — `true` while objects of `type` remain, in
   * the list's own (x-sorted) order. `out.value` receives the object.
   */
  next(type: number, out: Ref<unknown>): boolean;
}

/** Native `computeAdamiComplexity` (`complexity/adami.cc`) — lane L13's entry point. */
export type ComputeAdamiComplexity = (
  timestep: number,
  oneBit: TextSink,
  twoBit: TextSink,
  fourBit: TextSink,
  summary: TextSink,
) => void;

//===========================================================================
// The run's log environment
//===========================================================================

/**
 * Everything a recorder reaches *outside* the events it receives: the file backends, the
 * global sorted object list, `GenomeUtil`'s schema, `FoodType`'s definition table and the
 * complexity entry point.
 *
 * PORT-NOTE(l12/log-environment): native reaches all of these as process globals
 * (`objectxsortedlist::gXSortedObjects`, `GenomeUtil::schema`, `FoodType`'s statics,
 * `computeAdamiComplexity`) and the loggers' constructors take no arguments at all. The port
 * keeps one `LogContext` per run and hands it to every recorder, because (a) the file seam
 * has to be injectable for a browser/headless run, and (b) a replay harness can then drive
 * the exact same recorders with the recorded scenario's values. The recorder bodies are
 * otherwise a literal transcription: `this.env.world` *is* `gXSortedObjects` at the call
 * sites that used it.
 */
export interface LogContext {
  readonly fs: RecordFileSystem;
  readonly world: LogSortedObjectList;
  readonly genomeUtil: LogGenomeUtil;
  readonly foodTypes: LogFoodTypeRegistry;
  readonly computeAdamiComplexity: ComputeAdamiComplexity;
}

//===========================================================================
// Events
//===========================================================================

/** Re-exported so a recorder's `processEvent` switch can name the bits it registered for. */
export type { EventType };
