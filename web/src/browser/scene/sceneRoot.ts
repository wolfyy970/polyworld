/**
 * Lane L18 (browser wiring) — scene graph assembly (fog, lights, ground, agents, barriers, objects).
 *
 * PORT-NOTE (L18/visuals): the native scene's lighting/materials live in `graphics/`
 * (lanes L15/L16) and none of it is frozen. What this module *does* take from the model is the
 * worldfile: extent, ground/food/brick/barrier colours and heights, the domain rectangle, the food
 * patches, the barrier segment and brick-patch declarations (`sim/worldParams.ts`), and the agent
 * height. Everything else here is look.
 *
 * PORT-NOTE (L18/draw): since L18c the scene draws every world object native's own renderer does —
 * the model's `food` and `brick` boxes (`objects.ts`), the worldfile's barrier walls
 * (`barriers.ts`), and the agent field (`agents.ts`). All of them are fed from the model's current
 * step and use one `InstancedMesh` per kind, so the frame cost is proportional to object count, not
 * to a draw call per object; there are no shadows, no post-processing and no per-frame allocation
 * in steady state. A field grows its buffers only when a step's object count passes the allocation.
 */

import * as THREE from 'three';
import type { WorldParams } from '../sim/worldParams';
import { createAgentField, type AgentField } from './agents';
import { createBarrierField, type BarrierField } from './barriers';
import { createGround, createGroundOuter, createGroundScale } from './ground';
import { createBoxField, type BoxField } from './objects';
import { LIGHTING, PALETTE, rgbToHex } from './palette';

export interface SceneRootOptions {
  readonly params: WorldParams;
  /** Instance capacity for the agent field (see `config.ts`). */
  readonly agentCapacity: number;
}

export interface SceneRoot {
  readonly scene: THREE.Scene;
  readonly agents: AgentField;
  /** The worldfile's barrier walls (`barriers.ts`); empty when the file declares none. */
  readonly barriers: BarrierField;
  /** The model's brick boxes (`objects.ts`); empty when the world has no bricks. */
  readonly bricks: BoxField;
  /** The model's food boxes (`objects.ts`). */
  readonly food: BoxField;
  readonly worldSize: number;
  dispose(): void;
}

export function createSceneRoot(options: SceneRootOptions): SceneRoot {
  const { params } = options;
  const worldSize = params.worldSize;
  const groundHex = rgbToHex(params.colors.ground);

  const scene = new THREE.Scene();
  scene.name = 'polyworld-shell';
  // Background and fog share one colour so the ground's far edge dissolves into the sky.
  scene.background = new THREE.Color(PALETTE.sky);
  scene.fog = new THREE.Fog(PALETTE.sky, worldSize * 0.9, worldSize * 2.8);

  // Hemispheric fill does most of the work: it is one light and gives flat-shaded facets their
  // retro two-tone read without a shadow pass. Its ground colour is the worldfile's.
  const hemisphere = new THREE.HemisphereLight(PALETTE.sky, groundHex, 1.15);
  hemisphere.position.set(0, worldSize, 0);

  const key = new THREE.DirectionalLight(LIGHTING.keyColor, LIGHTING.keyIntensity);
  key.position.set(worldSize * 0.6, worldSize * 1.1, worldSize * 0.45);
  key.target.position.set(0, 0, 0);

  const fill = new THREE.DirectionalLight(LIGHTING.fillColor, LIGHTING.fillIntensity);
  fill.position.set(-worldSize * 0.7, worldSize * 0.5, -worldSize * 0.6);
  fill.target.position.set(0, 0, 0);

  const ambient = new THREE.AmbientLight(LIGHTING.ambient, LIGHTING.ambientIntensity);

  const ground = createGround({
    worldSize,
    domain: params.domain,
    patches: params.patches,
    groundColor: params.colors.ground,
    foodColor: params.colors.food,
  });
  const outerPlain = createGroundOuter(worldSize, params.colors.ground);
  const scale = createGroundScale(worldSize);
  const agents = createAgentField(options.agentCapacity, params.agent.height);
  const barriers = createBarrierField(
    rgbToHex(params.colors.barrier),
    Math.max(1, params.barriers.length),
  );
  // Brick patches declare the world's brick ceiling (`BrickCount` each); food is unbounded in the
  // worldfile, so its field starts empty and grows to fit (PORT-NOTE (L18/no-per-frame-allocation)
  // in `objects.ts`).
  const bricks = createBoxField('bricks', declaredBricks(params));
  const food = createBoxField('food', Math.max(1, params.maxAgents));

  scene.add(
    hemisphere,
    key,
    key.target,
    fill,
    fill.target,
    ambient,
    outerPlain,
    scale,
    ground,
    barriers.group,
    bricks.group,
    food.group,
    agents.group,
  );

  return {
    scene,
    agents,
    barriers,
    bricks,
    food,
    worldSize,
    dispose(): void {
      scene.remove(
        hemisphere,
        key,
        key.target,
        fill,
        fill.target,
        ambient,
        outerPlain,
        scale,
        ground,
        barriers.group,
        bricks.group,
        food.group,
        agents.group,
      );
      agents.dispose();
      barriers.dispose();
      bricks.dispose();
      food.dispose();
      disposeTree(outerPlain);
      disposeTree(scale);
      ground.traverse((child) => disposeTree(child));
      scene.clear();
    },
  };
}

/** The world's declared brick ceiling: the sum of every `On` brick patch's `BrickCount`. */
function declaredBricks(params: WorldParams): number {
  let total = 0;
  for (const patch of params.brickPatches) if (patch.on) total += patch.brickCount;
  return Math.max(1, total);
}

function disposeTree(object: THREE.Object3D): void {
  const mesh = object as Partial<THREE.Mesh>;
  mesh.geometry?.dispose();
  const material = mesh.material;
  if (Array.isArray(material)) for (const entry of material) entry.dispose();
  else material?.dispose();
  const instanced = object as Partial<THREE.InstancedMesh>;
  instanced.dispose?.();
}
