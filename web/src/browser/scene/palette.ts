/**
 * Lane L18 (browser wiring) — clear colour, world-scale helpers and the **native camera**.
 *
 * PORT-NOTE (L18d/native-camera-is-the-contract): until L18d this file owned a "look" palette and
 * free camera feel (`PORT_SPEC` "camera feel" was not frozen). Since the user's L18d requirement
 * the on-screen render is a fidelity surface, so the values here are the native ones, not choices:
 * the clear colour is `glClearColor(0,0,0,1)` (`QtSceneRenderer::render`), and the default camera
 * is native's `MainScene` — `CameraSettings "Default"` (`FieldOfView 90.0`) driven by
 * `CameraControllerSettings "Main"`, mode `Rotate` (`etc/monitors.mfs`), the exact pose
 * `CameraController::initRotation`/`setRotationAngle` produce (`monitor/CameraController.cc:44-81`).
 *
 * The only thing left that is a choice is *interaction*: `OrbitControls` still lets a human spin
 * the rig, but the pose they return to (`reset`, and the pose the page boots on) is native's.
 */

import type { Rgb } from '../sim/worldParams';

/**
 * World extent used only when nothing has been booted (tests, examples). Every real path reads
 * `WorldSize` from the worldfile — both recorded scenarios say 25
 * (`oracle/<scenario>/run/normalized.wf`).
 */
export const DEFAULT_WORLD_SIZE = 25;

/** Native `glClearColor(0, 0, 0, 1)` (`QtSceneRenderer::render`, `QtSceneRenderer.cc:89`). */
export const SCENE_CLEAR = 0x000000;

/**
 * Native `MainScene` camera numbers, verbatim from `etc/monitors.mfs`:
 *
 *   CameraSettings "Default":        FieldOfView 90.0
 *   CameraControllerSettings "Main": Mode Rotate
 *                                    Rotate { Radius 0.6; Height 0.35; Rate 0.09; AngleStart 0.0
 *                                             Fixation { X 0.5; Y 0.0; Z 0.5 } }
 *
 * `MonitorManager.cc:229-238` builds the `RotationParms` from those, scaling the fixation X and Z
 * by `globals::worldsize` and negating Z (`-1 * fixZ * worldsize`), with `Radius`/`Height` used as
 * fractions of the world size (`CameraController.cc:78-80`).
 */
export const NATIVE_CAMERA = {
  fov: 90,
  near: 0.01,
  /** `SceneRenderer.cc:24-27`: `SetPerspective(fov, aspect, 0.01, 1.5 * globals::worldsize)`. */
  farWorldFactor: 1.5,
  radius: 0.6,
  height: 0.35,
  /** `Rate` in degrees per step — `CameraController::step` advances the angle by this each step. */
  rate: 0.09,
  angleStart: 0.0,
  fixation: { x: 0.5, y: 0.0, z: 0.5 },
} as const;

/** A worldfile colour (`{ R G B }`, 0..1, f32) → three.js hex (byte-quantised). */
export function rgbToHex(color: Rgb): number {
  const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value * 255)));
  return (channel(color.r) << 16) | (channel(color.g) << 8) | channel(color.b);
}

/**
 * The native camera pose, in scene coordinates (the native→scene mapping is a pure translation,
 * `simSeam.ts`), for a rotation `angle` in degrees.
 *
 * Native eye (`CameraController.cc:78-80`):
 *   `((0.5 + radius·sin(angle))·W,  height·W,  (-0.5 + radius·cos(angle))·W)`
 * Native fixation (`MonitorManager.cc:235-237`): `(0.5·W, 0, -0.5·W)`.
 * `nativeXToScene`/`nativeZToScene` then shift by `∓W/2`, so the fixation becomes the scene origin
 * and the eye becomes `(radius·W·sin, height·W, radius·W·cos)`.
 */
export function cameraDefaults(worldSize: number, angleDegrees: number = NATIVE_CAMERA.angleStart): {
  fov: number;
  near: number;
  far: number;
  position: [number, number, number];
  target: [number, number, number];
  minDistance: number;
  maxDistance: number;
  maxPolarAngle: number;
} {
  const angle = (angleDegrees * Math.PI) / 180;
  const radius = NATIVE_CAMERA.radius * worldSize;
  const height = NATIVE_CAMERA.height * worldSize;
  return {
    fov: NATIVE_CAMERA.fov,
    near: NATIVE_CAMERA.near,
    far: NATIVE_CAMERA.farWorldFactor * worldSize,
    position: [radius * Math.sin(angle), height, radius * Math.cos(angle)],
    target: [0, 0, 0],
    minDistance: worldSize * 0.05,
    maxDistance: worldSize * 3,
    maxPolarAngle: Math.PI * 0.49,
  };
}
