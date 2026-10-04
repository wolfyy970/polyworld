/**
 * Lane W1j/L16 — the batched atlas path, and the "no per-agent synchronous readback" criterion.
 *
 * The card's acceptance has two halves: the model logs stay byte-exact (proved against the
 * native pixels in `tests/vision-native-rows.test.ts`) and the raster must be fast, i.e. it must
 * not do what native does — one synchronous `glReadPixels` per agent per step (64 % of wall at
 * 192 agents, PORT_PLAN.md measured fact 6).
 *
 * This test drives `VisionRaster` through a recording WebGL2 double: it counts `readPixels`
 * calls, records every `viewport`/`drawArrays`/uniform call, and synthesizes the atlas contents
 * from the *absolute pixel coordinates* it is asked for. That makes the row addressing
 * (`y + retinaHeight/2`, `x + icol*(w + CELL_PAD)`) checkable end to end: if the port asked for
 * the wrong rectangle, or sliced the wrong row out of the batched readback, the synthesized
 * bytes would not match the expected pattern.
 *
 * The real-context half is `src/model/vision/native/atlas-browser-check.mjs` (headless Chrome
 * over CDP), run by the last test in this file: it rasterizes the atlas on a real WebGL2 context
 * and measures — not assumes — the addressing, the quantization, the depth ties, the per-step GL
 * state arming (with its negative controls) and the batched-vs-per-agent readback equality. It
 * skips when no Chrome is installed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { atlasLayout, readbackRow, rowByteOffset, viewportOf } from '../src/model/vision/atlas';
import { visionCamera } from '../src/model/vision/camera';
import { identity } from '../src/model/vision/matrix';
import { VisionRaster, type VisionScene } from '../src/model/vision/raster';

const RETINA = 22;
const MAX_AGENTS = 25;

interface RecordingGl {
  gl: WebGL2RenderingContext;
  readPixelsCalls: { x: number; y: number; w: number; h: number }[];
  viewports: [number, number, number, number][];
  drawArraysCalls: number;
  clearCalls: number;
  currentViewport: [number, number, number, number];
  /** Every `enable`/`disable`/`depthFunc` call, in order (the raster's GL state arming). */
  stateCalls: string[];
}

/** A WebGL2 double: enough state to record the calls and synthesize the atlas bytes. */
function recordingGl(): RecordingGl {
  const state: RecordingGl = {
    gl: null as unknown as WebGL2RenderingContext,
    readPixelsCalls: [],
    viewports: [],
    drawArraysCalls: 0,
    clearCalls: 0,
    currentViewport: [0, 0, 0, 0],
    stateCalls: [],
  };
  const noop = (): void => {};
  const GL_NAME: Record<number, string> = { 2929: 'DEPTH_TEST', 3042: 'BLEND', 2884: 'CULL_FACE', 513: 'LESS' };
  const nameOf = (value: number): string => GL_NAME[value] ?? String(value);
  const gl: Record<string, unknown> = {
    // constants the raster reads
    DEPTH_TEST: 2929, LESS: 513, BLEND: 3042, CULL_FACE: 2884,
    COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256,
    TEXTURE_2D: 3553, RGBA8: 32856, RGBA: 6408, UNSIGNED_BYTE: 5121, FLOAT: 5126,
    TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240, NEAREST: 9728,
    TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243, CLAMP_TO_EDGE: 33071,
    RENDERBUFFER: 36161, DEPTH_COMPONENT24: 33190, FRAMEBUFFER: 36160,
    COLOR_ATTACHMENT0: 36064, DEPTH_ATTACHMENT: 36096, FRAMEBUFFER_COMPLETE: 36053,
    ARRAY_BUFFER: 34962, STATIC_DRAW: 35044, TRIANGLES: 4,
    VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713, LINK_STATUS: 35714,
    // object creation
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}),
    createFramebuffer: () => ({}), createRenderbuffer: () => ({}), createTexture: () => ({}),
    shaderSource: noop, compileShader: noop, attachShader: noop, linkProgram: noop, deleteShader: noop,
    getShaderParameter: () => true, getProgramParameter: () => true,
    getShaderInfoLog: () => '', getProgramInfoLog: () => '',
    deleteFramebuffer: noop, deleteTexture: noop, deleteRenderbuffer: noop, deleteBuffer: noop, deleteProgram: noop,
    // state
    bindFramebuffer: noop, bindRenderbuffer: noop, bindTexture: noop, bindBuffer: noop,
    texImage2D: noop, texParameteri: noop, renderbufferStorage: noop,
    framebufferTexture2D: noop, framebufferRenderbuffer: noop,
    checkFramebufferStatus: () => 36053,
    enable: (cap: number) => {
      state.stateCalls.push(`enable:${nameOf(cap)}`);
    },
    disable: (cap: number) => {
      state.stateCalls.push(`disable:${nameOf(cap)}`);
    },
    depthFunc: (func: number) => {
      state.stateCalls.push(`depthFunc:${nameOf(func)}`);
    },
    colorMask: noop, clearColor: noop, useProgram: noop,
    clear: () => {
      state.clearCalls++;
    },
    viewport: (x: number, y: number, w: number, h: number) => {
      state.currentViewport = [x, y, w, h];
      state.viewports.push([x, y, w, h]);
    },
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    getAttribLocation: () => 0,
    uniformMatrix4fv: noop, uniform3f: noop, enableVertexAttribArray: noop, vertexAttribPointer: noop,
    bufferData: noop,
    drawArrays: () => {
      state.drawArraysCalls++;
    },
    // Synthesize the framebuffer contents from absolute coordinates: pixel (px, py) gets
    // (px & 0xff, py & 0xff, 0x4d, 0xff). The lane's addressing is then checkable byte for byte.
    readPixels: (x: number, y: number, w: number, h: number, _format: number, _type: number, pixels: Uint8Array) => {
      state.readPixelsCalls.push({ x, y, w, h });
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const px = x + col;
          const py = y + row;
          const at = (row * w + col) * 4;
          pixels[at] = px & 0xff;
          pixels[at + 1] = py & 0xff;
          pixels[at + 2] = 0x4d;
          pixels[at + 3] = 0xff;
        }
      }
    },
  };
  state.gl = gl as unknown as WebGL2RenderingContext;
  return state;
}

