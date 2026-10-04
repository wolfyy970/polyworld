/**
 * Lane W1j/L16 — the retina *encoder*: the exact arithmetic that turns one rendered
 * retina row into the doubles the brain reads.
 *
 * This is the acceptance surface of the vision lane. PARITY.md's vision finding says the
 * native model is reproducible with vision on (two native runs of minitest.wf differ in
 * exactly one file, `run/movie.pmv`), so retina *pixels* are a debugging aid and the
 * `3 × numneurons` nerve values are the contract. This module is the "contract" half;
 * `raster.ts` is the "pixels" half.
 *
 * Native source: `agent/Retina.cc` (`Channel::init` :153-178, `Channel::update` :180-240).
 * Spec: `docs/specs/vision-spec.md` §7 and §11.5 (the executable reference encoder, whose
 * fingerprint reproduction is asserted in `tests/vision-encoder.test.ts`).
 *
 * Boundaries: PORT_PLAN.md gives lane L9 (`agent/Retina.*` + vision encoding) the Retina
 * object and this lane the raster; W1j's spec puts the reference encoder in this lane
 * (`tests/vision-encoder.test.ts`). Both lanes must not end up with two copies: this file
 * is the one implementation, and L9's Retina is expected to call it (see `retina.ts`).
 *
 * PORT-NOTE(vision/encoder-float-discipline): every "float" store in the native code is
 * `Math.fround` here, the final division stays in f64, and the multiply-add at
 * `Retina.cc:225` is a *single* rounding — see PN-V5/V6/V7 below. `PN-V7` is not
 * cosmetic: the two-rounding form prints `0.349019` where the oracle prints `0.34902`.
 *
 * PORT-NOTE(vision/encoder-carry-double): the carry at `Retina.cc:234` is
 * `(1.0 - (endpixloc - float(pixel))) * buf[...]` with `1.0` a C++ *double* literal, so
 * the subtraction *and* the multiply happen in double and the single rounding is the
 * assignment to the `float avgcolor`. The spec's §11.5 listing rounds `1.0 - t` to f32
 * first (`f32(f32(1.0 - t) * b)`); the C++ abstract machine does not, so this port keeps
 * the double arithmetic and rounds once on the store. Both forms agree on every value the
 * recorded oracle prints (verified against the real native retina buffers, PARITY.md).
 */

/** A deterministic failure, mirroring the native `assert`-or-UB sites this lane must not emulate. */
export class VisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionError';
  }
}

/** The three channels, in the order `Retina::sensor_update` walks them (`Retina.cc:66-69`). */
export const ChannelIndex = { Red: 0, Green: 1, Blue: 2 } as const;
export type ChannelIndex = (typeof ChannelIndex)[keyof typeof ChannelIndex];

/** One channel's bound nerve: exactly what `Channel::init`/`update` use of it. */
export interface NerveTarget {
  /** `nerve->getNeuronCount()` (`Retina.cc:164`). */
  getNeuronCount(): number;
  /** `nerve->set( i, value )` — native stores a `double` (`Nerve::set(int,double)`). */
  set(i: number, value: number): void;
}

/**
 * The per-channel pooling geometry, cached once at bind time (`Channel::init`,
 * `Retina.cc:153-178`). `xintwidth != 0` selects the integer branch.
 */
export interface ChannelGeometry {
  readonly numneurons: number;
  /** `float(width) / numneurons` — an f32 (`Retina.cc:170`). */
  readonly xwidth: number;
  /** `width / numneurons` if that divides exactly, else 0 (`Retina.cc:171-176`). */
  readonly xintwidth: number;
}

/**
 * `Channel::init` (`Retina.cc:153-178`), minus the nerve binding.
 *
 * PORT-NOTE(vision/encoder-geometry): `xwidth` is the f32 quotient and `xintwidth` the
 * exact-division flag (`xintwidth * numneurons != width` → 0). For `width = 22` the
 * integer branch therefore fires for `numneurons ∈ {1, 2, 11, 22}` only — measured in the
 * oracle, 21 of its 108 agents have at least one such channel (spec §7.2), so both branches
 * are part of the acceptance surface.
 */
export function channelGeometry(width: number, numneurons: number): ChannelGeometry {
  if (numneurons === 0) {
    // Native: the `numneurons > 0` guard leaves xwidth/xintwidth uninitialized, but
    // `Channel::update` returns immediately for numneurons == 0, so the values are dead.
    return { numneurons: 0, xwidth: 0, xintwidth: 0 };
  }
  if (numneurons > width) {
    // PORT-NOTE(vision/encoder-pnv8): PN-V8 — with more neurons than pixels the native
    // code reads past `buf` (adjacent heap) and the port must not. The oracle never
    // exercises it (its largest channel has 14 neurons against 22 pixels); the port fails
    // deterministically instead of emulating heap garbage.
    throw new VisionError(
      `retina channel has more neurons (${numneurons}) than pixels (${width}): native reads out of bounds here (PN-V8)`,
    );
  }
  const xwidth = Math.fround(width / numneurons);
  let xintwidth = Math.trunc(width / numneurons);
  if (xintwidth * numneurons !== width) xintwidth = 0;
  return { numneurons, xwidth, xintwidth };
}

