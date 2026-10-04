/**
 * Lane W1j/L16 — the POV **scanner**: `AgentPovRenderer`'s readback on a build with no GL
 * context (the parity runner and the sim's own tests).
 *
 * Native renders every agent's POV into an offscreen framebuffer and copies one row of it into
 * the retina (`QtAgentPovRenderer::render` → `a->GetRetina()->updateBuffer`, `Retina.cc:116-122`).
 * The node runner has no GL, so this module answers the same question the *driver* answered:
 * which polygon covers each pixel centre of that row. Coverage and depth are decided in
 * **window space**, by `povRaster.ts` — projected with the f32 `P·V` matrices, snapped to the
 * driver's sub-pixel grid, edge functions at the pixel centres with the top-left fill rule, and
 * screen-space-interpolated `z/w` under `GL_LESS`.
 *
 * PORT-NOTE(vision/pov-scan-not-a-rays): until t_717e215e this module point-sampled with an
 * exact f64 ray cast. That is the same arithmetic in the limit and it reproduced `microtest_von`
 * byte-for-byte (`t_83dc2e2c`), but it is not the arithmetic native ran: a ray through a pixel
 * *centre* and a rasterized sub-pixel-snapped polygon disagree whenever a silhouette lands
 * within a fraction of a pixel of that centre. `minitest_von`'s first divergence was exactly
 * that — a 0.00145-pixel margin (step 12, agent 23, pixel 13) — and the model is chaotic, so
 * one disagreed pixel poisoned the whole run. The window-space pass is the fidelity the oracle
 * asks for; it is also *cheaper* per step (one row bbox prune instead of a ray triangle sweep).
 *
 * What this module still owns and the rasterizer must not re-decide:
 *
 *   * the scene: `beginStep()` snapshots the world in native display-list order (the set list,
 *     then the cast list — `gstage::Draw()`, `gstage.cc:168-176`) and every object is drawn with
 *     a single `glColor3fv`, so fills are flat (`gpolygon.cc:205`, `:106`);
 *   * `agent::draw` (`agent.cc:1819-1831`): polygons 0-4 with `fNoseColor`, 5-9 with `fColor`,
 *     the model matrix `T·R(yaw)·S` (`gpolyobj::position()` + `glScalef`);
 *   * `gbox::draw`: the unit cube (`gmisc.cc:219-262`) scaled by `fScale · fLength[i]`;
 *   * the camera: `agent.povCamera()` (`agent.ts`) + `visionCamera()` (`vision/camera.ts`),
 *     the same two the port's own `updateVision()` configures;
 *   * the read row: `Retina::updateBuffer` reads `glReadPixels(x, y + height/2, width, 1, …)`
 *     — the single row `floor(height/2)`, whose centres are at `+0.5`;
 *   * the readback is the *quantized* framebuffer byte, `round(255·clamp(c,0,1))` — the same
 *     rule `vision/vector.ts` uses for a colour byte and the one the real-WebGL2 atlas probe
 *     measured (`vision/probe-quantization-offset`).
 *
 * Measured: `microtest_von`'s 25 recorded native retina rows and `minitest_von`'s 7315-row dump
 * are reproduced byte-for-byte from the recorded world (see `PARITY.md`'s L16 row).
 *
 * PORT-NOTE(vision/pov-scan-not-a-rasterizer): this is **not** a substitute for lane L16's
 * batched WebGL2 atlas in the browser — that one renders real geometry at real cost, and the
 * shell keeps it. The scanner exists because the *parity* path is a headless node process: the
 * frozen artifact is the fed neuron value, and the row is a means to it. It refuses rather than
 * guesses wherever the scene is not what it can draw (see `PovScanGeometryError`).
 *
 * PORT-NOTE(vision/pov-scan-scene-order): the snapshot is taken in `beginStep()` — native's
 * `fStage.Compile()` point (`Simulation.cc:1407`, before the vision loop) — and drawn in
 * `gstage::Draw()`'s list order, the set list first and then the cast list (`gstage.cc:168-176`).
 * The ground is drawn whenever the set list carries it: the port's ground is lane L15's loader
 * and is a stub today (`sim/ground-stub`), and `vision-spec.md` §5.5 proves it can never cover
 * the sampled row (it lies strictly below the eye), so its absence moves no pixel.
 */