function sceneWith(objects: number): VisionScene {
  return {
    objects: Array.from({ length: objects }, () => ({
      model: identity(new Float32Array(16)),
      positions: new Float32Array([0, 0, -1, 1, 0, -1, 0, 1, -1]),
      color: [0.35, 0.25, 0.15] as const,
    })),
  };
}

function camera(): ReturnType<typeof visionCamera> {
  return visionCamera({
    agentFOV: 10,
    minFocus: 20,
    maxFocus: 140,
    invertFocus: false,
    retinaWidth: RETINA,
    retinaHeight: RETINA,
    worldSize: 25,
    eyeHeight: 0.5,
    agentHeight: 0.2,
    fLengthZ: 1,
    agentX: 15.35,
    agentY: 0.1,
    agentZ: -16.72,
    agentYawDeg: 45,
    focus: 0.5,
    enableVisionPitch: false,
    visionPitch: 0.5,
    enableVisionYaw: false,
    visionYaw: 0.5,
  });
}

describe('VisionRaster — the batched atlas', () => {
  it('allocates the 240x72 atlas and its readback target', () => {
    const recorder = recordingGl();
    const raster = new VisionRaster(recorder.gl, {
      maxAgents: MAX_AGENTS,
      retinaWidth: RETINA,
      retinaHeight: RETINA,
    });
    expect({ w: raster.layout.width, h: raster.layout.height }).toEqual({ w: 240, h: 72 });
    expect(raster.readback.length).toBe(240 * 72 * 4);
    expect(raster.rowBytes).toBe(RETINA * 4);
  });

  it('does exactly one readPixels per step, never one per agent', () => {
    const recorder = recordingGl();
    const raster = new VisionRaster(recorder.gl, {
      maxAgents: MAX_AGENTS,
      retinaWidth: RETINA,
      retinaHeight: RETINA,
    });
    const scene = sceneWith(3);
    const steps = 4;
    for (let step = 0; step < steps; step++) {
      raster.beginStep();
      raster.setScene(scene);
      for (let slot = 0; slot < MAX_AGENTS; slot++) raster.drawAgent(slot, camera());
      raster.endStep();
    }
    // 25 agents x 4 steps of rendering, 4 readbacks — native does 100 here (`Retina.cc:116`)
    expect(raster.readbackCount).toBe(steps);
    expect(recorder.readPixelsCalls.length).toBe(steps);
    expect(recorder.drawArraysCalls).toBe(steps * MAX_AGENTS * 3);
    expect(recorder.clearCalls).toBe(steps);
    // every readback is the whole atlas, from the origin
    for (const call of recorder.readPixelsCalls) {
      expect(call).toEqual({ x: 0, y: 0, w: 240, h: 72 });
    }
    expect(raster.singleReadbackCount).toBe(0);
  });

  it('re-arms DEPTH_TEST/LESS/no-blend/no-cull on every beginStep, not just the first', () => {
    // The contract the browser probe measures on a real context (check
    // `gl-state-re-armed-every-step`): the browser shell shares this context and draws in it, so
    // the raster may not rely on its own first step having left the state armed — every step arms
    // it. Four calls per step; the first-step-only arming this replaced emitted them exactly once.
    const recorder = recordingGl();
    const raster = new VisionRaster(recorder.gl, {
      maxAgents: MAX_AGENTS,
      retinaWidth: RETINA,
      retinaHeight: RETINA,
    });
    const scene = sceneWith(1);
    const steps = 3;
    for (let step = 0; step < steps; step++) {
      raster.beginStep();
      raster.setScene(scene);
      raster.drawAgent(0, camera());
      raster.endStep();
    }
    const perStep = ['enable:DEPTH_TEST', 'depthFunc:LESS', 'disable:BLEND', 'disable:CULL_FACE'];
    expect(recorder.stateCalls).toEqual(Array.from({ length: steps }, () => perStep).flat());
  });

  it('slices each agent\'s retina row out of the batched readback at the native offsets', () => {
    const recorder = recordingGl();
    const raster = new VisionRaster(recorder.gl, {
      maxAgents: MAX_AGENTS,
      retinaWidth: RETINA,
      retinaHeight: RETINA,
    });
    raster.beginStep();
    raster.setScene(sceneWith(1));
    for (let slot = 0; slot < MAX_AGENTS; slot++) raster.drawAgent(slot, camera());
    raster.endStep();

    const layout = atlasLayout(MAX_AGENTS, RETINA, RETINA);
    for (const slot of [0, 4, 5, 14, 20, 24]) {
      const viewport = viewportOf(layout, slot);
      const expectedRow = readbackRow(layout, slot);
      // the sampled row is `y + retinaHeight/2` (`Retina.cc:117`)
      expect(expectedRow).toBe(viewport.y + RETINA / 2);

      const row = raster.retinaRow(slot);
      expect(row.length).toBe(RETINA * 4);
      for (let pixel = 0; pixel < RETINA; pixel++) {
        expect(row[pixel * 4]).toBe((viewport.x + pixel) & 0xff);
        expect(row[pixel * 4 + 1]).toBe(expectedRow & 0xff);
        expect(row[pixel * 4 + 2]).toBe(0x4d);
        expect(row[pixel * 4 + 3]).toBe(0xff);
      }
      // and the offset really is the row/column arithmetic, not a coincidence
      const offset = rowByteOffset(layout, slot);
      expect(offset).toBe((expectedRow * 240 + viewport.x) * 4);
    }
  });

  it('sets each agent\'s own viewport and draws the whole snapshot per agent (PN-V4: no culling)', () => {
    const recorder = recordingGl();
    const raster = new VisionRaster(recorder.gl, {
      maxAgents: MAX_AGENTS,
      retinaWidth: RETINA,
      retinaHeight: RETINA,
    });
    const layout = raster.layout;
    raster.beginStep();
    raster.setScene(sceneWith(7));
    for (let slot = 0; slot < MAX_AGENTS; slot++) raster.drawAgent(slot, camera());
    expect(recorder.viewports).toEqual(layout.viewports.map((v) => [v.x, v.y, v.width, v.height]));
    // 7 objects drawn for each of the 25 agents, in the scene's order
    expect(recorder.drawArraysCalls).toBe(MAX_AGENTS * 7);
  });

  it('the batched row equals what a per-viewport readback would have returned', () => {
    // The equivalence the port relies on: reading the whole atlas once and slicing a row gives
    // the same bytes as native's per-agent `glReadPixels` of that viewport. The double
    // synthesizes pixels from absolute coordinates, so this is an identity here by construction
    // — the real-context measurement is `atlas-browser-check.mjs`, which compares all 484 pixels
    // of every one of the 25 viewports against the batched readback of a *rendered* atlas
    // (check `batched-row-equals-viewport-readback`) and reports 0 differing pixels.
    const recorder = recordingGl();
    const raster = new VisionRaster(recorder.gl, {
      maxAgents: MAX_AGENTS,
      retinaWidth: RETINA,
      retinaHeight: RETINA,
    });
    raster.beginStep();
    raster.setScene(sceneWith(2));
    raster.drawAgent(3, camera());

    const single = raster.drawAndReadSingle(3, camera());
    expect(raster.singleReadbackCount).toBe(1);
    expect(raster.readbackCount).toBe(0);

    raster.endStep();
    const layout = raster.layout;
    const viewport = viewportOf(layout, 3);
    const batched = raster.retinaRow(3);
    const singleRowOffset = (RETINA / 2) * viewport.width * 4;
    expect([...single.subarray(singleRowOffset, singleRowOffset + RETINA * 4)]).toEqual([...batched]);
  });

  it('reports the atlas geometry a caller needs to build its own scene (CELL_PAD included)', () => {
    const layout = atlasLayout(3, RETINA, RETINA);
    // 3 agents: ncols = 10, nrows = 1 -> one row of 10 cells (cells 3..9 stay free)
    expect({ ncols: layout.ncols, nrows: layout.nrows, w: layout.width, h: layout.height }).toEqual({
      ncols: 10,
      nrows: 1,
      w: 240,
      h: 24,
    });
    expect(layout.viewports[0]).toMatchObject({ x: 2, y: 0, irow: 0, icol: 0 });
    expect(layout.viewports[2]).toMatchObject({ x: 50, y: 0, irow: 0, icol: 2 });
  });
});

