/**
 * Lane W1e — 4x4 matrices in the GL convention, without GL.
 *
 * The native code never touches matrices directly: it calls `glLoadIdentity`, `glRotatef`,
 * `glTranslatef`, `glScalef`, `glMultMatrixf`, `gluPerspective`, `gluLookAt` and lets the
 * fixed-function stack compose them (`gobject::position`, `gcamera::Use`,
 * `gcamera::UsePerspective`). The port replaces the stack with these builders, so the
 * *storage order* and the *composition order* have to match GL exactly:
 *
 *   - storage: column-major, `m[col*4 + row]` — what `glGetFloatv(GL_*_MATRIX)` returns and
 *     what `types/geometry.ts` left to this lane to decide;
 *   - composition: a GL call post-multiplies, `M <- M · N`, so a sequence of calls
 *     `A(); B(); C();` from the identity is `((I·A)·B)·C` — the order the port's builders
 *     are chained in `camera.ts`;
 *   - matrices are `float` in the stack, so every composition result is rounded to f32.
 *
 * PORT-NOTE(W1e/compose-rounding): each composed entry gets **one rounding per term** — the
 * accumulation is the f32 FMA chain `s = f32(a·b + s)` (the product is exact in f64, the sum is
 * rounded once), not one rounding of the whole four-term dot. Measured two ways:
 *
 *   - against the recorded native matrix `gl.obj->minitest_a10_focus_min.modelview`, whose
 *     translation entry `[14]` is `0x3fbbff8a`: the FMA chain reproduces it bit-for-bit, the
 *     f64-accumulate form lands on `0x3fbbff87` and the product-then-sum form on `0x3fbbff88`
 *     (`tests/vision-camera.test.ts` replays the same fixture against the native bits);
 *   - directly, on this machine's Apple GL 2.1 (offscreen legacy CGL context, the same
 *     implementation the native build links): over 20,000 random `glRotatef`/`glTranslatef`
 *     sequences followed by one `glTranslatef` post-multiply, the FMA chain reproduces GL's
 *     `glGetFloatv(GL_MODELVIEW_MATRIX)` exactly **15,485/20,000** times and the
 *     f64-accumulate form **6,964/20,000**. Neither form is *always* exact — Apple's own
 *     composition rounds in a way these two models do not capture on every state — but the FMA
 *     chain is the one the frozen artifacts pin, so it is the port's rule.
 */

import type { Matrix4, Plane, Vec3, Vec4 } from '../types/geometry';
import { DEGTORAD, f32, sameF32 } from './float';
import { planeDistance } from './raycast';
import { vec3, vec4 } from './vector';

/** 4x4 matrix, column-major (`m[col*4+row]`), 16 f32 values — the GL layout. */
export const MATRIX_LENGTH = 16;

export function identityMatrix(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function cloneMatrix(m: Matrix4): number[] {
  return m.slice();
}

/** `glLoadIdentity()` + `glTranslatef(x, y, z)`. */
export function translationMatrix(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, f32(x), f32(y), f32(z), 1];
}

/**
 * `glScalef(sx, sy, sz)` — the general form, so a caller cannot need a second one. Every
 * diagonal entry is stored to `GLfloat` (the stack is f32).
 */
export function scalefMatrix(sx: number, sy: number, sz: number): number[] {
  return [f32(sx), 0, 0, 0, 0, f32(sy), 0, 0, 0, 0, f32(sz), 0, 0, 0, 0, 1];
}

/** `glLoadIdentity()` + `glScalef(s, s, s)` (the only scale form the scene uses). */
export function scaleMatrix(s: number): number[] {
  return scalefMatrix(s, s, s);
}

export type Axis = 'x' | 'y' | 'z';

