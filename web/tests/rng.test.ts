/**
 * Lane W1d — exact PRNGs, verified against the native oracle.
 *
 * The vectors come from `src/model/rng/nativeVectors.ts` (generated from the probes in
 * `src/model/rng/native/`; see that directory's README for how each was produced). The
 * headline test is the first one: the ten lines of `../polyworld/bin/rancheck` reproduced
 * byte-for-byte, which is this lane's acceptance criterion.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { BsdRandom, LibcRand, RAND_MAX } from '../src/model/rng/rand';
import { Drand48 } from '../src/model/rng/drand48';
import { Mt19937 } from '../src/model/rng/mt19937';
import { atan2f, cos, cosf, exp, fma, log, pow, powf, sin, sincosf, sinf } from '../src/model/rng/libm';
import {
  RandomNumberGenerator,
  createMt19937Stream,
  createRngSurface,
  globalRngSurface,
  resetGlobalRngSurface,
} from '../src/model/rng/surface';
import { RngRole, RngType } from '../src/model/types/rng';
import {
  LOG_BIG_SAMPLE,
  LOG_CORPUS,
  LOG_WIDE_SAMPLE,
  PROBE_OUTPUT,
  RANCHECK_STDOUT,
} from '../src/model/rng/nativeVectors';

/* ------------------------------------------------------------------ helpers */

function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('### ')) {
      current = [];
      out.set(line.slice(4).trim(), current);
    } else if (current !== null && line.trim() !== '') {
      current.push(line.trim());
    }
  }
  return out;
}

const S = sections(PROBE_OUTPUT);

function section(name: string): string[] {
  const s = S.get(name);
  if (s === undefined) throw new Error(`no such vector section: ${name}`);
  return s;
}

function single(name: string): number[] {
  return section(name).map(Number);
}

/** Indexed sections (`"0 <value>"`): take the value column. */
function column(name: string, index: number): number[] {
  return section(name).map((line) => Number(line.split(/\s+/)[index]));
}

/** C `printf("%*d")`: right-aligned, space padded. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, ' ');
}

/** C `printf("%.Nf")`. */
function fixed(value: number, digits: number): string {
  return value.toFixed(digits);
}

/** The seven seeds the second probe swept. */
const SEEDS = ['0', '1', '2', '42', '12345', '2147483647', '4294967295'];

function expectExact(got: number, want: number, what: string): void {
  if (!Object.is(got, want)) {
    throw new Error(`${what}: got ${got} (${got.toPrecision(17)}), want ${want} (${want.toPrecision(17)})`);
  }
}

/* ------------------------------------------------------------------ rancheck */

describe('rancheck parity (lane acceptance)', () => {
  it('reproduces ../polyworld/bin/rancheck byte-for-byte', () => {
    const libc = new LibcRand();
    const dr = new Drand48();
    const bsd = new BsdRandom();
    const mt = new Mt19937();
    libc.srand(42);
    dr.srand48(42);
    bsd.srandom(42);
    mt.set(42);

    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(
        `${i}:  srand = ${pad(libc.rand(), 10)},  drand48 = ${fixed(dr.drand48(), 4)},  random = ${pad(bsd.random(), 10)},  gsl = ${fixed(mt.uniform(), 6)}`,
      );
    }
    // RANCHECK_STDOUT is verbatim stdout, so it ends with the binary's final newline
    expect(lines.join('\n') + '\n').toBe(RANCHECK_STDOUT);
  });
});

/* ------------------------------------------------------------------ rand() */

describe('rand()/srand() — Apple Libc Park-Park-Miller (rand.c)', () => {
  it('matches the oracle for every probed seed', () => {
    for (const seed of SEEDS) {
      const r = new LibcRand();
      r.srand(Number(seed));
      const want = single(`RAND_SEED ${seed}`);
      want.forEach((w, i) => expectExact(r.rand(), w, `rand() seed ${seed} #${i}`));
    }
  });

  it('matches the seed-42 and seed-1 vectors from the first probe', () => {
    const r = new LibcRand();
    r.srand(42);
    column('RAND', 1).forEach((w, i) => expectExact(r.rand(), w, `rand() #${i}`));
    r.srand(1);
    column('RAND_SEED1', 1).forEach((w, i) => expectExact(r.rand(), w, `rand() seed 1 #${i}`));
  });

  it('remaps a zero seed to 123459876, as the C does', () => {
    const r = new LibcRand();
    r.srand(0);
    expect(r.rand()).toBe(520932930); // 16807 * 123459876 mod (2^31-1)
    r.srand(0);
    expect(single('RAND_SEED 0')[0]).toBe(r.rand());
  });

  it('is the Park-Miller reduction: x -> 16807*x mod (2^31-1)', () => {
    const r = new LibcRand();
    r.srand(1);
    let x = 1;
    for (let i = 0; i < 20000; i++) {
      x = (16807 * x) % RAND_MAX;
      expectExact(r.rand(), x, `park-miller step ${i}`);
    }
  });

  it('stays inside [0, RAND_MAX] and is not the TYPE_3 stream', () => {
    const r = new LibcRand();
    r.srand(42);
    const bsd = new BsdRandom();
    bsd.srandom(42);
    for (let i = 0; i < 1000; i++) {
      const v = r.rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(RAND_MAX);
      expect(v).not.toBe(bsd.random());
    }
  });

  it('truncates the seed to 32 bits, as the C `u_int` parameter does', () => {
    const a = new LibcRand();
    const b = new LibcRand();
    a.srand(7);
    b.srand(7 + 2 ** 32);
    expect(a.rand()).toBe(b.rand());
  });
});

/* ------------------------------------------------------------------ random() */

describe('random()/srandom() — TYPE_3 additive feedback (random.c)', () => {
  it('matches the oracle for every probed seed', () => {
    for (const seed of SEEDS) {
      const r = new BsdRandom();
      r.srandom(Number(seed));
      const want = single(`RANDOM_SEED ${seed}`);
      want.forEach((w, i) => expectExact(r.random(), w, `random() seed ${seed} #${i}`));
    }
  });

  it('matches the first probe’s seed-42, seed-1 and seed-0 vectors', () => {
    const r = new BsdRandom();
    r.srandom(42);
    column('RANDOM', 1).forEach((w, i) => expectExact(r.random(), w, `random() #${i}`));
    r.srandom(1);
    column('RANDOM_SEED1', 1).forEach((w, i) => expectExact(r.random(), w, `random() seed 1 #${i}`));
    r.srandom(0);
    column('RANDOM_SEED0', 1).forEach((w, i) => expectExact(r.random(), w, `random() seed 0 #${i}`));
  });

  it('produces 31-bit values and keeps a 31-word state', () => {
    const r = new BsdRandom();
    r.srandom(5);
    for (let i = 0; i < 5000; i++) {
      const v = r.random();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0x7fffffff);
    }
  });
});

/* ------------------------------------------------------------------ drand48 */

describe('drand48()/lrand48()/srand48() — 48-bit LCG', () => {
  it('matches the oracle for every probed seed', () => {
    for (const seed of SEEDS) {
      const dr = new Drand48();
      dr.srand48(Number(seed));
      single(`DRAND48_SEED ${seed}`).forEach((w, i) => expectExact(dr.drand48(), w, `drand48 seed ${seed} #${i}`));

      const lr = new Drand48();
      lr.srand48(Number(seed));
      single(`LRAND48_SEED ${seed}`).forEach((w, i) => expectExact(lr.lrand48(), w, `lrand48 seed ${seed} #${i}`));
    }
  });

  it('matches the first probe’s full-precision vectors', () => {
    const dr = new Drand48();
    dr.srand48(42);
    column('DRAND48', 1).forEach((w, i) => expectExact(dr.drand48(), w, `drand48 #${i}`));
    dr.srand48(42);
    column('LRAND48', 1).forEach((w, i) => expectExact(dr.lrand48(), w, `lrand48 #${i}`));
    dr.srand48(0);
    column('DRAND48_SEED0', 1).forEach((w, i) => expectExact(dr.drand48(), w, `drand48 seed 0 #${i}`));
  });

  it('shares one state between lrand48 and drand48, in call order', () => {
    const dr = new Drand48();
    dr.srand48(42);
    for (const line of section('DRAND48_INTERLEAVED')) {
      const [i, l, d] = line.split(/\s+/);
      const gotL = dr.lrand48();
      const gotD = dr.drand48();
      expectExact(gotL, Number(l), `interleaved #${i} lrand48`);
      expectExact(gotD, Number(d), `interleaved #${i} drand48`);
    }
  });

  it('matches an exact BigInt reference for 20000 consecutive draws', () => {
    const dr = new Drand48();
    dr.srand48(42);
    const A = 0x5deece66dn;
    const C = 0xbn;
    const M = 1n << 48n;
    let x = (42n << 16n) | 0x330en;
    for (let i = 0; i < 20000; i++) {
      x = (A * x + C) % M;
      expectExact(dr.drand48(), Number(x) / 281474976710656, `drand48 bigint #${i}`);
    }
  });

  it('returns the top 31 bits from lrand48', () => {
    const dr = new Drand48();
    dr.srand48(7);
    const A = 0x5deece66dn;
    const C = 0xbn;
    const M = 1n << 48n;
    let x = (7n << 16n) | 0x330en;
    for (let i = 0; i < 5000; i++) {
      x = (A * x + C) % M;
      expectExact(dr.lrand48(), Number(x >> 17n), `lrand48 bigint #${i}`);
    }
  });

  it('truncates the seed to 32 bits', () => {
    const a = new Drand48();
    const b = new Drand48();
    a.srand48(0xffffffff);
    b.srand48(0x1ffffffff);
    expectExact(a.drand48(), b.drand48(), 'seed truncation');
  });
});

/* ------------------------------------------------------------------ MT19937 */