import { GObjectType } from '../types/simconst';
import { f32 } from '../geometry/float';
import { VisionError } from './encoder';
import {
  identity,
  multiply,
  rotatef,
  translate,
  type Mat4,
} from './matrix';
import { visionCamera, type VisionCameraConfig } from './camera';
import {
  rasterizeRow,
  type FragmentCover,
  type RasterObject,
  type SubpixelGrid,
} from './povRaster';

export { colorByte } from './povRaster';

/** `PovScanRenderer`'s loud failure: something on the path is not what the scanner can draw. */
export class PovScanGeometryError extends VisionError {
  constructor(message: string) {
    super(message);
    this.name = 'PovScanGeometryError';
  }
}

/**
 * The two world lists the vision camera draws, as `gstage` owns them: `fWorldSet` (the ground
 * and the barriers, drawn first) and `fWorldCast` (agents, food, bricks, in insertion order).
 * The sim hands its live views in — the lists change while the world runs (`FoodPatch::addFood`,
 * eaten food removed, agents born and dead).
 */
export interface PovSceneLists {
  /** Native `TSimulation::fWorldSet`. */
  setList(): readonly unknown[];
  /** Native `TSimulation::fWorldCast` (the stage's cast list). */
  castList(): readonly unknown[];
}

/** The per-agent camera numbers, as `agent::SetGraphics`/`UpdateVision` leave them. */
export interface PovCameraNumbers {
  /** `agent::FieldOfView()` — the horizontal FOV in degrees (the focus nerve's result). */
  readonly fovx: number;
  /** `fCamera.SetAspect( fovx * retinaHeight / ( agentFOV * retinaWidth ) )`. */
  readonly aspect: number;
  /** The derived camera pitch/yaw in degrees; `0` when the nerve is disabled. */
  readonly pitch: number;
  readonly yaw: number;
  /** The camera's local offset in the agent's frame (`x` is always 0). */
  readonly localPosition: readonly [number, number, number];
}

/** The agent surface this renderer reads (native `agent::draw` + `GetRetina` + `fCamera`). */
export interface PovAgent {
  x(): number;
  y(): number;
  z(): number;
  /** `fAngle[0]` — the yaw `agent::setyaw` stored (`agent.cc:1159`). */
  yaw(): number;
  color(): readonly [number, number, number];
  noseColor(): readonly [number, number, number];
  povCamera(): PovCameraNumbers;
  povRetina(): { updateRow(row: Uint8Array | Uint8ClampedArray): void };
  /** The scaled body mesh (`agent::SetGeometry`'s `gpolyobj`). */
  readonly deps: { readonly geometry: { numPolygons(): number; polygonVertices(index: number): readonly number[] } };
  /**
   * Native `agent::draw`'s mesh source: the agent's **own** `fPolygon` — the instance its own
   * `agent::SetGeometry()` cloned `agentobj` into and scaled (`Agent.bodyGeometry()`). Optional so
   * a scene-level diagnostic can still hand in `deps.geometry`; production always has it, and
   * `deps.geometry` is the *shared* clone target (`PORT-NOTE(L8/agent-owns-its-mesh)`).
   */
  bodyGeometry?(): { numPolygons(): number; polygonVertices(index: number): readonly number[] };
}

/** A `gboxf` (food, brick): `gbox::draw` draws the unit cube scaled by `fScale * fLength[i]`. */
interface PovBox {
  getType(): number;
  x(): number;
  y(): number;
  z(): number;
  scale: number;
  length: readonly number[];
  color: readonly number[];
}

/** The render config the scanner reads (native `agent::config` + `globals` + `Brain::config`). */
export interface PovScanOptions {
  readonly scene: PovSceneLists;
  /** Native `agent::config.agentFOV` — the *vertical* field of view in degrees. */
  readonly agentFOV: number;
  /** Native `agent::config.eyeHeight`. */
  readonly eyeHeight: number;
  /** Native `agent::config.agentHeight`. */
  readonly agentHeight: number;
  /** Native `Brain::config.retinaWidth` / `retinaHeight`. */
  readonly retinaWidth: number;
  readonly retinaHeight: number;
  /** Native `globals::worldsize` — `fCamera.SetFar( 1.5 * worldsize )`. */
  readonly worldSize: number;
  /**
   * The driver's sub-pixel grid, as a power-of-two exponent (`povRaster.ts`). Defaults to the
   * grid the recorded native rows were rasterized on: `SUB_PIXEL_BITS`.
   */
  readonly subpixelBits?: SubpixelGrid;
  /** The top-left fill rule (`povRaster.ts`); `false` only for the experiment. Default `true`. */
  readonly topLeftFill?: boolean;
}

