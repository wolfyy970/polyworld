/**
 * Lane W1a — the sim-wide constants and enums that cross lane boundaries
 * (native `sim/simconst.h`, included by `sim/simtypes.h`).
 *
 * `ObjectType` is what an event payload carries for a collision, and the `MAX*` limits are
 * *schema-coupled* (native says "if you change this, you MUST change the schema file"), so
 * they belong to the frozen surface rather than to one lane. The MATE/FIGHT/GIVE status
 * masks are the native vocabulary for the `mate`/`fight`/`give` integers carried inside
 * `AgentContactBeginEvent::AgentInfo`, and `Logs::ContactLog` decodes them with exactly
 * those bits (`MATE__PREVENTED__PARTNER`, …).
 *
 * PORT-NOTE(types/simconst-masks): the mask *values* are frozen (they are written to event
 * logs as integers); the member names here are the native names with the double
 * underscores flattened (`MATE__PREVENTED__PARTNER` -> `MATE_PREVENTED_PARTNER`), because
 * the native spelling is a preprocessor convention, not a symbol anything prints.
 *
 * Enums that only one lane uses (`FitnessScope`, `FoodEnergyStatType`, `Scheduler` modes)
 * are deliberately *not* here: they are that lane's vocabulary, not a boundary.
 */

/** Native `sim::MAXDOMAINS` — keep in step with the worldfile schema. */
export const MAXDOMAINS = 10;
/** Native `sim::MAXMETABOLISMS`. */
export const MAXMETABOLISMS = 10;
/** Native `sim::MAXFITNESSITEMS`. */
export const MAXFITNESSITEMS = 5;

/** Native `sim::ObjectType` — what an object in the world is (collision payloads). */
export const ObjectType = {
  AGENT: 0,
  FOOD: 1,
  BRICK: 2,
  BARRIER: 3,
  EDGE: 4,
} as const;

export type ObjectType = (typeof ObjectType)[keyof typeof ObjectType];

/**
 * The `events/collisions.log` Type column tokens, indexed by `ObjectType` (`Logs::CollisionLog`).
 * The log stores the name, not the number, so the spelling is part of the byte contract.
 */
export const OBJECT_TYPE_NAMES: readonly string[] = ['agent', 'food', 'brick', 'barrier', 'edge'];

/**
 * Native `graphics/gobject.h` object-type *bits* — a **different** vocabulary from
 * `ObjectType` above (`ObjectType` is an enumeration 0..4 used by sim events; these are the
 * 1/2/4 bit masks `gobject::getType()` returns and `ANYTYPE` masks combine). Mixing them
 * up is silent: `AGENTTYPE === 1 === ObjectType.FOOD`.
 *
 * PORT-NOTE(types/gobject-type-bits): both vocabularies are frozen because both are written
 * to logs — `collisions.log` uses `ObjectType`, `carry.log` uses the gobject bits
 * (`{"A","F","B"}`).
 */
export const GObjectType = {
  ANY: 0xffffffff,
  AGENT: 0x1,
  FOOD: 0x2,
  BRICK: 0x4,
} as const;

export type GObjectType = (typeof GObjectType)[keyof typeof GObjectType];

/** Native `MATE__*` — mating status bits (`AgentContactInfo::mate`). */
export const MATE_NIL = 0;
export const MATE_DESIRED = 1 << 0;
export const MATE_PREVENTED_PARTNER = 1 << 1;
export const MATE_PREVENTED_CARRY = 1 << 2;
export const MATE_PREVENTED_MATE_WAIT = 1 << 3;
export const MATE_PREVENTED_ENERGY = 1 << 4;
export const MATE_PREVENTED_EAT_MATE_SPAN = 1 << 5;
export const MATE_PREVENTED_EAT_MATE_MIN_DISTANCE = 1 << 6;
export const MATE_PREVENTED_OF1 = 1 << 7;
export const MATE_PREVENTED_MAX_DOMAIN = 1 << 8;
export const MATE_PREVENTED_MAX_WORLD = 1 << 9;
export const MATE_PREVENTED_MAX_METABOLISM = 1 << 10;
export const MATE_PREVENTED_MISC = 1 << 11;
export const MATE_PREVENTED_MAX_VELOCITY = 1 << 12;
export const MATE_PREVENTED_WORLDFILE = 1 << 13;

/** Native `FIGHT__*` — fighting status bits (`AgentContactInfo::fight`). */
export const FIGHT_NIL = 0;
export const FIGHT_DESIRED = 1 << 0;
export const FIGHT_PREVENTED_CARRY = 1 << 1;
export const FIGHT_PREVENTED_SHIELD = 1 << 2;
export const FIGHT_PREVENTED_POWER = 1 << 3;

/** Native `GIVE__*` — giving status bits (`AgentContactInfo::give`). */
export const GIVE_NIL = 0;
export const GIVE_DESIRED = 1 << 0;
export const GIVE_PREVENTED_CARRY = 1 << 1;
export const GIVE_PREVENTED_ENERGY = 1 << 2;