/**
 * `glRotatef(degrees, axis)`.
 *
 * PORT-NOTE(W1e/rotatef-trig): GL converts the angle with a **float** product of the degree
 * value and the `π/180` constant, and evaluates the sine and cosine in **float** — the goldens
 * show `glRotatef(90, 0,1,0)` producing `cos = -4.3711388e-08` (the cosine of the *float* π/2,
 * not the double one, which would be 6.1e-17). The port therefore computes
 * `f32(f32(deg) * f32(π/180))` and rounds the trig result to f32.
 *
 * PORT-NOTE(W1e/rotatef-radians-measured): that product is `float × float`, i.e. the degree value
 * times the **f32** `π/180` — *not* the degree value times the full-precision `π/180` narrowed
 * once at the end. Measured directly on this machine's Apple GL 2.1 (offscreen legacy CGL
 * context, the same implementation the native build links): for 4,323 angles over
 * `[-180°, 180°]` × {x, y, z}, `glGetFloatv(GL_MODELVIEW_MATRIX)` after `glRotatef` equals this
 * f32-product form on **4,323/4,323** angles and the double-product form on **3,939/4,323**
 * (the two differ on 390 of the radians values). The recorded goldens cannot separate them —
 * both forms reproduce all six recorded angles — which is why the measurement, not the fixture,
 * is the reason. Rounding the double `cos`/`sin` to f32 is likewise fine: over the same 4,323
 * angles the narrowed double value equals `cosf`/`sinf` every time.
 *
 * PORT-NOTE(W1e/rotatef-signed-zero): GL leaves `-0` in some zero entries (e.g. the `0 * -s`
 * products of the y rotation) where this builder writes `+0`. The values are identical, the
 * bit patterns differ; the golden comparison treats ±0 as equal (see `float.ts`).
 */
export function rotationMatrix(axis: Axis, degrees: number): number[] {
  const radians = f32(f32(degrees) * f32(Math.PI / 180));
  const c = f32(Math.cos(radians));
  const s = f32(Math.sin(radians));
  switch (axis) {
    case 'x':
      return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
    case 'y':
      return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
    case 'z':
      return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }
}

/**
 * `M · N` in column-major storage: `out[col*4+row] = Σ_k M[row][k] · N[k][col]`, i.e. the
 * row-dot-product form GL uses, with the composition rounding rule of the fixed-function
 * stack — `PORT-NOTE(W1e/compose-rounding)` above (one f32 rounding per term).
 */
export function multiplyMatrix(a: Matrix4, b: Matrix4): number[] {
  const out = new Array<number>(MATRIX_LENGTH).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        // PORT-NOTE(W1e/compose-rounding): the product of two f32 values is exact in f64, so
        // `f32(a·b + sum)` is the fixed-function pipeline's per-term fused rounding.
        sum = f32((a[k * 4 + row] as number) * (b[col * 4 + k] as number) + sum);
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** Fold a left-to-right GL call sequence into one matrix (identity start). */
export function composeMatrix(...parts: readonly Matrix4[]): number[] {
  let m = identityMatrix();
  for (const p of parts) m = multiplyMatrix(m, p);
  return m;
}

export function transposeMatrix(m: Matrix4): number[] {
  const out = new Array<number>(MATRIX_LENGTH).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) out[col * 4 + row] = m[row * 4 + col] as number;
  }
  return out;
}

/** Element accessor for readability at call sites (`matrixAt(m, row, col)`). */
export function matrixAt(m: Matrix4, row: number, col: number): number {
  return m[col * 4 + row] as number;
}

/** Matrix · column vector (no perspective divide — that is the caller's business). */
export function transformVec4(m: Matrix4, v: Vec4): Vec4 {
  return vec4(
    (m[0] as number) * v.x + (m[4] as number) * v.y + (m[8] as number) * v.z + (m[12] as number) * v.w,
    (m[1] as number) * v.x + (m[5] as number) * v.y + (m[9] as number) * v.z + (m[13] as number) * v.w,
    (m[2] as number) * v.x + (m[6] as number) * v.y + (m[10] as number) * v.z + (m[14] as number) * v.w,
    (m[3] as number) * v.x + (m[7] as number) * v.y + (m[11] as number) * v.z + (m[15] as number) * v.w,
  );
}

