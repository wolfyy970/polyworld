/**
 * Lane L6 (brain core) — the C `printf` subset the brain files are written with.
 *
 * `Brain::{dumpAnatomical,startFunctional,writeFunctional,dumpSynapses}` and
 * `BaseNeuronModel::*` write through `AbstractFile::printf`, i.e. straight `sprintf` with
 * `char *` formats. Four of those formats matter for the frozen surface
 * (`run/brain/function/**`, `run/brain/anatomy/**`, `run/brain/synapses/**`):
 *
 *     "brain %ld fitness=%g numneurons+1=%d maxWeight=%g maxBias=%g"
 *     "%+06.4f "                       // one connection-matrix cell
 *     "%d %g\n"                        // one neuron activation
 *     "%hd %hd %g %g\n"                // one synapse
 *
 * so the port needs `%g` and `%hd` in addition to what lane W1c already ported for the
 * columnar logs (`%d/%i/%u/%f/%s` — see `src/model/datalib/printf.ts`, which *deliberately*
 * rejects `%g` because `datalib.cc` never uses it).
 *
 * PORT-NOTE(l6/cformat-g): `%g` follows C99 7.19.6.1: precision P (default 6, 0 -> 1); let
 * X be the decimal exponent the value has when written with %e and precision P-1; use the
 * %f style with precision P-1-X when P > X >= -4, otherwise the %e style with precision
 * P-1; then strip trailing zeros and a trailing '.'. The rounding is glibc's: the *exact*
 * binary value of the double, rounded to P significant decimal digits, ties to even. That
 * is not `toPrecision`, which is not correctly rounded to the same ties
 * (`(0.0078125).toPrecision(1) === '0.008'`, C gives `0.007812`).
 *
 * PORT-NOTE(l6/cformat-length): the length modifiers are *not* uniform conversions here.
 * `%d`/`%hd` take a C `int` (or `short`, promoted) — the port applies the same wrap
 * lane W1c uses for INT columns (`toInt32`). `%ld` takes a C `long` (64-bit here, and the
 * model's counts are `long`), so it truncates toward zero without wrapping; wrapping a
 * `numSynapses` into 32 bits would corrupt a big brain's header.
 *
 * PORT-NOTE(l6/cformat-float-reuse): `%f`/`%F` are delegated to W1c's `formatFixed`, which
 * is already pinned against clang/glibc on this machine including the tie cases. `%g` needs
 * the same exact-decimal machinery, so it is built here on W1c's decomposition of the double
 * (`decomposeBinary`/`pow5`, `src/model/datalib/printf.ts`) rather than on a decimal string
 * round-trip or on a second transcription of the IEEE-754 layout.
 */

import { decomposeBinary, formatFixed, pow5, toInt32 } from '../../datalib';
import { toShort } from './nativeMath';

/** A value a native `printf` call in the brain code can receive. */
export type CValue = number | string;

interface Conversion {
  left: boolean;
  zeroPad: boolean;
  plus: boolean;
  space: boolean;
  width: number | undefined;
  precision: number | undefined;
  length: string;
  conversion: string;
}

/**
 * `round( abs * 10^h )` exactly, ties to even, as a BigInt.
 *
 * PORT-NOTE(l6/cformat-small-bigints): `abs === mantissa * 2^e` with an odd mantissa, so
 * `abs * 10^h` is `mantissa * 5^h * 2^(e+h)` for `h >= 0` — one multiply by a cached `5^h`
 * and a shift with a round-half-to-even compare — and `mantissa * 2^(e+h) / 5^-h` for
 * `h < 0`, one multiply and one division by a `5^-h` that is ~80 bit for the whole float
 * range. The shape this replaces expanded the value as `mantissa * 5^-e` (up to 2.5 kbit for
 * a subnormal) and then divided that product by `10^-drop`.
 */
