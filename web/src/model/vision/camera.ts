/**
 * Lane W1j/L16 — the per-agent vision camera: focus → field of view, the aspect the retina's
 * 22×22 viewport implies, and the modelview/projection pair the retina is rendered with.
 *
 * Native source: `agent/agent.cc` (`SetGraphics` :1019-1034, `FieldOfView` :1899-1904, the
 * inline duplicate in `UpdateVision` :1070-1087), `graphics/gcamera.cc` (`Use` :271-294,
 * `UsePerspective` :118-126, `SetAspect` :94-98), `graphics/gobject.cc` (`rotate` :265-276,
 * `inverserotate` :284-294, `inversetranslate` :297-301). Spec: `vision-spec.md` §5.
 *
 * PORT-NOTE(vision/camera-scope): **`gcamera` is one object** — lane L15's `Camera`
 * (`src/model/geometry/camera.ts`), which is what `visionCamera()` below builds and configures.
 * This lane owns the *vision configuration* of it (which nerves drive focus/pitch/yaw, which
 * numbers the retina's 22×22 viewport implies, and when the camera is set up relative to the
 * render) and the f32 storage the WebGL2 raster wants; it owns no camera maths. Before the
 * L15/L16 collapse this module was a second composition, pinned against native `glGetFloatv`
 * goldens — the hazard PARITY.md *Open questions* 6 recorded. The collapse was decided by
 * measurement; the numbers and the per-primitive outcome are in PARITY.md → *Open questions* 6.
 * `tests/vision-camera.test.ts` still replays every scene fixture bit-exactly, and now also
 * asserts that this camera *is* L15's on a sweep of configurations.
 *
 * PORT-NOTE(vision/camera-at-nose): with `EyeHeight 0.5` the camera's local y offset is
 * exactly 0 and its local z is `-0.5*fLengthZ`, i.e. the eye sits exactly at the nose plane
 * (`agent.cc:1819-1831` draws polygons 0-4 as the nose at that plane), so the agent's own
 * body is never in its own retina (near plane 0.01). Kept as-is: PN-V11.
 */

import type { Matrix4, Vec3 } from '../types/geometry';
import {
  Camera,
  type AgentPovCameraConfig,
  type CameraFollowObject,
} from '../geometry/camera';
import { multiplyMatrix, objectMatrix } from '../geometry/matrix';
import { vec3 } from '../geometry/vector';
import { type Mat4 } from './matrix';

/**
 * `agentFOV`/focus range defaults from the oracle's worldfile (`normalized.wf:208, 206, 207`);
 * they are configuration, not constants of the algorithm — pass the real values.
 *
 * The vision pitch/yaw *ranges* are `agent.cc`'s constants and are the default here
 * (`MIN_VISION_PITCH` … `MAX_VISION_YAW`); a caller may override them.
 *
 * The pose fields are this lane's seam to lane L8: native reaches the agent's `gobject` through
 * `gcamera::Use`'s follow object (`fCamera.attachTo( this )`), while the node-side scanner has
 * only the numbers (`AgentDeps.visionCamera` is `null` off the WebGL path).
 */
export interface VisionCameraConfig
  extends Omit<AgentPovCameraConfig, 'minVisionPitch' | 'maxVisionPitch' | 'minVisionYaw' | 'maxVisionYaw'> {
  /** Agent world position (`fPosition`) and yaw (`fAngle[0]`, degrees). */
  readonly agentX: number;
  readonly agentY: number;
  readonly agentZ: number;
  readonly agentYawDeg: number;
  readonly minVisionPitch?: number;
  readonly maxVisionPitch?: number;
  readonly minVisionYaw?: number;
  readonly maxVisionYaw?: number;
}

export interface VisionCamera {
  /** `agent::FieldOfView()` — the horizontal FOV the focus nerve asks for, in degrees. */
  readonly fovx: number;
  /** `fCamera`'s stored f32 aspect (`fovx * retinaHeight / (agentFOV * retinaWidth)`). */
  readonly aspect: number;
  /** Degrees actually written to the camera (`0` when the nerve is disabled). */
  readonly pitch: number;
  readonly yaw: number;
  /** `gluPerspective(agentFOV, aspect, 0.01, 1.5*worldsize)`. */
  readonly projection: Mat4;
  /** `gcamera::Use()`'s modelview, including the attached agent's inverse transform. */
  readonly view: Mat4;
  /** The camera's local position, for callers that need the eye point. */
  readonly localPosition: readonly [number, number, number];
}

/** Vision pitch/yaw ranges (`agent.cc` `min/maxVisionPitch`, `min/maxVisionYaw`). */
export const MIN_VISION_PITCH = -7.5;
export const MAX_VISION_PITCH = 7.5;
export const MIN_VISION_YAW = -90.0;
export const MAX_VISION_YAW = 90.0;

/**
 * `agent::FieldOfView()` (`agent.cc:1899-1904`), also inlined at `:1070-1072` — lane L15's
 * transcription (`Camera.horizontalFovForFocus`), whose form the shipped binary's disassembly
 * pins: the f32 bounds are promoted to binary64 and the multiply-add is fused there (`f32(hit
 * ...)`). This lane called the unfused float form until the ownership collapse; the recorded
 * scenes cannot tell the two apart, `tests/fma-contraction-sweep.test.ts` can.
 */
export function fieldOfView(
  focus: number,
  minFocus: number,
  maxFocus: number,
  invertFocus: boolean,
): number {
  return Camera.horizontalFovForFocus(focus, minFocus, maxFocus, invertFocus);
}

