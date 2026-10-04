/**
 * Lane L12 (logs) — the `Logs` class (`logs/Logs.{h,cc}`): the run's recorder set.
 *
 * Native's `Logs` is the whole log lane in one object, and its central trick is that the
 * recorders are *members*: merely declaring them constructs them, and a `Logger`'s
 * constructor installs itself into the process-wide registry. `Logs`' own constructor then
 * resets the registered-event mask and calls `init( sim, doc )` on every installed logger, in
 * install order:
 *
 *   logs = new Logs( this, worldfile );        // TSimulation::TSimulation
 *   ...
 *   logs->postEvent( StepEndEvent() );         // the sim's step loop
 *   delete logs;                               // TSimulation::~TSimulation
 *
 * The port keeps all three parts: the recorders are constructed (in native's declaration
 * order) by `createLogs`, each one installs itself, `Logs` walks them in order at init, and
 * `dispose()` mirrors `~Logs` — member destructors run in **reverse** declaration order,
 * which is the order native closes its files in.
 *
 * PORT-NOTE(l12/recorder-construction-order): the field order below is `Logs.h`'s member
 * order, and it is observable: it is the order recorders appear in `_installedLoggers`, which
 * is the dispatch order within one event type and the order `getMaxOpenFiles()` sums in. It is
 * not cosmetic, so do not sort it.
 */

import { clearInstalledLoggers, installLogger, maxOpenFiles, postEvent, resetEventMask } from './registry';
import { AgentEnergyLog, AgentMaxEnergyLog, AgentPositionLog, BirthsDeathsLog, LifeSpanLog, PopulationLog } from './agentLogs';
import { BrainAnatomyLog, BrainComplexityLog, BrainFunctionLog, SynapseLog } from './brainLogs';
import { CarryLog, CollisionLog, ContactLog, EnergyLog, FoodConsumptionLog, FoodEnergyLog } from './eventLogs';
import { GeneStatsLog, GenomeLog, GenomeMetaLog, GenomeSubsetLog, SeparationLog } from './genomeLogs';
import { AdamiComplexityLog, GitRevisionLog } from './simLogs';
import type { Config, SimEvent } from '../types';
import type { LogContext, LogSimulation } from './seams';

/** Native's global `Logs *logs` (`logs/Logs.cc:30`). */
export let logs: Logs | null = null;

/** Native `class Logs`. */
export class Logs {
  // --- members, in Logs.h declaration order (see PORT-NOTE(l12/recorder-construction-order))
  readonly adamiComplexity: AdamiComplexityLog;
  readonly agentEnergy: AgentEnergyLog;
  readonly agentMaxEnergy: AgentMaxEnergyLog;
  readonly agentPosition: AgentPositionLog;
  readonly birthsDeaths: BirthsDeathsLog;
  readonly brainAnatomy: BrainAnatomyLog;
  readonly brainComplexity: BrainComplexityLog;
  readonly brainFunction: BrainFunctionLog;
  readonly carry: CarryLog;
  readonly collision: CollisionLog;
  readonly contact: ContactLog;
  readonly energy: EnergyLog;
  readonly foodConsumption: FoodConsumptionLog;
  readonly foodEnergy: FoodEnergyLog;
  readonly geneStats: GeneStatsLog;
  readonly genome: GenomeLog;
  readonly genomeMeta: GenomeMetaLog;
  readonly genomeSubset: GenomeSubsetLog;
  readonly gitRevision: GitRevisionLog;
  readonly lifespan: LifeSpanLog;
  readonly population: PopulationLog;
  readonly separation: SeparationLog;
  readonly synapse: SynapseLog;

  /** The recorders in construction order — what `getMaxOpenFiles()` and `dispose()` walk. */
  private readonly recorders: readonly LoggerLike[];

  constructor(
    private readonly sim: LogSimulation,
    doc: Config,
    env: LogContext,
  ) {
    if (logs !== null) throw new Error('logs: more than one Logs instance (native asserts logs == NULL)');

    resetEventMask();

    this.adamiComplexity = new AdamiComplexityLog(env);
    this.agentEnergy = new AgentEnergyLog(env);
    this.agentMaxEnergy = new AgentMaxEnergyLog(env);
    this.agentPosition = new AgentPositionLog(env);
    this.birthsDeaths = new BirthsDeathsLog(env);
    this.brainAnatomy = new BrainAnatomyLog(env);
    this.brainComplexity = new BrainComplexityLog(env);
    this.brainFunction = new BrainFunctionLog(env);
    this.carry = new CarryLog(env);
    this.collision = new CollisionLog(env);
    this.contact = new ContactLog(env);
    this.energy = new EnergyLog(env);
    this.foodConsumption = new FoodConsumptionLog(env);
    this.foodEnergy = new FoodEnergyLog(env);
    this.geneStats = new GeneStatsLog(env);
    this.genome = new GenomeLog(env);
    this.genomeMeta = new GenomeMetaLog(env);
    this.genomeSubset = new GenomeSubsetLog(env);
    this.gitRevision = new GitRevisionLog(env);
    this.lifespan = new LifeSpanLog(env);
    this.population = new PopulationLog(env);
    this.separation = new SeparationLog(env);
    this.synapse = new SynapseLog(env);

    this.recorders = [
      this.adamiComplexity,
      this.agentEnergy,
      this.agentMaxEnergy,
      this.agentPosition,
      this.birthsDeaths,
      this.brainAnatomy,
      this.brainComplexity,
      this.brainFunction,
      this.carry,
      this.collision,
      this.contact,
      this.energy,
      this.foodConsumption,
      this.foodEnergy,
      this.geneStats,
      this.genome,
      this.genomeMeta,
      this.genomeSubset,
      this.gitRevision,
      this.lifespan,
      this.population,
      this.separation,
      this.synapse,
    ];

    logs = this;

    // Native `Logs::Logs`: `itfor( LoggerList, _installedLoggers, it ) (*it)->init( sim, doc );`
    for (const logger of this.recorders) logger.init(this.sim, doc);
  }

  /**
   * Native `Logs::postEvent( const T &e )`. The port's `postEvent` takes the union and routes
   * on the tag (see `registry.ts`); the sim lane calls this exactly where native calls
   * `logs->postEvent( … )`.
   */
  postEvent(event: SimEvent): void {
    postEvent(event);
  }

  /** Native `Logs::getMaxOpenFiles()` — the sum over every installed logger. */
  getMaxOpenFiles(): number {
    return maxOpenFiles();
  }

  /**
   * Native `Logs::~Logs` plus the members' destructors: reverse declaration order, then the
   * installed list is cleared and the global pointer nulled. Native does not reset
   * `_registeredEvents` here, and neither does the port.
   */
  dispose(): void {
    for (let i = this.recorders.length - 1; i >= 0; i--) this.recorders[i]!.close();
    clearInstalledLoggers();
    logs = null;
  }
}

/** The slice of a recorder `Logs` itself uses (the base `Logger` API). */
interface LoggerLike {
  init(sim: LogSimulation, doc: Config): void;
  close(): void;
}

/**
 * Test hook: forget the singleton without running the destructors, so a test can build the next
 * `Logs` from the same t0 state a fresh process has (`dispose()` is the production path).
 */
export function resetLogsSingletonForTests(): void {
  logs = null;
}

/** Native `Logs::installLogger` — exposed for a lane that needs a logger outside `Logs`. */
export { installLogger };
