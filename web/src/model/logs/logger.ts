/**
 * Lane L12 (logs) — `Logger` and its three convenience bases (`logs/Logger.{h,cc}`).
 *
 * A `Logger` is a recorder that subscribes to simulation events. Native's design has three
 * moving parts, all of them reproduced here:
 *
 *  1. **Installation by construction.** `Logger::Logger()` calls `Logs::installLogger( this )`,
 *     so declaring a logger as a member of `Logs` is what installs it. The port does the same
 *     in the `Logger` constructor (`registry.installLogger`).
 *  2. **`initRecording( sim, scope, events )`.** The derived class decides at init time
 *     whether it records and which events it wants; the base records the scope, allocates the
 *     state slot (`_simulationScope.data = NULL` or an `AgentAttachedData` slot) and registers
 *     the events.
 *  3. **State scope.** `NullStateScope` keeps no state, `SimulationStateScope` holds one
 *     opaque `void *` (the `FILE *`, `AbstractFile *` or `DataLibWriter *` of the run) and
 *     `AgentStateScope` holds one per agent, through `AgentAttachedData`.
 *
 * PORT-NOTE(l12/state-is-explicit): native's `union { _nullScope; _simulationScope;
 * _agentScope; }` is a type-punned `void *`; the port keeps the two live members as separate
 * fields and asserts the same scope precondition on each accessor, so an accessor used under
 * the wrong scope fails loudly instead of reinterpreting a pointer.
 *
 * PORT-NOTE(l12/destructor-order): native closes the run's files in *member destructor*
 * order (reverse declaration order in `Logs`), and `FileLogger`/`AbstractFileLogger`/
 * `DataLibLogger` only close when the scope is `SimulationStateScope` and they recorded
 * (per-agent files are closed by the loggers themselves on death). The port gives each base
 * an explicit `close()` and `Logs.dispose()` calls them in reverse declaration order.
 */

import { agentAttachedData, type SlotHandle } from './agentSlots';
import { cFormatTextSink } from './formatSink';
import { installLogger, registerEvents, type RegisteredLogger } from './registry';
import { Event_None, type Config, type EventType, type SimEvent } from '../types';
import type { LogContext, LogSimulation, TextSink } from './seams';
import type { DataLibWriter } from '../datalib';

/** Native `Logger::StateScope`. */
export const StateScope = {
  NULL: 0,
  SIMULATION: 1,
  AGENT: 2,
} as const;

export type StateScope = (typeof StateScope)[keyof typeof StateScope];

/** Native `assert( false )` in the base `processEvent` overloads. */
function unhandled(where: string, event: SimEvent): never {
  throw new Error(`logs: ${where} received an event it did not register for (type ${event.type})`);
}

/**
 * Native `class Logger`. `init` is native's pure virtual; `processEvent` is the port's
 * replacement for the overload set (see PORT-NOTE(l12/event-registry-bits) in `registry.ts`).
 */
export abstract class Logger implements RegisteredLogger {
  protected _scope: StateScope = StateScope.NULL;
  protected _simulation: LogSimulation | null = null;
  protected _record = false;

  /** The run's log environment (file backends + the globals a recorder reaches). */
  protected readonly env: LogContext;

  /** Native `_simulationScope.data`. */
  private simulationState: unknown = null;

  /** Native `_agentScope.slotHandle`. */
  private agentSlot: SlotHandle | null = null;

  protected constructor(env: LogContext) {
    this.env = env;
    installLogger(this);
  }

  /** Native `virtual void Logger::init( TSimulation *sim, proplib::Document *doc ) = 0`. */
  abstract init(sim: LogSimulation, doc: Config): void;

  /** Native `Logger::getMaxOpenFiles()`. */
  getMaxOpenFiles(): number {
    if (!this._record) return 0;

    if (this._simulation === null) {
      throw new Error('logs: Logger::getMaxOpenFiles with no simulation (native asserts)');
    }

    switch (this._scope) {
      case StateScope.AGENT:
        return this._simulation.maxAgents();
      default:
        return 1;
    }
  }

