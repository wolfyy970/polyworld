/**
 * Lane L6 (brain core) — `brain/Sensor.h`: the interface the nervous system drives.
 *
 * Ported here (not in the sensor lanes) because it is the *brain*'s contract with its
 * sensors: `NervousSystem::{grow,update,prebirthSignal,startFunctional,dumpAnatomical}` walk
 * a `SensorList` and the order of that walk is model behaviour. L9 (`agent/Retina.*` and the
 * vision encoding) and L8 (`agent/*Sensor.*`) implement this interface; nothing in this lane
 * does.
 */

import type { BrainTextFile } from './textFile';
import type { NervousSystem } from './nervousSystem';
import type { RngSurface } from '../../types';

/** Native `Sensor`. */
export interface Sensor {
  /** Native `Sensor::sensor_grow` — called once, right after the brain is grown. */
  sensorGrow(cns: NervousSystem): void;
  /** Native `Sensor::sensor_prebirth_signal` — called once per prebirth cycle. */
  sensorPrebirthSignal(rng: RngSurface): void;
  /** Native `Sensor::sensor_update` — called once per world step, before the brain. */
  sensorUpdate(bprint: boolean): void;
  /** Native `Sensor::sensor_start_functional` — the "organs" part of a functional dump. */
  sensorStartFunctional(file: BrainTextFile): void;
  /** Native `Sensor::sensor_dump_anatomical`. */
  sensorDumpAnatomical(file: BrainTextFile): void;
}
