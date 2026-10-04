/**
 * Lane L11 (sim) — native `agent/Retina.*` bound as a `Sensor` (the L9 object, built on lane
 * W1j/L16's `VisionRetina`).
 *
 * PORT-NOTE(sim/retina-sensor): native `agent::grow` creates a retina **unconditionally**
 * (`agent.cc:570`) and registers it as the *first* sensor, and it is not a rendering-only object:
 *
 *   * `Retina::sensor_prebirth_signal` draws `4 * retinaWidth` values off the nervous system's own
 *     RNG (the `NERVOUS_SYSTEM` role — LOCAL MT19937 when `StaticTimestepGeometry True`, i.e. both
 *     oracle scenarios) once per prebirth cycle, *before* every other sensor's draw, and
 *     `Retina::sensor_update` writes the buffer into the `Red`/`Green`/`Blue` input nerves every
 *     step. With `Vision False` the buffer is never refreshed, so those nerves carry the prebirth
 *     noise forever — and that noise draw is `4 * 22 * 25 = 2200` MT19937 values per agent, which
 *     every later draw on that stream depends on (the per-step `RandomSensor` above all).
 *   * `Retina::sensor_start_functional` / `sensor_dump_anatomical` write the three channels' neuron
 *     ranges into the functional header and the anatomical dump (lane L7's `brain/**` bytes).
 *
 * So a vision-off run is **not** byte-exact without the retina: it is model, not graphics.
 *
 * Lane W1j/L16 already owns the acceptance arithmetic (`VisionRetina`, verified against recorded
 * native retina rows and the oracle's own nerve values); this class is the `Sensor` shell around it
 * — the two dump hooks the encoder lane never needs — plus the factory lane L8's `AgentDeps` asks
 * for. It lives in the sim lane because the sim is the lane that can bind it without editing L9's
 * file, and there must be exactly one implementation: when L9 lands it adopts this class
 * (PARITY.md → Gaps).
 *
 * PORT-NOTE(sim/retina-sensor-name): native `Sensor` has no name; lane L8's `SensorLike` asks for
 * one and nothing reads it, so the retina is labelled `Retina`.
 */

import type { RetinaFactoryLike } from '../agent';
import type { BrainTextFile, Nerve, NervousSystem, Sensor } from '../brain/core';
import type { RngSurface } from '../types';
import { VisionRetina } from '../vision';

/** Native `RandomNumberGenerator::range( lo, hi )` — the only draw `Retina` makes itself. */
interface RangeRng {
  range(lo: number, hi: number): number;
}

/** Native `new Retina( Brain::config.retinaWidth )`, as lane L8's `SensorLike`. */
export class RetinaSensor implements Sensor {
  /** Lane L8's `SensorLike` label (see PORT-NOTE(sim/retina-sensor-name)). */
  readonly sensorName = 'Retina';

  /** Native `Retina::width` / `Retina::buf` / the three channels (lane W1j/L16's object). */
  private readonly retina: VisionRetina;

  constructor(width: number) {
    this.retina = new VisionRetina(width);
  }

  /** Native `Retina::sensor_grow` — the channels bind to `Red`/`Green`/`Blue` by name. */
  sensorGrow(cns: NervousSystem): void {
    this.retina.sensorGrow(cns);
  }

  /**
   * Native `Retina::sensor_prebirth_signal` — `width * 4` draws of `range( 0.0, 255.0 )`, each
   * truncated to a byte, then one encode. The draw *count* is contract (see the note above).
   */
  sensorPrebirthSignal(rng: RngSurface): void {
    this.retina.sensorPrebirthSignal(rng as unknown as RangeRng);
  }

  /** Native `Retina::sensor_update` — the buffer's three channels, in channel order. */
  sensorUpdate(_bprint: boolean): void {
    this.retina.sensorUpdate();
  }

  /**
   * Native `Retina::updateBuffer( x, y, width, height )` (`Retina.cc:108-146`) — this port's
   * *row* form of it (`VisionRetina.updateRow`, PORT-NOTE `vision/retina-owns-the-buffer`): the
   * renderer hands the retina the slice it read back, and the encode into `Red`/`Green`/`Blue`
   * happens on the next `sensor_update` (i.e. in the brain update of the same step, native's
   * order). Lane L16's POV renderer is the caller (`vision/povScan.ts`); the WebGL2 atlas calls
   * `VisionRetina.updateRow` through the same seam.
   */
  updateRow(row: Uint8Array | Uint8ClampedArray): void {
    this.retina.updateRow(row);
  }

  /** Native `Retina::sensor_start_functional` — `Channel::start_functional` per channel. */
  sensorStartFunctional(file: BrainTextFile): void {
    for (const nerve of this.channels()) {
      const index = nerve.getIndex();
      file.printf(' %d-%d', index, index + nerve.getNeuronCount() - 1);
    }
  }

  /** Native `Retina::sensor_dump_anatomical` — `Channel::dump_anatomical` per channel. */
  sensorDumpAnatomical(file: BrainTextFile): void {
    for (const nerve of this.channels()) {
      const index = nerve.getIndex();
      // `sprintf( name, "%c%sinput", tolower( name[0] ), name.substr( 1 ) )` (`Retina.cc:265-267`).
      const name = `${nerve.name.slice(0, 1).toLowerCase()}${nerve.name.slice(1)}input`;
      file.printf(' %s=%d-%d', name, index, index + nerve.getNeuronCount() - 1);
    }
  }

  /** The three channel nerves, in `sensor_grow` order (the runtime objects are lane L6's). */
  private channels(): Nerve[] {
    return this.retina.bindings().map((binding) => binding.nerve as unknown as Nerve);
  }
}

/** Native `new Retina( width )` — lane L8's `AgentDeps.retinaFactory`. */
export function retinaFactory(): RetinaFactoryLike {
  return { create: (width: number) => new RetinaSensor(width) };
}
