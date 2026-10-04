/**
 * Lane W1j/L16 — the POV atlas: how many retina viewports fit in one offscreen buffer and
 * where each one lives.
 *
 * Native source: `qtrenderer/renderer/qt/QtAgentPovRenderer.cc:28-104` (ctor + `add/remove`).
 * Spec: `docs/specs/vision-spec.md` §4.
 *
 * The native renderer keeps **one** offscreen buffer per simulation and gives each agent a
 * cell of it (`fFreeViewports`, a `std::map<int, Viewport*>`, so slots are handed out
 * lowest-index-first and returned on removal). The port keeps the same packing and the same
 * per-slot geometry, because the retina row is addressed by it (`Retina.cc:116-122` reads
 * `(x, y + height/2)` out of the *viewport*).
 *
 * PORT-NOTE(vision/atlas-slot-freedom): which slot an agent occupies depends on allocation
 * history, and the spec proves it cannot affect any brain input — cells are disjoint, each
 * agent's `render()` sets its own viewport and its own projection, and the depth buffer is
 * cleared once for the whole atlas before the per-agent draws. So a batched renderer may
 * assign slots in any order (§4). `AtlasLayout` therefore exposes the packing, and the
 * batched readback addresses rows by slot, not by agent.
 */

import { VisionError } from './encoder';

/** `#define CELL_PAD 2` (`QtAgentPovRenderer.cc:13`). */
export const CELL_PAD = 2;

/** One retina viewport inside the atlas (native `struct Viewport`, `QtAgentPovRenderer`). */
export interface AtlasViewport {
  /** `viewport->index` — also the slot number. */
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** `irow = i / ncols` — the cell row, counted from the *bottom* like GL. */
  readonly irow: number;
  /** `icol = i - ncols*irow`. */
  readonly icol: number;
}

export interface AtlasLayout {
  readonly maxAgents: number;
  readonly retinaWidth: number;
  readonly retinaHeight: number;
  /** Cells across (`ncols`), a multiple of 10. */
  readonly ncols: number;
  readonly nrows: number;
  /** `fBufferWidth` / `fBufferHeight` in pixels. */
  readonly width: number;
  readonly height: number;
  readonly viewports: readonly AtlasViewport[];
}

/**
 * The native packing (`QtAgentPovRenderer.cc:39-67`).
 *
 * ```c
 * int n = 10; int a = 3;
 * int i = (int)( sqrt( (float)(maxAgents*a) ) + n - 1 ) / n;   // truncation, then int div
 * int ncols = i * n;
 * int nrows = (maxAgents + ncols - 1) / ncols;
 * ```
 * Note the arithmetic: `maxAgents*a` is `int`, cast to `float` (exact here), *double*
 * `sqrt` of it, `+ n - 1` in double, then `(int)` truncates toward zero, then integer
 * division. The port reproduces that order literally rather than simplifying it — the
 * packing decides the readback addressing (`README`-level reasoning, and spec §4's worked
 * example: `maxAgents = 25, retina = 22 → 240 x 72`, i.e. `i = 1`, `ncols = 10`,
 * `nrows = 3`).
 */
export function atlasLayout(maxAgents: number, retinaWidth: number, retinaHeight: number): AtlasLayout {
  if (!Number.isInteger(maxAgents) || maxAgents <= 0) {
    throw new VisionError(`atlas needs at least one agent slot, got maxAgents=${maxAgents}`);
  }
  const n = 10;
  const a = 3;
  // PORT-NOTE(vision/atlas-packing): the `(float)` cast is `Math.fround`; `sqrt` of that
  // value is computed in double (C: `sqrt` is the double overload), `+ 9` stays double,
  // `(int)` truncates, and only then does the integer division by `n` happen.
  const i = Math.trunc(Math.trunc(Math.sqrt(Math.fround(maxAgents * a)) + n - 1) / n);
  const ncols = i * n;
  if (ncols <= 0) {
    // Native divides by ncols here; a 0-sized atlas is UB in the native code, so the port
    // refuses instead (PORT-NOTE(vision/atlas-zero-cols)).
    throw new VisionError(`atlas packing produced ncols=0 for maxAgents=${maxAgents}`);
  }
  const nrows = Math.trunc((maxAgents + ncols - 1) / ncols);
  const width = ncols * (retinaWidth + CELL_PAD);
  const height = nrows * (retinaHeight + CELL_PAD);

  const viewports: AtlasViewport[] = [];
  for (let slot = 0; slot < maxAgents; slot++) {
    const irow = Math.trunc(slot / ncols);
    const icol = slot - ncols * irow;
    const x = icol * (retinaWidth + CELL_PAD) + CELL_PAD;
    const ytop = height - irow * (retinaHeight + CELL_PAD) - CELL_PAD - 1;
    const y = ytop - retinaHeight + 1;
    viewports.push({ index: slot, x, y, width: retinaWidth, height: retinaHeight, irow, icol });
  }
  return { maxAgents, retinaWidth, retinaHeight, ncols, nrows, width, height, viewports };
}

/**
 * The row `Retina::updateBuffer` samples: `y + height/2` (`Retina.cc:117`, integer division).
 * For `retinaHeight = 22` that is `y + 11` — the row immediately *above* the viewport's
 * vertical centre line, which spec §5.5 identifies as the horizon band (the ground can
 * never appear there).
 */
export function readbackRow(layout: AtlasLayout, slot: number): number {
  const viewport = viewportOf(layout, slot);
  return viewport.y + Math.trunc(viewport.height / 2);
}

export function viewportOf(layout: AtlasLayout, slot: number): AtlasViewport {
  const viewport = layout.viewports[slot];
  if (!viewport) throw new VisionError(`no atlas slot ${slot} (maxAgents=${layout.maxAgents})`);
  return viewport;
}

/** Byte offset of a slot's retina row inside a full-atlas RGBA8 readback. */
export function rowByteOffset(layout: AtlasLayout, slot: number): number {
  const viewport = viewportOf(layout, slot);
  return (readbackRow(layout, slot) * layout.width + viewport.x) * 4;
}

/** Bytes per retina row: `retinaWidth` RGBA pixels (`Retina.cc:22-31`). */
export function rowByteLength(layout: AtlasLayout): number {
  return layout.retinaWidth * 4;
}

/**
 * Slice one agent's retina row out of a full-atlas readback.
 *
 * PORT-NOTE(vision/atlas-batched-readback): native issues one `glReadPixels` per agent
 * (`Retina.cc:116-122`), each a pipeline flush — 64 % of wall at 192 agents
 * (PORT_PLAN.md, measured). The port draws every viewport and reads the *whole* atlas once
 * (`readPixels(0, 0, W, H, RGBA, UNSIGNED_BYTE, …)`), then addresses rows arithmetically.
 * `glReadPixels` keeps GL's lower-left origin in WebGL2 exactly as in GL 2.1, so the
 * addressing is unchanged; the *values* are identical because the cells are disjoint and
 * nothing writes outside its viewport.
 */
export function retinaRow(
  atlas: Uint8Array | Uint8ClampedArray,
  layout: AtlasLayout,
  slot: number,
): Uint8Array {
  const offset = rowByteOffset(layout, slot);
  const length = rowByteLength(layout);
  if (offset + length > atlas.length) {
    throw new VisionError(
      `retina row ${slot} out of range: need ${offset + length} bytes of readback, have ${atlas.length}`,
    );
  }
  return atlas instanceof Uint8Array
    ? atlas.subarray(offset, offset + length)
    : new Uint8Array(atlas.buffer, atlas.byteOffset + offset, length);
}
