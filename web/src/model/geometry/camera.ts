/**
 * Lane W1e — `gcamera`, as data.
 *
 * The native camera is a `gobject` subclass that owns four numbers (`fFOV`, `fAspect`,
 * `fNear`, `fFar`), a pose (`fPosition`, `fAngle`) and a follow object it inverts, and whose
 * `Use()` / `UsePerspective()` are nothing but GL calls (`gcamera.cc:121-126`, `:271-294`).
 * The port keeps the numbers and the *decisions* (is the perspective fixed? is LookAt in
 * use? is fog on?) and returns matrices instead of issuing calls; the drawing side is L15/L16.
 *
 * PORT-NOTE(W1e/camera-defaults): the native defaults are FOV 90, aspect 0, near 1e-5,
 * far 10000 (`gcamera.cc:25-28`, `:58-80`). They are reproduced verbatim, including the
 * degenerate aspect 0 — the *scene* camera (`gscene::MakeCamera`) starts there and only gets
 * real values from `FixPerspective`/`SetAspect`. Nothing in the port may "repair" it.
 */

import type { Frustum, Matrix4, Plane, Vec3 } from '../types/geometry';
import { f32 } from './float';
import { FRUSTUM_PLANE_NAMES, cameraModelview, frustumPlanes, invertMatrix, multiplyMatrix, perspectiveMatrix } from './matrix';
import { vec3 } from './vector';

/** `gcamera.cc` internal defaults. */
export const CAMERA_DEFAULT_FOV = 90.0;
export const CAMERA_DEFAULT_ASPECT = 0.0;
export const CAMERA_DEFAULT_NEAR = 0.00001;
export const CAMERA_DEFAULT_FAR = 10000.0;

/** The pose the camera is attached to (`gobject`), reduced to what the math reads. */
export interface CameraFollowObject {
  position: Vec3;
  angles: Vec3;
  rotated: boolean;
}

/**
 * `glFogFunction` / `glExpFogDensity` / `glLinearFogEnd` from the simulation, as
 * `gcamera::SetFog` consumes them (`gcamera.cc:331-363`).
 */
export interface CameraFog {
  readonly enabled: boolean;
  /** 'L' linear, 'E' exponential, 'O' off — the native `glFogFunction()` char. */
  readonly function: 'L' | 'E' | 'O';
  readonly density: number;
  readonly linearEnd: number;
}

/** A named frustum plane (`types/geometry.ts`'s `Plane`, in the native order). */
export interface NamedPlane extends Plane {
  readonly name: (typeof FRUSTUM_PLANE_NAMES)[number];
}

/** The two matrices a camera contributes, plus what can be derived from them. */
export interface CameraView {
  readonly projection: Matrix4;
  readonly modelview: Matrix4;
  /** `projection · modelview`, i.e. the clip matrix of the pair. */
  readonly clip: Matrix4;
  /** World-space clipping planes, native order (left, right, bottom, top, near, far). */
  readonly frustum: Frustum;
  /** World-space eye position: what the modelview maps to the origin (`null` if singular). */
  readonly eyeWorld: Vec3 | null;
}

export class Camera {
  fov: number = CAMERA_DEFAULT_FOV;
  aspect: number = CAMERA_DEFAULT_ASPECT;
  near: number = CAMERA_DEFAULT_NEAR;
  far: number = CAMERA_DEFAULT_FAR;

  /** Camera-local pose, i.e. relative to the follow object (`fPosition`, `fAngle`). */
  position: Vec3 = vec3(0, 0, 0);
  /** `(yaw, pitch, roll)` in degrees — `fAngle[0..2]`. */
  angles: Vec3 = vec3(0, 0, 0);

  followObject: CameraFollowObject | null = null;
  fixationPoint: Vec3 = vec3(0, 0, 0);
  usingLookAt = false;
  perspectiveFixed = false;
  perspectiveInUse = false;
  fog: CameraFog = { enabled: false, function: 'O', density: 0, linearEnd: 0 };

  /** The projection GL currently holds: identity until the first `usePerspective()`. */
  private stackProjection: Matrix4 = identityCopy();

  // --- the native mutators -------------------------------------------------

  setFOV(fov: number): void {
    this.fov = f32(fov);
  }

  getFOV(): number {
    return this.fov;
  }

  setNear(n: number): void {
    this.near = f32(n);
  }

  setFar(f: number): void {
    this.far = f32(f);
  }

  /** `SetAspect(float a)` — stores `a` as written (`fAspect` is a `float`). */
  setAspect(a: number): void {
    this.aspect = f32(a);
  }

  /** `SetAspect(float width, float height)` — `fAspect = float(width)/float(height)`. */
  setAspectPair(width: number, height: number): void {
    this.aspect = f32(f32(width) / f32(height));
  }