describe('MT19937 with GSL mapping', () => {
  it('matches gsl_rng_uniform for every probed seed', () => {
    for (const seed of SEEDS) {
      const mt = new Mt19937(Number(seed));
      single(`MT_SEED ${seed}`).forEach((w, i) => expectExact(mt.uniform(), w, `uniform seed ${seed} #${i}`));
    }
  });

  it('matches the first probe’s uniform, uniform_pos and range vectors', () => {
    const mt = new Mt19937(42);
    column('GSL_UNIFORM_42', 1).forEach((w, i) => expectExact(mt.uniform(), w, `uniform #${i}`));
    mt.set(42);
    column('GSL_UNIFORM_POS_42', 1).forEach((w, i) => expectExact(mt.uniformPos(), w, `uniformPos #${i}`));
    mt.set(42);
    for (const line of section('GSL_RANGE_42')) {
      const [i, v] = line.split(/\s+/);
      expectExact(mt.range(10, 20), Number(v), `range #${i}`);
    }
    mt.set(0);
    column('GSL_UNIFORM_0', 1).forEach((w, i) => expectExact(mt.uniform(), w, `uniform seed 0 #${i}`));
    mt.set(1);
    column('GSL_UNIFORM_1', 1).forEach((w, i) => expectExact(mt.uniform(), w, `uniform seed 1 #${i}`));
    mt.set(4294967295);
    column('GSL_UNIFORM_BIGSEED', 1).forEach((w, i) => expectExact(mt.uniform(), w, `uniform big seed #${i}`));
  });

  it('maps a zero seed to GSL’s default seed 4357', () => {
    const a = new Mt19937(0);
    const b = new Mt19937(4357);
    for (let i = 0; i < 10; i++) expectExact(a.uniform(), b.uniform(), `seed 0 == 4357 #${i}`);
  });

  it('matches gsl_ran_ugaussian (GSL’s polar normal)', () => {
    const mt = new Mt19937(42);
    column('GSL_UGAUSSIAN_42', 1).forEach((w, i) => expectExact(mt.gaussian(), w, `gaussian #${i}`));
  });

  /**
   * Regression (review round 1, defect in `Mt19937.gaussian`): the shipped GSL draws the polar
   * components with `gsl_rng_uniform_pos`, so a raw draw of exactly 0 is rejected and redrawn
   * instead of becoming `-1`. Ordinary vectors cannot tell the two readings apart (an MT19937
   * output is exactly 0 with probability 2^-32), so the fixture pins them with *fixed* streams
   * and with an injected zero, draw counts included — captured by
   * `native/raw/gsl_polar_probe.c`, linked against the same
   * `/opt/homebrew/opt/gsl/lib/libgsl.28.dylib` the oracle links.
   */
  class FixedGaussianStream extends Mt19937 {
    /** Every `uniform()` the algorithm asked for. */
    calls = 0;
    private i = 0;
    constructor(
      private readonly values: number[],
      private readonly cycle: boolean,
    ) {
      super(42);
    }
    override uniform(): number {
      this.calls++;
      const i = this.cycle
        ? this.i++ % this.values.length
        : Math.min(this.i++, this.values.length - 1);
      return this.values[i]!;
    }
  }

  /** A real MT19937(42) stream with one `uniform()` forced to return an exact 0. */
  class ZeroInjectedStream extends Mt19937 {
    /** Native `outer`: every draw asked of the stream. */
    outer = 0;
    /** Native `inner`: the draws that really came from MT19937. */
    inner = 0;
    constructor(private readonly injectAt: number) {
      super(42);
    }
    override uniform(): number {
      this.outer++;
      if (this.outer === this.injectAt) return 0;
      this.inner++;
      return super.uniform();
    }
  }

  /** The 16-value cycle `native/raw/gsl_polar_probe.c` feeds the library. */
  const FIXED_B = [0.9, 0.1, 0, 0.6, 0.7, 0.8, 0.3, 0.2, 0.55, 0.45, 0.95, 0.05, 0.85, 0.15, 0.65, 0.35];

  it('draws the polar components with gsl_rng_uniform_pos, not uniform()', () => {
    const streams: Array<[string, FixedGaussianStream]> = [
      ['GSL_FIXED_A', new FixedGaussianStream([0, 0.75], false)],
      ['GSL_FIXED_B', new FixedGaussianStream(FIXED_B, true)],
    ];
    for (const [name, stream] of streams) {
      for (const line of section(name)) {
        const [i, value, draws] = line.split(/\s+/);
        const before = stream.calls;
        expectExact(stream.gaussian(), Number(value), `${name} gaussian #${i}`);
        expect(stream.calls - before, `${name} gaussian #${i} draw count`).toBe(Number(draws));
      }
    }
  });

  it('keeps the stream in step when a raw draw is exactly zero', () => {
    for (const injectAt of [1, 7]) {
      const name = `GSL_INJECT_${injectAt}`;
      const stream = new ZeroInjectedStream(injectAt);
      for (const line of section(name)) {
        const [i, value, outer, inner] = line.split(/\s+/);
        expectExact(stream.gaussian(), Number(value), `${name} gaussian #${i}`);
        expect(stream.outer, `${name} gaussian #${i} draws`).toBe(Number(outer));
        expect(stream.inner, `${name} gaussian #${i} MT draws`).toBe(Number(inner));
      }
    }
  });

  it('the probe wrapper is faithful: no injection reproduces the plain GSL stream', () => {
    const wrapped = new ZeroInjectedStream(0);
    const plain = new Mt19937(42);
    const direct = section('GSL_DIRECT_MT42').map((line) => Number(line.split(/\s+/)[1]));
    const noInject = section('GSL_NO_INJECT');
    expect(direct.length).toBe(noInject.length);
    noInject.forEach((line, i) => {
      const [, value, outer, inner] = line.split(/\s+/);
      expectExact(wrapped.gaussian(), Number(value), `GSL_NO_INJECT #${i}`);
      expectExact(plain.gaussian(), Number(value), `plain Mt19937 #${i}`);
      expect(Number(value), `GSL_DIRECT_MT42 #${i}`).toBe(direct[i]!);
      expect(wrapped.outer).toBe(Number(outer));
      expect(wrapped.inner).toBe(wrapped.outer); // nothing was injected
      expect(Number(inner)).toBe(Number(outer));
    });
  });

  it('the fixed-stream fixture really discriminates: a uniform() loop fails it', () => {
    // Replica of the pre-fix loop over the same fixed streams. For GSL_FIXED_A it returns the
    // same value from one draw too many; for GSL_FIXED_B the value differs as well.
    function uniformReading(values: number[], cycle: boolean): { value: number; draws: number } {
      let i = 0;
      const draw = (): number => {
        const k = cycle ? i++ % values.length : Math.min(i++, values.length - 1);
        return values[k]!;
      };
      let x = 0;
      let y = 0;
      let r2 = 0;
      let draws = 0;
      do {
        x = -1 + 2 * draw();
        draws++;
        y = -1 + 2 * draw();
        draws++;
        r2 = fma(x, x, y * y);
      } while (r2 > 1.0 || r2 === 0);
      return { value: y * Math.sqrt((-2 * log(r2)) / r2), draws };
    }

    const a = uniformReading([0, 0.75], false);
    const [aValue, aDraws] = section('GSL_FIXED_A')[0]!.split(/\s+/).slice(1) as [string, string];
    expect(Number(aDraws)).toBe(3);
    expect(a.draws).toBe(4); // the zero is folded in as -1 instead of being redrawn
    expectExact(a.value, Number(aValue), 'GSL_FIXED_A value is the same either way');

    const b = uniformReading(FIXED_B, true);
    const [bValue, bDraws] = section('GSL_FIXED_B')[0]!.split(/\s+/).slice(1) as [string, string];
    expect(b.draws).not.toBe(Number(bDraws));
    expect(b.value).not.toBe(Number(bValue));
  });

  it('matches GSL’s reported range', () => {
    expect(section('GSLINFO')[0]).toBe('name=mt19937 min=0 max=4294967295 size=5000');
    const mt = new Mt19937(42);
    for (let i = 0; i < 5000; i++) {
      const v = mt.uniform();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is a fresh GSL default stream when constructed without a seed', () => {
    const a = createMt19937Stream();
    const b = createMt19937Stream(4357);
    for (let i = 0; i < 10; i++) expectExact(a.uniform(), b.uniform(), `default stream #${i}`);
  });
});

/* ------------------------------------------------------------------ nrand() */

describe('nrand() — Marsaglia polar over drand48 with a static spare', () => {
  function surfaceWithSeed(seed: number) {
    const s = createRngSurface();
    s.srand48(seed);
    return s;
  }

  it('matches the oracle’s twelve values', () => {
    const s = surfaceWithSeed(42);
    column('NRAND_42', 1).forEach((w, i) => expectExact(s.nrand(), w, `nrand #${i}`));
  });

  it('consumes two draws on the first call and none on the second', () => {
    const s = surfaceWithSeed(42);
    const first = s.nrand();
    const afterFirst = s.drand48();
    const second = s.nrand();
    const afterSecond = s.drand48();
    const expected = new Map(
      section('NRAND_DRAWCOUNT').map((line) => {
        const [k, v] = line.split('=');
        return [k!.trim(), Number(v)];
      }),
    );
    expectExact(first, expected.get('nrand0')!, 'nrand0');
    expectExact(afterFirst, expected.get('drand48_after_nrand0')!, 'drand48 after nrand0');
    expectExact(second, expected.get('nrand1')!, 'nrand1');
    expectExact(afterSecond, expected.get('drand48_after_nrand1')!, 'drand48 after nrand1');
  });

  it('scales as mean + nrand() * stdev', () => {
    const s = surfaceWithSeed(42);
    column('NRAND_SCALED_42', 1).forEach((w, i) => expectExact(s.nrandScaled(100, 15), w, `nrandScaled #${i}`));
  });

  it('uses drand48 only, never the rand() or MT19937 streams', () => {
    const s = surfaceWithSeed(11);
    s.rand();
    s.rand();
    const want = (() => {
      const pure = surfaceWithSeed(11);
      return pure.nrand();
    })();
    expectExact(s.nrand(), want, 'nrand after rand() draws');
  });
});

/* ------------------------------------------------------------------ log() */

describe('log() — transcribed from the oracle’s libm', () => {
  function checkCorpus(text: string, what: string) {
    let n = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const [xs, vs] = line.trim().split(/\s+/);
      const x = Number(xs);
      const want = Number(vs);
      if (!(x > 0)) continue;
      expectExact(log(x), want, `${what} log(${xs})`);
      n++;
    }
    return n;
  }

  it('matches the 1126-value corpus (uniform, near-1, extremes, subnormals)', () => {
    expect(checkCorpus(LOG_CORPUS, 'corpus')).toBe(1126);
  });

  it('matches the 180,000-value sweep (sample)', () => {
    expect(checkCorpus(LOG_BIG_SAMPLE, 'big sweep')).toBe(800);
  });

  it('matches the wide-magnitude sweep (sample)', () => {
    expect(checkCorpus(LOG_WIDE_SAMPLE, 'wide sweep')).toBe(1200);
  });

  it('handles the C library’s edge cases', () => {
    expect(log(0)).toBe(-Infinity);
    expect(log(-0)).toBe(-Infinity);
    expect(log(1)).toBe(0);
    expect(log(Infinity)).toBe(Infinity);
    expect(Number.isNaN(log(NaN))).toBe(true);
    expect(Number.isNaN(log(-1))).toBe(true);
    expect(Number.isNaN(log(-Infinity))).toBe(true);
    expect(log(0.5)).toBe(-0.6931471805599453);
    expect(log(2)).toBe(0.6931471805599453);
  });

  it('is not Math.log (V8 is a 1-ulp-off implementation)', () => {
    for (const x of [0.610517046879977, 0.22675609239377081, 0.28999411537873954]) {
      expect(log(x)).not.toBe(Math.log(x));
    }
    // …and it agrees with Math.log where the two implementations coincide
    expect(log(0.32352970400825143)).toBe(Math.log(0.32352970400825143));
  });
});

