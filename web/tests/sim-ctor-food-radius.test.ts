/**
 * Lane L11 — the ctor's step-13 **food** radius in native's widths (`Simulation.cc:324-326`).
 *
 *     float maxfoodlen    = 0.75 * food::gMaxFoodEnergy / food::gSize2Energy;
 *     float maxfoodradius = 0.5 * sqrt(maxfoodlen * maxfoodlen * 2.0);
 *     food::gMaxFoodRadius = maxfoodradius;
 *
 * The line is three width decisions wide, and the port originally took none of them: it kept
 * `maxfoodlen` in binary64, squared it in binary64 and stored a binary64 `gMaxFoodRadius`. The
 * corpus below is the oracle's own answer, measured (not printed to decimals — `%g` at
 * `Simulation.cc:1469` shows six significant digits and would have hidden it) by
 * `src/model/sim/native/foodradiusprobe.cc`, which boots a real `TSimulation` the way
 * `Polyworld --ui term` does and prints every field as a bit pattern:
 *
 *   sh src/model/sim/native/run_foodradiusprobe.sh worldfiles/tests/low-spec-pc/microtest.wf
 *   # row 1 — the recorded tier-A worldfiles (`MaxFoodEnergy 1000`, `FoodEnergySizeScale 400`):
 *   #   food::gMaxFoodRadius  0x1.536948p+0  (0x3fa9b4a4)  1.3258252143859863
 *   #   0.5*sqrt(…) as a double  0x1.536948017481p+0  (0x3ff5369480174810)  1.3258252147247767
 *   # row 2 — a probe worldfile overriding the two properties to inexact values (the probe's work
 *   #   dir carries `inexact.wf`: microtest.wf + `MaxFoodEnergy 1000.5` +
 *   #   `FoodEnergySizeScale 300.3`); `foodradiusprobe inexact.wf`:
 *   #   food::gMaxFoodRadius  0x1.c45284p+0  (0x3fe22942)  1.7668840885162354
 *   #   0.5*sqrt(…) as a double  0x1.c45283cbb24f3p+0  (0x3ffc45282ec400da)  1.7668840243132338
 *
 * What the two rows separate:
 *
 *  * row 1 is the case where the three width decisions do **not** separate in the final `float`
 *    (`maxfoodlen` and its square are exact there, and the double root rounds up to the same
 *    binary32) — the port was still wrong, but only in the *stored* value: native's
 *    `gMaxFoodRadius` is the binary32 `1.3258252143859863`, the port's was the binary64
 *    `1.3258252147247767`, and `agent.cc:1971` **divides by it** on every carried-food energy
 *    conversion (`Simulation.cc:2613`/`:2623` compare against `2.0*gMaxFoodRadius` in the contact
 *    walk too).
 *  * row 2 is the case where the missing `f32` on the *final store* moves the binary32 itself:
 *    the pre-fix spelling narrows to `0x3fe22941`, **one ulp below** the oracle's `0x3fe22942`.
 *  * the intermediate square is narrowed to binary32 before the `* 2.0` (native's `float * float`).
 *    On both rows the double `sqrt` absorbs that rounding into the same binary32, so it is pinned
 *    as a *width* fact (the un-rounded double square is in the table) rather than as a separate
 *    observable — reported as measured, not as load-bearing.
 *
 * The last test boots the scenario through the real runner and reads the global the ctor writes,
 * so a revert of `simulation.ts`'s step 13 cannot hide behind this file's own transcription.
 *
 * Harness: with the fix in place, `microtest_voff` → PASS 225/225, `minitest_voff` → PASS
 * 1369/1369, `hello` → PASS 19/19, `minitest_adami` → PASS 1373/1373 and `microtest_von` → PASS
 * 225/225 (all `differing=0 missing=0 extra=0`); no golden moved, i.e. the recorded scenarios do
 * not exercise the last-bit difference — the divergence is a real one for the model's arithmetic,
 * not one the frozen artifacts can see.
 * Load, not slowness of the code: the guarded test(s) are 710 ms solo and 3.1 s under four
 * concurrent full suites — the band that false-reds when the fleet's three concurrent pairs
 * (6 processes) run. They carry LOAD_TIMEOUT_MS below; no assertion changed.
 */

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { Food } from '../src/model/environment';
import { f32, f32Bits } from '../src/model/geometry';
import { runScenario } from '../src/model/sim/runner';

