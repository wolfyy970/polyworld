/**
 * Lane L11 (sim) × lane W1h (cppprops) — the negative control for the engine context.
 *
 * A fixture that cannot fail proves nothing. Here the *same* recorded world (`growers_ring`) is run
 * through the *same* module with the ring's engine input removed: every `FoodPatch::agentInsideCount`
 * is zeroed at the top of each step, which is exactly the state a caller with no engine context is
 * in (`run_cppprops.mjs` without `--engine` reads `0` for every patch). The sim accumulates those
 * counts *during* a step, so the ring's read point at the start of step N sees nothing.
 *
 * Measured: 299 of 300 steps diverge, the first at **step 2** with `Domains[0].FoodPatches[0].On`
 * `True` where the recording has `False`, and no `-patch` deaths at all — the same first step, the
 * same column and the same direction the sibling fixture card (`t_4e0e8f31`) measured on the CLI
 * path with its recorded table removed. So the 300/300 in `cppprops-sim-engine.test.ts` comes from
 * reading the live counts, not from a fixture that matches anything.
 *
 * This file runs one world (one `Simulation` per process — see `cpppropsSimWorld.ts`).
 */

import { describe, expect, it } from 'vitest';

import { haveNativeTree, parseFarmLine, runWorld } from './cpppropsSimWorld';

const SCENARIO = 'growers_ring';

describe.skipIf(!haveNativeTree)('L11 × W1h — the engine input is load-bearing', () => {
  const run = runWorld(SCENARIO, { zeroPatchCounts: true });

  it('diverges at step 2 (P0On) and never kills an agent by patch', () => {
    expect(run.firstDivergence).not.toBeNull();
    expect(run.divergenceCount).toBeGreaterThan(200);

    const port = parseFarmLine(run.lines[1] as string);
    const native = parseFarmLine(run.recorded[1] as string);
    expect(port.get('P0On')).toBe('True');
    expect(native.get('P0On')).toBe('False');
    // The delay window the maxPopulation branch opens is what the recording shows (`000` at step 2)
    // and what the starving run never reaches: without the counts the ring only ever times out.
    expect(['P1On', 'P2On'].map((title) => native.get(title))).toEqual(['False', 'False']);

    // The kill side effect is on the same input: `updateActive`'s `findActive( true, … )` is what
    // marks agents, and the recording's `-patch` counter ends at 67.
    expect(run.patchDeaths).toBe(0);

    // ... and the ring's own flag string shows the difference directly: the starving run only ever
    // sees the timeout branch (once per `timeout 20` steps), never the two-count switches.
    const transitions = run.onPattern.filter(
      (pattern, index) => index > 0 && pattern !== run.onPattern[index - 1],
    );
    expect(run.onPattern[0]).toBe('100');
    expect(run.onPattern[1]).toBe('100');
    expect(transitions.length).toBeLessThan(20);
  });
});
