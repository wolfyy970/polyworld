/**
 * Lane L12 (logs) — the world-event recorders (`logs/Logs.cc`):
 *
 *   Logs::CarryLog              run/events/carry.log
 *   Logs::CollisionLog          run/events/collisions.log
 *   Logs::ContactLog            run/events/contacts.log     (the MATE/FIGHT/GIVE decoder)
 *   Logs::EnergyLog             run/events/energy.log       (one column per energy type)
 *   Logs::FoodConsumptionLog    run/energy/consumption.txt
 *   Logs::FoodEnergyLog         run/energy/food.txt         (one column per FoodType)
 *
 * PORT-NOTE(l12/event-token-tables): each of these logs stores a *word* where the model
 * carries an enum — `{"P","D","Do"}` for `CarryEvent::Action`, `{"G","F","E"}` for
 * `EnergyEvent::Action`, `{"A","F","B"}` for the object-type bits, and
 * `{"agent","food","brick","barrier","edge"}` for `sim::ObjectType` (that one lives in
 * `types/simconst.ts` because W1a froze it). The tokens are part of the byte contract, so they
 * are declared next to the recorder that writes them rather than derived.
 */

import {
  ColumnType,
  Event_Carry,
  Event_Collision,
  Event_ContactEnd,
  Event_Energy,
  Event_SimInited,
  Event_StepEnd,
  FIGHT_NIL,
  FIGHT_PREVENTED_CARRY,
  FIGHT_PREVENTED_POWER,
  FIGHT_PREVENTED_SHIELD,
  GIVE_NIL,
  GIVE_PREVENTED_CARRY,
  GIVE_PREVENTED_ENERGY,
  GObjectType,
  MATE_NIL,
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
  OBJECT_TYPE_NAMES,
  EnergyAction,
  globals,
} from '../types';
import type {
  AgentContactEndEvent,
  AgentContactEndInfo,
  CarryEvent,
  CollisionEvent,
  Config,
  EnergyEvent,
  SimEvent,
} from '../types';
import type { ColumnSpec } from '../datalib';
import { DataLibLogger, StateScope } from './logger';
import {
  forEachSorted,
  type LogAgent,
  type LogContext,
  type LogEnergy,
  type LogFood,
  type LogGameObject,
  type LogSimulation,
} from './seams';

/** `Logs::CarryLog`'s `actions[]` — indexed by `CarryEvent::Action`. */
export const CARRY_ACTION_NAMES: readonly string[] = ['P', 'D', 'Do'];

/** `Logs::CarryLog`'s object-type tokens, indexed by the `gobject` **bit** vocabulary. */
export const CARRY_OBJECT_TYPE_TOKENS: readonly string[] = ['A', 'F', 'B'];

/** `Logs::EnergyLog`'s `actionNames[]` — indexed by `EnergyEvent::Action`. */
export const ENERGY_ACTION_NAMES: readonly string[] = ['G', 'F', 'E'];

/** Native `Logs::CarryLog`. */
export class CarryLog extends DataLibLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordCarry')) {
      this.initRecording(sim, StateScope.SIMULATION, Event_Carry);

      this.createWriter('run/events/carry.log');
      this.getWriter().beginTable('Carry', [
        { name: 'T', type: ColumnType.INT },
        { name: 'Agent', type: ColumnType.INT },
        { name: 'Action', type: ColumnType.STRING },
        { name: 'ObjectType', type: ColumnType.STRING },
        { name: 'ObjectNumber', type: ColumnType.INT },
      ]);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_Carry: {
        const e = event as CarryEvent<LogAgent, LogGameObject>;
        const objectType = carryObjectTypeToken(e.obj.type());
        this.getWriter().addRow([
          this.getStep(),
          e.a.number(),
          CARRY_ACTION_NAMES[e.action]!,
          objectType,
          e.obj.typeNumber(),
        ]);
        return;
      }
      default:
        return super.processEvent(event);
    }
  }
}

/**
 * Native `switch( e.obj->getType() )` — the `AGENTTYPE`/`FOODTYPE`/`BRICKTYPE` *bits*, with
 * `assert( false )` for anything else (a barrier or the world edge has no token).
 */
export function carryObjectTypeToken(type: number): string {
  switch (type) {
    case GObjectType.AGENT:
      return CARRY_OBJECT_TYPE_TOKENS[0]!;
    case GObjectType.FOOD:
      return CARRY_OBJECT_TYPE_TOKENS[1]!;
    case GObjectType.BRICK:
      return CARRY_OBJECT_TYPE_TOKENS[2]!;
    default:
      throw new Error(`logs: CarryLog got object type ${type} (native asserts)`);
  }
}

