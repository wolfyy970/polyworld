/**
 * Lane W1a — agent lifecycle enums (native `agent/LifeSpan.h`).
 *
 * These two enums cross a lane boundary the moment they are written down: the simulation
 * lane (L11) raises the events, the agent lane (L8) stores them in each agent's `LifeSpan`,
 * and the logs lane (L12) writes the *names* into `run/lifespans.txt`:
 *
 *   BirthsDeaths.log / lifespans.txt lines
 *     "3\t0\tSIMINIT\t1\tSIMEND"          (Agent, BirthStep, BirthReason, DeathStep, DeathReason)
 *
 * The names are the contract, so they are frozen here alongside the values: the native
 * `BR_NAMES`/`DR_NAMES` tables are built by stringifying the enum member names
 * (`LifeSpan.cc`), and `Logs::LifeSpanLog` writes `BR_NAMES[birth.reason]` /
 * `DR_NAMES[death.reason]`.
 *
 * PORT-NOTE(types/lifespan-enums): one definition. Lane L8's `LifeSpan` must consume these
 * rather than declare its own, because the numeric values are also written to logs
 * (`DeathReason` ordering is `INVALID, SIMEND, SMITE, PATCH, NATURAL, FIGHT, EAT,
 * LOCKSTEP, RANDOM`) and any renumbering silently changes recorded output.
 */

/** Native `LifeSpan::BirthReason`. */
export const BirthReason = {
  INVALID: 0,
  SIMINIT: 1,
  CREATE: 2,
  NATURAL: 3,
  LOCKSTEP: 4,
  VIRTUAL: 5,
} as const;

export type BirthReason = (typeof BirthReason)[keyof typeof BirthReason];

/** Native `LifeSpan::BR_NAMES` — `BR_NAMES[BirthReason.NATURAL] === 'NATURAL'`. */
export const BIRTH_REASON_NAMES: readonly string[] = [
  'INVALID',
  'SIMINIT',
  'CREATE',
  'NATURAL',
  'LOCKSTEP',
  'VIRTUAL',
];

/** Native `LifeSpan::__BR_NTYPES`. */
export const NUM_BIRTH_REASONS = 6;

/** Native `LifeSpan::DeathReason`. */
export const DeathReason = {
  INVALID: 0,
  SIMEND: 1,
  SMITE: 2,
  PATCH: 3,
  NATURAL: 4,
  FIGHT: 5,
  EAT: 6,
  LOCKSTEP: 7,
  RANDOM: 8,
} as const;

export type DeathReason = (typeof DeathReason)[keyof typeof DeathReason];

/** Native `LifeSpan::DR_NAMES`. */
export const DEATH_REASON_NAMES: readonly string[] = [
  'INVALID',
  'SIMEND',
  'SMITE',
  'PATCH',
  'NATURAL',
  'FIGHT',
  'EAT',
  'LOCKSTEP',
  'RANDOM',
];

/** Native `LifeSpan::__DR_NTYPES`. */
export const NUM_DEATH_REASONS = 9;

/** Native `LifeSpan::BR_NAMES[ reason ]`. */
export function birthReasonName(reason: BirthReason): string {
  return BIRTH_REASON_NAMES[reason] ?? 'INVALID';
}

/** Native `LifeSpan::DR_NAMES[ reason ]`. */
export function deathReasonName(reason: DeathReason): string {
  return DEATH_REASON_NAMES[reason] ?? 'INVALID';
}
