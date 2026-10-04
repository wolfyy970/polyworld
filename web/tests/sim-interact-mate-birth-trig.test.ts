/**
 * Lane L8/L11 — `TSimulation::Mate`'s birth position goes through the oracle's
 * `__sincosf_stret`, not a narrowed `Math.cos`/`Math.sin` (task t_c99150dc).
 *
 * Read out of the shipped `libpolyworld.dylib` (`xcrun llvm-objdump
 * --disassemble-symbols=__ZN11TSimulation4MateEP5agentS1_PN3sim22AgentContactBeginEventE`):
 *
 *     98564: fmul d0, d0, d1            ; d1 = 0x401921fb54442d18 = 2*M_PI, d0 = randpw()
 *     98568: fcvt s0, d0                ; angle = f32( 2*M_PI * randpw() )
 *     9856c: bl   0xa3994               ; <symbol stub for: ___sincosf_stret>  -- ONE call
 *     98570: fmadd s1, s8, s1, s13      ; x = distance*s1 + x   (s8 = distance)
 *     98574: fmsub s0, s8, s0, s14      ; z = z - distance*s0
 *
 * `0x9856c` is LLVM's fused **two-output single-precision** entry in the `sinf`/`cosf` unit
 * (`sinf + 0x1ac`) — the same overload the camera reaches (PARITY ->
 * `W1d-fu/camera-calls-sincosf-not-sinf-cosf`), and a *different algorithm* from the scalar
 * `sinf`/`cosf` pair. It is not two calls and it is not `f32(double)`: the site used to narrow
 * V8's **double** `Math.cos`/`Math.sin` as a stand-in for the float overloads, which is the last
 * such stand-in in the tree.
 *
 * The returned pair is `(sin, cos)` — `s0` = sin feeds z, `s1` = cos feeds x, and the corpus
 * agrees independently (`raw/libm_native_sincosf.txt` row 1: `sincosf(0) = (0, 1)`).
 *
 * Two measured facts, and the second is why this has to assert the call site:
 *
 *  * the two forms disagree over the angle domain the site can actually produce
 *    (`f32(2*M_PI*randpw())` is in `[0, 2*M_PI)`), counted below, and
 *  * the difference does reach the position — so the pin is not documenting an effect that dies
 *    in the fused product — but the block itself is unreachable in every recorded run
 *    (`RandomBirthLocation` is `False` in the schema default *and* in both recorded worldfiles),
 *    so **no golden, farm line or per-agent trace can catch a revert**. That makes this a
 *    fidelity fix, not an artifact fix, and it is not claimed as one.
 * Load, not slowness of the code: the heavy test here has been measured at 6.4 s with four
 * concurrent full suites against a 1105 ms solo baseline — past vitest's 5 s default, which is
 * what false-reds it. It carries LOAD_TIMEOUT_MS below; no assertion changed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { f32, f32Fma } from '../src/model/agent';
import { sincosf } from '../src/model/rng/libm';

const HERE = __dirname;
const TWO_PI = 2 * Math.PI;

/**
 * Vitest's default is 5 s, which this test has been measured past: 6.4 s with four concurrent
 * full suites against a 1105 ms solo baseline (2026-09-29, the load the fleet runs at). 60 s is
 * the budget the vision-on gate already carries (t_1f4a7a8a) — that measurement with room, and
 * still a guard: a genuine hang fails.
 */
const LOAD_TIMEOUT_MS = 60_000;

describe('L8/L11 — `TSimulation::Mate` birth position uses the oracle’s `__sincosf_stret` (t_c99150dc)', () => {
  /** the site's own domain: `angle = f32( 2*M_PI * randpw() )`, `randpw()` in `[0, 1)`. */
  const ANGLES: readonly number[] = Array.from({ length: 200000 }, (_, i) =>
    f32((i * TWO_PI) / 200000),
  );
  /** a minitest-scale world: `WorldSize 25`, `RandomBirthLocationRadius` default `1.0`. */
  const DISTANCES: readonly number[] = [1, 5, 12.5, 25].map(f32);
  /** the parents' midpoint: `x` in `[0, 25)`, `z` in `(-25, 0]`. */
  const X0: readonly number[] = [0.5, 6.25, 12.5, 24.9].map(f32);
  const Z0: readonly number[] = [-24.9, -12.5, -6.25, -0.5].map(f32);

  it('disagrees with V8 on 56 (sin) / 48 (cos) of 200,000 angles in [0, 2π)', () => {
    let sinDiff = 0;
    let cosDiff = 0;

    for (const angle of ANGLES) {
      const [sinAngle, cosAngle] = sincosf(angle);
      if (sinAngle !== f32(Math.sin(angle))) sinDiff++;
      if (cosAngle !== f32(Math.cos(angle))) cosDiff++;
    }

    expect([sinDiff, cosDiff], 'raw disagreement on the angle domain').toEqual([56, 48]);
    expect(ANGLES.length, 'the angle grid').toBe(200000);
  });

  it('the difference reaches x and z through the fused update (428 / 485 of 3,200,000)', () => {
    let xFlips = 0;
    let zFlips = 0;

    for (const distance of DISTANCES) {
      for (let i = 0; i < X0.length; i++) {
        for (const angle of ANGLES) {
          const [sinAngle, cosAngle] = sincosf(angle);
          const sinV8 = f32(Math.sin(angle));
          const cosV8 = f32(Math.cos(angle));

          if (f32Fma(distance, cosAngle, X0[i]!) !== f32Fma(distance, cosV8, X0[i]!)) xFlips++;
          if (f32Fma(-distance, sinAngle, Z0[i]!) !== f32Fma(-distance, sinV8, Z0[i]!)) zFlips++;
        }
      }
    }

    expect([xFlips, zFlips], 'flips after the fused update, 4 distances × 4 midpoints').toEqual([
      428, 485,
    ]);
    expect(DISTANCES.length * X0.length * ANGLES.length, 'the (angle, distance, x) grid').toBe(
      3200000,
    );
  }, LOAD_TIMEOUT_MS);

  it('the birth-position site calls `sincosf`, not `Math.cos`/`Math.sin`', () => {
    const source = readFileSync(join(HERE, '..', 'src', 'model', 'sim', 'interact.ts'), 'utf8');

    expect(source).toContain('const [sinAngle, cosAngle] = sincosf(angle);');
    // the lane's own call site, so a swap of the two lanes is caught too
    expect(source).toContain('x = f32(f32Fma(distance, cosAngle, x));');
    expect(source).toContain('z = f32(f32Fma(-distance, sinAngle, z));');
    // the pre-change form, so the stand-in cannot come back unnoticed (no golden can see it)
    expect(source).not.toContain('Math.cos(');
    expect(source).not.toContain('Math.sin(');
  });
});