/* ------------------------------------------------------------------------ exp */

/**
 * `exp` is transcribed from the oracle's libm, so the corpus is the `libm_native_exp.txt`
 * the native probe wrote (`native/raw/libm_census.c` over `native/raw/libm_args_exp.txt`):
 * every line is `exp <argument bits> <result bits>`, both 64-bit hex. The same file is the
 * evidence the C transcription (`native/raw/apple_exp_impl.h`) was diffed against, so the
 * two ports cannot disagree about what the oracle does.
 */
describe('exp() — transcribed from the oracle’s libm', () => {
  const corpusPath = join(__dirname, '..', 'src', 'model', 'rng', 'native', 'raw', 'libm_native_exp.txt');
  const corpus = readFileSync(corpusPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.trim().split(/\s+/));

  function bitsOf(x: number): string {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(x, 0);
    return b.toString('hex');
  }

  function fromBits(h: string): number {
    return Buffer.from(h, 'hex').readDoubleBE(0);
  }

  it('matches every captured native exp() bit-for-bit', () => {
    let checked = 0;
    let mismatches = 0;
    const first: string[] = [];
    for (const row of corpus) {
      const x = fromBits(row[1]!);
      const want = bitsOf(exp(x));
      if (want !== row[2]) {
        mismatches += 1;
        if (first.length < 5) first.push(`exp(${x}) -> ${want}, native ${row[2]}`);
      }
      checked += 1;
    }
    if (mismatches !== 0) throw new Error(`${mismatches} mismatches, e.g. ${first.join('; ')}`);
    expect(checked).toBe(8261);
  });

  it('is not Math.exp (V8 is ~4.6 % off the oracle on this corpus)', () => {
    let v8Wrong = 0;
    let portWrong = 0;
    for (const row of corpus) {
      const x = fromBits(row[1]!);
      if (bitsOf(Math.exp(x)) !== row[2]) v8Wrong += 1;
      if (bitsOf(exp(x)) !== row[2]) portWrong += 1;
    }
    // the corpus is discriminative by construction: V8 disagrees with the oracle on
    // hundreds of its values, the port on none
    expect(v8Wrong).toBeGreaterThan(200);
    expect(portWrong).toBe(0);
  });

  it('covers the branches: overflow, subnormals, underflow, the special paths', () => {
    const rows = new Map<string, string>();
    for (const row of corpus) rows.set(row[1]!, row[2]!);
    // the two dispatch thresholds are in the corpus, exactly
    expect(rows.has('40862e42fefa39f0')).toBe(true);
    expect(rows.has('c0874a0000000000')).toBe(true);
    // exp(709.78271289338409) is the first argument that overflows
    expect(exp(709.78271289338409)).toBe(Infinity);
    expect(exp(fromBits('40862e42fefa39ef'))).toBe(1.7976931348622732e308);
    // subnormal results, and the underflow threshold
    expect(bitsOf(exp(-745.0))).toBe('0000000000000001');
    expect(exp(-745.25)).toBe(0);
    expect(exp(-746)).toBe(0);
    expect(Object.is(exp(-0), 1)).toBe(true);
  });

  it('handles the C library’s edge cases', () => {
    expect(exp(0)).toBe(1);
    expect(exp(1)).toBe(2.718281828459045);
    expect(exp(Infinity)).toBe(Infinity);
    expect(exp(-Infinity)).toBe(0);
    expect(Number.isNaN(exp(NaN))).toBe(true);
    expect(exp(1e300)).toBe(Infinity);
    expect(exp(-1e300)).toBe(0);
    expect(bitsOf(exp(1))).toBe('4005bf0a8b145769');
  });
});

/* ---------------------------------------------------------------- sin / cos */

/**
 * `sin`/`cos` are transcribed from the oracle's libm like `exp`, over the corpora the native
 * probe wrote (`native/raw/libm_census.c` over `native/raw/libm_args_{sin,cos}.txt`).  The
 * corpora hit both dispatch boundaries exactly (pi/4 and 524288.61698514968, with their ulp
 * neighbours), the Payne-Hanek range (1e6, 1e15, 1e300), the motion path's own arguments
 * (`yaw * DEGTORAD`) and the special paths (+-0, +-inf, NaN).
 */
describe('sin()/cos() — transcribed from the oracle’s libm', () => {
  const raw = (name: string) =>
    readFileSync(join(__dirname, '..', 'src', 'model', 'rng', 'native', 'raw', name), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.trim().split(/\s+/));

  function bitsOf(x: number): string {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(x, 0);
    return b.toString('hex');
  }

  function fromBits(h: string): number {
    return Buffer.from(h, 'hex').readDoubleBE(0);
  }

  it('matches every captured native sin() bit-for-bit', () => {
    const corpus = raw('libm_native_sin.txt');
    let checked = 0;
    let wrong = 0;
    const first: string[] = [];
    for (const row of corpus) {
      const x = fromBits(row[1]!);
      if (bitsOf(sin(x)) !== row[2]) {
        wrong += 1;
        if (first.length < 5) first.push(`sin(${x}) -> ${bitsOf(sin(x))}, native ${row[2]}`);
      }
      checked += 1;
    }
    if (wrong) throw new Error(`${wrong} mismatches, e.g. ${first.join('; ')}`);
    expect(checked).toBe(5055);
  });

  it('matches every captured native cos() bit-for-bit', () => {
    const corpus = raw('libm_native_cos.txt');
    let checked = 0;
    let wrong = 0;
    const first: string[] = [];
    for (const row of corpus) {
      const x = fromBits(row[1]!);
      if (bitsOf(cos(x)) !== row[2]) {
        wrong += 1;
        if (first.length < 5) first.push(`cos(${x}) -> ${bitsOf(cos(x))}, native ${row[2]}`);
      }
      checked += 1;
    }
    if (wrong) throw new Error(`${wrong} mismatches, e.g. ${first.join('; ')}`);
    expect(checked).toBe(5055);
  });

  it('is not Math.sin / Math.cos', () => {
    let v8Wrong = 0;
    let portWrong = 0;
    for (const [name, fn, v8] of [
      ['sin', sin, Math.sin],
      ['cos', cos, Math.cos],
    ] as [string, (x: number) => number, (x: number) => number][]) {
      for (const row of raw(`libm_native_${name}.txt`)) {
        const x = fromBits(row[1]!);
        if (bitsOf(v8(x)) !== row[2]) v8Wrong += 1;
        if (bitsOf(fn(x)) !== row[2]) portWrong += 1;
      }
    }
    // the census: V8 disagrees with the oracle on ~4.3 % of these values, the port on none
    expect(v8Wrong).toBeGreaterThan(300);
    expect(portWrong).toBe(0);
  });

  it('covers the branches: both dispatch boundaries, Payne-Hanek, the special paths', () => {
    const sinRows = new Set(raw('libm_native_sin.txt').map((r) => r[1]!));
    // the small/medium boundary and the medium/Payne-Hanek boundary, with ulp neighbours
    for (const b of ['3fe921fb54442d18', '412000013be57a40', '3fe921fb54442d19', '412000013be57a3f']) {
      expect(sinRows.has(b)).toBe(true);
    }
    expect(sinRows.has('7ff0000000000000')).toBe(true); // +inf
    expect(sinRows.has('fff0000000000000')).toBe(true); // -inf
    expect(sinRows.has('7ff8000000000000')).toBe(true); // NaN
    expect(sinRows.has('7e37e43c8800759c')).toBe(true); // 1e300
    // the motion path's own arguments are in the corpus: yaw * DEGTORAD, as a float
    const deg = Math.PI / 180;
    for (const yaw of [0, 45, 90, 180, 270]) {
      expect(sinRows.has(bitsOf(Math.fround(yaw * deg)))).toBe(true);
    }
    // the oracle's own values at two Payne-Hanek arguments (1e17, 1e300)
    expect(bitsOf(sin(fromBits('4376345785d8a000')))).toBe('bfddbadc7a119fc8');
    expect(bitsOf(cos(fromBits('4376345785d8a000')))).toBe('bfec567c5278afcb');
    expect(bitsOf(sin(1e300))).toBe('bfea2c16b010e385');
    expect(bitsOf(cos(1e300))).toBe('bfe2699022adc4c1');
    // exactly on the Pi/Hanek boundary: the medium reduction's last input
    expect(bitsOf(sin(fromBits('412000013be57a40')))).toBe('3fe6a09e668410ee');
    // and the very next double up goes through Payne-Hanek
    expect(bitsOf(sin(fromBits('412000013be57a41')))).toBe('3fe6a09e668f613e');
  });

  it('handles the C library’s edge cases', () => {
    expect(sin(0)).toBe(0);
    expect(Object.is(sin(-0), -0)).toBe(true);
    expect(cos(0)).toBe(1);
    expect(cos(-0)).toBe(1);
    expect(Number.isNaN(sin(Infinity))).toBe(true);
    expect(Number.isNaN(sin(-Infinity))).toBe(true);
    expect(Number.isNaN(cos(Infinity))).toBe(true);
    expect(Number.isNaN(cos(-Infinity))).toBe(true);
    expect(Number.isNaN(sin(NaN))).toBe(true);
    expect(Number.isNaN(cos(NaN))).toBe(true);
    // pi/4 is the small/medium boundary, and the oracle's sin there is NOT the correctly
    // rounded one (1 ulp low); cos(pi/4) is
    expect(bitsOf(sin(Math.PI / 4))).toBe('3fe6a09e667f3bcc');
    expect(bitsOf(sin(-Math.PI / 4))).toBe('bfe6a09e667f3bcc');
    expect(bitsOf(cos(Math.PI / 4))).toBe('3fe6a09e667f3bcd');
    expect(bitsOf(cos(Math.PI))).toBe('bff0000000000000');
  });
});