/** Matrix · point (w = 1, w' dropped) — the rigid-transform case the scene uses. */
export function transformPoint3(m: Matrix4, p: Vec3): Vec3 {
  const v = transformVec4(m, vec4(p.x, p.y, p.z, 1));
  return vec3(v.x, v.y, v.z);
}

/**
 * Inverse of a general 4x4, used to recover a camera's world position from its modelview
 * (the goldens' `eyeWorld`). Returns `null` for a singular matrix instead of NaN/inf.
 */
export function invertMatrix(m: Matrix4): number[] | null {
  const a = m.map(Number);
  const inv = new Array<number>(16).fill(0);
  inv[0] = (a[5] as number) * (a[10] as number) * (a[15] as number) - (a[5] as number) * (a[11] as number) * (a[14] as number) -
    (a[9] as number) * (a[6] as number) * (a[15] as number) + (a[9] as number) * (a[7] as number) * (a[14] as number) +
    (a[13] as number) * (a[6] as number) * (a[11] as number) - (a[13] as number) * (a[7] as number) * (a[10] as number);
  inv[4] = -(a[4] as number) * (a[10] as number) * (a[15] as number) + (a[4] as number) * (a[11] as number) * (a[14] as number) +
    (a[8] as number) * (a[6] as number) * (a[15] as number) - (a[8] as number) * (a[7] as number) * (a[14] as number) -
    (a[12] as number) * (a[6] as number) * (a[11] as number) + (a[12] as number) * (a[7] as number) * (a[10] as number);
  inv[8] = (a[4] as number) * (a[9] as number) * (a[15] as number) - (a[4] as number) * (a[11] as number) * (a[13] as number) -
    (a[8] as number) * (a[5] as number) * (a[15] as number) + (a[8] as number) * (a[7] as number) * (a[13] as number) +
    (a[12] as number) * (a[5] as number) * (a[11] as number) - (a[12] as number) * (a[7] as number) * (a[9] as number);
  inv[12] = -(a[4] as number) * (a[9] as number) * (a[14] as number) + (a[4] as number) * (a[10] as number) * (a[13] as number) +
    (a[8] as number) * (a[5] as number) * (a[14] as number) - (a[8] as number) * (a[6] as number) * (a[13] as number) -
    (a[12] as number) * (a[5] as number) * (a[10] as number) + (a[12] as number) * (a[6] as number) * (a[9] as number);
  inv[1] = -(a[1] as number) * (a[10] as number) * (a[15] as number) + (a[1] as number) * (a[11] as number) * (a[14] as number) +
    (a[9] as number) * (a[2] as number) * (a[15] as number) - (a[9] as number) * (a[3] as number) * (a[14] as number) -
    (a[13] as number) * (a[2] as number) * (a[11] as number) + (a[13] as number) * (a[3] as number) * (a[10] as number);
  inv[5] = (a[0] as number) * (a[10] as number) * (a[15] as number) - (a[0] as number) * (a[11] as number) * (a[14] as number) -
    (a[8] as number) * (a[2] as number) * (a[15] as number) + (a[8] as number) * (a[3] as number) * (a[14] as number) +
    (a[12] as number) * (a[2] as number) * (a[11] as number) - (a[12] as number) * (a[3] as number) * (a[10] as number);
  inv[9] = -(a[0] as number) * (a[9] as number) * (a[15] as number) + (a[0] as number) * (a[11] as number) * (a[13] as number) +
    (a[8] as number) * (a[1] as number) * (a[15] as number) - (a[8] as number) * (a[3] as number) * (a[13] as number) -
    (a[12] as number) * (a[1] as number) * (a[11] as number) + (a[12] as number) * (a[3] as number) * (a[9] as number);
  inv[13] = (a[0] as number) * (a[9] as number) * (a[14] as number) - (a[0] as number) * (a[10] as number) * (a[13] as number) -
    (a[8] as number) * (a[1] as number) * (a[14] as number) + (a[8] as number) * (a[2] as number) * (a[13] as number) +
    (a[12] as number) * (a[1] as number) * (a[10] as number) - (a[12] as number) * (a[2] as number) * (a[9] as number);
  inv[2] = (a[1] as number) * (a[6] as number) * (a[15] as number) - (a[1] as number) * (a[7] as number) * (a[14] as number) -
    (a[5] as number) * (a[2] as number) * (a[15] as number) + (a[5] as number) * (a[3] as number) * (a[14] as number) +
    (a[13] as number) * (a[2] as number) * (a[7] as number) - (a[13] as number) * (a[3] as number) * (a[6] as number);
  inv[6] = -(a[0] as number) * (a[6] as number) * (a[15] as number) + (a[0] as number) * (a[7] as number) * (a[14] as number) +
    (a[4] as number) * (a[2] as number) * (a[15] as number) - (a[4] as number) * (a[3] as number) * (a[14] as number) -
    (a[12] as number) * (a[2] as number) * (a[7] as number) + (a[12] as number) * (a[3] as number) * (a[6] as number);
  inv[10] = (a[0] as number) * (a[5] as number) * (a[15] as number) - (a[0] as number) * (a[7] as number) * (a[13] as number) -
    (a[4] as number) * (a[1] as number) * (a[15] as number) + (a[4] as number) * (a[3] as number) * (a[13] as number) +
    (a[12] as number) * (a[1] as number) * (a[7] as number) - (a[12] as number) * (a[3] as number) * (a[5] as number);
  inv[14] = -(a[0] as number) * (a[5] as number) * (a[14] as number) + (a[0] as number) * (a[6] as number) * (a[13] as number) +
    (a[4] as number) * (a[1] as number) * (a[14] as number) - (a[4] as number) * (a[2] as number) * (a[13] as number) -
    (a[12] as number) * (a[1] as number) * (a[6] as number) + (a[12] as number) * (a[2] as number) * (a[5] as number);
  inv[3] = -(a[1] as number) * (a[6] as number) * (a[11] as number) + (a[1] as number) * (a[7] as number) * (a[10] as number) +
    (a[5] as number) * (a[2] as number) * (a[11] as number) - (a[5] as number) * (a[3] as number) * (a[10] as number) -
    (a[9] as number) * (a[2] as number) * (a[7] as number) + (a[9] as number) * (a[3] as number) * (a[6] as number);
  inv[7] = (a[0] as number) * (a[6] as number) * (a[11] as number) - (a[0] as number) * (a[7] as number) * (a[10] as number) -
    (a[4] as number) * (a[2] as number) * (a[11] as number) + (a[4] as number) * (a[3] as number) * (a[10] as number) +
    (a[8] as number) * (a[2] as number) * (a[7] as number) - (a[8] as number) * (a[3] as number) * (a[6] as number);
  inv[11] = -(a[0] as number) * (a[5] as number) * (a[11] as number) + (a[0] as number) * (a[7] as number) * (a[9] as number) +
    (a[4] as number) * (a[1] as number) * (a[11] as number) - (a[4] as number) * (a[3] as number) * (a[9] as number) -
    (a[8] as number) * (a[1] as number) * (a[7] as number) + (a[8] as number) * (a[3] as number) * (a[5] as number);
  inv[15] = (a[0] as number) * (a[5] as number) * (a[10] as number) - (a[0] as number) * (a[6] as number) * (a[9] as number) -
    (a[4] as number) * (a[1] as number) * (a[10] as number) + (a[4] as number) * (a[2] as number) * (a[9] as number) +
    (a[8] as number) * (a[1] as number) * (a[6] as number) - (a[8] as number) * (a[2] as number) * (a[5] as number);

  const det =
    (a[0] as number) * inv[0] + (a[1] as number) * inv[4] + (a[2] as number) * inv[8] + (a[3] as number) * inv[12];
  if (det === 0 || !Number.isFinite(det)) return null;
  for (let i = 0; i < 16; i++) inv[i] = (inv[i] as number) / det;
  return inv;
}

