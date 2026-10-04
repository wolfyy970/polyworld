/**
 * Lane L11 (sim) × lane W1h (cppprops) — the second `dyn` growers world through the sim.
 *
 * `growers_dyn` is `growers_small` with the dyn gate moved from `Step < 10000` to `Step < 10`, and
 * the ring left at the native `growingBarriers.wf` parameters — so the ring never switches inside
 * the 300-step window and the load falls on the *portable* bodies: `Barriers[0].Z2 dyn( Z1 ) { … }`
 * reads the live `AgentCount` (181 > 175) and grows by `0.0001` from the first step the gate lets
 * through, while `Barriers[1].Z2` reads `Barriers[0].Z2` through the property table, so the run
 * pins the update order too. This is the world where the `Z2` walk is the interesting half
 * (`-1 → -0.970895`, 292 distinct `%g` renderings of a `float` accumulation).
 *
 * This file runs one world (one `Simulation` per process — see `cpppropsSimWorld.ts`).
 *
 * **The drift this file used to pin is closed** (`t_da2ab201`, 2026-09-28). Its root cause was
 * lane L6's activation residual — clang's `-ffp-contract=on` in the shipped brain — which the
 * `Yaw` nerve's last bits carried into the agent's `float` yaw accumulator; with
 * `FiringRateModel`'s contractions transcribed the port reproduces **all 300 recorded lines**,
 * `divergenceCount === 0`, and the residue/event guards below take their release branch. The
 * guards are kept because the drift is one revert away: dropping just the two accumulation
 * `fmadd`s (`FiringRateModel::update`'s two neuron loops) puts `31/300` differing lines back.
 */

import { describe, expect, it } from 'vitest';

import { haveNativeTree, parseFarmLine, runWorld } from './cpppropsSimWorld';

const SCENARIO = 'growers_dyn';

/**
 * The columns this lane's engine context owns. `Alive0` is deliberately *not* here: the property's
 * cpp symbol (`context->sim->fNumberAliveWithMetabolism[ Metabolism::get( 0 )->index ]`) is this
 * lane's, but its value *is* the sim's agent count, so it inherits the agent-dynamics residue the
 * last test reports. The other seven are exact at all 300 steps.
 */
const CPPPROPS_COLUMNS = ['Step', 'FoodCount', 'B0Z2', 'B1Z2', 'P0On', 'P1On', 'P2On'];