/**
 * The real-context half of the lane's raster evidence.
 *
 * `atlas-browser-check.mjs` builds `native/atlas-probe.ts` with the project's vite, serves it to
 * a headless Chrome over CDP and asserts 16 checks against real rasterization. It skips itself
 * (exit 3) when the machine has no Chrome or no `node_modules/vite`, and this test skips with it —
 * so a machine without a browser still has a green suite, and a machine with one measures the
 * claims rather than assuming them.
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ATLAS_PROBE = join(REPO_ROOT, 'src/model/vision/native/atlas-browser-check.mjs');

/** The report shape this test reads back (subset of `AtlasProbeReport`). */
interface AtlasBrowserReport {
  kind: string;
  passed: boolean;
  context: { version: string; renderer: string };
  layout: { width: number; height: number; viewports: number; samplingRows: number[] };
  steps: {
    step: number;
    label: string;
    readPixels: number;
    readPixelRects: string[];
    drawArrays: number;
    enable: string[];
    disable: string[];
    depthFunc: string[];
  }[];
  state: {
    differingBytesVsStep1: number;
    flippedOutside: { depthTest: boolean; blend: boolean; cullFace: boolean; depthFunc: string };
    afterStep: { depthTest: boolean; blend: boolean; cullFace: boolean; depthFunc: string };
    controls: {
      depthRearmSilenced: { differingBytesVsStep1: number; tieBytes: number[] };
      cullRearmSilenced: { differingBytesVsStep1: number; nonBlackPixels: number };
    };
  };
  equivalence: { pixelsCompared: number; mismatchedPixels: number; distinctFramebuffers: number };
  quantization: { roundMatches: number; pixels: number; truncationMatches: number };
  perf: {
    batched: { median: number; readPixelsPerStep: number };
    perAgentReadback: { median: number; readPixelsPerStep: number };
  };
  checks: { id: string; ok: boolean; detail: string }[];
  failures: string[];
}

