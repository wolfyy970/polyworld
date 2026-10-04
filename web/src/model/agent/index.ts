/**
 * Lane L8 — agent core (`src/library/agent/**`, minus the retina).
 *
 *   import { Agent, agentConfig, processWorldfile, Energy } from '../model/agent';
 *
 * What the lane owns, by native file:
 *
 *   agent/agent.cc, agent/agent.h   -> agent.ts, agentConfig.ts   (energy, lifespan,
 *                                      movement/steering, eat/mate/carry, collisions,
 *                                      the step: UpdateBody/UpdateColor/UpdateBrain)
 *   agent/LifeSpan.{h,cc}           -> lifeSpan.ts
 *   agent/Metabolism.{h,cc}         -> metabolism.ts
 *   agent/*Sensor.cc                -> sensors.ts (Retina is L9's)
 *   utils/misc.h macros             -> numeric.ts
 *
 * `environment/Energy.{h,cc}` is **not** here: lane L8 carried its definition (the agent core
 * cannot be expressed without it) until L10 landed, and it has now moved to where native keeps
 * it — `src/model/environment/energy.ts`. PORT-NOTE(`L8/energy-home`) below is the record.
 *
 * The lane's boundary — everything the agent core needs from genome (L5), brain (L6),
 * environment (L10), graphics (L15) and simulation (L11) — is `contracts.ts` +
 * `nervousSystem.ts`. No module here imports another lane's implementation.
 *
 * PORT-NOTE(L8/energy-home): the `Energy` value type is native `environment/Energy.{h,cc}`,
 * which belongs to lane L10's directory. L8 carried the definition while L10 did not exist and
 * asked for it to be *moved* (not copied) once both lanes were quiescent — done: the module body
 * (and `MAX_ENERGY_TYPES`/`ENERGY_EPSILON`) lives in `src/model/environment/energy.ts`, this
 * lane's importers point at it (`agent.ts`, `metabolism.ts`, `contracts.ts`, this barrel), and
 * there is exactly one definition. A second `Energy` is the one outcome that silently changes
 * every recorded energy log; PARITY.md → Gaps carried the hop and it is closed.
 *
 * Verification: `native/` holds the probe that generates this lane's differential vectors
 * from the real C++ build, and `tests/agent.test.ts` replays them bit-for-bit.
 */

export * from './agent';
export * from './agentConfig';
export * from './contracts';
// The `Energy` module is lane L10's directory (native `environment/Energy.{h,cc}`); the lane
// still re-exports it so `import { Energy } from '../model/agent'` keeps working — a re-export,
// not a second definition (PORT-NOTE `L8/energy-home` above).
export * from '../environment/energy';
export * from './lifeSpan';
export * from './metabolism';
export * from './nervousSystem';
export * from './numeric';
export * from './sensors';
