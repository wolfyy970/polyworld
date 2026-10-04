/**
 * Lane L11 (sim) — `TSimulation::initFitnessMode` (t_077f3e96).
 *
 * A steady-state GA run — the ctor calls the function whenever
 * `fHeuristicFitnessWeight != 0.0 || fComplexityFitnessWeight != 0` (`Simulation.cc:292`) — forces
 * the whole population-control machinery off, discarding the worldfile's own values. The function
 * used to be a stub whose body set five fields native's function never touches, and none of the
 * eight it does; the omission is what made the port's `BirthsDeaths.log` diverge from native's at
 * *step 18* on the `t_20d5ff13` fixture (agent 23 killed by `FIGHT` against native's `NATURAL` at
 * 227; 5 deaths against 23) — see PARITY.md's Gaps row.
 *
 * Two halves, both cheap:
 *
 *   1. **the forced list, and nothing else** — the function is driven over a stub so that every
 *      write and every *non*-write is visible. In particular the five fields the old body set
 *      (`fNumberToSeed`/`fNumberBorn`/`fNumberCreated`, `fEpoch`, `fFitness2Frequency`) must come
 *      out of `initFitnessMode` **unchanged**: none of them is in native's function (`fEpoch =
 *      fEpochFrequency` is `processWorldFile`, `Simulation.cc:3913`; nothing in native zeroes
 *      `fFitness2Frequency`), so a regression that re-adds them fails here.
 *
 *   2. **the gate** — the six recorded scenarios must be *unable* to reach the function, because
 *      the recorded runs are what the milestone measures. This is asserted from the recorded
 *      worldfiles through the port's own document builder, not assumed from the fact that they
 *      still PASS: both fitness weights read `0.0` in all six, so the ctor's condition is false.
 *      Read-only; skipped loudly without the oracle tree, like `tests/sim-complexity-seam.test.ts`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { Config } from '../src/model/types';
import { emitNormalizedWorldfile } from '../src/model/proplib';
import { monitorDocumentEvaluator } from '../src/model/monitor/monitorDocument';
import { scenarioEntry } from '../src/model/sim/runner';
import type { Simulation } from '../src/model/sim/simulation';
import { initFitnessMode } from '../src/model/sim/worldfile';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = './etc/worldfile.wfs';
const RECORDED = [
  'microtest_voff',
  'minitest_voff',
  'microtest_von',
  'minitest_von',
  'hello',
  'minitest_adami',
] as const;

/** What `initFitnessMode` reads/writes, plus the fields it must leave alone. */
interface SimStub {
  fMinNumAgents: number;
  fInitNumAgents: number;
  fNumDepletionSteps: number;
  fMaxPopulationPenaltyFraction: number;
  fApplyLowPopulationAdvantage: boolean;
  fEnergyBasedPopulationControl: boolean;
  fEndOnPopulationCrash: boolean;
  // not native's function — must survive the call untouched
  fNumberToSeed: number;
  fNumberBorn: number;
  fNumberCreated: number;
  fEpoch: number;
  fEpochFrequency: number;
  fFitness2Frequency: number;
  fNumDomains: number;
  fDomains: { minNumAgents: number; maxNumAgents: number; initNumAgents: number }[];
  setStaticMaxNumAgents(value: number): void;
}

function stubSim(): { sim: Simulation; stub: SimStub; staticMaxWrites: number[] } {
  const staticMaxWrites: number[] = [];
  const stub: SimStub = {
    fMinNumAgents: 20,
    fInitNumAgents: 25,
    fNumDepletionSteps: 7,
    fMaxPopulationPenaltyFraction: 0.5,
    fApplyLowPopulationAdvantage: true,
    fEnergyBasedPopulationControl: true,
    fEndOnPopulationCrash: true,
    fNumberToSeed: 25,
    fNumberBorn: 3,
    fNumberCreated: 4,
    fEpoch: 0,
    fEpochFrequency: 100,
    fFitness2Frequency: 0xff,
    fNumDomains: 2,
    fDomains: [
      { minNumAgents: 1, maxNumAgents: 2, initNumAgents: 6 },
      { minNumAgents: 3, maxNumAgents: 4, initNumAgents: 7 },
    ],
    setStaticMaxNumAgents(value: number) {
      staticMaxWrites.push(value);
    },
  };
  return { sim: stub as unknown as Simulation, stub, staticMaxWrites };
}

