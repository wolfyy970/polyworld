/**
 * Lane W1e — the polygon objects `gpoint` / `gline` / `gpoly` / `gpolyobj`, as data.
 *
 * The native geometry classes are `gobject`s that keep a flat `float` vertex array and a
 * "radius of influence" derived from their bounding box; the model uses the *bounds and the
 * radius* (carrying, collision radius, `fLengthZ` for agents) far more than the vertices.
 * What this module ports is exactly that machinery — `gpolyobj::setlen` (`gpolygon.cc:271-295`)
 * and `setradius` (`:249-254`), plus the three `setradius*` overrides that decide whether the
 * radius is recomputed — and it keeps vertices as plain arrays so L15/L16 can hand them to a
 * renderer without a copy.
 *
 * PORT-NOTE(W1e/radius-machinery): the radius is `|bbox diagonal| * radiusScale * scale * 0.5`
 * and is only recomputed while `fRadiusFixed` is false; `setradius(r)` fixes it forever,
 * `setradiusscale(s)` and `setscale(s)` unfix it. The goldens pin all four states
 * (`polyobj.radius*`), including the order `setlen` → `setradius` (`gpolyobj::init` calls
 * `setlen` only when the object was built with geometry, `:257-266`).
 */

import type { Bounds, Sphere, Vec3 } from '../types/geometry';
import { f32Fma } from '../agent/numeric';
import { f32 } from './float';
import { max3, min3, vec3, vec3FromArray } from './vector';

// ---------------------------------------------------------------------------
// the radius rule — ONE definition for every radiused `gobject`
// ---------------------------------------------------------------------------

/**
 * The tail every radius derivation ends with, transcribed from the shipped binary:
 * `sqrt( sum ) * fRadiusScale * fScale * 0.5`. `fsqrt` is the `float` overload, the three
 * multiplies are `float × float` (`fmul`), and native materialises the source's `0.5` as a
 * float (`fmov s1, #0.50000000`), so the last `fmul` is `float × float` too.
 *
 * Every site that derives a radius of influence ends here — `gpoly` (`0x8498c` on),
 * `gpolyobj` (`0x84cb0` on), `gbox::setradius` (`0x87624` on), `agent::setradius`
 * (`0x21f4c`-`0x21f60`) and `food::setradius` (`0x5aa84` on). This is the port's one spelling
 * of it: the callers differ only in which square sum they feed it and in whether their own
 * `fRadiusFixed` latches, and both of those are per-class facts native keeps per class too.
 *
 * PORT-NOTE(W1e/radius-rule-is-one-function): `gbox`'s slice lives in lane L10's
 * `src/model/environment/object.ts`, which used to carry its own copy of this arithmetic and
 * now imports it (PARITY.md → Gaps: "one of the two re-exports the other"). Keep it that way —
 * a second copy of the tail is a second answer to `run/energy/**`'s radius columns.
 */
export function scaledRadius(squares: number, radiusScale: number, scale: number): number {
  const root = f32(Math.sqrt(squares)); // fsqrt — the `float` overload
  return f32(f32(f32(root * f32(radiusScale)) * f32(scale)) * 0.5);
}

/**
 * The contracted 3-D square sum as `gpoly::setradius` (`0x8497c`/`0x84980`/`0x84988`) and
 * `gpolyobj::setradius` (`0x84ca0`/`0x84ca4`/`0x84cac`) emit it: `f32( lx² + ly² + lz² )` with
 * **one** rounding of the sum (`fmul` on `ly²`, `fmadd` for the other two terms).
 */
export function contractedSquareSum(lx: number, ly: number, lz: number): number {
  return f32Fma(lz, lz, f32Fma(lx, lx, f32(ly * ly)));
}

/**
 * The x/z-only variant of the same contracted sum — `agent::setradius` (`0x21f44`/`0x21f48`)
 * and `food::setradius` (`0x5aa7c`/`0x5aa80`/`0x5aa84`) round `fLength[2]`'s square and keep
 * `fLength[0]`'s exact. `food`'s override is what makes a food box's radius the 2-D one.
 */
export function contractedSquareSumXZ(lx: number, lz: number): number {
  return f32Fma(lx, lx, f32(lz * lz));
}

/**
 * `gbox::setradius`'s **recorded** spelling of the 3-D sum — `f32( a*a + t )` rather than
 * `f32Fma`. The shipped site (`0x87624`/`0x87628`/`0x87630`) is the same `fmul`+`fmadd`+`fmadd`
 * sequence as `gpoly`'s, and the two forms were measured to differ on **0 of 200 000** samples
 * over the model's own ranges (round 2 of *the contraction sweep* in PARITY.md), so it stays as
 * recorded rather than being churned — the box rule is `boxRadius` below.
 */
export function recordedSquareSum(lx: number, ly: number, lz: number): number {
  const l0 = f32(lx);
  const l1 = f32(ly);
  const l2 = f32(lz);
  const t1 = f32(l1 * l1);
  const s1 = f32(l0 * l0 + t1);
  return f32(l2 * l2 + s1);
}