/* ---------------------------------------------------------------- sinf / cosf */

/**
 * The C++ `float` overloads (`CameraController.cc:78-80` passes a `float`) are transcribed
 * like the doubles, from `raw/sinf_bytes.bin` (`native/raw/dump_libm3.c`, tables extracted by
 * `native/gen_sinf_table.py`, C transcription `native/raw/apple_sinf_impl.h` diffed against
 * these very corpora first).  The corpora are 5,016 distinct float32 arguments each -- the
 * double corpora's arguments cast to float32 plus the camera's own `yaw * DEGTORAD` for 1,000
 * yaws (`native/raw/gen_libm_sinf_corpus.py`), captured by `native/raw/libm_census.c`'s
 * `sinf`/`cosf` cases, which print the float result promoted to double so the rows look like
 * the double corpora's.
 *
 * The regression these tests pin is the one `native/raw/sinf_decision.py` measured: rounding
 * the *double* transcription to float32 is not the float overload -- it disagrees on 304/5,016
 * (sin) and 135/5,016 (cos) of these arguments.
 */
describe('sinf()/cosf() — the float overloads, transcribed from the oracle’s libm', () => {
  const raw = (name: string) =>
    readFileSync(join(__dirname, '..', 'src', 'model', 'rng', 'native', 'raw', name), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.trim().split(/\s+/));

  function f32BitsOf(x: number): string {
    const b = Buffer.alloc(4);
    b.writeFloatBE(x, 0);
    return b.toString('hex');
  }

  function fromBits(h: string): number {
    return Buffer.from(h, 'hex').readDoubleBE(0);
  }

  /** The corpus row's argument, as the float32 the native call actually receives. */
  function argOf(row: string[]): number {
    return Math.fround(fromBits(row[1]!));
  }

  it('matches every captured native sinf() bit-for-bit', () => {
    const corpus = raw('libm_native_sinf.txt');
    let checked = 0;
    const first: string[] = [];
    for (const row of corpus) {
      const x = argOf(row);
      const got = f32BitsOf(sinf(x));
      if (got !== f32BitsOf(fromBits(row[2]!))) {
        if (first.length < 5) first.push(`sinf(${x}) -> ${got}, native ${row[2]}`);
      }
      checked += 1;
    }
    if (first.length) throw new Error(`mismatches, e.g. ${first.join('; ')}`);
    expect(checked).toBe(5016);
  });

  it('matches every captured native cosf() bit-for-bit', () => {
    const corpus = raw('libm_native_cosf.txt');
    let checked = 0;
    const first: string[] = [];
    for (const row of corpus) {
      const x = argOf(row);
      const got = f32BitsOf(cosf(x));
      if (got !== f32BitsOf(fromBits(row[2]!))) {
        if (first.length < 5) first.push(`cosf(${x}) -> ${got}, native ${row[2]}`);
      }
      checked += 1;
    }
    if (first.length) throw new Error(`mismatches, e.g. ${first.join('; ')}`);
    expect(checked).toBe(5016);
  });

  it('is not the double function narrowed to float32 — that is the regression it fixes', () => {
    // the measurement (`native/raw/sinf_decision.py`, `native/README.md` §3d): neither V8's
    // `Math.sin` nor this lane's transcribed double `sin`, rounded to float32, *is* `sinf`
    let v8Wrong = 0;
    let doublePortWrong = 0;
    let portWrong = 0;
    for (const [name, f32fn, doubleFn, v8] of [
      ['sinf', sinf, sin, Math.sin],
      ['cosf', cosf, cos, Math.cos],
    ] as [string, (x: number) => number, (x: number) => number, (x: number) => number][]) {
      for (const row of raw(`libm_native_${name}.txt`)) {
        const x = argOf(row);
        const want = f32BitsOf(fromBits(row[2]!));
        if (f32BitsOf(Math.fround(v8(x))) !== want) v8Wrong += 1;
        if (f32BitsOf(Math.fround(doubleFn(x))) !== want) doublePortWrong += 1;
        if (f32BitsOf(f32fn(x)) !== want) portWrong += 1;
      }
    }
    expect(v8Wrong).toBe(439); // 304 of the 5,016 sin arguments + 135 of the cos ones
    expect(doublePortWrong).toBe(439); // the same 439: no double-precision fix reaches them
    expect(portWrong).toBe(0);
  });

  it('covers the branches: the two dispatches, the tiny path and the special values', () => {
    const sinRows = new Set(raw('libm_native_sinf.txt').map((r) => r[1]!));
    const keyOf = (x: number) => {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(Math.fround(x), 0);
      return b.toString('hex');
    };
    // the corpus really does contain the float32 neighbour of pi/4 (the small/medium
    // boundary), +-0, 1 and the camera's own arguments (yaw * pi/180, the generator's DEGTORAD)
    for (const v of [Math.PI / 4, 0, 1]) expect(sinRows.has(keyOf(v))).toBe(true);
    for (const yaw of [0, 45, 90, 180, 270]) {
      expect(sinRows.has(keyOf(yaw * (Math.PI / 180)))).toBe(true);
    }
    // ... and that the 5,016 float32 arguments reach every branch: count them by range
    let small = 0;
    let medium = 0;
    let large = 0;
    for (const row of raw('libm_native_sinf.txt')) {
      const ax = Math.abs(argOf(row));
      if (ax >= 120) large += 1;
      else if (ax >= Math.PI / 4) medium += 1;
      else small += 1;
    }
    expect([small, medium, large]).toEqual([680, 2629, 1707]);

    // the oracle's own answers (from `native/raw/libm_census.c`, the shipped libm) at one value
    // per branch; the C transcription and the port both reproduce every one of them
    const cases: [string, (x: number) => number, number, string][] = [
      ['sinf', sinf, 0, '00000000'], // +-0 through the tiny path
      ['sinf', sinf, -0, '80000000'],
      ['sinf', sinf, 1e-20, '1e3ce508'], // tiny: fmaf(x, 2^26, x) * 2^-26 == x
      ['sinf', sinf, 3e-4, '399d4952'], // small: |x| < pi/4, the plain polynomial
      ['sinf', sinf, 0.7853981852531433, '3f3504f3'], // the float32 neighbour of pi/4
      ['sinf', sinf, 1, '3f576aa4'],
      ['sinf', sinf, 100, 'bf01a12e'], // medium: n*(pi/2) is still subtracted
      ['sinf', sinf, 119.99999237060547, '3f14a287'], // the last float below 120
      ['sinf', sinf, 120, '3f14a2ef'], // exactly the medium/table boundary
      ['sinf', sinf, 120.00000762939453, '3f14a358'], // the first float above it
      ['sinf', sinf, 524288, '3e2ba40f'], // the table path (the double sin's Payne-Hanek
      ['sinf', sinf, 1e6, 'beb33259'], //   boundary means nothing to the float one)
      ['sinf', sinf, 1e9, '3f0bbc66'],
      ['sinf', sinf, 3.4e38, 'be79f163'], // the largest finite float
      ['sinf', sinf, Infinity, '7fc00000'],
      ['sinf', sinf, -Infinity, '7fc00000'],
      ['sinf', sinf, NaN, '7fc00000'],
      ['cosf', cosf, 0, '3f800000'],
      ['cosf', cosf, -0, '3f800000'],
      ['cosf', cosf, 1e-20, '3f800000'], // the tiny path is (2^26 - |x|) * 2^-26 == 1.0f
      ['cosf', cosf, 2.44140625e-4, '3f800000'], // exactly 2^-12 is the last tiny input
      ['cosf', cosf, 3e-4, '3f7fffff'], // small: 1 + z*(...), one ulp under 1
      ['cosf', cosf, 0.7853981852531433, '3f3504f3'], // the pi/4 neighbour
      ['cosf', cosf, 1, '3f0a5140'],
      ['cosf', cosf, 100, '3f5cc0ee'],
      ['cosf', cosf, 119.99999237060547, '3f506e74'], // 120..2^26: the two-part pi/2
      ['cosf', cosf, 120, '3f506e2a'],
      ['cosf', cosf, 1e6, '3f6fcefd'],
      ['cosf', cosf, 1e9, '3f567fc6'],
      ['cosf', cosf, 67108864, 'bf683c6d'], // exactly 2^26: the table path
      ['cosf', cosf, 3.4e38, '3f7841ca'],
      ['cosf', cosf, Infinity, '7fc00000'],
      ['cosf', cosf, -Infinity, '7fc00000'],
    ];
    for (const [name, fn, x, want] of cases) {
      expect(f32BitsOf(fn(Math.fround(x))), `${name}(${x})`).toBe(want);
    }
  });
});