describe('sim initFitnessMode — the forced-GA parameter list', () => {
  it("forces native's eight fields, including the *static* MaxNumAgents", () => {
    const { sim, stub, staticMaxWrites } = stubSim();

    initFitnessMode(sim);

    // `fMinNumAgents = fMaxNumAgents = fInitNumAgents` (`Simulation.cc:4638`): the instance min,
    // and the static max through the same writer `processWorldFile` uses for `MaxAgents`.
    expect(staticMaxWrites).toEqual([25]);
    expect(stub.fMinNumAgents).toBe(25);

    // each domain's min/max collapse onto its own init (`:4643-4647`)
    expect(stub.fDomains).toEqual([
      { minNumAgents: 6, maxNumAgents: 6, initNumAgents: 6 },
      { minNumAgents: 7, maxNumAgents: 7, initNumAgents: 7 },
    ]);

    // the population-control switches (`:4649-4653`)
    expect(stub.fNumDepletionSteps).toBe(0);
    expect(stub.fMaxPopulationPenaltyFraction).toBe(0.0);
    expect(stub.fApplyLowPopulationAdvantage).toBe(false);
    expect(stub.fEnergyBasedPopulationControl).toBe(false);
    expect(stub.fEndOnPopulationCrash).toBe(false);
  });

  it('sets nothing else — the five fields the old stub body wrote are not in native’s function', () => {
    const { sim, stub } = stubSim();

    initFitnessMode(sim);

    expect(stub.fNumberToSeed).toBe(25);
    expect(stub.fNumberBorn).toBe(3);
    expect(stub.fNumberCreated).toBe(4);
    // `fEpoch = fEpochFrequency` is `processWorldFile` (`Simulation.cc:3913`) — already ported
    // there — not `initFitnessMode`.
    expect(stub.fEpoch).toBe(0);
    // No native code turns `0xFF` into `0`; `fFitness2Frequency` is a plain `long` frequency
    // (`Simulation.h:295`, read as `PairFrequency`).
    expect(stub.fFitness2Frequency).toBe(0xff);
  });
});

describe('sim initFitnessMode — the recorded scenarios cannot reach it', () => {
  const hasOracle = existsSync(join(REPO, 'oracle', 'minitest_voff', 'run', 'normalized.wf'));

  it('every recorded scenario reads HeuristicFitnessWeight 0.0 / ComplexityFitnessWeight 0.0', () => {
    if (!hasOracle) {
      // `oracle/*/run/**` is gitignored; a developer without it cannot drive this.
      console.warn('sim-fitness-mode: skipped (no oracle run trees)');
      return;
    }

    const weights: Record<string, [number, number]> = {};
    for (const scenario of RECORDED) {
      const recorded = join(REPO, 'oracle', scenario, 'run');
      const originalWf = readFileSync(join(recorded, 'original.wf'), 'utf8');
      const originalWfs = readFileSync(join(recorded, 'original.wfs'), 'utf8');
      const entry = scenarioEntry(REPO, scenario);
      const worldfilePath = entry.worldfile;
      if (worldfilePath === null) {
        throw new Error(`sim-fitness-mode: scenario '${scenario}' has no worldfile in ${entry.source}`);
      }

      // The worldfile the *native* run booted from, through the port's own builder — the same
      // document the runner's ctor gate reads (PORT-NOTE(sim/runner-scenario-args)).
      const built = emitNormalizedWorldfile(
        (path: string) => {
          if (path === worldfilePath) return originalWf;
          if (path === SCHEMA) return originalWfs;
          throw new Error(`sim-fitness-mode: no source text for '${path}'`);
        },
        {
          worldfilePath,
          schemaPath: SCHEMA,
          parameters: new Map<string, string>(),
          validate: false,
          evaluator: monitorDocumentEvaluator,
        },
      );

      const doc = new Config(built.worldfileDocument);
      weights[scenario] = [
        doc.getFloat('HeuristicFitnessWeight'),
        doc.getFloat('ComplexityFitnessWeight'),
      ];
    }

    expect(weights).toEqual({
      microtest_voff: [0, 0],
      minitest_voff: [0, 0],
      microtest_von: [0, 0],
      minitest_von: [0, 0],
      hello: [0, 0],
      minitest_adami: [0, 0],
    });

    // ...so `simulation.ts`'s ctor gate (`Simulation.cc:292`) is false for every one of them, and
    // `initFitnessMode` — the only thing that would overwrite `EnergyBasedPopulationControl True`,
    // which all six worldfiles set — never runs. Measured end to end: the six-scenario milestone
    // is unchanged (225/225, 1369/1369, 225/225, 1308/1308, 19/19, 1373/1373, differing=0).
  });
});
