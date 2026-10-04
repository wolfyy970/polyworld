/**
 * Lane L8 — the agent's proprioceptive sensors (native `agent/{Energy,Random,MateWait,Speed,
 * Carrying,BeingCarried}Sensor.cc`).
 *
 * These are tiny but they are *model inputs*: each one writes a brain input nerve every step,
 * so their exact formulas are contract.
 *
 * PORT-NOTE(L8/sensor-preproprioception-switches): the native per-file
 * `#define DISABLE_PROPRIOCEPTION` values are transcribed as they are —
 * `MateWaitSensor`/`SpeedSensor` false (live values), `CarryingSensor`/`BeingCarriedSensor`
 * true. In the last two the macro only guards an unused local before the live value is
 * computed, so the port keeps the live computation, which is what native executes.
 *
 * `Retina` is lane L9's and arrives through `AgentDeps.retinaFactory`; the `class Sensor`
 * base plumbing (registration, and the update loop that calls these methods) is lane L6's,
 * expressed here as `AgentSensorLike`.
 */

import type { NervousSystemLike } from './nervousSystem';
import type { NervousSystemRngLike, NerveLike, SensorLike } from './contracts';
import { agentConfig } from './agentConfig';
import { clamp, f32 } from './numeric';

/**
 * The native `Sensor` interface as the agent lane uses it: the nervous system calls these
 * three methods (`sensor_grow` at brain-grow time, `sensor_prebirth_signal` in
 * `NervousSystem::prebirth()`, `sensor_update` every step).
 */
export interface AgentSensorLike extends SensorLike {
  sensorGrow(cns: NervousSystemLike): void;
  sensorPrebirthSignal(rng: NervousSystemRngLike): void;
  sensorUpdate(print?: boolean): void;
}

/** The agent state the sensors read (native `agent*` — the subset these sensors touch). */
export interface SensorHost {
  normalizedEnergy(): number;
  normalizedSpeed(): number;
  age(): number;
  lastMate(): number;
  numCarries(): number;
  beingCarried(): boolean;
}

/** Native `EnergySensor` — the brain's `Energy` input is the agent's *normalized* energy. */
export class EnergySensor implements AgentSensorLike {
  readonly sensorName = 'Energy';
  private nerve: NerveLike | undefined;

  constructor(private readonly self: SensorHost) {}

  sensorGrow(cns: NervousSystemLike): void {
    this.nerve = cns.getNerve('Energy');
  }

  sensorPrebirthSignal(rng: NervousSystemRngLike): void {
    this.nerve!.set(rng.drand());
  }

  sensorUpdate(): void {
    this.nerve!.set(this.self.normalizedEnergy());
  }
}

/** Native `RandomSensor` — the brain's `Random` input is a draw from the *local* RNG. */
export class RandomSensor implements AgentSensorLike {
  readonly sensorName = 'Random';
  private nerve: NerveLike | undefined;

  constructor(private readonly rng: NervousSystemRngLike) {}

  sensorGrow(cns: NervousSystemLike): void {
    this.nerve = cns.getNerve('Random');
  }

  sensorPrebirthSignal(): void {
    this.sensorUpdate(false);
  }

  sensorUpdate(_print = false): void {
    void _print;
    // Native `nerve->set( rng->drand() )`: `Nerve::set` takes a **double** and the activation
    // array is `double[]`, so there is no `float` narrowing here.
    this.nerve!.set(this.rng.drand());
  }
}

/**
 * Native `MateWaitSensor` — `clamp( 1 - (age - lastMate) / mateWait, 0, 1 )`, inverted when
 * the worldfile asks. `mateWait` is the value `agent::grow()` was called with (`-fLastMate`
 * for a seed), not the agent's current one.
 */
export class MateWaitSensor implements AgentSensorLike {
  readonly sensorName = 'MateWaitFeedback';
  private nerve: NerveLike | undefined;

  constructor(
    private readonly self: SensorHost,
    private readonly mateWait: number,
  ) {}

  sensorGrow(cns: NervousSystemLike): void {
    this.nerve = cns.getNerve('MateWaitFeedback');
  }

  sensorPrebirthSignal(rng: NervousSystemRngLike): void {
    this.nerve!.set(rng.drand());
  }

  sensorUpdate(): void {
    // Native: `float activation = 1.0 - float(age - lastMate) / mateWait;` — the subtraction
    // is long, the cast and the division are float, and the `1.0 -` is double.
    let activation = f32(1.0 - f32(f32(this.self.age() - this.self.lastMate()) / this.mateWait));
    activation = clamp(activation, 0, 1);
    if (agentConfig.invertMateWaitFeedback) activation = f32(1.0 - activation);
    this.nerve!.set(activation);
  }
}

/** Native `SpeedSensor` — the brain's `SpeedFeedback` input is the normalized speed. */
export class SpeedSensor implements AgentSensorLike {
  readonly sensorName = 'SpeedFeedback';
  private nerve: NerveLike | undefined;

  constructor(private readonly self: SensorHost) {}

  sensorGrow(cns: NervousSystemLike): void {
    this.nerve = cns.getNerve('SpeedFeedback');
  }

  sensorPrebirthSignal(rng: NervousSystemRngLike): void {
    this.nerve!.set(rng.drand());
  }

  sensorUpdate(): void {
    this.nerve!.set(this.self.normalizedSpeed());
  }
}

/** Native `CarryingSensor` — 1.0 when the agent carries anything, else 0.0. */
export class CarryingSensor implements AgentSensorLike {
  readonly sensorName = 'Carrying';
  private nerve: NerveLike | undefined;

  constructor(private readonly self: SensorHost) {}

  sensorGrow(cns: NervousSystemLike): void {
    this.nerve = cns.getNerve('Carrying');
  }

  sensorPrebirthSignal(rng: NervousSystemRngLike): void {
    this.nerve!.set(rng.drand());
  }

  sensorUpdate(): void {
    this.nerve!.set(this.self.numCarries() > 0 ? 1.0 : 0.0);
  }
}

/** Native `BeingCarriedSensor` — 1.0 when this agent is being carried, else 0.0. */
export class BeingCarriedSensor implements AgentSensorLike {
  readonly sensorName = 'BeingCarried';
  private nerve: NerveLike | undefined;

  constructor(private readonly self: SensorHost) {}

  sensorGrow(cns: NervousSystemLike): void {
    this.nerve = cns.getNerve('BeingCarried');
  }

  sensorPrebirthSignal(rng: NervousSystemRngLike): void {
    this.nerve!.set(rng.drand());
  }

  sensorUpdate(): void {
    this.nerve!.set(this.self.beingCarried() ? 1.0 : 0.0);
  }
}
