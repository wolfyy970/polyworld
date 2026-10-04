/**
 * Lane W1e — ray/sphere/plane helpers and bounds queries.
 *
 * PORT-NOTE(W1e/ray-helpers-are-new): **the native tree has no ray code** (no `ray` symbol
 * in `library/**` outside the word "array"; no intersection routine anywhere), and its only
 * spatial primitive besides `frustumXZ` is `gobject::fRadius` — the "sphere of influence"
 * used for carrying and contact radii. These helpers therefore do not reproduce a native
 * algorithm; they exist so the lanes that must reason in TS (L15 picking/framing, L16
 * batching, L14 monitor selection) do not each grow their own, and so the *native* radius
 * and plane semantics have exactly one implementation (`sphereFromRadius`,
 * `planeDistance`, `frustumXZ`). Anything that changes a model value must keep coming from
 * the ported code, not from here.
 *
 * Conventions: every function is f64 (`number`) maths over the frozen `Vec3`/`Sphere`/
 * `Plane` shapes, with no rounding, because no native code stores a float here.
 */

import type { Bounds, Plane, Sphere, Vec3 } from '../types/geometry';
import { boundsCenter } from './primitives';
import { add3, cross3, distance3, dot3, length3, normalize3, scale3, sub3, vec3 } from './vector';

/** A half-line: `origin + t * direction`, `t >= 0`, `direction` need not be unit length. */
export interface Ray {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

export function ray(origin: Vec3, direction: Vec3): Ray {
  return Object.freeze({ origin, direction });
}

/** The native sphere: `gobject::fRadius` around the object's position. */
export function sphereFromRadius(center: Vec3, radius: number): Sphere {
  return Object.freeze({ center, radius });
}

/** A sphere that encloses a bounding box (the radius a soup's bounds imply). */
export function sphereFromBounds(b: Bounds): Sphere {
  const center = boundsCenter(b);
  const half = vec3((b.max.x - b.min.x) / 2, (b.max.y - b.min.y) / 2, (b.max.z - b.min.z) / 2);
  return Object.freeze({ center, radius: length3(half) });
}

export function pointInSphere(p: Vec3, s: Sphere): boolean {
  return distance3(p, s.center) <= s.radius;
}

/** True when two native spheres overlap (centre distance ≤ r1 + r2), the contact test. */
export function spheresOverlap(a: Sphere, b: Sphere): boolean {
  return distance3(a.center, b.center) <= a.radius + b.radius;
}

/** Signed distance from a point to a plane (`> 0` on the side the normal points to). */
export function planeDistance(plane: Plane, p: Vec3): number {
  return plane.a * p.x + plane.b * p.y + plane.c * p.z + plane.d;
}

/** Plane through three points (normal = `(b-a) × (c-a)`, normalised); `null` if degenerate. */
export function planeFromPoints(a: Vec3, b: Vec3, c: Vec3): Plane | null {
  const n = normalize3(cross3(sub3(b, a), sub3(c, a)));
  if (n.x === 0 && n.y === 0 && n.z === 0) return null;
  const d = -dot3(n, a);
  return Object.freeze({ a: n.x, b: n.y, c: n.z, d });
}

/** Plane with a unit normal `n` through `p`. */
export function planeFromNormalPoint(n: Vec3, p: Vec3): Plane {
  const un = normalize3(n);
  return Object.freeze({ a: un.x, b: un.y, c: un.z, d: -dot3(un, p) });
}

/** Reflect a direction about a (unit) plane normal. */
export function reflectDirection(direction: Vec3, normal: Vec3): Vec3 {
  return sub3(direction, scale3(normal, 2 * dot3(direction, normal)));
}

/**
 * Ray/plane intersection distance (`null` when parallel). `t >= 0` means the plane is hit in
 * front of the origin.
 */
export function rayPlane(ray: Ray, plane: Plane): number | null {
  const denom = plane.a * ray.direction.x + plane.b * ray.direction.y + plane.c * ray.direction.z;
  if (denom === 0) return null;
  const t = -planeDistance(plane, ray.origin) / denom;
  return t;
}

/** Ray/sphere: the nearest non-negative hit distance, or `null`. */
export function raySphere(ray: Ray, sphere: Sphere): number | null {
  const oc = sub3(ray.origin, sphere.center);
  const a = dot3(ray.direction, ray.direction);
  if (a === 0) return null;
  const b = 2 * dot3(oc, ray.direction);
  const c = dot3(oc, oc) - sphere.radius * sphere.radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / (2 * a);
  const t1 = (-b + sq) / (2 * a);
  if (t0 >= 0) return t0;
  if (t1 >= 0) return t1;
  return null;
}

/** Closest point on the segment `a..b` to `p` (slab-free helper for L15 handles). */
export function closestPointOnSegment(a: Vec3, b: Vec3, p: Vec3): Vec3 {
  const ab = sub3(b, a);
  const denom = dot3(ab, ab);
  if (denom === 0) return a;
  let t = dot3(sub3(p, a), ab) / denom;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return add3(a, scale3(ab, t));
}

/** Distance from a point to a segment. */
export function distanceToSegment(a: Vec3, b: Vec3, p: Vec3): number {
  return distance3(p, closestPointOnSegment(a, b, p));
}

/**
 * Slab test: does the ray hit the axis-aligned box, and at what entry distance? Used to
 * reject whole objects before a per-vertex pass (L15/L16).
 */
export function rayBounds(rayIn: Ray, b: Bounds): number | null {
  let tmin = 0;
  let tmax = Number.POSITIVE_INFINITY;
  const o = rayIn.origin;
  const d = rayIn.direction;
  const mins = [b.min.x, b.min.y, b.min.z];
  const maxs = [b.max.x, b.max.y, b.max.z];
  const origin = [o.x, o.y, o.z];
  const dir = [d.x, d.y, d.z];
  for (let i = 0; i < 3; i++) {
    const di = dir[i] as number;
    const oi = origin[i] as number;
    const lo = mins[i] as number;
    const hi = maxs[i] as number;
    if (di === 0) {
      if (oi < lo || oi > hi) return null;
      continue;
    }
    let t1 = (lo - oi) / di;
    let t2 = (hi - oi) / di;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** Does a sphere overlap an axis-aligned box? (Cheap reject for the renderer's batching.) */
export function sphereIntersectsBounds(s: Sphere, b: Bounds): boolean {
  const dx = Math.max((b.min.x as number) - s.center.x, 0, s.center.x - (b.max.x as number));
  const dy = Math.max((b.min.y as number) - s.center.y, 0, s.center.y - (b.max.y as number));
  const dz = Math.max((b.min.z as number) - s.center.z, 0, s.center.z - (b.max.z as number));
  return dx * dx + dy * dy + dz * dz <= s.radius * s.radius;
}
