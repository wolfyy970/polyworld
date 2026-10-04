/**
 * Lane L12 (logs) — the agent-lifecycle recorders (`logs/Logs.cc`):
 *
 *   Logs::AgentEnergyLog        run/energy/agents/agent_<n>.txt   (per-agent datalib, fixed-length records)
 *   Logs::AgentMaxEnergyLog     run/energy/agents/max.txt
 *   Logs::AgentPositionLog      run/motion/position/agents/position_<n>.txt
 *   Logs::BirthsDeathsLog       run/BirthsDeaths.log              (plain text, *not* datalib)
 *   Logs::LifeSpanLog           run/lifespans.txt
 *   Logs::PopulationLog         run/population.txt
 *
 * Everything here is recorder mechanics: which event opens which file, the table/column
 * schema, the per-agent file lifecycle (created on birth, written per step, a final row and
 * closed on death) and which value each column reads. The values themselves belong to the
 * agent/sim lanes (`seams.ts`).
 *
 * PORT-NOTE(l12/agent-file-per-type-number): every per-agent path is built from
 * `agent::getTypeNumber()` (`agent_%ld.txt`, `position_%ld.txt`), while `LifeSpanLog` and
 * `BirthsDeathsLog` write `agent::Number()`. For agents the two agree in the oracle (both are
 * 1..N); the port keeps each call site's own accessor rather than unifying them.
 *
 * PORT-NOTE(l12/recorders-take-the-environment): native's recorders are default-constructed
 * as members of `Logs` and reach `gXSortedObjects`, `fopen` and `FoodType` as globals. The
 * port's constructors take the run's `LogContext` (see `seams.ts`); nothing else about the
 * recorders differs.
 */

import {
  BirthReason,
  ColumnType,
  DeathReason,
  Event_AgentBirth,
  Event_AgentDeath,
  Event_AgentGrown,
  Event_BodyUpdated,
  Event_StepEnd,
  GObjectType,
  birthReasonName,
  deathReasonName,
} from '../types';
import type {
  AgentBirthEvent,
  AgentBodyUpdatedEvent,
  AgentDeathEvent,
  AgentGrownEvent,
  Config,
  SimEvent,
} from '../types';
import { formatBirthLine, formatDeathLine } from '../datalib';
import { DataLibLogger, FileLogger, StateScope } from './logger';
import { forEachSorted, type LogAgent, type LogContext, type LogSimulation } from './seams';

/** Native `Logs::AgentEnergyLog`. */
export class AgentEnergyLog extends DataLibLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordAgentEnergy')) {
      this.initRecording(sim, StateScope.AGENT, Event_AgentBirth | Event_StepEnd | Event_AgentDeath);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_AgentBirth:
        return this.onBirth(event as AgentBirthEvent<LogAgent>);
      case Event_StepEnd:
        return this.onStepEnd();
      case Event_AgentDeath:
        return this.onDeath(event as AgentDeathEvent<LogAgent>);
      default:
        return super.processEvent(event);
    }
  }

  /** Native `processEvent( const AgentBirthEvent &e )`. */
  private onBirth(e: AgentBirthEvent<LogAgent>): void {
    if (e.reason === BirthReason.VIRTUAL) return;

    const path = `run/energy/agents/agent_${e.a!.typeNumber()}.txt`;
    const writer = this.createWriterFor(e.a!, path, true, false);

    writer.beginTable('AgentEnergy', [
      { name: 'Timestep', type: ColumnType.INT },
      { name: 'Energy', type: ColumnType.FLOAT },
      { name: 'FoodEnergy', type: ColumnType.FLOAT },
    ]);
  }

  /** Native `processEvent( const StepEndEvent & )` — one row per live agent, in x-sorted order. */
  private onStepEnd(): void {
    const step = this.getStep();
    forEachSorted(this.env.world, GObjectType.AGENT, (obj) => {
      const a = obj as LogAgent;
      // Native dereferences `getWriter( a )` unconditionally: an agent with no writer (a
      // virtual birth writes no file) is a crash in native too.
      this.getWriterFor(a).addRow([step, a.energy().sum(), a.foodEnergy().sum()]);
    });
  }

  /** Native `processEvent( const AgentDeathEvent &e )`. */
  private onDeath(e: AgentDeathEvent<LogAgent>): void {
    if (e.reason !== DeathReason.SIMEND) {
      this.getWriterFor(e.a).addRow([this.getStep(), e.a.energy().sum(), e.a.foodEnergy().sum()]);
    }
    this.getWriterFor(e.a).close(); // native `delete getWriter( e.a )`
  }
}

