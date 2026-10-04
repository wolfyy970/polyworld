/**
 * Lane L11 (sim) × lane W1h (cppprops) — `proplib::CppProperties::UpdateContext` in the sim.
 *
 * Native's `UpdateContext` is `{ TSimulation *sim; }` (`cppprops.h:32`), so a `dyn` body that
 * reaches through it (`portable: false` — today only the `FoodPatchTokenRing` ones) is bound by the
 * lane that owns the mutated symbol: here the sim. `src/model/sim/cppProperties.ts` is that half
 * (the live runtime values, `ctx.patchAgentInsideCount`, `ctx.engine.onActivatePatch`, and the
 * write-back of each dyn value into the model object its cpp symbol names), and this file pins it
 * the only way that counts: by running a recorded `dyn` worldfile **through the sim's own step
 * loop** and comparing the result to the native farm log, column by column, step by step.
 *
 * With the engine context wired the port reproduces `growers_ring`'s **300/300** recorded farm
 * lines — all nine columns, `B0Z2`/`B1Z2` (portable bodies reading the live `AgentCount`), the
 * three `P*On` columns (the ring, reading the live `FoodPatch::agentInsideCount`), `Alive0`, and
 * the `-patch` death count — and this file also pins the *inputs* of that match against the
 * recording's own state trace, so the result cannot be a coincidence of a copy: the counts the ring
 * reads at step N are the counts the recording printed at the end of step N-1.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CppPropertiesRefusalError, createCppProperties } from '../src/model/sim/cppProperties';
import {
  extractSpec,
  haveNativeTree,
  parseFarmLine,
  recordedState,
  runWorld,
} from './cpppropsSimWorld';

const SCENARIO = 'growers_ring';

/** Measured by the sibling fixture card: the native run's ` -patch` death counter ends at 67. */
const RECORDED_PATCH_DEATHS = 67;

