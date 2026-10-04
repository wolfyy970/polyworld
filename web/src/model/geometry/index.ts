/**
 * Lane W1e — the geometry lane's public surface.
 *
 * Lanes import the *behaviour* from here (and only the frozen shapes from
 * `src/model/types/geometry.ts`):
 *
 *   import { Camera, FrustumXZ, PolyObj, frustumPlanes } from '../geometry';
 *
 * Nothing in this directory touches OpenGL: rendering is L16's problem. What is here is the
 * maths the native `graphics/` layer performs *before* any rasterization — the camera and
 * its matrices, the frustum, the polygon/bounds/radius machinery — plus the ray helpers the
 * GPU-side lanes need. The goldens that pin these numbers are generated from the native code
 * itself (see `native/glprobe.sh`) and checked in `tests/geometry.test.ts`.
 */

export * from './float';
export * from './vector';
export * from './matrix';
export * from './camera';
export * from './frustum';
export * from './primitives';
export * from './body';
export * from './raycast';
export * from './golden/nativeCameraVectors';
export * from './golden/nativeBodyMesh';
