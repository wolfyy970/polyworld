/**
 * Lane L18 (browser wiring) — the barrier walls.
 *
 * Native `barrier::draw()` is `gpoly::draw()` — a *vertical quad* whose four corners are
 * `(xa, 0, za)`, `(xa, h, za)`, `(xb, h, zb)`, `(xb, 0, zb)` (`barrier::updateVertices` fills
 * `fVertices` in exactly that order) — plus a top edge line. The wall is a plane, not a box, so
 * this draws one double-sided plane per barrier, scaled to the segment length and `gBarrierHeight`
 * and rotated about +Y to lie along the segment. `BarrierColor` is the worldfile's global colour
 * (a barrier has no per-instance override; `barrier::init` copies `gBarrierColor`).
 *
 * PORT-NOTE (L18/draw): the geometry is the *model's* (`barrier::absolutePosition()`), read per
 * step, so a `dyn` barrier grows on screen the step the model grows it. The only invention is the
 * look (flat shading, no top edge line, an invisible wall for a degenerate segment).
 *
 * PORT-NOTE (L18/no-per-frame-allocation): one `InstancedMesh` for every barrier, grown only if a
 * step ever adds one (native's barrier list is fixed after `processWorldFile`, so it never does).
 *
 * PORT-NOTE (L18d/no-top-edge-line): `barrier::draw()` (`barrier.cc:69-77`) also strokes a
 * `GL_LINES` segment between the quad's two top corners in `gBarrierColor` — a one-pixel outline
 * with no three.js equivalent short of a screen-space-width line primitive, and invisible at the
 * recorded 640×480. It is deliberately not drawn; the fill (what the wall *is*) is.
 */

import * as THREE from 'three';
import { nativeXToScene, nativeZToScene, type SimulationBarrier } from '../sim/simSeam';
import type { Rgb } from '../sim/worldParams';

export interface BarrierField {
  readonly group: THREE.Group;
  readonly capacity: number;
  /** Walls actually in the buffers after the last `sync` (degenerate segments are not drawn). */
  readonly drawn: number;
  sync(barriers: readonly SimulationBarrier[], worldSize: number): void;
  dispose(): void;
}

export function createBarrierField(color: Rgb, capacity: number): BarrierField {
  // A unit quad in the XY plane; instances scale it to (length, height, 1) and stand it up.
  const geometry = new THREE.PlaneGeometry(1, 1);
  // Unlit (`MeshBasicMaterial`): native enables no `GL_LIGHTING`, so `barrier::draw()`'s
  // `gpoly::draw()` writes `BarrierColor` flat. Double-sided: native leaves culling off.
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  material.color.setRGB(color.r, color.g, color.b);

  let current = Math.max(1, Math.floor(capacity));
  let mesh = newInstanced(geometry, material, current);

  const group = new THREE.Group();
  group.name = 'barriers';
  group.add(mesh);

  const dummy = new THREE.Object3D();
  let drawn = 0;

  return {
    group,
    get capacity(): number {
      return current;
    },
    get drawn(): number {
      return drawn;
    },

    sync(barriers: readonly SimulationBarrier[], worldSize: number): void {
      if (barriers.length > current) {
        const grown = Math.max(barriers.length, current * 2);
        const next = newInstanced(geometry, material, grown);
        group.remove(mesh);
        mesh.dispose();
        mesh = next;
        current = grown;
        group.add(mesh);
      }

      let count = 0;
      for (const barrier of barriers) {
        // Native draws the quad's four corners, which collapse to a line when the two endpoints
        // coincide (the recorded `growingBarriers` world boots with both barriers degenerate at
        // `Z1 == Z2`). A zero-area wall is not drawn — and is not counted as drawn.
        const dx = barrier.xb - barrier.xa;
        const dz = barrier.zb - barrier.za;
        const length = Math.hypot(dx, dz);
        if (!(length > 1e-6) || !(barrier.height > 0)) continue;

        // Rotation about +Y by θ maps local +x to (cos θ, 0, -sin θ); aim it along (dx, dz).
        const yaw = Math.atan2(-dz, dx);
        dummy.position.set(
          nativeXToScene((barrier.xa + barrier.xb) / 2, worldSize),
          barrier.height / 2,
          nativeZToScene((barrier.za + barrier.zb) / 2, worldSize),
        );
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(length, barrier.height, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(count, dummy.matrix);
        count++;
      }

      mesh.count = count;
      drawn = count;
      mesh.instanceMatrix.needsUpdate = true;
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}

function newInstanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = 'barriers-walls';
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  return mesh;
}