function roundScaled(abs: number, h: number): bigint {
  const { mantissa, exponent } = decomposeBinary(abs);
  const m = BigInt(mantissa);

  if (h >= 0) {
    const scaled = m * pow5(h);
    const shift = exponent + h;
    if (shift >= 0) return scaled << BigInt(shift);

    const right = BigInt(-shift);
    const quotient = scaled >> right;
    const remainder = scaled - (quotient << right);
    const half = 1n << (right - 1n);
    return remainder > half || (remainder === half && (quotient & 1n) === 1n) ? quotient + 1n : quotient;
  }

  const g = -h;
  const twos = exponent - g;
  let numerator = m;
  let divisor = pow5(g);
  if (twos >= 0) numerator <<= BigInt(twos);
  else divisor <<= BigInt(-twos);

  const quotient = numerator / divisor;
  const remainder = numerator - quotient * divisor;
  const twice = remainder * 2n;
  return twice > divisor || (twice === divisor && (quotient & 1n) === 1n) ? quotient + 1n : quotient;
}

/** `10^n` as a BigInt, cached (`roundSignificant`'s carry test). */
const POW10: bigint[] = [1n];

function pow10(n: number): bigint {
  for (let i = POW10.length; i <= n; i++) POW10[i] = POW10[i - 1]! * 10n;
  return POW10[n]!;
}

/**
 * True when `abs * 10^h >= bound` exactly, for `abs > 0` and `bound > 0`.
 *
 * `10^h === 2^h * 5^h`, so this is `mantissa * 5^h * 2^(e+h) >= bound` for `h >= 0` and
 * `mantissa * 2^(e+h) >= bound * 5^-h` for `h < 0` — one multiply and one shift per side.
 * `roundSignificant` uses it to settle the one result its digit count cannot judge.
 */
function scaledAtLeast(abs: number, h: number, bound: bigint): boolean {
  const { mantissa, exponent } = decomposeBinary(abs);

  let left = BigInt(mantissa);
  let right = bound;
  if (h >= 0) left *= pow5(h);
  else right *= pow5(-h);

  const shift = exponent + h;
  if (shift >= 0) left <<= BigInt(shift);
  else right <<= BigInt(-shift);

  return left >= right;
}

/**
 * The exact value rounded to `sig` significant decimal digits, ties to even, as
 * `digits * 10^exp10` where `digits` has exactly `sig` digits (0 keeps one digit).
 *
 * The rounding position is `10^(X - sig + 1)` for the value's decimal exponent `X`, which
 * `Math.log10` estimates. The estimate can be one too large — the value can sit within a
 * `log10` rounding error of a power of ten (`1e-6` is `9.9999999999999995e-7`, whose log10
 * is `-6.0000000000000002` and can come back as `-6`) — so the digit count of the result
 * corrects it: `sig + 1` digits means the rounding carried, fewer digits means `X` was too
 * large, and a result *exactly* at `10^(sig-1)` is the one ambiguous case (it is also what
 * rounding produces when `X` is too large), so it is re-run one place finer. When the
 * estimate was right that re-run returns the same digits through the carry branch.
 */
function roundSignificant(abs: number, sig: number): { digits: bigint; exp10: number } {
  if (abs === 0) return { digits: 0n, exp10: 0 };

  let x = Math.floor(Math.log10(abs));
  const boundary = pow10(sig - 1);

  for (let attempt = 0; attempt < 4; attempt++) {
    const h = sig - 1 - x;
    const digits = roundScaled(abs, h);
    const length = digits.toString().length;

    if (length === sig) {
      if (digits !== boundary || scaledAtLeast(abs, h, boundary)) return { digits, exp10: -h };
      x -= 1;
      continue;
    }
    if (length > sig) {
      // `9.99…` rounded up to `10.00…`: the carry adds a digit, so the exponent grows.
      if (digits === pow10(sig)) return { digits: digits / 10n, exp10: 1 - h };
      x += 1; // the estimate was one too small
      continue;
    }
    x -= 1; // the estimate was one too large
  }

  throw new Error(`l6 brain: cannot round ${abs} to ${sig} significant digits`);
}

