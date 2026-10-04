/**
 * The contraction sweep (t_981fcace) — pins for the sites it changed.
 *
 * Background: `PARITY.md` -> *the float-contraction rule*. The native model is built with
 * clang `-O2` (`-ffp-contract=on`), so a source `a*b + c` is **one** rounding wherever the
 * product and the destination are `float` — and, as the sweep measured, in `double` too
 * (`agent::FieldOfView`'s `0x261d0 fmadd d0, d0, d2, d1`, `agent::UpdateVision`'s
 * `0x26260/0x262f0/0x26338`, `Patch::initBase`'s `0x5dcdc fmla.2s`). This file pins the
 * sites the sweep fixed, each against a value derived from **exact rational arithmetic**
 * (Python `Fraction` + explicit binary32 rounding, `dis/gen_ts_cases.py` in the card's
 * workspace) rather than from the port's own helpers, plus a non-vacuity check: the form
 * the site used before the sweep must produce a *different* bit pattern on every pinned
 * case, so a revert fails here.
 *
 * The two classes of defect the sweep found, and which these cases separate:
 *
 *  1. a product rounded to binary32 before the add (`f32(f32(a*b) + c)`) where the binary
 *     keeps it exact and rounds once (`fmadd`) — measured at ~half of the model's `x`
 *     values (see `PARITY.md`);
 *  2. the *wrong operand* rounded (`food::setradius`: `0x5aa80 fmul s1, s1, s1` rounds
 *     `fLength[2]`'s square, so `fLength[0]`'s square must stay exact).
 * Load, not slowness of the code: the guarded test(s) are 719 ms solo and 3.2 s under four
 * concurrent full suites — the band that false-reds when the fleet's three concurrent pairs
 * (6 processes) run. They carry LOAD_TIMEOUT_MS below; no assertion changed.
 */
import { describe, expect, it } from 'vitest';

import { f32Fma } from '../src/model/agent/numeric';
import { linearPDF } from '../src/model/environment/distributions';
import { createAgentBodyGeometry } from '../src/model/geometry/body';
import { Camera } from '../src/model/geometry/camera';
import { PolyObj } from '../src/model/geometry/primitives';
import { Poly, f32, vec3 } from '../src/model/geometry';
import { Energy, Food, type FoodType } from '../src/model/environment';
import { globals, type RngSurface } from '../src/model/types';

// --- the sweep follow-up (t_2a625bd5)
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentConfig } from '../src/model/agent';
import { EnergySensor, RandomSensor } from '../src/model/agent/sensors';
import {
  Sheet,
  SheetsModel,
  Vector2f,
  Vector2i,
  Vector3f,
  offsetCenter,
  type Neuron,
} from '../src/model/brain/core/sheets/sheetsModel';
import { runScenario } from '../src/model/sim/runner';

// ---------------------------------------------------------------------------
// Constants: every `fused` value below is the correctly-rounded binary32 of the exact
// `a*b + c` (what the hardware `fmadd`/`fmla` at the quoted address produces); every
// `unfused` value is what the pre-sweep form produced. Generated, not hand-typed.
// ---------------------------------------------------------------------------

/** `__Z9linearPDFfff` `0xfbdc fmadd s1, s1, s0, s2`; slope `-0.4f`, yIntercept `0.4f`. */
const LINEAR_PDF_CASES = [
  { x: 0x3f20002a, fused: 0x3e199957, unfused: 0x3e199956 },
  { x: 0x3f200054, fused: 0x3e199913, unfused: 0x3e199914 },
  { x: 0x3f2000a8, fused: 0x3e19988d, unfused: 0x3e19988c },
];

/** `agent::FieldOfView` `0x261d0 fmadd d0, d0, d2, d1` (also `UpdateVision` `0x26260`). */
const FOV_CASES = [
  { focus: 0x3aa2db62, minFocus: 0xbf000000, maxFocus: 0x3f34fdf4, fused: 0xbeff3b6f, unfused: 0xbeff3b6e },
];

/** `agent::UpdateVision` `0x262f0 fmadd d0, d0, d1, d2` (yaw: `0x26338`). */
const PITCH_CASES = [
  { nerve: 0x3b070111, minPitch: 0xc3340000, maxPitch: 0x43340000, fused: 0xc3334227, unfused: 0xc3334226 },
  { nerve: 0x3b6410b6, minPitch: 0xc3340000, maxPitch: 0x43340000, fused: 0xc332bf49, unfused: 0xc332bf48 },
  { nerve: 0x3b6d6777, minPitch: 0xc3340000, maxPitch: 0x43340000, fused: 0xc332b227, unfused: 0xc332b226 },
];

