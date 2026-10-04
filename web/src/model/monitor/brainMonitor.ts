/**
 * Lane L14 — `BrainMonitor` and `PovMonitor` (`Monitor.h:147-177`, `Monitor.cc:220-257`).
 *
 * Both are thin: the brain monitor wakes a listener every `frequency` steps (the GUI draws the
 * tracked agent's brain), the POV monitor is a no-op step whose only job is to hand the UI the
 * agent POV renderer. Neither writes an artifact and neither touches the model.
 *
 * PORT-NOTE(monitor/brain-frequency-modulo): native is `if( (timestep % frequency) == 0 )` —
 * with the schema's `min 1` for `Frequency` the divisor is never 0, and step 0 (never passed:
 * `getStep()` is ≥ 1 when `stepEnding` fires) is irrelevant. Kept verbatim.
 */

import { Monitor, MonitorType } from './monitor';
import { Signal } from './signal';
import type { AgentTracker } from './agentTracker';
import type { MonitorSim } from './simSurface';

export class BrainMonitor extends Monitor {
  /** Native `util::Signal<> update`. */
  readonly update: Signal<[]> = new Signal<[]>();

  private readonly frequency: number;
  private readonly tracker: AgentTracker | null;

  constructor(sim: MonitorSim, frequency: number, tracker: AgentTracker | null) {
    super(MonitorType.BRAIN, sim, 'brainmonitor', 'Brain Monitor', 'Brain Monitor');

    this.frequency = frequency;
    this.tracker = tracker;
  }

  getTracker(): AgentTracker | null {
    return this.tracker;
  }

  step(timestep: number): void {
    if (timestep % this.frequency === 0) this.update.emit();
  }
}

/**
 * Native `PovMonitor` — `step()` is an explicit no-op; the renderer is fetched on demand from
 * the simulation (`GetAgentPovRenderer()`, lane L9).
 */
export class PovMonitor extends Monitor {
  constructor(sim: MonitorSim) {
    super(MonitorType.POV, sim, 'pov', 'POV', 'POV');
  }

  /** Native `AgentPovRenderer *getRenderer()` — opaque here (lane L9 owns the renderer). */
  getRenderer(): unknown {
    return this.sim.GetAgentPovRenderer();
  }

  step(_timestep: number): void {
    // noop, exactly as native (the retina rendering happens in the agent's own UpdateVision)
  }
}
