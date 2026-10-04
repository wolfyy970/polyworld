/**
 * Lane L11 (sim) × lane W1h (cppprops) — the third `dyn` growers world through the sim.
 *
 * `growers_small` is the world the card that filed this file (`t_05b45824`) measured in a scratch
 * driver: `growers_dyn` with the dyn gate left at `Step < 10000`, so the ring/barrier never grows
 * inside the 300-step window and `B0Z2`/`B1Z2` stay `-1`. Everything else is byte-identical to
 * `growers_dyn.wf`, which is why it is a second, independent sample of the same residue rather than
 * a second world: the two runs share their first steps and then hit *different* knife edges.
 *
 * One `Simulation` per process (see `cpppropsSimWorld.ts`), hence one world per file.
 *
 * **The drift this file used to pin is closed** (`t_da2ab201`, 2026-09-28): lane L6's activation
 * residual (clang's `-ffp-contract=on` in the shipped brain) was what the `Yaw` nerve carried
 * into the agent's `float` yaw accumulator, and with `FiringRateModel`'s contractions
 * transcribed this world too reproduces **all 300 recorded lines** — its one missing `BIRTH`
 * from 267 included — with `divergenceCount === 0`, so the guards below take their release
 * branch. Reverting only the two accumulation `fmadd`s brings the class back in `growers_dyn`
 * (`31/300` differing lines), which is what keeps the release branch a live check.
 */

import { describe, expect, it } from 'vitest';

import { haveNativeTree, parseFarmLine, runWorld } from './cpppropsSimWorld';

const SCENARIO = 'growers_small';

/** The columns this lane's engine context owns. `AgentCount`/`Alive0` are the sim's own. */
const CPPPROPS_COLUMNS = ['Step', 'FoodCount', 'B0Z2', 'B1Z2', 'P0On', 'P1On', 'P2On'];

describe.skipIf(!haveNativeTree)('L11 × W1h — growers_small through the sim', () => {
  const run = runWorld(SCENARIO);

  it('reproduces every cppprops-owned column at every step', () => {
    expect(run.lines).toHaveLength(300);

    const mismatches: string[] = [];
    for (let step = 0; step < run.recorded.length; step++) {
      const got = parseFarmLine(run.lines[step] as string);
      const want = parseFarmLine(run.recorded[step] as string);
      for (const column of CPPPROPS_COLUMNS) {
        if (got.get(column) !== want.get(column)) {
          mismatches.push(
            `step ${step + 1} ${column}: port ${got.get(column)}, native ${want.get(column)}`,
          );
        }
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(run.unresolvedStorage).toEqual([]);
    expect(mismatches).toEqual([]);
  });

  it('leaves the agent-count residue outside the cppprops surface', () => {
    // Same residue, same shape as `growers_dyn`'s — and a different step, which is the point: this
    // world's knife edge falls at step 267 (`AgentCount` 279 vs 280), not at 239.
    if (run.divergenceCount === 0) return; // fixed by another lane: nothing to report
    expect([...run.divergentColumns.keys()].sort()).toEqual(['AgentCount', 'Alive0']);
    expect(run.firstDivergence?.split('\n')[0]).toContain('Step=267');
  });

  /**
   * The residue at the event level: **one BIRTH short, first at step 267** — where `growers_dyn`
   * loses an extra *death* at 239. Two worlds, one class: a threshold decision (an energy/mate
   * gate) landing a step off, then a permanent offset — in the *counter*, not the column: the port's
   * birth count stays exactly one short while the population columns oscillate around the recording
   * (measured `port − native` ∈ −1…+4 over the 34 steps from 267, 7 of them matching, e.g. step 300
   * 292 vs 288).
   *
   * The derivation is the mirror of `growers_dyn`'s: `agents = created + born − died` is native's
   * own identity, `created` is the constant seed count, and the port's `died` agrees with the
   * recording's own death count until step 274 (measured in a scratch driver against the native
   * status text that produced the pinned `farm.log`), so through step 273 the *recording's* birth
   * count is recoverable from the farm log alone:
   *
   *     recordedBorn( step ) = recordedAgentCount( step ) − created + portDied( step )
   *
   * and `recordedBorn − portBorn` is 0 for every step up to 266 and exactly 1 from 267 to 273 (the
   * port's own death count joins the divergence at 274, which is where this derivation stops being
   * sound — and where the cascade past the recorded `born`/`died` split takes over).
   */
  it('drops exactly one BIRTH, first at step 267', () => {
    const steps = run.perStep;
    expect(steps).toHaveLength(300);
    for (const counters of steps) {
      expect(counters.agents).toBe(counters.created + counters.born - counters.died);
      expect(counters.created).toBe(180);
    }
    if (run.divergenceCount === 0) return; // fixed by another lane: nothing to pin

    let firstDivergentStep: number | null = null;
    for (let step = 1; step <= 273; step++) {
      const recordedAgents = Number(parseFarmLine(run.recorded[step - 1] as string).get('AgentCount'));
      const recordedBorn = recordedAgents - steps[0]!.created + steps[step - 1]!.died;
      const missingBirths = recordedBorn - steps[step - 1]!.born;
      if (missingBirths > 0 && firstDivergentStep === null) firstDivergentStep = step;
      expect(missingBirths).toBe(step >= 267 ? 1 : 0);
    }
    expect(firstDivergentStep).toBe(267);

    // The recording births three agents on 267, the port two — and the deaths of that step agree.
    // `perStep[i]` is the state *after* step `i + 1`, so a step's own delta is
    // `perStep[step-1] - perStep[step-2]`.
    expect(steps[266]!.born - steps[265]!.born).toBe(2);
    expect(steps[266]!.died - steps[265]!.died).toBe(3);
  });
});
