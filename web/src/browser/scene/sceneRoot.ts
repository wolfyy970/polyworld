/**
 * Lane L18 (browser wiring) — scene graph assembly (clear colour, ground, agents, barriers, objects).
 *
 * Native's scene is drawn by `QtSceneRenderer::render()` (`qtrenderer/renderer/qt/QtSceneRenderer.cc`)
 * and `gstage::Draw()`:
 *
 *   - `glClearColor(0,0,0,1)` — pure black, no fog (`QtSceneRenderer.cc:89`);
 *   - the stage's set list (the ground and the barrier walls), then props, then the cast list
 *     (agents and the `food`/`brick` boxes) — `gstage.cc:168-175`;
 *   - **no lighting**: nothing in `app/`, `library/sim/`, `library/graphics/` or `qtrenderer/`
 *     ever calls `glEnable(GL_LIGHTING)` (the sole `glLightfv(GL_LIGHT0, …)` in
 *     `QtSceneRenderer::render` positions a light that is never enabled), so every object is drawn
 *     at its raw `glColor` with no shade, falloff or highlight.
 *
 * PORT-NOTE (L18d/faithful-scene): until L18d this module added a hemisphere light, a key light, a
 * fill light, an ambient light, a fog, an oversized `outer-plain` and a unit `ground-grid` — none of
 * which exist in the native render. They are all removed here: what the page draws is what native
 * draws. The materials are `MeshBasicMaterial` (unlit), matching native's un-lit `glColor` path, and
 * the clear colour is native's black.
 *
 * What this module still takes from the *worldfile* is only what native takes: extent, colours,
 * heights, the domain rectangle, the barrier segment and brick-patch declarations
 * (`sim/worldParams.ts`), and the agent height. Everything on screen is the model's own geometry.
 */

import * as THREE from 'three';
import type { WorldParams } from '../sim/worldParams';
import { createAgentField, type AgentField } from './agents';
import { createBarrierField, type BarrierField } from './barriers';
import { createGround } from './ground';
import { createBoxField, type BoxField } from './objects';
import { SCENE_CLEAR } from './palette';

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

  const scene = new THREE.Scene();
  scene.name = 'polyworld-shell';
  // Native `glClearColor(0,0,0,1)`. No fog: native clears to black and draws the world on top.
  scene.background = new THREE.Color(SCENE_CLEAR);

  const ground = createGround({
    worldSize,
    groundColor: params.colors.ground,
    groundClearance: params.groundClearance,
  });
  const agents = createAgentField(options.agentCapacity, params.agent.height);
  const barriers = createBarrierField(
    params.colors.barrier,
    Math.max(1, params.barriers.length),
  );
  // Brick patches declare the world's brick ceiling (`BrickCount` each); food is unbounded in the
  // worldfile, so its field starts empty and grows to fit (PORT-NOTE (L18/no-per-frame-allocation)
  // in `objects.ts`).
  const bricks = createBoxField('bricks', declaredBricks(params));
  const food = createBoxField('food', Math.max(1, params.maxAgents));

  scene.add(ground, barriers.group, bricks.group, food.group, agents.group);

  return {
    scene,
    agents,
    barriers,
    bricks,
    food,
    worldSize,
    dispose(): void {
      scene.remove(ground, barriers.group, bricks.group, food.group, agents.group);
      agents.dispose();
      barriers.dispose();
      bricks.dispose();
      food.dispose();
      disposeTree(ground);
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
