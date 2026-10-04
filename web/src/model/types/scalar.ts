/**
 * Lane W1a — native scalar coercion, defined once.
 *
 * Native reads a config value by coercing the *evaluated string* of a property
 * (`dom.cc`), and the coercion is where a port silently diverges:
 *
 *   operator int()/short()/long() -> __ScalarProperty::toInt()    strtol( s, &end, 10 )
 *   operator float()             -> __ScalarProperty::toFloat()   (float)strtof( s, &end )
 *   operator bool()              -> __ScalarProperty::toBool()    exactly "1"/"True"/"0"/"False"
 *   operator string()            -> getEvaledString()             no conversion at all
 *
 * Each one errors (native: prints and `exit(1)`) when the parse does not consume the whole
 * string. So `"1.0"` read as an int is a *hard failure* in the original, not a truncation
 * to 1, and `"true"` read as a bool is a hard failure too. These functions reproduce that,
 * including the C-library corner cases:
 *
 *   - strtol skips leading whitespace, accepts a sign, base 10 only (`"0x10"` fails: the
 *     trailing `x10` is not consumed);
 *   - strtol's no-conversion case leaves `end` at the *start* of the string, so `""`
 *     parses as 0 (end == '\0') while `" "` fails;
 *   - range overflow clamps to LONG_MAX/LONG_MIN (errno ERANGE, which native ignores) and
 *     the value is then truncated by the `(int)` cast, i.e. the low 32 bits;
 *   - strtof accepts `inf`/`infinity`/`nan` (case-insensitive) and is rounded to `float`
 *     *before* the value is stored (port: `Math.fround`).
 *
 * PORT-NOTE(types/scalar-coercion): single definition of the native coercions. PORT-NOTE
 * (types/scalar-int-truncation): `(int)strtol(...)` is implementation-defined for values
 * outside int's range; the port reproduces x86-64 gcc's truncation to the low 32 bits.
 * PORT-NOTE(types/scalar-hex-float): strtof's hexadecimal-float form (`0x1.8p3`) is not
 * implemented — a decimal-only worldfile value that starts with `0x` fails the same way
 * `"0x10"` fails for int. No writer in the model emits hex floats.
 */

import { configError } from './errors';

const LONG_MAX = 9223372036854775807n;
const LONG_MIN = -9223372036854775808n;

/** C `isspace` in the "C" locale. */
function isSpaceCode(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

function isDigitCode(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** Result of a C-library-style parse: value plus the index `endptr` ends up at. */
interface ParseResult {
  readonly value: number;
  readonly end: number;
}

function skipSpace(text: string): number {
  let i = 0;
  while (i < text.length && isSpaceCode(text.charCodeAt(i))) i++;
  return i;
}

/** `strtol( text, &end, 10 )`. */
function strtol10(text: string): ParseResult {
  const n = text.length;
  let i = skipSpace(text);

  let negative = false;
  if (i < n) {
    const sign = text.charCodeAt(i);
    if (sign === 0x2b /* + */ || sign === 0x2d /* - */) {
      negative = sign === 0x2d;
      i++;
    }
  }

  const digitsStart = i;
  while (i < n && isDigitCode(text.charCodeAt(i))) i++;

  if (i === digitsStart) {
    // Subject sequence does not have the expected form: no conversion, endptr = nptr.
    return { value: 0, end: 0 };
  }

  let magnitude = 0n;
  for (let k = digitsStart; k < i; k++) {
    magnitude = magnitude * 10n + BigInt(text.charCodeAt(k) - 0x30);
  }
  let value = negative ? -magnitude : magnitude;
  // errno == ERANGE: strtol returns LONG_MAX / LONG_MIN (native ignores the error).
  if (value > LONG_MAX) value = LONG_MAX;
  else if (value < LONG_MIN) value = LONG_MIN;

  // The `(int)` cast native then applies (`(int)strtol(...)`).
  return { value: Number(BigInt.asIntN(32, value)), end: i };
}

/** `strtof( text, &end )`, rounded to `float` (f32). */
function strtof(text: string): ParseResult {
  const n = text.length;
  let i = skipSpace(text);
  const numberStart = i; // before the sign: strtof consumes the sign as part of the number

  let negative = false;
  if (i < n) {
    const sign = text.charCodeAt(i);
    if (sign === 0x2b || sign === 0x2d) {
      negative = sign === 0x2d;
      i++;
    }
  }

  const bodyStart = i;
  let j = i;
  let digits = 0;
  while (j < n && isDigitCode(text.charCodeAt(j))) {
    j++;
    digits++;
  }
  if (j < n && text.charCodeAt(j) === 0x2e /* . */) {
    j++;
    while (j < n && isDigitCode(text.charCodeAt(j))) {
      j++;
      digits++;
    }
  }

  if (digits === 0) {
    const rest = text.slice(bodyStart).toLowerCase();
    if (rest.startsWith('infinity')) {
      return { value: negative ? -Infinity : Infinity, end: bodyStart + 8 };
    }
    if (rest.startsWith('inf')) {
      return { value: negative ? -Infinity : Infinity, end: bodyStart + 3 };
    }
    if (rest.startsWith('nan')) {
      return { value: NaN, end: bodyStart + 3 };
    }
    // No conversion: endptr = nptr (the start of the string, before whitespace).
    return { value: 0, end: 0 };
  }

  let end = j;
  if (j < n && (text.charCodeAt(j) === 0x65 /* e */ || text.charCodeAt(j) === 0x45 /* E */)) {
    let k = j + 1;
    if (k < n && (text.charCodeAt(k) === 0x2b || text.charCodeAt(k) === 0x2d)) k++;
    let expDigits = 0;
    while (k < n && isDigitCode(text.charCodeAt(k))) {
      k++;
      expDigits++;
    }
    // An exponent marker with no digits is not part of the number (strtod backs up).
    if (expDigits > 0) end = k;
  }

  const value = Math.fround(Number(text.slice(numberStart, end)));
  return { value, end };
}

/** Native `__ScalarProperty::toInt()`: `(int)strtol( evaled, &end, 10 )`, all-or-nothing. */
export function nativeInt(text: string, where = ''): number {
  const { value, end } = strtol10(text);
  if (end !== text.length) configError(where, 'Expecting integer.');
  return value;
}

/** Native `__ScalarProperty::toFloat()`: `(float)strtof( evaled, &end )`, all-or-nothing. */
export function nativeFloat(text: string, where = ''): number {
  const { value, end } = strtof(text);
  if (end !== text.length) configError(where, 'Expecting float.');
  return value;
}

/**
 * Native `__ScalarProperty::toBool()`. Only four spellings are accepted — `"true"`,
 * `"TRUE"`, `"yes"` all fail the same way the native `err( "Expecting bool." )` does.
 */
export function nativeBool(text: string, where = ''): boolean {
  if (text === '1' || text === 'True') return true;
  if (text === '0' || text === 'False') return false;
  configError(where, 'Expecting bool.');
}

/** Native `operator std::string()`: the evaluated string, unchanged. */
export function nativeString(text: string): string {
  return text;
}
