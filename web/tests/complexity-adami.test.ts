/**
 * Lane L13 (complexity) — `complexity/adami.cc` (`computeAdamiComplexity`).
 *
 * Two layers, because `computeAdamiComplexity` has no reachable oracle of its own:
 *
 *   1. **The arithmetic, against an independent reference.** Native can only reach this
 *      function from a booted simulation (`GenomeUtil::schema` + a walk of
 *      `objectxsortedlist::gXSortedObjects`), so no probe can drive the shipped symbol the way
 *      `native/complexityprobe.cc` drives `CalcComplexity_brainfunction`. The lane therefore
 *      reproduces the arithmetic a second time, in Python, from the native source —
 *      `native/adami_reference.py`, a *different* libm (`math.log2`) and a different float32
 *      implementation (numpy) — over a fixed synthetic agent set, and commits its output. The
 *      test builds the same agent set through the port's own seam and compares byte for byte.
 *      The expected files are in `golden/adami/`; regenerate with
 *      `python3 src/model/complexity/native/adami_reference.py`.
 *
 *   2. **End to end, through the real simulation** — the lane's own recorded scenario
 *      `minitest_adami` (`tools/scenarios.d/minitest_adami.json`: `minitest_voff`'s worldfile and
 *      args plus `RecordAdamiComplexity True` / `AdamiComplexityRecordFrequency 1`), recorded
 *      from the native build by `./oracle/run_parity.sh minitest_adami --record`. That golden
 *      pins the whole path: the x-sorted walk, the gene bytes of a live population, all three
 *      window widths, the four sinks and L12's `fprintf` shapes.
 *
 * The end-to-end half needs a simulation that runs to `MaxSteps` with births in it, which needs
 * lanes L11 (step loop) and L5 (genome) — it *was* skipped, loudly, while that path raised; it now
 * runs to completion and passes, because L11's recorded scenarios (this one boots `minitest_voff`'s
 * worldfile) are byte-exact. A developer without the oracle (`oracle/*\/run/**` is gitignored) gets
 * the same skip. Set `POLYWORLD_ORACLE_ROOT` to point at the canonical oracle.
 *
 * **The gate the run itself imposes** (PORT-NOTE(l13/adami-is-a-function-of-the-run)). The record
 * is a function of the live population's gene bytes, so a whole-record byte comparison is only
 * *meaningful* while the replayed run is byte-exact. The gate was built while lane L11 was not there
 * yet: the model's first divergence *was* then a 1–2 ulp fight-damage amount at step 39, which
 * walked agent 47's energy off the golden from step 128 and moved its NATURAL death one step
 * (`BirthsDeaths.log` line 77: golden `197 DEATH 47`, port `198 DEATH 47`; PARITY.md -> *the former
 * `minitest_voff` divergence*). Every Adami row **before** that step was still forced — a divergence
 * there is this lane's, or the genome lane's, and fails the test — while the rows from it on were
 * compared only far enough to report the run's own gap as a skip. The gate is read off the run's own
 * population history (`run/BirthsDeaths.log`, `run/population.txt`), so it disappears by itself when
 * L11 lands: **it has.** Run 7 made `minitest_voff` byte-exact, so `firstHistoryDivergence()` returns
 * `null`, every one of the 301 rows per record is asserted, and this file is **3 passed (3), 0
 * skipped** (re-measured 2026-09-29, tree `b2bbcaf`). Nothing here had to be remembered or flipped.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { cFormatTextSink } from '../src/model/logs/formatSink';
import type { TextSink } from '../src/model/logs/seams';
import {
  createComputeAdamiComplexity,
  type AdamiAgent,
  type AdamiSink,
  type AdamiWorld,
} from '../src/model/complexity/adami';
import { parameterMapFromArgs, runScenario } from '../src/model/sim/runner';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANE = join(REPO, 'src/model/complexity');
const ORACLE_ROOT = process.env.POLYWORLD_ORACLE_ROOT ?? join(REPO, 'oracle');
const E2E_GOLDEN = join(ORACLE_ROOT, 'minitest_adami');
const E2E_FILES = [
  'run/genome/AdamiComplexity-1bit.txt',
  'run/genome/AdamiComplexity-2bit.txt',
  'run/genome/AdamiComplexity-4bit.txt',
  'run/genome/AdamiComplexity-summary.txt',
];

//===========================================================================
// the synthetic input — kept identical to `native/adami_reference.py`
//===========================================================================

/**
 * `AGENTS_BY_GENE[gene][agent]` — the raw byte `Genes()->get_raw_uint( gene )` returns. 8 mutable
 * genes, 5 agents, chosen so the three window widths produce several distinct information values
 * (constant / 1-in-5 / 2-in-5 symbol frequencies) instead of the all-`1.0000` a freshly seeded
 * population gives.
 */