  /** Native `Logger::initRecording( sim, scope, events )`. */
  protected initRecording(sim: LogSimulation, scope: StateScope, events: EventType = Event_None): void {
    this._scope = scope;
    this._record = true;
    this._simulation = sim;

    switch (scope) {
      case StateScope.NULL:
        break;
      case StateScope.SIMULATION:
        this.simulationState = null;
        break;
      case StateScope.AGENT:
        this.agentSlot = agentAttachedData.createSlot();
        break;
      default:
        throw new Error('logs: initRecording with an unknown state scope (native asserts)');
    }

    registerEvents(this, events);
  }

  /** Native `Logger::getStep()`. */
  protected getStep(): number {
    if (this._simulation === null) throw new Error('logs: getStep with no simulation');
    return this._simulation.step();
  }

  /** Native `_simulation` — bound by `initRecording`, so only a recording logger has one. */
  protected simulation(): LogSimulation {
    if (this._simulation === null) throw new Error('logs: no simulation bound (Logger::initRecording)');
    return this._simulation;
  }

  /** Native `Logger::getSimulationState()`. */
  protected getSimulationState(): unknown {
    if (this._scope !== StateScope.SIMULATION) {
      throw new Error('logs: getSimulationState outside SimulationStateScope (native asserts)');
    }
    return this.simulationState;
  }

  /** Native `Logger::getAgentState( agent *a )`. */
  protected getAgentState(agent: object): unknown {
    if (this._scope !== StateScope.AGENT) {
      throw new Error('logs: getAgentState outside AgentStateScope (native asserts)');
    }
    return agentAttachedData.get(agent, this.agentSlot!);
  }

  /** Native `Logger::setSimulationState( void * )`. */
  protected setSimulationState(state: unknown): void {
    if (this._scope !== StateScope.SIMULATION) {
      throw new Error('logs: setSimulationState outside SimulationStateScope (native asserts)');
    }
    this.simulationState = state;
  }

  /** Native `Logger::setAgentState( agent *a, void *state )`. */
  protected setAgentState(agent: object, state: unknown): void {
    agentAttachedData.set(agent, this.agentSlot!, state);
  }

  /**
   * Native's base `processEvent( const T & )` overloads are `assert( false )`: a logger that
   * registered for an event must handle it. Subclasses switch on `event.type`.
   */
  processEvent(event: SimEvent): void {
    unhandled(this.constructor.name, event);
  }

  /** Native `Logger::~Logger` — nothing to release at this level. */
  close(): void {
    /* the three convenience bases release their own state */
  }
}

//===========================================================================
// FileLogger
//===========================================================================

/** Native `class FileLogger` — a recorder that holds one plain `FILE *` (per agent or per run). */
export abstract class FileLogger extends Logger {
  /** Native `FileLogger::createFile( path, mode = "w" )`. */
  protected createFile(path: string, mode: 'w' | 'a' = 'w'): TextSink {
    this.env.fs.makeParentDir(path);

    // PORT-NOTE(l12/text-sink-format) (`formatSink.ts`): every sink a recorder hands out accepts
    // native's `fprintf( f, format, ...values )` as well as its pre-formatted `fprintf( f, "%s", t )`
    // shape. `AdamiComplexityLog` is a `FileLogger` and its four files are written by lane L13's
    // `adami.cc` transcription, which is `fprintf( oneBit, "%.4f %.4f …", … )`.
    const file = cFormatTextSink(this.env.fs.openPlain(path, mode));

    if (this._scope === StateScope.SIMULATION) this.setSimulationState(file);

    return file;
  }

  /** Native `FileLogger::getFile()`. */
  protected getFile(): TextSink {
    return this.getSimulationState() as TextSink;
  }

  /** Native `FileLogger::createFile( agent *a, path, mode )`. */
  protected createFileFor(agent: object, path: string, mode: 'w' | 'a' = 'w'): TextSink {
    this.env.fs.makeParentDir(path);

    const file = cFormatTextSink(this.env.fs.openPlain(path, mode));
    this.setAgentState(agent, file);

    return file;
  }

  /** Native `FileLogger::getFile( agent *a )`. */
  protected getFileFor(agent: object): TextSink {
    return this.getAgentState(agent) as TextSink;
  }