/**
 * The world-space position a modelview matrix maps to the origin (inverse of its rigid
 * transform). `null` when the matrix is singular.
 */
export function eyePositionFromModelview(modelview: Matrix4): Vec3 | null {
  const inv = invertMatrix(modelview);
  if (inv === null) return null;
  return vec3(inv[12] as number, inv[13] as number, inv[14] as number);
}

// ---------------------------------------------------------------------------
// projections
// ---------------------------------------------------------------------------

/**
 * `gluPerspective(fov, aspect, near, far)` — the only projection the model uses
 * (`gcamera::UsePerspective`, `gcamera.cc:121-126`).
 *
 * PORT-NOTE(W1e/glu-perspective): native GLU is the SGI route — `gluPerspective` builds a
 * **`GLfloat`** half-height/half-width pair (`ymax = f32(zNear·tan(fovy·π/360))`,
 * `xmin/xmax = ±ymax·aspect` likewise), hands *those* to `glFrustum`, whose entries are rounded
 * into a `GLfloat` matrix.
 *
 * PORT-NOTE(W1e/glu-perspective-reciprocal): the near-plane entries are `2·zNear` **times a
 * rounded f32 reciprocal** of the frustum width (`m00 = f32(f32(2·zNear) · f32(1/f32(xmax-xmin)))`),
 * not a division. Measured on this machine's Apple GLU 1.3 (offscreen legacy CGL context, the
 * same implementation the native build links), against 288 `(fov, aspect, near, far)` grid points
 * and the 13 recorded projections: the reciprocal form reproduces **52/52** recorded entry values
 * and **951/1152** grid entries; the plain division `f32(2·zNear/(xmax-xmin))` reproduces 49-50/52
 * and 808-835/1152. The reciprocal form is also the *only* one of the two that is insensitive to
 * the last bit of `zNear` — and native reaches GL with `fNear` promoted from the `float` the
 * camera stores, so that insensitivity is observable: with the f32 near, the division form misses
 * the recorded `gl.obj->vision_pitch_yaw.projection[0]` (`0x40124dfe` against the native
 * `0x40124dff`).
 *
 * PORT-NOTE(W1e/glFrustum-float-delta): the depth entries narrow the **numerators** to f32 and
 * divide by the *double* plane delta: `m22 = f32(f32(-(zFar+zNear))/(zFar-zNear))`,
 * `m32 = f32(f32((-2·zFar)·zNear)/(zFar-zNear))`. Also measured, on the same grid: this is
 * 52/52 recorded and 951/1152 grid, against 42/52 and 870/1152 for the form with a f32 plane
 * delta. (It is the *numerator* narrowing, not the delta, that the recorded
 * `gl.obj->world100_origin.projection[10] = 0xbf80045e` needs — the same one-ulp class the earlier
 * transcription recorded here; the earlier note is preserved in PARITY.md's history.)
 *
 * The degenerate case (`left == right`, `bottom == top`, non-positive planes) is GL's
 * `glFrustum` guard: it returns `GL_INVALID_VALUE` and **leaves the matrix untouched**. The port
 * has no stack, so it returns the identity — the state of a projection stack that `Use()` has
 * not written yet. `fAspect == 0` is the native `gcamera` default (`camera.ts`'s
 * `CAMERA_DEFAULT_ASPECT`) and reaches exactly this branch.
 */
