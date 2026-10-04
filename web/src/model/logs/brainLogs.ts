/**
 * Lane L12 (logs) — the brain recorders (`logs/Logs.cc`):
 *
 *   Logs::BrainAnatomyLog      run/brain/anatomy/brainAnatomy_<agent>_<suffix>.txt[.gz]
 *                              + the `bestRecent`/`bestSoFar` link trees
 *   Logs::BrainFunctionLog     run/brain/function/{incomplete_,}brainFunction_<agent>.txt[.gz]
 *                              + the `Recent/<epoch>` and `bestRecent`/`bestSoFar` links
 *   Logs::BrainComplexityLog   run/brain/Recent/<epoch>/complexity_<type>.plt,
 *                              run/brain/bestRecent/complexity.txt
 *   Logs::SynapseLog           run/brain/synapses/synapses_<agent>_<suffix>.txt[.gz]
 *
 * The *contents* of these files are the brain lane's (L6's `Brain` dumps); this lane owns the
 * file names, the suffixes, which event triggers which dump, the `learningMode` gates, the
 * rename/link bookkeeping, and the fact that all four go through `AbstractFile` (so they are
 * gzipped when `CompressFiles True` — the recorded scenarios are).
 *
 * PORT-NOTE(l12/brain-file-naming): the suffix set is `{incept, birth, death}` and the index
 * in the `bestRecent`/`bestSoFar` trees is the *rank in the fittest list* (`i`), not the agent
 * number — `%d_brainAnatomy_%ld_%s.txt`. The port keeps both facts literally; they are the
 * only way to name the 308 files under `brain/bestSoFar/`.
 *
 * PORT-NOTE(l12/link-and-rename-refuse): native's `AbstractFile::link`/`::rename` are raw
 * `::link`/`::rename` that do nothing when the destination already exists or the source is
 * ambiguous (both backends present). The port routes both through the file seam, so a
 * re-run into a non-empty tree keeps native's "first writer wins" behaviour instead of
 * overwriting.
 */

import {
  ColumnType,
  Event_AgentGrown,
  Event_BrainAnalysisBegin,
  Event_BrainAnalysisEnd,
  Event_BrainGrown,
  Event_BrainUpdated,
  Event_EpochEnd,
  Event_SimEnd,
  GObjectType,
} from '../types';
import type {
  AgentGrownEvent,
  BrainAnalysisBeginEvent,
  BrainAnalysisEndEvent,
  BrainGrownEvent,
  BrainUpdatedEvent,
  Config,
  EpochEndEvent,
  SimEvent,
} from '../types';
import { formatFixed } from '../datalib';
import { LearningMode, brainConfig } from '../brain/core';
import { AbstractFileLogger, DataLibLogger, StateScope } from './logger';
import { FitnessScope, forEachSorted, type LogAgent, type LogContext, type LogSimulation } from './seams';

/** Native's `prefixes[]` in `recordEpochFittest` — the anatomy suffixes, in order. */
export const ANATOMY_SUFFIXES: readonly string[] = ['incept', 'birth', 'death'];

/**
 * `Logs::BrainAnatomyLog::processEvent( const BrainAnalysisBeginEvent & )`'s gate and
 * `BrainGrownEvent`'s gate both read `Brain::config.learningMode` (lane L6's singleton).
 */
function learningMode(): LearningMode {
  return brainConfig.learningMode;
}

/** Native `Logs::BrainAnatomyLog`. */
export class BrainAnatomyLog extends AbstractFileLogger {
  private _recordRecent = false;
  private _recordBestRecent = false;
  private _recordBestSoFar = false;

  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordBrainAnatomy')) {
      this._recordRecent = doc.getBool('RecordBrainRecent');
      this._recordBestRecent = doc.getBool('RecordBrainBestRecent');
      this._recordBestSoFar = doc.getBool('RecordBrainBestSoFar');

