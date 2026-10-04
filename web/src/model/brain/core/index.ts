/**
 * Lane L6 (brain core) — public surface of `src/library/brain/**` except the recording paths
 * (lane L7) and the GL renderer (L15/L14).
 *
 * What the other lanes may use:
 *
 *   - `NervousSystem` / `Nerve` / `Sensor` — the agent lane (L8) creates the nerves, adds its
 *     sensors and drives `update()`; the vision lane (L9) implements `Sensor`.
 *   - `Brain` / `GroupsBrain` / `SheetsBrain` / the neuron models — the sim lane (L11) grows
 *     brains through the genome, and the log lanes (L7/L12) call the dumps.
 *   - `brainConfig` / `groupsConfig` + the worldfile readers — the sim lane's worldfile step.
 *   - `GroupsGenomeView` / `SheetsGenomeView` + the enums in `brainGenome.ts` — the genome
 *     lane (L5) implements the view; nothing else in this lane knows what a gene is.
 *
 * PORT-NOTE(l6/lane-boundary): this barrel is the *only* import path other lanes should use
 * (`import { … } from './model/brain/core'`), so the module layout inside stays free to move.
 */

import { Brain, brainConfig, type WorldfileReader } from './brain';
import { groupsConfig, initGroupsBrain, processGroupsWorldfile, type BrainFlags } from './groups/groupsBrain';
import { processSheetsWorldfile, type SheetsWorldfileReader } from './sheets/sheetsBrain';

export * from './cformat';
export * from './textFile';
export * from './nativeMath';
export * from './errors';
export * from './neuronModel';
export * from './baseNeuronModel';
export * from './firingRateModel';
export * from './spikingModel';
export * from './nerve';
export * from './sensor';
export * from './nervousSystem';
export * from './brain';
export * from './brainGenome';
export * from './brainRng';
export * from './growRng';
export * from './neuralNetRenderer';
export * from './rqNervousSystem';
export * from './groups/groupsBrain';
export * from './groups/growArithmetic';
export * from './sheets/sheetsModel';
export * from './sheets/sheetsBrain';

export { Brain, brainConfig } from './brain';
/** The RNG surfaces this lane draws from (frozen in `types/rng.ts`, implemented by W1d). */
export type { Mt19937Stream, RngRole, RngSurface } from '../../types';
export { groupsConfig, initGroupsBrain, processGroupsWorldfile } from './groups/groupsBrain';
export { processSheetsWorldfile, sheetsConfig } from './sheets/sheetsBrain';
export type { SheetsBrainConfig, SheetsWorldfileReader } from './sheets/sheetsBrain';
export type { BrainFlags, GroupsBrainConfig, GroupsBrainOptions } from './groups/groupsBrain';

/**
 * Native `Brain::init()` + `GroupsBrain::init()` + `SheetsBrain::init()` in the order
 * `Simulation::readWorldfile` calls them. `GroupsBrain::init` derives the group counts from
 * the agent flags (which is why they are an argument), and `Brain::init` reads
 * `GroupsBrain::config.maxvisneurpergroup` — so the order matters.
 *
 * `SheetsBrain::init()` is empty in native.
 */
export function initBrain(flags: BrainFlags): void {
  Brain.init(groupsConfig.maxvisneurpergroup);
  initGroupsBrain(flags);
}

/**
 * Native `Brain::processWorldfile( doc )` — the worldfile step that fills `Brain::config`
 * (and, through it, `GroupsBrain::config` and `SheetsBrain::config`; both are called
 * unconditionally by the native function, whichever architecture is selected).
 */
export function processBrainWorldfile(doc: WorldfileReader & SheetsWorldfileReader): void {
  Brain.processWorldfile(doc);
  processGroupsWorldfile(doc);
  processSheetsWorldfile(doc);
}

/** The brain configuration singleton (native `Brain::config`), re-exported for convenience. */
export { brainConfig as config };
