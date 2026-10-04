/**
 * Lane W1a — the simulation event vocabulary (native `sim/simtypes.h`).
 *
 * Native raises events with `logs->postEvent( ... )` and dispatches them to loggers by C++
 * overload (`Logger::processEvent( const sim::AgentBirthEvent & )`), so an event's *type* is
 * its C++ class, not a runtime tag. The port makes the tag explicit — every struct carries
 * a literal `type` field holding the native `sim::Event_*` bit — so a switch narrows and so
 * a dispatcher can route without overloads.
 *
 * Two native details are load-bearing and easy to get wrong:
 *
 *  1. `AgentBirthEvent::a` is **NULL for virtual births** and `parent1`/`parent2` are NULL
 *     for `BR_SIMINIT` births (`TSimulation::Birth` is called as `Birth(c, BR_SIMINIT)`;
 *     `BirthsDeathsLog` prints `0` instead of `a->Number()` for `BR_VIRTUAL`). A port that
 *     types them non-null crashes the moment a world uses virtual births.
 *  2. `EnergyEvent` holds `const Energy &` — a **live reference** to the agent's or object's
 *     energy, not a copy. Anything that stores the event past the synchronous dispatch sees
 *     later mutations (and the native code would too).
 *
 * PORT-NOTE(types/event-structs-are-generic): the events reference native `agent*`,
 * `gobject*` and `Energy`, which belong to other lanes. The port makes the structs generic
 * over those three types (defaults are opaque `object`s) so `types/` neither depends on nor
 * invents another lane's shape: `AgentBirthEvent<Agent, GameObject, Energy>`.
 * PORT-NOTE(types/event-type-field): native computes the type (`getType()`); the port stores
 * it as a literal `type` field. Values are native's `sim::Event_*` bits.
 * PORT-NOTE(types/event-null-pointers): nullability follows the native call sites (birth
 * agent/parents), not a guess; see above.
 */

import type { BirthReason, DeathReason } from './lifespan';
import type { ObjectType } from './simconst';

/** Native `sim::EventType` — the `sim::Event_*` bit for an event's class. */
export type EventType = number;

/** Native `sim::Event_*`. Each is one bit, so masks OR; the tag field carries the bit. */
export const Event_None = 0;
export const Event_SimInited: 1 = 1; // 1 << 0
export const Event_AgentBirth: 2 = 2; // 1 << 1
export const Event_BrainGrown: 4 = 4; // 1 << 2
export const Event_AgentGrown: 8 = 8; // 1 << 3
export const Event_BrainUpdated: 16 = 16; // 1 << 4
export const Event_BodyUpdated: 32 = 32; // 1 << 5
export const Event_ContactBegin: 64 = 64; // 1 << 6
export const Event_ContactEnd: 128 = 128; // 1 << 7
export const Event_Collision: 256 = 256; // 1 << 8
export const Event_Carry: 512 = 512; // 1 << 9
export const Event_Energy: 1024 = 1024; // 1 << 10
export const Event_AgentDeath: 2048 = 2048; // 1 << 11
export const Event_BrainAnalysisBegin: 4096 = 4096; // 1 << 12
export const Event_BrainAnalysisEnd: 8192 = 8192; // 1 << 13
export const Event_StepEnd: 16384 = 16384; // 1 << 14
export const Event_EpochEnd: 32768 = 32768; // 1 << 15
export const Event_SimEnd: 65536 = 65536; // 1 << 16

/**
 * The referenced lane types. `types/` never declares their shape; a lane instantiates the
 * event types with its own class (`AgentBirthEvent<Agent>`), so the event is as typed as the
 * consumer wants and `types/` stays a pure interface cut.
 */
export type AgentRef = object;
export type GameObjectRef = object;
export type EnergyRef = object;

/** Native `sim::SimInitedEvent`. */
export interface SimInitedEvent {
  readonly type: 1;
}

/**
 * Native `sim::AgentBirthEvent`. `a` is null for `BR_VIRTUAL` births; `parent1`/`parent2`
 * are null for `BR_SIMINIT` (and are dereferenced *without* a check for `BR_NATURAL` /
 * `BR_LOCKSTEP` / `BR_VIRTUAL`, where native guarantees them).
 */
export interface AgentBirthEvent<A = AgentRef> {
  readonly type: 2;
  a: A | null;
  reason: BirthReason;
  parent1: A | null;
  parent2: A | null;
}

/** Native `sim::BrainGrownEvent`. */
export interface BrainGrownEvent<A = AgentRef> {
  readonly type: 4;
  a: A;
}

/** Native `sim::AgentGrownEvent`. */
export interface AgentGrownEvent<A = AgentRef> {
  readonly type: 8;
  a: A;
}

/** Native `sim::AgentBodyUpdatedEvent` (`energyUsedRaw` is the pre-scaling value). */
export interface AgentBodyUpdatedEvent<A = AgentRef> {
  readonly type: 32;
  a: A;
  energyUsed: number;
  energyUsedRaw: number;
}

/** Native `sim::BrainUpdatedEvent`. */
export interface BrainUpdatedEvent<A = AgentRef> {
  readonly type: 16;
  a: A;
}

