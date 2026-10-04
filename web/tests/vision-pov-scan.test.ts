/**
 * Lane L16 — the POV scanner's **coverage and depth rules**, and the two defects that made
 * `minitest_von` a 182/1308 run (`t_717e215e`).
 *
 * The scanner answers native's question, not an approximation of it: which polygon covers each
 * pixel *centre* of the one row `Retina::updateBuffer` reads, decided in **window space** after
 * the viewport transform and the driver's sub-pixel snap (`vision/povRaster.ts`). Two things
 * decided the recorded run, and both are pinned here:
 *
 *   1. the sub-pixel grid (8 bits) plus the top-left fill rule — at `minitest_von` step 12,
 *      agent 23, pixel 13, the wall's corner projects to window x = 13.501451 against a pixel
 *      centre of 13.5, so an unsnapped f64 decision lands outside (the ray-cast answer) and the
 *      snapped one lands exactly on the wall's *left* edge, which the fill rule keeps (native's
 *      answer). It is a 0.00145-pixel margin, and the model is chaotic, so that one pixel decided
 *      the whole run;
 *   2. `agent::draw`'s mesh is the agent's **own** `fPolygon`, not a run-wide one: a single shared
 *      `deps.geometry` meant the last agent to grow rescaled every other agent's body, and at
 *      step 71 it moved every agent's own nose plane off the eye plane.
 *
 * The end-to-end evidence is the harness, not this file: `./oracle/run_parity.sh minitest_von`
 * (1308/1308, `differing=0 missing=0 extra=0`) compares the whole run tree, and the 7315-row
 * native dump in `src/model/vision/golden/minitest_von.retina.jsonl.gz` is what localised both
 * defects. What lives here is the cheap half: the rules themselves, and the two invariants.
 */

import { describe, expect, it } from 'vitest';

import {
  SUB_PIXEL_BITS,
  buildSceneObjects,
  rasterizeRow,
  type RasterObject,
  type SubpixelGrid,
} from '../src/model/vision';
import { identity } from '../src/model/vision/matrix';
import { GObjectType } from '../src/model/types/simconst';
import { AgentBodyGeometry, agentBodyTemplate, createAgentBodyGeometry } from '../src/model/geometry/body';
import { f32 } from '../src/model/geometry/float';
import type { AgentDeps } from '../src/model/agent';

const WIDTH = 22;
const HEIGHT = 22;
const ROW = Math.floor(HEIGHT / 2);

/**
 * The measured margin: the barrier corner projects to window x = 13.501451 (`t_717e215e`'s
 * diagnostic), 0.00145 px to the right of pixel 13's centre. `rasterizeRow` is fed an identity
 * `P·V`, so the "world" coordinates below *are* NDC and the viewport transform maps them exactly
 * as the agent camera does (`x_window = (ndc + 1) · width/2`).
 */
const KNIFE_EDGE_NDC = 13.501451 / (WIDTH / 2) - 1;

/**
 * A vertical wall whose **left** edge is the knife edge (interior to the right) — the orientation
 * the recorded barrier has at `minitest_von` step 12. Drawn white so "covered" is unmistakable.
 */
function leftEdgeScene(): RasterObject[] {
  return [
    {
      label: 'wall-left',
      color: [1, 1, 1],
      tris: Float64Array.from([KNIFE_EDGE_NDC, -2, 0, KNIFE_EDGE_NDC, 5, 0, 5, 2, 0]),
      bounds: [KNIFE_EDGE_NDC, -2, 0, 5, 5, 0],
    },
  ];
}

/** The mirror image: the same vertical edge is the wall's **right** one (interior to the left). */
function rightEdgeScene(): RasterObject[] {
  return [
    {
      label: 'wall-right',
      color: [1, 1, 1],
      tris: Float64Array.from([KNIFE_EDGE_NDC, -2, 0, KNIFE_EDGE_NDC, 5, 0, -5, 2, 0]),
      bounds: [-5, -2, 0, KNIFE_EDGE_NDC, 5, 0],
    },
  ];
}