      if (this._recordBestRecent || this._recordBestSoFar) {
        this.initRecording(
          sim,
          StateScope.NULL,
          Event_BrainGrown | Event_AgentGrown | Event_BrainAnalysisBegin | Event_EpochEnd,
        );
      } else {
        this.initRecording(sim, StateScope.NULL, Event_BrainGrown | Event_AgentGrown | Event_BrainAnalysisBegin);
      }
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_BrainGrown:
        return this.onBrainGrown(event as BrainGrownEvent<LogAgent>);
      case Event_AgentGrown:
        return this.onAgentGrown(event as AgentGrownEvent<LogAgent>);
      case Event_BrainAnalysisBegin:
        return this.onBrainAnalysisBegin(event as BrainAnalysisBeginEvent<LogAgent>);
      case Event_EpochEnd:
        return this.onEpochEnd(event as EpochEndEvent);
      default:
        return super.processEvent(event);
    }
  }

  /** Native `processEvent( const BrainGrownEvent & )`. */
  private onBrainGrown(e: BrainGrownEvent<LogAgent>): void {
    if (learningMode() !== LearningMode.LEARN_NONE) this.createAnatomyFile(e.a, 'incept', 0.0);
  }

  /** Native `processEvent( const AgentGrownEvent & )`. */
  private onAgentGrown(e: AgentGrownEvent<LogAgent>): void {
    this.createAnatomyFile(e.a, 'birth', 0.0);
  }

  /** Native `processEvent( const BrainAnalysisBeginEvent & )`. */
  private onBrainAnalysisBegin(e: BrainAnalysisBeginEvent<LogAgent>): void {
    if (learningMode() === LearningMode.LEARN_ALL) {
      this.createAnatomyFile(e.a, 'death', e.a.heuristicFitness());
    }
  }

  /** Native `processEvent( const EpochEndEvent & )`. */
  private onEpochEnd(e: EpochEndEvent): void {
    if (this._recordBestRecent) this.recordEpochFittest(e.epoch, FitnessScope.RECENT, 'bestRecent');
    if (this._recordBestSoFar) this.recordEpochFittest(e.epoch, FitnessScope.OVERALL, 'bestSoFar');
  }

  /** Native `BrainAnatomyLog::createAnatomyFile( agent *a, const char *suffix, float fitness )`. */
  private createAnatomyFile(a: LogAgent, suffix: string, fitness: number): void {
    const path = `run/brain/anatomy/brainAnatomy_${a.number()}_${suffix}.txt`;

    const file = this.createFile(path);
    a.brain().dumpAnatomical(file, a.number(), fitness);
    file.close(); // native `delete file`
  }

  /** Native `BrainAnatomyLog::recordEpochFittest( long step, FitnessScope, const char * )`. */
  private recordEpochFittest(step: number, scope: FitnessScope, scopeName: string): void {
    const fittest = this.simulation().fittest(scope);

    this.env.fs.makeDirs(`run/brain/${scopeName}/${step}`);
    for (let i = 0; i < fittest.getSize(); i++) {
      const agentID = fittest.get(i).agentID;
      for (const prefix of ANATOMY_SUFFIXES) {
        const source = `run/brain/anatomy/brainAnatomy_${agentID}_${prefix}.txt`;
        const target = `run/brain/${scopeName}/${step}/${i}_brainAnatomy_${agentID}_${prefix}.txt`;
        if (this.env.fs.exists(source)) this.env.fs.link(source, target);
      }
    }
  }
}

/** Native `Logs::BrainFunctionLog`. */
export class BrainFunctionLog extends AbstractFileLogger {
  private _recordRecent = false;
  private _recordBestRecent = false;
  private _recordBestSoFar = false;
  private _nseeds = 0;

  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordBrainFunction')) {
      this._recordRecent = doc.getBool('RecordBrainRecent');
      this._recordBestRecent = doc.getBool('RecordBrainBestRecent');
      this._recordBestSoFar = doc.getBool('RecordBrainBestSoFar');
      this._nseeds = doc.getInt('InitAgents');

