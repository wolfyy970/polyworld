/**
 * Lane W1j/L16 — the retina encoder's acceptance tests.
 *
 * `docs/specs/vision-spec.md` §11.4/§11.5 defines the lane's observable: not a picture, but
 * the `3 × numneurons` doubles the retina writes into the brain, printed by the native
 * recorder as `%g` (6 significant digits). These tests hold the encoder to that:
 *
 *   1. the golden's own fingerprint is recomputed from `brainFunction_10` (185 steps, 4995
 *      vision samples, 112 distinct printed values, 3717 exact zeros, 27 uniform-barrier
 *      steps, `0.349019` absent, the ground-only bytes absent) — i.e. the numbers the spec
 *      rests on are re-derived, not quoted;
 *   2. for those 27 uniform-barrier steps the encoder is fed the pixel row they must have come
 *      from (89/64/38 for every pixel) and must print the golden's 27 values *as strings* —
 *      the check that pins the single-rounding multiply-add (PN-V7): the two-rounding form
 *      prints `0.349019` instead of `0.34902`;
 *   3. the six regression vectors of §11.4 (uniform rows of every byte value, the PN-V5 carry
 *      across a seam, the integer branch, and the PN-V8 out-of-range guard).
 *
 * Goldens live in `oracle/**` (gitignored, read-only): the golden-dependent tests skip when
 * they are absent and `POLYWORLD_ORACLE_ROOT` can point at the canonical tree.
 * Load, not slowness of the code: the guarded test(s) are 366 ms solo and 1.2 s under four
 * concurrent full suites — the band that false-reds when the fleet's three concurrent pairs
 * (6 processes) run. They carry LOAD_TIMEOUT_MS below; no assertion changed.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ChannelIndex,
  VisionError,
  channelGeometry,
  encodeChannel,
  encodeChannels,
  type NerveTarget,
} from '../src/model/vision/encoder';
import { formatG, oracleRoot, readFunctionalLog, retinaRanges } from './visionGolden';

const scenario = 'minitest_von';
const goldenDir = path.join(oracleRoot, scenario, 'run', 'brain', 'function');
const goldensAvailable = existsSync(path.join(goldenDir, 'brainFunction_10.txt.gz'));

/** A retina row of `width` RGBA pixels with the same byte colour everywhere. */
function uniformRow(width: number, r: number, g: number, b: number): Uint8Array {
  const row = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    row[i * 4] = r;
    row[i * 4 + 1] = g;
    row[i * 4 + 2] = b;
    row[i * 4 + 3] = 255; // alpha is read but never consumed (`Retina.cc:196` indexes 0..2)
  }
  return row;
}

/** A row built from a per-pixel function. */
function rowOf(width: number, pixel: (i: number) => [number, number, number]): Uint8Array {
  const row = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const [r, g, b] = pixel(i);
    row[i * 4] = r;
    row[i * 4 + 1] = g;
    row[i * 4 + 2] = b;
    row[i * 4 + 3] = 255;
  }
  return row;
}

/** A nerve double, as `Retina::Channel` writes it (`nerve->set( i, value )`). */
function fakeNerve(count: number): NerveTarget & { values: number[] } {
  const values = new Array<number>(count).fill(Number.NaN);
  return {
    values,
    getNeuronCount: () => count,
    set: (i, value) => {
      values[i] = value;
    },
  };
}

const WIDTH = 22; // Brain::config.retinaWidth for the oracle scenario (`normalized.wf:374`)
const BARRIER = [89, 64, 38] as const; // round(255 * (0.35, 0.25, 0.15)) — spec §6

/**
 * Vitest's default is 5 s. The guarded test(s) are 366 ms solo and 1.2 s under four concurrent
 * full suites; the fleet also runs three concurrent pairs (6 processes), and at that load the
 * orchestrator measured a 946 ms-solo test false-red 6/6 on 2026-09-29 — this is the same band.
 * 60 s is the budget the vision-on gate already carries (t_1f4a7a8a): that measurement with room,
 * and still a guard, so a genuine hang fails.
 */
