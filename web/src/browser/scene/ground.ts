/**
 * Lane L18 (browser wiring) — the ground, from the worldfile's own geometry.
 *
 * The native ground is a set of rectangular/elliptical *patches* inside a domain
 * (`environment/Patch.{h,cc}`), each carrying a food fraction, plus a global ground colour
 * (`GroundColor`). This module draws exactly that: a domain-sized plane in `GroundColor`, and
 * one quad per `on` food patch in a tint of `FoodColor`, at the patch's own absolute
 * coordinates (`Patch::initBase`, converted by `sim/worldParams.ts`).
 *
 * PORT-NOTE (L18/ground): the *patch* geometry, its on/off state and both colours are the
 * worldfile's; nothing here is invented. Bricks and barriers are not this module's job — they
 * belong to `objects.ts` (the model's `food`/`brick` boxes) and `barriers.ts` (the worldfile's
 * walls, ratio-scaled exactly as `barrier::updateVertices` scales them), and *are* drawn since
 * L18c. The recorded worldfiles' barrier coordinates are expressions
 * (`X1 ( 0.3333 if RatioBarrierPositions else … )`), which lane L4 evaluates at boot;
 * `worldParams.ts` reads them (`barriers`), and a segment whose expression cannot be produced is
 * reported there as a note and not drawn rather than guessed. Patch *height* (`FoodHeight`) is not
 * drawn: patches are flat ground areas in the native scene (`Patch` has no y).
 */

import * as THREE from 'three';
import { nativeXToScene, nativeZToScene } from '../sim/simSeam';
import type { PatchRect, Rgb } from '../sim/worldParams';
import { mixHex, PALETTE, rgbToHex } from './palette';

export interface GroundOptions {
  readonly worldSize: number;
  readonly domain: { readonly startX: number; readonly startZ: number; readonly endX: number; readonly endZ: number };
  readonly patches: readonly PatchRect[];
  readonly groundColor: Rgb;
  readonly foodColor: Rgb;
}

/**
 * Base plane + food patches, as one group (`'ground'`). Two instanced meshes at most (rects
 * and ellipses), so the worldfile's patch count does not add draw calls.
 */
export function createGround(options: GroundOptions): THREE.Group {
  const { worldSize, domain, patches } = options;
  const groundHex = rgbToHex(options.groundColor);
  const foodHex = rgbToHex(options.foodColor);

  const group = new THREE.Group();
  group.name = 'ground';

  const width = nativeXToScene(domain.endX, worldSize) - nativeXToScene(domain.startX, worldSize);
  const depth = nativeZToScene(domain.endZ, worldSize) - nativeZToScene(domain.startZ, worldSize);
  const baseGeometry = new THREE.PlaneGeometry(Math.abs(width), Math.abs(depth), 1, 1);
  baseGeometry.rotateX(-Math.PI / 2);
  const baseMaterial = new THREE.MeshLambertMaterial({ color: groundHex, flatShading: true });
  const base = new THREE.Mesh(baseGeometry, baseMaterial);
  base.name = 'ground-domain';
  base.position.set(
    nativeXToScene((domain.startX + domain.endX) / 2, worldSize),
    0,
    nativeZToScene((domain.startZ + domain.endZ) / 2, worldSize),
  );
  base.matrixAutoUpdate = false;
  base.updateMatrix();
  group.add(base);

  const on = patches.filter((patch) => patch.on);
  const rects = on.filter((patch) => patch.shape === 'R');
  const ellipses = on.filter((patch) => patch.shape === 'E');

  if (rects.length > 0) {
    group.add(patchMesh(rects, worldSize, groundHex, foodHex, 'R'));
  }
  if (ellipses.length > 0) {
    group.add(patchMesh(ellipses, worldSize, groundHex, foodHex, 'E'));
  }

  return group;
}

/**
 * One instanced mesh for a patch shape. A `RECTANGULAR` patch is a unit plane scaled to
 * (sizeX, sizeZ); an `ELLIPTICAL` one is a unit disc scaled to the same box (native's
 * `ELLIPTICAL` is a radius test over that box — `Patch.cc::setPoint`), which is why a single
 * scale per instance covers both.
 */
function patchMesh(
  patches: readonly PatchRect[],
  worldSize: number,
  groundHex: number,
  foodHex: number,
  shape: 'R' | 'E',
): THREE.Mesh {
  const geometry =
    shape === 'R'
      ? new THREE.PlaneGeometry(1, 1)
      : ((): THREE.CircleGeometry => {
          const disc = new THREE.CircleGeometry(0.5, 40);
          disc.rotateX(-Math.PI / 2);
          return disc;
        })();
  if (shape === 'R') geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshLambertMaterial({
    flatShading: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: true,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, patches.length);
  mesh.name = shape === 'R' ? 'ground-food-patches' : 'ground-food-patches-ellipse';
  mesh.frustumCulled = false;

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  patches.forEach((patch, index) => {
    const spanX = Math.abs(nativeXToScene(patch.endX, worldSize) - nativeXToScene(patch.startX, worldSize));
    const spanZ = Math.abs(nativeZToScene(patch.endZ, worldSize) - nativeZToScene(patch.startZ, worldSize));
    dummy.position.set(
      nativeXToScene(patch.centerX, worldSize),
      // A hair above the base plane so the two never z-fight; patches are flat in native.
      0.01,
      nativeZToScene(patch.centerZ, worldSize),
    );
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(Math.max(0.001, spanX), 1, Math.max(0.001, spanZ));
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);

    // The tint is presentation, the colours are the worldfile's: a patch that carries most of
    // the world's food reads closer to `FoodColor`, a thin one closer to the ground.
    const weight = 0.55 + 0.35 * Math.min(1, Math.max(0, patch.foodFraction));
    color.setHex(mixHex(groundHex, foodHex, weight));
    mesh.setColorAt(index, color);
  });

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/**
 * A plain, unpatterned plane much larger than the world, sitting just below the domain. Without
 * it the domain ends mid-frame and the viewer sees a hard edge where the ground stops; with it
 * the horizon dissolves into fog instead.
 */
export function createGroundOuter(worldSize: number, groundColor: Rgb): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(worldSize * 12, worldSize * 12, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshLambertMaterial({ color: rgbToHex(groundColor), flatShading: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'outer-plain';
  // Below the domain plane (which sits at y=0) so the two never z-fight.
  mesh.position.y = -0.02 * worldSize;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/** A scale cue over the domain: one grid line per world unit, faintly. */
export function createGroundScale(worldSize: number): THREE.GridHelper {
  const grid = new THREE.GridHelper(
    worldSize,
    Math.max(2, Math.round(worldSize)),
    PALETTE.groundEdge,
    PALETTE.groundEdge,
  );
  grid.name = 'ground-grid';
  grid.position.y = 0.002 * worldSize;
  const material = grid.material as THREE.Material;
  material.transparent = true;
  material.opacity = 0.22;
  material.depthWrite = false;
  return grid;
}