/* ---------------------------------------------------------------- sincosf */

/**
 * `__sincosf_stret` is the *two-output* entry point in the same `libsystem_m` unit (`sinf` is at
 * the symbol, `cosf` at `-0x110`, `__sincosf_stret` at `+0x1ac`) — not a pair of `sinf`/`cosf`
 * calls.  The native `CameraController::setRotationAngle( float )` calls it: its two adjacent
 * `sin(camrad)`/`cos(camrad)` calls are merged by LLVM's sincos combine, and the shipped
 * `libpolyworld.dylib` contains `bl ___sincosf_stret` (read off the symbol stub).
 *
 * The corpus (`native/raw/libm_native_sincosf.txt`, 5,016 float32 arguments, captured from the
 * *shipped* function by `native/raw/sincosf_census.c`, which reaches it through `dlsym`) is the
 * evidence that this is a different function from the scalar pair: its sine disagrees with
 * `sinf` on 305 of the rows and its cosine with `cosf` on 133 — including the argument the
 * recorded camera frames pin (see `L14`'s PORT-NOTE and `tests/monitor.test.ts`).
 */
describe('sincosf() — the oracle’s two-output float entry, transcribed', () => {
  const raw = (name: string) =>
    readFileSync(join(__dirname, '..', 'src', 'model', 'rng', 'native', 'raw', name), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.trim().split(/\s+/));

  function f32BitsOf(x: number): string {
    const b = Buffer.alloc(4);
    b.writeFloatBE(x, 0);
    return b.toString('hex');
  }

  function bitsOf(x: number): string {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(x, 0);
    return b.toString('hex');
  }

  function fromBits(h: string): number {
    return Buffer.from(h, 'hex').readDoubleBE(0);
  }

  it('matches every captured native row bit-for-bit, both outputs', () => {
    let checked = 0;
    const first: string[] = [];
    for (const row of raw('libm_native_sincosf.txt')) {
      const x = Math.fround(fromBits(row[1]!));
      const [s, c] = sincosf(x);
      const wantS = f32BitsOf(fromBits(row[2]!));
      const wantC = f32BitsOf(fromBits(row[3]!));
      if (f32BitsOf(s) !== wantS || f32BitsOf(c) !== wantC) {
        if (first.length < 5) {
          first.push(`sincosf(${x}) -> ${f32BitsOf(s)},${f32BitsOf(c)} native ${wantS},${wantC}`);
        }
      }
      checked += 1;
    }
    if (first.length) throw new Error(`mismatches, e.g. ${first.join('; ')}`);
    expect(checked).toBe(5016);
  });

  it('is not sinf / cosf — the difference the camera frames pin', () => {
    let sinDiff = 0;
    let cosDiff = 0;
    let portDiff = 0;
    for (const row of raw('libm_native_sincosf.txt')) {
      const x = Math.fround(fromBits(row[1]!));
      const [s, c] = sincosf(x);
      if (f32BitsOf(s) !== f32BitsOf(sinf(x))) sinDiff += 1;
      if (f32BitsOf(c) !== f32BitsOf(cosf(x))) cosDiff += 1;
      if (f32BitsOf(s) !== f32BitsOf(fromBits(row[2]!))) portDiff += 1;
      if (f32BitsOf(c) !== f32BitsOf(fromBits(row[3]!))) portDiff += 1;
    }
    // measured over the corpus: 305 of the sines and 133 of the cosines differ from the scalars
    expect(sinDiff).toBe(305);
    expect(cosDiff).toBe(133);
    expect(portDiff).toBe(0);

    // the exact argument of `camera.json` `rotate[3]` frame 3, the frame that moved when this
    // card first switched the camera to `sinf`/`cosf`: the shipped `cosf` gives one ulp less,
    // which walks the recorded position from bits 1123315328 to 1123315326.  (The two sines
    // agree on this argument; it is the cosine that separates the functions.)
    const camrad = Math.fround(-1.1122977733612061); // the float32-accumulated camera angle
    expect(f32BitsOf(sincosf(camrad)[1])).toBe('3ee29cc3');
    expect(f32BitsOf(cosf(camrad))).toBe('3ee29cc2');
    expect(f32BitsOf(sincosf(camrad)[0])).toBe('bf658f50');
    expect(f32BitsOf(sinf(camrad))).toBe('bf658f50');
  });

  it('handles the C library’s edge cases, including its own inf row', () => {
    expect(f32BitsOf(sincosf(Math.fround(0))[1])).toBe('3f800000');
    expect(f32BitsOf(sincosf(Math.fround(-0))[0])).toBe('80000000');
    expect(f32BitsOf(sincosf(Math.fround(1e-20))[0])).toBe('1e3ce508');
    expect(f32BitsOf(sincosf(Math.fround(1e-20))[1])).toBe('3f800000');
    // the shipped ±inf/NaN row is `(x - x)` copied into *both* outputs (measured)
    for (const v of [Infinity, -Infinity, NaN]) {
      const [s, c] = sincosf(v);
      expect(f32BitsOf(s), `sincosf(${v}) sin`).toBe('7fc00000');
      expect(f32BitsOf(c), `sincosf(${v}) cos`).toBe('7fc00000');
    }
    // one value per range, from the shipped function (sincosf_census.c)
    expect(f32BitsOf(sincosf(1)[0])).toBe('3f576aa4');
    expect(f32BitsOf(sincosf(100)[1])).toBe('3f5cc0ee');
    expect(f32BitsOf(sincosf(120)[1])).toBe('3f506e2a');
    expect(f32BitsOf(sincosf(1e9)[1])).toBe('3f567fc6');
    expect(f32BitsOf(sincosf(Math.fround(3.4e38))[1])).toBe('3f7841ca'); // |x| > 2^63: only the
    expect(f32BitsOf(sincosf(Math.fround(3.4e38))[0])).toBe('be79f163'); // quadrant bits survive
  });
});

/* ------------------------------------------------------------------------ pow */

/**
 * `pow` is transcribed from the oracle's libm like `exp`/`sin`/`cos`, and it is the last
 * function of the census (4,373/4,471 = 97.81 % correctly rounded, V8 4,084 = 91.3 %).  The
 * corpus is the 4,471-value `libm_native_pow.txt` the native probe wrote
 * (`native/raw/libm_census.c` over `native/raw/libm_args_pow.txt`): the recorded sweeps, the
 * dispatch guards as raw bit patterns, ±0/±inf/NaN, integral vs non-integral y, negative bases
 * with odd/even integer exponents, |y| tiny/huge, (1,y), (x,0) and subnormals.  The same file
 * is the evidence the C transcription (`native/raw/apple_pow_impl.h`) was diffed against, so
 * the two ports cannot disagree about what the oracle does.
 *
 * The ladder table below carries the cases the committed corpus does not happen to contain;
 * every row is captured from the shipped libm by `native/raw/wide_pow_sweep.py` (189,368
 * (x, y) pairs, all bit-exact), whose argument list re-derives each of them.
 *
 * `PORT-NOTE(W1d-fu/math-pow-is-engine-version-dependent)`: how *far* the transcription sits
 * from V8's `Math.pow` is a property of V8, not of this port, and V8 moved under this repo.
 * Over the same 4,471 recorded rows `Math.pow` disagrees with the oracle on **387** of them
 * under V8 12.4 (node 22.22.2 — the runtime the agent/worker sessions get) and on **9** under
 * V8 13.6 and 14.6 (node 24.21.0 / 26.7.0 — what a login shell resolves to, nvm's
 * `default -> 24`), while the port is off on **0 rows under every one of them**.  The test below
 * therefore asserts the differential contract — the port reproduces the recorded oracle
 * bit-for-bit and, wherever the engine disagrees with the oracle, takes the *oracle's* side —
 * and keeps the engine-specific count only as a direction (`> 0`: the corpus does discriminate
 * this V8's `Math.pow`).  An engine-pinned `expect(...).toBe(<count>)` here is what turned this
 * lane red when the shell's node changed (V8 12.4 -> 13.6), not any change in the port.
 */