function scan(grid: SubpixelGrid, topLeft = true, objects = leftEdgeScene()): Uint8Array {
  const out = new Uint8Array(WIDTH * 4);
  rasterizeRow({
    width: WIDTH,
    height: HEIGHT,
    rowIndex: ROW,
    grid,
    topLeft,
    mvp: identity(new Float32Array(16)),
    objects,
    out,
  });
  return out;
}

/** `true` when the pixel is white — i.e. the wall covered its centre. */
function covered(row: Uint8Array, pixel: number): boolean {
  return row[pixel * 4] === 255;
}

describe('POV scanner: window-space coverage', () => {
  it('lets the sub-pixel grid decide the 0.00145-pixel knife edge, exactly as GL did', () => {
    // Unsnapped, the f64 decision: the sample at 13.5 is 0.00145 px outside the wall's left edge.
    expect(covered(scan(null), 13)).toBe(false);
    // On the 8-bit grid the corner snaps *to* 13.5, the sample lands exactly on the wall's left
    // edge, and the top-left fill rule keeps it. This is native's answer, and it is the reason
    // `minitest_von` step 12 stops being a divergence.
    expect(covered(scan(8), 13)).toBe(true);
    // The neighbours are unaffected either way.
    expect(covered(scan(null), 12)).toBe(false);
    expect(covered(scan(8), 12)).toBe(false);
    expect(covered(scan(null), 14)).toBe(true);
    expect(covered(scan(8), 14)).toBe(true);
  });

  it('is the top-left rule, not the snap, that keeps a sample exactly on an edge', () => {
    // The other half of the rule: when the same snapped edge is the wall's *right* boundary, the
    // sample sitting exactly on it is dropped (its edge is neither a top nor a left one).
    expect(covered(scan(8, true, rightEdgeScene()), 13)).toBe(false);
    // Non-vacuity: the control case ("any edge counts") keeps it, so the exclusion above is the
    // rule and not an accident of the sampling.
    expect(covered(scan(8, false, rightEdgeScene()), 13)).toBe(true);
    // ...and both agree on the unambiguous neighbours.
    expect(covered(scan(8, true, rightEdgeScene()), 12)).toBe(true);
    expect(covered(scan(8, true, rightEdgeScene()), 14)).toBe(false);
  });

  it('rasterizes on the grid the recorded rows were produced with', () => {
    // 8 bits = 1/256 px: Apple's GL 2.1 path. Measured against the 7315-row dump: `null`, 4 and
    // 12 bits all diverge at step 12; 8 bits carries the run five dozen steps further, to the
    // point where the *other* defect above takes over. Changing this number changes retina bytes.
    expect(SUB_PIXEL_BITS).toBe(8);
  });

  it('keeps the first fragment on a depth tie and lets a nearer one win (GL_LESS)', () => {
    const plane = (z: number, color: [number, number, number], label: string): RasterObject => ({
      label,
      color,
      tris: Float64Array.from([-2, -2, z, 2, -2, z, 0, 2, z]),
      bounds: [-2, -2, z, 2, 2, z],
    });
    const run = (objects: RasterObject[]): Uint8Array => {
      const out = new Uint8Array(WIDTH * 4);
      rasterizeRow({
        width: WIDTH, height: HEIGHT, rowIndex: ROW, grid: 8, topLeft: true,
        mvp: identity(new Float32Array(16)), objects, out,
      });
      return out;
    };

    // Same depth: the earlier draw wins (a bigger triangle with a *positive* z ... both equal).
    const tie = run([plane(0, [1, 1, 1], 'near-first'), plane(0, [0, 1, 0], 'near-second')]);
    expect(tie[11 * 4]).toBe(255); // white, not the green the second draw would leave

    // The second is nearer in clip z (smaller z = closer): it wins even though it draws later.
    const nearerLater = run([plane(0, [1, 1, 1], 'far'), plane(-0.5, [0, 1, 0], 'near')]);
    expect(nearerLater[11 * 4]).toBe(0);
    expect(nearerLater[11 * 4 + 1]).toBe(255);
  });

  it('clips at the near and far planes and drops degenerate triangles', () => {
    const run = (tris: number[]): Uint8Array => {
      const out = new Uint8Array(WIDTH * 4);
      rasterizeRow({
        width: WIDTH, height: HEIGHT, rowIndex: ROW, grid: 8, topLeft: true,
        mvp: identity(new Float32Array(16)),
        objects: [{ label: 't', color: [1, 1, 1], tris: Float64Array.from(tris), bounds: [-2, -2, -9, 2, 2, 9] }],
        out,
      });
      return out;
    };
    const triangleAt = (z: number): number[] => [-2, -2, z, 2, -2, z, 0, 2, z];
    expect(covered(run(triangleAt(0)), 11)).toBe(true);
    expect(covered(run(triangleAt(-3)), 11)).toBe(false); // beyond the near plane
    expect(covered(run(triangleAt(3)), 11)).toBe(false); // beyond the far plane
    expect(covered(run([0, 0, 0, 0, 0, 0, 0, 0, 0]), 11)).toBe(false); // zero area
  });
});

