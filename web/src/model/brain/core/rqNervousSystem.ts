/**
 * Lane L6 (brain core) — `brain/RqNervousSystem.{h,cc}`: a nervous system that builds *all*
 * nerves up front (the input nerves each get a `RqSensor`) instead of having the agent create
 * them. Used by the offline analysis path (`utils/analysis.cc`, `tools/neuron*`), not by the
 * simulation.
 *
 * PORT-NOTE(l6/rq-sensor-factory): native `createInput` constructs an `RqSensor` (defined in
 * `agent/RqSensor.h`, lane L8/L9) — so this class is the *ordering* of the nerves plus a
 * sensor factory, and the port takes the factory as a constructor argument rather than
 * importing the agent lane. The nerve order is the same as `agent::grow`'s, which is what
 * makes an Rq brain comparable with a sim brain.
 */

import { NerveType } from './nerve';
import { NervousSystem } from './nervousSystem';
import type { Sensor } from './sensor';
import type { Brain } from './brain';
import type { RngSurface } from '../../types';

export interface RqNervousSystemOptions {
  /** The `agent::config` flags that decide which nerves exist (lane L8's config). */
  enableMateWaitFeedback: boolean;
  enableSpeedFeedback: boolean;
  enableCarry: boolean;
  yawEncodingIsOppose: boolean;
  hasLightBehavior: boolean;
  enableVisionPitch: boolean;
  enableVisionYaw: boolean;
  enableGive: boolean;
  /** Native `new RqSensor( name, getRNG() )` — lane L9's sensor, injected. */
  createSensor: (name: string, rng: RngSurface) => Sensor;
}

export class RqNervousSystem extends NervousSystem {
  private readonly options: RqNervousSystemOptions;

  constructor(rng: RngSurface, options: RqNervousSystemOptions) {
    super(rng);
    this.options = options;
  }

  /** Native `RqNervousSystem::grow` — the input/output nerves, then the normal grow. */
  override grow(createBrain: (cns: NervousSystem) => Brain): void {
    const o = this.options;

    this.createInput('Random');
    this.createInput('Energy');
    if (o.enableMateWaitFeedback) this.createInput('MateWaitFeedback');
    if (o.enableSpeedFeedback) this.createInput('SpeedFeedback');
    if (o.enableCarry) {
      this.createInput('Carrying');
      this.createInput('BeingCarried');
    }
    this.createInput('Red');
    this.createInput('Green');
    this.createInput('Blue');

    this.createOutput('Eat');
    this.createOutput('Mate');
    this.createOutput('Fight');
    this.createOutput('Speed');
    this.createOutput('Yaw');
    if (o.yawEncodingIsOppose) this.createOutput('YawOppose');
    if (o.hasLightBehavior) this.createOutput('Light');
    this.createOutput('Focus');
    if (o.enableVisionPitch) this.createOutput('VisionPitch');
    if (o.enableVisionYaw) this.createOutput('VisionYaw');
    if (o.enableGive) this.createOutput('Give');
    if (o.enableCarry) {
      this.createOutput('Pickup');
      this.createOutput('Drop');
    }

    super.grow(createBrain);
  }

  private createInput(name: string): void {
    this.createNerve(NerveType.INPUT, name);
    this.addSensor(this.options.createSensor(name, this.getRNG()));
  }

  private createOutput(name: string): void {
    this.createNerve(NerveType.OUTPUT, name);
  }
}