const hex = (bits: number): string => `0x${(bits >>> 0).toString(16).padStart(8, '0')}`;

function f64Bits(x: number): string {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, x);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface OracleRow {
  readonly label: string;
  /** `food::gMaxFoodEnergy` as the worldfile resolves it, float32 bits. */
  readonly gMaxFoodEnergy: number;
  /** `food::gSize2Energy` as the worldfile resolves it, float32 bits. */
  readonly gSize2Energy: number;
  /** `maxfoodlen` after its single narrowing to `float`, float32 bits. */
  readonly maxfoodlen: number;
  /** `maxfoodlen * maxfoodlen` as a binary64 (the value *before* native's `float` square rounds). */
  readonly unroundedSquare: string;
  /** The `float` square native then multiplies by `2.0`, float32 bits. */
  readonly square: number;
  /** `food::gMaxFoodRadius` as the real ctor stored it, float32 bits. */
  readonly radius: number;
  /** The pre-fix spelling's stored value (`0.5 * sqrt(len * len * 2.0)` all in binary64). */
  readonly legacyRadius: string;
  /** …and what that legacy double narrows to, so the 1-ulp case is explicit. */
  readonly legacyRadiusAsF32: number;
}

const ORACLE_ROWS: readonly OracleRow[] = [
  {
    label: 'recorded worldfiles: MaxFoodEnergy 1000, FoodEnergySizeScale 400',
    gMaxFoodEnergy: 0x447a0000,
    gSize2Energy: 0x43c80000,
    maxfoodlen: 0x3ff00000,
    unroundedSquare: '400c200000000000',
    square: 0x40610000,
    radius: 0x3fa9b4a4,
    legacyRadius: '3ff5369480174810',
    legacyRadiusAsF32: 0x3fa9b4a4,
  },
  {
    label: 'probe worldfile inexact.wf: MaxFoodEnergy 1000.5, FoodEnergySizeScale 300.3',
    gMaxFoodEnergy: 0x447a2000,
    gSize2Energy: 0x43962666,
    maxfoodlen: 0x401feb8b,
    unroundedSquare: '4018f99bd89f5e40',
    square: 0x40c7ccdf,
    radius: 0x3fe22942,
    legacyRadius: '3ffc45282ec400da',
    legacyRadiusAsF32: 0x3fe22941,
  },
];

/** The width chain under test, token for token the ctor's food half. */
function foodRadius(gMaxFoodEnergy: number, gSize2Energy: number): {
  maxfoodlen: number;
  unroundedSquare: number;
  square: number;
  radius: number;
} {
  const maxfoodlen = f32((0.75 * gMaxFoodEnergy) / gSize2Energy);
  const unroundedSquare = maxfoodlen * maxfoodlen;
  const square = f32(unroundedSquare);
  return { maxfoodlen, unroundedSquare, square, radius: f32(0.5 * Math.sqrt(square * 2.0)) };
}

/** The spelling the port used before this card: binary64 all the way through. */
function legacyRadius(gMaxFoodEnergy: number, gSize2Energy: number): number {
  const len = (0.75 * gMaxFoodEnergy) / gSize2Energy;
  return 0.5 * Math.sqrt(len * len * 2.0);
}

const unhex = (bits: number): number => {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = bits >>> 0;
  return new Float32Array(buf)[0] as number;
};

/**
 * Vitest's default is 5 s. The guarded test(s) are 710 ms solo and 3.1 s under four concurrent
 * full suites; the fleet also runs three concurrent pairs (6 processes), and at that load the
 * orchestrator measured a 946 ms-solo test false-red 6/6 on 2026-09-29 — this is the same band.
 * 60 s is the budget the vision-on gate already carries (t_1f4a7a8a): that measurement with room,
 * and still a guard, so a genuine hang fails.
 */
const LOAD_TIMEOUT_MS = 60_000;