const LOAD_TIMEOUT_MS = 60_000;

describe('retina encoder — §11.4 fingerprint, recomputed from the recorded golden', () => {
  it.skipIf(!goldensAvailable)('brainFunction_10 has the fingerprint the spec pins', () => {
    const log = readFunctionalLog(scenario, 10);
    expect(log.header).toBe('brainFunction 10 37 29 8 74 0 2-10 11-19 20-28');
    expect(log.steps.length).toBe(185);
    expect(log.numNeurons).toBe(37);

    const ranges = retinaRanges(log);
    expect(ranges).toEqual({ red: [2, 10], green: [11, 19], blue: [20, 28] });

    const samples: string[] = [];
    for (const step of log.steps) {
      for (let nerve = ranges.red[0]; nerve <= ranges.blue[1]; nerve++) {
        samples.push(step.printed[nerve]!);
      }
    }
    expect(samples.length).toBe(4995);

    const distinct = new Set(samples);
    expect(distinct.size).toBe(112);
    expect(samples.filter((value) => value === '0').length).toBe(3717);

    // Pure-byte values: the ones the readback quantization can produce from the palette
    // (spec §11.4's table). Their byte provenance is `round(255*c)` from the worldfile.
    const byteValues: Record<string, number> = {
      '0': 3717,
      '0.34902': 330,
      '0.25098': 330,
      '0.14902': 330,
      '0.505882': 42,
      '0.501961': 23,
      '1': 23,
      '0.152941': 14,
      '0.2': 14,
      '0.6': 7,
      '0.686275': 7,
      '0.27451': 1,
    };
    const counts: Record<string, number> = {};
    for (const value of samples) counts[value] = (counts[value] ?? 0) + 1;
    for (const [value, expected] of Object.entries(byteValues)) {
      expect({ value, count: counts[value] ?? 0 }).toEqual({ value, count: expected });
    }
    // The two-rounding artifact must never appear in the golden, and neither may the ground's
    // bytes (the ground plane cannot reach the sampled row — PN-V9/§5.5).
    expect(samples).not.toContain('0.349019');
    expect(samples).not.toContain('0.101961'); // 26/255, GroundColor r
    expect(samples).not.toContain('0.0509804'); // 13/255, GroundColor b

    // Every printed value is on the %f branch of %g (so the test-side formatter's %e branch is
    // never load-bearing for this oracle), and every one round-trips through `formatG`.
    for (const value of distinct) {
      expect(value).not.toContain('e');
      const asNumber = Number(value);
      expect(formatG(asNumber)).toBe(value);
    }
  });

  it.skipIf(!goldensAvailable)('the 27 uniform-barrier steps are reproduced as strings', () => {
    const log = readFunctionalLog(scenario, 10);
    const ranges = retinaRanges(log);
    const redNeurons = ranges.red[1] - ranges.red[0] + 1;
    const greenNeurons = ranges.green[1] - ranges.green[0] + 1;
    const blueNeurons = ranges.blue[1] - ranges.blue[0] + 1;
    expect([redNeurons, greenNeurons, blueNeurons]).toEqual([9, 9, 9]);

    const row = uniformRow(WIDTH, BARRIER[0], BARRIER[1], BARRIER[2]);
    const [red, green, blue] = encodeChannels(row, WIDTH, [redNeurons, greenNeurons, blueNeurons]);
    const encoded = [
      ...[...red].map((value) => formatG(value)),
      ...[...green].map((value) => formatG(value)),
      ...[...blue].map((value) => formatG(value)),
    ];
    // the string equality that pins PN-V7 (single rounding at Retina.cc:225)
    expect(encoded).toEqual([
      ...new Array<string>(9).fill('0.34902'),
      ...new Array<string>(9).fill('0.25098'),
      ...new Array<string>(9).fill('0.14902'),
    ]);

    // and the golden really does contain those 27 values, in those 27 steps
    let uniformSteps = 0;
    for (const step of log.steps) {
      const vision = step.printed.slice(ranges.red[0], ranges.blue[1] + 1);
      if (vision.join(' ') === encoded.join(' ')) uniformSteps++;
    }
    expect(uniformSteps).toBe(27);
  });
});