/**
 * Native `gbox::setradius()` (`gsquare.cc:230-235`) — the box rule `food` and `brick` derive
 * their radius of influence from: the 3-D diagonal over `fLength[]`, in the recorded
 * `f32( a*a + t )` spelling, scaled by `fRadiusScale`/`fScale`.
 */
export function boxRadius(length: readonly number[], radiusScale: number, scale: number): number {
  return scaledRadius(
    recordedSquareSum(length[0] ?? 0, length[1] ?? 0, length[2] ?? 0),
    radiusScale,
    scale,
  );
}

/** `opoly` — one polygon of a `gpolyobj` (`gpolygon.h:15-19`). */
export interface Polygon {
  readonly vertices: readonly number[];
}

/** A single polygon as its own object (`gpoly`, `gpolygon.h:21-58`). */
export class Poly {
  vertices: readonly number[];
  length: Vec3 = vec3(0, 0, 0);
  radius = 0;
  radiusScale = 1.0;
  radiusFixed = false;
  scale = 1.0;

  constructor(vertices: readonly number[] = []) {
    this.vertices = vertices.map(f32);
  }

  /** `gpoly::setlen` does not exist — a bare `gpoly` never derives bounds (`gpolygon.cc:131-135`). */
  setRadius(r: number): void {
    this.radiusFixed = true;
    this.radius = f32(r);
  }

  setRadiusScale(s: number): void {
    this.radiusFixed = false;
    this.radiusScale = f32(s);
    this.deriveRadius();
  }

  setScale(s: number): void {
    this.scale = f32(s);
    this.deriveRadius();
  }

  /**
   * `gpoly::setradius()` — `gpolygon.cc:81-86`.
   *
   * PORT-NOTE(W1e/radius-fma-contraction): the shipped `__ZN5gpoly9setradiusEv` **contracts**
   * the square sum into fused multiply-adds (clang `-O2`, `-ffp-contract=on`):
   *
   *   84978:  ldp    s0, s1, [x0, #0x98]  ; s0 = fLength[0], s1 = fLength[1]
   *   8497c:  fmul   s1, s1, s1           ; f32( y^2 ) — the ONLY rounded square
   *   84980:  fmadd  s0, s0, s0, s1       ; x^2 + that, ONE rounding
   *   84984:  ldp    s1, s2, [x0, #0xa0]  ; s1 = fLength[2], s2 = fRadiusScale
   *   84988:  fmadd  s0, s1, s1, s0       ; z^2 + that, ONE rounding
   *   8498c:  fsqrt  s0, s0               ; the `float` overload
   *   84990:  fmul   s0, s2, s0           ; * fRadiusScale
   *   84998:  fmul   s0, s1, s0           ; * fScale
   *   8499c:  fmov   s1, #0.50000000      ; the source's `* 0.5`, materialised as a float
   *   849a0:  fmul   s0, s0, s1           ; * 0.5f
   *
   * `gpolyobj::setradius()` is the same sequence at `0x84c9c`-`0x84cc8`. The pre-sweep port
   * rounded **all three** products, which is the unfused source semantics: over `(x, y, z)`
   * uniform in `[0.01, 100]` the sum differs on 45 244 of 200 000 samples (22.6 %) and the
   * derived radius on 23 626 of them (11.8 %; the recorded size range `[0.05, 2]`: 22.4 % /
   * 10.9 %). `PolyObj` is live (`body.ts`'s `agentBodyTemplate()` / `cloneGeometry`), and
   * `AgentBodyGeometry.deriveRadius` is the live agent-body path, so this decided a real
   * radius. Pinned with exact-rational constants in `tests/fma-contraction-sweep.test.ts`
   * (which drives this class and `AgentBodyGeometry` live). `gbox::setradius` (`0x87624`/
   * `0x87628`/`0x87630`) is the same sequence; its slice writes it in the measured-equivalent
   * `f32(a*a + t)` form — re-measured: 0 of 200 000 differ from `f32Fma` over these ranges, so
   * it stays as recorded (`recordedSquareSum`/`boxRadius` above; see *the contraction sweep* in
   * PARITY.md). The tail itself is `scaledRadius` above, shared by every one of these sites.
   */
  deriveRadius(): void {
    if (!this.radiusFixed) {
      const { x, y, z } = this.length;
      this.radius = scaledRadius(contractedSquareSum(x, y, z), this.radiusScale, this.scale);
    }
  }
}

/** A polygon soup (`gpolyobj`, `gpolygon.h:70-108`) — what `etc/objects/*.obj` loads into. */
export class PolyObj {
  polygons: readonly Polygon[];
  numPolygons: number;
  length: Vec3 = vec3(0, 0, 0);
  radius = 0;
  radiusScale = 1.0;
  radiusFixed = false;
  scale = 1.0;

  /**
   * Build from polygons; `setlen()` runs when there is geometry, as `gpolyobj::init` does
   * (`gpolygon.cc:264-265`).
   */
  constructor(polygons: readonly Polygon[] = []) {
    this.polygons = polygons.map((p) => Object.freeze({ vertices: p.vertices.map(f32) }));
    this.numPolygons = this.polygons.length;
    if (this.numPolygons > 0) this.setLen();
  }

