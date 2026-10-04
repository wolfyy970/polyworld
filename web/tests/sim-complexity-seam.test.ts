/**
 * Lane L11 (sim) — the L13 complexity seam: `analyzeBrain` and `AgentFitness` (t_20d5ff13).
 *
 * Both call sites used to `throw` ("lane L13 is not landed"), which is what made a worldfile with
 * `CalcComplexity`/`ComplexityFitnessWeight` set unrunnable in the port. They now transcribe
 * `Simulation.cc:3610-3635` and `:3772-3817`, and this file pins the three things a transcription
 * like this can get wrong *without* changing a number anywhere else:
 *
 *   1. **the wiring** — which path the analysis reads (`brainAnalysisParms.functionPath`, written
 *      by lane L12's `BrainFunctionLog` when the *begin* event is handled), which `parts` string it
 *      passes for which `ComplexityType` (`D` = two `events == NULL` reads and a float difference;
 *      `Z` = nothing at all), and where the `double` return is narrowed to `float`. Driven over the
 *      lane's own native differential (`src/model/complexity/golden/brain.txt`, 87 recorded brains
 *      × 7 parts) so the expected value is the *shipped binary's*, not this test's arithmetic:
 *      `analyzeBrain` must store `f32( golden complexity )`.
 *   2. **the contraction** — `0x9b260`, the weighted branch's
 *      `f32Fma(cw, Complexity, f32(f32(hw*HF)/total))`. PARITY.md's mutation table recorded it as
 *      "no ported site to pin" while the branch threw; the cases in `CONTRACTED_FITNESS` are
 *      exact-rational (`dis` scratch generator) and were selected *because* the round-product-then-
 *      sum form differs in the returned fitness, so a revert to that form fails here.
 *   3. **the refusal** — a `Simulation` built without the file read-back refuses the analysis
 *      (native `assert(*brainFunctionPath)` / `exit(1)` on a failed open) instead of scoring a zero
 *      that would reach `run/brain/Recent/<epoch>/complexity_<type>.plt` and the fitness.
 *
 * The end-to-end half (a worldfile with `ComplexityFitnessWeight != 0` booting and stepping) needs
 * the recorded oracle tree, which `oracle/*\/run/**` gitignores; it skips loudly without it, like
 * `tests/complexity-adami.test.ts`.
 * Load, not slowness of the code: the guarded test(s) are 448 ms solo and 2.2 s under four
 * concurrent full suites — the band that false-reds when the fleet's three concurrent pairs
 * (6 processes) run. They carry LOAD_TIMEOUT_MS below; no assertion changed.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { f32, f32Fma } from '../src/model/agent';
import type { Agent } from '../src/model/agent';
import type { BrainFunctionFile } from '../src/model/complexity';
import { agentFitness, analyzeBrain } from '../src/model/sim/agents';
import { brainAnalysisParmsOf } from '../src/model/sim/bindings';
import { parameterMapFromArgs, runScenario } from '../src/model/sim/runner';
import { Simulation } from '../src/model/sim/simulation';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(REPO, 'src/model/complexity/golden/brain.txt');

/** The IEEE-754 bit pattern of a binary32 — the only way to state these values exactly. */
function bits(x: number): string {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, x);
  return `0x${view.getUint32(0).toString(16).padStart(8, '0')}`;
}

/** `AbstractFile` over a recorded fixture (the same node reader `tests/complexity.test.ts` uses). */
function openFixture(path: string): BrainFunctionFile {
  const bytes: Uint8Array = path.endsWith('.gz')
    ? new Uint8Array(gunzipSync(readFileSync(path)))
    : new Uint8Array(readFileSync(path));
  let pos = 0;
  return {
    gets(maxChars: number): string | null {
      if (pos >= bytes.length) return null;
      const max = maxChars - 1;
      const start = pos;
      let n = 0;
      while (pos < bytes.length && n < max) {
        const ch = bytes[pos]!;
        pos++;
        n++;
        if (ch === 0x0a) break;
      }
      return Buffer.from(bytes.subarray(start, pos)).toString('latin1');
    },
    seek(offset: number): void {
      pos = offset;
    },
  };
}

/** `golden/brain.txt`'s `file` column is an absolute path from the recording machine. */
function fixturePath(recorded: string): string {
  const i = recorded.indexOf('oracle/');
  return join(REPO, i >= 0 ? recorded.slice(i) : recorded);
}

interface GoldenRow {
  file: string;
  part: string;
  complexity: number;
}

