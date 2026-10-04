/**
 * Lane L18 (browser wiring) — the scene fields' geometry, as pure maths (no WebGL).
 *
 * `sceneRoot.ts` is only *assembled* here (the page's own verification is
 * `verify/demoEvidence.mjs`, which needs a live WebGL context). What this file pins is the part
 * that can be wrong without a browser: the native→scene mapping and the per-instance
 * position/scale/colour a field writes for the model's own numbers.
 *
 * The expectations are the *native* coordinates converted by `simSeam.ts` — a barrier from
 * `(0, 0)` to `(10, 0)` at `WorldSize 25` is a wall 10 long, 5 tall, centred at scene
 * `(-7.5, 2.5, +12.5)` — so a regression in the seam shows up here rather than on a screenshot.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createBarrierField } from './barriers';
import { createBoxField } from './objects';

function positionOf(mesh: THREE.InstancedMesh, index: number): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

function scaleOf(mesh: THREE.InstancedMesh, index: number): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  return new THREE.Vector3().setFromMatrixScale(matrix);
}

function instanceCount(mesh: THREE.InstancedMesh): number {
  return mesh.count;
}

function firstMesh(group: THREE.Group): THREE.InstancedMesh {
  const child = group.children[0];
  if (!(child instanceof THREE.InstancedMesh)) throw new Error('group has no InstancedMesh');
  return child;
}

describe('L18 scene — the box field (`food`, `brick`)', () => {
  it('places a model object at its own native position and size, and its own colour', () => {
    const field = createBoxField('food', 2);
    field.sync(
      [{ x: 10, y: 0.5, z: -20, sizeX: 1, sizeY: 0.6, sizeZ: 1, color: [0.2, 0.6, 0.2] }],
      25,
    );

    const mesh = firstMesh(field.group);
    expect(instanceCount(mesh)).toBe(1);
    // nativeXToScene(10, 25) = -2.5; nativeZToScene(-20, 25) = +12.5 - 20 = -7.5.
    const position = positionOf(mesh, 0);
    expect(position.x).toBeCloseTo(-2.5, 6);
    expect(position.y).toBeCloseTo(0.5, 6);
    expect(position.z).toBeCloseTo(-7.5, 6);

    const scale = scaleOf(mesh, 0);
    expect(scale.x).toBeCloseTo(1, 6);
    expect(scale.y).toBeCloseTo(0.6, 6);
    expect(scale.z).toBeCloseTo(1, 6);

    const colour = new THREE.Color();
    mesh.getColorAt(0, colour);
    expect(colour.r).toBeCloseTo(0.2, 5);
    expect(colour.g).toBeCloseTo(0.6, 5);
    expect(colour.b).toBeCloseTo(0.2, 5);

    field.dispose();
  });

  it('grows to fit more objects than it was allocated for, without losing the first ones', () => {
    const field = createBoxField('bricks', 1);
    const mesh0 = firstMesh(field.group);
    const items = Array.from({ length: 5 }, (_, i) => ({
      x: i,
      y: 0.15,
      z: -i,
      sizeX: 0.3,
      sizeY: 0.3,
      sizeZ: 0.3,
      color: [0.6, 0.2, 0.2] as const,
    }));

    field.sync(items, 25);
    const mesh = firstMesh(field.group);
    expect(mesh).not.toBe(mesh0); // the allocation was replaced…
    expect(field.capacity).toBeGreaterThanOrEqual(5);
    expect(instanceCount(mesh)).toBe(5); // …and every object is in the new buffers
    expect(scaleOf(mesh, 4).x).toBeCloseTo(0.3, 6);

    field.dispose();
  });
});

describe('L18 scene — the barrier walls', () => {
  it('draws a segment as a wall of its length and `gBarrierHeight`, along its direction', () => {
    const field = createBarrierField({ r: 0.35, g: 0.25, b: 0.15 }, 2);
    field.sync([{ xa: 0, za: 0, xb: 10, zb: 0, height: 5 }], 25);

    const mesh = firstMesh(field.group);
    expect(field.drawn).toBe(1);
    expect(instanceCount(mesh)).toBe(1);

    // Midpoint (5, 0) in native → scene (5 - 12.5, 0 + 12.5) = (-7.5, +12.5); the wall stands on
    // the ground, so its centre is at half the height.
    const position = positionOf(mesh, 0);
    expect(position.x).toBeCloseTo(-7.5, 6);
    expect(position.y).toBeCloseTo(2.5, 6);
    expect(position.z).toBeCloseTo(12.5, 6);

    const scale = scaleOf(mesh, 0);
    expect(scale.x).toBeCloseTo(10, 6); // the segment's length
    expect(scale.y).toBeCloseTo(5, 6); // gBarrierHeight
    expect(scale.z).toBeCloseTo(1, 6);

    field.dispose();
  });

  it('does not draw a degenerate segment (the `growingBarriers` world boots with them)', () => {
    const field = createBarrierField({ r: 0.35, g: 0.25, b: 0.15 }, 2);
    field.sync([{ xa: 5, za: -5, xb: 5, zb: -5, height: 5 }], 25);
    expect(field.drawn).toBe(0);
    expect(instanceCount(firstMesh(field.group))).toBe(0);
    field.dispose();
  });
});
