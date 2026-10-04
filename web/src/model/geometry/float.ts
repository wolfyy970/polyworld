/**
 * Lane W1e — float discipline and the native math constants.
 *
 * PORT_SPEC ground rule 3: model math is `float`/`double` exactly as written, so every
 * place the native code stores into a `float` must round through `Math.fround`, and every
 * place it computes in `double` (a C `double` literal or a libm call) must stay f64.
 *
 * PORT-NOTE(W1e/f32-discipline): the native graphics code is a mix of both. `gobject` /
 * `gcamera` / `gpoly` store `float` members, `glRotatef`/`glTranslatef`/`glScalef` take
 * floats and the GL matrix stack is float, while `frustumXZ` computes with `double`
 * constants (`DEGTORAD`, `TWOPI`) and `double` libm calls and only rounds on assignment to
 * its `float` members. The port reproduces exactly that split; the golden vectors in
 * `golden/nativeCameraVectors.ts` are generated from the native code + the same GL
 * implementation and are the arbiter (see `tests/geometry.test.ts`).
 *
 * PORT-NOTE(W1e/atan2f-is-transcribed): the oracle's arm64 `atan2f` — the float overload this
 * lane's `frustumXZ::Inside` calls — is transcribed in lane W1d/L1's `rng/libm.ts`; `nativeAtan2f`
 * below delegates to it so the model maths keeps one copy.  See that file and
 * `rng/native/raw/apple_atan2f_impl.h` for the transcription and the census that forced it.
 */

import { atan2f } from '../rng/libm';

/** The native `float` store: every value the C++ code keeps in a `float` member/array. */
export const f32: (x: number) => number = Math.fround;

/** Round every element of a vector-like array through f32. */
export function f32All(values: readonly number[]): number[] {
  return values.map(f32);
}

/**
 * `PI` — native `utils/misc.h:108` (`#define PI M_PI`, i.e. the host `M_PI`).
 */
export const PI = Math.PI;

/**
 * `HPI` — native `utils/misc.h:112` (`M_PI_2`).
 */
export const HPI = Math.PI / 2;

/**
 * `TWOPI` — native `utils/misc.h:111`, **verbatim**: `6.28318530717059647602`.
 *
 * PORT-NOTE(W1e/twopi-truncated): this literal is *not* `2*PI` (6.283185307179586…) — the
 * native constant is truncated at the 13th decimal and differs from 2π by 8.99e-12. The
 * difference is small but not zero, and `frustumXZ::Set` feeds it to `fmod`, so the port
 * keeps the truncated value rather than "fixing" it (PORT_SPEC ground rule 1).
 */
export const TWOPI = 6.28318530717059647602;

/**
 * `DEGTORAD` — native `utils/misc.h:114`, **verbatim**: `0.017453292`.
 *
 * PORT-NOTE(W1e/degtorad-truncated): likewise truncated (π/180 = 0.017453292519943295…);
 * the port uses the native value everywhere the native code does. Note that *GL itself*
 * does not: `glRotatef` converts degrees with the full-precision constant, which is why
 * `matrix.ts` has a separate `glDegreesToRadians` (see its PORT-NOTE).
 */
export const DEGTORAD = 0.017453292;

/** `RADTODEG` — native `utils/misc.h:113`, verbatim: `57.29577951`. */
export const RADTODEG = 57.29577951;

/** The sign of a zero is not preserved through the GL matrix stack; normalizers use this. */
export function normalizeZero(x: number): number {
  return x === 0 ? 0 : x;
}

/** Exact float32 bit pattern of a value (after f32 rounding). */
export function f32Bits(x: number): number {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = f32(x);
  return new Uint32Array(buf)[0] as number;
}

/** Number of float32 steps between two values (0 = bit-identical, NaN/inf = Infinity). */
export function f32UlpDistance(a: number, b: number): number {
  const ia = f32Bits(a);
  const ib = f32Bits(b);
  const ordered = (i: number): number => (i & 0x80000000 ? 0x80000000 - (i & 0x7fffffff) : i);
  return Math.abs(ordered(ia) - ordered(ib));
}

/** f32 comparison that treats `-0` and `+0` as equal (the GL stack produces both). */
export function sameF32(a: number, b: number): boolean {
  return f32(a) === f32(b);
}

/**
 * `atan2f` — the libm call the native code actually makes.
 *
 * PORT-NOTE(W1e/atan2f-is-transcribed): `frustumXZ::Inside` writes `float ang = atan2(x0 - p[0],
 * z0 - p[2])` with **float** arguments, so C++ overload resolution picks the *float* `atan2f`,
 * not `atan2`. That float overload is now a real transcription — `src/model/rng/libm.ts`'s
 * `atan2f`, its constants extracted from the shipped bytes by `rng/native/gen_atan2f_table.py`
 * into `appleAtan2fTable.ts`, the C transcription diffed against the census before the port —
 * and this is a thin delegation to it, so there is exactly one copy. What used to live here
 * (`PORT-NOTE W1e/atan2f-pi`: `f32(Math.atan2)` plus the two ±π values) is **deleted**, because
 * the census (`PORT-NOTE W1e/atan2f-census` below) measured it wrong: 1 ulp off the shipped
 * `atan2f` on 460 of the 20,050 committed pairs and on 18,279 of a 606,583-pair sweep, every one
 * of them *outside* the ±π family the two constants covered, the model's own argument class
 * included. The transcription is bit-exact on both corpora, exact ±π by construction — arm64's
 * `atan2f(0, -1)` is `0x40490FDA`, one ulp below the correctly rounded `0x40490FDB`, which
 * `ATAN2F_PI_HI` reproduces; see the `frustumQ.yaw90_fov180` golden, where that decides an
 * `Inside` result at the wedge boundary.
 *
 * PORT-NOTE(W1e/atan2f-census): the census (`native/atan2fprobe.{c,sh}`, the corpus + native
 * output under `native/raw/**`, `tools/measure_atan2f.ts`) swept 20,050 argument pairs — the
 * model's own lattice (differences of WorldSize-25 world coordinates), the whole float range
 * either side of it, the ±0 / ±π / quadrant edges and denormals — and compared **bit patterns**:
 * arm64's `atan2f` differs from `f32(atan2)` on 3,924 (19.571 %) of them, always by 1 ulp, and
 * the *pre-transcription stand-in* differed from `atan2f` on **460 (2.3 %)**, every one outside
 * the ±π family. The shipped function is the inaccurate side (`raw/verify_atan2f_correct_
 * rounding.py`: the true angle is nearer `f32(atan2)` on 177/179 decided rows) and the
 * difference is observable (`tools/witness_atan2f_wedge.ts`: 187 of 244 differing reachable
 * pairs have a wedge configuration in the model's own `fov`/`yaw` domain whose limit lands
 * exactly on the differing float and flips `Inside`). It moves no recorded byte, because
 * `Inside` has no call site in `src/model/**` (PORT-NOTE `W1e/frustumxz-is-dead-for-the-retina`)
 * and native's `infrustum`/`outfrustum` counters are never logged — which is why the census and
 * the witness tool are kept re-runnable (`tools/measure_atan2f.ts` now reports the transcription
 * against the shipped function: 0 differ of 20,050 and 0 of 606,583) rather than deleted with
 * the stand-in.
 */
export function nativeAtan2f(y: number, x: number): number {
  return atan2f(y, x);
}