  setPerspective(fov: number, aspect: number, near: number, far: number): void {
    this.setFOV(fov);
    this.setAspect(aspect);
    this.setNear(near);
    this.setFar(far);
  }

  /** `Perspective()`: set the four values and apply the projection. */
  perspective(fov: number, aspect: number, near: number, far: number): Matrix4 {
    this.setPerspective(fov, aspect, near, far);
    return this.usePerspective();
  }

  setTranslation(x: number, y: number, z: number): void {
    this.position = vec3(f32(x), f32(y), f32(z));
  }

  /** `gobject::setyaw` — before `use()`, this only affects the modelview (and `fRotated`). */
  setYaw(degrees: number): void {
    this.angles = vec3(f32(degrees), this.angles.y, this.angles.z);
  }

  setPitch(degrees: number): void {
    this.angles = vec3(this.angles.x, f32(degrees), this.angles.z);
  }

  setRoll(degrees: number): void {
    this.angles = vec3(this.angles.x, this.angles.y, f32(degrees));
  }

  attachTo(object: CameraFollowObject | null): void {
    this.followObject = object;
  }

  setFixationPoint(p: Vec3): void {
    this.fixationPoint = vec3(f32(p.x), f32(p.y), f32(p.z));
    this.usingLookAt = true;
  }

  /**
   * `SetFog(bool fog, char function, float density, int end)`.
   *
   * PORT-NOTE(W1e/fog-data-only): native turns fog into GL state
   * (`glEnable(GL_FOG)` / `glFogi(GL_FOG_MODE, GL_LINEAR)` / `glFogf(GL_FOG_START, fNear)` /
   * `glFogf(GL_FOG_END, end)`, or `GL_EXP` + density — `gcamera.cc:331-363`). The port keeps
   * the *parameters*; a renderer (L16) applies them. The native never turns fog off again
   * and never calls `SetFog` with `function == 'O'` (the agent path skips the call unless
   * `glFogFunction() != 'O'`, `agent.cc:1030-1031`), so `'O'` here means "leave the
   * renderer's fog alone".
   */
  setFog(enabled: boolean, func: 'L' | 'E' | 'O', density: number, end: number): void {
    this.fog = { enabled, function: func, density: f32(density), linearEnd: end };
  }

  // --- projection ----------------------------------------------------------

  /**
   * `UsePerspective()`: latch `fPerspectiveInUse` and build `gluPerspective(fFOV, fAspect,
   * fNear, fFar)`. `fAspect == 0` (the native default) makes the near-plane frustum extents
   * collapse (`xmin == xmax`), which is GL's `glFrustum` guard: the matrix is left untouched, so
   * a projection stack nothing has written yet stays the identity.
   */
  usePerspective(): Matrix4 {
    this.perspectiveInUse = true;
    const m = perspectiveMatrix(this.fov, this.aspect, this.near, this.far);
    this.stackProjection = m;
    return m;
  }

  /** `UpdatePerspective()`: apply only when the perspective is not fixed. */
  updatePerspective(): Matrix4 | null {
    if (this.perspectiveFixed) return null;
    return this.usePerspective();
  }

  /**
   * `FixPerspective(bool fixed, float width, float height)`: set the aspect from a pixel
   * size and, if `fixed`, latch the projection — this is what the widget cameras do
   * (`gcamera.cc:191-199`).
   */
  fixPerspective(fixed: boolean, width: number, height: number): void {
    this.setAspectPair(width, height);
    if (fixed) this.usePerspective();
    this.perspectiveFixed = fixed;
  }

  // --- modelview -----------------------------------------------------------

  /**
   * The modelview matrix `gcamera::Use()` would leave on the stack. The LookAt path has no
   * call site in the model, so it is reported as the identity plus `usingLookAt`, rather
   * than invented (see `matrix.ts`'s `lookAtMatrix` PORT-NOTE).
   */
  useModelview(): Matrix4 {
    if (this.usingLookAt) return identityCopy();
    return cameraModelview(this.position, this.angles, this.followObject);
  }

  /** `Use()`: the projection (unless fixed) followed by the modelview. */
  use(): CameraView {
    // UpdatePerspective() leaves the stack's projection alone when fPerspectiveFixed, so the
    // port returns whatever is on the stack (identity until something applied a projection)
    return this.viewFrom(this.updatePerspective() ?? this.stackProjection);
  }

  /**
   * The two matrices for the *current* parameters, without touching the projection latch
   * (`fPerspectiveInUse`) or the fixed-perspective rule. This is the convenience the
   * GPU-side lanes want; `use()` is the faithful re-enactment of `gcamera::Use()`.
   */
  view(): CameraView {
    return this.viewFrom(perspectiveMatrix(this.fov, this.aspect, this.near, this.far));
  }