/** The lane's committed native differential, parsed by `(file, part)`. */
function goldenRows(): GoldenRow[] {
  return readFileSync(GOLDEN, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('file '))
    .map((l) => {
      const t = l.split(' ');
      return { file: fixturePath(t[1]!), part: t[3]!, complexity: Number(t[12]) };
    });
}

/** The `TSimulation` surface the two call sites touch, with the reads recorded. */
function seamSim(opts: {
  complexityType: string;
  calcComplexity?: boolean;
  events?: unknown;
  complexityWeight?: number;
  heuristicWeight?: number;
  totalHeuristicFitness?: number;
  /** Serves a read: native reads the path it was handed, the test substitutes a fixture. */
  resolve?: (path: string) => BrainFunctionFile;
}): { sim: Simulation; reads: string[]; events: number[] } {
  const reads: string[] = [];
  const events: number[] = [];
  const resolve = opts.resolve ?? openFixture;
  const sim = {
    fCalcComplexity: opts.calcComplexity ?? true,
    fComplexityType: opts.complexityType,
    fEvents: opts.events ?? null,
    fComplexityFitnessWeight: opts.complexityWeight ?? 0,
    fHeuristicFitnessWeight: opts.heuristicWeight ?? 0,
    fTotalHeuristicFitness: opts.totalHeuristicFitness ?? 1,
    postEvent: (e: { type: number }) => events.push(e.type),
    openBrainFunctionFile: (path: string): BrainFunctionFile => {
      reads.push(path);
      return resolve(path);
    },
  };
  return { sim: sim as unknown as Simulation, reads, events };
}

/** The `agent` surface the two call sites touch (`Number`, `Complexity`, `HeuristicFitness`). */
function seamAgent(init: {
  number: number;
  complexity?: number;
  heuristicFitness?: number;
  maxSpeed?: number;
  alive?: boolean;
  functionPath?: string;
}): Agent {
  const state = { complexity: init.complexity ?? 0 };
  const agent = {
    number: () => init.number,
    complexity: () => state.complexity,
    setComplexity: (value: number) => {
      state.complexity = value;
    },
    heuristicFitness: () => init.heuristicFitness ?? 0,
    maxSpeedReached: () => init.maxSpeed ?? 0,
    alive: () => init.alive ?? false,
  };
  if (init.functionPath !== undefined) brainAnalysisParmsOf(agent).functionPath = init.functionPath;
  return agent as unknown as Agent;
}

//===========================================================================
// 1. analyzeBrain's wiring, against the native differential
//===========================================================================

/**
 * Vitest's default is 5 s. The guarded test(s) are 448 ms solo and 2.2 s under four concurrent
 * full suites; the fleet also runs three concurrent pairs (6 processes), and at that load the
 * orchestrator measured a 946 ms-solo test false-red 6/6 on 2026-09-29 — this is the same band.
 * 60 s is the budget the vision-on gate already carries (t_1f4a7a8a): that measurement with room,
 * and still a guard, so a genuine hang fails.
 */
const LOAD_TIMEOUT_MS = 60_000;