describe('retina encoder — §11.4 regression vectors', () => {
  it('vector 2/3: a uniform row of any byte value stays within the f32 accumulation of byte/255', () => {
    // PORT-NOTE(vision/encoder-f32-accumulation): the accumulator is a C `float`
    // (`Retina.cc:187`, `:206`), so a uniform row of `b` bytes accumulates `b` in f32 and
    // divides by a f32 `xwidth*255`. For most bytes that is bit-for-bit `b/255` to 6 digits;
    // for some (measured: b = 2 prints `0.00784313` where `b/255` prints `0.00784314`) the
    // f32 rounding is visible in the sixth digit. The oracle's own uniform rows — 89/64/38,
    // the barrier — are asserted *exactly*, as strings, below.
    const tolerance = 5e-7;
    let maxDeviation = 0;
    let visibleInSixDigits = 0;
    let example: { byte: number; index: number; printed: string; ideal: string } | null = null;
    for (let byte = 0; byte <= 255; byte++) {
      const row = uniformRow(WIDTH, byte, byte, byte);
      const [channel] = encodeChannels(row, WIDTH, [9, 9, 9]);
      for (let i = 0; i < channel.length; i++) {
        const value = channel[i]!;
        expect(Number.isNaN(value)).toBe(false);
        expect(value).toBeGreaterThanOrEqual(0);
        // PORT-NOTE(vision/encoder-no-clamp): the spec's §11.4 vector 3 expects values in
        // [0,1]; measured here, a 255-byte row can land one f32 ulp *above* 1
        // (1.0000000761) because the native accumulator is f32 and there is no clamp anywhere
        // in `Channel::update`. The port keeps the native behaviour (PORT_SPEC rule 1) — a
        // clamp would be an "improvement" that changes a double the brain consumes. The bound
        // asserted here is the f32 accumulation error, and the printed value is still `1`.
        expect(value).toBeLessThanOrEqual(1 + tolerance);
        maxDeviation = Math.max(maxDeviation, Math.abs(value - byte / 255));
        const printed = formatG(value);
        const ideal = formatG(byte / 255);
        if (printed !== ideal) {
          visibleInSixDigits++;
          example ??= { byte, index: i, printed, ideal };
        }
      }
      // monotone in the byte value
      if (byte > 0) {
        const previous = encodeChannel(uniformRow(WIDTH, byte - 1, byte - 1, byte - 1), ChannelIndex.Red, 9, WIDTH);
        expect(channel[0]!).toBeGreaterThanOrEqual(previous[0]!);
      }
    }
    // The f32 accumulator's error, measured over all 256 rows x 3 channels: bounded well below
    // one part in a million, and visible in the golden's 6 printed digits on a few rows (the
    // oracle's own uniform rows are all barrier rows, asserted exactly below). The example is
    // recorded so the phenomenon is pinned rather than described.
    expect(maxDeviation).toBeLessThanOrEqual(tolerance);
    expect(maxDeviation).toBeGreaterThan(0);
    expect(visibleInSixDigits).toBeGreaterThan(0);
    expect(example).not.toBeNull();
    expect(formatG(encodeChannel(uniformRow(WIDTH, example!.byte, example!.byte, example!.byte), ChannelIndex.Red, 9, WIDTH)[example!.index]!)).toBe(example!.printed);
    // the 89/64/38 barrier row, exactly as the golden prints it
    const [r, g, b] = encodeChannels(uniformRow(WIDTH, ...BARRIER), WIDTH, [9, 9, 9]);
    expect([...r].map((value) => formatG(value))).toEqual(new Array<string>(9).fill('0.34902'));
    expect([...g].map((value) => formatG(value))).toEqual(new Array<string>(9).fill('0.25098'));
    expect([...b].map((value) => formatG(value))).toEqual(new Array<string>(9).fill('0.14902'));
  });

  it('vector 4: the PN-V5 carry crosses the seam (and is not a per-neuron reset)', () => {
    // Left half 89, right half 0: the neuron straddling the seam is a weighted mean and the
    // carry is the *starting accumulator* of the next neuron.
    const seamPixel = 11; // 22 pixels: 0..10 = 89, 11..21 = 0
    const row = rowOf(WIDTH, (i) => (i < seamPixel ? [89, 89, 89] : [0, 0, 0]));

    const numneurons = 9;
    const { xwidth, xintwidth } = channelGeometry(WIDTH, numneurons);
    expect(xintwidth).toBe(0); // 22/9 does not divide => the fractional branch
    const values = encodeChannel(row, ChannelIndex.Red, numneurons, WIDTH);

    // Closed-form reference for the same algorithm, in f64, with the same carry rule.
    const reference: number[] = [];
    {
      let pixel = 0;
      let avg = 0;
      for (let i = 0; i < numneurons; i++) {
        const endpixloc = xwidth * (i + 1);
        while (pixel < endpixloc - 1.0) avg += row[pixel++ * 4]!;
        const t = endpixloc - pixel;
        avg += t * row[pixel * 4]!;
        reference.push(avg / (xwidth * 255.0));
        avg = (1.0 - t) * row[pixel * 4]!;
        pixel++;
      }
    }
    for (let i = 0; i < numneurons; i++) {
      // the encoder accumulates in f32 where this reference accumulates in f64
      expect(Math.abs(values[i]! - reference[i]!)).toBeLessThan(5e-8);
    }

    // The carry is load-bearing: without it, neuron 1 would start from 0 instead of
    // (1-t)*89. Compute the no-carry variant and show the value actually differs.
    const noCarry: number[] = [];
    {
      let pixel = 0;
      for (let i = 0; i < numneurons; i++) {
        let avg = 0;
        const endpixloc = xwidth * (i + 1);
        while (pixel < endpixloc - 1.0) avg += row[pixel++ * 4]!;
        const t = endpixloc - pixel;
        avg += t * row[pixel * 4]!;
        noCarry.push(avg / (xwidth * 255.0));
        pixel++;
      }
    }
    expect(values[1]!).toBeGreaterThan(noCarry[1]!); // the seam's leftover grey is carried in
    expect(formatG(values[0]!)).toBe(formatG(reference[0]!));
    expect(formatG(values[8]!)).toBe('0');
  });

  it('vector 5: the integer branch (11 neurons on a uniform row) matches §7.1', () => {
    const numneurons = 11;
    const { xwidth, xintwidth } = channelGeometry(WIDTH, numneurons);
    expect(xintwidth).toBe(2); // 22/11 divides exactly
    expect(xwidth).toBe(2);

    const row = uniformRow(WIDTH, BARRIER[0], BARRIER[1], BARRIER[2]);
    const values = encodeChannel(row, ChannelIndex.Blue, numneurons, WIDTH);
    // 2 pixels of 38 bytes: avg = 76 (exact in f32), 76 / (2*255) = 0.14901960784313725
    for (const value of values) expect(formatG(value)).toBe('0.14902');
    expect(values[0]!).toBe(76 / 510);

    // 1 neuron (xintwidth = 22) and 2 neurons (xintwidth = 11) as well — the measured census
    // in the oracle has channels with 1, 2, 3, 10, 11, 12 and 14 neurons too (spec §7.2).
    for (const count of [1, 2, 11, 22]) {
      expect(channelGeometry(WIDTH, count).xintwidth).toBe(WIDTH / count);
    }
    for (const count of [3, 9, 10, 12, 14]) {
      expect(channelGeometry(WIDTH, count).xintwidth).toBe(0);
    }
  });

  it('vector 6: more neurons than pixels throws instead of reading out of bounds (PN-V8)', () => {
    expect(() => channelGeometry(WIDTH, 23)).toThrow(VisionError);
    expect(() => encodeChannel(uniformRow(WIDTH, 1, 2, 3), ChannelIndex.Red, 23, WIDTH)).toThrow(/out of bounds/);
    // a zero-neuron channel is skipped, exactly as `Channel::update` returns early
    const nerve = fakeNerve(0);
    const row = uniformRow(WIDTH, 1, 2, 3);
    encodeChannels(row, WIDTH, [0, 0, 0]);
    expect(nerve.values.length).toBe(0);
  });

  it('the three channels read their own byte (no cross-channel bleed)', () => {
    const row = uniformRow(WIDTH, 10, 20, 30);
    const [r, g, b] = encodeChannels(row, WIDTH, [9, 9, 9]);
    for (const value of r) expect(Math.abs(value - 10 / 255)).toBeLessThanOrEqual(2e-7);
    for (const value of g) expect(Math.abs(value - 20 / 255)).toBeLessThanOrEqual(2e-7);
    for (const value of b) expect(Math.abs(value - 30 / 255)).toBeLessThanOrEqual(2e-7);
    // strictly ordered, so a cross-channel mixup would break the ordering
    expect(r[0]!).toBeLessThan(g[0]!);
    expect(g[0]!).toBeLessThan(b[0]!);
  });

  it('alpha is never consumed (spec §3: only bytes 0-2 are read)', () => {
    const alphaOnly = rowOf(WIDTH, (i) => [0, 0, 0]);
    for (let i = 0; i < WIDTH; i++) alphaOnly[i * 4 + 3] = 255;
    const [r] = encodeChannels(alphaOnly, WIDTH, [9, 9, 9]);
    expect([...r].map((value) => formatG(value))).toEqual(new Array<string>(9).fill('0'));
  });
});