export function perspectiveMatrix(fov: number, aspect: number, near: number, far: number): number[] {
  const ymax = f32(near * Math.tan((fov * Math.PI) / 360.0));
  const ymin = -ymax;
  const xmin = f32(ymin * aspect);
  const xmax = f32(ymax * aspect);

  if (xmin === xmax || ymin === ymax || near <= 0 || far <= 0) return identityMatrix();

  const width = f32(xmax - xmin);
  const height = f32(ymax - ymin);
  const p = new Array<number>(MATRIX_LENGTH).fill(0);
  p[0] = f32(f32(2 * near) * f32(1 / width));
  p[5] = f32(f32(2 * near) * f32(1 / height));
  p[8] = f32((xmax + xmin) / width);
  p[9] = f32((ymax + ymin) / height);
  const delta = far - near; // the double plane delta (the numerators are the f32 stores)
  p[10] = f32(f32(-(far + near)) / delta);
  p[11] = -1;
  p[14] = f32(f32(-2 * far * near) / delta);
  p[15] = 0;
  return p;
}

/**
 * `glFrustum(left, right, bottom, top, near, far)`.
 *
 * PORT-NOTE(W1e/glfrustum): no native call site in the model — `gcamera` only ever uses
 * `gluPerspective` — but it is the primitive `gluPerspective` is documented in terms of,
 * so it is ported once rather than re-derived per caller (L16 may want an off-centre
 * projection for the batched atlas).
 */