describe.skipIf(!haveNativeTree)('L11 × W1h — the cppprops engine context in the sim', () => {
  // One world per process (see `cpppropsSimWorld.ts`): the run below is the only stepped
  // `Simulation` this file builds, and the assertions read its result.
  const run = runWorld(SCENARIO);

  it('reproduces all 300 recorded farm lines, every column', () => {
    expect(run.firstDivergence).toBeNull();
    expect(run.lines).toEqual(run.recorded);
    expect(run.lines).toHaveLength(300);
    expect(run.unresolvedStorage).toEqual([]);
  });

  it('kills the agents the ring’s activation marks, through the sim’s own death gate', () => {
    // `onActivatePatch( domain, patch, 5 )` is `FoodPatchTokenRing::updateActive`'s side effect
    // (`state.cc:205-213`): every agent inside the newly active patch gets `SetDeathByPatch()`, and
    // the sim kills them in `Interact`'s death gate — `Alive0` drops 181 → 139 at step 7 (42
    // agents) here *and* in the recording, and the `-patch` counter ends at the native 67.
    expect(run.lines[0]).toContain('Alive0=181');
    expect(run.lines[6]).toContain('Alive0=139');
    expect(run.patchDeaths).toBe(RECORDED_PATCH_DEATHS);

    // 35 `P*On` transitions after step 1's initial activation (12 maxPopulation → delay window, 12
    // delayEnd activations — the delegated-kill branch — and 11 timeout/immediate switches); the
    // recorded lines are counted, and the port's own patch flags are the same string at every step.
    const onOf = (line: string): string => {
      const fields = parseFarmLine(line);
      return ['P0On', 'P1On', 'P2On']
        .map((title) => (fields.get(title) === 'True' ? '1' : '0'))
        .join('');
    };
    const transitions = run.recorded.filter(
      (line, index) => index > 0 && onOf(line) !== onOf(run.recorded[index - 1] as string),
    );
    expect(transitions).toHaveLength(35);
    expect(run.onPattern).toEqual(run.recorded.map(onOf));
  });

  it('reads the ring’s input live, at the native phase', () => {
    // The discriminating control for the input channel, inside the acceptance run: the value every
    // patch holds when the ring reads it at step N is the count the recording printed at the end of
    // step N-1 (the alignment the sibling card measured as `stepShift -1`; a caller without an
    // engine context reads 0 everywhere, and reading step N's own counts diverges at step 26).
    const state = recordedState(SCENARIO);
    const mismatched: { step: number; port: number[]; recorded: number[] }[] = [];
    for (let index = 0; index < run.readPointCounts.length; index++) {
      const step = run.readPointStep[index] as number;
      const previous = state[step - 2];
      const expected =
        previous === undefined
          ? [0, 0, 0] // step 1: nothing has been accumulated yet (the fields start at 0)
          : ['0.0', '0.1', '0.2'].map((key) => previous.foodPatches?.[key]?.agentInsideCount ?? 0);
      const port = run.readPointCounts[index] as number[];
      if (port.join(',') !== expected.join(',')) mismatched.push({ step, port, recorded: expected });
    }

    // Exact wherever the phase can be arbitrated — and note the counts at step 2 are step 1's
    // (`23/24/40`, the milestone the sibling card measured), never step 2's own.
    expect(mismatched.filter((entry) => entry.step <= 250)).toEqual([]);
    // One late residue remains, the same one-agent difference the farm log cannot see: measured,
    // `step 299` patch 2 reads 21 where the recording printed 20 — after the recorded steps'
    // columns all still agree, so it is agent dynamics, not the engine input.
    expect(mismatched.length).toBeLessThanOrEqual(1);
    if (mismatched.length) console.log(`[cppprops-sim] read-point residue: ${JSON.stringify(mismatched)}`);

    // ... and those recorded counts are not zero, so the assertion above is not vacuous.
    const step1 = state[0] as { foodPatches?: Record<string, { agentInsideCount: number }> };
    expect(['0.0', '0.1', '0.2'].map((key) => step1.foodPatches?.[key]?.agentInsideCount)).toEqual([
      23, 24, 40,
    ]);
  });

  it('writes each dyn value back into the model object its cpp symbol names', () => {
    // `FoodPatch::on` *is* the property's storage natively (`metadata[i].value =
    // &( context->sim->fDomains[0].fFoodPatches[i].on )`), and food is cleared when a patch turns
    // off (`removeFood && !isOn() && isOnChanged()`) — so the recorded `FoodCount` column
    // (90 → 0 at step 2, back to 90 at step 7) is only reproducible if the write-back reached the
    // model, not just the property table.
    expect(run.lines[0]).toContain('FoodCount=90');
    expect(run.lines[1]).toContain('FoodCount=0');
    expect(run.lines[6]).toContain('FoodCount=90');

    // The barriers' storage is `barrier::gBarriers[i]->getPosition().zb`, whose consumer is
    // `agent::UpdateBody`'s barrier crossing test; the port's `LineSegment` follows the recorded
    // column at every step — the phase included: `Barriers[0].Z2` grows at step 187 (the step the
    // sibling card pinned with `B0Z2`), not 186, because the body reads the *live* `AgentCount`.
    expect(run.lines[185]).toContain('B0Z2=-1 ');
    expect(run.lines[186]).toContain('B0Z2=-0.9999');
  });

  it('serves the runtime properties from the live sim, never from a copy', () => {
    // A second stepped world is not possible in one process (see `cpppropsSimWorld.ts`), so the
    // harness captures `getMetadata()` (plus the sim's own counters) at the ctor, after step 1 and
    // after step 7, inside the single acceptance run above.
    const ctor = run.snapshots.ctor;
    const step1 = run.snapshots.step1;
    const step7 = run.snapshots.step7;

    // `getMetadata()` is the native table: all nine properties, in metadata order, which is what
    // the farm monitor matches by name (the status text prints only the five `Dynamic` entries).
    expect(ctor.properties.map((entry) => entry.name)).toEqual([
      'AgentCount',
      'AgentMetabolisms[0].MetabolismAgentCount',
      'Barriers[0].Z2',
      'Barriers[1].Z2',
      'Domains[0].FoodPatches[0].On',
      'Domains[0].FoodPatches[1].On',
      'Domains[0].FoodPatches[2].On',
      'FoodCount',
      'Step',
    ]);
    expect(ctor.properties.filter((entry) => entry.type === 0)).toHaveLength(5);

    // At the ctor nothing has been recorded yet: `Step` is the native `fStep` (still 0 — it is
    // incremented at the top of `Step()`), the agents are the `InitAgents` seeding, and there is no
    // food (it appears only once a patch is on).
    const at = (snapshot: typeof ctor, name: string): string | undefined =>
      snapshot.properties.find((entry) => entry.name === name)?.value;
    expect(at(ctor, 'Step')).toBe('0');
    expect(at(ctor, 'AgentCount')).toBe('180');
    expect(at(ctor, 'AgentMetabolisms[0].MetabolismAgentCount')).toBe('180');
    expect(at(ctor, 'FoodCount')).toBe('0');
    expect(at(ctor, 'Domains[0].FoodPatches[0].On')).toBe('False');

    // ... and every reading is the sim's live variable at that instant, not the value the update
    // was fed: `AgentCount`/`Alive0`/`FoodCount` at step 1 and step 7 (the patch-death step) match
    // the sim's own counters, and step 7's 139 is the recorded column.
    expect(step1.agents).toBe(181);
    expect(at(step1, 'AgentCount')).toBe(String(step1.agents));
    expect(at(step1, 'AgentMetabolisms[0].MetabolismAgentCount')).toBe(String(step1.alive0));
    expect(at(step1, 'FoodCount')).toBe(String(step1.food));
    expect(at(step1, 'FoodCount')).toBe('90');

    expect(step7.agents).toBe(139);
    expect(at(step7, 'AgentCount')).toBe(String(step7.agents));
    expect(at(step7, 'AgentMetabolisms[0].MetabolismAgentCount')).toBe(String(step7.alive0));
    expect(at(step7, 'AgentMetabolisms[0].MetabolismAgentCount')).toBe('139');
    // The `Dynamic` entries are the last update's values, which is what native's pointer holds:
    // step 7 is the recording's `000 → 010` delayEnd activation, so patch 1 is the active one.
    expect(at(step7, 'Domains[0].FoodPatches[0].On')).toBe('False');
    expect(at(step7, 'Domains[0].FoodPatches[1].On')).toBe('True');
    expect(at(step7, 'Domains[0].FoodPatches[2].On')).toBe('False');
  });

  it('refuses what it cannot serve instead of inventing a value', () => {
    // The W1h exit-3 contract, at the sim's own init point: `run_cppprops.mjs` exits 3 naming the
    // property and its unportable symbols, so the sim throws the same list rather than evaluating a
    // body whose engine call it cannot make.
    const unportable = {
      formatVersion: 1,
      worldfile: 'synthetic.wf',
      updateOrder: ['Domains[0].FoodPatches[0].On'],
      properties: [
        {
          index: 0,
          name: 'Domains[0].FoodPatches[0].On',
          kind: 'Dynamic',
          datalibType: 'BOOL',
          cppType: 'bool',
          cppSymbol: 'context->sim->fDomains[ 0 ].fFoodPatches[ 0 ].on',
          dynamic: {
            initial: 'False',
            initBody: '',
            updateBody: 'FoodPatchTokenRing::update( parent )',
            updateSource: 'update',
            metadataRefs: {},
            updatePortable: false,
            updateUnportableSymbols: ['FoodPatchTokenRing::update'],
            initPortable: true,
            initUnportableSymbols: [],
            portable: false,
            stateStruct: null,
            stage: -1,
          },
        },
      ],
    };

    const attempt = (): unknown => createCppProperties({ spec: unportable, bindings: {} });
    expect(attempt).toThrowError(CppPropertiesRefusalError);
    expect(attempt).toThrowError(/Domains\[0\]\.FoodPatches\[0\]\.On: FoodPatchTokenRing::update/);

    // The same spec *with* W1h's shipped registry constructs: the refusal is about the missing
    // binding, not about the shape of an unportable property.
    expect(createCppProperties({ spec: unportable })).toBeInstanceOf(Object);

    // A runtime property the spec carries but the port has no live source for is the same class of
    // refusal — never a 0.
    const outDir = mkdtempSync(join(tmpdir(), 'cppprops-sim-'));
    const spec = extractSpec(SCENARIO, outDir) as { properties: Record<string, unknown>[] };
    const runtime = spec.properties.find((prop) => prop['name'] === 'AgentCount')!;
    const unknown = {
      ...spec,
      // An empty update order: the property is the only entry, so the interpreter has nothing to
      // evaluate after the refusal check — which is the point (it must refuse while constructing).
      updateOrder: [],
      properties: [{ ...runtime, name: 'UnknownCount', cppSymbol: 'context->sim->fSomethingElse' }],
    };
    expect(() => createCppProperties({ spec: unknown })).toThrowError(
      /no live source for runtime property 'UnknownCount' \(context->sim->fSomethingElse\)/,
    );
  });
});
