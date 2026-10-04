/**
 * Lane W1a — the frozen shared surface (`src/model/types/`).
 *
 * Lanes import from here and from nowhere else in this directory tree:
 *
 *   import { createConfig, globals, type PropertyNode, type SimEvent } from '../types';
 *
 * Contents, by PORT_PLAN.md's interface cuts:
 *
 *   property / config / scalar / memoryDocument — the property document + config accessors
 *   globals                                     — the process-wide settings singleton
 *   events / lifespan / simconst                — event structs, lifecycle enums, sim constants
 *   rng / datalib / geometry                    — the frozen shapes of the other three cuts
 *
 * `rng/`, `datalib/` and `geometry/` are implemented by lanes W1d/W1c/W1e under
 * `src/model/{rng,datalib,geometry}`; what is re-exported here is their *contract* (the
 * function/enum surface they must satisfy and the shapes lanes share), so a lane can be
 * written and typechecked before those modules exist. A lane that needs the behaviour
 * imports the implementation module directly; nothing in the model should ever declare a
 * second copy of one of these types.
 */

export * from './config';
export * from './datalib';
export * from './errors';
export * from './events';
export * from './geometry';
export * from './globals';
export * from './lifespan';
export * from './memoryDocument';
export * from './property';
export * from './rng';
export * from './scalar';
export * from './simconst';