export function frustumMatrix(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): number[] {
  const m00 = f32((2 * f32(near)) / f32(right - left));
  const m11 = f32((2 * f32(near)) / f32(top - bottom));
  const m20 = f32((right + left) / f32(right - left));
  const m21 = f32((top + bottom) / f32(top - bottom));
  const m22 = f32(-(f32(far) + f32(near)) / f32(f32(far) - f32(near)));
  const m32 = f32(-(f32(2) * f32(far) * f32(near)) / f32(f32(far) - f32(near)));
  return [m00, 0, 0, 0, 0, m11, 0, 0, m20, m21, m22, -1, 0, 0, m32, 0];
}

/**
 * `gluOrtho2D(left, right, bottom, top)`. Native has no call site (the 2-D widget path is
 * Qt's, lane L18); provided so L18 does not hand-roll a projection.
 */
export function orthoMatrix(left: number, right: number, bottom: number, top: number): number[] {
  return [
    f32(2 / (right - left)),
    0,
    0,
    0,
    0,
    f32(2 / (top - bottom)),
    0,
    0,
    0,
    0,
    -1,
    0,
    f32(-(right + left) / (right - left)),
    f32(-(top + bottom) / (top - bottom)),
    0,
    1,
  ];
}

/**
 * `gluLookAt(eye, center, up)` — `gcamera::UseLookAt` (`gcamera.cc:239-253`).
 *
 * PORT-NOTE(W1e/lookat-up-vector): the native call passes `fAngle[0..2]` as the **up
 * vector**, i.e. a yaw/pitch/roll triple in degrees used as a direction. With the
 * `gcamera` defaults that is `(0,0,0)`, which makes the standard construction degenerate
 * (`|forward × up| = 0` → 0/0). Nothing in the model reaches this path — `fUsingLookAt`
 * only becomes true via `SetFixationPoint`, which has no call site in the tree — so the
 * port implements the standard formula and returns `null` for the degenerate case instead
 * of producing a NaN matrix.
 */
export function lookAtMatrix(eye: Vec3, center: Vec3, up: Vec3): number[] | null {
  const f = normalizeOrNull(vec3(center.x - eye.x, center.y - eye.y, center.z - eye.z));
  if (f === null) return null;
  const s = normalizeOrNull(vec3(f.y * up.z - f.z * up.y, f.z * up.x - f.x * up.z, f.x * up.y - f.y * up.x));
  if (s === null) return null;
  const u = vec3(s.y * f.z - s.z * f.y, s.z * f.x - s.x * f.z, s.x * f.y - s.y * f.x);
  return [
    s.x, u.x, -f.x, 0,
    s.y, u.y, -f.y, 0,
    s.z, u.z, -f.z, 0,
    0, 0, 0, 1,
  ].map((v, i) => (i % 4 === 3 && i < 12 ? v : f32(v))) as number[];
}

function normalizeOrNull(v: Vec3): Vec3 | null {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len === 0 || !Number.isFinite(len)) return null;
  return vec3(v.x / len, v.y / len, v.z / len);
}

// ---------------------------------------------------------------------------
// object / camera transforms (the native call sequences)
// ---------------------------------------------------------------------------

