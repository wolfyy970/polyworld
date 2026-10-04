/**
 * Lane L18 (browser wiring) — the agent field: the **native body mesh**, one instance per creature.
 *
 * Each agent draws `etc/objects/agent.obj`, scaled by its own `(fLengthX, agentHeight, fLengthZ)`
 * and rotated by its yaw, exactly as `agent::SetGeometry()` + `agent::draw()` do
 * (`agent/agent.cc:993-1013, 1819-1831`). The mesh is split into the two polygon ranges native
 * paints (`0..4` in `fNoseColor`, `5..9` in `fColor`) — see `agentMesh.ts`. Two `InstancedMesh`es
 * carry the whole population regardless of agent count, so agent count adds no draw calls; the
 * frame is allocation-free and reads no clock.
 *
 * The sim-facing type is `SimulationAgent` (`sim/simSeam.ts`), in *native* coordinates; the
 * conversion to three.js space happens here and only here
 * (`nativeXToScene`/`nativeZToScene`/`yawToMeshRotation`).
 *
 * PORT-NOTE (L18d/unlit): native never enables `GL_LIGHTING` on the scene path (there is no
 * `glEnable(GL_LIGHTING)` anywhere in `app/`, `library/sim/`, `library/graphics/` or
 * `qtrenderer/` — confirmed by `src/model/vision/raster.ts`'s own note), so `agent::draw()`'s
 * `glColor3fv` writes flat colour with no shade, falloff or highlight. The body is therefore drawn
 * with `MeshBasicMaterial` (unlit), not a Lambert material — the same reasoning as the ground,
 * barriers and boxes.
 *
 * PORT-NOTE (L18d/agents-sit-on-the-ground): native `agent::fPosition[1]` is never set (it stays
 * `gobject::init`'s `0.0`), and the mesh spans `y ∈ [-0.5, +0.5]·agentHeight`, so the creature is
 * centred on `y = 0` and the ground (drawn first, depth-tested) hides the buried half. The old
 * `agentHeight + radius` lift was an invention and is gone.
 *
 * PORT-NOTE (L18d/no-dead-agents): native's cast list holds only live agents (a dead agent is
 * removed from `gXSortedObjects`, `Simulation.cc:3570`), so the roster the renderer gets is already
 * the live set; nothing here filters `alive` a second time.
 */

import * as THREE from 'three';
import {
  nativeXToScene,
  nativeZToScene,
  yawToMeshRotation,
  type SimulationAgent,
} from '../sim/simSeam';
import { createAgentMeshes } from './agentMesh';

export interface AgentField {
  readonly group: THREE.Group;
  /** Instance capacity the field was allocated for (native `MaxAgents`, or the `?agents=` floor). */
  readonly capacity: number;
  /** Push current agent positions/orientations/sizes/colours into the instance buffers. */
  sync(agents: readonly SimulationAgent[], worldSize: number): void;
  dispose(): void;
}

export function createAgentField(maxAgents: number, agentHeight: number): AgentField {
  const capacity = Math.max(1, Math.floor(maxAgents));
  const meshes = createAgentMeshes();

  // Native leaves face culling off (`//glEnable(GL_CULL_FACE)`), so both sides of every polygon
  // are filled; `MeshBasicMaterial` is the unlit equivalent of native's flat `glColor3fv` fills.
  const noseMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const bodyMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

  const noses = new THREE.InstancedMesh(meshes.nose, noseMaterial, capacity);
  noses.name = 'agents-nose';
  const bodies = new THREE.InstancedMesh(meshes.body, bodyMaterial, capacity);
  bodies.name = 'agents-body';

  for (const mesh of [noses, bodies]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
  }

  // Allocate the instance-colour buffers up front (three.js would otherwise create one lazily on
  // the first `setColorAt`, mid-sync).
  const seed = new THREE.Color();
  for (let i = 0; i < capacity; i++) {
    noses.setColorAt(i, seed.setRGB(0.5, 0.5, 0.5));
    bodies.setColorAt(i, seed.setRGB(0.5, 0.5, 0.5));
  }
  if (noses.instanceColor) noses.instanceColor.setUsage(THREE.DynamicDrawUsage);
  if (bodies.instanceColor) bodies.instanceColor.setUsage(THREE.DynamicDrawUsage);

  const group = new THREE.Group();
  group.name = 'agents';
  group.add(noses, bodies);
  group.matrixAutoUpdate = false;
  group.updateMatrix();

  const dummy = new THREE.Object3D();
  const bodyColour = new THREE.Color();
  const noseColour = new THREE.Color();

  return {
    group,
    capacity,

    sync(agents: readonly SimulationAgent[], worldSize: number): void {
      const n = Math.min(agents.length, capacity);
      for (let i = 0; i < n; i++) {
        const a = agents[i]!;
        dummy.position.set(nativeXToScene(a.x, worldSize), 0, nativeZToScene(a.z, worldSize));
        dummy.rotation.set(0, yawToMeshRotation(a.yaw), 0);
        // Native `agent::SetGeometry`'s scale: x by `fLengthX`, y by `agentHeight`, z by `fLengthZ`.
        // A degenerate length would collapse a polygon; keep a hair of width so it stays drawable.
        dummy.scale.set(Math.max(1e-4, a.lengthX), agentHeight, Math.max(1e-4, a.lengthZ));
        dummy.updateMatrix();

        bodies.setMatrixAt(i, dummy.matrix);
        bodies.setColorAt(i, bodyColour.setRGB(a.color[0], a.color[1], a.color[2]));

        // `agent::draw()`: polygons 0..4 in `fNoseColor`, unless the worldfile's `NoseColor` is `B`.
        const nose = a.noseIsBody ? a.color : a.noseColor;
        noses.setMatrixAt(i, dummy.matrix);
        noses.setColorAt(i, noseColour.setRGB(nose[0], nose[1], nose[2]));
      }
      noses.count = n;
      bodies.count = n;
      noses.instanceMatrix.needsUpdate = true;
      bodies.instanceMatrix.needsUpdate = true;
      if (noses.instanceColor) noses.instanceColor.needsUpdate = true;
      if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    },

    dispose(): void {
      meshes.dispose();
      noseMaterial.dispose();
      bodyMaterial.dispose();
      noses.dispose();
      bodies.dispose();
    },
  };
}
