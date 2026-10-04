/**
 * Lane L14 — the monitor lane's interface cut into the simulation (lane L11) and into the
 * agent it tracks (lane L8), plus the small enum vocabularies that live in `sim/simconst.h`
 * but are used *only* by monitors.
 *
 * Native source: `sim/Simulation.h` (the getters `Monitor.cc`/`MonitorManager.cc` call),
 * `sim/simconst.h` (`FitnessWeightType`, `FoodEnergyStatType`, `FoodEnergyStatScope`,
 * `FitnessStatType`, `AgentBirthType`).
 *
 * PORT-NOTE(monitor/simconst-extras): the frozen `src/model/types/simconst.ts` deliberately
 * carries only the *cross-lane* vocabulary (MAXDOMAINS/MAXMETABOLISMS/MAXFITNESSITEMS,
 * `ObjectType`, the MATE/FIGHT/GIVE masks, the gobject bits) and its header says so: "Enums
 * that only one lane uses (FitnessScope, FoodEnergyStatType, Scheduler modes) are deliberately
 * *not* here: they are that lane's vocabulary, not a boundary." The five enums below are the
 * monitor lane's vocabulary, so they are declared here with the native member order (the
 * *values* matter: `ABT__BORN_VIRTUAL` decides which counter the birth-rate curve reads, and
 * `FESS__*` indexes the food-energy scopes). Values are pinned by
 * `src/model/monitor/native/vectors/enums.json` where the type crosses into a probeable
 * signature, and by `simconst.h` for the rest (`ABT__CREATED`=0, `ABT__BORN`=1,
 * `ABT__BORN_VIRTUAL`=2; `FWT__COMPLEXITY`=0, `FWT__HEURISTIC`=1; `FEST__IN`=0, `FEST__OUT`=1;
 * `FESS__STEP`=0, `FESS__TOTAL`=1, `FESS__AVERAGE`=2; `FST__MAX_FITNESS`=0,
 * `FST__CURRENT_MAX_FITNESS`=1, `FST__AVERAGE_FITNESS`=2).
 *
 * PORT-NOTE(monitor/observer-only): the monitor lane consumes **no RNG** and **no wall
 * clock** — `grep -rn "rand\|drand48\|hirestime" library/monitor/*.cc` returns nothing
 * (measured; also stated in `docs/specs/sim-spec.md:820`). Every function here is therefore
 * free to be called in any order without perturbing the model's byte-exact outputs; the only
 * thing monitors *write* is `run/stats/stat.<timestep>` (StatusTextMonitor) and the movie
 * file (SceneMonitor → movie controller), and the latter is Tier C (not frozen).
 */

/**
 * Native `sim::AgentBirthType` — which birth counter `getNumBorn` returns.
 *
 * `BirthRateMonitor` picks `BORN_VIRTUAL` when the run is in lockstep or either fitness
 * weight is non-zero, otherwise `BORN`; it always reads `CREATED` for the denominator.
 */
export const AgentBirthType = {
  CREATED: 0,
  BORN: 1,
  BORN_VIRTUAL: 2,
} as const;
export type AgentBirthType = (typeof AgentBirthType)[keyof typeof AgentBirthType];

/** Native `sim::FitnessWeightType`. */
export const FitnessWeightType = {
  COMPLEXITY: 0,
  HEURISTIC: 1,
} as const;
export type FitnessWeightType = (typeof FitnessWeightType)[keyof typeof FitnessWeightType];

/** Native `sim::FitnessStatType`. */
export const FitnessStatType = {
  MAX_FITNESS: 0,
  CURRENT_MAX_FITNESS: 1,
  AVERAGE_FITNESS: 2,
} as const;
export type FitnessStatType = (typeof FitnessStatType)[keyof typeof FitnessStatType];

