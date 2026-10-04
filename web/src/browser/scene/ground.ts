/**
 * Lane L18d — the ground, drawn exactly as native's `gstage` set list draws it.
 *
 * Native builds one `gpolyobj` from `etc/objects/ground.obj` (`Resources::loadPolygons`, called from
 * `TSimulation::InitGround`, `Simulation.cc:820-827`), then:
 *
 *   - `sety( -fGroundClearance )` — a y translation (`gobject::settranslation`),
 *   - `setscale( globals::worldsize )` — uniform scale (`gpolyobj::draw`'s `glScalef(fScale,…)`),
 *   - `setcolor( fGroundColor )`    — the worldfile's `GroundColor`.
 *
 * and `fWorldSet.Add( &fGround )` puts it in the set list, which `gstage::Draw` draws **before**
 * props and cast (`gstage.cc:168-175`). That is the only ground geometry native draws.
 *
 * PORT-NOTE (L18d/no-patch-rectangles): the food *patches* (`FoodPatch`) are not drawable objects —
 * a patch's only visual effect is the `food` boxes it spawns (`FoodPatch.cc:124-126` adds a `food`
 * to the cast list; nothing adds the patch itself). The old ground module drew one tinted rectangle
 * per patch with an invented `ground→food` mix (`0.55 + 0.35·foodFraction`), which is why the
 * browser had bright green slabs native never renders. Gone.
 *
 * PORT-NOTE (L18d/no-outer-plane-no-grid): the oversized `outer-plain` and the unit `ground-grid`
 * were presentation inventions with no native counterpart (native clears to pure black and draws
 * only the world). Both are deleted.
 *
 * PORT-NOTE (L18d/ground-obj-is-not-bundled): unlike `agent.obj` (bundled, sha-pinned by lane L15
 * in `model/geometry/golden/nativeBodyMesh.ts`), `ground.obj` is not on any model path, so it is not
 * bundled anywhere and this module states its four quads verbatim (a comment-only transcription of
 * `etc/objects/ground.obj`, which is four `4`-point polygons tiling the unit square `x 0..1,
 * z 0..-1` at `y = 0`). The quads are coplanar, so the render is a single flat plane either way.
 */

import * as THREE from 'three';
import type { Rgb } from '../sim/worldParams';

/** `etc/objects/ground.obj` — four quads tiling the unit square at `y = 0` (native units). */
const GROUND_QUADS: readonly (readonly number[])[] = [
  [0, 0, 0, 0.5, 0, 0, 0.5, 0, -0.5, 0, 0, -0.5],
  [0, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, -1, 0, 0, -1],
  [0.5, 0, 0, 1, 0, 0, 1, 0, -0.5, 0.5, 0, -0.5],
  [0.5, 0, -0.5, 1, 0, -0.5, 1, 0, -1, 0.5, 0, -1],
];

export interface GroundOptions {
  readonly worldSize: number;
  readonly groundColor: Rgb;
  /** Native `GroundClearance` — the ground's `y` is `-GroundClearance`. */
  readonly groundClearance: number;
}

/**
 * The world's ground: the native unit quads, uniformly scaled to `worldSize` and shifted so the
 * native square `x 0..W, z -W..0` lands where `simSeam.ts` maps it (scene `x -W/2..W/2`,
 * `z -W/2..W/2`).
 */
export function createGround(options: GroundOptions): THREE.Mesh {
  const { worldSize, groundColor, groundClearance } = options;

  const positions: number[] = [];
  for (const quad of GROUND_QUADS) {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      positions.push(quad[i * 3]!, quad[i * 3 + 1]!, quad[i * 3 + 2]!);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();

  // Unlit: native has no `GL_LIGHTING` enabled, so `fGroundColor` is written raw. Native leaves
  // culling off (`//glEnable(GL_CULL_FACE)`), so the ground is double-sided.
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  material.color.setRGB(groundColor.r, groundColor.g, groundColor.b);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ground';
  mesh.scale.setScalar(worldSize);
  mesh.position.set(-worldSize / 2, -groundClearance, worldSize / 2);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