describe('POV scanner: the scene it feeds', () => {
  const template = agentBodyTemplate();

  /** A stand-in agent that keeps the two meshes distinct, like the real `Agent` does. */
  function fakeAgent(number: number, shared: AgentBodyGeometry, own: AgentBodyGeometry): unknown {
    return {
      getType: () => GObjectType.AGENT,
      getTypeNumber: () => number,
      x: () => 0,
      y: () => 0,
      z: () => 0,
      yaw: () => 0,
      color: () => [1, 0, 0] as const,
      noseColor: () => [0, 1, 1] as const,
      povCamera: () => ({
        fovx: 90, aspect: 1, pitch: 0, yaw: 0, localPosition: [0, 0, 0] as const,
      }),
      povRetina: () => ({ updateRow: () => {} }),
      bodyGeometry: () => own,
      deps: { geometry: shared },
    };
  }

  function sceneObjects(cast: unknown[]): RasterObject[] {
    return buildSceneObjects({ setList: () => [], castList: () => cast });
  }

  it('draws each agent from its own mesh (native fPolygon), not the shared agentobj slot', () => {
    // Two agents grown to different sizes, sharing one `deps.geometry` exactly as lane L11's
    // `TSimulation::deps()` hands it out. Before this seam existed the second agent's
    // `SetGeometry` rescaled the first one's body too (`t_717e215e`, `minitest_von` step 71).
    const shared = createAgentBodyGeometry(template);
    const small = createAgentBodyGeometry(template);
    small.scaleVertices(0.5, 0.2, 0.5);
    const large = createAgentBodyGeometry(template);
    large.scaleVertices(2.0, 0.2, 2.0);

    const objects = sceneObjects([fakeAgent(1, shared, small), fakeAgent(2, shared, large)]);
    expect(objects).toHaveLength(4); // nose + body for each agent

    const noseDepth = (object: RasterObject): number => object.bounds[2]; // min z of the nose
    expect(noseDepth(objects[0]!)).toBeCloseTo(-0.25, 6); // 0.5-scale nose plane = -0.5 · 0.5
    expect(noseDepth(objects[2]!)).toBeCloseTo(-1.0, 6); // 2.0-scale nose plane

    // The shared slot was never scaled by either agent — it is `agent::agentobj`, the template.
    expect(shared.polygonVertices(0)![2]).toBe(f32(-0.5));
  });

  it('falls back to deps.geometry when the agent has no own-mesh accessor', () => {
    const shared = createAgentBodyGeometry(template);
    shared.scaleVertices(1.5, 0.2, 1.5);
    const agent = fakeAgent(1, shared, shared) as Record<string, unknown>;
    delete agent.bodyGeometry;
    const objects = sceneObjects([agent]);
    expect(objects[0]!.bounds[2]).toBeCloseTo(-0.75, 6);
  });
});
