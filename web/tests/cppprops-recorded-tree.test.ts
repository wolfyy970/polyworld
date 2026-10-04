/**
 * Lane L12 (logs) × lane L11 (sim) — the per-agent artifact tree of a run **with births**
 * (task t_1263719e).
 *
 * What this locks, and why it needs its own world:
 *
 *  * The card that opened this work measured `growers_dyn` through this harness and read the
 *    result as "the per-agent recorders write nothing for agents born during a run": 181 files
 *    under `run/energy/agents` against native's 493, 360 anatomy dumps against 1195, and a
 *    `run/BirthsDeaths.log` of 0 bytes. Neither was a recorder bug. The harness constructed the
 *    `Simulation` in the invoking cwd and then chdir'd to its temp `outDir` before stepping, so the
 *    `init`-time files and the per-agent files landed in **two** trees (the missing 312 energy files
 *    and 835 anatomy dumps were found in the temp dir, `<tmp>/cppprops-sim-…/run/…`), and it
 *    stopped stepping without native's end phase, so the buffered sinks never reached disk
 *    (`BirthsDeaths.log`, a survivor's datalib file and every deferred-gzip `AbstractFile` dump stay
 *    in memory until the recorders' destructors run — native's `~TSimulation`). See `runWorld`'s doc
 *    comment and its end-phase note.
 *
 *  * This file is the acceptance for both halves, on the world the card measured: every agent that
 *    ever lived has the per-agent files native writes, and `run/BirthsDeaths.log` carries native's
 *    own BIRTH/DEATH lines at the steps the model raised them. Everything is derived from the run's
 *    own state (`agentsEver`, the per-step counters) except the constants marked `NATIVE`, which are
 *    the reference recording's own counts (native `tools/cppprops/fixtures/harness/record_scenario.py`
 *    re-recording of the same worldfile with the twelve recording flags below — 492 agents ever,
 *    312 births, 211 deaths before the `SIMEND` kills, `MaxSteps 300`).
 *
 *  * The `run/energy/agents/max.txt` row *order* is deliberately **not** asserted: native appends
 *    its `AgentGrown` rows in thread-completion order, which is not stable between native runs
 *    (PARITY.md, `W1f --selfcheck`). The row multiset is asserted instead, as the count above.
 *
 * One world per process (see `cpppropsSimWorld.ts`), so this file runs exactly one world.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { haveNativeTree, runWorld } from './cpppropsSimWorld';

const SCENARIO = 'growers_dyn';

/**
 * The native reference run's argv (`record_scenario.py --args '…'`): every recorder that writes a
 * per-agent file in this world, plus the two run-level logs the card names.
 */
const RECORDING_ARGS: readonly string[] = [
  '--Vision', 'False',
  '--RecordEnergy', 'True',
  '--RecordAgentEnergy', 'True',
  '--RecordPosition', 'Precise',
  '--RecordBrain', 'True',
  '--RecordBrainAnatomy', 'True',
  '--RecordBrainFunction', 'True',
  '--RecordBrainRecent', 'True',
  '--RecordCollisions', 'True',
  '--RecordContacts', 'True',
  '--RecordBarrierPosition', 'True',
  '--RecordBirthsDeaths', 'True',
];

/** The reference recording's own counts (header comment). */
const NATIVE = {
  agents: 492,
  energyFiles: 493, // the 492 agents + max.txt
  positionFiles: 492,
  anatomyIncept: 492,
  anatomyBirth: 492,
  anatomyDeath: 211,
  anatomyFiles: 1195,
  functionFinished: 211,
  functionIncomplete: 281,
  functionFiles: 492,
  births: 312,
  deaths: 211,
  birthsDeathsLines: 524, // the header + 312 BIRTH + 211 DEATH
  survivors: 281,
} as const;