/** Native `sim::FoodEnergyStatType`. */
export const FoodEnergyStatType = {
  IN: 0,
  OUT: 1,
} as const;
export type FoodEnergyStatType = (typeof FoodEnergyStatType)[keyof typeof FoodEnergyStatType];

/** Native `sim::FoodEnergyStatScope`. */
export const FoodEnergyStatScope = {
  STEP: 0,
  TOTAL: 1,
  AVERAGE: 2,
} as const;
export type FoodEnergyStatScope = (typeof FoodEnergyStatScope)[keyof typeof FoodEnergyStatScope];

/**
 * A tracked agent, as the monitor lane sees it (native `class agent`, lane L8).
 *
 * Only the members `AgentTracker` and `CameraController` touch are here:
 *   `Number()`, `x()`, `z()`, `getCamera()` (agent-tracking camera), and the listener
 *   registration `setTarget` performs.
 *
 * PORT-NOTE(monitor/agent-removeListener-alive-guard): native
 * `agent::removeListener` is `if( fAlive ) listeners.remove(listener)` — it **silently does
 * nothing for a dead agent** (`agent.h:375`). `AgentTracker::setTarget(NULL)` is called from
 * the death listener *after* the agent died, so the listener stays registered on the dead
 * agent. Faithful porting therefore means the interface must let the implementation apply
 * that guard (lane L8's job, not the tracker's): the tracker always calls
 * `removeListener`, exactly as native does.
 */
export interface TrackedAgent {
  Number(): number;
  x(): number;
  z(): number;
  getCamera(): TrackedAgentCamera;
  addListener(listener: AgentDeathListener): void;
  removeListener(listener: AgentDeathListener): void;
}

/** Native `AgentListener` (`agent/AgentListener.h`): the death callback. */
export interface AgentDeathListener {
  died(a: TrackedAgent): void;
}

/** Native `gcamera` — only the members `CameraController` reads (lane L15 owns the real one). */
export interface TrackedAgentCamera {
  x(): number;
  y(): number;
  z(): number;
  getyaw(): number;
  getpitch(): number;
  getroll(): number;
}

/**
 * Native `TSimulation` — the surface the monitor lane calls.
 *
 * METHOD NAMES ARE NATIVE'S, including their inconsistencies (`getNumBorn` vs `GetNumDomains`),
 * so that a reader can diff this file against `Simulation.h` line by line.
 *
 * PORT-NOTE(monitor/sim-status-text): `getStatusText( out, statusFrequency )` *appends* to
 * `out` and is synchronous; native pushes `strdup`ed lines the caller must `free()` (the
 * monitor does, `Monitor.cc:288-292`). The port uses plain strings and `out.length = 0` to
 * clear, so there is nothing to free — the observable bytes are identical.
 */
export interface MonitorSim {
  /** Native `getStep()` — the value handed to `Monitor::step` at `stepEnding` (Step() :724). */
  getStep(): number;

  isLockstep(): boolean;
  getFitnessWeight(type: FitnessWeightType): number;

  GetMaxAgents(): number;
  GetNumDomains(): number;
  getNumAgents(domain?: number): number;

  getNumBorn(type: AgentBirthType): number;
  getFitnessStat(type: FitnessStatType): number;
  getFoodEnergyStat(type: FoodEnergyStatType, scope: FoodEnergyStatScope): number;

  /** Native `getCurrentFittest( rank )` (1 = best, -1 = worst), or null. */
  getCurrentFittest(rank: number): TrackedAgent | null;
  /** Native `getAgentByNumber( number )`, or null. */
  getAgentByNumber(number: number): TrackedAgent | null;

  /** Native `getStatusText( StatusText& out, int statusFrequency )`. */
  getStatusText(out: string[], statusFrequency: number): void;

  /** Native `GetAgentPovRenderer()` — lane L9's renderer, opaque here. */
  GetAgentPovRenderer(): unknown;

  /** Native `gstage &getStage()` — lane L15's scene stage, opaque here. */
  getStage(): unknown;
}