/** Native `Logs::AgentMaxEnergyLog`. */
export class AgentMaxEnergyLog extends DataLibLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordAgentEnergy')) {
      this.initRecording(sim, StateScope.SIMULATION, Event_AgentGrown);

      this.createWriter('run/energy/agents/max.txt');
      this.getWriter().beginTable('MaxEnergy', [
        { name: 'Agent', type: ColumnType.INT },
        { name: 'MaxEnergy', type: ColumnType.FLOAT },
      ]);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_AgentGrown: {
        const e = event as AgentGrownEvent<LogAgent>;
        this.getWriter().addRow([e.a.number(), e.a.maxEnergy().sum()]);
        return;
      }
      default:
        return super.processEvent(event);
    }
  }
}

/** Native `Logs::AgentPositionLog::Mode`. */
export const PositionMode = {
  PRECISE: 0,
  APPROXIMATE: 1,
} as const;

export type PositionMode = (typeof PositionMode)[keyof typeof PositionMode];

/** Native `Logs::AgentPositionLog`. */
export class AgentPositionLog extends DataLibLogger {
  /** Native `_mode` — uninitialized until `init` decides (see the switch defaults below). */
  private _mode: PositionMode | null = null;

  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    const mode = doc.getString('RecordPosition');
    if (mode !== 'False') {
      if (mode === 'Precise') this._mode = PositionMode.PRECISE;
      else if (mode === 'Approximate') this._mode = PositionMode.APPROXIMATE;
      else throw new Error(`logs: unknown RecordPosition mode '${mode}' (native asserts)`);

      this.initRecording(sim, StateScope.AGENT, Event_AgentBirth | Event_BodyUpdated | Event_AgentDeath);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_AgentBirth:
        return this.onBirth(event as AgentBirthEvent<LogAgent>);
      case Event_BodyUpdated:
        return this.onBodyUpdated(event as AgentBodyUpdatedEvent<LogAgent>);
      case Event_AgentDeath:
        return this.onDeath(event as AgentDeathEvent<LogAgent>);
      default:
        return super.processEvent(event);
    }
  }

  /** Native `processEvent( const AgentBirthEvent &e )`. */
  private onBirth(e: AgentBirthEvent<LogAgent>): void {
    if (e.reason === BirthReason.VIRTUAL) return;

    const path = `run/motion/position/agents/position_${e.a!.typeNumber()}.txt`;

    switch (this._mode) {
      case PositionMode.PRECISE: {
        const writer = this.createWriterFor(e.a!, path, true, false);
        writer.beginTable('Positions', [
          { name: 'Timestep', type: ColumnType.INT },
          { name: 'x', type: ColumnType.FLOAT },
          { name: 'y', type: ColumnType.FLOAT },
          { name: 'z', type: ColumnType.FLOAT },
        ]);
        break;
      }
      case PositionMode.APPROXIMATE: {
        const writer = this.createWriterFor(e.a!, path);
        writer.beginTable(
          'Positions',
          [
            { name: 'Timestep', type: ColumnType.INT },
            { name: 'x', type: ColumnType.FLOAT },
            { name: 'z', type: ColumnType.FLOAT },
          ],
          ['%d', '%.2f', '%.2f'],
        );
        break;
      }
      default:
        // native `default: assert( false )` — an unset mode
        throw new Error('logs: AgentPositionLog birth with no RecordPosition mode (native asserts)');
    }
  }

  /** Native `processEvent( const AgentBodyUpdatedEvent &e )`. */
  private onBodyUpdated(e: AgentBodyUpdatedEvent<LogAgent>): void {
    switch (this._mode) {
      case PositionMode.PRECISE:
        this.getWriterFor(e.a).addRow([this.getStep(), e.a.x(), e.a.y(), e.a.z()]);
        break;
      case PositionMode.APPROXIMATE:
        this.getWriterFor(e.a).addRow([this.getStep(), e.a.x(), e.a.z()]);
        break;
      default:
        throw new Error('logs: AgentPositionLog update with no RecordPosition mode (native asserts)');
    }
  }

  /** Native `processEvent( const AgentDeathEvent &e )` — close, never a row. */
  private onDeath(e: AgentDeathEvent<LogAgent>): void {
    this.getWriterFor(e.a).close(); // native `delete getWriter( e.a )`
  }
}