/** Place the digits of `value = digits * 10^exp10` around a decimal point. */
function placeDecimal(digits: bigint, exp10: number): { int: string; frac: string; exp: number } {
  const text = digits.toString();
  if (digits === 0n) return { int: '0', frac: '', exp: 0 };

  if (exp10 >= 0) {
    return { int: text + '0'.repeat(exp10), frac: '', exp: text.length + exp10 - 1 };
  }

  const point = text.length + exp10;
  if (point > 0) {
    return { int: text.slice(0, point), frac: text.slice(point), exp: text.length + exp10 - 1 };
  }
  return { int: '0', frac: '0'.repeat(-point) + text, exp: text.length + exp10 - 1 };
}

function pad(text: string, c: Conversion, padChar = ' '): string {
  if (c.width === undefined || text.length >= c.width) return text;
  const fill = padChar.repeat(c.width - text.length);
  return c.left ? text + fill : fill + text;
}

function padNumeric(text: string, c: Conversion): string {
  if (c.width === undefined || text.length >= c.width) return text;
  if (c.left) return pad(text, c);
  if (c.zeroPad) {
    const sign = text[0] === '-' || text[0] === '+' || text[0] === ' ' ? text[0] : '';
    const body = sign ? text.slice(1) : text;
    return sign + '0'.repeat(c.width - text.length) + body;
  }
  return pad(text, c);
}

function signPrefix(c: Conversion, negative: boolean): string {
  if (negative) return '-';
  if (c.plus) return '+';
  if (c.space) return ' ';
  return '';
}

/** C `printf( "%g", value )` / `"%G"`. */
export function formatGeneral(value: number, precision: number | undefined): string {
  const p = precision === undefined || precision === 0 ? 6 : precision;
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';

  const negative = value < 0 || Object.is(value, -0);
  const abs = Math.abs(value);
  if (abs === 0) return `${negative ? '-' : ''}0`;

  const { digits, exp10 } = roundSignificant(abs, p);
  const placed = placeDecimal(digits, exp10);
  const x = placed.exp;

  let body: string;
  if (x >= -4 && x < p) {
    let frac = placed.frac.padEnd(p - 1 - x, '0').slice(0, Math.max(0, p - 1 - x));
    frac = frac.replace(/0+$/, '');
    body = frac.length > 0 ? `${placed.int}.${frac}` : placed.int;
  } else {
    const text = digits.toString().padEnd(p, '0');
    let frac = text.slice(1).replace(/0+$/, '');
    const mantissa = frac.length > 0 ? `${text[0]}.${frac}` : text[0]!;
    const expSign = x < 0 ? '-' : '+';
    const expText = Math.abs(x).toString().padStart(2, '0');
    body = `${mantissa}e${expSign}${expText}`;
  }

  return `${negative ? '-' : ''}${body}`;
}

function applyConversion(c: Conversion, value: CValue): string {
  const upper = c.conversion === c.conversion.toUpperCase();
  switch (c.conversion.toLowerCase()) {
    case 'd':
    case 'i': {
      const n =
        typeof value === 'number'
          ? c.length === 'l'
            ? Math.trunc(value)
            : c.length === 'h' || c.length === 'hh'
              ? toShort(toInt32(value))
              : toInt32(value)
          : value
            ? 1
            : 0;
      const text = n < 0 ? String(n) : signPrefix(c, false) + String(n);
      return padNumeric(text, c);
    }
    case 'u': {
      const n = typeof value === 'number' ? toInt32(value) : 0;
      return padNumeric(String(n >>> 0), c);
    }
    case 'f': {
      const n = typeof value === 'number' ? value : Number(value);
      const body = formatFixed(n, c.precision ?? 6);
      const text = body.startsWith('-') ? body : signPrefix(c, false) + body;
      return padNumeric(text, c);
    }
    case 'e': {
      const n = typeof value === 'number' ? value : Number(value);
      let text = formatExponential(n, c.precision ?? 6, upper);
      if (!text.startsWith('-')) text = signPrefix(c, false) + text;
      return padNumeric(text, c);
    }
    case 'g': {
      const n = typeof value === 'number' ? value : Number(value);
      let text = formatGeneral(n, c.precision);
      if (upper) text = text.toUpperCase();
      if (!text.startsWith('-')) text = signPrefix(c, false) + text;
      return padNumeric(text, c);
    }
    case 'c':
      return pad(typeof value === 'string' ? String.fromCharCode(value.charCodeAt(0) & 0xff) : String.fromCharCode(Number(value) & 0xff), c);
    case 's':
      return pad(typeof value === 'string' ? value : String(value), c);
    default:
      throw new Error(`l6 brain: unsupported printf conversion '%${c.conversion}'`);
  }
}

