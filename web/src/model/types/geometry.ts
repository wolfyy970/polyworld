/**
 * Lane W1a — the shared geometry primitives (data shapes only).
 *
 * Native geometry lives in `src/library/graphics/` (`gpoint`, `gline`, `gpolygon`,
 * `gcamera`, `gstage`, `gobject`) and stores raw `float` arrays inside OpenGL-shaped
 * objects. The port separates data from rendering: lane W1e (`src/model/geometry/`) owns
 * the faithful port + maths (camera/frustum numbers reproduced from a fixed scene config)
 * and lane L15/L16 own the scene and the rasterizer.
 *
 * What is frozen *here* is the boundary shape lanes hand to each other — a lane must not
 * invent a third vector type to talk to the renderer.
 *
 * PORT-NOTE(types/geometry-boundary): these interfaces are the lane-boundary shape, not a
 * claim about native internals (native carries `xa/ya/za` components on a `gobject`).
 * Components are f64 in the port; native `float` storage is `Math.fround`ed where the
 * native code stores one (see PORT_SPEC ground rule 3).
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Vec4 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/** Native colours are 3 or 4 `float` components (0..1), e.g. `food::gFoodColor`. */
export interface Color {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Color4 extends Color {
  readonly a: number;
}

/** 16 numbers (4x4). Column/row-major choice belongs to W1e and must match native GL. */
export type Matrix4 = readonly number[];

/** Plane equation `a*x + b*y + c*z + d = 0` (native frustum planes). */
export interface Plane {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

/** The 6 planes of the view frustum, in native order. */
export interface Frustum {
  readonly planes: readonly Plane[];
}

/** Camera parameters as the native `gcamera` holds them (`yaw`/`pitch`/`roll`). */
export interface CameraParams {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  readonly fov: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
}

/** Axis-aligned bounding box (native `gobject` extents). */
export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** A sphere: native agent/food/brick radius plus centre. */
export interface Sphere {
  readonly center: Vec3;
  readonly radius: number;
}
