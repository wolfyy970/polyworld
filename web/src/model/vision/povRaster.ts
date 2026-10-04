/**
 * Lane W1j/L16 — the **window-space rasterizer** the node POV scanner (`povScan.ts`) decides
 * coverage with.
 *
 * Why this module exists: native does not ask "which polygon does this pixel's ray hit" — the
 * fixed-function GL pipeline answers "which polygon covers this pixel *centre*", and it answers
 * it **after** the vertex has been through the viewport transform and been snapped to the
 * driver's sub-pixel grid. Those two questions disagree exactly at the sub-pixel margins, and
 * because every downstream artifact is downstream of the quantized retina byte, a single
 * disagreeing pixel is a whole-run divergence (t_717e215e).
 *
 * The pipeline reproduced here, in the order GL 2.1 applies it (`glspec21` §2.11-2.12):
 *
 *   1. `clip = (P · V) · v_world` — one matrix-vector product per vertex;
 *   2. clip against the near/far planes (`-w ≤ z ≤ w`). Culling is never enabled in the model
 *      path and the side planes need no explicit clip: a pixel *centre* inside the viewport
 *      maps to a ray inside the frustum, so any polygon covering it from the front is already
 *      inside the side planes;
 *   3. perspective divide, then the **viewport transform** — only the viewport's *size* enters;
 *      its integer origin does not, because a sub-pixel grid of `1/2^n` is invariant under an
 *      integer translation (`round((x+k)·2^n)/2^n = round(x·2^n)/2^n + k`);
 *   4. snap each window coordinate to the driver's sub-pixel grid (`SubpixelGrid`; `null` =
 *      unsnapped, for the experiment);
 *   5. fan-tessellate the polygon (`GL_POLYGON` of a convex, planar polygon) and evaluate the
 *      three edge functions at each pixel centre of the sampled row, with the **top-left fill
 *      rule** for samples that land exactly on an edge;
 *   6. depth = the screen-space-interpolated `z/w`, quantized to the depth buffer's fixed point,
 *      under `GL_LESS` against a buffer cleared to 1.0 — i.e. the first polygon in draw order
 *      wins, and a tie loses.
 *
 * PORT-NOTE(vision/raster-subpixel-grid): the grid is a *parameter*, because it is a property of
 * the driver, not of the model. Measured against the 7315-row `minitest_von` dump: an unsnapped
 * projection, a 4-bit and a 12-bit grid all diverge at step 12 (agent 23, pixel 13 — the
 * 0.00145-pixel margin this module exists for), while the 8-bit grid carries the run five dozen
 * steps further before anything else disagrees. So 8 bits is what Apple's GL 2.1 path rasterized
 * on (`SUB_PIXEL_BITS` in `povScan.ts`).
 *
 * PORT-NOTE(vision/raster-precision): the vertex transform is done in binary64 from the f32
 * matrices and the f32 vertices (`povScan.ts` already stores world-space vertices that way), with
 * the clip result rounded to f32 once. That is within ~1e-6 pixel of any f32 accumulation order a
 * driver could have used, i.e. three orders of magnitude below the knife-edge margin this module
 * exists to resolve (0.00145 px in the measured residual). The *grid*, not the arithmetic, is what
 * decides a margin that size.
 */

import type { Mat4 } from './matrix';

/**
 * The driver's sub-pixel precision, as a power of two's exponent: window coordinates are snapped
 * with `round(x · 2^n) / 2^n`. `null` disables snapping (the control case).
 */
export type SubpixelGrid = number | null;

/** One draw-ordered object: a flat colour and the world-space triangles it contributes. */
export interface RasterObject {
  readonly label: string;
  readonly color: readonly [number, number, number];
  /** Triangle soup, 9 doubles per triangle, in native display-list order. */
  readonly tris: Float64Array;
  /** World-space AABB of `tris`: `[minX, minY, minZ, maxX, maxY, maxZ]`, for the row prune. */
  readonly bounds: readonly [number, number, number, number, number, number];
}