/** C `printf( "%e", value )` — only used by `%g`'s internal decision and by tests. */
function formatExponential(value: number, precision: number, upper: boolean): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  const negative = value < 0 || Object.is(value, -0);
  const abs = Math.abs(value);
  if (abs === 0) {
    const mantissa = `0${precision > 0 ? `.${'0'.repeat(precision)}` : ''}`;
    return `${negative ? '-' : ''}${mantissa}${upper ? 'E' : 'e'}+00`;
  }
  const { digits, exp10 } = roundSignificant(abs, precision + 1);
  const text = digits.toString().padEnd(precision + 1, '0');
  const frac = text.slice(1);
  const mantissa = precision > 0 ? `${text[0]}.${frac}` : text[0]!;
  const exp = exp10 + precision;
  return `${negative ? '-' : ''}${mantissa}${upper ? 'E' : 'e'}${exp < 0 ? '-' : '+'}${Math.abs(exp).toString().padStart(2, '0')}`;
}

const SPEC_RE = /^%([-+ 0#]*)(\d+)?(?:\.(\d+))?(hh|h|ll|l|j|z|t|L)?([diouxXeEfFgGaAcsp])/;

/** One parsed piece of a format string: literal text, or a conversion. */
type FormatPart = string | Conversion;

/**
 * Parsed format strings, cached. The brain writes a handful of *literal* formats
 * (`"%d %g\n"`, `"%+06.4f "`, …) millions of times — once per neuron of every functional
 * dump — so scanning them with `SPEC_RE` belongs to the format, not to the call.
 */
const parsedFormats = new Map<string, readonly FormatPart[]>();

function parseFormat(format: string): readonly FormatPart[] {
  const cached = parsedFormats.get(format);
  if (cached !== undefined) return cached;

  const parts: FormatPart[] = [];
  let literal = '';
  let i = 0;
  while (i < format.length) {
    const ch = format[i]!;
    if (ch !== '%') {
      literal += ch;
      i += 1;
      continue;
    }
    if (format[i + 1] === '%') {
      literal += '%';
      i += 2;
      continue;
    }
    const rest = format.slice(i);
    const m = SPEC_RE.exec(rest);
    if (!m) throw new Error(`l6 brain: unsupported printf format near ${JSON.stringify(rest)}`);
    if (literal.length > 0) {
      parts.push(literal);
      literal = '';
    }
    parts.push({
      left: m[1]!.includes('-'),
      zeroPad: m[1]!.includes('0'),
      plus: m[1]!.includes('+'),
      space: m[1]!.includes(' '),
      width: m[2] === undefined ? undefined : Number(m[2]),
      precision: m[3] === undefined ? undefined : Number(m[3]),
      length: m[4] ?? '',
      conversion: m[5]!,
    });
    i += m[0]!.length;
  }
  if (literal.length > 0) parts.push(literal);

  // Formats are literals in the model; the cap only bounds a caller that builds them.
  if (parsedFormats.size >= 4096) parsedFormats.clear();
  parsedFormats.set(format, parts);
  return parts;
}

/**
 * `sprintf`-style formatting for the formats the brain writes. `args` are consumed in
 * order, one per conversion; `%%` is a literal percent.
 */
export function sprintfC(format: string, ...args: readonly CValue[]): string {
  const parts = parseFormat(format);

  let out = '';
  let arg = 0;
  for (const part of parts) {
    if (typeof part === 'string') {
      out += part;
      continue;
    }
    if (arg >= args.length) throw new Error(`l6 brain: printf '${format}' wants more arguments`);
    out += applyConversion(part, args[arg]!);
    arg += 1;
  }
  return out;
}