describe('pow() — transcribed from the oracle’s libm', () => {
  const raw = (name: string) =>
    readFileSync(join(__dirname, '..', 'src', 'model', 'rng', 'native', 'raw', name), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.trim().split(/\s+/));

  function bitsOf(x: number): string {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(x, 0);
    return b.toString('hex');
  }

  function fromBits(h: string): number {
    return Buffer.from(h, 'hex').readDoubleBE(0);
  }

  it('matches every captured native pow() bit-for-bit', () => {
    const corpus = raw('libm_native_pow.txt');
    let checked = 0;
    let wrong = 0;
    const first: string[] = [];
    for (const row of corpus) {
      const x = fromBits(row[1]!);
      const y = fromBits(row[2]!);
      const got = bitsOf(pow(x, y));
      if (got !== row[3]) {
        wrong += 1;
        if (first.length < 5) first.push(`pow(${row[1]}, ${row[2]}) -> ${got}, native ${row[3]}`);
      }
      checked += 1;
    }
    if (wrong) throw new Error(`${wrong} mismatches, e.g. ${first.join('; ')}`);
    expect(checked).toBe(4471);
  });

  it('is not Math.pow — and where this V8 differs from the oracle, so does the port', () => {
    let v8Wrong = 0; // rows where this engine's `Math.pow` disagrees with the recorded oracle
    let portWrong = 0; // rows where the transcription disagrees with it — the acceptance: 0
    let portTookTheOraclesSide = 0; // ...restricted to the engine's own disagreements
    for (const row of raw('libm_native_pow.txt')) {
      const x = fromBits(row[1]!);
      const y = fromBits(row[2]!);
      const want = row[3]!;
      // Math.pow(NaN, 0) is 1 in V8, as in C, so the comparison is well defined
      const gotV8 = bitsOf(Math.pow(x, y));
      const got = bitsOf(pow(x, y));
      if (got !== want) portWrong += 1;
      if (gotV8 !== want) {
        v8Wrong += 1;
        if (got === want && got !== gotV8) portTookTheOraclesSide += 1;
      }
    }
    // the acceptance: the oracle's bits on every recorded row, under any engine
    expect(portWrong).toBe(0);
    // ...and the corpus is not the engine's function: wherever this V8's `Math.pow` leaves the
    // oracle, the port leaves it too (measured 387 rows under V8 12.4, 9 under V8 13.6/14.6)
    expect(portTookTheOraclesSide).toBe(v8Wrong);
    expect(v8Wrong).toBeGreaterThan(0);
  });

  it('reproduces the oracle across the whole special-case ladder', () => {
    const INF = Infinity;
    const NAN = NaN;
    const ladder: [number, number, string][] = [
      [2.0, 0.0, '3ff0000000000000'], [2.0, -0.0, '3ff0000000000000'],
      [-0.0, 0.0, '3ff0000000000000'], [-2.0, -0.0, '3ff0000000000000'],
      [NAN, 0.0, '3ff0000000000000'], [1.0, 1.0, '3ff0000000000000'],
      [1.0, INF, '3ff0000000000000'], [1.0, -INF, '3ff0000000000000'],
      [1.0, NAN, '3ff0000000000000'], [1.0, 1e300, '3ff0000000000000'],
      [1.0, -1e300, '3ff0000000000000'],
      [-2.0, 3.0, 'c020000000000000'], [-2.0, 4.0, '4030000000000000'],
      [-2.0, -3.0, 'bfc0000000000000'], [-2.0, -4.0, '3fb0000000000000'],
      [-2.0, 0.5, '7ff8000000000000'], [-2.0, -0.5, '7ff8000000000000'],
      [-0.0, 3.0, '8000000000000000'], [-0.0, 4.0, '0000000000000000'],
      [-0.0, -3.0, 'fff0000000000000'], [-0.0, -4.0, '7ff0000000000000'],
      [-0.0, 3.5, '0000000000000000'], [-0.0, -3.5, '7ff0000000000000'],
      [0.0, 1.0, '0000000000000000'], [0.0, -1.0, '7ff0000000000000'],
      [0.0, 0.5, '0000000000000000'], [0.0, -0.5, '7ff0000000000000'],
      [INF, 1.0, '7ff0000000000000'], [INF, -1.0, '0000000000000000'],
      [INF, 0.5, '7ff0000000000000'], [INF, -0.5, '0000000000000000'],
      [-INF, 3.0, 'fff0000000000000'], [-INF, 4.0, '7ff0000000000000'],
      [-INF, -3.0, '8000000000000000'], [-INF, -4.0, '0000000000000000'],
      [-INF, 0.5, '7ff0000000000000'], [-INF, -0.5, '0000000000000000'],
      [NAN, 3.0, '7ff8000000000000'], [2.0, NAN, '7ff8000000000000'],
      // |y| at the 2^64 / 2^-65 thresholds (the ladder's own range guards)
      [2.0, INF, '7ff0000000000000'], [2.0, -INF, '0000000000000000'],
      [0.5, INF, '0000000000000000'], [0.5, -INF, '7ff0000000000000'],
      [2.0 ** 64, 3.0, '4bf0000000000000'], [-(2.0 ** 64), 3.0, 'cbf0000000000000'],
      [2.0 ** 64, 0.5, '41f0000000000000'],
      [3.0, 2.0 ** 64, '7ff0000000000000'], [3.0, -(2.0 ** 64), '0000000000000000'],
      [0.5, 2.0 ** 64, '0000000000000000'], [0.5, -(2.0 ** 64), '7ff0000000000000'],
      [-3.0, 2.0 ** 64, '7ff0000000000000'], [-3.0, -(2.0 ** 64), '0000000000000000'],
      [3.0, 2.0 ** -65, '3ff0000000000000'], [0.5, 2.0 ** -65, '3ff0000000000000'],
      [3.0, fromBits('3be0000000000001'), '3ff0000000000000'],
      [0.5, fromBits('3be0000000000001'), '3ff0000000000000'],
      [1.0, 2.0 ** -65, '3ff0000000000000'],
      // subnormal and extreme bases (the normalising branch, and y == 1)
      [5e-324, 1.0, '0000000000000001'], [1e-310, 1.0, '000012688b70e62b'],
      [-5e-324, 1.0, '8000000000000001'], [-1e-310, 3.0, '8000000000000000'],
      [5e-324, 2.0, '0000000000000000'], [2.0, 5e-324, '3ff0000000000000'],
      [1e-310, 1e-310, '3ff0000000000000'],
      [fromBits('0010000000000000'), 1.0, '0010000000000000'],
      [fromBits('7fefffffffffffff'), 1.0, '7fefffffffffffff'],
    ];
    const wrong: string[] = [];
    for (const [x, y, want] of ladder) {
      const got = bitsOf(pow(x, y));
      if (got !== want) wrong.push(`pow(${x}, ${y}) -> ${got}, oracle ${want}`);
    }
    if (wrong.length) throw new Error(wrong.join('; '));
    expect(ladder.length).toBe(66);
  });

  it('covers the dispatch guards and the branches the corpus names', () => {
    const corpus = raw('libm_native_pow.txt');
    const xs = new Set(corpus.map((r) => r[1]!));
    const ys = new Set(corpus.map((r) => r[2]!));
    // the fast-path guards are compared as bit patterns, so the corpus records them that way
    for (const pat of ['3ff0000000000000', '0000000000000000', '8000000000000000',
                       '7ff0000000000000']) {
      expect(xs.has(pat)).toBe(true);
    }
    for (const pat of ['0000000000000000', '7ff0000000000000', 'fff0000000000000',
                       '7ff8000000000000']) {
      expect(ys.has(pat)).toBe(true);
    }
    // the corpus hits both ends of the result range: overflow to +-inf and underflow to 0
    const results = corpus.map((r) => r[3]!);
    expect(results).toContain('7ff0000000000000');
    expect(results).toContain('0000000000000000');
    expect(results.filter((r) => r === '7ff8000000000000').length).toBeGreaterThan(0);
    // …and it is not dominated by one shape: three genome paths plus the distributions feed it
    expect(new Set(results).size).toBeGreaterThan(4000);
  });
});

/* ------------------------------------------------------------------------ powf */

/**
 * `powf` is the *float* overload — the one the two `_powf` sites in the model actually call
 * (`normalPDF`/`getNormal`'s `pow(e, rightTop/rightBottom)` and `mateProbability`'s
 * `pow(fabs(cosa), MISC_INVIS_SLOPE)`), transcribed like `pow` but from its own machine code:
 * `src/model/rng/native/raw/powf_bytes.bin` + `powf_tables.bin` (dumps of the live libSystem
 * by `raw/dump_libm4.c`), tables extracted *and checked* by `native/gen_powf_table.py`, the C
 * transcription `raw/apple_powf_impl.h` diffed byte-for-byte against the corpus before this
 * port (0 differences on all 7 325 rows).
 *
 * The corpus `libm_native_powf.txt` is the 7 325-argument file `raw/gen_libm_powf_corpus.py`
 * builds for `raw/libm_census.c` (`powf <argbits> <argbits> <resultbits>`, both arguments the
 * float32 values the C++ call sites pass, printed as the doubles they promote to).  It carries
 * four sources, so a port cannot pass one of them and be wrong where the model calls it:
 *
 *  * the model's own `(e, -(x-mu)^2/(2 sigma^2))` pairs, re-derived from L10's pinned
 *    `normalpdf_sweep.tsv` (1 296 rows, each carrying the oracle's own `right`);
 *  * `mateProbability`'s `(fabs(cosa), slope)` lattice;
 *  * a wide float lattice over every binade, the binade boundaries, subnormals and the
 *    exponent lattice of the model's own base;
 *  * the special-case ladder: `±0`, `±inf`, NaN on either side, negative bases with odd/even
 *    integer exponents, and the overflow/underflow ends.
 *
 * The numbers below are the "do we need this at all" measurement: on this corpus `f32(pow(x,y))`
 * (the double transcription narrowed) is off on 37 rows — engine-independent, it is the port's
 * own double function measured against the recorded oracle — while V8's `Math.pow` is off on
 * 196 rows under V8 12.4 and on 42 under V8 13.6/14.6, the port on none under either
 * (`PORT-NOTE(W1d-fu/math-pow-is-engine-version-dependent)`; `npx tsx tools/measure_powf.ts`
 * prints all three counts for the engine it runs under).
 */