/** `gcamera::SetAspect(fovx * retinaHeight / (agentFOV * retinaWidth))` — an f32 store. */
export function visionAspect(
  fovx: number,
  retinaWidth: number,
  retinaHeight: number,
  agentFOV: number,
): number {
  return Camera.agentPovAspect(fovx, retinaWidth, retinaHeight, agentFOV);
}

/** `agent::FieldOfView()` + `SetAspect` in one call, as `SetGraphics`/`UpdateVision` do. */
export function visionFovxAndAspect(config: VisionCameraConfig): { fovx: number; aspect: number } {
  const fovx =
    config.fovx ??
    fieldOfView(config.focus, config.minFocus, config.maxFocus, config.invertFocus);
  const aspect =
    config.aspect ?? visionAspect(fovx, config.retinaWidth, config.retinaHeight, config.agentFOV);
  return { fovx, aspect };
}

function toMat4(m: Matrix4): Mat4 {
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = m[i] as number;
  return out;
}

/**
 * Build the agent's camera exactly as `agent::SetGraphics()`/`UpdateVision()` configure it and
 * `gcamera::Use()` composes it — **L15's `Camera`**, configured with this lane's numbers.
 *
 * Native sequence (`gcamera.cc:271-294`), all post-multiplied onto the identity:
 *
 * ```
 * glRotatef(-roll, 0,0,1); glRotatef(-pitch, 1,0,0); glRotatef(-yaw, 0,1,0);
 * glTranslatef(-camPos[0], -camPos[1], -camPos[2]);
 * followObject->inverseposition();   // agent: Rz(-a2) Rx(-a1) Ry(-a0) then T(-pos)
 * ```
 *
 * PORT-NOTE(vision/camera-order): `UpdateVision` re-derives the aspect every step *after*
 * setting focus and *before* pitch/yaw (`agent.cc:1070-1087`); the order is kept by
 * `configureAgentPov`, since the same float expression is not necessarily the same f32 result
 * when re-associated.
 *
 * PORT-NOTE(vision/camera-precomputed-inputs): the node-side POV scanner (`vision/povScan.ts`)
 * reaches the agent through its public surface and is handed the already-derived numbers
 * (`fovx`/`aspect`/`pitch`/`yaw`/`localPosition`); passing them through changes nothing about the
 * derivation, it *replaces* it (see `AgentPovCameraConfig`).
 */
export function visionCamera(config: VisionCameraConfig): VisionCamera {
  const camera = new Camera();
  const geometryConfig: AgentPovCameraConfig = {
    ...config,
    minVisionPitch: config.minVisionPitch ?? MIN_VISION_PITCH,
    maxVisionPitch: config.maxVisionPitch ?? MAX_VISION_PITCH,
    minVisionYaw: config.minVisionYaw ?? MIN_VISION_YAW,
    maxVisionYaw: config.maxVisionYaw ?? MAX_VISION_YAW,
  };
  const { fovx, aspect } = camera.configureAgentPov(geometryConfig);

  // `An agent always has fRotated set` (`setyaw` at spawn), so `inverseposition()` never takes
  // its no-op branch for the follow object.
  const follow: CameraFollowObject = {
    position: vec3(config.agentX, config.agentY, config.agentZ),
    angles: vec3(config.agentYawDeg, 0, 0),
    rotated: true,
  };
  camera.attachTo(follow);

  return {
    fovx,
    aspect,
    pitch: camera.angles.y,
    yaw: camera.angles.x,
    projection: toMat4(camera.usePerspective()),
    view: toMat4(camera.useModelview()),
    localPosition: [camera.position.x, camera.position.y, camera.position.z],
  };
}

/** A scene object's pose, in the terms `gobject` stores it. */
export interface ObjectPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** `fAngle[0]` (yaw, degrees). */
  readonly yaw?: number;
  /** `fAngle[1]` (pitch, degrees). */
  readonly pitch?: number;
  /** `fAngle[2]` (roll, degrees). */
  readonly roll?: number;
  /**
   * `gobject::fRotated` — `position()` calls `rotate()`, which is a no-op until
   * `SetRotation`/`setyaw`/… has been called at least once (`gobject.cc:265-276`).
   */
  readonly rotated?: boolean;
  /** `gpolyobj::setscale()` value; `gpolyobj::draw` applies `glScalef(s, s, s)`. */
  readonly scale?: number;
}

/**
 * The model matrix a scene object contributes, as `gpolyobj::draw`/`agent::draw` build it:
 * `position()` (`translate` then `rotate`) followed by `glScalef`. L15's `objectMatrix`,
 * converted to this lane's storage.
 */
export function objectModelMatrix(pose: ObjectPose, out: Mat4 = new Float32Array(16)): Mat4 {
  const angles: Vec3 = vec3(pose.yaw ?? 0, pose.pitch ?? 0, pose.roll ?? 0);
  return intoMat4(out, objectMatrix(vec3(pose.x, pose.y, pose.z), angles, pose.scale ?? 1, pose.rotated ?? false));
}

/** `mvp = projection · view · model`, for a vertex shader that takes one matrix. */
export function mvp(projection: Mat4, view: Mat4, model: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  return intoMat4(out, multiplyMatrix(multiplyMatrix(asNumbers(projection), asNumbers(view)), asNumbers(model)));
}

function asNumbers(m: Mat4): number[] {
  const out = new Array<number>(16);
  for (let i = 0; i < 16; i++) out[i] = m[i] as number;
  return out;
}

function intoMat4(out: Mat4, m: Matrix4): Mat4 {
  for (let i = 0; i < 16; i++) out[i] = m[i] as number;
  return out;
}