      if (this._recordBestRecent || this._recordBestSoFar) {
        this.initRecording(
          sim,
          StateScope.AGENT,
          Event_AgentGrown | Event_BrainUpdated | Event_BrainAnalysisBegin | Event_EpochEnd | Event_SimEnd,
        );
      } else {
        this.initRecording(
          sim,
          StateScope.AGENT,
          Event_AgentGrown | Event_BrainUpdated | Event_BrainAnalysisBegin | Event_SimEnd,
        );
      }
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_AgentGrown:
        return this.onAgentGrown(event as AgentGrownEvent<LogAgent>);
      case Event_BrainUpdated:
        return this.onBrainUpdated(event as BrainUpdatedEvent<LogAgent>);
      case Event_BrainAnalysisBegin:
        return this.onBrainAnalysisBegin(event as BrainAnalysisBeginEvent<LogAgent>);
      case Event_EpochEnd:
        return this.onEpochEnd(event as EpochEndEvent);
      case Event_SimEnd:
        return this.onSimEnd();
      default:
        return super.processEvent(event);
    }
  }

  /** Native `processEvent( const AgentGrownEvent & )` — start recording this agent's function. */
  private onAgentGrown(e: AgentGrownEvent<LogAgent>): void {
    const path = `run/brain/function/incomplete_brainFunction_${e.a.number()}.txt`;

    const file = this.createFileFor(e.a, path);
    e.a.brain().startFunctional(file, e.a.number());
  }

  /** Native `processEvent( const BrainUpdatedEvent & )`. */
  private onBrainUpdated(e: BrainUpdatedEvent<LogAgent>): void {
    const file = this.getFileFor(e.a);
    e.a.brain().writeFunctional(file);
  }

  /** Native `processEvent( const BrainAnalysisBeginEvent & )` — finalize, rename, link. */
  private onBrainAnalysisBegin(e: BrainAnalysisBeginEvent<LogAgent>): void {
    const a = e.a;
    const file = this.getFileFor(a);

    a.brain().endFunctional(file, a.heuristicFitness());
    file.close(); // native `delete file`
    // "The file is gone: clear the agent's slot so the end-of-run cleanup in
    //  processEvent(SimEndEvent) doesn't delete the same pointer a second time."
    this.setAgentState(a, null);

    const incomplete = `run/brain/function/incomplete_brainFunction_${a.number()}.txt`;
    const finished = `run/brain/function/brainFunction_${a.number()}.txt`;
    this.env.fs.rename(incomplete, finished);

    // "Simulation needs this path for calculating complexity."
    a.brainAnalysisParms.functionPath = finished;

    if (this._recordRecent) {
      const recent = `run/brain/Recent/${this.simulation().epoch()}/brainFunction_${a.number()}.txt`;
      this.env.fs.makeParentDir(recent);
      this.env.fs.link(finished, recent);

      if (a.number() <= this._nseeds) {
        const initial = `run/brain/Recent/0/brainFunction_${a.number()}.txt`;
        this.env.fs.makeParentDir(initial);
        this.env.fs.link(finished, initial);
      }
    }
  }

  /** Native `processEvent( const EpochEndEvent & )`. */
  private onEpochEnd(e: EpochEndEvent): void {
    if (this._recordBestRecent) this.recordEpochFittest(e.epoch, FitnessScope.RECENT, 'bestRecent');
    if (this._recordBestSoFar) this.recordEpochFittest(e.epoch, FitnessScope.OVERALL, 'bestSoFar');
  }

  /**
   * Native `processEvent( const SimEndEvent & )` — close whatever is still open. Agents whose
   * analysis already ran have a cleared slot.
   */
  private onSimEnd(): void {
    forEachAgent(this.env, (a) => {
      const file = this.getFileFor(a) as { close(): void } | null | undefined;
      if (file) file.close();
    });
  }

  /** Native `BrainFunctionLog::recordEpochFittest( long step, FitnessScope, const char * )`. */
  private recordEpochFittest(step: number, scope: FitnessScope, scopeName: string): void {
    const fittest = this.simulation().fittest(scope);

    this.env.fs.makeDirs(`run/brain/${scopeName}/${step}`);
    for (let i = 0; i < fittest.getSize(); i++) {
      const agentID = fittest.get(i).agentID;
      const source = `run/brain/function/brainFunction_${agentID}.txt`;
      const target = `run/brain/${scopeName}/${step}/${i}_brainFunction_${agentID}.txt`;
      // Native links unconditionally here (no `exists` check, unlike the anatomy logger).
      this.env.fs.link(source, target);
    }
  }
}

