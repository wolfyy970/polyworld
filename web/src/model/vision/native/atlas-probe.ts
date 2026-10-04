/**
 * Lane W1j/L16 — the browser half of the real-WebGL2 atlas probe.
 *
 * `atlas-browser-check.mjs` builds this module with vite, serves it next to a one-line HTML
 * page and drives headless Chrome over CDP. This file is what runs *inside* that page: it
 * builds the 25-agent atlas against a real `WebGL2RenderingContext`, rasterizes a fixture whose
 * every pixel is predictable, and asserts the byte-level claims that the recording GL double in
 * `tests/vision-raster.test.ts` can only prove by construction:
 *
 * * exactly one `readPixels` per step (native: one per agent, `Retina.cc:116-122`);
 * * the sampled row is at `viewport.y + retinaHeight/2` and it is the row that *really* holds
 *   that viewport's pixels, counted from GL's **lower-left** origin;
 * * a row sliced out of the batched readback equals a per-viewport `readPixels` of the same
 *   rectangle, pixel for pixel;
 * * a flat `glColor3fv` colour lands as `round(255·c)`;
 * * depth-test ties resolve by draw order (`GL_LESS`, later equal-depth fragment loses) and a
 *   nearer fragment still wins;
 * * the four GL state calls (`DEPTH_TEST`/`GL_LESS`/no-blend/no-cull) are re-armed on **every**
 *   `beginStep`, so state a caller leaves behind cannot change the atlas — measured against two
 *   negative controls that show the fixture *would* move if they were not
 *   (PORT-NOTE(vision/raster-gl-state-armed-once));
 * * the batched path's per-step wall time, next to the per-agent-readback path native uses.
 *
 * The fixture is not a native-comparable scene (that comparison is `tests/vision-native-rows
 * .test.ts` against the real retina golden); it is deliberately synthetic so that every byte in
 * the atlas is derivable from the slot number and the pixel row.
 *
 * PORT-NOTE(vision/probe-identity-matrices): the fixture draws with **identity** projection,
 * view and model matrices, so a quad in `[-1,1]²` covers its viewport exactly and the only
 * arithmetic between a slot's colour and its readback byte is the atlas addressing under test.
 * The real per-agent camera path (`camera.ts`) is pinned separately against native
 * `glGetFloatv` goldens by `tests/vision-camera.test.ts`; mixing the two here would make a
 * mismatch ambiguous.
 *
 * PORT-NOTE(vision/probe-row-ladder): each slot is filled with a ladder of `retinaHeight`
 * horizontal stripes (pixel row `k` = stripe `k`, counted from the bottom) instead of one flat
 * quad, because the row the encoder samples is the *only* thing this probe exists to check and a
 * flat colour cannot reveal it. A readback origin of upper-left instead of lower-left (the
 * classic WebGL1-vs-`readPixels` confusion) samples stripe `H-1-11 = 10` instead of stripe 11,
 * and the ladder reports that as a byte mismatch. The stripes are disjoint, so they exercise the
 * depth buffer only where the fixture adds overlapping quads.
 *
 * PORT-NOTE(vision/probe-quantization-offset): every stripe's blue channel is fed as
 * `(b8 + 0.6)/255` with `b8` an integer, so `255·c` is `b8 + 0.6` and the expected byte is
 * `b8 + 1`: the assertion discriminates `round(255·c)` from `trunc(255·c)`, which is what the
 * raster's "the framebuffer quantizes on write" claim means. The 0.6 offset is far outside any
 * `mediump`/f16 error in the varying (≈0.1 in these units), so a driver that implements
 * `mediump float` as half precision still asserts the same byte.
 */

import { readbackRow, retinaRow as sliceRetinaRow, rowByteOffset, viewportOf, type AtlasLayout } from '../atlas';
import type { VisionCamera } from '../camera';
import { identity } from '../matrix';
import { VisionRaster, type VisionScene, type VisionSceneObject } from '../raster';

/** `Brain::config.retinaWidth` / `retinaHeight` for the recorded scenarios. */
export const RETINA = 22;
/** `fMaxNumAgents` — the atlas the lane's acceptance is stated for (240×72). */
export const MAX_AGENTS = 25;
/** Slots carrying the depth fixture: equal-depth tie, and a nearer overdrawn quad. */
export const TIE_SLOT = 7;
export const NEAR_SLOT = 8;
/** The stripe the encoder samples: `readbackRow` = `viewport.y + height/2` (integer division). */
export const SAMPLE_STRIPE = Math.trunc(RETINA / 2);

/** `glColor3fv(1, 0.5, 0.25)`-style colour: bytes (200, 100, 50) with no rounding tie. */
const TIE_COLOUR = [200 / 255, 100 / 255, 50 / 255] as const;
/** The nearer quad (NDC z = −0.5 ⇒ window depth 0.25 < 0.5): bytes (10, 220, 130). */
const NEAR_COLOUR = [10 / 255, 220 / 255, 130 / 255] as const;
const TIE_BYTES = [200, 100, 50] as const;
const NEAR_BYTES = [10, 220, 130] as const;

export interface ProbeCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly data?: unknown;
}

interface Counters {
  readPixels: number;
  drawArrays: number;
  clear: number;
  clearColor: number;
  viewport: number;
  enable: number;
  disable: number;
  depthFunc: number;
}

interface CallLog {
  readPixels: { x: number; y: number; w: number; h: number }[];
  viewports: [number, number, number, number][];
  clearColours: [number, number, number, number][];
  enable: string[];
  disable: string[];
  depthFunc: string[];
  /** Every non-null framebuffer bound so far — the atlas FBO, so the probe can read it directly. */
  framebuffers: unknown[];
}

export interface StepSummary {
  readonly step: number;
  readonly label: string;
  readonly drawArrays: number;
  readonly readPixels: number;
  readonly readPixelRects: string[];
  readonly viewportCalls: number;
  readonly clears: number;
  readonly clearColour: string;
  readonly enable: string[];
  readonly disable: string[];
  readonly depthFunc: string[];
  /** The raster's own counter after the step (`readbackCount`). */
  readonly rasterReadbackCount: number;
}