/** Native `Logs::CollisionLog`. */
export class CollisionLog extends DataLibLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordCollisions')) {
      this.initRecording(sim, StateScope.SIMULATION, Event_Collision);

      this.createWriter('run/events/collisions.log');
      this.getWriter().beginTable('Collisions', [
        { name: 'Step', type: ColumnType.INT },
        { name: 'Agent', type: ColumnType.INT },
        { name: 'Type', type: ColumnType.STRING },
      ]);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_Collision: {
        // "We store type as a string since this data will most likely be processed by a script."
        const e = event as CollisionEvent<LogAgent>;
        this.getWriter().addRow([this.getStep(), e.a.number(), OBJECT_TYPE_NAMES[e.ot]!]);
        return;
      }
      default:
        return super.processEvent(event);
    }
  }
}

/** Native `Logs::ContactLog`. */
export class ContactLog extends DataLibLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordContacts')) {
      this.initRecording(sim, StateScope.SIMULATION, Event_ContactEnd);

      this.createWriter('run/events/contacts.log');
      this.getWriter().beginTable('Contacts', [
        { name: 'Timestep', type: ColumnType.INT },
        { name: 'Agent1', type: ColumnType.INT },
        { name: 'Agent2', type: ColumnType.INT },
        { name: 'Events', type: ColumnType.STRING },
      ]);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_ContactEnd: {
        const e = event as AgentContactEndEvent;
        const text = `${encodeContactInfo(e.c)}C${encodeContactInfo(e.d)}`;
        this.getWriter().addRow([this.getStep(), e.c.number, e.d.number, text]);
        return;
      }
      default:
        return super.processEvent(event);
    }
  }
}

/**
 * Native `Logs::ContactLog::encode( const AgentInfo &info, char **buf )`.
 *
 * The order of the letters is the order of the `__SET` blocks in the C++ and **is** the log
 * format, so it is written out explicitly: `M` then `p c w e f i d x t m v o` for the mate
 * bits, `F` then `c s p` for fight, `G` then `c e` for give. Each flag is its own bit of the
 * corresponding `simconst` mask, and the letter only appears for the bits that are set.
 *
 * PORT-NOTE(l12/contact-nul-terminator): native builds the string in a `char buf[32]` and
 * terminates it with `*(b++) = 0` before `addRow( ..., buf )`. `%s` stops at that NUL, so the
 * terminator is *not* in the file — the port therefore never puts it in the string. The
 * buffer is 32 bytes in native: `M` + 12 + `C` + `M` + 12 + NUL = 28 fits, and the port keeps
 * the same bound (a longer string would be a stack overflow in native, a throw here).
 */
export function encodeContactInfo(info: AgentContactEndInfo): string {
  let out = '';

  if (info.mate) {
    out += 'M';
    if (info.mate & MATE_PREVENTED_PARTNER) out += 'p';
    if (info.mate & MATE_PREVENTED_CARRY) out += 'c';
    if (info.mate & MATE_PREVENTED_MATE_WAIT) out += 'w';
    if (info.mate & MATE_PREVENTED_ENERGY) out += 'e';
    if (info.mate & MATE_PREVENTED_EAT_MATE_SPAN) out += 'f';
    if (info.mate & MATE_PREVENTED_EAT_MATE_MIN_DISTANCE) out += 'i';
    // MATE__PREVENTED__OF1 (1 << 7) has no letter: native's `#ifdef OF1` body is disabled.
    if (info.mate & MATE_PREVENTED_MAX_DOMAIN) out += 'd';
    if (info.mate & MATE_PREVENTED_MAX_WORLD) out += 'x';
    if (info.mate & MATE_PREVENTED_MAX_METABOLISM) out += 't';
    if (info.mate & MATE_PREVENTED_MISC) out += 'm';
    if (info.mate & MATE_PREVENTED_MAX_VELOCITY) out += 'v';
    if (info.mate & MATE_PREVENTED_WORLDFILE) out += 'o';
  }

  if (info.fight) {
    out += 'F';
    if (info.fight & FIGHT_PREVENTED_CARRY) out += 'c';
    if (info.fight & FIGHT_PREVENTED_SHIELD) out += 's';
    if (info.fight & FIGHT_PREVENTED_POWER) out += 'p';
  }

  if (info.give) {
    out += 'G';
    if (info.give & GIVE_PREVENTED_CARRY) out += 'c';
    if (info.give & GIVE_PREVENTED_ENERGY) out += 'e';
  }

  return out;
}

/** The mask values `encodeContactInfo` decodes, re-exported for tests and the sim lane. */
export const CONTACT_FLAG_MASKS = {
  MATE_NIL,
  FIGHT_NIL,
  GIVE_NIL,
} as const;