  private viewFrom(projection: Matrix4): CameraView {
    const modelview = this.useModelview();
    const clip = multiplyMatrix(projection, modelview);
    const planes: NamedPlane[] = frustumPlanes(clip).map((p, i) =>
      Object.freeze({ a: p.a, b: p.b, c: p.c, d: p.d, name: FRUSTUM_PLANE_NAMES[i] as NamedPlane['name'] }),
    );
    const inv = invertMatrix(modelview);
    return Object.freeze({
      projection,
      modelview,
      clip,
      frustum: Object.freeze({ planes: Object.freeze(planes) }),
      eyeWorld: inv === null ? null : vec3(inv[12] as number, inv[13] as number, inv[14] as number),
    });
  }

  // --- agent POV configuration (agent::SetGraphics / agent::UpdateVision) ---

  /**
   * `agent::FieldOfView()` (`agent.cc:1899-1904`, duplicated at `:1070-1072`), with the
   * `InvertFocus` branch: `focus * (minFocus - maxFocus) + maxFocus`.
   */
  static horizontalFovForFocus(focus: number, minFocus: number, maxFocus: number, invertFocus: boolean): number {
    // PORT-NOTE(geometry/fov-double-fma): the shipped `agent::FieldOfView` (`0x261d0`)
    // and `agent::UpdateVision`'s `fovx` (`0x26260`) fuse this multiply-add in
    // **double**, not in float:
    //
    //   26254:  fsub  s2, s2, s1     ; the two bounds are floats: their difference is a float
    //   26258:  fcvt  d2, s2         ; ... promoted to binary64
    //   2625c:  fcvt  d1, s1
    //   26260:  fmadd d0, d0, d2, d1 ; ONE rounding, in binary64
    //   26264:  fcvt  s8, d0         ; `const float fovx = ...` narrows here
    //
    // Both operands of the product are binary32, so the product is *exact* in binary64 and
    // the single rounding is the sum's; `f32(focus * f32(hi - lo) + lo)` is that. The
    // previous inner `f32(...)` around the product rounded it to binary32 first, i.e. it
    // transcribed the unfused source expression (`agent.cc:1899-1904` / `:1070-1072`) and
    // disagrees with the shipped binary on a measured fraction of the `focus` values (see
    // PARITY.md -> the float-contraction rule, which carries the rate).
    const lo = f32(minFocus);
    const hi = f32(maxFocus);
    return invertFocus
      ? f32(focus * f32(lo - hi) + hi)
      : f32(focus * f32(hi - lo) + lo);
  }

  /**
   * `fCamera.SetAspect( fovx * retinaHeight / ( agentFOV * retinaWidth ) )` — the aspect
   * `agent::SetGraphics`/`UpdateVision` stores, as a **float** expression (`fovx` is a float,
   * the retina dimensions are `short`, `agentFOV` is a float — `Brain.h:110-111`), so it is
   * rounded at each step and then stored by `SetAspect`.
   */
  static agentPovAspect(fovx: number, retinaWidth: number, retinaHeight: number, agentFOV: number): number {
    const numerator = f32(f32(fovx) * f32(retinaHeight));
    const denominator = f32(f32(agentFOV) * f32(retinaWidth));
    return f32(numerator / denominator);
  }