function chromeBinary(): string | null {
  const candidates = [
    process.env.CHROME,
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

describe.skipIf(chromeBinary() === null)('VisionRaster — a real WebGL2 context (headless Chrome)', () => {
  it(
    'measures the atlas claims the recording double can only assume',
    () => {
      const chrome = chromeBinary();
      const run = spawnSync(process.execPath, [ATLAS_PROBE, '--json', '--iterations=20'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 240_000,
        env: { ...process.env, CHROME: chrome ?? '' },
      });
      // 3 = the probe's own environment skip (no Chrome / no vite); 1 with `skipped: true` is the
      // same verdict from the driver's failure path.
      if (run.status === 3) {
        console.warn(`atlas-browser-check skipped itself: ${run.stderr.trim()}`);
        return;
      }
      expect(run.error, `spawn failed: ${String(run.error)}`).toBeUndefined();
      expect(run.status, run.stdout || run.stderr).toBe(0);
      const report = JSON.parse(run.stdout) as AtlasBrowserReport;

      expect(report.kind).toBe('polyworld-atlas-browser-check');
      expect(report.passed, report.failures.join('; ')).toBe(true);
      expect(report.failures).toEqual([]);
      expect(report.context.version).toContain('WebGL 2.0');
      expect(report.layout).toMatchObject({ width: 240, height: 72, viewports: 25 });
      expect(report.layout.samplingRows).toEqual(
        Array.from({ length: 25 }, (_, slot) => readbackRow(atlasLayout(25, RETINA, RETINA), slot)),
      );
      // the three rows the packing puts the 25 viewports on (y + 11 for y = 48 / 24 / 0)
      expect([...new Set(report.layout.samplingRows)]).toEqual([59, 35, 11]);

      // one readback per step, against a real context's own call count
      expect(report.steps[0]).toMatchObject({ readPixels: 1, readPixelRects: ['0,0,240,72'] });
      expect(report.steps[0]!.drawArrays).toBe(25 * RETINA + 2);
      expect(report.steps[1]).toMatchObject({ readPixels: 1, drawArrays: 0 });

      // a row sliced out of the batched readback == a per-viewport readback of the same rect
      expect(report.equivalence.mismatchedPixels).toBe(0);
      expect(report.equivalence.pixelsCompared).toBe(25 * RETINA * RETINA);
      expect(report.equivalence.distinctFramebuffers).toBe(1);

      // the flat colour lands as round(255·c), not trunc(255·c)
      expect(report.quantization.pixels).toBeGreaterThan(0);
      expect(report.quantization.roundMatches).toBe(report.quantization.pixels);
      expect(report.quantization.truncationMatches).toBe(0);

      // the state contract: the four calls are re-armed on every step, and the check can fail
      expect(report.steps[2]).toMatchObject({
        enable: ['DEPTH_TEST'],
        disable: ['BLEND', 'CULL_FACE'],
        depthFunc: ['LESS'],
      });
      expect(report.state.flippedOutside).toEqual({ depthTest: false, blend: true, cullFace: true, depthFunc: 'GREATER' });
      expect(report.state.afterStep).toEqual({ depthTest: true, blend: false, cullFace: false, depthFunc: 'LESS' });
      expect(report.state.differingBytesVsStep1).toBe(0);
      expect(report.state.controls.depthRearmSilenced.differingBytesVsStep1).toBeGreaterThan(0);
      expect(report.state.controls.depthRearmSilenced.tieBytes).toEqual([200, 100, 50]);
      expect(report.state.controls.cullRearmSilenced.nonBlackPixels).toBe(0);

      // the fast half: same draws, one readback instead of 25
      expect(report.perf.batched.readPixelsPerStep).toBe(1);
      expect(report.perf.perAgentReadback.readPixelsPerStep).toBe(25);
      expect(report.perf.batched.median).toBeLessThanOrEqual(report.perf.perAgentReadback.median);

      // every named check ran, and the ones this card is about are present
      const ids = report.checks.map((entry) => entry.id);
      expect(ids).toEqual([
        'webgl2-context',
        'atlas-packing',
        'one-readback-per-step',
        'viewport-assignment',
        'draw-and-clear-counts',
        'clear-to-black-every-step',
        'sampled-row-is-stripe-y+height/2',
        'colour-quantizes-to-round-255c',
        'retinaRow-accessor-matches-the-slice',
        'batched-row-equals-viewport-readback',
        'depth-tie-later-quad-loses',
        'depth-nearer-quad-wins',
        'gl-state-re-armed-every-step',
        'step-is-reproducible-after-rearm',
        'perf-batched-readback-is-the-cheap-half',
        'gl-error-clean',
      ]);
      expect(report.checks.every((entry) => entry.ok)).toBe(true);
    },
    300_000,
  );
});