/** One fragment a triangle contributed to the sampled row (`onCover`'s payload). */
export interface FragmentCover {
  readonly label: string;
  /** Index into `objects`. */
  readonly object: number;
  /** Byte offset of the triangle inside its object's `tris`. */
  readonly tri: number;
  /** The screen-space-interpolated `z/w` at the sample. */
  readonly ndcZ: number;
  /** Its fixed-point depth-buffer value. */
  readonly depth: number;
  /** Whether `GL_LESS` kept it. */
  readonly kept: boolean;
}

export interface RowRasterOptions {
  /** The retina's width = the viewport's width. */
  readonly width: number;
  /** The retina's height = the viewport's height. */
  readonly height: number;
  /** The window row `glReadPixels` reads, local to the viewport (`height / 2`). */
  readonly rowIndex: number;
  readonly grid: SubpixelGrid;
  /** The top-left fill rule; `false` is the "any edge counts" control case. */
  readonly topLeft: boolean;
  /** `P · V`, column-major: world space → clip space. */
  readonly mvp: Mat4 | Float64Array;
  readonly objects: readonly RasterObject[];
  /** `width * 4` bytes, filled with the quantized readback. */
  readonly out: Uint8Array;
  /** Optional per-sample trace of *winning* fragments (diagnostics only). */
  readonly onSample?: (pixel: number, label: string | null, ndcZ: number) => void;
  /**
   * Optional trace of every *covering* fragment, in draw order, whether or not it passed the
   * depth test (diagnostics only — this is what a knife-edge investigation needs to see).
   */
  readonly onCover?: (pixel: number, cover: FragmentCover) => void;
}

/**
 * The colour byte native's `glReadPixels` returns for a flat float colour: GL's float→ubyte
 * conversion is `round(clamp(c, 0, 1) · 255)`.
 */
export function colorByte(c: number): number {
  return Math.round(255 * Math.min(1, Math.max(0, c)));
}

/** `Math.round` on the grid: `round(x · 2^n) / 2^n`. */
function snap(value: number, grid: SubpixelGrid): number {
  if (grid === null) return value;
  const scale = 2 ** grid;
  return Math.round(value * scale) / scale;
}

/** The f32 store GL's vertex unit ends on. */
function f32(v: number): number {
  return Math.fround(v);
}

/**
 * The 24-bit fixed-point depth the framebuffer holds (`glDepthRange` is the default 0..1, the
 * attachment is 24-bit): `round(clamp(z,0,1) · (2^24 - 1))`.
 */
function depth24(ndcZ: number): number {
  const z = ndcZ * 0.5 + 0.5;
  const clamped = z < 0 ? 0 : z > 1 ? 1 : z;
  return Math.round(clamped * 16777215);
}

/** A clip-space vertex (`x, y, z, w`). */
interface Clip4 {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Sutherland–Hodgman against one half-space of the clip volume: the plane is `coord >= -w` when
 * `lower` (`z >= -w` is the near plane) and `coord <= w` otherwise (`z <= w` is the far plane).
 */
function clipPlane(poly: Clip4[], lower: boolean, coord: (c: Clip4) => number): Clip4[] {
  const out: Clip4[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const da = lower ? coord(a) + a.w : a.w - coord(a);
    const db = lower ? coord(b) + b.w : b.w - coord(b);
    const aIn = da >= 0;
    const bIn = db >= 0;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = da / (da - db);
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        w: a.w + (b.w - a.w) * t,
      });
    }
  }
  return out;
}

/** `-w ≤ z ≤ w`, the near/far planes. */
function clipNearFar(poly: Clip4[]): Clip4[] {
  let p = clipPlane(poly, true, (c) => c.z);
  if (p.length >= 3) p = clipPlane(p, false, (c) => c.z);
  return p;
}

/** The per-row state every triangle contributes fragments to. */
interface RowState {
  width: number;
  sampleY: number;
  topLeft: boolean;
  depth: Int32Array;
  out: Uint8Array;
  onSample: RowRasterOptions['onSample'];
  onCover: RowRasterOptions['onCover'];
  label: string;
  objectIndex: number;
}

