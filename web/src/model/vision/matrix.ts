/**
 * Lane W1j/L16 — the **f32 storage adapter** over lane L15's GL matrix primitives.
 *
 * PORT-NOTE(vision/gl-matrix-adapter): this file used to carry its own copy of the fixed-function
 * matrix maths (`identity`/`multiply`/`translate`/`rotatef`/`scalef`/`perspective` over
 * `Float32Array`). That copy is gone — it was the second `gcamera` PARITY.md's *Open questions* 6
 * flagged, and it was measured to be the same maths in some places and a *different* one in
 * others (see `PARITY.md` → *Open questions* 6 for the numbers). The single definition now lives
 * in `src/model/geometry/matrix.ts` (lane L15/W1e, the native owner of `gcamera`/GL), and every
 * function here is a lossless conversion between the `number[]` that module speaks and the
 * `Float32Array` this lane's WebGL2 raster wants for a uniform upload. Nothing in this file
 * performs arithmetic on a matrix entry: the converter only copies, and every value geometry
 * hands over is already an f32 (`src/model/geometry/float.ts` `f32`). `tests/vision-camera.test.ts`
 * replays the native `glGetFloatv` fixtures through *these* names and asserts the images of the
 * single definition, so the adapter cannot drift from it without the goldens noticing.
 *
 * Native source of the maths: `graphics/gobject.{h,cc}` (`translate`/`rotate`/`inverserotate`),
 * `graphics/gcamera.cc` (`Use`, `UsePerspective`, `SetAspect`), `graphics/gpolyobj.cc`
 * (`draw` → `position()`, `glScalef`), plus the GL 2.1 entry points they call
 * (`glLoadIdentity`, `glRotatef`, `glTranslatef`, `glScalef`, `glPushMatrix`, `glPopMatrix`,
 * `gluPerspective`).
 *
 * PORT-NOTE(vision/gl-matrix-f32): GL's fixed-function matrix stack is f32, so the entry points
 * are typed `Float32Array` here; that is a *storage* choice of this lane's renderer, and the
 * values are L15's. The `mvp`/uniform upload path relies on it (`raster.ts`,
 * `povRaster.ts`, `native/atlas-probe.ts`).
 */

import type { Matrix4 } from '../types/geometry';
import {
  identityMatrix,
  matrixEquals as geometryMatrixEquals,
  multiplyMatrix,
  perspectiveMatrix,
  rotationMatrix,
  scalefMatrix,
  translationMatrix,
} from '../geometry/matrix';

/** Column-major 4×4 matrix, GL order (`m[col*4 + row]`). */
export type Mat4 = Float32Array;

function toNumbers(m: ArrayLike<number>): number[] {
  const out = new Array<number>(16);
  for (let i = 0; i < 16; i++) out[i] = m[i] as number;
  return out;
}

function into(out: Mat4, m: Matrix4): Mat4 {
  for (let i = 0; i < 16; i++) out[i] = m[i] as number;
  return out;
}

export function identity(out: Mat4 = new Float32Array(16)): Mat4 {
  return into(out, identityMatrix());
}

export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  return into(out, multiplyMatrix(toNumbers(a), toNumbers(b)));
}

/**
 * `glTranslatef(x, y, z)`: `m = m · T`, the translation post-multiplied (`gobject::translate`).
 * The rounding is `geometry/matrix.ts`'s `multiplyMatrix`.
 */
export function translate(m: Mat4, x: number, y: number, z: number): Mat4 {
  return multiply(m, m, into(new Float32Array(16), translationMatrix(x, y, z)));
}

/**
 * `glRotatef(degrees, x, y, z)`: `m = m · R`.
 *
 * PORT-NOTE(vision/rotatef-axis-only): the model only ever rotates about one of the three axes
 * (`gcamera::Use`'s roll/pitch/yaw, `gobject::rotate`'s yaw/pitch/roll, the object poses in
 * `povScan.ts`), and L15's definition is the three axis builders the native goldens pin
 * bit-for-bit. A general axis vector is therefore **refused loudly** rather than silently
 * forking the maths — this lane's convention is to fail rather than render wrongly.
 */
export function rotatef(m: Mat4, degrees: number, x: number, y: number, z: number): Mat4 {
  const axis = x === 1 && y === 0 && z === 0 ? 'x' : y === 1 && x === 0 && z === 0 ? 'y' : z === 1 && x === 0 && y === 0 ? 'z' : null;
  if (axis === null) {
    throw new Error(
      `vision/matrix.rotatef(): glRotatef is only defined for the three axis rotations the model ` +
        `uses, got (${x}, ${y}, ${z}) — see PORT-NOTE(vision/rotatef-axis-only)`,
    );
  }
  return multiply(m, m, into(new Float32Array(16), rotationMatrix(axis, degrees)));
}

/** `glScalef(sx, sy, sz)`: `m = m · S`. */
export function scalef(m: Mat4, sx: number, sy: number, sz: number): Mat4 {
  return multiply(m, m, into(new Float32Array(16), scalefMatrix(sx, sy, sz)));
}

/**
 * `gluPerspective(fovy, aspect, zNear, zFar)` composed onto `out` — the form
 * `gcamera::UsePerspective()` produces from an identity projection.
 */
export function perspective(out: Mat4, fovy: number, aspect: number, zNear: number, zFar: number): Mat4 {
  return into(out, multiplyMatrix(toNumbers(out), perspectiveMatrix(fovy, aspect, zNear, zFar)));
}

/** Compare two matrices allowing `+0`/`-0` to differ (`geometry/matrix.ts`'s rule). */
export function matrixEquals(a: readonly number[], b: readonly number[]): boolean {
  return geometryMatrixEquals(toNumbers(a), toNumbers(b));
}