  /**
   * `gpolyobj::setlen()` (`gpolygon.cc:271-295`): the axis-aligned bounding box over every
   * vertex of every polygon, then `setradius()`.
   *
   * The native comparison is `xmin = xmin < v ? xmin : v` — i.e. a *strict* less-than, so
   * ties keep the earlier value; with `min`/`max` the result is the same value either way.
   */
  setLen(): void {
    const first = this.polygons[0];
    if (first === undefined) return;
    const v0 = first.vertices;
    let xmin = (v0[0] ?? 0) as number;
    let xmax = xmin;
    let ymin = (v0[1] ?? 0) as number;
    let ymax = ymin;
    let zmin = (v0[2] ?? 0) as number;
    let zmax = zmin;
    for (const poly of this.polygons) {
      for (let j = 0; j < poly.vertices.length / 3; j++) {
        const v = vec3FromArray(poly.vertices, j * 3);
        xmin = Math.min(xmin, v.x);
        xmax = Math.max(xmax, v.x);
        ymin = Math.min(ymin, v.y);
        ymax = Math.max(ymax, v.y);
        zmin = Math.min(zmin, v.z);
        zmax = Math.max(zmax, v.z);
      }
    }
    this.length = vec3(f32(xmax - xmin), f32(ymax - ymin), f32(zmax - zmin));
    this.deriveRadius();
  }

  /**
   * `gpolyobj::setradius()` — `gpolygon.cc:249-254`.
   *
   * Same contracted square sum as `Poly.deriveRadius` (PORT-NOTE
   * `W1e/radius-fma-contraction` above): `0x84ca0 fmul s1, s1, s1` rounds the **second**
   * square only, `0x84ca4`/`0x84cac fmadd` keep the first and third exact. `agent::setradius`
   * overrides this with the 2-D (`x`/`z`) rule — lane L8 owns that one.
   */
  deriveRadius(): void {
    if (!this.radiusFixed) {
      const { x, y, z } = this.length;
      this.radius = scaledRadius(contractedSquareSum(x, y, z), this.radiusScale, this.scale);
    }
  }

  setRadius(r: number): void {
    this.radiusFixed = true;
    this.radius = f32(r);
  }

  setRadiusScale(s: number): void {
    this.radiusFixed = false;
    this.radiusScale = f32(s);
    this.deriveRadius();
  }

  setScale(s: number): void {
    this.scale = f32(s);
    this.deriveRadius();
  }

  /** `gpolyobj::clonegeom` (`gpolygon.cc:177-200`): copy the vertex data into a new soup. */
  cloneGeometry(): PolyObj {
    return new PolyObj(this.polygons.map((p) => ({ vertices: p.vertices.slice() })));
  }
}

// ---------------------------------------------------------------------------
// points, lines and bounds
// ---------------------------------------------------------------------------

/** `gpoint` (`gpoint.h:12-23`) — a `gobject` with nothing but a position. */
export interface Point3Object {
  readonly position: Vec3;
  readonly radius: number;
}

/** `gline` (`gline.h:10-30`): the beginning is the object's position, `fEnd` the end. */
export interface LineObject {
  readonly begin: Vec3;
  readonly end: Vec3;
  readonly radius: number;
}

/** Axis-aligned bounds from a vertex soup (what `gpolyobj::setlen` computes). */
export function boundsOfPolygons(polygons: readonly Polygon[]): Bounds | null {
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  for (const poly of polygons) {
    for (let j = 0; j < poly.vertices.length / 3; j++) {
      const v = vec3FromArray(poly.vertices, j * 3);
      min = min === null ? v : min3(min, v);
      max = max === null ? v : max3(max, v);
    }
  }
  return min === null || max === null ? null : Object.freeze({ min, max });
}

/** `gpolyobj::setlen`'s `fLength[]`, from bounds. */
export function lengthOfBounds(b: Bounds): Vec3 {
  return vec3(f32(b.max.x - b.min.x), f32(b.max.y - b.min.y), f32(b.max.z - b.min.z));
}

/** The sphere a `gpolyobj` radius defines (`gobject::fRadius`, "sphere of influence"). */
export function boundsSphere(polyobj: PolyObj, center = vec3(0, 0, 0)): Sphere {
  return { center, radius: polyobj.radius };
}

/** Bounds of a whole scene's objects, in list order (used by the tests and by L15 framing). */
export function unionBounds(all: readonly Bounds[]): Bounds | null {
  if (all.length === 0) return null;
  let min = all[0]?.min as Vec3;
  let max = all[0]?.max as Vec3;
  for (const b of all) {
    min = min3(min, b.min);
    max = max3(max, b.max);
  }
  return Object.freeze({ min, max });
}

/** Centre of bounds. */
export function boundsCenter(b: Bounds): Vec3 {
  return vec3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
}

/** The eight corners of a bounding box — the point set the frustum tests sweep. */
export function boundsCorners(b: Bounds): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.min.x, b.max.x]) {
    for (const y of [b.min.y, b.max.y]) {
      for (const z of [b.min.z, b.max.z]) out.push(vec3(x, y, z));
    }
  }
  return out;
}
