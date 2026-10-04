/**
 * Lane W1j/L16 — the batched WebGL2 agent-POV renderer: what replaces the fixed-function GL
 * retina path.
 *
 * Native source: `qtrenderer/renderer/qt/QtAgentPovRenderer.{h,cc}` (the atlas, the per-agent
 * viewport, `render()`'s projection reset + `glViewport` + `a->GetScene().Draw()`, and
 * `Retina::updateBuffer`'s per-agent `glReadPixels`), `PwOffscreenGLSurface.cc:13-51` (the
 * requested GL 2.1 compatibility context: depth 24, stencil 8, no MSAA), plus `sim/Simulation.cc`
 * `UpdateAgents_StaticTimestepGeometry` (:1404-1429) for the per-step order.
 * Spec: `docs/specs/vision-spec.md` §3, §4, §6, §11.
 *
 * What is *kept* from native (all of it semantic):
 *
 * * one atlas buffer per simulation, packed exactly as `QtAgentPovRenderer` packs it
 *   (`atlas.ts`), `clearColor(0,0,0,1)` + one colour+depth clear per step;
 * * one geometry snapshot per step (PN-V1): every agent's retina sees the world as it was when
 *   the step's compile ran — the GPU work is per viewport, never per geometry;
 * * the native draw order (set/world list then cast list, `gstage.cc:168-176`) so depth-test
 *   ties resolve identically — the caller's `objects` array order *is* the draw order;
 * * no frustum culling (PN-V4: `frustumXZ` is written and never read on this path);
 * * depth test on, `GL_LESS`, no blending, no MSAA, flat per-object colour (`glColor3fv`),
 *   and an RGBA8 attachment so the readback is GL's own quantized bytes — plus the fog/light
 *   state native never enables on this path (PORT-NOTE `vision/raster-no-fog-no-lighting`).
 *
 * What *changes* (the point of the lane):
 *
 * * **one `readPixels` per step instead of one per agent.** Native stalls in a synchronous
 *   `glReadPixels` for every agent — 64 % of wall at 192 agents (PORT_PLAN.md, measured) — and
 *   it cannot be made deterministic by construction. Here the whole 240×72 atlas is read once
 *   and each agent's row is a slice of it (`atlas.ts` `retinaRow`). The *values are identical*
 *   because the cells are disjoint and nothing writes outside its own viewport; only the
 *   number of pipeline flushes changes. `readbackCount` exposes the count so a test (or the
 *   HUD) can assert it equals the number of steps.
 *
 * PORT-NOTE(vision/raster-triangulate): GL 2.1 has `GL_POLYGON`; WebGL2 does not. Polyworld's
 * objects are flat convex polygon soups (`opoly` in `gpolygon.cc`), so a fan triangulation of
 * each polygon rasterizes the same flat interior. A non-convex polygon would differ — the
 * model's objects are convex by construction (etc/objects/*.obj), and the scene builders in
 * lanes L10/L15 produce triangles/quads; the caller triangulates, this module just draws
 * triangles.
 *
 * PORT-NOTE(vision/raster-single-attachment): native's offscreen surface has depth 24 and
 * stencil 8. WebGL2's default framebuffer has no stencil; this lane uses an explicit
 * `DEPTH_COMPONENT24` renderbuffer and no stencil, because nothing in the model path writes
 * stencil (no `glStencil*` call exists in `graphics/**`).
 *
 * PORT-NOTE(vision/raster-no-fog-no-lighting): the fragment shader is flat colour — it has no
 * fog term and no light model. Native enables `GL_FOG` only when the worldfile asks for it
 * (`FogFunction != 'O'` → `agent.cc:1030-1031` → `gcamera::SetFog`, `gcamera.cc:331-363`: fog
 * colour = the clear colour, `GL_FOG_START = fNear`), so a world with fog would diverge in
 * *pixels* and therefore in the fed neurons; all four recorded worldfiles say `FogFunction O`
 * (`normalized.wf:219` in each of the oracle scenarios), so nothing frozen is affected.
 * **Lighting cannot diverge**: native has no light model at all — `gstage::SetLightModel`,
 * `gstage::SetLightList` and `gscene::SetDrawLights` have **no** call site anywhere in the
 * tree and no `glEnable(GL_LIGHTING)` exists on this path — so `GL_NORMALIZE`
 * (`QtAgentPovRenderer.cc:117`) is inert here and the port rightly omits it. The fog
 * parameters already reach the port (`src/model/geometry/camera.ts` `setFog`, PORT-NOTE
 * `W1e/fog-data-only`); threading them into this shader is the gap recorded in PARITY.md's
 * L16 section.
 *
 * PORT-NOTE(vision/raster-gl-state-armed-once): the id names **native's** behaviour —
 * `QtAgentPovRenderer::beginStep:111-123` armed `DEPTH_TEST`/`GL_LESS`/no-blend/no-cull once, at
 * the start of the run, because the renderer owned its own `QOpenGLContext`
 * (`PwOffscreenGLSurface.cc:19-28`) and nothing else could touch that state. The port does **not**
 * reproduce that: in the browser the context is the shell's (Three.js draws in it), so any state
 * the shell leaves behind — `DEPTH_TEST` off, a different `depthFunc`, blending on, culling on —
 * silently changes what the raster draws: different atlas pixels, therefore different nerve
 * values, and no gate in the lane would notice, because every check the lane has runs the raster
 * from a bind it controls. A dedicated context per raster is **not** the contract (a WebGL2
 * context is a scarce browser resource); `beginStep()` therefore re-arms all four on **every**
 * step, four calls per step, and the hazard cannot exist. Measured on a real context by the
 * probe's check `gl-state-re-armed-every-step` (`native/atlas-probe.ts`), which flips the four
 * outside the raster between steps and shows the step's bytes are unchanged — and carries its own
 * negative control (silencing the re-arm on the same fixture still flips the depth tie).
 */