/**
 * `gobject::position()` followed by `glScalef(s,s,s)` — the transform `gpolyobj::draw`
 * (`gpolygon.cc:221-228`), `gpoly::draw` (`:104-118`) and `agent::draw`
 * (`agent.cc:1819-1831`) push before emitting vertices.
 *
 * Native order (GL post-multiplies, so it reads left to right):
 *   `glTranslatef(pos)` → `if (fRotated) glRotatef(yaw,y) glRotatef(pitch,x) glRotatef(roll,z)`
 *   → `glScalef(s,s,s)`.
 *
 * PORT-NOTE(W1e/object-rotated-flag): `gobject::rotate()` is a **no-op** unless
 * `SetRotation`/`setyaw`/`setpitch`/`setroll`/`add*` has set `fRotated` (`gobject.cc:266-274`).
 * `settranslation` does not. The port keeps that flag (`rotated`), so an object that never
 * had an angle set produces a pure translate·scale matrix — the goldens include both cases
 * (`obj.unrotated` vs `obj.rotated_zero_angles`, which are numerically identical).
 */
export function objectMatrix(
  position: Vec3,
  angles: Vec3,
  scale: number,
  rotated: boolean,
): number[] {
  const parts: number[][] = [translationMatrix(position.x, position.y, position.z)];
  if (rotated) {
    parts.push(rotationMatrix('y', angles.x), rotationMatrix('x', angles.y), rotationMatrix('z', angles.z));
  }
  parts.push(scaleMatrix(scale));
  return composeMatrix(...parts);
}

/**
 * `gcamera::Use()`'s modelview, minus the GL calls:
 *
 *   `glLoadIdentity(); glRotatef(-roll,z); glRotatef(-pitch,x); glRotatef(-yaw,y);
 *    glTranslatef(-camPos); [followObject.inverseposition()]`
 *
 * with `gobject::inverseposition() = inverserotate() then inversetranslate()`
 * (`gobject.cc:301-305`) = `glRotatef(-a2,z) glRotatef(-a1,x) glRotatef(-a0,y) glTranslatef(-pos)`.
 *
 * PORT-NOTE(W1e/camera-modelview): the composition is a straight transcription of the call
 * order, including the fact that the agent's own rotation is applied with the *roll* axis
 * first — that ordering is what makes the native camera local −Z the agent's forward
 * (`docs/specs/vision-spec.md` §5.4).
 */
export function cameraModelview(
  cameraPosition: Vec3,
  cameraAngles: Vec3,
  follow: { position: Vec3; angles: Vec3; rotated: boolean } | null,
): number[] {
  const parts: number[][] = [
    rotationMatrix('z', -cameraAngles.z),
    rotationMatrix('x', -cameraAngles.y),
    rotationMatrix('y', -cameraAngles.x),
    translationMatrix(-cameraPosition.x, -cameraPosition.y, -cameraPosition.z),
  ];
  if (follow !== null && follow.rotated) {
    parts.push(
      rotationMatrix('z', -follow.angles.z),
      rotationMatrix('x', -follow.angles.y),
      rotationMatrix('y', -follow.angles.x),
    );
  }
  if (follow !== null) {
    parts.push(translationMatrix(-follow.position.x, -follow.position.y, -follow.position.z));
  }
  return composeMatrix(...parts);
}

// ---------------------------------------------------------------------------
// planes (frustum extraction)
// ---------------------------------------------------------------------------

export const FRUSTUM_PLANE_NAMES = ['left', 'right', 'bottom', 'top', 'near', 'far'] as const;
export type FrustumPlaneName = (typeof FRUSTUM_PLANE_NAMES)[number];

/**
 * The six clipping planes of a clip-space matrix (`projection · modelview`), normalised so
 * `d` is a signed distance and a point is inside when `a·x + b·y + c·z + d >= 0`
 * (Gribb-Hartmann, in the native plane order left/right/bottom/top/near/far).
 *
 * PORT-NOTE(W1e/frustum-planes): the native code never builds GL-style planes — it culls
 * with `frustumXZ` (an XZ wedge) and the GPU clips the rest. The planes here are for the
 * lanes that must reason about the view volume in TS (L15 picking, L16 batching), and they
 * are validated two ways in the tests: against the planes the probe derived from GL's own
 * matrices, and against a direct clip-space classification of the same points.
 */