/**
 * `run/genome/meta/generange.txt` — `GenomeSchema::printRanges()`'s dump, verbatim from the
 * reference recording (997 bytes, sha256
 * `9b69dc50609839a3af062b0d31c3749d3ae61e73012f96b3000e1c38e0a31b05`).
 *
 * This file is in the tree because this world turns both RNG-seed genes on: with
 * `EnableTopologicalDistortionRngSeed` / `EnableInitWeightRngSeed` False (every recorded Tier-A
 * scenario) the two `*RngSeed` genes do not exist and the 21 remaining rows are the same ones
 * `tests/genome.test.ts` pins from the `microtest_voff`/`minitest_voff` goldens. The two
 * `IntNearest INT 0 INT 255` rows are native's: the schema builds those ranges from `long`
 * config fields, so the gene is an `INT` scalar with `SynapseAttrGene`'s fixed
 * `ROUND_INT_NEAREST` (`PORT-NOTE(genome/rng-seed-gene-int)`), and `growSynapses` reads it back
 * as a `long` (`PORT-NOTE(sim/rng-seed-gene-long-read)`) — the type is what makes
 * `long td_seed = _genome->get( … )` legal in native at all. The port built both from
 * `Scalar.float` and printed `None FLOAT 0.000000 FLOAT 255.000000` here (card t_cc4faf49).
 */
const NATIVE_GENERANGE =
  'None FLOAT 0.100000 FLOAT 0.600000 BitProbability\n' +
  'None FLOAT 0.001000 FLOAT 0.005000 MutationRate\n' +
  'IntFloor INT 2 INT 8 CrossoverPointCount\n' +
  'IntFloor INT 500 INT 1000 LifeSpan\n' +
  'None FLOAT 0.000000 FLOAT 1.000000 ID\n' +
  'None FLOAT 0.500000 FLOAT 2.000000 Strength\n' +
  'None FLOAT 0.500000 FLOAT 2.000000 Size\n' +
  'None FLOAT 0.500000 FLOAT 1.500000 MaxSpeed\n' +
  'None FLOAT 0.200000 FLOAT 0.800000 MateEnergyFraction\n' +
  'IntNearest INT 1 INT 16 Red\n' +
  'IntNearest INT 1 INT 16 Green\n' +
  'IntNearest INT 1 INT 16 Blue\n' +
  'IntNearest INT 0 INT 5 InternalNeuronGroupCount\n' +
  'IntNearest INT 0 INT 16 ExcitatoryNeuronCount\n' +
  'IntNearest INT 0 INT 16 InhibitoryNeuronCount\n' +
  'None FLOAT -8.000000 FLOAT 8.000000 Bias\n' +
  'None FLOAT 0.010000 FLOAT 1.000000 Tau\n' +
  'None FLOAT 0.100000 FLOAT 10.000000 Gain\n' +
  'None FLOAT 0.000000 FLOAT 1.000000 ConnectionDensity\n' +
  'None FLOAT 0.000000 FLOAT 0.100000 LearningRate\n' +
  'None FLOAT 0.000000 FLOAT 1.000000 TopologicalDistortion\n' +
  'IntNearest INT 0 INT 255 TopologicalDistortionRngSeed\n' +
  'IntNearest INT 0 INT 255 InitWeightRngSeed\n';

/** Every file under `root`, as a path relative to it, with its size. */
function tree(root: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(root, path), statSync(path).size);
    }
  };
  walk(root);
  return out;
}