import {
  CELL_PAD,
  atlasLayout,
  retinaRow as sliceRetinaRow,
  rowByteLength,
  type AtlasLayout,
} from './atlas';
import { VisionError } from './encoder';
import type { VisionCamera } from './camera';

/** One object of the step's snapshot, in native draw order. */
export interface VisionSceneObject {
  /** The object's model matrix: `position()` (`translate` + `rotate`) then `glScalef`. */
  readonly model: Float32Array;
  /** Triangles as `x, y, z` triples (the caller triangulates — see the PORT-NOTE above). */
  readonly positions: ArrayLike<number>;
  /** `glColor3fv` colour, 0..1 floats; the framebuffer quantizes on write. */
  readonly color: readonly [number, number, number];
}

/** The world as the step's compile saw it (PN-V1). */
export interface VisionScene {
  readonly objects: readonly VisionSceneObject[];
}

export interface VisionRasterOptions {
  /** `fMaxNumAgents` — sizes the atlas (`Simulation.cc:3874`, `normalized.wf:458`). */
  readonly maxAgents: number;
  /** `Brain::config.retinaWidth`. */
  readonly retinaWidth: number;
  /** `Brain::config.retinaHeight`. */
  readonly retinaHeight: number;
}

const VERTEX_SHADER = `
attribute vec3 aPosition;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
uniform vec3 uColor;
varying vec3 vColor;
void main() {
  vColor = uColor;
  gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;

/**
 * The batched agent-POV renderer.
 *
 * Typical use, one iteration per simulation step (native order in brackets):
 *
 * ```ts
 * raster.beginStep();                        // fStage.Compile() + the atlas clear
 * raster.setScene(scene);                    // the compiled display list (PN-V1/V2)
 * for (const agent of agentsInNativeOrder) {
 *   raster.drawAgent(slotOf(agent), cameraOf(agent));   // a->UpdateVision()
 *   // ...the brain update of the same step happens *after all* renders (postParallel)
 * }
 * raster.endStep();                          // the single glReadPixels
 * for (const agent of agentsInNativeOrder) {
 *   retinaOf(agent).updateRow(raster.retinaRow(slotOf(agent)));
 *   retinaOf(agent).sensorUpdate();
 * }
 * ```
 * (The last two loops are separate because native renders every retina inside the loop and
 * encodes inside the following postParallel brain update — the readback is batched here, so
 * the rows are taken after all draws; the values are the same.)
 */
export class VisionRaster {
  readonly layout: AtlasLayout;
  /** The atlas readback target, RGBA8, `layout.width * layout.height * 4` bytes. */
  readonly readback: Uint8Array;
  /** Number of `readPixels` calls so far — one per step by construction. */
  readbackCount = 0;
  /** Number of the *diagnostic* per-viewport readbacks (`drawAndReadSingle`), which the step
   * loop must never use: kept separate so `readbackCount === steps` stays assertable. */
  singleReadbackCount = 0;
  /** Number of `drawArrays` calls so far, for diagnostics/benchmarks. */
  drawCalls = 0;

  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: {
    projection: WebGLUniformLocation;
    view: WebGLUniformLocation;
    model: WebGLUniformLocation;
    color: WebGLUniformLocation;
  };
  private readonly positionBuffer: WebGLBuffer;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly colorTexture: WebGLTexture;
  private readonly depthBuffer: WebGLRenderbuffer;
  private scene: VisionScene = { objects: [] };
  /** Interleaved vertex data for the whole snapshot, uploaded once per step. */
  private vertexData = new Float32Array(0);

  constructor(gl: WebGL2RenderingContext, options: VisionRasterOptions) {
    this.gl = gl;
    this.layout = atlasLayout(options.maxAgents, options.retinaWidth, options.retinaHeight);
    this.readback = new Uint8Array(this.layout.width * this.layout.height * 4);

    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    const location = (name: string): WebGLUniformLocation => {
      const uniform = gl.getUniformLocation(this.program, name);
      if (!uniform) throw new VisionError(`vision raster: uniform '${name}' is not active`);
      return uniform;
    };
    this.uniforms = {
      projection: location('uProjection'),
      view: location('uView'),
      model: location('uModel'),
      color: location('uColor'),
    };

    const positionBuffer = gl.createBuffer();
    if (!positionBuffer) throw new VisionError('vision raster: no vertex buffer');
    this.positionBuffer = positionBuffer;

    const framebuffer = gl.createFramebuffer();
    const colorTexture = gl.createTexture();
    const depthBuffer = gl.createRenderbuffer();
    if (!framebuffer || !colorTexture || !depthBuffer) {
      throw new VisionError('vision raster: no offscreen target');
    }
    this.framebuffer = framebuffer;
    this.colorTexture = colorTexture;
    this.depthBuffer = depthBuffer;
    this.allocateTarget();

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new VisionError(`vision raster: incomplete atlas framebuffer (0x${status.toString(16)})`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** The atlas target: RGBA8 colour + DEPTH_COMPONENT24, single-sample (native: no MSAA). */
  private allocateTarget(): void {
    const gl = this.gl;
    const { width, height } = this.layout;
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuffer);
  }

  /**
   * `QtAgentPovRenderer::beginStep` (`:111-130`) plus the atlas clear (`:129-130`) — with one
   * deliberate difference: the four state calls are re-armed on **every** step, not once
   * (PORT-NOTE `vision/raster-gl-state-armed-once`).
   */
  beginStep(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.enable(gl.DEPTH_TEST); // `:116`
    gl.depthFunc(gl.LESS); // GL's default, stated because the native code relies on it
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE); // native never enables culling
    gl.clearColor(0, 0, 0, 1); // `:129`
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); // `:130`
  }

  /**
   * Hand the step's geometry snapshot to the renderer (PN-V1). Vertices are uploaded once per
   * step into one buffer; each object is then a `drawArrays` range under its own model matrix.
   */
  setScene(scene: VisionScene): void {
    const gl = this.gl;
    let total = 0;
    for (const object of scene.objects) total += object.positions.length;
    if (this.vertexData.length < total) this.vertexData = new Float32Array(total);
    let offset = 0;
    for (const object of scene.objects) {
      this.vertexData.set(object.positions as ArrayLike<number>, offset);
      offset += object.positions.length;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData.subarray(0, total), gl.STATIC_DRAW);
    this.scene = scene;
  }

  /**
   * `QtAgentPovRenderer::render` (`:136-154`) for one slot: reset the projection, set this
   * agent's viewport, then draw the whole snapshot with the agent's camera. No per-agent
   * readback (`Retina::updateBuffer` is replaced by the batched read in `endStep`).
   */
  drawAgent(slot: number, camera: VisionCamera): void {
    const gl = this.gl;
    const viewport = this.layout.viewports[slot];
    if (!viewport) throw new VisionError(`no atlas slot ${slot}`);

    gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height); // `:145`
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.projection, false, camera.projection);
    gl.uniformMatrix4fv(this.uniforms.view, false, camera.view);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    const positionAttribute = gl.getAttribLocation(this.program, 'aPosition');
    gl.enableVertexAttribArray(positionAttribute);
    gl.vertexAttribPointer(positionAttribute, 3, gl.FLOAT, false, 0, 0);

    let first = 0;
    for (const object of this.scene.objects) {
      const count = object.positions.length / 3;
      if (count === 0) continue;
      gl.uniformMatrix4fv(this.uniforms.model, false, object.model);
      gl.uniform3f(this.uniforms.color, object.color[0], object.color[1], object.color[2]);
      gl.drawArrays(gl.TRIANGLES, first, count);
      this.drawCalls++;
      first += count;
    }
  }

  /**
   * The batched readback: **one** `glReadPixels` for the whole atlas, versus native's one per
   * agent. `glReadPixels` keeps GL's lower-left origin in WebGL2, so `atlas.ts`'s addressing
   * applies unchanged (spec §11.1).
   */
  endStep(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.readPixels(
      0,
      0,
      this.layout.width,
      this.layout.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.readback,
    );
    this.readbackCount++;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** One agent's retina row out of the last batched readback (`Retina::updateBuffer`'s row). */
  retinaRow(slot: number): Uint8Array {
    return sliceRetinaRow(this.readback, this.layout, slot);
  }

  /** Bytes per retina row (88 for `retinaWidth = 22`). */
  get rowBytes(): number {
    return rowByteLength(this.layout);
  }

  /**
   * The one-agent-at-a-time path, for a *test or a debugging view* — it renders a single slot
   * and reads that viewport back synchronously. Never call this in the step loop: it is exactly
   * the native behaviour this lane removes (kept so the batched path can be differentially
   * tested against it, which `tests/vision-raster.test.ts` does).
   */
  drawAndReadSingle(slot: number, camera: VisionCamera): Uint8Array {
    const gl = this.gl;
    this.drawAgent(slot, camera);
    const viewport = this.layout.viewports[slot]!;
    const out = new Uint8Array(viewport.width * viewport.height * 4);
    gl.readPixels(viewport.x, viewport.y, viewport.width, viewport.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    this.singleReadbackCount++;
    return out;
  }

  /** Free the GL objects (a simulation that is torn down; native `delete fPixelBuffer`). */
  dispose(): void {
    const gl = this.gl;
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteTexture(this.colorTexture);
    gl.deleteRenderbuffer(this.depthBuffer);
    gl.deleteBuffer(this.positionBuffer);
    gl.deleteProgram(this.program);
  }
}

/** The atlas size and cell geometry for a configuration, without touching GL. */
export function atlasFor(options: VisionRasterOptions): AtlasLayout {
  return atlasLayout(options.maxAgents, options.retinaWidth, options.retinaHeight);
}

/** `CELL_PAD`, exported so a caller building its own atlas agrees on the padding. */
export { CELL_PAD };

function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new VisionError('vision raster: no shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new VisionError(`vision raster: shader failed to compile: ${gl.getShaderInfoLog(shader) ?? ''}`);
    }
    return shader;
  };
  const program = gl.createProgram();
  if (!program) throw new VisionError('vision raster: no program');
  const vs = compile(gl.VERTEX_SHADER, vertex);
  const fs = compile(gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new VisionError(`vision raster: program failed to link: ${gl.getProgramInfoLog(program) ?? ''}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}
