/**
 * Lane W1e — the `atan2f` census, checked against the ported float overload.
 *
 *   npx tsx tools/measure_atan2f.ts [native-output.txt [args.txt]]
 *
 * Reads a native census (`src/model/geometry/native/raw/atan2f_native.txt` by default, written by
 * `native/atan2fprobe.sh census`) whose lines are
 *
 *     atan2f <ybits> <xbits> <atan2f_result_bits> <f32_atan2_result_bits>
 *
 * and answers, per argument class taken from the corpus (`raw/atan2f_args.txt`):
 *
 *   * `native`    — the shipped `atan2f` vs `(float)atan2((double)y,(double)x)`: "does arm64's
 *                   float overload differ from the correctly rounded stand-in, and on which
 *                   arguments?" — the question PARITY.md *Open questions* 4 leaves open;
 *   * `port`      — the port's `nativeAtan2f` (a delegation to the transcribed `atan2f`) vs the
 *                   shipped `atan2f`.  Since `t_4bb10112` this is **0 on every corpus and every
 *                   class** — it was 460/20,050 when `nativeAtan2f` was `f32(Math.atan2)` plus
 *                   the two +-pi values, and the numbers in PARITY.md's table are that
 *                   pre-transcription stand-in's;
 *   * `libm`      — the transcription itself (`rng/libm.ts`'s `atan2f`), measured *directly*
 *                   rather than through the geometry lane's delegation, so a future rewrite of
 *                   `nativeAtan2f` cannot hide behind it;
 *   * `v8`        — `f32(Math.atan2)`, i.e. the deleted stand-in without its pi corrections, so
 *                   "the port is not `Math.atan2`-based" is a number and not a claim.
 *
 * The ulp distances are counted with the port's own `f32UlpDistance`, so NaN/inf pairs count as
 * "infinite" and are reported separately rather than as a giant number.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { f32, f32Bits, f32UlpDistance, nativeAtan2f } from '../src/model/geometry/float';
import { atan2f } from '../src/model/rng/libm';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, '..', 'src', 'model', 'geometry', 'native', 'raw');

function bitsOf(x: number): number {
  return f32Bits(x) >>> 0;
}

function fromBits(u: number): number {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(u >>> 0, 0);
  return b.readFloatLE(0);
}

function hex(u: number): string {
  return (u >>> 0).toString(16).padStart(8, '0');
}

function isNaN32(u: number): boolean {
  return (u & 0x7f800000) === 0x7f800000 && (u & 0x007fffff) !== 0;
}

/** A float either side of zero, i.e. `-0` written as `80000000` counts as zero magnitude. */
function isPi32(u: number): boolean {
  const v = u & 0x7fffffff;
  return v === 0x40490fdb || v === 0x40490fda || v === 0x40490fd9;
}

interface Counts {
  rows: number;
  nativeDiff: number;
  nativeLow: number;
  nativeHigh: number;
  portDiff: number;
  libmDiff: number;
  v8Diff: number;
  worstNativeUlp: number;
  worstPortUlp: number;
  worstLibmUlp: number;
  worstV8Ulp: number;
  nanDisagree: number;
  examples: string[];
}

function emptyCounts(): Counts {
  return {
    rows: 0, nativeDiff: 0, nativeLow: 0, nativeHigh: 0, portDiff: 0, libmDiff: 0, v8Diff: 0,
    worstNativeUlp: 0, worstPortUlp: 0, worstLibmUlp: 0, worstV8Ulp: 0, nanDisagree: 0,
    examples: [],
  };
}

/** Total order on float32 patterns, so "low"/"high" means what it says across zero. */
function ordered32(u: number): number {
  return u & 0x80000000 ? 0x80000000 - (u & 0x7fffffff) : u;
}

function tally(c: Counts, tag: string, yb: number, xb: number, want: number, got: number, cls: string): void {
  const disagree =
    isNaN32(want) || isNaN32(got) ? !(isNaN32(want) && isNaN32(got)) : (want >>> 0) !== (got >>> 0);
  if (!disagree) return;
  const ulp = isNaN32(want) || isNaN32(got) ? Infinity : f32UlpDistance(fromBits(want), fromBits(got));
  if (!Number.isFinite(ulp)) c.nanDisagree += 1;
  if (tag === 'native') {
    c.nativeDiff += 1;
    if (ordered32(want) < ordered32(got)) c.nativeLow += 1;
    else c.nativeHigh += 1;
    if (ulp > c.worstNativeUlp) c.worstNativeUlp = ulp;
  } else if (tag === 'port') {
    c.portDiff += 1;
    if (ulp > c.worstPortUlp) c.worstPortUlp = ulp;
  } else if (tag === 'libm') {
    c.libmDiff += 1;
    if (ulp > c.worstLibmUlp) c.worstLibmUlp = ulp;
  } else {
    c.v8Diff += 1;
    if (ulp > c.worstV8Ulp) c.worstV8Ulp = ulp;
  }
  if (c.examples.length < 6) {
    c.examples.push(
      `${tag} ${cls} y=${hex(yb)} x=${hex(xb)} native=${hex(want)} got=${hex(got)} ulp=${ulp}`,
    );
  }
}