export interface Timing {
  readonly iterations: number;
  readonly mean: number;
  readonly median: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}

export interface AtlasProbeReport {
  readonly kind: 'polyworld-atlas-browser-check';
  readonly probeVersion: number;
  readonly passed: boolean;
  readonly context: Record<string, unknown>;
  readonly layout: Record<string, unknown>;
  readonly steps: readonly StepSummary[];
  readonly equivalence: Record<string, unknown>;
  readonly quantization: Record<string, unknown>;
  readonly depth: Record<string, unknown>;
  readonly state: Record<string, unknown>;
  readonly perf: Record<string, unknown>;
  readonly checks: readonly ProbeCheck[];
  readonly failures: readonly string[];
}

const GL_NAMES: Record<number, string> = {
  2929: 'DEPTH_TEST', 3042: 'BLEND', 2884: 'CULL_FACE',
  513: 'LESS', 515: 'LEQUAL', 516: 'GREATER',
};

function zeroCounters(): Counters {
  return { readPixels: 0, drawArrays: 0, clear: 0, clearColor: 0, viewport: 0, enable: 0, disable: 0, depthFunc: 0 };
}

function emptyLog(): CallLog {
  return { readPixels: [], viewports: [], clearColours: [], enable: [], disable: [], depthFunc: [], framebuffers: [] };
}

function snapshotCounters(counters: Counters): Counters {
  return { ...counters };
}

function delta(before: Counters, after: Counters): Counters {
  return {
    readPixels: after.readPixels - before.readPixels,
    drawArrays: after.drawArrays - before.drawArrays,
    clear: after.clear - before.clear,
    clearColor: after.clearColor - before.clearColor,
    viewport: after.viewport - before.viewport,
    enable: after.enable - before.enable,
    disable: after.disable - before.disable,
    depthFunc: after.depthFunc - before.depthFunc,
  };
}

/**
 * Wrap the *real* context's entry points on the instance (own properties shadow the prototype),
 * so the counts come from the GL calls the raster actually makes, not from a double. Every
 * wrapper delegates to the original bound method; runtime is unaffected beyond the counter.
 */
function instrument(gl: WebGL2RenderingContext): { counters: Counters; log: CallLog } {
  const counters = zeroCounters();
  const log = emptyLog();
  const target = gl as unknown as Record<string, unknown>;
  const patch = (name: string, onCall: (...args: unknown[]) => void): void => {
    const original = (target[name] as (...a: never[]) => unknown).bind(gl);
    target[name] = (...args: never[]): unknown => {
      onCall(...(args as unknown[]));
      return original(...args);
    };
  };

  patch('readPixels', (x, y, w, h) => {
    counters.readPixels++;
    log.readPixels.push({ x: x as number, y: y as number, w: w as number, h: h as number });
  });
  patch('drawArrays', () => {
    counters.drawArrays++;
  });
  // The atlas FBO is created inside VisionRaster; recording what it binds is the only way to
  // read that framebuffer directly (endStep unbinds it and leaves the default one current).
  patch('bindFramebuffer', (_target, framebuffer) => {
    if (framebuffer) log.framebuffers.push(framebuffer);
  });
  patch('clear', () => {
    counters.clear++;
  });
  patch('clearColor', (r, g, b, a) => {
    counters.clearColor++;
    log.clearColours.push([r as number, g as number, b as number, a as number]);
  });
  patch('viewport', (x, y, w, h) => {
    counters.viewport++;
    log.viewports.push([x as number, y as number, w as number, h as number]);
  });
  patch('enable', (cap) => {
    counters.enable++;
    log.enable.push(GL_NAMES[cap as number] ?? String(cap));
  });
  patch('disable', (cap) => {
    counters.disable++;
    log.disable.push(GL_NAMES[cap as number] ?? String(cap));
  });
  patch('depthFunc', (func) => {
    counters.depthFunc++;
    log.depthFunc.push(GL_NAMES[func as number] ?? String(func));
  });

  return { counters, log };
}

/**
 * The native packing expression, transcribed a second time from `QtAgentPovRenderer.cc:39-67`
 * (independent of `atlas.ts`): `i = (int)(sqrt((float)(M*a)) + n - 1) / n`, then integer
 * division, then the `short` cell arithmetic of `:56-64`.
 */
function nativePacking(maxAgents: number, retinaWidth: number, retinaHeight: number) {
  const n = 10;
  const a = 3;
  const i = Math.trunc(Math.trunc(Math.sqrt(Math.fround(maxAgents * a)) + n - 1) / n);
  const ncols = i * n;
  const nrows = Math.trunc((maxAgents + ncols - 1) / ncols);
  const bufferWidth = ncols * (retinaWidth + 2);
  const bufferHeight = nrows * (retinaHeight + 2);
  const viewports = [];
  for (let slot = 0; slot < maxAgents; slot++) {
    const irow = Math.trunc(slot / ncols);
    const icol = slot - ncols * irow;
    const x = icol * (retinaWidth + 2) + 2;
    const ytop = bufferHeight - irow * (retinaHeight + 2) - 2 - 1;
    const y = ytop - retinaHeight + 1;
    viewports.push({ slot, x, y, width: retinaWidth, height: retinaHeight });
  }
  return { ncols, nrows, bufferWidth, bufferHeight, viewports };
}

/** One stripe of a slot's ladder: its colour, and the bytes that colour must produce. */
interface Stripe {
  readonly stripe: number;
  readonly r8: number;
  readonly g8: number;
  readonly b8: number;
  readonly colour: readonly [number, number, number];
  readonly bytes: readonly [number, number, number];
}

