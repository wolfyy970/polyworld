/**
 * Lane L18 (browser wiring) — the world's box objects: native `food` and `brick` are both
 * `gboxf`s (`environment/object.ts`), so one instanced field carries either.
 *
 * PORT-NOTE (L18/draw): what is on screen is the *model's* own geometry, never an invention. A
 * food box is `fLength[3]` at `fPosition[3]` in `fColor[0..2]` (`food::initFoodAt` — position is
 * the box centre, so the renderer adds nothing); a brick is the same with `gBrickHeight` on all
 * three axes (`brick::initBrick`). The only choices here are look: a flat-shaded unit cube, and
 * the fog/lights `sceneRoot.ts` already owns.
 *
 * PORT-NOTE (L18/no-per-frame-allocation): one `InstancedMesh` per object kind, whatever the
 * object count — the sim step cost does not grow with draw calls. The field *grows* (a new, larger
 * `InstancedMesh`, the old one disposed) only when a step's object count passes the allocation,
 * which is amortised, never per-frame; in steady state `sync` writes into the existing buffers.
 */

import * as THREE from 'three';
import { nativeXToScene, nativeZToScene, type SimulationBox } from '../sim/simSeam';

export interface BoxField {
  /** The field's only child: the InstancedMesh, for `renderer.info` and disposal. */
  readonly group: THREE.Group;
  /** Instances the buffers are allocated for (grows to fit — never a drawn-object ceiling). */
  readonly capacity: number;
  /** Push the model's objects into the instance buffers. */
  sync(items: readonly SimulationBox[], worldSize: number): void;
  dispose(): void;
}

export function createBoxField(name: string, capacity: number): BoxField {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  // Unlit (`MeshBasicMaterial`): native enables no `GL_LIGHTING`, so a `gboxf`'s `gbox::draw()`
  // writes its own `fColor` flat (`gmisc.cc::drawunitcube`). The per-instance colour below is the
  // object's own (`gobject::setcolor`).
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

  let current = Math.max(1, Math.floor(capacity));
  let mesh = newInstanced(geometry, material, name, current);

  const group = new THREE.Group();
  group.name = `${name}-field`;
  group.add(mesh);

  const dummy = new THREE.Object3D();
  const colour = new THREE.Color();

  const seedColours = (target: THREE.InstancedMesh, count: number): void => {
    for (let i = 0; i < count; i++) target.setColorAt(i, colour.setHex(0xffffff));
    if (target.instanceColor) target.instanceColor.setUsage(THREE.DynamicDrawUsage);
  };

  return {
    group,
    get capacity(): number {
      return current;
    },

    sync(items: readonly SimulationBox[], worldSize: number): void {
      if (items.length > current) {
        const grown = Math.max(items.length, current * 2);
        const next = newInstanced(geometry, material, name, grown);
        seedColours(next, grown);
        group.remove(mesh);
        mesh.dispose();
        mesh = next;
        current = grown;
        group.add(mesh);
      }

      const count = items.length;
      for (let i = 0; i < count; i++) {
        const item = items[i]!;
        dummy.position.set(
          nativeXToScene(item.x, worldSize),
          item.y,
          nativeZToScene(item.z, worldSize),
        );
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(
          Math.max(0.001, item.sizeX),
          Math.max(0.001, item.sizeY),
          Math.max(0.001, item.sizeZ),
        );
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, colour.setRGB(item.color[0], item.color[1], item.color[2]));
      }

      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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
  name: string,
  capacity: number,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  // Allocate the instance-colour buffer up front so `setColorAt` never has to (three.js would
  // otherwise create it lazily on the first per-instance colour write, mid-sync).
  mesh.setColorAt(0, new THREE.Color(0xffffff));
  if (mesh.instanceColor) {
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor.needsUpdate = true;
  }
  return mesh;
}