/** Native `Logs::EnergyLog`. */
export class EnergyLog extends DataLibLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordEnergy')) {
      this.initRecording(sim, StateScope.SIMULATION, Event_Energy);

      this.createWriter('run/events/energy.log');

      // Native builds the column list at run time: the five fixed columns, then one FLOAT
      // per energy type (`Energy0`, `Energy1`, …) named by `globals::numEnergyTypes`.
      const columns: ColumnSpec[] = [
        { name: 'T', type: ColumnType.INT },
        { name: 'Agent', type: ColumnType.INT },
        { name: 'EventType', type: ColumnType.STRING },
        { name: 'ObjectNumber', type: ColumnType.INT },
        { name: 'NeuralActivation', type: ColumnType.FLOAT },
      ];
      for (let i = 0; i < globals.numEnergyTypes; i++) {
        columns.push({ name: `Energy${i}`, type: ColumnType.FLOAT });
      }

      this.getWriter().beginTable('Energy', columns);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_Energy: {
        const e = event as EnergyEvent<LogAgent, LogGameObject, LogEnergy>;
        const row: (number | string)[] = [
          this.getStep(),
          e.a.number(),
          ENERGY_ACTION_NAMES[e.action]!,
          e.obj.typeNumber(),
          e.neuralActivation,
        ];
        for (let i = 0; i < globals.numEnergyTypes; i++) row.push(e.energy.at(i));
        this.getWriter().addRow(row);
        return;
      }
      default:
        return super.processEvent(event);
    }
  }
}

/** Native `Logs::FoodConsumptionLog`. */
export class FoodConsumptionLog extends DataLibLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordFoodConsumption')) {
      this.initRecording(sim, StateScope.SIMULATION, Event_Energy);

      this.createWriter('run/energy/consumption.txt');
      this.getWriter().beginTable('FoodConsumption', [
        { name: 'Timestep', type: ColumnType.INT },
        { name: 'Agent', type: ColumnType.INT },
        { name: 'FoodType', type: ColumnType.STRING },
        { name: 'Energy', type: ColumnType.FLOAT },
        { name: 'EnergyRaw', type: ColumnType.FLOAT },
      ]);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_Energy: {
        const e = event as EnergyEvent<LogAgent, LogFood, LogEnergy>;
        if (e.action !== EnergyAction.Eat) return;
        // native `food *f = (food *) e.obj;`
        const f = e.obj as LogFood;
        this.getWriter().addRow([
          this.getStep(),
          e.a.number(),
          f.type().name,
          e.energy.sum(),
          e.energyRaw.sum(),
        ]);
        return;
      }
      default:
        return super.processEvent(event);
    }
  }
}

/**
 * Native `Logs::FoodEnergyLog` — total food energy per `FoodType`, every step.
 *
 * PORT-NOTE(l12/food-energy-f32-accumulator): native accumulates into a `float[]`
 * (`energy[i] += f->getEnergy().sum()`), so every add rounds to f32; the port uses
 * `Math.fround` at each step of the accumulation rather than summing in double and rounding
 * once (PORT_SPEC rule 3).
 */
export class FoodEnergyLog extends DataLibLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordFoodEnergy')) {
      this.initRecording(sim, StateScope.SIMULATION, Event_SimInited | Event_StepEnd);

      this.createWriter('run/energy/food.txt');

      // Native: `count = FoodType::getNumberDefinitions()`, one FLOAT column per definition
      // named `FoodType::get( i )->name`, so the column set follows the worldfile.
      const count = this.env.foodTypes.getNumberDefinitions();
      const columns: ColumnSpec[] = [{ name: 'Timestep', type: ColumnType.INT }];
      for (let i = 0; i < count; i++) {
        columns.push({ name: this.env.foodTypes.get(i).name, type: ColumnType.FLOAT });
      }

      this.getWriter().beginTable('FoodEnergy', columns);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_SimInited:
      case Event_StepEnd:
        return this.recordStep();
      default:
        return super.processEvent(event);
    }
  }

  /** Native `Logs::FoodEnergyLog::processEvent()` (the no-argument overload). */
  private recordStep(): void {
    const count = this.env.foodTypes.getNumberDefinitions();
    const energy = new Array<number>(count).fill(0);

    forEachSorted(this.env.world, GObjectType.FOOD, (obj) => {
      const f = obj as LogFood;
      const index = f.type().index;
      energy[index] = Math.fround(energy[index]! + f.energySum());
    });

    const row: number[] = [this.getStep()];
    for (let i = 0; i < count; i++) row.push(energy[i]!);

    const writer = this.getWriter();
    writer.addRow(row);
    writer.flush();
  }
}
