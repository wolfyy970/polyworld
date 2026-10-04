/**
 * Lane W1g — fixed-timestep accumulator.
 *
 * The shell advances the world in discrete steps on a fixed dt and renders at whatever
 * rate the display gives us. Two reasons, both from PORT_SPEC.md:
 *
 *  1. Determinism by construction. The spec asks the browser port to make recording
 *     deterministic "by construction (sample on step boundaries)" instead of reproducing
 *     the native movie's sampling jitter. Nothing can be sampled on a step boundary until
 *     steps have a boundary — hence a fixed dt, not `dt = frameDelta`.
 *  2. Speed control that means something. `speed` scales *simulated* time only; the step
 *     size never changes, so a 4x run visits the same states as a 1x run, sooner.
 *
 * PORT-NOTE (W1g/loop): the stepping itself is lane L11's (`sim/Simulation.cc`); this
 * accumulator is the clock that drives it — one `step()` call per returned step, always at the
 * fixed dt. Lane L11 has landed, and `app.ts` drives it exactly this way.
 */

export interface FixedStepOptions {
  /** Fixed simulated seconds per step. */
  stepSeconds: number;
  /** Simulated-time multiplier (0.25x … 8x). Values <= 0 are treated as 1. */
  speed: number;
  /** Upper bound on steps executed for one frame, so a stalled tab cannot spiral. */
  maxStepsPerFrame: number;
}

export interface FixedStepAccumulator {
  /** Feed wall-clock elapsed ms; returns how many steps to run this frame. */
  advance(elapsedMs: number): number;
  /** Change the simulated-time multiplier. */
  setSpeed(speed: number): void;
  /** Simulated-time multiplier currently in effect. */
  speed(): number;
  /** Throw away accumulated (unspent) time — e.g. after a tab was hidden. */
  reset(): void;
  /** Simulated seconds banked but not yet stepped — diagnostics only. */
  pendingSeconds(): number;
}

export function createFixedStepAccumulator(options: FixedStepOptions): FixedStepAccumulator {
  const stepSeconds = options.stepSeconds > 0 ? options.stepSeconds : 1 / 30;
  const maxStepsPerFrame = Math.max(1, Math.floor(options.maxStepsPerFrame));
  let currentSpeed = options.speed > 0 ? options.speed : 1;
  let pending = 0;

  return {
    advance(elapsedMs: number): number {
      // Guard against non-finite/negative deltas (paused tabs report 0; some browsers can
      // hand back a first frame delta of a few seconds).
      const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
      pending += (elapsed / 1000) * currentSpeed;

      let steps = Math.floor(pending / stepSeconds);
      if (steps > maxStepsPerFrame) {
        // Drop the excess rather than queueing it: keeping up with wall clock is less
        // important than staying responsive (classic spiral-of-death guard).
        steps = maxStepsPerFrame;
        pending = 0;
      } else {
        pending -= steps * stepSeconds;
      }
      return steps;
    },
    setSpeed(speed: number): void {
      currentSpeed = speed > 0 ? speed : 1;
    },
    speed(): number {
      return currentSpeed;
    },
    reset(): void {
      pending = 0;
    },
    pendingSeconds(): number {
      return pending;
    },
  };
}