describe('powf() — the float overload, transcribed from the oracle’s libm', () => {
  const rawF = (name: string) =>
    readFileSync(join(__dirname, '..', 'src', 'model', 'rng', 'native', 'raw', name), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.trim().split(/\s+/));

  const f32d = (x: number): number => Math.fround(x);

  function f32BitsOf(x: number): string {
    const b = Buffer.alloc(4);
    b.writeFloatLE(x, 0);
    return b.readUInt32LE(0).toString(16).padStart(8, '0');
  }

  function f32FromBits(h: string): number {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(parseInt(h, 16), 0);
    return b.readFloatLE(0);
  }

  function dFromBits(h: string): number {
    return Buffer.from(h, 'hex').readDoubleBE(0);
  }

  it('matches every captured native powf() bit-for-bit', () => {
    const corpus = rawF('libm_native_powf.txt');
    const first: string[] = [];
    let wrong = 0;
    for (const row of corpus) {
      const x = f32d(dFromBits(row[1]!));
      const y = f32d(dFromBits(row[2]!));
      const want = f32BitsOf(f32d(dFromBits(row[3]!)));
      const got = f32BitsOf(powf(x, y));
      if (got !== want) {
        wrong += 1;
        if (first.length < 5) first.push(`powf(${row[1]}, ${row[2]}) -> ${got}, native ${want}`);
      }
    }
    if (wrong) throw new Error(`${wrong} mismatches, e.g. ${first.join('; ')}`);
    expect(corpus.length).toBe(7325);
  });

  it('is neither f32(pow) (37 rows) nor this engine’s Math.pow (196 / 42, by V8)', () => {
    let v8Wrong = 0; // rows where this engine's Math.pow leaves the recorded oracle
    let powWrong = 0; // rows where the *double* transcription narrowed to f32 leaves it
    for (const row of rawF('libm_native_powf.txt')) {
      const x = f32d(dFromBits(row[1]!));
      const y = f32d(dFromBits(row[2]!));
      const want = f32BitsOf(f32d(dFromBits(row[3]!)));
      if (f32BitsOf(f32d(Math.pow(x, y))) !== want) v8Wrong += 1;
      if (f32BitsOf(f32d(pow(x, y))) !== want) powWrong += 1;
    }
    // engine-independent, and the regression this lane exists for: rounding the *double*
    // transcription to float32 is not the float overload — the same 37 rows under V8 12.4, 13.6
    // and 14.6, because both sides of the comparison are the port's.
    expect(powWrong).toBe(37);
    // engine-dependent direction only: V8's `Math.pow` is closer to Apple's libm in the newer
    // V8 (196 rows off the oracle under 12.4, 42 under 13.6/14.6 — see the PORT-NOTE above and
    // the `pow` block's), while `powf` itself is off on 0 rows under either (the corpus test
    // above), i.e. it *is* a different function from this engine's `Math.pow` on every row
    // counted here.
    expect(v8Wrong).toBeGreaterThan(0);
  });

  it('reproduces the oracle across the whole special-case ladder', () => {
    const INF = Infinity;
    const NAN = NaN;
    const f = (x: number) => Math.fround(x);
    const p32 = (h: string) => f32BitsOf(f32FromBits(h));
    const ladder: [number, number, string][] = [
      // every row's expected value is the *oracle's* own float32 result (captured from
      // the shipped `powf` at transcript time), never a value computed in this file
      [1.0, 1.0, '3f800000'],
      [1.0, NAN, '3f800000'],
      [1.0, INF, '3f800000'],
      [0.699999988079071, 1.0, '3f333333'],
      [-2.0, 1.0, 'c0000000'],
      [2.0, 0.0, '3f800000'],
      [2.0, -0.0, '3f800000'],
      [-2.0, 0.0, '3f800000'],
      [0.0, 0.0, '3f800000'],
      [-0.0, -0.0, '3f800000'],
      [INF, 0.0, '3f800000'],
      [NAN, 0.0, '3f800000'],
      [0.5, 0.0, '3f800000'],
      [2.0, INF, '7f800000'],
      [2.0, -INF, '00000000'],
      [0.5, INF, '00000000'],
      [0.5, -INF, '7f800000'],
      [-2.0, INF, '7f800000'],
      [-2.0, -INF, '00000000'],
      [-1.0, INF, '3f800000'],
      [-1.0, -INF, '3f800000'],
      [INF, INF, '7f800000'],
      [NAN, INF, '7fc00000'],
      [2.0, NAN, '7fc00000'],
      [NAN, NAN, '7fc00000'],
      [-1.0, NAN, '7fc00000'],
      [INF, NAN, '7fc00000'],
      [0.0, 2.0, '00000000'],
      [-0.0, 2.0, '00000000'],
      [-0.0, 3.0, '80000000'],
      [0.0, -3.0, '7f800000'],
      [-0.0, -3.0, 'ff800000'],
      [-0.0, -2.0, '7f800000'],
      [0.0, 0.5, '00000000'],
      [0.0, -0.5, '7f800000'],
      [-0.0, 2.5, '00000000'],
      [0.0, INF, '00000000'],
      [-0.0, INF, '00000000'],
      [INF, 2.0, '7f800000'],
      [INF, -2.0, '00000000'],
      [-INF, 3.0, 'ff800000'],
      [-INF, 4.0, '7f800000'],
      [-INF, -3.0, '80000000'],
      [-INF, 2.5, '7f800000'],
      [INF, 16777216.0, '7f800000'],
      [-2.0, 3.0, 'c1000000'],
      [-2.0, 4.0, '41800000'],
      [-2.0, -3.0, 'be000000'],
      [-2.0, 2.5, '7fc00000'],
      [-2.0, 0.5, '7fc00000'],
      [-1.5, 5.0, 'c0f30000'],
      [-1.0000000150474662e+30, 3.0, 'ff800000'],
      [-1.0000000150474662e+30, 4.0, '7f800000'],
      [-2.0, 16777216.0, '7f800000'],
      [-2.0, 16777215.0, 'ff800000'],
      [-2.0, -16777215.0, '80000000'],
      [-1.5, 8388609.0, 'ff800000'],
      [-1.5, f(33554433.0), '7f800000'],
      [-2.0, f(33554433.0), '7f800000'],
      [-0.5, f(33554433.0), '00000000'],
      [1.401298464324817e-45, 2.0, '00000000'],
      [1.401298464324817e-45, -1.0, '7f800000'],
      [5.877471754111438e-39, 2.0, '00000000'],
      [1.1754943508222875e-38, 2.0, '00000000'],
      [7.174648137343064e-43, -2.0, '7f800000'],
      [2.0, 200.0, '7f800000'],
      [2.0, -200.0, '00000000'],
      [1.0000000150474662e+30, -3.0, '00000000'],
      [1.0000000150474662e+30, 3.0, '7f800000'],
      [2.0, 3.4028234663852886e+38, '7f800000'],
      [2.0, -3.4028234663852886e+38, '00000000'],
      [0.5, 3.4028234663852886e+38, '00000000'],
      [2.0, 1.0, '40000000'],
      [2.7182817459106445, 0.0, '3f800000'],
      [2.7182817459106445, -1.0, '3ebc5ab2'],
      [2.7182817459106445, -0.5, '3f1b4598'],
      [2.7182817459106445, -0.125, '3f61eb51'],
      [2.7182817459106445, -0.03125, '3f781fab'],
      [2.7182817459106445, -2.0, '3e0a9556'],
    ];
    const wrong: string[] = [];
    for (const [x, y, want] of ladder) {
      const got = f32BitsOf(powf(x, y));
      if (got !== want) wrong.push(`powf(${x}, ${y}) -> ${got}, oracle ${want}`);
    }
    if (wrong.length) throw new Error(wrong.join('; '));
    expect(ladder.length).toBe(79);
  });

  it('covers the dispatch guards, the branches and the model’s own domain', () => {
    const corpus = rawF('libm_native_powf.txt');
    const xs = new Set(corpus.map((r) => f32BitsOf(f32d(dFromBits(r[1]!)))));
    const ys = new Set(corpus.map((r) => f32BitsOf(f32d(dFromBits(r[2]!)))));
    for (const pat of ['3f800000', '00000000', '80000000', '7f800000', 'ff800000',
                       '7fc00000']) {
      expect(xs.has(pat)).toBe(true);
      expect(ys.has(pat)).toBe(true);
    }
    // the |y| dispatch guard, both sides of it (FLT_MAX and the largest value below)
    expect(ys.has('7f7fffff')).toBe(true);
    expect(corpus.some((r) => f32BitsOf(f32d(dFromBits(r[2]!))) === '7f800000')).toBe(true);
    // the model's own exponent: `(e, ratio)` with the base the float literal narrows to
    expect(xs.has(f32BitsOf(f32d(2.7182818)))).toBe(true);
    // both ends of the result range are present, and NaNs are not accidental
    const results = corpus.map((r) => f32BitsOf(f32d(dFromBits(r[3]!))));
    expect(results).toContain('7f800000');
    expect(results).toContain('00000000');
    expect(results.filter((r) => r === '7fc00000').length).toBeGreaterThan(0);
    expect(new Set(results).size).toBeGreaterThan(2000);
  });
});

/* ----------------------------------------------------------------------- atan2f */

/**
 * `atan2f` is the *other* float overload the model calls — `frustumXZ::Inside` (`gmisc.cc:335`)
 * computes `float ang = atan2(x0 - p[0], z0 - p[2])` from two floats (lane W1e).  It is
 * transcribed like `powf`, from its own machine code: `src/model/rng/native/raw/atan2f_bytes.bin`
 * (a dump of the live libSystem by `dump_libm5.c`), the nine polynomial constants and the eight
 * angle constants extracted *and checked* by `native/gen_atan2f_table.py` (it decodes the
 * `adr`/`adrp`+`add`/`ldr` displacements that read them), the C transcription
 * `raw/apple_atan2f_impl.h` diffed against the corpus before this port.
 *
 * The corpus is lane W1e's census — `src/model/geometry/native/{atan2fprobe.c,atan2fprobe.sh}`,
 * `raw/atan2f_args.txt` + `raw/atan2f_native.txt`, 20,050 argument pairs over 12 argument
 * classes, read here directly because that is the committed census the card's acceptance quotes.
 * Each line is `atan2f <ybits> <xbits> <shipped atan2f bits> <f32(atan2) bits>`, so both
 * numbers below are the oracle's, captured once, not recomputed in this file.
 *
 * The measurement that forced the transcription: the shipped `atan2f` is **not** the correctly
 * rounded `f32(atan2)` (3,924 of the 20,050 rows differ by 1 ulp), and the stand-in the port
 * used before it — `f32(Math.atan2)` plus the two ±π values — differed from the shipped function
 * on 460 rows, every one of them outside the ±π family.  The transcription is exact on all of
 * them; `npx tsx tools/measure_atan2f.ts` prints the same counts per class.
 */
