/**
 * Lane L5 (genome) — native `Scalar` (`utils/Scalar.h`/`.cc`) and the printf subset the
 * genome printers emit.
 *
 * `Scalar` is the polyworld value type: a tagged union of `int`, `float` and `bool`, with
 * C-style implicit conversions that `assert` on a kind mismatch and a `str()` used by
 * `printRanges`. Two details matter for byte-exactness and are reproduced here:
 *
 *   - a `Scalar( float )`/`Scalar( double )` stores into the union's **`float`** member, so
 *     every FLOAT scalar is rounded to f32 on construction (`Math.fround`);
 *   - `str()` formats with `printf( "FLOAT %f" )` — six decimals, round-half-to-even on an
 *     exact tie (the C default rounding mode), which `Number.toFixed` does not guarantee.
 *
 * PORT-NOTE(genome/scalar-value): the native conversions are `assert`-guarded; the port
 * throws (native: abort in a debug build, reinterpret the union in a release build — never
 * a silent coercion). PORT-NOTE(genome/printf-float6): `formatFloat6` computes the exact
 * decimal expansion of the double (sign/mantissa/exponent as a `bigint` rational) and
 * rounds once, ties-to-even, instead of relying on JS's `toFixed` rounding.
 */

/** Native `Scalar::Type`. */
export type ScalarKind = 'INVALID' | 'INT' | 'FLOAT' | 'BOOL';

const F64 = new DataView(new ArrayBuffer(8));

/** Native `nint(a)`: `(long)( a + ( a < 0.0 ? -0.499999999 : 0.499999999 ) )`. */
export function nint(a: number): number {
  const shifted = a + (a < 0.0 ? -0.499999999 : 0.499999999);
  const truncated = Math.trunc(shifted);
  // C's `long` has no signed zero; JS's `-0` does (and `Object.is(-0, 0)` is false).
  return truncated === 0 ? 0 : truncated;
}

/** C `printf( "%f", x )` — six fractional digits, ties-to-even, from the exact value of `x`.
 * `nan`/`inf` spellings match the C library's.
 */
export function formatFloat6(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';

  const negative = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);

  F64.setFloat64(0, ax);
  const hi = F64.getUint32(0);
  const lo = F64.getUint32(4);
  const rawExp = (hi >>> 20) & 0x7ff;
  const fracHi = hi & 0xfffff;

  if (rawExp === 0 && fracHi === 0 && lo === 0) {
    return negative ? '-0.000000' : '0.000000';
  }

  // ax = mantissa * 2^exp2, with the mantissa an exact integer.
  let mantissa: bigint;
  let exp2: number;
  if (rawExp === 0) {
    // subnormal: no implicit leading bit, exponent -1074
    mantissa = (BigInt(fracHi) << 32n) | BigInt(lo);
    exp2 = -1074;
  } else {
    mantissa = (BigInt(fracHi | 0x100000) << 32n) | BigInt(lo);
    exp2 = rawExp - 1075;
  }

  // scaled = ax * 10^6 = numerator / denominator, exactly.
  let numerator = mantissa * 1000000n;
  let denominator = 1n;
  if (exp2 >= 0) numerator <<= BigInt(exp2);
  else denominator <<= BigInt(-exp2);

  let scaled = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  if (twice > denominator || (twice === denominator && (scaled & 1n) === 1n)) scaled += 1n;

  const digits = scaled.toString().padStart(7, '0');
  const integerPart = digits.slice(0, digits.length - 6);
  const fractionPart = digits.slice(digits.length - 6);
  return `${negative ? '-' : ''}${integerPart}.${fractionPart}`;
}

/** Native `Scalar`. */
export class Scalar {
  readonly kind: ScalarKind;
  private readonly intValue: number;
  private readonly floatValue: number;
  private readonly boolValue: boolean;

  private constructor(kind: ScalarKind, i: number, f: number, b: boolean) {
    this.kind = kind;
    this.intValue = i;
    this.floatValue = f;
    this.boolValue = b;
  }

  /** Native `Scalar( int )` / `Scalar( long )` — stored in the union's `int` member. */
  static int(value: number): Scalar {
    // Native: `this->ival = ival` into an `int`, i.e. the low 32 bits.
    return new Scalar('INT', value | 0, 0, false);
  }

  /** Native `Scalar( float )` / `Scalar( double )` — stored in the union's `float` member. */
  static float(value: number): Scalar {
    return new Scalar('FLOAT', 0, Math.fround(value), false);
  }

  /** Native `Scalar( bool )`. */
  static bool(value: boolean): Scalar {
    return new Scalar('BOOL', 0, 0, value);
  }

  /** Native `operator int()` — `assert( type == INT )`. */
  asInt(): number {
    if (this.kind !== 'INT') throw new Error(`Scalar: int conversion of ${this.kind}`);
    return this.intValue;
  }

  /** Native `operator float()` — `assert( type == FLOAT )`. */
  asFloat(): number {
    if (this.kind !== 'FLOAT') throw new Error(`Scalar: float conversion of ${this.kind}`);
    return this.floatValue;
  }

  /** Native `operator double()` — `return (float)*this`, i.e. an f32 widened to f64. */
  asDouble(): number {
    return this.asFloat();
  }

  /** Native `operator bool()` — `assert( type == BOOL )`. */
  asBool(): boolean {
    if (this.kind !== 'BOOL') throw new Error(`Scalar: bool conversion of ${this.kind}`);
    return this.boolValue;
  }

  /** Native `Scalar::str()` — the text `printRanges` writes. */
  str(): string {
    switch (this.kind) {
      case 'INT':
        return `INT ${this.intValue}`;
      case 'FLOAT':
        return `FLOAT ${formatFloat6(this.floatValue)}`;
      case 'BOOL':
        return `BOOL ${this.boolValue ? 'true' : 'false'}`;
      default:
        return 'INVALID SCALAR';
    }
  }
}
