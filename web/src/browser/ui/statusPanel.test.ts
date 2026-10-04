/**
 * Lane L18c — the status panel's `scene objects` row. What is drawn, and what is *not*.
 *
 * The two expectations are the live readings `verify/demoEvidence.mjs`-style drivers took off the
 * built page (2026-10-04, this machine) for the two worlds that matter here: the recorded
 * `minitest_voff` (two walls from the schema default, ten food items, no brick patches) and the
 * demo `bricks_voff` (100 bricks, and its two `dyn` barriers still degenerate at boot, so 0/2).
 *
 * The row is a *string* on screen and nothing else reads it, so the honesty rule lives here: a
 * worldfile that declares no brick patches must not read as "this world has zero bricks" without
 * saying so.
 */

import { describe, expect, it } from 'vitest';

import { formatScene } from './statusPanel';

describe('L18c — the status panel’s `scene objects` row', () => {
  it('minitest_voff: two walls, no brick patches declared, ten food items', () => {
    expect(
      formatScene({
        foodCount: 10,
        brickCount: 0,
        barrierCount: 2,
        barriersDrawn: 2,
        brickPatchesDeclared: 0,
      }),
    ).toBe('2 barriers · 0 bricks (no BrickPatches) · 10 food');
  });

  it('bricks_voff: 100 bricks and two not-yet-grown (`0/2`) barriers', () => {
    expect(
      formatScene({
        foodCount: 0,
        brickCount: 100,
        barrierCount: 2,
        barriersDrawn: 0,
        brickPatchesDeclared: 1,
      }),
    ).toBe('0/2 barriers · 100 bricks · 0 food');
  });

  it('says `0 bricks` plainly only when the worldfile does declare brick patches', () => {
    const text = formatScene({
      foodCount: 3,
      brickCount: 0,
      barrierCount: 2,
      barriersDrawn: 2,
      brickPatchesDeclared: 1,
    });
    expect(text).toBe('2 barriers · 0 bricks · 3 food');
  });
});