/** `agent::UpdateBody` `0x26a04`-`0x26a94 fmadd s3, s1, s3, s0` — `x() - FF*CarryRadius()`. */
const BARRIER_BOUND_CASES = [
  { x: 0x410551ec, carryRadius: 0x3f000221, ff: 0x3f8147ae, fused: 0x40fa7a9d, unfused: 0x40fa7a9e },
  { x: 0x410551ec, carryRadius: 0x3f000443, ff: 0x3f8147ae, fused: 0x40fa7a59, unfused: 0x40fa7a58 },
  { x: 0x410551ec, carryRadius: 0x3f000afa, ff: 0x3f8147ae, fused: 0x40fa797f, unfused: 0x40fa7980 },
];

/** `food::setradius` `0x5aa80 fmul s1, s1, s1` + `0x5aa84 fmadd s0, s0, s0, s1`. */
const FOOD_RADIUS_SQ_CASES = [
  { l0: 0x3db851ec, l2: 0x3d4cd20b, fused: 0x3c2dadb9, unfused: 0x3c2dadb8 },
  { l0: 0x3db851ec, l2: 0x3d4cd749, fused: 0x3c2dafd2, unfused: 0x3c2dafd1 },
  { l0: 0x3db851ec, l2: 0x3d4cdc87, fused: 0x3c2db1eb, unfused: 0x3c2db1ea },
];

/**
 * A counterexample to "`Math.fround(a*b + c)` is equivalent to the hardware fma" with all
 * three operands binary32: the exact product lands *on* a binary32 midpoint, and the tiny
 * `c` (|c|/|a*b| ~ 4e-22) is below a binary64 ulp of the product, so the double rounding
 * hides it. `f32Fma` gets the hardware's answer. Found by a 2e8-triple sweep with a wide
 * exponent spread (`dis/drcheck.c`); over the model's own ranges the two forms agreed on
 * 6e8 triples (`dis/drcheck_model.c`), which is why the lanes that wrote `f32(a*b + c)`
 * are left alone — but it is *not* a theorem, hence the helper.
 */
const NEAR_MISS_COUNTEREXAMPLE = {
  a: 0x4b7d4800,
  b: 0xcb601000,
  c: 0xb3d87820,
  exactFma: 0xd75daed5,
  doubleRounded: 0xd75daed4,
};

/**
 * `agent::setradius` (`__ZN5agent9setradiusEv`) — `0x21f44 fmul s1, s1, s1` rounds
 * `fLength[2]^2` only, `0x21f48 fmadd s0, s0, s0, s1` keeps `fLength[0]^2` exact; the radius
 * is `f32(f32(f32(root * fRadiusScale) * fScale) * 0.5)` and `root` is the `float` `fsqrt`
 * (`0x21f4c`). The pre-sweep port rounded both squares.
 */
const AGENT_RADIUS_CASES = [
  { lx: 0x3e846cce, lz: 0x3e2e46b7, fusedSum: 0x3dc452e0, unfusedSum: 0x3dc452df, fusedRadius: 0x3e1e85ce, unfusedRadius: 0x3e1e85cd },
  { lx: 0x3f6e5d2e, lz: 0x3f74d974, fusedSum: 0x3fe41051, unfusedSum: 0x3fe41050, fusedRadius: 0x3f2adb6d, unfusedRadius: 0x3f2adb6c },
  { lx: 0x3ff1e575, lz: 0x3fef9a9d, fusedSum: 0x40e269f1, unfusedSum: 0x40e269f2, fusedRadius: 0x3faa3cec, unfusedRadius: 0x3faa3ced },
];

/**
 * `gpoly::setradius` (`0x8497c`/`0x84980`/`0x84988`) and `gpolyobj::setradius`
 * (`0x84ca0`/`0x84ca4`/`0x84cac`) — `fmul` on the second square, `fmadd` for the first and
 * third, so exactly one square is rounded. One case per decade of the model's range.
 */