/** Native `AgentContactBeginEvent::AgentInfo` — contact bookkeeping for one participant. */
export interface AgentContactBeginInfo<A = AgentRef> {
  a: A;
  /** Native `long number` — the agent's `Number()`. */
  number: number;
  /** Native `MATE__*` bits (`simconst.ts`). */
  mate: number;
  /** Native `FIGHT__*` bits. */
  fight: number;
  /** Native `GIVE__*` bits. */
  give: number;
}

/**
 * Native `sim::AgentContactBeginEvent`. Native also carries the mutators
 * (`mate(agent*,int)`, `fight`, `give`, `get(agent*)`, `AgentInfo::init(agent*)`) that the
 * interaction code uses to fill the flags; they belong to the lane that owns contact
 * handling (L11) and are not part of the frozen data shape.
 */
export interface AgentContactBeginEvent<A = AgentRef> {
  readonly type: 64;
  c: AgentContactBeginInfo<A>;
  d: AgentContactBeginInfo<A>;
}

/** Native `AgentContactEndEvent::AgentInfo` — same flags, no agent pointer. */
export interface AgentContactEndInfo {
  number: number;
  mate: number;
  fight: number;
  give: number;
}

/** Native `sim::AgentContactEndEvent` (built from the matching begin event). */
export interface AgentContactEndEvent {
  readonly type: 128;
  c: AgentContactEndInfo;
  d: AgentContactEndInfo;
}

/** Native `sim::CollisionEvent` — `ot` is a `sim::ObjectType` (`collisions.log`). */
export interface CollisionEvent<A = AgentRef> {
  readonly type: 256;
  a: A;
  ot: ObjectType;
}

/** Native `CarryEvent::Action`. Logged as `{"P","D","Do"}[action]` in `events/carry.log`. */
export const CarryAction = {
  Pickup: 0,
  DropRecent: 1,
  DropObject: 2,
} as const;

export type CarryAction = (typeof CarryAction)[keyof typeof CarryAction];

/** The `events/carry.log` Action column tokens, indexed by `CarryAction`. */
export const CARRY_ACTION_NAMES: readonly string[] = ['P', 'D', 'Do'];

/**
 * Native `sim::CarryEvent`. `obj` is non-null: all three native construction sites
 * (`agent::PickupObject`, `DropMostRecent`, `DropObject`) pass the object being carried, and
 * `CarryLog` dereferences it unconditionally.
 */
export interface CarryEvent<A = AgentRef, G = GameObjectRef> {
  readonly type: 512;
  a: A;
  action: CarryAction;
  obj: G;
}

/** Native `EnergyEvent::Action`. */
export const EnergyAction = {
  Give: 0,
  Fight: 1,
  Eat: 2,
} as const;

export type EnergyAction = (typeof EnergyAction)[keyof typeof EnergyAction];

/**
 * Native `sim::EnergyEvent`. `obj` is the other party — an agent for `Give`/`Fight`, a food
 * object for `Eat` (native passes `agent*` here because `agent` derives from `gobject`).
 * `energy`/`energyRaw` are native `const Energy &`: live references, not copies.
 */
export interface EnergyEvent<A = AgentRef, G = GameObjectRef, E = EnergyRef> {
  readonly type: 1024;
  a: A;
  obj: G;
  neuralActivation: number;
  energy: E;
  energyRaw: E;
  action: EnergyAction;
}

/** Native `sim::AgentDeathEvent`. */
export interface AgentDeathEvent<A = AgentRef> {
  readonly type: 2048;
  a: A;
  reason: DeathReason;
}

/** Native `sim::BrainAnalysisBeginEvent`. */
export interface BrainAnalysisBeginEvent<A = AgentRef> {
  readonly type: 4096;
  a: A;
}

/** Native `sim::BrainAnalysisEndEvent`. */
export interface BrainAnalysisEndEvent<A = AgentRef> {
  readonly type: 8192;
  a: A;
}

/** Native `sim::StepEndEvent`. */
export interface StepEndEvent {
  readonly type: 16384;
}

/** Native `sim::EpochEndEvent` (`epoch` is the native `long` step counter). */
export interface EpochEndEvent {
  readonly type: 32768;
  epoch: number;
}

/** Native `sim::SimEndEvent`. */
export interface SimEndEvent {
  readonly type: 65536;
}

/** Every event the simulation posts, discriminated by `type`. */
export type SimEvent<A = AgentRef, G = GameObjectRef, E = EnergyRef> =
  | SimInitedEvent
  | AgentBirthEvent<A>
  | BrainGrownEvent<A>
  | AgentGrownEvent<A>
  | AgentBodyUpdatedEvent<A>
  | BrainUpdatedEvent<A>
  | AgentContactBeginEvent<A>
  | AgentContactEndEvent
  | CollisionEvent<A>
  | CarryEvent<A, G>
  | EnergyEvent<A, G, E>
  | AgentDeathEvent<A>
  | BrainAnalysisBeginEvent<A>
  | BrainAnalysisEndEvent<A>
  | StepEndEvent
  | EpochEndEvent
  | SimEndEvent;

/** `SimEvent` narrowed to the members with a given `type` tag. */
export type SimEventOf<T extends EventType, A = AgentRef, G = GameObjectRef, E = EnergyRef> = Extract<
  SimEvent<A, G, E>,
  { readonly type: T }
>;

/** Native `sim::StatusText` (`std::vector<char *>`) — the lines the UI/monitor displays. */
export type StatusText = readonly string[];

/** Native `sim::Position` — a plain 3-float position. */
export interface Position {
  x: number;
  y: number;
  z: number;
}
