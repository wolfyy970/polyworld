/**
 * Lane L11 (sim) — the simulation loop (`src/library/sim/**`).
 *
 *   import { Simulation, Scheduler } from '../model/sim';
 *
 * | Module | Native | What it is |
 * |---|---|---|
 * | `scheduler.ts` | `sim/Scheduler.{h,cc}` | the per-step master/parallel/serial phase machine |
 * | `simulation.ts` | `sim/Simulation.{h,cc}` | `TSimulation`: the init phase order, the step loop, the agent update passes, energy accounting, the end phase |
 * | `interact.ts` | `Simulation.cc:1452-2909` | `Interact`, `DeathAndStats`, Mate/Fight/Give/Eat/Carry/Fitness, the contact events |
 * | `agents.ts` | `Simulation.cc:2914-3817` | `CreateAgents`, `Birth`, `Kill`, `analyzeBrain`, `updateFittest`, `AgentFitness` |
 * | `maintain.ts` | `Simulation.cc:3153-3745, 5261-5301` | `MaintainFood`/`MaintainBricks`, `AddFood`/`RemoveFood`, `FoodEnergyIn/Out`, `getRandomPatch` |
 * | `worldfile.ts` | `Simulation.cc:3822-4725` | `processWorldFile` + the lockstep/fitness/adaptivity mode forcing |
 * | `domain.ts` | `sim/Domain.h` | the per-domain record, its fittest list and its smite queue |
 * | `fittestList.ts` | `sim/FittestList.{h,cc}` | the best-N list (genomes stored, ties keep insertion order) |
 * | `geneStats.ts` | `sim/GeneStats.cc` | the per-gene mean/stddev the gene-stats log reads |
 * | `eatStatistics.ts` | `sim/EatStatistics.cc` | the eat-attempt ratios behind the runtime properties |
 * | `stats.ts` | `sim/simtypes.h:333-389` | `Stat` / `StatRecent` |
 * | `events.ts` | `utils/Events.h` | the per-step eat/mate event filter |
 * | `bindings.ts` | — | the concrete side of lane L8's seams (+ the graphics stand-ins) |
 *
 * Verification state, the PORT-NOTEs this lane adds and the Gaps rows it leaves are in
 * `PARITY.md` (the lane's own section). The oracle is `./oracle/run_parity.sh <scenario>
 * --candidate <run tree>`; `runner.ts` writes that tree in node.
 */

export * from './scheduler';
export * from './stats';
export * from './domain';
export * from './fittestList';
export * from './geneStats';
export * from './eatStatistics';
export * from './events';
export * from './bindings';
export * from './interact';
export * from './agents';
export * from './maintain';
export * from './worldfile';
export * from './simulation';
