/**
 * Lane L18d — the agent body mesh, decoded from the native `etc/objects/agent.obj`.
 *
 * Native `agent::agentinit()` loads that `pw1` file once (`Resources::loadPolygons( agent::agentobj,
 * "agent" )`, `agent/agent.cc:322`); `agent::SetGeometry()` clones it per agent and mutates the
 * clone by `fLengthX` (x), `agentHeight` (y), `fLengthZ` (z) (`agent.cc:1002-1010`), i.e. a pure
 * per-axis scale of this template. `agent::draw()` then paints two ranges
 * (`agent.cc:1819-1831`):
 *
 *   - polygons **0..4** — the narrow "nose" end — in `fNoseColor` (or `fColor` when the worldfile
 *     says `NoseColor B`, `NC_BODY`);
 *   - polygons **5..9** — the flaring body and front cap — in `fColor`.
 *
 * The split is a native constant (the ranges are literal in `agent::draw`), so the two groups are
 * built here from the same literals. The mesh text itself comes from lane L15's bundled, sha-pinned
 * copy (`model/geometry/body.ts::agentBodyTemplate`, generated from the native file), never a
 * re-typed copy.
 *
 * PORT-NOTE (L18d/agent-triangulation): native draws each polygon with `GL_POLYGON` (a filled
 * convex n-gon, `gpolyobj::drawcolpolyrange`). three.js has no native n-gon; every polygon here is
 * a quad and is fan-triangulated. Culling stays **off** (`QtSceneRenderer` leaves
 * `//glEnable(GL_CULL_FACE)` commented out), so the material is `DoubleSide`, as native is.
 *
 * PORT-NOTE (L18d/agent-mesh-not-scaled-by-fScale): native `agent::draw()` also applies
 * `glScalef(fScale, fScale, fScale)`, but an agent's `fScale` stays at `gobject`'s default `1.0`
 * (nothing sets it), and `agent::SetGeometry` already baked `fLengthX`/`agentHeight`/`fLengthZ`
 * into the clone. The instance scale below is therefore `(lengthX, agentHeight, lengthZ)` exactly.
 */

import * as THREE from 'three';
import { agentBodyTemplate } from '../../model/geometry/body';

/** Native `agent::draw()`'s two polygon ranges (`agent.cc:1825-1828`). */
const NOSE_RANGE: readonly [number, number] = [0, 4];
const BODY_RANGE: readonly [number, number] = [5, 9];

function fanTriangulate(vertices: readonly number[], out: number[]): void {
  const count = Math.floor(vertices.length / 3);
  if (count < 3) return;
  const at = (i: number, c: number): number => vertices[i * 3 + c]!;
  for (let j = 1; j + 1 < count; j++) {
    for (const i of [0, j, j + 1]) {
      out.push(at(i, 0), at(i, 1), at(i, 2));
    }
  }
}

/** A non-indexed position-only geometry (unlit — no normals or uvs are read). */
function meshGeometry(positions: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

export interface AgentMeshes {
  /** Native `fPolygon[0..4]` — drawn in `fNoseColor` (or `fColor` when `NoseColor B`). */
  readonly nose: THREE.BufferGeometry;
  /** Native `fPolygon[5..9]` — drawn in `fColor`. */
  readonly body: THREE.BufferGeometry;
  /** Dispose both geometries. */
  dispose(): void;
}

/**
 * The two drawable groups of the native agent mesh, in template (unit) coordinates. The per-agent
 * scale is applied by the instance matrix, never by rewriting vertices, because every agent's mesh
 * is this same template scaled by its own `(fLengthX, agentHeight, fLengthZ)`.
 */
export function createAgentMeshes(): AgentMeshes {
  const polygons = agentBodyTemplate().polygons;

  const nose: number[] = [];
  const body: number[] = [];
  polygons.forEach((polygon, index) => {
    const target = index >= NOSE_RANGE[0] && index <= NOSE_RANGE[1] ? nose : index >= BODY_RANGE[0] && index <= BODY_RANGE[1] ? body : null;
    if (target !== null) fanTriangulate(polygon.vertices, target);
  });

  const noseGeometry = meshGeometry(nose);
  const bodyGeometry = meshGeometry(body);
  return {
    nose: noseGeometry,
    body: bodyGeometry,
    dispose(): void {
      noseGeometry.dispose();
      bodyGeometry.dispose();
    },
  };
}
