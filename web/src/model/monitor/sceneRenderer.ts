/**
 * Lane L14 — `SceneRenderer` (`library/monitor/SceneRenderer.{h,cc}`): the *base* of the
 * per-scene renderer, plus the two writer/recorder interfaces the movie controller drives.
 *
 * The native split is: this base class (owned here) holds the camera, the scene, the buffer
 * size and the `renderComplete` signal, and an abstract `render()` + `createMovieRecorder()`
 * pair (implemented by `src/qtrenderer/renderer/qt/QtSceneRenderer.cc`, lane L16/L15's side of
 * the port). `SceneRenderer::create` is *not* in this file natively either — it lives in the Qt
 * renderer — so the port keeps the same shape: this file declares the surface and the parts of
 * the base constructor that are pure arithmetic (the camera's perspective), and the concrete
 * renderer is injected.
 *
 * PORT-NOTE(monitor/scene-renderer-surface): `SceneRendererSurface` is the seam for the
 * concrete renderer (Three.js, lane L18, via L15/L16's scene). It names native's methods
 * (`getCamera`, `getBufferWidth`, `getBufferHeight`, `renderComplete`, `createMovieRecorder`,
 * `render`) so a reader can diff it against `SceneRenderer.h`. It is deliberately *narrow*: the
 * monitor lane never calls `render()`'s internals, and `render()` itself is native's "only
 * renders if slots are connected" rule — the port's implementation must keep it, because
 * `SceneMovieController` relies on it to avoid rendering unsampled steps' cost.
 *
 * PORT-NOTE(monitor/camera-perspective-args): native calls
 * `camera.SetPerspective( fov, float(width)/float(height), 0.01, 1.5 * globals::worldsize )`.
 * The aspect is an f32 division of the two integer buffer sizes and the far plane is an f32
 * narrowing of `1.5 * worldsize` (worldsize is itself f32); both are reproduced in
 * `sceneCameraPerspective`, with the values listed for a caller that must set them itself (the
 * browser renderer sets a Three.js `PerspectiveCamera`, not a `gcamera`).
 */

import { globals, type Color, type Color4 } from '../types';
import type { ControllerCamera } from './cameraController';
import type { MovieRecorder, MovieWriter } from './movieWriter';
import type { Signal } from './signal';

const f = Math.fround;

/** Native `SceneRenderer::CameraProperties` — the colour the scene clears to, and the fov. */
export interface CameraProperties {
  readonly color: Color4;
  readonly fov: number;
}

/** Native `SceneRenderer::CameraProperties::CameraProperties()` — `(0.3,0.3,0.3,1.0)`, fov 90. */
export const DEFAULT_CAMERA_PROPERTIES: CameraProperties = {
  color: { r: f(0.3), g: f(0.3), b: f(0.3), a: 1.0 },
  fov: 90,
};

/** Native `SceneRenderer::CameraProperties( Color _color, float _fov )`. */
export function cameraProperties(color: Color | Color4, fov: number): CameraProperties {
  return {
    color: {
      r: f(color.r),
      g: f(color.g),
      b: f(color.b),
      a: f('a' in color ? color.a : 1.0),
    },
    fov: f(fov),
  };
}

/** What native hands to `gcamera::SetPerspective` (plus the near plane it hard-codes). */
export interface SceneCameraPerspective {
  readonly fov: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
}

/**
 * Native `SceneRenderer::SceneRenderer` — `camera.SetPerspective( cameraProps.fov,
 * float(width)/float(height), 0.01, 1.5 * globals::worldsize )`.
 */
export function sceneCameraPerspective(
  props: CameraProperties,
  width: number,
  height: number,
): SceneCameraPerspective {
  return {
    fov: props.fov,
    aspect: f(f(width) / f(height)),
    near: f(0.01),
    far: f(1.5 * globals.worldsize),
  };
}

/**
 * The concrete renderer, as `SceneMonitor`/`SceneMovieController` use it. Implemented outside
 * this lane (`QtSceneRenderer` → Three.js); see the file's PORT-NOTE.
 */
export interface SceneRendererSurface {
  /** Native `gcamera &getCamera()` — the camera the `CameraController` programs. */
  getCamera(): ControllerCamera;
  /** Native `int getBufferWidth()`. */
  getBufferWidth(): number;
  /** Native `int getBufferHeight()`. */
  getBufferHeight(): number;
  /** Native `util::Signal<> renderComplete`. */
  readonly renderComplete: Signal<[]>;
  /** Native `virtual MovieRecorder *createMovieRecorder( PwMovieWriter * )`. */
  createMovieRecorder(writer: MovieWriter): MovieRecorder;
  /** Native `virtual void render()` — only renders when slots are connected. */
  render(): void;
}

/**
 * Native `SceneRenderer::create( gstage &, cameraProps, width, height )` is a Qt-renderer
 * function; in the port the equivalent is whatever factory the app passes to
 * `MonitorManager`. The signature is kept so the seam is recognisable.
 */
export type SceneRendererFactory = (
  stage: unknown,
  cameraProperties: CameraProperties,
  width: number,
  height: number,
) => SceneRendererSurface;

export type { MovieRecorder, MovieWriter };