export function frustumPlanes(clip: Matrix4): Plane[] {
  // row i of a column-major matrix: elements m[i], m[i+4], m[i+8], m[i+12]
  const row = (i: number): number[] => [clip[i] as number, clip[i + 4] as number, clip[i + 8] as number, clip[i + 12] as number];
  const r3 = row(3);
  const combos: [number, number][] = [
    [0, 1],  // left   = row4 + row1
    [0, -1], // right  = row4 - row1
    [1, 1],  // bottom = row4 + row2
    [1, -1], // top    = row4 - row2
    [2, 1],  // near   = row4 + row3
    [2, -1], // far    = row4 - row3
  ];
  return combos.map(([r, sign]) => {
    const ri = row(r);
    const p = [0, 1, 2, 3].map((k) => (r3[k] as number) + sign * (ri[k] as number));
    const len = Math.sqrt((p[0] as number) ** 2 + (p[1] as number) ** 2 + (p[2] as number) ** 2);
    const inv = len > 0 ? 1 / len : 0;
    return Object.freeze({ a: (p[0] as number) * inv, b: (p[1] as number) * inv, c: (p[2] as number) * inv, d: (p[3] as number) * inv });
  });
}

/** Signed distance from a plane (`> 0` on the inside of a `frustumPlanes` plane). */
export { planeDistance };

/** A point is inside the frustum when no plane rejects it. */
export function pointInFrustum(planes: readonly Plane[], p: Vec3): boolean {
  return planes.every((pl) => planeDistance(pl, p) >= 0);
}

/** Conservative sphere test: outside as soon as one plane is farther than the radius. */
export function sphereInFrustum(planes: readonly Plane[], center: Vec3, radius: number): boolean {
  return planes.every((pl) => planeDistance(pl, center) >= -radius);
}

/** The eight corners of the view volume, for tests and debug draws. */
export function frustumCorners(planes: readonly Plane[]): Vec3[] {
  if (planes.length !== 6) return [];
  const [l, r, b, t, n, f] = planes as [Plane, Plane, Plane, Plane, Plane, Plane];
  const triples: [Plane, Plane, Plane][] = [
    [n, t, r], [n, t, l], [n, b, l], [n, b, r],
    [f, t, r], [f, t, l], [f, b, l], [f, b, r],
  ];
  const out: Vec3[] = [];
  for (const [p1, p2, p3] of triples) {
    const p = intersectThreePlanes(p1, p2, p3);
    if (p !== null) out.push(p);
  }
  return out;
}

function intersectThreePlanes(a: Plane, b: Plane, c: Plane): Vec3 | null {
  const det =
    a.a * (b.b * c.c - b.c * c.b) - a.b * (b.a * c.c - b.c * c.a) + a.c * (b.a * c.b - b.b * c.a);
  if (det === 0) return null;
  const x = (-a.d * (b.b * c.c - b.c * c.b) + a.b * (-b.d * c.c + c.d * b.c) - a.c * (-b.d * c.b + c.d * b.b)) / det;
  const y = (a.a * (-b.d * c.c + c.d * b.c) + a.d * (b.a * c.c - b.c * c.a) - a.c * (b.a * c.d - c.a * b.d)) / det;
  const z = (a.a * (b.b * c.d - c.b * b.d) - a.b * (b.a * c.d - c.a * b.d) + a.d * (b.a * c.b - b.b * c.a)) / det;
  return vec3(x, y, z);
}

/** Matrices equal to f32 precision, ignoring the sign of zero. */
export function matrixEquals(a: Matrix4, b: Matrix4, tolerance = 0): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (tolerance === 0) {
      if (!sameF32(x, y)) return false;
    } else if (!(Math.abs(x - y) <= tolerance)) {
      return false;
    }
  }
  return true;
}

/** Radians from degrees using the native `DEGTORAD` literal (see `float.ts`). */
export function nativeDegreesToRadians(degrees: number): number {
  return degrees * DEGTORAD;
}