describe.skipIf(!haveNativeTree)('L11 × W1h — growers_dyn through the sim', () => {
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

  it('grows the barrier exactly when the gate and the live population allow it', () => {
    // `Z2 dyn( Z1 )`: for `Step < 10` the body returns `value` unchanged, so the recording prints
    // `-1` for steps 1-9; step 10 is the first step the gate lets through, and `AgentCount` (181) is
    // already `> 175`, so the growth prints there — the body reads the *live* `AgentCount` at the
    // start of the step (`fStep` is already 10).
    expect(run.lines[8]).toContain('B0Z2=-1 ');
    expect(run.lines[9]).toContain('B0Z2=-0.9999');
    expect(run.lines[9]).toContain('Step=10');
    expect(run.lines[10]).toContain('B0Z2=-0.9998');

    // `Barriers[1].Z2 dyn( Barriers[0].Z2 )` follows through the property table at every step, and
    // the barrier actually walks: `-0.1`'s cap and the `float` accumulation are the recording's.
    const distinct = new Set<string>();
    for (let step = 0; step < run.recorded.length; step++) {
      const fields = parseFarmLine(run.lines[step] as string);
      const native = parseFarmLine(run.recorded[step] as string);
      expect(fields.get('B1Z2')).toBe(fields.get('B0Z2'));
      expect(fields.get('B0Z2')).toBe(native.get('B0Z2'));
      distinct.add(fields.get('B0Z2') as string);
    }
    expect(distinct.size).toBeGreaterThan(100);
    // The walk's end point, in the recording's own `%g` rendering.
    expect(run.lines[299]).toContain('B0Z2=-0.970895');
  });

  it('leaves the agent-count residue outside the cppprops surface', () => {
    // Known residue, reported on the card and NOT this lane's surface: after 238 steps in which
    // every column agrees, the port's *agent dynamics* drift by one agent (first at step 239:
    // AgentCount 273 vs 274 — with one metabolism `Alive0` follows it). Every cppprops column keeps
    // matching at that step and after it, which is the boundary of what this card claims; the drift
    // needs the LOCAL-RNG brain path this card is the first to make runnable at all
    // (PORT-NOTE(sim/brain-local-rng-provider)).
    if (run.divergenceCount === 0) return; // fixed by another lane: nothing to report
    expect([...run.divergentColumns.keys()].sort()).toEqual(['AgentCount', 'Alive0']);
    console.log(
      `[cppprops-sim] growers_dyn: ${run.divergenceCount}/300 lines differ, only in ` +
        `${[...run.divergentColumns.entries()]
          .map(([column, count]) => `${column}=${count}`)
          .join(' ')}`,
    );
  });

  /**
   * The residue at the *event* level, which is the finest thing the recording can arbitrate from
   * this side of the world: **two knife edges** — one `ENERGY` death landing one step early at 239
   * (transient: the recording kills the same agent the very next step, so the population offset
   * realigns), and then one `BIRTH` short from 246 on (permanent).
   *
   * `Simulation::getStatusText` prints `agents`, `created`, `born` and `died` for every step and
   * they satisfy `agents = created + born − died` (native's own identity — the port's counter trace
   * is checked against it below). `created` is the constant `InitAgents` seed count, so wherever
   * one of `born`/`died` still agrees with the recording's, the other is recoverable from the farm
   * log alone; measured against native's own status text (re-recorded in a scratch driver with
   * `tools/cppprops/fixtures/harness/record_scenario.py` — its farm log is byte-identical to the
   * pinned one):
   *
   *     recordedDied( step ) = created + portBorn( step ) − recordedAgentCount( step )   [1..245]
   *     recordedBorn( step ) = recordedAgentCount( step ) − created + portDied( step )   [246..251]
   *
   * and the port's `born` is the counter that moves first after the death realigns (steps 246+),
   * which is what fixes each window's end.
   *
   * What those two steps *are* — and why they land one step off — is on the card, not in this
   * test: both are knife-edge f32 roundings in an agent's accumulated `fYaw`, flipped by the brain
   * lane's activation residual (the `Yaw` nerve differs from native's in the low mantissa bits, so
   * `dyaw`'s f32 narrowing lands one ulp away whenever the yaw sum sits near a rounding boundary).
   * The grown-synapse dumps — i.e. the LOCAL-RNG wiring this card's parent made runnable — are
   * byte-identical to the native recording's for all 180 seeded agents, and feeding the *native's*
   * nerve values through the port's own yaw chain reproduces native's `yaw` bit-for-bit at every
   * step up to the drift. See PARITY.md's L11 Gaps row for the whole chain.
   */
  it('drifts on two knife edges: an ENERGY death a step early at 239, then one BIRTH short from 246', () => {
    const steps = run.perStep;
    expect(steps).toHaveLength(300);
    // The identity the counters have to satisfy at every step, and the constant seed count both
    // derivations below need.
    for (const counters of steps) {
      expect(counters.agents).toBe(counters.created + counters.born - counters.died);
      expect(counters.created).toBe(180);
    }
    if (run.divergenceCount === 0) return; // fixed by another lane: nothing to pin

    const recordedAgents = (step: number): number =>
      Number(parseFarmLine(run.recorded[step - 1] as string).get('AgentCount'));
    const recordedDied = (step: number): number =>
      steps[0]!.created + steps[step - 1]!.born - recordedAgents(step);
    const recordedBorn = (step: number): number =>
      recordedAgents(step) - steps[0]!.created + steps[step - 1]!.died;

    // (a) Steps 1..245: exactly one step carries an extra death — 239, by one.
    const extraDeathSteps: number[] = [];
    for (let step = 1; step <= 245; step++) {
      const extra = steps[step - 1]!.died - recordedDied(step);
      expect(extra).toBe(step === 239 ? 1 : 0);
      if (extra !== 0) extraDeathSteps.push(step);
    }
    expect(extraDeathSteps).toEqual([239]);
    expect(run.firstDivergence?.split('\n')[0]).toContain('Step=239');

    // (b) That death is an ENERGY death — the port's own deltas at 239 are `died +3 / energy +3`
    // (`perStep[i]` is the state *after* step `i + 1`, so a step's delta is
    // `perStep[step-1] − perStep[step-2]`) — and the recording realigns on the next step: its own
    // death delta at 240 is +3 where the port's is +2, i.e. the *same* agent died a step early.
    expect(steps[238]!.died - steps[237]!.died).toBe(3);
    expect(steps[238]!.diedEnergy - steps[237]!.diedEnergy).toBe(3);
    expect(steps[239]!.died - steps[238]!.died).toBe(2);
    expect(recordedDied(240) - recordedDied(239)).toBe(3);

    // (c) The permanent *counter* offset, from 246: the recording's own birth count is exactly one
    // ahead of the port's (while the port's death count still matches, steps 246..251). The
    // population columns themselves are not one off — they oscillate around the recording (measured
    // `port − native` ∈ −4…+4 over the 62 steps from 239, 15 of them matching, e.g. step 286
    // 271 vs 275, step 297 282 vs 278) — so this counter is what "permanent" means here.
    for (let step = 246; step <= 251; step++) {
      expect(recordedBorn(step) - steps[step - 1]!.born).toBe(1);
    }
  });
});