/** The `SimEnd` walk: native's `gXSortedObjects` walk of `AGENTTYPE`. */
function forEachAgent(env: LogContext, visit: (a: LogAgent) => void): void {
  forEachSorted(env.world, GObjectType.AGENT, (obj) => visit(obj as LogAgent));
}

/** Native `Logs::SynapseLog`. */
export class SynapseLog extends AbstractFileLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordSynapses')) {
      this.initRecording(sim, StateScope.NULL, Event_BrainGrown | Event_AgentGrown | Event_BrainAnalysisBegin);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_BrainGrown: {
        const e = event as BrainGrownEvent<LogAgent>;
        if (learningMode() !== LearningMode.LEARN_NONE) this.createSynapseFile(e.a, 'incept');
        return;
      }
      case Event_AgentGrown:
        return this.createSynapseFile((event as AgentGrownEvent<LogAgent>).a, 'birth');
      case Event_BrainAnalysisBegin: {
        const e = event as BrainAnalysisBeginEvent<LogAgent>;
        if (learningMode() === LearningMode.LEARN_ALL) this.createSynapseFile(e.a, 'death');
        return;
      }
      default:
        return super.processEvent(event);
    }
  }

  /** Native `SynapseLog::createSynapseFile( agent *a, const char *suffix )`. */
  private createSynapseFile(a: LogAgent, suffix: string): void {
    const path = `run/brain/synapses/synapses_${a.number()}_${suffix}.txt`;

    const file = this.createFile(path);
    a.brain().dumpSynapses(file, a.number());
    file.close(); // native `delete file`
  }
}

/**
 * Native `Logs::BrainComplexityLog`.
 *
 * PORT-NOTE(l12/complexity-row-order): `ComplexityMap` is `std::map< long, float >`, so native
 * visits the entries in **ascending agent number** and `complexity_<type>.plt`'s rows are ordered
 * by agent number *whatever* order the analyses arrived in — the analyses run on several threads,
 * so their arrival order is not even deterministic in native. The port's `Map` is
 * insertion-ordered, so `writeComplexityFile` sorts at the write site, exactly as
 * `l12/separation-table-name` does for `SeparationCache`.
 */
export class BrainComplexityLog extends DataLibLogger {
  private _nseeds = 0;
  private _seedsRemaining = 0;
  private _complexityType = '';
  /**
   * Native `std::map< long, float >` — the map is keyed by agent number and the *file's* row
   * order is that map's iteration order; see `PORT-NOTE(l12/complexity-row-order)`.
   */
  private readonly _seedComplexity = new Map<number, number>();
  private readonly _recentComplexity = new Map<number, number>();
  private _recordBestRecent = false;

  constructor(env: LogContext) {
    super(env);
  }