function stripeOf(slot: number, stripe: number): Stripe {
  const r8 = slot + 1; // 1..25 — identifies the slot inside its own row
  const g8 = stripe; // 0..21 — identifies the pixel row, counted from the viewport's bottom
  const b8 = 1 + ((7 * slot + 3 * stripe) % 250); // 1..250 — the round-vs-truncation probe
  return {
    stripe,
    r8,
    g8,
    b8,
    colour: [r8 / 255, g8 / 255, (b8 + 0.6) / 255],
    bytes: [r8, g8, b8 + 1],
  };
}

/** Two triangles covering `[x0,x1] × [y0,y1]` at depth `z`, in NDC (identity matrices). */
function quad(x0: number, y0: number, x1: number, y1: number, z: number): Float32Array {
  return new Float32Array([
    x0, y0, z, x1, y0, z, x1, y1, z,
    x0, y0, z, x1, y1, z, x0, y1, z,
  ]);
}

/** The fixture scene for one slot: the ladder, plus the depth fixture on its two slots. */
function slotScene(slot: number): VisionScene {
  const model = identity();
  const objects: VisionSceneObject[] = [];
  for (let stripe = 0; stripe < RETINA; stripe++) {
    const y0 = -1 + (2 * stripe) / RETINA;
    const y1 = -1 + (2 * (stripe + 1)) / RETINA;
    objects.push({ model, positions: quad(-1, y0, 1, y1, 0), color: stripeOf(slot, stripe).colour });
  }
  if (slot === TIE_SLOT) {
    // Same depth as every stripe (NDC z = 0 ⇒ window depth 0.5) and drawn *after* them:
    // with the depth test on and `GL_LESS` this must lose the tie. `gstage.cc:168-176` is the
    // native rule this reproduces (display-list order decides equal depths).
    objects.push({ model, positions: quad(-1, -1, 1, 1, 0), color: TIE_COLOUR });
  }
  if (slot === NEAR_SLOT) {
    // Nearer (window depth 0.25) and drawn after: must win.
    objects.push({ model, positions: quad(-1, -1, 1, 1, -0.5), color: NEAR_COLOUR });
  }
  return { objects };
}

function identityCamera(): VisionCamera {
  return {
    fovx: 0,
    aspect: 1,
    pitch: 0,
    yaw: 0,
    projection: identity(),
    view: identity(),
    localPosition: [0, 0, 0],
  };
}

/** RGBA tuple at (x, y) of a full-atlas readback (GL lower-left origin, as the addressing assumes). */
function pixel(atlas: Uint8Array, layout: AtlasLayout, x: number, y: number): [number, number, number, number] {
  const offset = (y * layout.width + x) * 4;
  return [atlas[offset] ?? -1, atlas[offset + 1] ?? -1, atlas[offset + 2] ?? -1, atlas[offset + 3] ?? -1];
}

/**
 * Pixels of a full-atlas readback that are not the clear colour. Used as a negative control: a
 * byte-equality between two all-black readbacks would pass while proving nothing.
 */
function nonBlack(atlas: Uint8Array): number {
  let count = 0;
  for (let index = 0; index < atlas.length; index += 4) {
    if (atlas[index] !== 0 || atlas[index + 1] !== 0 || atlas[index + 2] !== 0) count++;
  }
  return count;
}

interface RowCheck {
  readonly ok: boolean;
  readonly mismatchedPixels: number;
  readonly firstMismatch: string | null;
}

/**
 * Every pixel of a slot's sampled row must equal `expected`. The row is sliced out of a *given*
 * batched readback with the lane's own `retinaRow`, i.e. the same function the step loop calls;
 * the accessor on the live readback is checked separately (step 2 overwrites it).
 */
function rowIs(
  atlas: Uint8Array,
  layout: AtlasLayout,
  slot: number,
  expected: readonly [number, number, number],
): RowCheck {
  const row = sliceRetinaRow(atlas, layout, slot);
  let mismatched = 0;
  let first: string | null = null;
  for (let pixelIndex = 0; pixelIndex < RETINA; pixelIndex++) {
    const at = pixelIndex * 4;
    const got: [number, number, number, number] = [
      row[at] ?? -1, row[at + 1] ?? -1, row[at + 2] ?? -1, row[at + 3] ?? -1,
    ];
    if (got[0] !== expected[0] || got[1] !== expected[1] || got[2] !== expected[2] || got[3] !== 255) {
      mismatched++;
      if (first === null) {
        first = `pixel ${pixelIndex}: got ${got.join(',')} expected ${expected.join(',')},255`;
      }
    }
  }
  return { ok: mismatched === 0, mismatchedPixels: mismatched, firstMismatch: first };
}