const AGENTS_BY_GENE = [
  [0x00, 0x7f, 0x80, 0xff, 0x0f],
  [0x7f, 0x00, 0x02, 0x40, 0xa5],
  [0x80, 0x3c, 0x04, 0x20, 0x5a],
  [0xff, 0xc3, 0x08, 0x10, 0x33],
  [0x0f, 0xf0, 0x10, 0x08, 0xaa],
  [0xa5, 0x5a, 0x20, 0x04, 0x55],
  [0x5a, 0xa5, 0x40, 0x02, 0x0f],
  [0x33, 0x0f, 0x80, 0x01, 0xf0],
];
const TIMESTEP = 7;

/** A `TextSink` that keeps every byte written to it. */
class CaptureSink implements TextSink {
  text = '';
  printf(text: string): void {
    this.text += text;
  }
  flush(): void {}
  close(): void {}
}

/**
 * `objectxsortedlist::gXSortedObjects` over the synthetic agents: `reset()` then `nextObj(
 * AGENTTYPE, &c )`. The port's walk asks for `GObjectType.AGENT`; this world holds nothing else,
 * so it hands out the agents in the same order native's x-sorted list would (the gene walk order
 * is model behaviour, and here it is the array order).
 */
function syntheticWorld(): AdamiWorld {
  let index = 0;
  const agents: AdamiAgent[] = AGENTS_BY_GENE[0]!.map((_, agent) => ({
    genes: () => ({ getRawUint: (gene: number) => AGENTS_BY_GENE[gene]![agent]! }),
  }));
  return {
    reset: () => {
      index = 0;
    },
    next: (_type: number, out: { value: unknown }) => {
      if (index >= agents.length) return false;
      out.value = agents[index++];
      return true;
    },
  };
}

/** The four sinks, wrapped like L12's loggers wrap them (`cFormatTextSink`). */
function captureSinks() {
  const oneBit = new CaptureSink();
  const twoBit = new CaptureSink();
  const fourBit = new CaptureSink();
  const summary = new CaptureSink();
  return {
    oneBit,
    twoBit,
    fourBit,
    summary,
    sinks: [
      cFormatTextSink(oneBit) as AdamiSink,
      cFormatTextSink(twoBit) as AdamiSink,
      cFormatTextSink(fourBit) as AdamiSink,
      cFormatTextSink(summary) as AdamiSink,
    ] as const,
  };
}

function golden(name: string): string {
  return readFileSync(join(LANE, 'golden/adami', name), 'latin1');
}

//===========================================================================
// the replayed run's own exactness — what the Adami record is a function of
//===========================================================================

/**
 * The artifacts that carry the replayed run's **population history**: which agent existed at which
 * step, and which pair begat it. `run/BirthsDeaths.log` is the genome-changing event stream
 * (`N DEATH a` / `N BIRTH c p1 p2`), `run/population.txt` the per-step count; together they are
 * what decides which gene bytes the Adami walk reads each step.
 *
 * The gene bytes themselves are *not* a gate: a child whose bytes differ from the golden's is
 * exactly the divergence this differential should report, so it has to fail rather than skip.
 */
const RUN_HISTORY = ['run/BirthsDeaths.log', 'run/population.txt'] as const;

/**
 * The first step at which the replayed run's own population history leaves the golden, or `null`
 * when it is byte-exact. Every row line in these files starts with its timestep; the header blocks
 * do not, which is what skips them.
 */
function firstHistoryDivergence(outDir: string): {
  rel: string;
  line: number;
  step: number;
  port: string;
  native: string;
} | null {
  let worst: ReturnType<typeof firstHistoryDivergence> = null;
  for (const rel of RUN_HISTORY) {
    const mine = readFileSync(join(outDir, rel), 'latin1').split('\n');
    const native = readFileSync(join(E2E_GOLDEN, rel), 'latin1').split('\n');
    for (let i = 0; i < Math.max(mine.length, native.length); i++) {
      if (mine[i] === native[i]) continue;
      const step = Number(/^\s*(\d+)/.exec(native[i] ?? '')?.[1] ?? NaN);
      if (Number.isFinite(step) && (worst === null || step < worst.step)) {
        worst = { rel, line: i + 1, step, port: mine[i] ?? '(missing)', native: native[i] ?? '' };
      }
      break; // the first difference per file is the one that moves the population
    }
  }
  return worst;
}

//===========================================================================
// 1. the arithmetic, against the Python reference
//===========================================================================