  /**
   * Native `~BrainComplexityLog` — WRITES on destruction. The last `EpochEnd` may leave both
   * maps non-empty (the run ends between epochs), and native flushes them here; the port
   * does the same in `close()`, which `Logs.dispose()` calls in destructor order.
   */
  override close(): void {
    if (this._record) {
      // "These won't take any action if the complexity maps are empty."
      this.writeComplexityFile(0, this._seedComplexity);
      this.writeComplexityFile(this.simulation().epoch(), this._recentComplexity);
    }
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordComplexity')) {
      this.initRecording(sim, StateScope.NULL, Event_BrainAnalysisEnd | Event_EpochEnd);

      this._nseeds = doc.getInt('InitAgents');
      this._seedsRemaining = this._nseeds;
      this._complexityType = doc.getString('ComplexityType');
      this._recordBestRecent = doc.getBool('RecordBrainBestRecent');

      sim.enableComplexityCalculations();
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_BrainAnalysisEnd:
        return this.onBrainAnalysisEnd(event as BrainAnalysisEndEvent<LogAgent>);
      case Event_EpochEnd:
        return this.onEpochEnd(event as EpochEndEvent);
      default:
        return super.processEvent(event);
    }
  }

  /** Native `processEvent( const BrainAnalysisEndEvent & )`. */
  private onBrainAnalysisEnd(e: BrainAnalysisEndEvent<LogAgent>): void {
    // Native serialises this handler with a mutex because the analysis runs on several
    // threads; the model is single-threaded in the browser, and the port keeps the lock's
    // *ordering* by doing the same two map updates in the same order.
    if (this._seedsRemaining && e.a.number() < this._nseeds) {
      if (e.a.complexity() > 0.0) this._seedComplexity.set(e.a.number(), e.a.complexity());

      if (--this._seedsRemaining === 0) this.writeComplexityFile(0, this._seedComplexity);
    }

    if (e.a.complexity() > 0.0) this._recentComplexity.set(e.a.number(), e.a.complexity());
  }

  /** Native `processEvent( const EpochEndEvent & )`. */
  private onEpochEnd(e: EpochEndEvent): void {
    this.writeComplexityFile(e.epoch, this._recentComplexity);

    if (this._recordBestRecent) this.writeBestRecent(e.epoch);
  }

  /** Native `writeComplexityFile( long epoch, ComplexityMap & )` — writes if non-empty, clears. */
  private writeComplexityFile(epoch: number, complexities: Map<number, number>): void {
    if (complexities.size === 0) return;

    const path = `run/brain/Recent/${epoch}/complexity_${this._complexityType}.plt`;

    const writer = this.createWriter(path);
    writer.beginTable(this._complexityType, [
      { name: 'AgentNumber', type: ColumnType.INT },
      { name: 'Complexity', type: ColumnType.FLOAT },
    ]);

    // Native iterates a `std::map< long, float >`, i.e. in ascending agent number, not in the
    // order the analyses arrived — see PORT-NOTE(l12/complexity-row-order). The port's `Map` is
    // insertion-ordered, so the order native's container provides is restored here.
    const ordered = [...complexities.entries()].sort((a, b) => a[0] - b[0]);
    for (const [agentNumber, complexity] of ordered) writer.addRow([agentNumber, complexity]);

    writer.close(); // native `delete writer`

    complexities.clear();
  }

  /**
   * Native `writeBestRecent( long epoch )` — mean/stddev/standard error of the recent fittest
   * list, appended to `run/brain/bestRecent/complexity.txt`.
   *
   * PORT-NOTE(l12/best-recent-stats): the native code is a hand-rolled statistic whose two
   * degenerate cases are load-bearing: an empty list gives `mean = 0/0 = NaN` and the
   * `!(mean >= 0)` test then zeroes both mean and stddev, and `sqrt(stddev / (count-1))` with
   * `count == 0` is `sqrt(-0) == -0`, which `%f` prints as `-0.000000`. The port reproduces
   * both exactly (they appear in the golden the moment a run has an empty fittest list).
   */
  private writeBestRecent(epoch: number): void {
    const fittest = this.simulation().fittest(FitnessScope.RECENT);

    let mean = 0;
    let stddev = 0;
    let count = 0;

    for (let i = 0; i < fittest.getSize(); i++) {
      mean += fittest.get(i).complexity;
      count++;
    }

    mean = mean / count;

    if (!(mean >= 0)) {
      mean = 0;
      stddev = 0;
    } else {
      for (let i = 0; i < fittest.getSize(); i++) {
        stddev += Math.pow(fittest.get(i).complexity - mean, 2);
      }
    }

    stddev = Math.sqrt(stddev / (count - 1)); // divided by N-1 (MATLAB default)
    const standardError = stddev / Math.sqrt(count);

    const path = 'run/brain/bestRecent/complexity.txt';
    this.env.fs.makeParentDir(path);
    const file = this.env.fs.openPlain(path, 'a');
    file.printf(`${epoch} ${formatF(mean)} ${formatF(stddev)} ${formatF(standardError)} ${count}\n`);
    file.close();
  }
}

/** C `%f` for a double — W1c's exact-decimal formatter (`datalib/printf.ts`). */
function formatF(value: number): string {
  return formatFixed(value, 6);
}
