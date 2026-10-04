/**
 * Lane W1a — `globals`: the process-wide settings native keeps in `sim/globals.cc`.
 *
 * Native is a class of statics written by `TSimulation::processWorldFile` and read by
 * agent, environment and scene code:
 *
 *   globals::worldsize    = doc.get( "WorldSize" );       // float
 *   globals::numEnergyTypes = doc.get( "NumEnergyTypes" ); // int (also Energy.cc)
 *   globals::blockedEdges / wraparound / stickyEdges       // set from doc.get( "Edges" )
 *   globals::recordFileType = (bool)doc.get( "CompressFiles" ) ? TYPE_GZIP_FILE : TYPE_FILE
 *
 * The port keeps the same shape — one mutable singleton object, value-typed — so a lane
 * reads `globals.worldsize` exactly as the native code reads `globals::worldsize`.
 *
 * PORT-NOTE(types/globals-singleton): native statics are zero-initialized before
 * `processWorldFile` runs (float 0 / bool false / enum 0), so the singleton starts clear
 * and *nothing* here infers a default from the worldfile: `resetGlobals()` restores that
 * pre-run state. The `Edges` string -> flag mapping is model behavior and stays in the
 * simulation lane (L11), not here.
 */

import { ConcreteFileType } from './datalib';

/** Native `sim/globals.h` constants. */
export const kMenuBarHeight = 22;
export const MAXLIGHTS = 10;
export const kWindowsGroupSettingsName = 'windows';

/** Native `class globals` — fields in declaration order. */
export interface Globals {
  /** Native `float worldsize` — world extent; agent motion, food, barriers, camera. */
  worldsize: number;
  /** Native `bool wraparound` — edges connect (world is a torus). */
  wraparound: boolean;
  /** Native `bool blockedEdges` — agents collide with the world edge. */
  blockedEdges: boolean;
  /** Native `bool stickyEdges` — agents stick to the world edge (blocked + sticky). */
  stickyEdges: boolean;
  /** Native `int numEnergyTypes` — energy vectors are this long (max `MAX_ENERGY_TYPES`). */
  numEnergyTypes: number;
  /** Native `AbstractFile::ConcreteFileType recordFileType` — plain files or gzip. */
  recordFileType: ConcreteFileType;
}

/** The singleton. Read it directly; the simulation lane writes it from the worldfile. */
export const globals: Globals = {
  worldsize: 0,
  wraparound: false,
  blockedEdges: false,
  stickyEdges: false,
  numEnergyTypes: 0,
  recordFileType: ConcreteFileType.TYPE_UNDEFINED,
};

/** Restore the singleton to its pre-`processWorldFile` (zero-initialized) state. Tests only. */
export function resetGlobals(): void {
  globals.worldsize = 0;
  globals.wraparound = false;
  globals.blockedEdges = false;
  globals.stickyEdges = false;
  globals.numEnergyTypes = 0;
  globals.recordFileType = ConcreteFileType.TYPE_UNDEFINED;
}