describe('Adami complexity (complexity/adami.cc)', () => {
  it('reproduces the independent reference, byte for byte', () => {
    const { oneBit, twoBit, fourBit, summary, sinks } = captureSinks();
    const compute = createComputeAdamiComplexity({
      world: syntheticWorld(),
      schema: { getMutableSize: () => AGENTS_BY_GENE.length },
    });

    compute(TIMESTEP, ...sinks);

    expect(oneBit.text).toBe(golden('1bit.txt'));
    expect(twoBit.text).toBe(golden('2bit.txt'));
    expect(fourBit.text).toBe(golden('4bit.txt'));
    expect(summary.text).toBe(golden('summary.txt'));
  });

  it('writes native\'s four headers once, on the first record only', () => {
    const first = captureSinks();
    const second = captureSinks();
    const compute = createComputeAdamiComplexity({
      world: syntheticWorld(),
      schema: { getMutableSize: () => AGENTS_BY_GENE.length },
    });

    compute(TIMESTEP, ...first.sinks);
    compute(TIMESTEP + 1, ...second.sinks);

    // native guards the headers with `if( ftell( FileOneBit ) == 0 )`.
    expect(first.oneBit.text).toContain('% BitsInGenome: 64 WindowSize: 1\n');
    expect(second.oneBit.text).not.toContain('BitsInGenome');
    expect(second.summary.text).not.toContain('Timestep 1bit');
    // `adami.cc:36-38` take a value, so the sink renders the doubled `%` to one;
    // `adami.cc:39` has none, so its `%` is literal (PORT-NOTE(l13/adami-header-format)).
    expect(second.oneBit.text.startsWith('8:')).toBe(true);
    expect(second.summary.text.endsWith('\n')).toBe(true);
    expect(second.summary.text.trim().split(' ').length).toBe(4);
  });
});

//===========================================================================
// 2. end to end, against the recorded native run
//===========================================================================

describe('Adami complexity, native differential (recorded run)', () => {
  it('reproduces `minitest_adami` byte for byte', (ctx) => {
    if (!existsSync(join(E2E_GOLDEN, E2E_FILES[0]!))) {
      ctx.skip(`no recorded Adami golden at ${E2E_GOLDEN}`);
      return;
    }

    const outDir = mkdtempSync(join(tmpdir(), 'adami-'));
    const result = runScenario({
      scenario: 'minitest_voff',
      outDir,
      repoRoot: REPO,
      // The registered scenario's own args, added to `minitest_voff`'s `--Vision False`
      // (the port's runner resolves scenario args from the base registry, so an overlay-only
      // name like `minitest_adami` is booted under its base-twin's name plus these two).
      parameters: parameterMapFromArgs([
        '--RecordAdamiComplexity',
        'True',
        '--AdamiComplexityRecordFrequency',
        '1',
      ]),
    });

    if (!result.ok) {
      // Not this lane: the step loop or the genome binding raised before `MaxSteps`. The Adami
      // goldens are only meaningful over a completed run, so the comparison cannot run —
      // reported as a skip with the reason, not as a pass, and the plain unit above still pins
      // the lane's arithmetic.
      ctx.skip(
        `the port cannot complete minitest_voff yet (${result.steps} steps): ${result.error?.split('\n')[0]}`,
      );
      return;
    }

    // What the run forces, and what it does not (see the file header's *gate the run itself
    // imposes*): rows at or after the run's own first population divergence are not this lane's.
    const historyDivergence = firstHistoryDivergence(outDir);
    let unforcedRows = 0;

    for (const rel of E2E_FILES) {
      const mine = readFileSync(join(outDir, rel), 'latin1').split('\n');
      const native = readFileSync(join(E2E_GOLDEN, rel), 'latin1').split('\n');
      expect(mine.length, `${rel} line count`).toBe(native.length);
      const bad: string[] = [];
      for (let i = 0; i < native.length; i++) {
        if (mine[i] === native[i]) continue;
        // Every record row carries its own timestep (`%ld:` in the three window files, `%ld ` in
        // the summary); the header line does not.
        const step = Number(/^\s*(\d+)/.exec(native[i] ?? '')?.[1] ?? NaN);
        if (historyDivergence !== null && Number.isFinite(step) && step >= historyDivergence.step) {
          unforcedRows++;
          continue;
        }
        if (bad.length < 3) bad.push(`line ${i + 1}:\n  port   ${mine[i]}\n  native ${native[i]}`);
      }
      expect(bad, `${rel}: first divergences`).toEqual([]);
    }

    if (historyDivergence !== null) {
      // Not this lane, and measured rather than guessed: the population history the record reads
      // is lane L11's residual. The rows before it were compared above (and would have failed);
      // the rows from it on are reported here instead of silently passed.
      ctx.skip(
        `the replayed run's own population history is not byte-exact yet, so the Adami rows from ` +
          `step ${historyDivergence.step} on are not forced by it (` +
          `${unforcedRows} differing row(s) left uncompared; all ${E2E_FILES.length} records were ` +
          `compared before that step): ${historyDivergence.rel} line ${historyDivergence.line}: ` +
          `port \`${historyDivergence.port.trim()}\` vs native ` +
          `\`${historyDivergence.native.trim()}\` — lane L11's residual, PARITY.md -> *the former ` +
          `\`minitest_voff\` divergence*.`,
      );
    }
  }, 1800000);
});