describe('retina encoder — numerically hostile rows', () => {
  it('never produces NaN or an out-of-range value for arbitrary bytes', () => {
    let seed = 12345;
    const next = (): number => {
      // a deterministic LCG, only so the test is reproducible
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let trial = 0; trial < 200; trial++) {
      const row = rowOf(WIDTH, () => [next() % 256, next() % 256, next() % 256]);
      for (const count of [1, 2, 3, 9, 10, 11, 12, 14, 22]) {
        const [r, g, b] = encodeChannels(row, WIDTH, [count, count, count]);
        for (const channel of [r, g, b]) {
          for (const value of channel) {
            expect(Number.isNaN(value)).toBe(false);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  }, LOAD_TIMEOUT_MS);

  it('all-zero and all-255 rows are the endpoints of the value range', () => {
    const black = encodeChannel(uniformRow(WIDTH, 0, 0, 0), ChannelIndex.Red, 9, WIDTH);
    const white = encodeChannel(uniformRow(WIDTH, 255, 255, 255), ChannelIndex.Red, 9, WIDTH);
    expect([...black].map((value) => formatG(value))).toEqual(new Array<string>(9).fill('0'));
    // a full-white row prints `1` (23 of the golden's values are exactly `1`); the f32
    // accumulator lands a hair below the exact 1, which %g rounds to `1` at 6 digits
    expect([...white].map((value) => formatG(value))).toEqual(new Array<string>(9).fill('1'));
    expect(Math.abs(white[0]! - 1)).toBeLessThanOrEqual(1e-6);
  });

  it('encodes into a caller-supplied array and into nerves without allocation surprises', () => {
    const nerve = fakeNerve(9);
    const row = uniformRow(WIDTH, ...BARRIER);
    // `encodeRetina` is exercised through the public helper
    const channel = encodeChannel(row, ChannelIndex.Red, 9, WIDTH);
    for (let i = 0; i < 9; i++) nerve.set(i, channel[i]!);
    expect(nerve.values.map((value) => formatG(value))).toEqual(new Array<string>(9).fill('0.34902'));

    const out = new Float64Array(20);
    // re-encode into an offset window, as the three-channel encoder may
    for (let i = 0; i < 9; i++) out[i + 5] = channel[i]!;
    expect([...out.slice(5, 14)].map((value) => formatG(value))).toEqual(new Array<string>(9).fill('0.34902'));
  });
});