const GPOLY_RADIUS_CASES = [
  { x: 0x3f2bedb6, y: 0x3f2d64bb, z: 0x3f1520a4, fusedSum: 0x3f9fe3df, unfusedSum: 0x3f9fe3de, fusedRadius: 0x3f0f0f28, unfusedRadius: 0x3f0f0f27 },
  { x: 0x400f80b9, y: 0x3fd2c98c, z: 0x3fd810ef, fusedSum: 0x41296c07, unfusedSum: 0x41296c06, fusedRadius: 0x3fd04270, unfusedRadius: 0x3fd0426f },
  { x: 0x42c07bf3, y: 0x4208a0d8, z: 0x428e499e, fusedSum: 0x46720abb, unfusedSum: 0x46720abc, fusedRadius: 0x4278ec53, unfusedRadius: 0x4278ec54 },
];

const dv = new DataView(new ArrayBuffer(4));
function fromBits(bits: number): number {
  dv.setUint32(0, bits >>> 0);
  return dv.getFloat32(0);
}
function bitsOf(value: number): number {
  dv.setFloat32(0, value);
  return dv.getUint32(0);
}
function hex(bits: number): string {
  return '0x' + (bits >>> 0).toString(16).padStart(8, '0');
}

/**
 * Vitest's default is 5 s. The guarded test(s) are 719 ms solo and 3.2 s under four concurrent
 * full suites; the fleet also runs three concurrent pairs (6 processes), and at that load the
 * orchestrator measured a 946 ms-solo test false-red 6/6 on 2026-09-29 — this is the same band.
 * 60 s is the budget the vision-on gate already carries (t_1f4a7a8a): that measurement with room,
 * and still a guard, so a genuine hang fails.
 */
const LOAD_TIMEOUT_MS = 60_000;