function main(): void {
  const nativePath = process.argv[2] ?? join(RAW, 'atan2f_native.txt');
  const argsPath = process.argv[3] ?? join(RAW, 'atan2f_args.txt');

  const classes = new Map<string, string>();
  for (const line of readFileSync(argsPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const f = t.split(/\s+/);
    classes.set(`${f[0]} ${f[1]}`, f[2] ?? 'unlabelled');
  }

  const total = emptyCounts();
  const perClass = new Map<string, Counts>();
  let piRows = 0;
  let piNativeDiff = 0;
  let piPortDiff = 0;
  const piExamples: string[] = [];

  for (const line of readFileSync(nativePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const f = t.split(/\s+/);
    if (f[0] !== 'atan2f' || f.length < 5) continue;
    const yb = parseInt(f[1]!, 16);
    const xb = parseInt(f[2]!, 16);
    const want = parseInt(f[3]!, 16);          // the shipped atan2f
    const crNative = parseInt(f[4]!, 16);      // (float)atan2((double)y, (double)x)
    const y = fromBits(yb);
    const x = fromBits(xb);
    const cls = classes.get(`${f[1]} ${f[2]}`) ?? 'unlabelled';

    const c = perClass.get(cls) ?? emptyCounts();
    perClass.set(cls, c);
    total.rows += 1;
    c.rows += 1;

    tally(total, 'native', yb, xb, want, crNative, cls);
    tally(c, 'native', yb, xb, want, crNative, cls);
    tally(total, 'port', yb, xb, want, bitsOf(nativeAtan2f(y, x)), cls);
    tally(c, 'port', yb, xb, want, bitsOf(nativeAtan2f(y, x)), cls);
    tally(total, 'libm', yb, xb, want, bitsOf(atan2f(y, x)), cls);
    tally(c, 'libm', yb, xb, want, bitsOf(atan2f(y, x)), cls);
    tally(total, 'v8', yb, xb, want, bitsOf(f32(Math.atan2(y, x))), cls);
    tally(c, 'v8', yb, xb, want, bitsOf(f32(Math.atan2(y, x))), cls);

    // The +-pi family, tracked separately: it is the case the port's correction claims.
    if (isPi32(want) || isPi32(crNative)) {
      piRows += 1;
      if ((want >>> 0) !== (crNative >>> 0)) piNativeDiff += 1;
      if ((want >>> 0) !== bitsOf(nativeAtan2f(y, x))) {
        piPortDiff += 1;
        if (piExamples.length < 4) {
          piExamples.push(`y=${hex(yb)} x=${hex(xb)} native=${hex(want)} port=${hex(bitsOf(nativeAtan2f(y, x)))}`);
        }
      }
    }
  }

  const show = (name: string, c: Counts): void => {
    const pct = (n: number): string => ((100 * n) / (c.rows || 1)).toFixed(3);
    console.log(
      `  ${name.padEnd(20)} rows ${String(c.rows).padStart(6)} | ` +
        `native!=f32(atan2) ${String(c.nativeDiff).padStart(5)} (${pct(c.nativeDiff)}%) ` +
        `[low ${c.nativeLow} / high ${c.nativeHigh}] | ` +
        `port!=native ${String(c.portDiff).padStart(5)} | ` +
        `libm atan2f!=native ${String(c.libmDiff).padStart(5)} | ` +
        `f32(Math.atan2)!=native ${String(c.v8Diff).padStart(5)} | ` +
        `worst native ${c.worstNativeUlp} / port ${c.worstPortUlp} / libm ${c.worstLibmUlp} ulp`,
    );
  };

  console.log(`atan2f census: ${total.rows} rows (${nativePath})`);
  console.log(`  TOTAL`);
  show('total', total);
  console.log(`  BY CLASS (corpus label)`);
  for (const cls of [...perClass.keys()].sort()) show(cls, perClass.get(cls)!);
  console.log(`  the +-pi family: ${piRows} rows, native!=f32(atan2) ${piNativeDiff}, port!=native ${piPortDiff}`);
  for (const e of piExamples) console.log(`    pi ${e}`);
  for (const e of total.examples) console.log(`  MISMATCH ${e}`);
}

main();