  /** Native `FileLogger::~FileLogger`. */
  override close(): void {
    if (this._scope === StateScope.SIMULATION && this._record) {
      (this.getSimulationState() as TextSink | null)?.close();
    }
  }
}

//===========================================================================
// AbstractFileLogger
//===========================================================================

/**
 * Native `class AbstractFileLogger` — a recorder that holds an `AbstractFile *`, i.e. a plain
 * file or a gzipped one depending on `globals::recordFileType` (`CompressFiles`).
 */
export abstract class AbstractFileLogger extends Logger {
  /** Native `AbstractFileLogger::createFile( path )`. */
  protected createFile(path: string): TextSink {
    this.env.fs.makeParentDir(path);

    // PORT-NOTE(l12/text-sink-format) (`formatSink.ts`): the brain's dumps (`Brain::dumpAnatomical`,
    // `dumpSynapses`, `startFunctional`/`writeFunctional`) are native `AbstractFile::printf` calls
    // with a format *and* its values — `brainLogs.ts` hands this sink straight to the brain, so the
    // sink is what applies the format. File naming and the dump triggers are this lane's; the values
    // are lane L6's.
    const file = cFormatTextSink(this.env.fs.openAbstract(path, 'w'));

    if (this._scope === StateScope.SIMULATION) this.setSimulationState(file);

    return file;
  }

  /** Native `AbstractFileLogger::getFile()`. */
  protected getFile(): TextSink {
    return this.getSimulationState() as TextSink;
  }

  /** Native `AbstractFileLogger::createFile( agent *a, path )`. */
  protected createFileFor(agent: object, path: string): TextSink {
    this.env.fs.makeParentDir(path);

    const file = cFormatTextSink(this.env.fs.openAbstract(path, 'w'));
    this.setAgentState(agent, file);

    return file;
  }

  /** Native `AbstractFileLogger::getFile( agent *a )`. */
  protected getFileFor(agent: object): TextSink {
    return this.getAgentState(agent) as TextSink;
  }

  /** Native `AbstractFileLogger::~AbstractFileLogger` — `delete getFile()`. */
  override close(): void {
    if (this._scope === StateScope.SIMULATION && this._record) {
      (this.getSimulationState() as TextSink | null)?.close();
    }
  }
}

//===========================================================================
// DataLibLogger
//===========================================================================

/**
 * Native `class DataLibLogger` — a recorder that holds a `DataLibWriter *`. Note that
 * `DataLibWriter` opens with `fopen( path, "wb" )`: datalib logs are **never** gzipped, which
 * is why `run/events/*.log` and `run/*.txt` are plain in a `CompressFiles True` run.
 */
export abstract class DataLibLogger extends Logger {
  /** Native `DataLibLogger::createWriter( path, randomAccess, singleSchema )`. */
  protected createWriter(path: string, randomAccess = false, singleSchema = true): DataLibWriter {
    this.env.fs.makeParentDir(path);
    const writer = this.env.fs.openDataLib(path, randomAccess, singleSchema);

    if (this._scope === StateScope.SIMULATION) this.setSimulationState(writer);

    return writer;
  }

  /** Native `DataLibLogger::getWriter()`. */
  protected getWriter(): DataLibWriter {
    return this.getSimulationState() as DataLibWriter;
  }

  /** Native `DataLibLogger::createWriter( agent *a, path, randomAccess, singleSchema )`. */
  protected createWriterFor(
    agent: object,
    path: string,
    randomAccess = false,
    singleSchema = true,
  ): DataLibWriter {
    this.env.fs.makeParentDir(path);
    const writer = this.env.fs.openDataLib(path, randomAccess, singleSchema);
    this.setAgentState(agent, writer);

    return writer;
  }

  /** Native `DataLibLogger::getWriter( agent *a )`. */
  protected getWriterFor(agent: object): DataLibWriter {
    return this.getAgentState(agent) as DataLibWriter;
  }

  /** Native `DataLibLogger::~DataLibLogger` — `delete getWriter()`. */
  override close(): void {
    if (this._scope === StateScope.SIMULATION && this._record) {
      (this.getSimulationState() as DataLibWriter | null)?.close();
    }
  }
}