  /**
   * `agent::SetGraphics()` (`agent.cc:1019-1034`) plus the per-step part of
   * `agent::UpdateVision()` (`agent.cc:1065-1093`): the agent's POV camera sits at the
   * agent's own y (`EyeHeight 0.5` ⇒ the y term is exactly 0) and exactly at the nose plane
   * (`-0.5 * fLengthZ`), with near 0.01 and far `1.5 * worldsize`.
   *
   * `fLengthZ = Size() * sqrt(geneCache.maxSpeed)` (`agent.cc:1000`) comes from the caller:
   * lane L8 owns the genes.
   *
   * The optional `fovx`/`aspect`/`pitchDeg`/`yawDeg`/`localPosition` fields are the *derived*
   * numbers for a caller that already has them and cannot re-derive them bit-exactly — native's
   * own `UpdateVision` computes `fovx = FieldOfView()` **once** (`agent.cc:1070`) and hands that
   * float to `SetAspect`, so re-deriving it from a focus round trip would be a second rounding of
   * the same expression. Passing any of them replaces the corresponding derivation and changes
   * nothing else, so there is still one implementation of each.
   *
   * PORT-NOTE(W1e/agent-pov-precomputed-inputs): the optional fields above are the seam. The
   * node-side POV scanner (`vision/povScan.ts`) is handed exactly these numbers, because it
   * reaches the agent through its public surface (`PovAgent.povCamera()`) rather than through a
   * camera object.
   */
  configureAgentPov(cfg: AgentPovCameraConfig): { fovx: number; aspect: number } {
    const fovx =
      cfg.fovx ?? Camera.horizontalFovForFocus(cfg.focus, cfg.minFocus, cfg.maxFocus, cfg.invertFocus);
    const aspect =
      cfg.aspect ?? Camera.agentPovAspect(fovx, cfg.retinaWidth, cfg.retinaHeight, cfg.agentFOV);

    this.setAspect(aspect);
    if (cfg.localPosition !== undefined) {
      this.setTranslation(cfg.localPosition[0], cfg.localPosition[1], cfg.localPosition[2]);
    } else {
      this.setTranslation(0.0, f32(f32(cfg.eyeHeight - 0.5) * f32(cfg.agentHeight)), f32(-0.5 * f32(cfg.fLengthZ)));
    }
    this.setNear(0.01);
    this.setFar(f32(1.5 * f32(cfg.worldSize)));
    this.setFOV(cfg.agentFOV);

    if (cfg.enableVisionPitch) {
      // PORT-NOTE(geometry/pitch-yaw-double-fma): `agent::UpdateVision` fuses these two in
      // **double** (`0x262f0` pitch, `0x26338` yaw: `fsub` of the bounds in float, `fmadd
      // d0, d0, d1, d2`, then `fcvt` to the float `pitch`/`yaw`). Both product operands are
      // binary32, so the product is exact in binary64 and the one rounding is the sum's.
      //
      // Do **not** "improve" this to `f32Fma`: the binary rounds twice here — once in the
      // binary64 `fmadd`, once in the `fcvt` that stores the `float` — and `f32(a*b + c)`
      // reproduces exactly those two roundings (the product is exact, so `a*b + c` *is* the
      // `fmadd`'s result). `f32Fma` rounds the exact sum once and is a *different* value in
      // general. Pinned live in `tests/fma-contraction-sweep.test.ts`.
      this.setPitch(f32(cfg.visionPitch * f32(cfg.maxVisionPitch - cfg.minVisionPitch) + cfg.minVisionPitch));
    }
    if (cfg.enableVisionYaw) {
      this.setYaw(f32(cfg.visionYaw * f32(cfg.maxVisionYaw - cfg.minVisionYaw) + cfg.minVisionYaw));
    }
    // The already-derived angles win over the nerve derivation (`povCamera()` hands them over);
    // `0` is what native leaves in the camera when the nerve is disabled.
    if (cfg.pitchDeg !== undefined) this.setPitch(cfg.pitchDeg);
    if (cfg.yawDeg !== undefined) this.setYaw(cfg.yawDeg);
    return { fovx, aspect };
  }
}

/** The `agent::config` / `Brain::config` fields the POV camera reads. */
export interface AgentPovCameraConfig {
  /** `outputNerves.focus->get()` — the Focus output nerve, 0..1. */
  readonly focus: number;
  readonly minFocus: number;
  readonly maxFocus: number;
  readonly invertFocus: boolean;
  /** `agent::config.agentFOV` — the *vertical* field of view (10 in minitest). */
  readonly agentFOV: number;
  readonly retinaWidth: number;
  readonly retinaHeight: number;
  readonly eyeHeight: number;
  readonly agentHeight: number;
  /** `agent::SetGeometry()`: `Size() * sqrt(geneCache.maxSpeed)`. */
  readonly fLengthZ: number;
  /** `globals::worldsize` (far plane = `1.5 * worldSize`). */
  readonly worldSize: number;
  readonly enableVisionPitch: boolean;
  /** `outputNerves.visionPitch->get()`, 0..1 — or the raw angle when `enableVisionPitch` is false. */
  readonly visionPitch: number;
  readonly minVisionPitch: number;
  readonly maxVisionPitch: number;
  readonly enableVisionYaw: boolean;
  /** `outputNerves.visionYaw->get()`, 0..1 — or the raw angle when `enableVisionYaw` is false. */
  readonly visionYaw: number;
  readonly minVisionYaw: number;
  readonly maxVisionYaw: number;

  /**
   * The **already-derived** numbers (PORT-NOTE `W1e/agent-pov-precomputed-inputs`). Each one,
   * when present, replaces its derivation above and is used verbatim:
   *
   *  - `fovx`: `agent::FieldOfView()`'s float result;
   *  - `aspect`: the float `fCamera.SetAspect(...)` stored;
   *  - `pitchDeg`/`yawDeg`: the derived camera pitch/yaw in degrees (`0` when the nerve is off);
   *  - `localPosition`: the camera's stored local offset (`SetGraphics`'s `settranslation`).
   *
   * The node-side POV scanner (`vision/povScan.ts`) is given exactly these, because it reaches
   * the agent through its public surface (`PovAgent.povCamera()`).
   */
  readonly fovx?: number;
  readonly aspect?: number;
  readonly pitchDeg?: number;
  readonly yawDeg?: number;
  readonly localPosition?: readonly [number, number, number];
}

function identityCopy(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
