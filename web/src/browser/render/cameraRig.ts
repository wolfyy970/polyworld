/**
 * Lane W1g/L18d — orbit camera whose **default pose is the native one**, and which follows the
 * native `Rotate` controller as the run advances.
 *
 * PORT-NOTE (L18d/default-view-is-native): the default pose (`cameraDefaults`, `scene/palette.ts`)
 * is native's `MainScene` camera — `FieldOfView 90`, near `0.01`, far `1.5·worldsize`, and the
 * `Rotate` controller's fixation/radius/height pose (`monitor/CameraController.cc:44-81`,
 * `etc/monitors.mfs`). A screenshot on load is therefore comparable 1:1 with a native movie frame.
 *
 * PORT-NOTE (L18d/camera-follows-the-run): native's `MainScene` camera is not static — every step,
 * `SceneMonitor::step()` calls `cameraController->step()`, which adds `Rate` (0.09°) to the orbit
 * angle before the frame is rendered (`monitor/Monitor.cc:420-427`,
 * `CameraController::setRotationAngle`). So the framing of native movie frame *k* is the pose at
 * angle `0.09 · (k+1)`. `followStep()` reproduces that: as long as the viewer has not grabbed the
 * rig, the camera sits at the native angle for the current step, so the page *is* the native movie.
 * A drag hands control to `OrbitControls` (following stops); `reset()` (`v`) returns to following.
 *
 * OrbitControls ships inside the `three` package (`three/addons/...`), so it is not a new
 * dependency — see PARITY.md dependency table, which lists only @types/three.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { cameraDefaults, NATIVE_CAMERA } from '../scene/palette';

export interface CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Damping integration; call once per rendered frame. */
  update(): void;
  /**
   * Sit at the native `MainScene` camera's pose for simulation step `stepIndex`
   * (angle = `Rate · stepIndex`) — unless the viewer has taken the controls.
   */
  followStep(stepIndex: number): void;
  /** Snap back to the native framing for the current step and resume following. */
  reset(): void;
  /** Distance from the orbit target, for the status panel. */
  distance(): number;
  /** True while the rig is on the native orbit (no user input since the last reset). */
  following(): boolean;
  dispose(): void;
}

/**
 * `worldSize` is the booted world's extent: the rig frames the world it is looking at rather
 * than a hard-coded extent (`cameraDefaults`, `scene/palette.ts`).
 */
export function createCameraRig(domElement: HTMLElement, aspect: number, worldSize: number): CameraRig {
  const defaults = cameraDefaults(worldSize);
  const camera = new THREE.PerspectiveCamera(defaults.fov, aspect, defaults.near, defaults.far);
  camera.position.set(...defaults.position);

  const controls = new OrbitControls(camera, domElement);
  controls.target.set(...defaults.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.75;
  controls.zoomSpeed = 0.8;
  controls.panSpeed = 0.6;
  controls.minDistance = defaults.minDistance;
  controls.maxDistance = defaults.maxDistance;
  controls.maxPolarAngle = defaults.maxPolarAngle;
  controls.screenSpacePanning = false;
  controls.update();

  // A user gesture takes the camera off the native track until the next reset.
  let userDriving = false;
  controls.addEventListener('start', () => {
    userDriving = true;
  });

  const placeAtAngle = (angleDegrees: number): void => {
    const pose = cameraDefaults(worldSize, angleDegrees);
    camera.position.set(...pose.position);
    controls.target.set(...pose.target);
  };

  return {
    camera,
    controls,
    update(): void {
      controls.update();
    },
    followStep(stepIndex: number): void {
      if (userDriving) return;
      placeAtAngle(NATIVE_CAMERA.rate * stepIndex);
    },
    reset(): void {
      userDriving = false;
      placeAtAngle(NATIVE_CAMERA.angleStart);
      // Zero the damping residue, otherwise a fresh reset keeps drifting for a few frames.
      controls.update();
    },
    distance(): number {
      return camera.position.distanceTo(controls.target);
    },
    following(): boolean {
      return !userDriving;
    },
    dispose(): void {
      controls.dispose();
    },
  };
}