describe('L11 ctor step 13 — food::gMaxFoodRadius widths', () => {
  it('narrows maxfoodlen, the square and the store exactly as the oracle does', () => {
    for (const row of ORACLE_ROWS) {
      const ge = unhex(row.gMaxFoodEnergy);
      const s2e = unhex(row.gSize2Energy);
      const got = foodRadius(ge, s2e);

      expect(hex(f32Bits(got.maxfoodlen))).toBe(hex(row.maxfoodlen));
      expect(f64Bits(got.unroundedSquare)).toBe(row.unroundedSquare);
      expect(hex(f32Bits(got.square))).toBe(hex(row.square));
      expect(hex(f32Bits(got.radius))).toBe(hex(row.radius));
    }
  });

  it('the pre-fix binary64 spelling is not equivalent (and is not even a faithful store)', () => {
    for (const row of ORACLE_ROWS) {
      const ge = unhex(row.gMaxFoodEnergy);
      const s2e = unhex(row.gSize2Energy);
      const legacy = legacyRadius(ge, s2e);

      expect(f64Bits(legacy)).toBe(row.legacyRadius);
      expect(legacy).not.toBe(unhex(row.radius)); // the *stored* value differs as a number
      expect(hex(f32Bits(legacy))).toBe(hex(row.legacyRadiusAsF32));
    }

    // Row 1: the two spellings share a binary32 but not a value — the port stored the double.
    const row1 = ORACLE_ROWS[0]!;
    expect(hex(f32Bits(legacyRadius(unhex(row1.gMaxFoodEnergy), unhex(row1.gSize2Energy))))).toBe(
      hex(row1.radius),
    );
    expect(f64Bits(legacyRadius(unhex(row1.gMaxFoodEnergy), unhex(row1.gSize2Energy)))).toBe(
      row1.legacyRadius,
    );

    // Row 2: the missing narrowing moves the binary32 itself — 1 ulp low.
    const row2 = ORACLE_ROWS[1]!;
    expect(row2.legacyRadiusAsF32).toBe(row2.radius - 1);
    expect(hex(f32Bits(legacyRadius(unhex(row2.gMaxFoodEnergy), unhex(row2.gSize2Energy))))).toBe(
      hex(row2.legacyRadiusAsF32),
    );
  });

  it('rounds the square to binary32 before the * 2.0 (the un-rounded square is a different double)', () => {
    // Row 1's square happens to be exact; row 2's is not, so the width is visible as a value even
    // though both rows' double `sqrt` lands on the same binary32 radius.
    const [row1, row2] = ORACLE_ROWS as [OracleRow, OracleRow];
    const sq1 = foodRadius(unhex(row1.gMaxFoodEnergy), unhex(row1.gSize2Energy));
    const sq2 = foodRadius(unhex(row2.gMaxFoodEnergy), unhex(row2.gSize2Energy));

    expect(f64Bits(sq1.unroundedSquare)).toBe(f64Bits(sq1.square)); // exact
    expect(f64Bits(sq2.unroundedSquare)).not.toBe(f64Bits(sq2.square)); // rounded
    expect(sq2.unroundedSquare).not.toBe(sq2.square);
    expect(hex(f32Bits(sq2.square))).toBe(hex(row2.square));
  });
});

// --- the production path ---------------------------------------------------------------------

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_ROOT = process.env['POLYWORLD_NATIVE'] ?? join(REPO_ROOT, '..', 'polyworld');
const havePrereqs =
  existsSync(join(NATIVE_ROOT, 'lib', 'libpolyworld.dylib')) &&
  existsSync(join(REPO_ROOT, 'oracle', 'microtest_voff', 'run', 'original.wf'));

describe.skipIf(!havePrereqs)('L11 ctor step 13 — the real ctor stores the oracle’s float', () => {
  it('reads food::gMaxFoodRadius off the booted simulation', () => {
    const outDir = mkdtempSync(join(tmpdir(), 't_1d2cd75d-foodradius-'));
    const result = runScenario({ scenario: 'microtest_voff', outDir, maxSteps: 1, repoRoot: REPO_ROOT });
    expect(result.ok).toBe(true);

    // f32 0x3fa9b4a4 — the float `Simulation.cc:326` stores (probe row 1).
    expect(hex(f32Bits(Food.gMaxFoodRadius))).toBe('0x3fa9b4a4');
    expect(Food.gMaxFoodRadius).toBe(1.3258252143859863);

    // non-vacuity: the pre-fix binary64 value is a different number in the very same slot, so a
    // revert fails here even though the two share a binary32.
    const legacy = legacyRadius(Food.gMaxFoodEnergy, Food.gSize2Energy);
    expect(legacy).not.toBe(Food.gMaxFoodRadius);
    expect(f64Bits(legacy)).toBe('3ff5369480174810');
  }, LOAD_TIMEOUT_MS);
});