describe('atan2f() — the float overload, transcribed from the oracle’s libm', () => {
  const GEO_RAW = join(__dirname, '..', 'src', 'model', 'geometry', 'native', 'raw');

  function censusRows(): string[][] {
    return readFileSync(join(GEO_RAW, 'atan2f_native.txt'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('#'))
      .map((l) => l.trim().split(/\s+/));
  }

  function classOf(): Map<string, string> {
    const out = new Map<string, string>();
    for (const l of readFileSync(join(GEO_RAW, 'atan2f_args.txt'), 'utf8').split('\n')) {
      const t = l.trim();
      if (t === '' || t.startsWith('#')) continue;
      const f = t.split(/\s+/);
      out.set(`${f[0]} ${f[1]}`, f[2] ?? 'unlabelled');
    }
    return out;
  }

  function f32BitsOf(x: number): string {
    const b = Buffer.alloc(4);
    b.writeFloatLE(Math.fround(x), 0);
    return b.readUInt32LE(0).toString(16).padStart(8, '0');
  }

  function f32FromBits(h: string): number {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(parseInt(h, 16), 0);
    return b.readFloatLE(0);
  }

  it('matches every captured native atan2f() bit-for-bit', () => {
    const corpus = censusRows();
    const first: string[] = [];
    let wrong = 0;
    for (const row of corpus) {
      const y = f32FromBits(row[1]!);
      const x = f32FromBits(row[2]!);
      const want = row[3]!;
      const got = f32BitsOf(atan2f(y, x));
      if (got !== want) {
        wrong += 1;
        if (first.length < 5) first.push(`atan2f(${row[1]}, ${row[2]}) -> ${got}, native ${want}`);
      }
    }
    if (wrong) throw new Error(`${wrong} mismatches, e.g. ${first.join('; ')}`);
    expect(corpus.length).toBe(20050);
  });

  it('is not a Math.atan2 stand-in (the deleted one missed 460 of the same 20,050 rows)', () => {
    // the *oracle*'s own f32(atan2) column, so this is "the shipped function is not the
    // correctly rounded one" and not a claim about V8:
    let nativeVsCorrect = 0;
    let v8Wrong = 0;
    for (const row of censusRows()) {
      const y = f32FromBits(row[1]!);
      const x = f32FromBits(row[2]!);
      if (row[3] !== row[4]) nativeVsCorrect += 1;
      if (f32BitsOf(Math.atan2(y, x)) !== row[3]!) v8Wrong += 1;
    }
    expect(nativeVsCorrect).toBe(3924); // the census' headline number, re-derived here
    // …and V8 agrees with the C library's double function, so `f32(Math.atan2)` is the same
    // candidate the stand-in was: it is *the wrong function*, by 1 ulp, on 19.571 % of rows.
    expect(v8Wrong).toBe(3924);
  });

  it('has the exact ±π family right by construction, arm64’s low π included', () => {
    // arm64's atan2f answers 0x40490FDA for the exact ±π (the correctly rounded value is
    // 0x40490FDB); that is ATAN2F_PI_HI, the constant the small-|y/x| arm returns.
    expect(f32BitsOf(atan2f(0, -1))).toBe('40490fda');
    expect(f32BitsOf(atan2f(-0, -1))).toBe('c0490fda');
    expect(f32BitsOf(atan2f(0, -0))).toBe('40490fda'); // the origin's -0 x arm
    expect(f32BitsOf(atan2f(-0, -0))).toBe('c0490fda');
    expect(f32BitsOf(Math.atan2(0, -1))).toBe('40490fdb');
    // the ±π/2 and ±π/4 boundaries are the exact double constants, so they round to the
    // correctly rounded float: pi/2 -> 3fc90fdb, 3pi/4 -> 4016cbe4, pi/4 -> 3f490fdb
    expect(f32BitsOf(atan2f(1, 0))).toBe('3fc90fdb');
    expect(f32BitsOf(atan2f(1, -1))).toBe('4016cbe4');
    expect(f32BitsOf(atan2f(1, 1))).toBe('3f490fdb');
    expect(f32BitsOf(atan2f(-1, -1))).toBe('c016cbe4');
    expect(f32BitsOf(atan2f(-1, 1))).toBe('bf490fdb');
    expect(f32BitsOf(atan2f(1, -0))).toBe('3fc90fdb');
    expect(f32BitsOf(atan2f(-1, 0))).toBe('bfc90fdb');
    // the origin itself keeps the argument's sign (and +-0 for x = +0)
    expect(f32BitsOf(atan2f(0, 0))).toBe('00000000');
    expect(f32BitsOf(atan2f(-0, 0))).toBe('80000000');
  });

  it('covers the census’ argument classes, the model’s own lattice included', () => {
    const classes = classOf();
    const seen = new Map<string, number>();
    for (const row of censusRows()) {
      const cls = classes.get(`${row[1]} ${row[2]}`) ?? 'unlabelled';
      seen.set(cls, (seen.get(cls) ?? 0) + 1);
    }
    expect(seen.get('reachable-lattice')).toBe(4532); // differences of WorldSize-25 coordinates
    expect([...seen.keys()].length).toBe(12);
    // the classes that carried the pre-transcription residual are all in the corpus
    for (const cls of ['reachable-uniform', 'midpoint-sweep', 'pi-boundary', 'denormals', 'zeros',
                       'specials', 'quadrant-edge', 'binade-lattice', 'all-magnitudes']) {
      expect(seen.has(cls)).toBe(true);
    }
  });

  it('answers NaN the way the machine does (y + x through the y >= x arm)', () => {
    const NaNin = NaN;
    expect(f32BitsOf(atan2f(NaNin, 1))).toBe('7fc00000');
    expect(f32BitsOf(atan2f(1, NaNin))).toBe('7fc00000');
    expect(f32BitsOf(atan2f(NaNin, NaNin))).toBe('7fc00000');
    expect(f32BitsOf(atan2f(NaNin, -1))).toBe('7fc00000');
    expect(f32BitsOf(atan2f(Infinity, Infinity))).toBe('3f490fdb'); // y == x, both +inf
    expect(f32BitsOf(atan2f(Infinity, -Infinity))).toBe('4016cbe4');
  });
});

/* ------------------------------------------------------------------ surface */

describe('RngSurface — the process-global streams', () => {
  it('keeps rand() and drand48() independent streams', () => {
    const a = createRngSurface();
    const b = createRngSurface();
    a.srand(1);
    b.srand(1);
    a.srand48(2);
    b.srand48(2);
    const firstA = a.drand48();
    a.rand();
    a.rand();
    const secondA = a.drand48();
    const firstB = b.drand48();
    const secondB = b.drand48();
    expectExact(firstA, firstB, 'first drand48');
    expectExact(secondA, secondB, 'second drand48');
  });

  it('is one shared instance through globalRngSurface()', () => {
    resetGlobalRngSurface();
    const a = globalRngSurface();
    const b = globalRngSurface();
    expect(a).toBe(b);
    const reference = createRngSurface();
    reference.srand48(42);
    const expected = reference.drand48();
    a.srand48(42);
    expect(b.drand48()).toBe(expected);
  });

  it('exposes the frozen RngSurface shape', () => {
    const s = createRngSurface();
    for (const k of ['srand', 'rand', 'srand48', 'drand48', 'lrand48', 'nrand', 'nrandScaled']) {
      expect(typeof (s as unknown as Record<string, unknown>)[k]).toBe('function');
    }
  });
});

describe('RandomNumberGenerator — native routing', () => {
  // The Role→Type table is a native static and the test below flips one entry; restore the
  // defaults (all GLOBAL) so nothing leaks into whatever runs after this block.
  afterAll(() => {
    RandomNumberGenerator.set(RngRole.NERVOUS_SYSTEM, RngType.GLOBAL);
    RandomNumberGenerator.set(RngRole.TOPOLOGICAL_DISTORTION, RngType.GLOBAL);
    RandomNumberGenerator.set(RngRole.INIT_WEIGHT, RngType.GLOBAL);
  });
  it('GLOBAL routes drand()/nrand() to the shared surface', () => {
    const s = createRngSurface();
    const rng = RandomNumberGenerator.create(RngRole.NERVOUS_SYSTEM, s);
    rng.seed(42);
    const want = createRngSurface();
    want.srand48(42);
    expectExact(rng.drand(), want.drand48(), 'GLOBAL drand');
    expectExact(rng.nrand(), want.nrand(), 'GLOBAL nrand');
    expectExact(rng.range(10, 20), want.drand48() * 10 + 10, 'GLOBAL range');
  });

  it('seedIfLocal is a no-op for GLOBAL and seeds for LOCAL', () => {
    const s = createRngSurface();
    const global = RandomNumberGenerator.create(RngRole.NERVOUS_SYSTEM, s);
    global.seedIfLocal(5);
    const fresh = createRngSurface();
    expectExact(global.drand(), fresh.drand48(), 'GLOBAL untouched by seedIfLocal');

    RandomNumberGenerator.set(RngRole.TOPOLOGICAL_DISTORTION, RngType.LOCAL);
    const local = RandomNumberGenerator.create(RngRole.TOPOLOGICAL_DISTORTION, s);
    local.seedIfLocal(5);
    const mt = new Mt19937(5);
    expectExact(local.drand(), mt.uniform(), 'LOCAL seeded');
    expectExact(local.nrand(), mt.gaussian(), 'LOCAL gaussian');
  });
});

/* ------------------------------------------------------------------ hygiene */

describe('determinism hygiene', () => {
  const dir = join(__dirname, '..', 'src', 'model', 'rng');

  function laneSources(): string[] {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => join(dir, f));
  }

  it('has no Math.random anywhere in the lane', () => {
    for (const file of laneSources()) {
      expect(readFileSync(file, 'utf8')).not.toContain('Math.random(');
    }
  });

  it('has no Math.log call (the oracle’s libm is not V8’s)', () => {
    for (const file of laneSources()) {
      expect(readFileSync(file, 'utf8')).not.toContain('Math.log(');
    }
  });
});