/**
 * The sub-pixel precision of the GL implementation the recorded native rows came from: Apple's
 * GL 2.1 driver, which rasterizes on a `1/256` grid (8 bits — the precision the measured
 * step-12 margin 13.501451 → 13.5 requires; a 4-bit grid gives the same answer there, and
 * `tests/vision-pov-scan.test.ts` pins it — the "rasterizes on the grid the recorded rows were
 * produced with" case asserts this constant, and the sweep behind it (unsnapped / 4 / 8 / 12 / 16
 * bits against the 7315-row native dump) is recorded in PARITY.md's `vision/raster-subpixel-grid`
 * note).
 */
export const SUB_PIXEL_BITS: SubpixelGrid = 8;

/** The six faces of `drawunitcube()` (`gmisc.cc:219-262`), as index quads into `ucube`. */
const UNIT_CUBE_FACES: readonly (readonly number[])[] = [
  [0, 1, 3, 2],
  [0, 4, 5, 1],
  [4, 6, 7, 5],
  [2, 3, 7, 6],
  [5, 7, 3, 1],
  [0, 2, 6, 4],
];

/** `static const float ucube[8][3]` (`gmisc.cc:25-32`). */
const UNIT_CUBE: readonly (readonly number[])[] = [
  [-0.5, -0.5, -0.5],
  [-0.5, -0.5, 0.5],
  [-0.5, 0.5, -0.5],
  [-0.5, 0.5, 0.5],
  [0.5, -0.5, -0.5],
  [0.5, -0.5, 0.5],
  [0.5, 0.5, -0.5],
  [0.5, 0.5, 0.5],
];

/**
 * `gobject::position()` (`translate` then `rotate` when `fRotated`) followed by `glScalef`,
 * as `gpolyobj::draw`/`agent::draw`/`gbox::draw` build it: `T · R · S`. The scale multiplies the
 * rotation columns, never the translation column.
 */
function modelMatrix(
  x: number,
  y: number,
  z: number,
  yawDeg: number | null,
  sx: number,
  sy: number,
  sz: number,
): Float64Array {
  const m = identity(new Float32Array(16));
  translate(m, x, y, z);
  if (yawDeg !== null) rotatef(m, yawDeg, 0, 1, 0);
  const out = new Float64Array(16);
  for (let c = 0; c < 3; c++) {
    out[c * 4 + 0] = m[c * 4 + 0]! * sx;
    out[c * 4 + 1] = m[c * 4 + 1]! * sy;
    out[c * 4 + 2] = m[c * 4 + 2]! * sz;
    out[c * 4 + 3] = m[c * 4 + 3]!;
  }
  out[12] = m[12]!;
  out[13] = m[13]!;
  out[14] = m[14]!;
  out[15] = m[15]!;
  return out;
}

/** `M · (x, y, z, 1)` in binary64, divided by `w` (the transform `glVertex3fv` + `glScalef` …). */
function transformPoint(
  m: Mat4 | Float64Array,
  x: number,
  y: number,
  z: number,
): [number, number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
  ];
}

/** Append the world-space fan triangulation of a convex polygon (f64 from f32 inputs). */
function appendPolygon(
  out: number[],
  m: Mat4 | Float64Array,
  vertices: readonly number[],
  count: number,
): void {
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  for (let i = 0; i + 2 < count; i += 3) {
    const v = transformPoint(m, vertices[i]!, vertices[i + 1]!, vertices[i + 2]!);
    const w = v[3];
    px.push(v[0] / w);
    py.push(v[1] / w);
    pz.push(v[2] / w);
  }
  for (let i = 1; i + 1 < px.length; i++) {
    out.push(px[0]!, py[0]!, pz[0]!, px[i]!, py[i]!, pz[i]!, px[i + 1]!, py[i + 1]!, pz[i + 1]!);
  }
}

/** Wrap a world-space triangle list as a `RasterObject` (with its AABB, for the row prune). */
function sceneObject(
  label: string,
  tris: number[],
  color: readonly [number, number, number],
): RasterObject {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i]!;
    const y = tris[i + 1]!;
    const z = tris[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (tris.length === 0) {
    // An object with no geometry (a mesh with no polygons) draws nothing; keep it in the list so
    // display order is untouched, but give the prune a box it will reject.
    minX = minY = minZ = 0;
    maxX = maxY = maxZ = 0;
  }
  return {
    label,
    color,
    tris: Float64Array.from(tris),
    bounds: [minX, minY, minZ, maxX, maxY, maxZ],
  };
}