/** The agent number in each name that matches `pattern`. */
function numbers(names: readonly string[], pattern: RegExp): number[] {
  return names
    .map((name) => pattern.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
}

function sorted<T extends number | string>(values: Iterable<T>): T[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe.skipIf(!haveNativeTree)('L12 × L11 — the recorded per-agent tree of a run with births', () => {
  const run = runWorld(SCENARIO, { args: RECORDING_ARGS });
  const files = tree(run.runDir);
  const names = [...files.keys()];
  const byDir = (dir: string): string[] =>
    sorted(names.filter((name) => name.startsWith(`${dir}/`)).map((name) => name.slice(dir.length + 1))) as string[];

  /** How many agents ever lived — native `agent::agentsEver`, the per-agent file-number domain. */
  const agents = run.agentsEver;
  const allAgents = Array.from({ length: agents }, (_, i) => i + 1);
  const last = run.perStep[run.perStep.length - 1]!;

  it('runs a world with births, and matches the reference recording’s own totals', () => {
    expect(agents, 'agents ever (native: 492)').toBe(NATIVE.agents);
    expect(last.agents, 'survivors at the last step (native: 281)').toBe(NATIVE.survivors);
    expect(last.born, 'births (native: 312)').toBe(NATIVE.births);
    // `fNumberDied` counts every death *except* the `DR_SIMEND` kills (native `Kill` returns before
    // bumping it), so it is the model-side count of the deaths native writes a DEATH line for.
    expect(last.died, 'deaths before the SIMEND kills (native: 211)').toBe(NATIVE.deaths);
  });

  it('gives every agent the energy, position, incept and birth files native writes', () => {
    const energy = byDir('energy/agents');
    expect(energy).toHaveLength(NATIVE.energyFiles);
    expect(sorted(energy.filter((name) => name.startsWith('agent_')))).toEqual(
      sorted(allAgents.map((n) => `agent_${n}.txt`)),
    );
    expect(energy).toContain('max.txt');

    // `max.txt` is the one shared per-agent table: one `AgentGrown` row per agent that ever lived.
    // Its *order* is native's thread-completion order and is not stable between native runs, so the
    // row multiset (i.e. the count) is what is checked here.
    const maxRows = readFileSync(join(run.runDir, 'energy/agents/max.txt'), 'utf8')
      .split('#<MaxEnergy>')[1]!
      .split('#</MaxEnergy>')[0]!
      .split('\n')
      .filter((row) => row.length > 0);
    expect(maxRows).toHaveLength(NATIVE.agents);

    expect(byDir('motion/position/agents')).toEqual(sorted(allAgents.map((n) => `position_${n}.txt`)));

    const anatomy = byDir('brain/anatomy');
    expect(anatomy).toHaveLength(NATIVE.anatomyFiles);
    const suffix = (suffixes: string): string[] => anatomy.filter((name) => name.endsWith(suffixes));
    expect(sorted(numbers(suffix('_incept.txt.gz'), /^brainAnatomy_(\d+)_/))).toEqual(allAgents);
    expect(sorted(numbers(suffix('_birth.txt.gz'), /^brainAnatomy_(\d+)_/))).toEqual(allAgents);

    // The `_death` dumps come from the `BrainAnalysisBegin` event, i.e. one per agent that died
    // before the `SIMEND` kills (`learningMode == LEARN_ALL` in this world).
    const deaths = sorted(numbers(suffix('_death.txt.gz'), /^brainAnatomy_(\d+)_/));
    expect(deaths).toHaveLength(NATIVE.anatomyDeath);
    expect(deaths.length).toBe(last.died);
  });

  it('closes every still-open brainFunction dump — the survivors included', () => {
    const fn = byDir('brain/function');
    expect(fn).toHaveLength(NATIVE.functionFiles);

    const finished = numbers(fn.filter((name) => !name.startsWith('incomplete_')), /^brainFunction_(\d+)\.txt\.gz$/);
    const incomplete = numbers(fn.filter((name) => name.startsWith('incomplete_')), /^incomplete_brainFunction_(\d+)\.txt\.gz$/);

    expect(finished).toHaveLength(NATIVE.functionFinished);
    expect(incomplete).toHaveLength(NATIVE.functionIncomplete);
    // one dump per agent that ever lived: the analysed ones renamed, the survivors left incomplete
    expect(sorted([...finished, ...incomplete])).toEqual(allAgents);
    // the two recorders that fire on a death agree on *which* agents they are
    const anatomyDeaths = numbers(byDir('brain/anatomy').filter((name) => name.endsWith('_death.txt.gz')), /^brainAnatomy_(\d+)_/);
    expect(sorted(finished)).toEqual(sorted(anatomyDeaths));
  });

  it('flushes every recorder at the end of the run — no artifact is left at 0 bytes', () => {
    const empty = sorted([...files.entries()].filter(([, size]) => size === 0).map(([name]) => name));
    expect(empty, 'zero-byte artifacts (the buffered sinks never reached disk before)').toEqual([]);
  });

  it('carries native’s own BIRTH/DEATH lines, at the steps the model raised them', () => {
    const log = readFileSync(join(run.runDir, 'BirthsDeaths.log'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    expect(log[0]).toBe('% Timestep Event Agent# Parent1 Parent2');
    expect(log).toHaveLength(NATIVE.birthsDeathsLines);

    const birthSteps = new Map<number, number>();
    const deathSteps = new Map<number, number>();
    for (const line of log.slice(1)) {
      const match = /^(\d+) (BIRTH|DEATH) (\d+)( \d+ \d+)?$/.exec(line);
      expect(match, `line '${line}' is not native's shape`).not.toBeNull();
      const step = Number(match![1]);
      const table = match![2] === 'BIRTH' ? birthSteps : deathSteps;
      table.set(step, (table.get(step) ?? 0) + 1);
    }

    // The lines are the model's own events: the per-step `fNumberBorn`/`fNumberDied` deltas are
    // `Simulation::getStatusText`'s counters, read after each step, and the recorder runs *inside*
    // that step.
    const perStepDeltas = (pick: (counters: (typeof run.perStep)[number]) => number): Map<number, number> => {
      const out = new Map<number, number>();
      let previous = 0;
      for (const counters of run.perStep) {
        const value = pick(counters);
        if (value !== previous) out.set(counters.step, value - previous);
        previous = value;
      }
      return out;
    };

    expect(birthSteps).toEqual(perStepDeltas((counters) => counters.born));
    expect(deathSteps).toEqual(perStepDeltas((counters) => counters.died));

    const total = (table: Map<number, number>): number => [...table.values()].reduce((a, b) => a + b, 0);
    expect(total(birthSteps)).toBe(NATIVE.births);
    expect(total(deathSteps)).toBe(NATIVE.deaths);
    // The `DR_SIMEND` kills are silenced, by native and by `formatDeathLine`: 281 agents died at the
    // end of this world and none of them is a DEATH line (which is why this is not 492 + 211).
    expect(total(deathSteps)).toBeLessThan(agents);
    // ... and the line the reference recording ends on is the line this run ends on.
    expect(log[log.length - 1]).toBe('300 BIRTH 492 317 145');
  });

  /**
   * The genome-meta side of the same run — the one artifact of this world that was *not* native's
   * before card t_cc4faf49 (`run/energy/agents/max.txt` is the other file that differs, by row
   * order alone).
   *
   * `run/genome/meta/generange.txt` is `GeneSchema::printRanges()` over the port's own schema, and
   * this world is one of the two that enable both RNG-seed genes — so its two `*RngSeed` rows are
   * the *only* place the port's transcription of native's `long`-ranged `SYNAPSE_ATTR` is
   * observable in an artifact (every Tier-A scenario leaves those genes out, and their goldens
   * therefore cannot see it). The assertion is the whole file, so the 21 unchanged rows are pinned
   * too. See `NATIVE_GENERANGE`.
   *
   * The same run is what exercises the other half of the fix: this world's
   * `EnableTopologicalDistortionRngSeed`/`EnableInitWeightRngSeed` are True, so
   * `GroupsBrain::growSynapses` seeds its two per-connection `RandomNumberGenerator`s from these
   * genes on every connection — through the `long` read (`PORT-NOTE(sim/rng-seed-gene-long-read)`),
   * i.e. `asInt()`. A revert of either half throws or prints here.
   */
  it('writes native’s own generange.txt — the two RNG-seed genes are `IntNearest INT`', () => {
    expect(readFileSync(join(run.runDir, 'genome/meta/generange.txt'), 'utf8')).toBe(NATIVE_GENERANGE);
  });
});
