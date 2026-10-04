/**
 * Lane W1e — 2D/3D/4D vector and colour maths.
 *
 * The native graphics code has no vector class: `gobject` carries three loose `float`s
 * (`fPosition[3]`, `fAngle[3]`), `gline` keeps `fEnd[3]`, `gpoly` keeps a flat
 * `fVertices[np*3]`, and colours are a 4-`float` array (`fColor[4]`). What the port needs
 * from those is arithmetic, so this module gives the *shapes* `src/model/types/geometry.ts`
 * froze (`Vec2`/`Vec3`/`Vec4`/`Color`/`Color4`) a set of operations.
 *
 * PORT-NOTE(W1e/vector-ops): every helper is `double` in, `double` out — a value is only
 * rounded to f32 where the native code would store one (a `float` member or a GL call
 * argument). Callers that feed the matrix builders apply `f32` themselves, which is where
 * the native rounding actually happens. The helpers are also the *only* place the port
 * does vector maths: lanes L15/L16 must import these rather than invent their own
 * (types/geometry.ts PORT-NOTE: one shape or none).
 */

import type { Color, Color4, Vec2, Vec3, Vec4 } from '../types/geometry';
import { f32 } from './float';

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

export function vec2(x: number, y: number): Vec2 {
  return Object.freeze({ x, y });
}

export function vec3(x: number, y: number, z: number): Vec3 {
  return Object.freeze({ x, y, z });
}

export function vec4(x: number, y: number, z: number, w: number): Vec4 {
  return Object.freeze({ x, y, z, w });
}

export function color(r: number, g: number, b: number): Color {
  return Object.freeze({ r, g, b });
}

export function color4(r: number, g: number, b: number, a: number): Color4 {
  return Object.freeze({ r, g, b, a });
}

/** The native default object colour is `rand()/32767.0` per channel (`gobject.cc:45-47`). */
export function colorFromRand(rand: () => number): Color {
  return color(rand() / 32767.0, rand() / 32767.0, rand() / 32767.0);
}

// ---------------------------------------------------------------------------
// conversions between the frozen shapes
// ---------------------------------------------------------------------------

export function asVec3(v: { x: number; y: number; z: number }): Vec3 {
  return vec3(v.x, v.y, v.z);
}

export function vec3FromArray(a: readonly number[], offset = 0): Vec3 {
  return vec3(a[offset] ?? 0, a[offset + 1] ?? 0, a[offset + 2] ?? 0);
}

export function vec3ToArray(v: Vec3, out: number[] = [], offset = 0): number[] {
  out[offset] = v.x;
  out[offset + 1] = v.y;
  out[offset + 2] = v.z;
  return out;
}

export function color3ToArray(c: Color, out: number[] = [], offset = 0): number[] {
  out[offset] = c.r;
  out[offset + 1] = c.g;
  out[offset + 2] = c.b;
  return out;
}

/** The native `float* fColor` handed to `glColor3fv` (gobject) or `glColor4fv`. */
export function color4ToArray(c: Color4, out: number[] = [], offset = 0): number[] {
  out[offset] = c.r;
  out[offset + 1] = c.g;
  out[offset + 2] = c.b;
  out[offset + 3] = c.a;
  return out;
}

// ---------------------------------------------------------------------------
// arithmetic
// ---------------------------------------------------------------------------

export const add3 = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub3 = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
export const negate3 = (a: Vec3): Vec3 => vec3(-a.x, -a.y, -a.z);
export const scale3 = (a: Vec3, s: number): Vec3 => vec3(a.x * s, a.y * s, a.z * s);
export const mul3 = (a: Vec3, b: Vec3): Vec3 => vec3(a.x * b.x, a.y * b.y, a.z * b.z);
export const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross3 = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const lengthSquared3 = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const length3 = (a: Vec3): number => Math.sqrt(lengthSquared3(a));
export const distance3 = (a: Vec3, b: Vec3): number => length3(sub3(a, b));

/** Unit vector; the zero vector keeps its zero (no NaN) and `axis` chooses the fallback. */
export function normalize3(a: Vec3, fallback: Vec3 = vec3(0, 0, 0)): Vec3 {
  const len = length3(a);
  if (len === 0) return fallback;
  return vec3(a.x / len, a.y / len, a.z / len);
}

/** Linear interpolation, `t` unclamped: `a + (b-a)*t` (native `interp` shape). */
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 =>
  vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

/** Component-wise min/max, as used by `gpolyobj::setlen`'s running bounds. */
export const min3 = (a: Vec3, b: Vec3): Vec3 => vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
export const max3 = (a: Vec3, b: Vec3): Vec3 => vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));

/** The whole array rounded to f32 — what a `float vertices[]` actually holds. */
export function f32Vec3(v: Vec3): Vec3 {
  return vec3(f32(v.x), f32(v.y), f32(v.z));
}

// ---------------------------------------------------------------------------
// colours
// ---------------------------------------------------------------------------

/**
 * `round(255*clamp(c, 0, 1))` — the framebuffer byte a colour becomes.
 *
 * PORT-NOTE(W1e/colour-quantization): this is the quantization the retina readback sees
 * (`docs/specs/vision-spec.md` §3, §11.4: the golden's `0.34902` is byte 89 = 0x59). The
 * native code never computes it — GL does, on write to the RGBA8 attachment — so it is a
 * *derived* rule, not a ported one; it lives here because both the retina lane (L16) and
 * any colour comparison need exactly one copy of it.
 */
export function colorToByte(c: number): number {
  const clamped = c < 0 ? 0 : c > 1 ? 1 : c;
  return Math.round(255 * clamped);
}

/** The three bytes `glReadPixels` would return for a colour. */
export function colorToBytes(c: Color): { r: number; g: number; b: number } {
  return { r: colorToByte(c.r), g: colorToByte(c.g), b: colorToByte(c.b) };
}