/**
 * The per-step snapshot in native display-list order: the set list (ground, barriers), then the
 * cast list (agents, food, bricks). Exported for the raster diagnostics, which replay one step's
 * scene against the recorded rows.
 */
export function buildSceneObjects(scene: PovSceneLists): RasterObject[] {
  const objects: RasterObject[] = [];
  for (const barrier of scene.setList()) {
    const b = barrier as {
      vertices?: readonly number[];
      color?: { r: number; g: number; b: number };
    };
    if (b?.vertices === undefined || b.color === undefined) {
      throw new PovScanGeometryError(
        'PovScanRenderer: the set list holds an object with no vertices/colour — the POV pass ' +
          'draws set-list objects directly (gstage.cc:168-176); the ground (L15) is a stub today',
      );
    }
    const out: number[] = [];
    appendPolygon(out, identity(new Float32Array(16)), b.vertices, b.vertices.length);
    objects.push(sceneObject('set', out, [b.color.r, b.color.g, b.color.b]));
  }

  for (const object of scene.castList()) {
    const type = (object as { getType?: () => number }).getType?.();
    if (type === GObjectType.AGENT) {
      const a = object as PovAgent;
      const mesh = a.bodyGeometry?.() ?? a.deps.geometry;
      const [nr, ng, nb] = a.noseColor();
      const [br, bg, bb] = a.color();
      const m = modelMatrix(a.x(), a.y(), a.z(), a.yaw(), 1, 1, 1);
      // `agent::draw` (`agent.cc:1819-1831`): polygons 0-4 are the nose, 5-9 the body.
      const nose: number[] = [];
      const body: number[] = [];
      for (let i = 0; i < mesh.numPolygons(); i++) {
        const vertices = mesh.polygonVertices(i);
        appendPolygon(i < 5 ? nose : body, m, vertices, vertices.length);
      }
      objects.push(sceneObject('agent-nose', nose, [nr, ng, nb]));
      objects.push(sceneObject('agent-body', body, [br, bg, bb]));
    } else if (type === GObjectType.FOOD || type === GObjectType.BRICK) {
      const box = object as PovBox;
      const m = modelMatrix(
        box.x(),
        box.y(),
        box.z(),
        null, // `food`/`brick` never rotate: `gobject::rotate()` is a no-op until `SetRotation`
        f32(box.scale * box.length[0]!),
        f32(box.scale * box.length[1]!),
        f32(box.scale * box.length[2]!),
      );
      const out: number[] = [];
      for (const face of UNIT_CUBE_FACES) {
        const flat: number[] = [];
        for (const index of face) flat.push(...UNIT_CUBE[index]!);
        appendPolygon(out, m, flat, flat.length);
      }
      objects.push(
        sceneObject(type === GObjectType.FOOD ? 'food' : 'brick', out, [
          box.color[0]!,
          box.color[1]!,
          box.color[2]!,
        ]),
      );
    } else {
      throw new PovScanGeometryError(
        `PovScanRenderer: cast-list object of type ${String(type)} has no draw path in this port ` +
          '(native draws every cast object; gstage.cc:174-175)',
      );
    }
  }
  return objects;
}

/** The camera config `visionCamera()` needs when the agent supplies the derived numbers. */
export function povCameraConfig(agent: PovAgent, options: PovScanOptions): VisionCameraConfig {
  const camera = agent.povCamera();
  return {
    agentFOV: options.agentFOV,
    minFocus: 0, // unused: `fovx` is supplied, so `fieldOfView()` is never evaluated
    maxFocus: 0,
    invertFocus: false,
    retinaWidth: options.retinaWidth,
    retinaHeight: options.retinaHeight,
    worldSize: options.worldSize,
    eyeHeight: options.eyeHeight,
    agentHeight: options.agentHeight,
    fLengthZ: 0, // unused: `localPosition` is supplied
    agentX: agent.x(),
    agentY: agent.y(),
    agentZ: agent.z(),
    agentYawDeg: agent.yaw(),
    focus: 0,
    enableVisionPitch: false,
    visionPitch: 0,
    enableVisionYaw: false,
    visionYaw: 0,
    fovx: camera.fovx,
    aspect: camera.aspect,
    pitchDeg: camera.pitch,
    yawDeg: camera.yaw,
    localPosition: camera.localPosition,
  };
}

