import { describe, expect, it } from 'vitest';
import { createFixedStepAccumulator } from './fixedStep';

describe('fixedStep accumulator', () => {
  it('produces whole steps only once a full step of time has accrued', () => {
    const acc = createFixedStepAccumulator({ stepSeconds: 0.1, speed: 1, maxStepsPerFrame: 8 });

    expect(acc.advance(40)).toBe(0); // 0.04 s banked
    expect(acc.advance(70)).toBe(1); // 0.11 s -> 1 step, 0.01 s left
    expect(acc.advance(90)).toBe(1); // 0.10 s -> 1 step
    expect(acc.advance(100)).toBe(1);
  });

  it('scales simulated time by speed without changing step size', () => {
    const at1x = createFixedStepAccumulator({ stepSeconds: 0.05, speed: 1, maxStepsPerFrame: 64 });
    const at8x = createFixedStepAccumulator({ stepSeconds: 0.05, speed: 8, maxStepsPerFrame: 64 });

    let stepsAt1x = 0;
    let stepsAt8x = 0;
    for (let i = 0; i < 10; i++) {
      stepsAt1x += at1x.advance(16);
      stepsAt8x += at8x.advance(16);
    }

    // 160 ms of wall clock: 3 steps at 1x (0.05 s each), 25 steps at 8x — the step size is
    // the same in both, only simulated time differs.
    expect(stepsAt1x).toBe(3);
    expect(stepsAt8x).toBe(25);
    expect(at1x.advance(0)).toBe(0);
    expect(at8x.advance(0)).toBe(0);
  });

  it('clamps a single frame to maxStepsPerFrame and drops the backlog', () => {
    const acc = createFixedStepAccumulator({ stepSeconds: 0.02, speed: 1, maxStepsPerFrame: 5 });
    // A tab that was hidden for 10 s would otherwise ask for 500 steps.
    expect(acc.advance(10_000)).toBe(5);
    expect(acc.pendingSeconds()).toBe(0);
    expect(acc.advance(0)).toBe(0);
  });

  it('ignores junk deltas and refuses non-positive speeds', () => {
    const acc = createFixedStepAccumulator({ stepSeconds: 0.05, speed: 0, maxStepsPerFrame: 8 });
    expect(acc.speed()).toBe(1);
    expect(acc.advance(Number.NaN)).toBe(0);
    expect(acc.advance(-1000)).toBe(0);
    acc.setSpeed(-3);
    expect(acc.speed()).toBe(1);
  });

  it('reset() throws away banked time', () => {
    const acc = createFixedStepAccumulator({ stepSeconds: 0.1, speed: 1, maxStepsPerFrame: 8 });
    acc.advance(95);
    expect(acc.pendingSeconds()).toBeCloseTo(0.095, 6);
    acc.reset();
    expect(acc.pendingSeconds()).toBe(0);
    expect(acc.advance(4)).toBe(0);
  });
});
