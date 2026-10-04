/**
 * Lane W1g — orbit camera.
 *
 * PORT-NOTE (W1g/camera): camera feel is explicitly NOT frozen (PORT_SPEC "Not frozen —
 * camera feel"). The native build has camera modes per agent/monitor (`monitor/`, lane L14);
 * the shell just needs one good orbit rig over the origin.
 *
 * OrbitControls ships inside the `three` package (`three/addons/...`), so it is not a new
 * dependency — see PARITY.md dependency table, which lists only @types/three.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { cameraDefaults } from '../scene/palette';

export interface CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Damping integration; call once per rendered frame. */
  update(): void;
  /** Snap back to the boot framing (instant, no animation — "efficient, not showy"). */
  reset(): void;
  /** Distance from the orbit target, for the status panel. */
  distance(): number;
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

  return {
    camera,
    controls,
    update(): void {
      controls.update();
    },
    reset(): void {
      camera.position.set(...defaults.position);
      controls.target.set(...defaults.target);
      // Zero the damping residue, otherwise a fresh reset keeps drifting for a few frames.
      controls.update();
    },
    distance(): number {
      return camera.position.distanceTo(controls.target);
    },
    dispose(): void {
      controls.dispose();
    },
  };
}