/**
 * Rasterize one row: `objects` are sampled in order, so the depth test's ties go to the earlier
 * object, exactly as `GL_LESS` without a depth write on failure does.
 */
export function rasterizeRow(options: RowRasterOptions): void {
  const { width, height, grid, mvp, objects, out } = options;
  const m = mvp;
  const sampleY = options.rowIndex + 0.5;

  // Row depth buffer, cleared to 1.0 by `glClear(GL_DEPTH_BUFFER_BIT)`; the clear colour is
  // `beginStep()`'s (0, 0, 0, 1).
  const depth = new Int32Array(width).fill(16777215);
  for (let i = 0; i < width; i++) {
    out[i * 4] = 0;
    out[i * 4 + 1] = 0;
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 255;
  }

  /** World → clip, one f32 store per component (see PORT-NOTE(vision/raster-precision)). */
  const toClip = (x: number, y: number, z: number): Clip4 => ({
    x: f32(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!),
    y: f32(m[1]! * x + m[5]! * y + m[9]! * z + m[13]!),
    z: f32(m[2]! * x + m[6]! * y + m[10]! * z + m[14]!),
    w: f32(m[3]! * x + m[7]! * y + m[11]! * z + m[15]!),
  });

  /** Clip → window (viewport transform + sub-pixel snap). */
  const toWindow = (c: Clip4): { x: number; y: number; z: number } => ({
    x: snap((c.x / c.w + 1) * 0.5 * width, grid),
    y: snap((c.y / c.w + 1) * 0.5 * height, grid),
    z: c.z / c.w,
  });

  const state: RowState = {
    width,
    sampleY,
    topLeft: options.topLeft,
    depth,
    out,
    onSample: options.onSample,
    onCover: options.onCover,
    label: '',
    objectIndex: -1,
  };

  for (let oi = 0; oi < objects.length; oi++) {
    const object = objects[oi]!;
    // --- per-object row prune: the object's world AABB projected to window space.
    const [minX, minY, minZ, maxX, maxY, maxZ] = object.bounds;
    let px0 = Infinity;
    let py0 = Infinity;
    let px1 = -Infinity;
    let py1 = -Infinity;
    let pruneable = true;
    for (let c = 0; c < 8; c++) {
      const clip = toClip(
        (c & 1) === 0 ? minX : maxX,
        (c & 2) === 0 ? minY : maxY,
        (c & 4) === 0 ? minZ : maxZ,
      );
      if (!(clip.w > 0)) {
        // Straddles the eye plane, so no cheap screen box exists: scan the object in full.
        pruneable = false;
        break;
      }
      const w = toWindow(clip);
      if (w.x < px0) px0 = w.x;
      if (w.x > px1) px1 = w.x;
      if (w.y < py0) py0 = w.y;
      if (w.y > py1) py1 = w.y;
    }
    if (pruneable) {
      // Widen by the snap step so a snapped vertex can never leave the box, plus one pixel of
      // slack for the fill rule and the depth-tie cases.
      const slack = (grid === null ? 0 : 1 / 2 ** grid) + 1;
      if (py1 < options.rowIndex - slack || py0 > options.rowIndex + 1 + slack) continue;
      if (px1 < -slack || px0 > width + slack) continue;
    }

    state.label = object.label;
    state.objectIndex = oi;

    const tris = object.tris;
    for (let t = 0; t + 8 < tris.length; t += 9) {
      const poly = clipNearFar([
        toClip(tris[t]!, tris[t + 1]!, tris[t + 2]!),
        toClip(tris[t + 3]!, tris[t + 4]!, tris[t + 5]!),
        toClip(tris[t + 6]!, tris[t + 7]!, tris[t + 8]!),
      ]);
      if (poly.length < 3) continue;

      const wx: number[] = [];
      const wy: number[] = [];
      const wz: number[] = [];
      for (const c of poly) {
        const w = toWindow(c);
        wx.push(w.x);
        wy.push(w.y);
        wz.push(w.z);
      }

      for (let i = 1; i + 1 < wx.length; i++) {
        rasterizeTriangle(
          state,
          wx[0]!, wy[0]!, wz[0]!,
          wx[i]!, wy[i]!, wz[i]!,
          wx[i + 1]!, wy[i + 1]!, wz[i + 1]!,
          object.color,
          t,
        );
      }
    }
  }
}