function summarize(samples: readonly number[]): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))] ?? 0;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    iterations: samples.length,
    mean,
    median: at(0.5),
    p95: at(0.95),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function measure(run: () => void, iterations: number, warmup: number): Timing {
  for (let i = 0; i < warmup; i++) run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

export interface AtlasProbeOptions {
  /** Timed iterations per path (default 40). */
  readonly iterations?: number;
  readonly warmup?: number;
}

/**
 * Run the whole probe and return a JSON-serializable report. Never throws for an assertion
 * failure — the failure lands in `checks`/`failures` and `passed` goes false — but a missing
 * WebGL2 context returns early with `passed: false` and one failed check.
 */
export function runAtlasProbe(options: AtlasProbeOptions = {}): AtlasProbeReport {
  const iterations = options.iterations ?? 40;
  const warmup = options.warmup ?? 4;
  const checks: ProbeCheck[] = [];
  const check = (id: string, ok: boolean, detail: string, data?: unknown): void => {
    checks.push(data === undefined ? { id, ok, detail } : { id, ok, detail, data });
  };

  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 72;
  canvas.id = 'atlas';
  document.body.appendChild(canvas);
  const gl = canvas.getContext('webgl2', { antialias: false, depth: true, preserveDrawingBuffer: false });
  if (!gl) {
    return {
      kind: 'polyworld-atlas-browser-check',
      probeVersion: 1,
      passed: false,
      context: { webgl2: false },
      layout: {},
      steps: [],
      equivalence: {},
      quantization: {},
      depth: {},
      state: {},
      perf: {},
      checks: [{ id: 'webgl2-context', ok: false, detail: 'canvas.getContext(webgl2) returned null' }],
      failures: ['webgl2-context: canvas.getContext(webgl2) returned null'],
    };
  }

  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const context: Record<string, unknown> = {
    version: gl.getParameter(gl.VERSION),
    glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxViewportDims: gl.getParameter(gl.MAX_VIEWPORT_DIMS),
    extensions: gl.getSupportedExtensions()?.length ?? 0,
  };

  const { counters, log } = instrument(gl);
  const raster = new VisionRaster(gl, {
    maxAgents: MAX_AGENTS,
    retinaWidth: RETINA,
    retinaHeight: RETINA,
  });
  const layout = raster.layout;
  const camera = identityCamera();
  const samplingRow = layout.viewports.map((_, slot) => readbackRow(layout, slot));

  check(
    'webgl2-context',
    typeof context.version === 'string' && String(context.version).startsWith('WebGL 2.0'),
    `WebGL2 context: ${String(context.version)} / ${String(context.renderer)}`,
    { version: context.version, renderer: context.renderer },
  );

  // ---- the packing, recomputed from the native expression a second time -------------------
  const packing = nativePacking(MAX_AGENTS, RETINA, RETINA);
  const packingDiffs: string[] = [];
  if (layout.width !== 240 || layout.height !== 72) packingDiffs.push(`atlas ${layout.width}x${layout.height} != 240x72`);
  if (layout.width !== packing.bufferWidth || layout.height !== packing.bufferHeight) {
    packingDiffs.push(`atlas ${layout.width}x${layout.height} != native expression ${packing.bufferWidth}x${packing.bufferHeight}`);
  }
  if (layout.ncols !== packing.ncols || layout.nrows !== packing.nrows) {
    packingDiffs.push(`packing ${layout.ncols}x${layout.nrows} != ${packing.ncols}x${packing.nrows}`);
  }
  for (const expected of packing.viewports) {
    const actual = layout.viewports[expected.slot];
    if (
      !actual ||
      actual.x !== expected.x ||
      actual.y !== expected.y ||
      actual.width !== expected.width ||
      actual.height !== expected.height
    ) {
      packingDiffs.push(`slot ${expected.slot}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    }
  }
  for (const slot of [0, 9, 10, 19, 20, 24]) {
    const viewport = viewportOf(layout, slot);
    if (samplingRow[slot] !== viewport.y + SAMPLE_STRIPE) {
      packingDiffs.push(`slot ${slot}: readbackRow ${String(samplingRow[slot])} != y + ${SAMPLE_STRIPE} (${viewport.y + SAMPLE_STRIPE})`);
    }
    if (rowByteOffset(layout, slot) !== (viewport.y + SAMPLE_STRIPE) * layout.width * 4 + viewport.x * 4) {
      packingDiffs.push(`slot ${slot}: rowByteOffset is not (row * width + x) * 4`);
    }
  }
  check(
    'atlas-packing',
    packingDiffs.length === 0,
    packingDiffs.length === 0
      ? `240x72, 10x3 cells, 25 viewports of 22x22; rows ${[...new Set(samplingRow)].join('/')} = y + ${SAMPLE_STRIPE}`
      : packingDiffs.join('; '),
    { samplingRows: samplingRow, distinctSamplingRows: [...new Set(samplingRow)] },
  );

  // ---- the fixture steps ------------------------------------------------------------------
  const steps: StepSummary[] = [];
  const runStep = (step: number, label: string, draw: boolean): { summary: StepSummary; bytes: Uint8Array } => {
    const before = snapshotCounters(counters);
    const logBefore = {
      readPixels: log.readPixels.length,
      viewports: log.viewports.length,
      clearColours: log.clearColours.length,
      enable: log.enable.length,
      disable: log.disable.length,
      depthFunc: log.depthFunc.length,
    };
    raster.beginStep();
    if (draw) {
      for (let slot = 0; slot < MAX_AGENTS; slot++) {
        raster.setScene(slotScene(slot));
        raster.drawAgent(slot, camera);
      }
    }
    raster.endStep();
    const changes = delta(before, counters);
    const rects = log.readPixels.slice(logBefore.readPixels).map((r) => `${r.x},${r.y},${r.w},${r.h}`);
    const clearColour = log.clearColours.slice(logBefore.clearColours).at(-1) ?? [0, 0, 0, 0];
    steps.push({
      step,
      label,
      drawArrays: changes.drawArrays,
      readPixels: changes.readPixels,
      readPixelRects: rects,
      viewportCalls: log.viewports.length - logBefore.viewports,
      clears: changes.clear,
      clearColour: clearColour.join(','),
      enable: log.enable.slice(logBefore.enable),
      disable: log.disable.slice(logBefore.disable),
      depthFunc: log.depthFunc.slice(logBefore.depthFunc),
      rasterReadbackCount: raster.readbackCount,
    });
    return { summary: steps[steps.length - 1]!, bytes: raster.readback.slice() };
  };

  const step1Run = runStep(1, 'fixture (ladder + depth pair)', true);
  const fixture = step1Run.bytes;
  // `raster.retinaRow` reads the *live* readback, which step 2's clear overwrites — capture the
  // accessor's answer for every slot here, and hold every later check to `fixture`.
  const accessorRows = Array.from({ length: MAX_AGENTS }, (_, slot) => [...raster.retinaRow(slot)]);
  // ---- batched row == per-viewport readback, on the *same* rendered frame -------------------
  // This is native's per-agent `glReadPixels(viewport)` (`Retina.cc:116-122`) against the slice
  // of the batched readback. `endStep` unbinds the atlas FBO, so bind the framebuffer the raster
  // itself bound (recorded by the instrumentation) — and read it *now*, because step 2's clear
  // wipes the atlas.
  const atlasFramebuffer = log.framebuffers.at(-1) ?? null;
  const distinctFramebuffers = new Set(log.framebuffers).size;
  gl.bindFramebuffer(gl.FRAMEBUFFER, atlasFramebuffer as WebGLFramebuffer | null);
  const beforeEquivalence = snapshotCounters(counters);
  const single = new Uint8Array(RETINA * RETINA * 4);
  let mismatchedPixels = 0;
  let mismatchedSlots = 0;
  let clearViewports = 0;
  for (let slot = 0; slot < MAX_AGENTS; slot++) {
    const viewport = viewportOf(layout, slot);
    single.fill(0xcd);
    gl.readPixels(viewport.x, viewport.y, viewport.width, viewport.height, gl.RGBA, gl.UNSIGNED_BYTE, single);
    let slotMismatches = 0;
    for (let row = 0; row < viewport.height; row++) {
      for (let col = 0; col < viewport.width; col++) {
        const at = (row * viewport.width + col) * 4;
        const [br, bg, bb, ba] = pixel(fixture, layout, viewport.x + col, viewport.y + row);
        if (single[at] !== br || single[at + 1] !== bg || single[at + 2] !== bb || single[at + 3] !== ba) {
          mismatchedPixels++;
          slotMismatches++;
        }
      }
    }
    // A viewport that never drew would read back as the clear colour; count those so "equal"
    // cannot be "both black" without the reader noticing.
    if (single[0] === 0 && single[1] === 0 && single[2] === 0) clearViewports++;
    if (slotMismatches > 0) mismatchedSlots++;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const equivalenceReadbacks = delta(beforeEquivalence, counters).readPixels;
  const clearOnly = runStep(2, 'clear-only step', false).bytes;

  // ---- one readback per step, and the viewport assignment ---------------------------------
  const stepOne = steps[0]!;
  check(
    'one-readback-per-step',
    stepOne.readPixels === 1 && stepOne.rasterReadbackCount === 1 && stepOne.readPixelRects.join(';') === '0,0,240,72',
    `step 1 issued ${stepOne.readPixels} readPixels (${stepOne.readPixelRects.join('; ')}) with 25 agents drawn; ` +
      `native issues 25 here (Retina.cc:116-122)`,
    { readPixels: stepOne.readPixels, rasterReadbackCount: stepOne.rasterReadbackCount },
  );
  const expectedViewports = layout.viewports.map((v) => `${v.x},${v.y},${v.width},${v.height}`);
  const gotViewports = log.viewports.slice(0, MAX_AGENTS).map((v) => v.join(','));
  check(
    'viewport-assignment',
    stepOne.viewportCalls === MAX_AGENTS && gotViewports.join(';') === expectedViewports.join(';'),
    `step 1 set ${stepOne.viewportCalls} viewports, in slot order, equal to atlasLayout's 25 rectangles`,
    { viewports: gotViewports },
  );
  check(
    'draw-and-clear-counts',
    stepOne.drawArrays === MAX_AGENTS * RETINA + 2 && stepOne.clears === 1 && steps[1]!.drawArrays === 0,
    `${stepOne.drawArrays} drawArrays and 1 clear on step 1 (25 slots × ${RETINA} ladder quads + the tie and near fixture quads); ` +
      `the clear-only step drew ${steps[1]!.drawArrays}`,
  );

  // ---- the clear --------------------------------------------------------------------------
  let clearMismatches = 0;
  let firstClearMismatch: string | null = null;
  for (let y = 0; y < layout.height; y++) {
    for (let x = 0; x < layout.width; x++) {
      const [r, g, b, a] = pixel(clearOnly, layout, x, y);
      if (r !== 0 || g !== 0 || b !== 0 || a !== 255) {
        clearMismatches++;
        if (firstClearMismatch === null) firstClearMismatch = `(${x},${y}) = ${[r, g, b, a].join(',')}`;
      }
    }
  }
  check(
    'clear-to-black-every-step',
    clearMismatches === 0 && steps[1]!.clearColour === '0,0,0,1' && nonBlack(fixture) > 0,
    clearMismatches === 0 && nonBlack(fixture) > 0
      ? `every one of the ${layout.width * layout.height} pixels is (0,0,0,255) after a draw-free step ` +
        `(clearColor 0,0,0,1), while the drawn step left ${nonBlack(fixture)} non-black pixels — the clear really erased them`
      : clearMismatches > 0
        ? `${clearMismatches} pixels survived the clear: ${String(firstClearMismatch)}`
        : 'the drawn step left no non-black pixels, so this check would pass vacuously',
    { clearColour: steps[1]!.clearColour, mismatches: clearMismatches, nonBlackAfterDrawStep: nonBlack(fixture) },
  );

  // ---- the sampled row: bytes, and the lower-left origin ----------------------------------
  const rowProblems: string[] = [];
  const quantization = { roundMatches: 0, truncationMatches: 0, pixels: 0 };
  const rowDetails: Record<string, unknown> = {};
  for (let slot = 0; slot < MAX_AGENTS; slot++) {
    const stripe = stripeOf(slot, SAMPLE_STRIPE);
    const expected: [number, number, number] = slot === NEAR_SLOT ? [...NEAR_BYTES] : [...stripe.bytes];
    const result = rowIs(fixture, layout, slot, expected);
    if (!result.ok) rowProblems.push(`slot ${slot}: ${result.mismatchedPixels}/22 pixels wrong; ${String(result.firstMismatch)}`);
    if (slot === TIE_SLOT || slot === NEAR_SLOT) rowDetails[`slot${slot}`] = expected.join(',');
    if (slot !== NEAR_SLOT) {
      // The blue channel is the quantization probe: `round(255·c)` is `b8 + 1`, `trunc` is `b8`.
      const row = sliceRetinaRow(fixture, layout, slot);
      for (let pixelIndex = 0; pixelIndex < RETINA; pixelIndex++) {
        const blue = row[pixelIndex * 4 + 2] ?? -1;
        quantization.pixels++;
        if (blue === stripe.b8 + 1) quantization.roundMatches++;
        if (blue === stripe.b8) quantization.truncationMatches++;
      }
    }
  }
  check(
    'sampled-row-is-stripe-y+height/2',
    rowProblems.length === 0,
    rowProblems.length === 0
      ? `every slot's retina row is 22 pixels of that slot's stripe ${SAMPLE_STRIPE} colour ` +
        `(R = slot+1, G = ${SAMPLE_STRIPE}); an upper-left readback origin would have sampled stripe ${RETINA - 1 - SAMPLE_STRIPE}`
      : rowProblems.join('; '),
  );
  check(
    'colour-quantizes-to-round-255c',
    quantization.roundMatches === quantization.pixels && quantization.truncationMatches === 0,
    `${quantization.roundMatches}/${quantization.pixels} blue bytes are round(255·c) = b8+1 ` +
      `(blind truncation matches ${quantization.truncationMatches})`,
    { ...quantization },
  );

  // ---- the raster's own accessor, against the same slice of the same bytes -----------------
  const accessorDiffs = Array.from({ length: MAX_AGENTS }, (_, slot) =>
    accessorRows[slot]!.join(',') === [...sliceRetinaRow(fixture, layout, slot)].join(','),
  ).filter((equal) => !equal).length;
  check(
    'retinaRow-accessor-matches-the-slice',
    accessorDiffs === 0,
    accessorDiffs === 0
      ? `raster.retinaRow(slot) equals atlas.retinaRow(readback, layout, slot) for all ${MAX_AGENTS} slots (22 RGBA pixels each, ${MAX_AGENTS * RETINA * 4} bytes compared)`
      : `${accessorDiffs} slots disagree between the accessor and the slice`,
  );

  // ---- batched row == per-viewport readback (measured above, on step 1's frame) -----------
  check(
    'batched-row-equals-viewport-readback',
    mismatchedPixels === 0 && distinctFramebuffers === 1 && clearViewports === 0,
    mismatchedPixels === 0 && clearViewports === 0
      ? `${MAX_AGENTS} per-viewport readPixels of ${RETINA}x${RETINA} agree with the batched readback ` +
        `pixel for pixel (${MAX_AGENTS * RETINA * RETINA} pixels compared, ${mismatchedPixels} differ)`
      : `${mismatchedPixels} of ${MAX_AGENTS * RETINA * RETINA} pixels differ (${mismatchedSlots} slots, ${clearViewports} of them read back as the clear colour); ` +
        `${distinctFramebuffers} distinct framebuffers bound by the raster (expected 1)`,
    {
      slots: MAX_AGENTS,
      pixelsCompared: MAX_AGENTS * RETINA * RETINA,
      mismatchedPixels,
      mismatchedSlots,
      slotsThatReadBackAsClear: clearViewports,
      distinctFramebuffers,
      equivalenceReadbacks,
    },
  );

  // ---- the depth fixture -------------------------------------------------------------------
  const tieRow = rowIs(fixture, layout, TIE_SLOT, stripeOf(TIE_SLOT, SAMPLE_STRIPE).bytes);
  check(
    'depth-tie-later-quad-loses',
    tieRow.ok,
    tieRow.ok
      ? `slot ${TIE_SLOT}: the second, equal-depth quad (bytes ${TIE_BYTES.join(',')}) drawn after the ladder did NOT ` +
        `overwrite it — GL_LESS plus draw order, as gstage.cc:168-176 requires`
      : `slot ${TIE_SLOT}: ${String(tieRow.firstMismatch)}`,
    { tieBytes: TIE_BYTES.join(','), expectedLadderBytes: stripeOf(TIE_SLOT, SAMPLE_STRIPE).bytes.join(',') },
  );
  const nearRow = rowIs(fixture, layout, NEAR_SLOT, NEAR_BYTES);
  check(
    'depth-nearer-quad-wins',
    nearRow.ok,
    nearRow.ok
      ? `slot ${NEAR_SLOT}: the nearer quad (window depth 0.25 vs 0.5) drawn after the ladder overwrote all 22 row pixels`
      : `slot ${NEAR_SLOT}: ${String(nearRow.firstMismatch)}`,
    { nearBytes: NEAR_BYTES.join(',') },
  );

  // ---- the state contract: `beginStep()` re-arms the four calls on *every* step --------------
  // The shell shares this context, so the depth/blend/cull state it leaves behind would change
  // the atlas silently if the raster armed only once. The lane's decision of record (PORT-NOTE
  // `vision/raster-gl-state-armed-once`) is that the port re-arms on every step rather than
  // exporting that hazard as a caller contract, so this asserts the contract on a real context —
  // and, because the assertion "the output is unchanged" is worthless without a configuration
  // that would change it, it carries its own negative controls: the same fixture, the same
  // flipped state, with the raster's arming calls swallowed for one step.
  const flipDepthState = (): void => {
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.depthFunc(gl.GREATER);
  };
  const flipCullState = (): void => {
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT); // the ladder triangles are CCW, so culling front faces removes them
  };
  const stateNow = (): Record<string, unknown> => {
    const depthFunc = gl.getParameter(gl.DEPTH_FUNC) as number;
    return {
      depthTest: gl.getParameter(gl.DEPTH_TEST) as boolean,
      blend: gl.getParameter(gl.BLEND) as boolean,
      cullFace: gl.getParameter(gl.CULL_FACE) as boolean,
      depthFunc: GL_NAMES[depthFunc] ?? String(depthFunc),
    };
  };
  /** Swallow `enable`/`disable`/`depthFunc` for one step; returns the restore. */
  const silenceStateCalls = (): (() => void) => {
    const target = gl as unknown as Record<string, unknown>;
    const saved = { enable: target.enable, disable: target.disable, depthFunc: target.depthFunc };
    const swallow = (): void => {};
    target.enable = swallow;
    target.disable = swallow;
    target.depthFunc = swallow;
    return () => {
      target.enable = saved.enable;
      target.disable = saved.disable;
      target.depthFunc = saved.depthFunc;
    };
  };
  const differingBytesVsStep1 = (bytes: Uint8Array): number => {
    let diffs = 0;
    for (let index = 0; index < fixture.length; index++) {
      if (fixture[index] !== bytes[index]) diffs++;
    }
    return diffs;
  };

  flipDepthState();
  flipCullState();
  const flippedOutside = stateNow();
  const armedStep = runStep(3, 'the four flipped outside, then a step', true);
  const afterStep = stateNow();
  const armedTie = rowIs(armedStep.bytes, layout, TIE_SLOT, stripeOf(TIE_SLOT, SAMPLE_STRIPE).bytes);
  const armedNear = rowIs(armedStep.bytes, layout, NEAR_SLOT, NEAR_BYTES);
  const armedDiffs = differingBytesVsStep1(armedStep.bytes);

  // Negative control 1 (the hazard this replaces, measured the way it was): the same fixture and
  // the same depth/blend/depthFunc flip, but the raster's arming never reaches GL — the
  // equal-depth quad then wins on slot 7, so the assertion above can fail.
  gl.disable(gl.CULL_FACE);
  flipDepthState();
  const restoreDepthCalls = silenceStateCalls();
  const depthControl = runStep(4, 'negative control: depth re-arm silenced', true);
  restoreDepthCalls();
  const depthControlTie = rowIs(depthControl.bytes, layout, TIE_SLOT, TIE_BYTES);
  const depthControlDiffs = differingBytesVsStep1(depthControl.bytes);

  // Negative control 2: the cull half of the re-arm, same construction. The raster's third state
  // call (`disable(CULL_FACE)`) is what keeps the atlas from being culled away.
  flipCullState();
  const restoreCullCalls = silenceStateCalls();
  const cullControl = runStep(5, 'negative control: cull re-arm silenced', true);
  restoreCullCalls();
  const cullControlNonBlack = nonBlack(cullControl.bytes);

  check(
    'gl-state-re-armed-every-step',
    flippedOutside.depthTest === false &&
      flippedOutside.blend === true &&
      flippedOutside.cullFace === true &&
      flippedOutside.depthFunc === 'GREATER' &&
      afterStep.depthTest === true &&
      afterStep.blend === false &&
      afterStep.cullFace === false &&
      afterStep.depthFunc === 'LESS' &&
      armedStep.summary.enable.includes('DEPTH_TEST') &&
      armedStep.summary.disable.includes('BLEND') &&
      armedStep.summary.disable.includes('CULL_FACE') &&
      armedStep.summary.depthFunc.includes('LESS') &&
      armedDiffs === 0 &&
      armedTie.ok &&
      armedNear.ok &&
      nonBlack(fixture) > 0 &&
      depthControlTie.ok &&
      depthControlDiffs > 0 &&
      cullControlNonBlack === 0,
    `the caller left the context flipped (DEPTH_TEST off, BLEND on, depthFunc GREATER, front-face culling on) and ` +
      `beginStep re-armed all four on that step (${armedStep.summary.enable.length} enable, ${armedStep.summary.disable.length} disable, ` +
      `${armedStep.summary.depthFunc.length} depthFunc call), leaving DEPTH_TEST on / BLEND off / CULL_FACE off / LESS: the step's atlas is ` +
      `byte-identical to step 1 (${armedDiffs} of ${fixture.length} bytes differ), slot ${TIE_SLOT} keeps the ladder's ` +
      `${stripeOf(TIE_SLOT, SAMPLE_STRIPE).bytes.join(',')} and slot ${NEAR_SLOT} the nearer quad's ${NEAR_BYTES.join(',')} — ` +
      `the hazard cannot exist. Controls on the same fixture with the re-arm swallowed for one step: depth flipped ⇒ slot ${TIE_SLOT} reads ` +
      `${[...sliceRetinaRow(depthControl.bytes, layout, TIE_SLOT).subarray(0, 3)].join(',')} (the equal-depth quad wins, ${depthControlDiffs} bytes differ from step 1), ` +
      `cull flipped ⇒ ${cullControlNonBlack} non-black pixels of ${fixture.length / 4} (the atlas is culled away) — so an unchanged atlas above is measured, not assumed`,
    {
      flippedOutside,
      afterStep,
      reArmCallsDuringStep: {
        enable: armedStep.summary.enable,
        disable: armedStep.summary.disable,
        depthFunc: armedStep.summary.depthFunc,
      },
      differingBytesVsStep1: armedDiffs,
      tieSlot: TIE_SLOT,
      nearSlot: NEAR_SLOT,
      controls: {
        depthRearmSilenced: {
          differingBytesVsStep1: depthControlDiffs,
          tieBytes: [...sliceRetinaRow(depthControl.bytes, layout, TIE_SLOT).subarray(0, 3)],
          expectedHazardBytes: [...TIE_BYTES],
          mismatchedPixels: depthControlTie.mismatchedPixels,
        },
        cullRearmSilenced: {
          differingBytesVsStep1: differingBytesVsStep1(cullControl.bytes),
          nonBlackPixels: cullControlNonBlack,
        },
      },
    },
  );

  // The context is still flipped by the last control (and the raster's own arming is the only
  // thing that puts it back — no manual re-arm here any more): a plain step must reproduce step 1
  // byte for byte, which also says the per-step clear leaves no stale cells.
  const repeat = runStep(6, 'repeat of step 1 from the flipped context', true).bytes;
  const repeatDiffs = differingBytesVsStep1(repeat);
  check(
    'step-is-reproducible-after-rearm',
    repeatDiffs === 0 && nonBlack(repeat) > 0,
    repeatDiffs === 0 && nonBlack(repeat) > 0
      ? `step 6 reproduces all ${fixture.length} bytes of step 1 (${nonBlack(fixture)} non-black pixels) from the context the last control left behind, with the raster re-arming itself — the per-step clear leaves no stale cells`
      : repeatDiffs === 0
        ? 'both steps read back all-black, so the byte equality proves nothing'
        : `${repeatDiffs} bytes differ between step 1 and step 6`,
    { bytes: fixture.length, differingBytes: repeatDiffs, nonBlackPixels: nonBlack(repeat) },
  );

  // ---- performance: the batched path vs native's per-agent readback ------------------------
  const perfScene: VisionScene = {
    objects: [{ model: identity(), positions: quad(-1, -1, 1, 1, 0), color: [0.4, 0.4, 0.4] }],
  };
  const slots = Array.from({ length: MAX_AGENTS }, (_, slot) => slot);
  const perStep = (run: () => void): { timing: Timing; readPixels: number; drawArrays: number } => {
    const before = snapshotCounters(counters);
    const timing = measure(run, iterations, warmup);
    const changes = delta(before, counters);
    return { timing, readPixels: changes.readPixels, drawArrays: changes.drawArrays };
  };

  const clearOnlyPerf = perStep(() => {
    raster.beginStep();
    raster.endStep();
  });
  const batchedPerf = perStep(() => {
    raster.beginStep();
    raster.setScene(perfScene);
    for (const slot of slots) raster.drawAgent(slot, camera);
    raster.endStep();
  });
  const singlePerf = perStep(() => {
    raster.beginStep();
    raster.setScene(perfScene);
    for (const slot of slots) raster.drawAndReadSingle(slot, camera);
  });

  const performed = iterations + warmup;
  const batchedBytes = layout.width * layout.height * 4;
  const singleBytes = MAX_AGENTS * RETINA * RETINA * 4;
  const perf: Record<string, unknown> = {
    fixture: `${MAX_AGENTS} slots × 1 full-viewport quad (identity matrices), one setScene per step`,
    iterations,
    warmup,
    clearOnly: { ...clearOnlyPerf.timing, readPixelsPerStep: clearOnlyPerf.readPixels / performed, drawArraysPerStep: clearOnlyPerf.drawArrays / performed, bytesPerStep: batchedBytes },
    batched: { ...batchedPerf.timing, readPixelsPerStep: batchedPerf.readPixels / performed, drawArraysPerStep: batchedPerf.drawArrays / performed, bytesPerStep: batchedBytes },
    perAgentReadback: { ...singlePerf.timing, readPixelsPerStep: singlePerf.readPixels / performed, drawArraysPerStep: singlePerf.drawArrays / performed, bytesPerStep: singleBytes },
    nativeForComparison: {
      source: 'PORT_PLAN.md measured fact 6 / PARITY.md vision finding',
      agents: 192,
      msPerStep: 1140,
      readbackShareOfWall: 0.64,
      note: 'one synchronous glReadPixels per agent per step (Retina.cc:116-122)',
      msPerStepAt25Agents: 15,
    },
  };
  check(
    'perf-batched-readback-is-the-cheap-half',
    batchedPerf.readPixels / performed === 1 && singlePerf.readPixels / performed === MAX_AGENTS &&
      batchedPerf.drawArrays / performed === MAX_AGENTS && singlePerf.drawArrays / performed === MAX_AGENTS &&
      batchIsFaster(batchedPerf.timing, singlePerf.timing),
    `same ${MAX_AGENTS} draws per step on both paths; readbacks per step: batched ${batchedPerf.readPixels / performed} ` +
      `(${batchedBytes} bytes), per-agent ${singlePerf.readPixels / performed} (${singleBytes} bytes). ` +
      `Median step: batched ${batchedPerf.timing.median.toFixed(3)} ms vs per-agent ${singlePerf.timing.median.toFixed(3)} ms ` +
      `(native reference: ~15 ms/step at 25 agents, 64 % of wall in readback at 192)`,
    perf,
  );

  const glError = gl.getError();
  check('gl-error-clean', glError === 0, glError === 0 ? 'gl.getError() === NO_ERROR after every phase' : `gl.getError() === 0x${glError.toString(16)}`);

  const failures = checks.filter((entry) => !entry.ok).map((entry) => `${entry.id}: ${entry.detail}`);
  return {
    kind: 'polyworld-atlas-browser-check',
    probeVersion: 1,
    passed: failures.length === 0,
    context,
    layout: {
      width: layout.width,
      height: layout.height,
      ncols: layout.ncols,
      nrows: layout.nrows,
      viewports: layout.viewports.length,
      cell: `${RETINA}x${RETINA}`,
      pad: raster.layout.viewports.length > 0 ? viewportOf(layout, 0).x : 0,
      samplingRows: samplingRow,
    },
    steps,
    equivalence: asRecord(checkById(checks, 'batched-row-equals-viewport-readback')?.data),
    quantization,
    depth: { tieSlot: TIE_SLOT, nearSlot: NEAR_SLOT, ...rowDetails },
    state: asRecord(checkById(checks, 'gl-state-re-armed-every-step')?.data),
    perf,
    checks,
    failures,
  };
}

function checkById(checks: readonly ProbeCheck[], id: string): ProbeCheck | undefined {
  return checks.find((entry) => entry.id === id);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function batchIsFaster(batched: Timing, perAgent: Timing): boolean {
  // The claim under test is "the batched path is the fast half". Allow a floor so a
  // sub-millisecond software-rasterizer measurement (where both paths are dominated by the same
  // 25 draws) is not called a failure for a rounding-level difference.
  return batched.median <= Math.max(perAgent.median * 1.1, perAgent.median - 0.05) || batched.median < perAgent.median;
}

// The driver calls this through `Runtime.evaluate('window.__atlasProbe(...)')`.
(globalThis as unknown as { __atlasProbe?: (options?: AtlasProbeOptions) => AtlasProbeReport }).__atlasProbe = runAtlasProbe;
