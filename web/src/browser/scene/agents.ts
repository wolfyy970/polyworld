/**
 * Lane L18 (browser wiring) — the agent field: instanced meshes fed by the simulation seam.
 *
 * Two instances meshes (body + nose pointer) carry the whole population regardless of agent
 * count, so agent count adds no draw calls; the frame is allocation-free and reads no clock.
 * The sim-facing type is `SimulationAgent` (`sim/simSeam.ts`), in *native* coordinates; the
 * conversion to three.js space happens here and only here
 * (`nativeXToScene`/`nativeZToScene`/`yawToSceneRotation`).
 *
 * PORT-NOTE (L18/agent-size): the body's radius is the agent's own `size` — native
 * `agent::radius()` after `SetGeometry`/`setRadius` — in world units, so a population's real size
 * range reads off the screen.
 *
 * PORT-NOTE (L18/agent-colour): the body's colour is the **model's own** (`agent::color()`, the
 * three native 0..1 floats `agent::UpdateColor()` writes each step from the body-channel nerves).
 * The lane's preview stand-in carried a palette slot instead because there were no nerves to read;
 * nothing on screen is a palette invention any more. The one look-only choice left is the nose
 * pointer: it is the same nerve colour blended towards the palette accent so that the ground
 * marker stays visible against the body it belongs to (visuals are not frozen — PORT_SPEC).
 *
 * PORT-NOTE (L18/agent-height): native agents stand on `AgentHeight` above the ground
 * (`agent::config.agentHeight`, 0.2 in both recorded worldfiles); this module adds it to the
 * body's own radius so the creature sits on the plane rather than in it.
 */

import * as THREE from 'three';
import { nativeXToScene, nativeZToScene, yawToSceneRotation, type SimulationAgent } from '../sim/simSeam';
import { PALETTE } from './palette';

/** How far the nose pointer is pushed towards the accent colour (look only). */
const ACCENT_COLOR = new THREE.Color(PALETTE.accent);

export interface AgentField {
  readonly group: THREE.Group;
  /** Instance capacity the field was allocated for (native `MaxAgents`, or the `?agents=` floor). */
  readonly capacity: number;
  /** Push current agent positions/orientations/sizes into the instance buffers. */
  sync(agents: readonly SimulationAgent[], worldSize: number): void;
  dispose(): void;
}

/** Radius of the unit body geometry; an agent's instance scale is its own radius. */
const BODY_RADIUS = 1;

export function createAgentField(maxAgents: number, agentHeight: number): AgentField {
  const capacity = Math.max(1, Math.floor(maxAgents));

  const bodyGeometry = new THREE.OctahedronGeometry(BODY_RADIUS, 0);
  const bodyMaterial = new THREE.MeshLambertMaterial({ flatShading: true });
  const bodies = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, capacity);
  bodies.name = 'agents-body';
  bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bodies.frustumCulled = false;
  bodies.count = 0;

  // Nose pointer: a flat triangle lying on the ground, just ahead of the body. It exists
  // because an octahedron's facing is ambiguous from a top-down orbit camera.
  const noseGeometry = new THREE.CircleGeometry(1, 3);
  noseGeometry.rotateX(-Math.PI / 2);
  const noseMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const noses = new THREE.InstancedMesh(noseGeometry, noseMaterial, capacity);
  noses.name = 'agents-nose';
  noses.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  noses.frustumCulled = false;
  noses.count = 0;

  const color = new THREE.Color();
  for (let i = 0; i < capacity; i++) {
    color.setHex(PALETTE.agents[i % PALETTE.agents.length]!);
    bodies.setColorAt(i, color);
    noses.setColorAt(i, color);
  }
  if (bodies.instanceColor) bodies.instanceColor.setUsage(THREE.DynamicDrawUsage);
  if (noses.instanceColor) noses.instanceColor.setUsage(THREE.DynamicDrawUsage);

  const group = new THREE.Group();
  group.name = 'agents';
  group.add(bodies, noses);
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
        const radius = Math.max(0.05, a.size);
        // Native yaw → three.js rotation about +Y (see simSeam.ts).
        const rotation = yawToSceneRotation(a.yaw);
        const sceneX = nativeXToScene(a.x, worldSize);
        const sceneZ = nativeZToScene(a.z, worldSize);

        dummy.position.set(sceneX, agentHeight + radius, sceneZ);
        dummy.rotation.set(0, rotation, 0);
        dummy.scale.setScalar(radius);
        dummy.updateMatrix();
        bodies.setMatrixAt(i, dummy.matrix);
        bodies.setColorAt(i, bodyColour.setRGB(a.color[0], a.color[1], a.color[2]));

        dummy.position.set(
          sceneX + Math.cos(rotation) * radius * 1.8,
          agentHeight * 0.5,
          sceneZ - Math.sin(rotation) * radius * 1.8,
        );
        dummy.rotation.set(0, rotation, 0);
        dummy.scale.setScalar(radius * 1.4);
        dummy.updateMatrix();
        noses.setMatrixAt(i, dummy.matrix);
        // The nose is the same nerve colour, pushed towards the palette's accent so a body and the
        // pointer on the ground stay distinguishable from above (look, not model — PORT-NOTE below).
        noses.setColorAt(
          i,
          noseColour.setRGB(a.color[0], a.color[1], a.color[2]).lerp(ACCENT_COLOR, 0.35),
        );
      }
      bodies.count = n;
      noses.count = n;
      bodies.instanceMatrix.needsUpdate = true;
      noses.instanceMatrix.needsUpdate = true;
      if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
      if (noses.instanceColor) noses.instanceColor.needsUpdate = true;
    },

    dispose(): void {
      bodyGeometry.dispose();
      bodyMaterial.dispose();
      noseGeometry.dispose();
      noseMaterial.dispose();
      bodies.dispose();
      noses.dispose();
    },
  };
}