/**
 * The edge-function coverage test of one window-space triangle against the sampled row, with the
 * top-left fill rule and the `GL_LESS` depth test.
 *
 * A sample is covered when every edge function has the interior sign, or is `0` on an edge the
 * fill rule counts (a "top" edge — horizontal, running left — or a "left" edge — running down,
 * once the triangle is normalized counter-clockwise). Culling is disabled in the model path, so
 * both windings draw and the normalization is by the sign of the signed area.
 */
function rasterizeTriangle(
  state: RowState,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  color: readonly [number, number, number],
  tri: number,
): void {
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (area === 0) return; // degenerate: GL produces no fragments
  const s = area > 0 ? 1 : -1;

  // Normalize the winding: with `s` folded into every edge function the interior is always the
  // `> 0` side, and the fill rule reads off the *normalized* edge direction.
  const px = [x0, x1, x2];
  const py = [y0, y1, y2];
  const pz = [z0, z1, z2];
  const top: boolean[] = [];
  const left: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const dex = s * (px[j]! - px[i]!);
    const dey = s * (py[j]! - py[i]!);
    top.push(dey === 0 && dex < 0); // a top edge: horizontal, running left
    left.push(dey < 0); // a left edge: running down
  }

  // Row bbox: the triangle can only cover the sampled row within its y range.
  const sy = state.sampleY;
  if (sy < Math.min(y0, y1, y2) || sy > Math.max(y0, y1, y2)) return;

  const xMin = Math.min(x0, x1, x2);
  const xMax = Math.max(x0, x1, x2);
  const { width, depth, out } = state;
  for (let i = 0; i < width; i++) {
    const sx = i + 0.5;
    if (sx < xMin || sx > xMax) continue;

    let inside = true;
    for (let e = 0; e < 3; e++) {
      const j = (e + 1) % 3;
      const v = s * ((px[j]! - px[e]!) * (sy - py[e]!) - (py[j]! - py[e]!) * (sx - px[e]!));
      if (v > 0) continue;
      if (v < 0) {
        inside = false;
        break;
      }
      // Exactly on the edge: the fill rule keeps the sample only on a *top* or *left* edge. The
      // control case (`topLeft === false`) is "any edge counts", which is what a naive
      // `e >= 0` test does and what makes the rule measurable.
      if (!state.topLeft || top[e]! || left[e]!) continue;
      inside = false;
      break;
    }
    if (!inside) continue;

    // Depth: `z/w` is affine in the window coordinates, so barycentric interpolation from the
    // projected corners is exact (up to rounding).
    const w0 = ((py[1]! - py[2]!) * (sx - px[2]!) + (px[2]! - px[1]!) * (sy - py[2]!)) / area;
    const w1 = ((py[2]! - py[0]!) * (sx - px[2]!) + (px[0]! - px[2]!) * (sy - py[2]!)) / area;
    const w2 = 1 - w0 - w1;
    const ndcZ = w0 * pz[0]! + w1 * pz[1]! + w2 * pz[2]!;
    const d = depth24(ndcZ);
    const cover: FragmentCover = {
      label: state.label,
      object: state.objectIndex,
      tri,
      ndcZ,
      depth: d,
      kept: d < depth[i]!,
    };
    if (!cover.kept) {
      state.onCover?.(i, cover);
      continue;
    }

    state.onCover?.(i, cover);
    state.onSample?.(i, state.label, ndcZ);
    depth[i] = d;
    out[i * 4] = colorByte(color[0]);
    out[i * 4 + 1] = colorByte(color[1]);
    out[i * 4 + 2] = colorByte(color[2]);
    out[i * 4 + 3] = 255;
  }
}