/**
 * `P · V` for one agent's camera — the matrix the whole scene is projected with, so it is built
 * once per agent per step rather than once per vertex.
 */
export function povMvp(agent: PovAgent, options: PovScanOptions, out?: Mat4): Mat4 {
  const { projection, view } = visionCamera(povCameraConfig(agent, options));
  const m = out ?? new Float32Array(16);
  return multiply(m, projection, view);
}

/**
 * Rasterize one agent's retina row into `row` (`width * 4` bytes). Exported so the raster
 * diagnostics can replay a recorded step's scene without the sim.
 */
export function scanAgentRow(
  agent: PovAgent,
  options: PovScanOptions,
  objects: readonly RasterObject[],
  row: Uint8Array,
  onSample?: (pixel: number, label: string | null, ndcZ: number) => void,
  onCover?: (pixel: number, cover: FragmentCover) => void,
): void {
  const height = options.retinaHeight;
  // `Retina::updateBuffer` reads the row at `viewport.y + height/2` (`Retina.cc:117`), i.e. the
  // pixel row `height/2` counted from the viewport's bottom-left origin — one row *above* the
  // optical axis for an even height.
  const rowIndex = Math.floor(height / 2);
  rasterizeRow({
    width: options.retinaWidth,
    height,
    rowIndex,
    grid: options.subpixelBits === undefined ? SUB_PIXEL_BITS : options.subpixelBits,
    topLeft: options.topLeftFill !== false,
    mvp: povMvp(agent, options),
    objects,
    out: row,
    onSample,
    onCover,
  });
}

/**
 * The node/raster-free `AgentPovRenderer` (see the module note). One instance per simulation;
 * `beginStep()` snapshots the world, `render(agent)` rasterizes that agent's retina row and
 * writes it straight into the agent's retina, exactly where native's renderer copies its
 * readback.
 */
export class PovScanRenderer {
  private readonly options: PovScanOptions;
  /** The per-step snapshot, in native display-list order. Empty until `beginStep()`. */
  private objects: RasterObject[] = [];
  /** Bumped by every `beginStep()`; `render()` refuses to scan a stale snapshot. */
  private snapshotStep = -1;
  private stepIndex = -1;

  constructor(options: PovScanOptions) {
    if (!(options.retinaWidth > 0)) {
      throw new PovScanGeometryError(`retinaWidth must be positive, got ${options.retinaWidth}`);
    }
    this.options = options;
  }

  /** Native `AgentPovRenderer::add` — the atlas slot bookkeeping has no arithmetic to copy. */
  add(_agent: unknown): void {}

  /** Native `AgentPovRenderer::remove`. */
  remove(_agent: unknown): void {}

  /** Native `QtAgentPovRenderer::beginStep` + `fStage.Compile()` (PN-V2): snapshot once a step. */
  beginStep(): void {
    this.stepIndex++;
    this.snapshotStep = this.stepIndex;
    this.objects = buildSceneObjects(this.options.scene);
  }

  /** Native `AgentPovRenderer::endStep` — nothing to unwind (no GL state, no FBO). */
  endStep(): void {}

  /**
   * Native `QtAgentPovRenderer::render` + `Retina::updateBuffer`: rasterize this agent's row and
   * copy it into the agent's retina. The encode into `Red`/`Green`/`Blue` happens later, in the
   * brain update (`NervousSystem::update` → `Retina::sensor_update`), exactly as native orders
   * it.
   */
  render(agent: unknown): void {
    if (this.snapshotStep !== this.stepIndex) {
      throw new PovScanGeometryError(
        'PovScanRenderer.render() before beginStep(): the scene snapshot is a step behind',
      );
    }
    const a = agent as PovAgent;
    const target = a.povRetina() as unknown as { updateRow?: (row: Uint8Array) => void };
    if (typeof target?.updateRow !== 'function') {
      // The one failure this module exists to prevent: a vision-on run whose retina is never
      // refreshed is byte-identical to a vision-off run, which is exactly the defect this
      // renderer was written for (t_83dc2e2c). Fail loudly instead.
      throw new PovScanGeometryError(
        "PovScanRenderer.render(): the agent's retina has no updateRow() — it is not a RetinaSensor, " +
          'so a vision-on run would silently keep its prebirth noise',
      );
    }
    const row = new Uint8Array(this.options.retinaWidth * 4);
    scanAgentRow(a, this.options, this.objects, row);
    target.updateRow(row);
  }
}