/**
 * Native `Logs::BirthsDeathsLog`.
 *
 * PORT-NOTE(l12/birthsdeaths-uses-w1c-formatters): the *bytes* of a line are W1c's
 * (`datalib/birthsDeaths.ts`, pinned against the goldens); this class owns the plumbing —
 * the header at init, the `BR_SIMINIT`/`DR_SIMEND` silence, `BR_VIRTUAL` printing `0` for the
 * agent id, and `createFile( "run/BirthsDeaths.log" )` going through **plain** `fopen` even
 * when `CompressFiles True`.
 */
export class BirthsDeathsLog extends FileLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordBirthsDeaths')) {
      this.initRecording(sim, StateScope.SIMULATION, Event_AgentBirth | Event_AgentDeath);

      this.createFile('run/BirthsDeaths.log');
      this.getFile().printf('% Timestep Event Agent# Parent1 Parent2\n');
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_AgentBirth:
        return this.onBirth(event as AgentBirthEvent<LogAgent>);
      case Event_AgentDeath:
        return this.onDeath(event as AgentDeathEvent<LogAgent>);
      default:
        return super.processEvent(event);
    }
  }

  /** Native `processEvent( const AgentBirthEvent & )`. */
  private onBirth(e: AgentBirthEvent<LogAgent>): void {
    // Native's `switch` on the reason dereferences `birth.a`/`parent1`/`parent2` without a
    // null check for the reasons that carry them (types/event-null-pointers).
    switch (e.reason) {
      case BirthReason.SIMINIT:
        return;
      case BirthReason.NATURAL:
      case BirthReason.LOCKSTEP:
        this.getFile().printf(
          formatBirthLine(this.getStep(), e.reason, e.a!.number(), e.parent1!.number(), e.parent2!.number()),
        );
        return;
      case BirthReason.VIRTUAL:
        this.getFile().printf(
          formatBirthLine(this.getStep(), e.reason, 0, e.parent1!.number(), e.parent2!.number()),
        );
        return;
      case BirthReason.CREATE:
        this.getFile().printf(formatBirthLine(this.getStep(), e.reason, e.a!.number(), 0, 0));
        return;
      default:
        throw new Error(`logs: BirthsDeathsLog got birth reason ${birthReasonName(e.reason)} (native asserts)`);
    }
  }

  /** Native `processEvent( const AgentDeathEvent & )`. */
  private onDeath(e: AgentDeathEvent<LogAgent>): void {
    this.getFile().printf(formatDeathLine(this.getStep(), e.reason, e.a.number()));
  }
}

/** Native `Logs::LifeSpanLog` — always records (no worldfile guard). */
export class LifeSpanLog extends DataLibLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, _doc: Config): void {
    this.initRecording(sim, StateScope.SIMULATION, Event_AgentDeath);

    this.createWriter('run/lifespans.txt');
    this.getWriter().beginTable('LifeSpans', [
      { name: 'Agent', type: ColumnType.INT },
      { name: 'BirthStep', type: ColumnType.INT },
      { name: 'BirthReason', type: ColumnType.STRING },
      { name: 'DeathStep', type: ColumnType.INT },
      { name: 'DeathReason', type: ColumnType.STRING },
    ]);
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_AgentDeath: {
        const { a } = event as AgentDeathEvent<LogAgent>;
        const ls = a.lifeSpan();
        const writer = this.getWriter();
        writer.addRow([
          a.number(),
          ls.birth.step,
          birthReasonName(ls.birth.reason as BirthReason),
          ls.death.step,
          deathReasonName(ls.death.reason as DeathReason),
        ]);
        writer.flush();
        return;
      }
      default:
        return super.processEvent(event);
    }
  }
}

/** Native `Logs::PopulationLog`. */
export class PopulationLog extends DataLibLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordPopulation')) {
      this.initRecording(sim, StateScope.SIMULATION, Event_StepEnd);

      this.createWriter('run/population.txt');
      this.getWriter().beginTable('Population', [
        { name: 'T', type: ColumnType.INT },
        { name: 'Population', type: ColumnType.INT },
      ]);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_StepEnd: {
        const writer = this.getWriter();
        writer.addRow([this.getStep(), this.simulation().numAgents()]);
        writer.flush();
        return;
      }
      default:
        return super.processEvent(event);
    }
  }
}