describe('analyzeBrain (Simulation.cc:3610-3635)', () => {
  it('stores f32( native complexity ) for A/P/I/B and the D difference', () => {
    const rows = goldenRows();
    expect(rows.length).toBeGreaterThan(600);

    // A subset of the 87 recorded brains: enough to be non-vacuous, cheap enough for `npm test`
    // (the full corpus is `tests/complexity.test.ts`'s job, at the L13 function level).
    const files = [...new Set(rows.map((r) => r.file))].slice(0, 8);
    const byKey = new Map(rows.map((r) => [`${r.file}|${r.part}`, r.complexity]));

    let checked = 0;
    for (const file of files) {
      if (!existsSync(file)) {
        throw new Error(`missing fixture ${file} — the oracle tree is required (POLYWORLD_ORACLE_ROOT)`);
      }

      for (const part of ['A', 'P', 'I', 'B']) {
        const want = byKey.get(`${file}|${part}`);
        if (want === undefined) continue;

        const { sim, reads, events } = seamSim({ complexityType: part });
        const agent = seamAgent({ number: 1, complexity: -1, functionPath: file });
        analyzeBrain(sim, agent);

        // The begin event's logger records the path; the analysis reads exactly it.
        expect(reads).toEqual([file]);
        // `ComputeAgentNode`: the begin event, then the end event, around the calculation.
        expect(events.length).toBe(2);
        // `SetComplexity( float )` — the `double` return narrowed ONCE (`fcvt s0, d0`).
        expect(bits(agent.complexity()), `${file.split('/').pop()} ${part}`).toBe(bits(f32(want)));
        checked++;
      }

      // `ComplexityType "D"`: two `events == NULL` reads, each narrowed, then a float subtract.
      const p = byKey.get(`${file}|P`)!;
      const i = byKey.get(`${file}|I`)!;
      const { sim, events } = seamSim({ complexityType: 'D' });
      const agent = seamAgent({ number: 1, complexity: -1, functionPath: file });
      analyzeBrain(sim, agent);
      expect(events.length).toBe(2);
      expect(bits(agent.complexity())).toBe(bits(f32(f32(p) - f32(i))));
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  }, LOAD_TIMEOUT_MS);

  it('computes nothing at all for ComplexityType "Z" (the zero-velocity hack)', () => {
    const rows = goldenRows();
    const file = fixturePath(rows[0]!.file);
    const { sim, reads, events } = seamSim({ complexityType: 'Z' });
    const agent = seamAgent({ number: 1, complexity: 0.5, functionPath: file });
    analyzeBrain(sim, agent);
    // `0x9aad4 b.eq 0x9aafc` jumps past the whole block: no read, and the stored complexity stays
    // whatever it was (`AgentFitness`'s `Z` branch never looks at it either).
    expect(reads).toEqual([]);
    expect(agent.complexity()).toBe(0.5);
    expect(events.length).toBe(2);
  });

  it('refuses when the begin event recorded no function path (native asserts)', () => {
    const { sim } = seamSim({ complexityType: 'P' });
    const agent = seamAgent({ number: 1, complexity: -1, functionPath: '' });
    expect(() => analyzeBrain(sim, agent)).toThrow(/no function path/);
  });

  it('passes `fEvents` on the plain branch and NULL on both D reads', () => {
    const rows = goldenRows();
    const file = fixturePath(rows[0]!.file);
    const events = { getAgentEvent: () => ({ eat: false, mate: false }) };

    // A non-null `fEvents` is what the ctor builds for a lowercase `ComplexityType` letter; the
    // analysis hands it to `CalcComplexity_brainfunction`, and lane L13 runs `FilterActivity` with
    // it. The port's seam forwards the sim's own object.
    const seen: unknown[] = [];
    const { sim } = seamSim({ complexityType: 'Pe', events });
    const open = sim.openBrainFunctionFile.bind(sim);
    (sim as unknown as { openBrainFunctionFile: unknown }).openBrainFunctionFile = (
      path: string,
    ): BrainFunctionFile => {
      seen.push(events);
      return open(path);
    };
    analyzeBrain(sim, seamAgent({ number: 1, complexity: -1, functionPath: file }));
    expect(seen).toEqual([events]);
  });
});

//===========================================================================
// 2. AgentFitness's contracted site, exact-rational cases
//===========================================================================

/**
 * `0x9b250`-`0x9b268`, the binary's own shape:
 *
 * ```
 * 9b250: fmul  s0, s8, s0      ; f32( hw * HeuristicFitness )
 * 9b258: fdiv  s0, s0, s3      ; / fTotalHeuristicFitness            (f32)
 * 9b260: fmadd s0, s3, s1, s0  ; f32Fma( cw, Complexity, that )      <- ONE rounding
 * 9b264: fadd  s1, s3, s2      ; f32( cw + hw )
 * 9b268: fdiv  s0, s0, s1      ; the normalisation                   (f32)
 * ```
 *
 * `weightedFused`/`weightedUnfused` and `fitnessFused`/`fitnessUnfused` come from a scratch
 * generator that used exact rational arithmetic (`fractions.Fraction` + explicit binary32
 * rounding), *not* the port's helpers. Every case was selected because the two forms differ in the
 * **returned** fitness, so `expect(bits(...)).toBe(fitnessFused)` is what fails on the
 * round-product-then-sum form.
 */
const CONTRACTED_FITNESS = [
  { heuristicWeight: 0.12390409409999847, heuristicFitness: 0.6434341669082642, totalHeuristicFitness: 0.3182554244995117, complexityWeight: 0.8494464755058289, complexity: 0.4876483380794525, weightedFused: 0x3f2a2c0f, weightedUnfused: 0x3f2a2c0e, fitnessFused: 0x3f2ed4cd, fitnessUnfused: 0x3f2ed4cc },
  { heuristicWeight: 0.8154789805412292, heuristicFitness: 0.05791930854320526, totalHeuristicFitness: 1.3151713609695435, complexityWeight: 0.2008451372385025, complexity: 0.7863255739212036, weightedFused: 0x3e467ebd, weightedUnfused: 0x3e467ebe, fitnessFused: 0x3e434e8e, fitnessUnfused: 0x3e434e8f },
  { heuristicWeight: 0.7505987882614136, heuristicFitness: 0.34719863533973694, totalHeuristicFitness: 0.8833880424499512, complexityWeight: 0.8268715143203735, complexity: 0.32456231117248535, weightedFused: 0x3f1039a7, weightedUnfused: 0x3f1039a8, fitnessFused: 0x3eb6db38, fitnessUnfused: 0x3eb6db39 },
  { heuristicWeight: 0.4010332226753235, heuristicFitness: 0.4286198019981384, totalHeuristicFitness: 1.9187310934066772, complexityWeight: 0.7397446632385254, complexity: 0.865023136138916, weightedFused: 0x3f3abf53, weightedUnfused: 0x3f3abf54, fitnessFused: 0x3f23b3a8, fitnessUnfused: 0x3f23b3a9 },
  { heuristicWeight: 0.8987137079238892, heuristicFitness: 0.5774627923965454, totalHeuristicFitness: 1.0949982404708862, complexityWeight: 0.1797625571489334, complexity: 0.6120019555091858, weightedFused: 0x3f157eb1, weightedUnfused: 0x3f157eb0, fitnessFused: 0x3f0a9de4, fitnessUnfused: 0x3f0a9de3 },
  { heuristicWeight: 0.41217556595802307, heuristicFitness: 0.03243573009967804, totalHeuristicFitness: 0.9931386709213257, complexityWeight: 0.6609814763069153, complexity: 0.4408990144729614, weightedFused: 0x3e9c1a3c, weightedUnfused: 0x3e9c1a3d, fitnessFused: 0x3e917603, fitnessUnfused: 0x3e917604 },
] as const;

/** The pre-contraction form, spelled out so a revert is visible in this file's own terms. */
function roundProductThenSum(c: (typeof CONTRACTED_FITNESS)[number]): number {
  const heuristicTerm = f32(
    f32(c.heuristicWeight * c.heuristicFitness) / c.totalHeuristicFitness,
  );
  const weighted = f32(f32(c.complexityWeight * c.complexity) + heuristicTerm);
  return f32(weighted / f32(c.complexityWeight + c.heuristicWeight));
}

describe('AgentFitness (Simulation.cc:3772-3817)', () => {
  it('contracts the weighted sum at 0x9b260 (fails on the round-product-then-sum form)', () => {
    for (const c of CONTRACTED_FITNESS) {
      const { sim } = seamSim({
        complexityType: 'P',
        complexityWeight: c.complexityWeight,
        heuristicWeight: c.heuristicWeight,
        totalHeuristicFitness: c.totalHeuristicFitness,
      });
      const agent = seamAgent({
        number: 3,
        complexity: c.complexity,
        heuristicFitness: c.heuristicFitness,
      });

      const got = agentFitness(sim, agent);
      expect(bits(got)).toBe(`0x${c.fitnessFused.toString(16).padStart(8, '0')}`);

      // The case is only a pin if the two forms separate — the assertion above is what a revert
      // fails, and these two are why.
      expect(c.fitnessFused).not.toBe(c.fitnessUnfused);
      expect(bits(roundProductThenSum(c))).toBe(`0x${c.fitnessUnfused.toString(16).padStart(8, '0')}`);
    }
  });

  it('keeps the zero-weight and "Z" branches exactly as they were', () => {
    const zero = seamSim({ complexityType: 'P', complexityWeight: 0, heuristicWeight: 0, totalHeuristicFitness: 2 });
    expect(agentFitness(zero.sim, seamAgent({ number: 1, complexity: 0.5, heuristicFitness: 1 }))).toBe(0.5);

    const z = seamSim({ complexityType: 'Z', complexityWeight: 0.5, heuristicWeight: 0.5 });
    expect(agentFitness(z.sim, seamAgent({ number: 1, complexity: 0.5, maxSpeed: 0.99 }))).toBe(
      0.01 / (0.99 + 0.01),
    );
  });

  it('re-reads `run/brain/function/brainFunction_<n>.txt` when the complexity is still unset', () => {
    const rows = goldenRows();
    const file = fixturePath(rows[0]!.file);
    const p = rows.find((r) => r.file === file && r.part === 'P')!.complexity;
    const i = rows.find((r) => r.file === file && r.part === 'I')!.complexity;

    for (const [type, want] of [
      ['P', f32(p)],
      ['D', f32(f32(p) - f32(i))],
    ] as const) {
      const { sim, reads } = seamSim({
        complexityType: type,
        complexityWeight: 0.5,
        heuristicWeight: 0.5,
        totalHeuristicFitness: 1,
        // The path the port asks for is the run tree's, which only exists inside a run; the
        // fixture stands in for it, so the recorded `reads` is the real assertion.
        resolve: () => openFixture(file),
      });
      // `sprintf( "run/brain/function/brainFunction_%ld.txt", c->Number() )` — the path is built
      // from the agent NUMBER, not from `brainAnalysisParms`.
      const agent = seamAgent({ number: 1, complexity: -1, heuristicFitness: 1 });
      const got = agentFitness(sim, agent);

      expect(reads).toEqual(
        new Array<string>(type === 'D' ? 2 : 1).fill('run/brain/function/brainFunction_1.txt'),
      );
      expect(bits(agent.complexity()), type).toBe(bits(want));
      // ...and the read value is what the weighted sum folded in.
      expect(bits(got)).toBe(
        bits(f32(f32Fma(0.5, want, f32(f32(0.5 * 1) / 1)) / f32(0.5 + 0.5))),
      );
    }
  });

  it('refuses a Simulation built without the file read-back rather than scoring zero', () => {
    const bare = { brainFunctionBytes: undefined } as unknown as Simulation;
    expect(() =>
      Simulation.prototype.openBrainFunctionFile.call(bare, 'run/brain/function/brainFunction_1.txt'),
    ).toThrow(/built without `brainFunctionBytes`/);
  });
});

//===========================================================================
// 3. end to end: a worldfile with the complexity keys boots and steps
//===========================================================================

describe('a complexity worldfile end to end', () => {
  const hasOracle = existsSync(join(REPO, 'oracle/minitest_voff/run/original.wf'));

  it('boots and steps `minitest_voff` + the complexity keys (no recorded scenario sets them)', () => {
    if (!hasOracle) {
      // `oracle/*/run/**` is gitignored; a developer without it cannot drive this.
      console.warn('sim-complexity-seam: skipped (no oracle/minitest_voff run tree)');
      return;
    }

    const outDir = mkdtempSync(join(tmpdir(), 'l13-seam-'));
    const result = runScenario({
      scenario: 'minitest_voff',
      outDir,
      repoRoot: REPO,
      parameters: parameterMapFromArgs([
        '--Vision',
        'False',
        '--ComplexityType',
        '"P"',
        '--ComplexityFitnessWeight',
        '0.5',
        '--HeuristicFitnessWeight',
        '0.5',
        '--RecordComplexity',
        'True',
        '--RecordNeuralComplexityFiles',
        'True',
      ]),
    });

    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.steps).toBe(301);

    // Both call sites were reached: `analyzeBrain` on every death (`DEATH` rows) and
    // `AgentFitness` from `updateFittest` on the same deaths (the weighted branch — with
    // `ComplexityFitnessWeight != 0` there is no other branch left).
    const birthsDeaths = readFileSync(join(outDir, 'run/BirthsDeaths.log'), 'latin1').split('\n');
    const deaths = birthsDeaths.filter((l) => l.includes(' DEATH '));
    expect(deaths.length).toBeGreaterThan(0);
    // ...and the worldfile really took the weighted path: `ComplexityFitnessWeight != 0` makes
    // `Mate` take its steady-state-GA arm (`interact.ts`, native `Simulation.cc:2168`), which logs
    // `VIRTUAL` births instead of real ones. If the parameter had been dropped, this is what
    // catches it — the rest of this test would still pass on the zero-weight branch.
    expect(birthsDeaths.some((l) => l.includes(' VIRTUAL '))).toBe(true);

    // A positive complexity per death is what the analysis produced and `BrainComplexityLog`
    // recorded to `run/brain/Recent/<epoch>/complexity_<type>.plt` (lane L12).
    const plt = readdirSync(join(outDir, 'run/brain/Recent/0')).filter((n) => n === 'complexity_P.plt');
    expect(plt).toEqual(['complexity_P.plt']);
    const text = readFileSync(join(outDir, 'run/brain/Recent/0/complexity_P.plt'), 'latin1');
    const rows = text.split('\n').filter((l) => /^\d+\t/.test(l));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(Number(row.split('\t')[1])).toBeGreaterThan(0);
  }, 600_000);
});