/**
 * `Retina::Channel::update` for one channel (`Retina.cc:180-240`).
 *
 * `buf` is the retina buffer: `width * 4` bytes, RGBA, little-endian byte order
 * (`Retina.cc:22-31`, filled by `glReadPixels(..., GL_RGBA, GL_UNSIGNED_BYTE, buf)`).
 * `index` is 0/1/2 for R/G/B — alpha (`index = 3`) is never consumed by the model
 * (spec §3).
 *
 * Returns a fresh `Float64Array` of the encoded values; native writes them straight into
 * the nerve (`nerve->set`), and callers that have a nerve call `encodeChannelInto`.
 */
export function encodeChannel(
  buf: Uint8Array | Uint8ClampedArray,
  index: ChannelIndex,
  numneurons: number,
  width: number,
): Float64Array {
  const out = new Float64Array(numneurons);
  encodeChannelInto(buf, index, numneurons, width, out, 0);
  return out;
}

/** `encodeChannel` writing into `out` at `outOffset` (one allocation less per channel). */
export function encodeChannelInto(
  buf: Uint8Array | Uint8ClampedArray,
  index: ChannelIndex,
  numneurons: number,
  width: number,
  out: Float64Array | number[],
  outOffset = 0,
): void {
  if (numneurons === 0) return; // `Retina.cc:182-183`: the channel is not fed at all
  const { xwidth, xintwidth } = channelGeometry(width, numneurons);
  const f32 = Math.fround;

  if (xintwidth !== 0) {
    // Retina.cc:189-200 — the integer branch (strictly disjoint pixels, no carry).
    // PORT-NOTE(vision/encoder-integer-branch): `avgcolor` is reset for *every* neuron
    // here (unlike the fractional branch) and the accumulation is a plain f32 sum.
    let pixel = 0;
    for (let i = 0; i < numneurons; i++) {
      let avg = f32(0.0);
      for (let k = 0; k < xintwidth; k++) {
        avg = f32(avg + buf[pixel * 4 + index]!);
        pixel++;
      }
      out[outOffset + i] = avg / (xwidth * 255.0); // double division (:198)
    }
    return;
  }

  // Retina.cc:201-239 — the fractional branch. `avgcolor` is *not* reset per neuron; the
  // value written at :234 is the starting accumulator of the next neuron (PN-V5).
  let pixel = 0; // native `short pixel` (:206)
  let avg = f32(0.0); // PN-V5 carry, reset once (:204)
  for (let i = 0; i < numneurons; i++) {
    const endpixloc = f32(xwidth * f32(i + 1)); // :210, one f32 rounding
    // :214 — the comparison is double (`endpixloc - 1.0` promotes to double).
    while (f32(pixel) < endpixloc - 1.0) {
      avg = f32(avg + buf[pixel * 4 + index]!); // :216, f32 accumulation
      pixel++;
    }
    const t = f32(endpixloc - f32(pixel)); // :225 operand, f32 subtraction
    // :225 — a single rounding: the f32×int product is exact in f64 and the f64 sum is
    // rounded once into f32, i.e. the exactly-rounded fused multiply-add (PN-V7).
    avg = f32(t * buf[pixel * 4 + index]! + avg);
    out[outOffset + i] = avg / (xwidth * 255.0); // :226, double division, double nerve
    // :234 — `1.0` is a double literal: the subtraction and the multiply are double, and
    // the assignment to `float avgcolor` is the one rounding.
    avg = f32((1.0 - t) * buf[pixel * 4 + index]!);
    pixel++; // :237
  }
}

/**
 * The three-channel encoding of one retina row (`Retina::sensor_update`, `Retina.cc:55-90`).
 *
 * The channels are walked 0,1,2 and each writes its own nerve; `numneurons` is per channel,
 * read from the nerve (`Channel::init`). `targets` may be nerve objects (then the values are
 * also `set` into them, exactly as native does) or plain descriptors.
 *
 * Measured in the oracle: a minitest agent's channels are not all the same size (9/9/9 for
 * agent 10, but 1/1/11 for agent 31 — spec §7.2), so the counts must come from the nerves.
 */
export interface ChannelBinding {
  readonly index: ChannelIndex;
  readonly nerve: NerveTarget;
}

export function encodeRetina(
  buf: Uint8Array | Uint8ClampedArray,
  width: number,
  bindings: readonly ChannelBinding[],
): void {
  for (const binding of bindings) {
    const numneurons = binding.nerve.getNeuronCount();
    if (numneurons === 0) continue; // :182-183
    const values = encodeChannel(buf, binding.index, numneurons, width);
    for (let i = 0; i < numneurons; i++) binding.nerve.set(i, values[i]!);
  }
}

/** Convenience: encode all three channels and return them as a length-3 array. */
export function encodeChannels(
  buf: Uint8Array | Uint8ClampedArray,
  width: number,
  numneurons: readonly [number, number, number],
): [Float64Array, Float64Array, Float64Array] {
  return [
    encodeChannel(buf, ChannelIndex.Red, numneurons[0], width),
    encodeChannel(buf, ChannelIndex.Green, numneurons[1], width),
    encodeChannel(buf, ChannelIndex.Blue, numneurons[2], width),
  ];
}