describe('the contraction sweep (t_981fcace)', () => {
  it('linearPDF takes the fused arm, not the rounded product', () => {
    const slope = fromBits(0xbecccccd); // -0.4f, native's own literal
    const yIntercept = fromBits(0x3ecccccd); // 0.4f
    for (const c of LINEAR_PDF_CASES) {
      const x = fromBits(c.x);
      const got = linearPDF(x, slope, yIntercept);
      // the pre-sweep form, verbatim: `f32(f32(slope*x) + yIntercept)`
      const unfused = f32(f32(slope * x) + yIntercept);
      expect(hex(bitsOf(unfused)), 'the pinned case must separate the two forms').toBe(
        hex(c.unfused),
      );
      expect(hex(bitsOf(got)), `linearPDF(${x})`).toBe(hex(c.fused));
    }
  });

  it('agent::FieldOfView / fovx takes the double-precision fused form', () => {
    for (const c of FOV_CASES) {
      const focus = fromBits(c.focus);
      const minFocus = fromBits(c.minFocus);
      const maxFocus = fromBits(c.maxFocus);
      const got = Camera.horizontalFovForFocus(focus, minFocus, maxFocus, false);
      // the pre-sweep form: the product narrowed before the sum
      const unfused = f32(f32(focus * f32(maxFocus - minFocus)) + minFocus);
      expect(hex(bitsOf(unfused))).toBe(hex(c.unfused));
      expect(hex(bitsOf(got))).toBe(hex(c.fused));
      // …and the sweep's form is the helper's, with the difference narrowed like native's `fsub`
      expect(bitsOf(got)).toBe(
        bitsOf(f32(focus * f32(maxFocus - minFocus) + minFocus)),
      );
    }
  });

  it('the pitch/yaw sites (agent.ts and geometry/camera.ts) are the same shape', () => {
    for (const c of PITCH_CASES) {
      const nerve = fromBits(c.nerve);
      const lo = fromBits(c.minPitch);
      const hi = fromBits(c.maxPitch);
      const delta = f32(hi - lo); // native's `fsub s2, s2, s1`
      expect(hex(bitsOf(f32Fma(nerve, delta, lo)))).toBe(hex(c.fused));
      expect(hex(bitsOf(f32(f32(nerve * delta) + lo)))).toBe(hex(c.unfused));
    }
  });

  it('the barrier bounds fuse `x() ± FF*CarryRadius()` (the rounded product only survives the |dist| test)', () => {
    for (const c of BARRIER_BOUND_CASES) {
      const x = fromBits(c.x);
      const cr = fromBits(c.carryRadius);
      const ff = fromBits(c.ff);
      // `0x26a04 fmadd s3, s1, s3, s0` with the multiplier baked to -1.01f
      expect(hex(bitsOf(f32Fma(-ff, cr, x)))).toBe(hex(c.fused));
      // the pre-sweep form, and the rounded product the `|dist| < FF*CarryRadius()` test uses
      expect(hex(bitsOf(f32(x - f32(ff * cr))))).toBe(hex(c.unfused));
      expect(f32Fma(-ff, cr, x)).not.toBe(f32(x - f32(ff * cr)));
    }
  });

  it('food::setradius keeps fLength[0] squared exact and rounds fLength[2] squared', () => {
    for (const c of FOOD_RADIUS_SQ_CASES) {
      const l0 = fromBits(c.l0);
      const l2 = fromBits(c.l2);
      expect(hex(bitsOf(f32Fma(l0, l0, f32(l2 * l2))))).toBe(hex(c.fused));
      // the pre-sweep form rounded the *first* square (a different value, not a rarer one)
      expect(hex(bitsOf(f32(f32(l0 * l0) + f32(l2 * l2))))).toBe(hex(c.unfused));
    }
  });

  it('agent::setradius keeps fLength[0] squared exact and rounds fLength[2] squared', () => {
    for (const c of AGENT_RADIUS_CASES) {
      const lx = fromBits(c.lx);
      const lz = fromBits(c.lz);
      const squares = f32Fma(lx, lx, f32(lz * lz)); // 0x21f44 fmul + 0x21f48 fmadd
      expect(hex(bitsOf(squares)), 'the contracted square sum').toBe(hex(c.fusedSum));
      // the pre-sweep form rounded *both* squares — a different value, not a rarer one
      const unfusedSquares = f32(f32(lx * lx) + f32(lz * lz));
      expect(hex(bitsOf(unfusedSquares))).toBe(hex(c.unfusedSum));
      expect(c.fusedSum).not.toBe(c.unfusedSum);
      // …and the derived `fRadius`: the float `fsqrt` (`0x21f4c`) then three float × float
      // multiplies (`fRadiusScale` and `fScale` are 1 for these cases, `× 0.5` is exact)
      const root = f32(Math.sqrt(squares));
      expect(hex(bitsOf(f32(f32(f32(root * f32(1)) * f32(1)) * 0.5)))).toBe(hex(c.fusedRadius));
      expect(hex(bitsOf(f32(Math.sqrt(unfusedSquares) * 0.5)))).toBe(hex(c.unfusedRadius));
      expect(c.fusedRadius).not.toBe(c.unfusedRadius);
    }
  });

  it('gpoly/gpolyobj::setradius contracts the three-square sum (live PolyObj and body path)', () => {
    for (const c of GPOLY_RADIUS_CASES) {
      const x = fromBits(c.x);
      const y = fromBits(c.y);
      const z = fromBits(c.z);
      // 0x84ca0 `fmul s1, s1, s1` rounds y² only; 0x84ca4/0x84cac `fmadd` keep x², z² exact
      const squares = f32Fma(z, z, f32Fma(x, x, f32(y * y)));
      expect(hex(bitsOf(squares)), 'the contracted square sum').toBe(hex(c.fusedSum));
      // the pre-sweep form rounded all three products
      const unfusedSquares = f32(f32(f32(x * x) + f32(y * y)) + f32(z * z));
      expect(hex(bitsOf(unfusedSquares))).toBe(hex(c.unfusedSum));
      expect(c.fusedSum).not.toBe(c.unfusedSum);
      // Live: `PolyObj`'s constructor runs `setlen()` → `deriveRadius()` over the box these
      // four vertices measure (exactly `(x, y, z)`), with `fRadiusScale = fScale = 1`.
      const template = new PolyObj([{ vertices: [0, 0, 0, x, 0, 0, 0, y, 0, 0, 0, z] }]);
      expect(hex(bitsOf(template.radius))).toBe(hex(c.fusedRadius));
      // …and the same rule on the *live* agent-body path (`agent::SetGeometry` → `setlen`)
      const body = createAgentBodyGeometry(template);
      body.lengths();
      expect(hex(bitsOf(body.radius()))).toBe(hex(c.fusedRadius));
      expect(c.fusedRadius).not.toBe(c.unfusedRadius);
    }
  });

  it('f32Fma is the hardware fma where `Math.fround(a*b + c)` is not', () => {
    const { a, b, c, exactFma, doubleRounded } = NEAR_MISS_COUNTEREXAMPLE;
    const fa = fromBits(a);
    const fb = fromBits(b);
    const fc = fromBits(c);
    expect(hex(bitsOf(f32Fma(fa, fb, fc)))).toBe(hex(exactFma));
    expect(hex(bitsOf(f32(fa * fb + fc)))).toBe(hex(doubleRounded));
    expect(f32Fma(fa, fb, fc)).not.toBe(f32(fa * fb + fc));
  });

  it('over the model’s own ranges the near-miss form agrees (the sweep left those sites alone)', () => {
    // A deterministic sample of the shapes the remaining `f32(a*b + c)` sites take: a
    // nerve-like factor in [0,1], a span-like factor in ±100, an accumulator in ±100.
    let state = 0x2545f491;
    const next = (): number => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0x100000000;
    };
    let checked = 0;
    for (let i = 0; i < 200000; i++) {
      const a = f32(next());
      const b = f32((next() * 2 - 1) * 100);
      const c = f32((next() * 2 - 1) * 100);
      expect(f32(a * b + c)).toBe(f32Fma(a, b, c));
      checked++;
    }
    expect(checked).toBe(200000);
  }, LOAD_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// the live drives — round 3 of the review: every cleared site must fail on a revert
// ---------------------------------------------------------------------------

/**
 * Round 2 of this card's review found that most of the pins above are **local
 * re-derivations**: they compose `f32Fma(a, b, c)` from the pinned constants and compare the
 * result with a constant, so they never call the ported site and a revert leaves the suite
 * green. The `agent.ts` sites now have drives that call the ported code
 * (`tests/agent.test.ts` -> *the contraction sweep — drives for the agent sites*); these are
 * the remaining three: `food::setradius` (live `Food`), `gpoly::setradius` (live `Poly`) and
 * `Camera.configureAgentPov`'s pitch/yaw.
 *
 * The expected values are the same exact-rational derivations the constants above use
 * (`dis/gen_pins2.py` in t_981fcace's workspace), and every case is checked non-vacuous: the
 * pre-sweep form is a different bit pattern on it.
 */

describe('the sweep’s live drives (t_981fcace, round 3)', () => {
  it('food::setradius contracts the square sum (live Food, 0x5aa80/0x5aa84)', () => {
    // `food::setradius` rounds `fLength[2]^2` (`0x5aa80 fmul s1, s1, s1`) and keeps
    // `fLength[0]^2` exact across the `0x5aa84 fmadd`. The case is one where the *derived
    // radius* (not just the sum) separates the two forms, so `Food.setlen()` — the live path
    // (`initlen()` -> `setlen()` -> the virtual `deriveRadius()`) — is pinned, not a copy of
    // its arithmetic.
    globals.numEnergyTypes = 1;
    const l0 = 0x4021b946;
    const l2 = 0x404b445f;
    const foodType = { color: { r: 0, g: 0, b: 0 } } as unknown as FoodType;
    const rng: RngSurface = {
      srand: () => {},
      rand: () => 0,
      srand48: () => {},
      drand48: () => 0.5,
      lrand48: () => 0,
      nrand: () => 0,
      nrandScaled: () => 0,
    };
    const food = new Food(foodType, 0, new Energy(100), 1, 1, rng);
    food.setlen(fromBits(l0), 1, fromBits(l2));
    expect(hex(bitsOf(food.radius())), 'food::setradius').toBe(hex(0x4001e07f));
    // non-vacuity: the pre-sweep form (both squares rounded) differs in the radius itself
    const oldSum = f32(f32(fromBits(l0) * fromBits(l0)) + f32(fromBits(l2) * fromBits(l2)));
    expect(hex(bitsOf(oldSum))).toBe(hex(0x4183c808));
    expect(hex(bitsOf(f32(f32(Math.sqrt(oldSum) * f32(1)) * f32(1)) * f32(0.5)))).toBe(
      hex(0x4001e07e),
    );
  });

  it('gpoly::setradius contracts the three-square sum (live Poly, 0x8497c-0x84988)', () => {
    // `Poly` has no caller in the tree (`new Poly(` occurs nowhere else) and `gpoly` never
    // derives bounds of its own (`setlen` does not exist on it), so the only way to drive
    // `gpoly::setradius` is to set `fLength` directly and call the deriver — which is what
    // `setscale` does (`gpoly::setscale` -> `setradius`, `radiusFixed` false).
    for (const c of GPOLY_RADIUS_CASES) {
      const poly = new Poly();
      poly.length = vec3(fromBits(c.x), fromBits(c.y), fromBits(c.z));
      poly.setScale(1);
      expect(hex(bitsOf(poly.radius)), `Poly.deriveRadius x=${hex(c.x)}`).toBe(
        hex(c.fusedRadius),
      );
      // non-vacuity: all three products rounded is a different radius on this case
      const oldSquares = f32(
        f32(f32(fromBits(c.x) * fromBits(c.x)) + f32(fromBits(c.y) * fromBits(c.y))) +
          f32(fromBits(c.z) * fromBits(c.z)),
      );
      expect(hex(bitsOf(f32(Math.sqrt(oldSquares) * 0.5)))).toBe(hex(c.unfusedRadius));
    }
  });

  it('Camera.configureAgentPov drives the fused pitch and yaw (0x262f0/0x26338)', () => {
    // `Camera.configureAgentPov` is the L15 side of `agent::UpdateVision`'s pitch/yaw; it is
    // the same two `fmadd d0, d0, d1, d2` + `fcvt` sites. `angles` is `(yaw, pitch, roll)`, so
    // `angles.y` is the pitch and `angles.x` the yaw.
    for (const c of PITCH_CASES) {
      const camera = new Camera();
      camera.configureAgentPov({
        focus: 0,
        minFocus: 0,
        maxFocus: 0,
        invertFocus: false,
        agentFOV: fromBits(0x41100000),
        retinaWidth: 2,
        retinaHeight: 2,
        eyeHeight: 0.5,
        agentHeight: 1,
        fLengthZ: 1,
        worldSize: 100,
        enableVisionPitch: true,
        visionPitch: fromBits(c.nerve),
        minVisionPitch: fromBits(0xc3340000),
        maxVisionPitch: fromBits(0x43340000),
        enableVisionYaw: true,
        visionYaw: fromBits(c.nerve),
        minVisionYaw: fromBits(0xc3340000),
        maxVisionYaw: fromBits(0x43340000),
      });
      expect(hex(bitsOf(camera.angles.y)), `pitch ${hex(c.nerve)}`).toBe(hex(c.fused));
      expect(hex(bitsOf(camera.angles.x)), `yaw ${hex(c.nerve)}`).toBe(hex(c.unfused + 1));
    }
  });
});

// ---------------------------------------------------------------------------
// The contraction-sweep follow-up (t_2a625bd5) — the L6 brain and L11 sim sites the sweep
// left open (see `PARITY.md` -> *the contraction sweep* -> *Open items*).
//
// Same discipline as the block above: every expected value comes from exact rational
// arithmetic (`dis/gen_followup_pins.py`, `dis/searchA.py`, `dis/gen_offc.py`,
// `dis/gen_offc2.py`, `dis/gen_final.py` in the card's workspace) and every case carries a
// non-vacuity assertion that the *pre-change* form is a different value — so a revert fails
// here. The one exception is called out in its own comment.
// ---------------------------------------------------------------------------

describe('the contraction sweep follow-up — L6/L11 single-precision sites (t_2a625bd5)', () => {
  // --- sheets::Vector3<float>::distance (`addReceptiveField` 0x61000/0x61004/0x61014/0x61018)
  // The binary materialises `f32(dy*dy)`, fuses `dx*dx` and `dz*dz` into it with two `fmadd`s
  // and takes the **float** sqrt; the port rounded all three squares.
  const VEC_DIST_CASES = [
    { x: 0xc22bdb99, y: 0xc1f55ee6, z: 0xc224745f, ox: 0x41d7e9de, oy: 0xc1559377, oz: 0xc0353bc7, fused: 0x42a334e0, unfused: 0x42a334e1 },
    { x: 0xc20aa740, y: 0xc23a2ac6, z: 0xc1ff5392, ox: 0xc22db452, oy: 0xc20bb24e, oz: 0x4193e4e8, fused: 0x4251d840, unfused: 0x4251d83f },
    { x: 0xc1c7fc45, y: 0xc1ec7314, z: 0xc21b1f79, ox: 0x4240699d, oy: 0x42206b8f, oz: 0xc190ad03, fused: 0x42ce2751, unfused: 0x42ce2750 },
    { x: 0xc1a27c2c, y: 0xc237cc33, z: 0xc2342782, ox: 0x424520aa, oy: 0x41bff209, oz: 0xc0c3f6a1, fused: 0x42d42074, unfused: 0x42d42075 },
  ];

  it('sheets::Vector3f::distance fuses two of the three squares (0x61004/0x61014)', () => {
    for (const c of VEC_DIST_CASES) {
      const label = `${hex(c.x)}..${hex(c.oz)}`;
      const got = new Vector3f(fromBits(c.x), fromBits(c.y), fromBits(c.z)).distance(
        new Vector3f(fromBits(c.ox), fromBits(c.oy), fromBits(c.oz)),
      );
      expect(hex(bitsOf(got)), `distance ${label}`).toBe(hex(c.fused));

      const dx = f32(fromBits(c.x) - fromBits(c.ox));
      const dy = f32(fromBits(c.y) - fromBits(c.oy));
      const dz = f32(fromBits(c.z) - fromBits(c.oz));
      const preChange = f32(Math.sqrt(f32(f32(f32(dx * dx) + f32(dy * dy)) + f32(dz * dz))));
      expect(hex(bitsOf(preChange)), `pre-change ${label}`).toBe(hex(c.unfused));
    }
  });

  // --- sheets::Sheet::createNeurons (`0x60904`/`0x6090c`): `inset + index*spacing` in ONE
  // rounding. `_neuronSpacing = f32(1/count)`, `_neuronInsets = spacing/2`.
  const SHEET_POS_CASES = [
    { count: 5, i: 3, spacing: 0x3e4ccccd, inset: 0x3dcccccd, fused: 0x3f333333, preChange: 0x3f333334 },
    { count: 7, i: 3, spacing: 0x3e124925, inset: 0x3d924925, fused: 0x3f000000, preChange: 0x3f000001 },
    { count: 7, i: 6, spacing: 0x3e124925, inset: 0x3d924925, fused: 0x3f6db6dc, preChange: 0x3f6db6dd },
    { count: 9, i: 7, spacing: 0x3de38e39, inset: 0x3d638e39, fused: 0x3f555555, preChange: 0x3f555556 },
  ];

  it('sheets::Sheet::createNeurons fuses each sheet position (0x60904/0x6090c)', () => {
    for (const c of SHEET_POS_CASES) {
      const label = `count ${c.count} i ${c.i}`;
      const model = new SheetsModel(new Vector3f(1, 1, 1), 0.0);
      const created: Neuron[] = [];
      model.createSheet(
        'Red',
        -1,
        Sheet.Input,
        0,
        0.0,
        new Vector2f(0.5, 0.5),
        new Vector2f(0.5, 0.5),
        new Vector2i(c.count, c.count),
        (n) => created.push(n),
      );
      const neuron = created[c.i * c.count]!;
      expect(hex(bitsOf(neuron.sheetPosition.a)), `sheetPosition.a ${label}`).toBe(hex(c.fused));
      const preChange = f32(fromBits(c.inset) + f32(c.i * fromBits(c.spacing)));
      expect(hex(bitsOf(preChange)), `pre-change ${label}`).toBe(hex(c.preChange));
    }
  });

  // --- Sheet::findReceptiveFieldNeurons's local `offsetCenter` (`addReceptiveField` 0x60ea8
  // `fmla.2s`, and the scalar `fmadd` pair when the two axes are not vectorised).
  //
  // NOTE on rigour: the *caller's* observable is only `findNeurons`' ceil/floor projection of
  // this center, and a ≤1 ulp binary32 move in the center changes that projection with
  // probability ≈ 1e-7 — a 4·10⁵-trial search (`dis/searchC.py`) found no discriminating
  // input. The helper is therefore exported for this pin and driven directly; that is the one
  // place in this file where the ported site is exercised below its public API.
  const OFFSET_CENTER_CASES = [
    { center: 0x3e99999a, offset: 0x3f333333, fused: 0x3f4a3d71, preChange: 0x3f4a3d70 },
    { center: 0x3f7ee294, offset: 0xbef0c661, fused: 0x3f07059d, preChange: 0x3f07059c },
  ];

  it('sheets offsetCenter fuses the receptive-field center move (0x60ea8)', () => {
    for (const c of OFFSET_CENTER_CASES) {
      const label = `${hex(c.center)}/${hex(c.offset)}`;
      const center = new Vector2f(fromBits(c.center), 0);
      offsetCenter(center, 'a', fromBits(c.offset));
      expect(hex(bitsOf(center.a)), `offsetCenter ${label}`).toBe(hex(c.fused));

      const was = fromBits(c.center);
      const off = fromBits(c.offset);
      const factor = off < 0 ? was : f32(1 - was);
      const preChange = f32(was + f32(factor * off));
      expect(hex(bitsOf(preChange)), `pre-change ${label}`).toBe(hex(c.preChange));
    }
  });

  // --- agent::{Random,Energy}Sensor's *prebirth* signal and the Random update
  // (`agent/RandomSensor.cc:26` `nerve->set( rng->drand() )`): `Nerve::set` takes a `double`
  // and the activation array is `double[]`, so nothing narrows here. The port applied `f32`
  // to the draw; the recorded `run/brain/Recent/0/brainFunction_*` divergences are exactly
  // this (`%g` of the double vs `%g` of its binary32 rounding differ on ~1.1 % of draws).
  const DRAW = 0.5030824984423816; // k/2^32, k = 0x80ca03be — on the oracle's GSL grid

  function sensorNerve(): { get: () => number; set: (v: number) => void; value: () => number } {
    let stored = 0;
    return { get: () => stored, set: (v: number) => { stored = v; }, value: () => stored };
  }

  it('the sensors store the RNG draw un-narrowed (RandomSensor.cc:26)', () => {
    const rng = { drand: () => DRAW };
    const randomNerve = sensorNerve();
    const random = new RandomSensor(rng as never);
    random.sensorGrow({ getNerve: () => randomNerve } as never);
    random.sensorUpdate();
    expect(randomNerve.value()).toBe(DRAW);
    // …and the pre-change `f32(draw)` is a *lossy* step whose printed value differs — the
    // shape of the recorded divergence (`0.503082` against `0.503083`)
    expect(f32(DRAW)).not.toBe(DRAW);
    expect(bitsOf(DRAW)).toBe(0x3f00ca04);
    expect(bitsOf(f32(DRAW))).toBe(0x3f00ca04); // same f32 round-trip; the *double* differs

    const energyNerve = sensorNerve();
    const energy = new EnergySensor({} as never);
    energy.sensorGrow({ getNerve: () => energyNerve } as never);
    energy.sensorPrebirthSignal(rng as never);
    expect(energyNerve.value()).toBe(DRAW);
  });

  // --- TSimulation ctor 0x892a4/0x892a8: `maxagentradius` in float, second square rounded.
  // Driven through a real scenario boot (the ctor runs there) and read off the global
  // `agentConfig.maxRadius` the ctor writes. The expected value is the exact-rational one
  // (`dis/gen_final.py`) for the config the recorded `microtest.wf` sets.
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const NATIVE_ROOT = process.env['POLYWORLD_NATIVE'] ?? join(REPO_ROOT, '..', 'polyworld');
  const haveNativeTree = existsSync(join(NATIVE_ROOT, 'lib', 'libpolyworld.dylib'));

  it.skipIf(!haveNativeTree)('TSimulation ctor fuses the max-radius square sum (0x892a4/0x892a8)', () => {
    const outDir = mkdtempSync(join(tmpdir(), 't2a625bd5-ctor-'));
    const result = runScenario({ scenario: 'microtest_voff', outDir, maxSteps: 1, repoRoot: REPO_ROOT });
    expect(result.ok).toBe(true);

    // `float` `maxagentradius` wins the `fmax` against `maxfoodradius`, widened to a JS number.
    expect(agentConfig.maxRadius).toBe(1.8708287477493286); // f32 0x3fef7751
    expect(hex(bitsOf(agentConfig.maxRadius))).toBe(hex(0x3fef7751));

    // non-vacuity: the pre-change binary64 form differs as a *double* (the two share an f32
    // bit pattern, which is why this pin reads the double, not `bitsOf` alone)
    const malx = agentConfig.maxAgentSize / Math.sqrt(agentConfig.minmaxspeed);
    const malz = agentConfig.maxAgentSize * Math.sqrt(agentConfig.maxmaxspeed);
    expect(0.5 * Math.sqrt(malx * malx + malz * malz)).not.toBe(agentConfig.maxRadius);
  }, LOAD_TIMEOUT_MS);
});
