/**
 * Lane L4 — the expression *language* native ran out of process, as a JS evaluator.
 *
 * Native proplib never evaluates a worldfile expression in C++: `interpreter.cc` renders the
 * expression's tokens into a Python source string and pipes it to a long-lived `python3`
 * child (`library/proplib/interpreter.py`) which does `str( eval( text ) )` and sends the
 * text back. This file is the `eval` half (the rendering half is `evaluator.ts`) — a
 * Python-expression evaluator, not a JS one, because the *values* are Python's: the contract
 * is the text `str( eval( text ) )` produced, byte for byte.
 *
 * What that buys, concretely:
 *
 *  * `str()` rules, not JS `String()` rules. `str( 1.0 )` is `'1.0'` (a worldfile float
 *    stays a float), `str( 25 )` is `'25'`, `str( True )` is `'True'`, `str( -1 )` is `'-1'`,
 *    `str( 1e16 )` is `'1e+16'` and `str( 0.00001 )` is `'1e-05'` — Python's float `repr`
 *    switches to exponent notation outside `[1e-4, 1e16)`, which JS never does.
 *  * Python integer semantics, not IEEE doubles: `int` is arbitrary precision (`bigint`
 *    here), `/` is true division (int/int -> float), `//` floors, `%` takes the sign of the
 *    *divisor*, `**` is right-associative, and `==` never coerces across types
 *    (`1 == '1'` is `False`, `1 == 1.0` is `True`).
 *  * Python truthiness and the operand-returning `and`/`or`, chained comparisons
 *    (`a < b <= c`), the `x if c else y` conditional, and `not`/`in`/`is`.
 *
 * Scope (PORT-NOTE(proplib/python-expression-subset) in `PARITY.md`): the subset of the
 * Python grammar a *proplib expression* can reach — literals (int/float/str/True/False/None,
 * list/tuple/dict/set), names, attribute access, subscripts and slices, calls, the operator
 * set above, and a builtin table (`len`, `int`, `float`, `str`, `bool`, `abs`, `min`, `max`,
 * `sum`, `round`, `pow`, `repr`, `ord`, `chr`, `sorted`, `list`, `tuple`, `dict`, `set`,
 * `divmod`). Everything else — `lambda`, comprehensions, generators, f-strings, `bytes`,
 * complex literals, `%`-formatting, augmented assignment, statements — raises
 * `PythonError('port: ...')` instead of guessing, so a worldfile that reaches one fails
 * loudly at its own location rather than evaluating to something native would not have
 * produced. Rule 7's "no stubs": this is a *language* whose unimplemented corners refuse.
 */

// CPython's float `**` — and, for a negative integer exponent, `int.__pow__` itself, which
// delegates to `float_pow` — call libm's `pow` with two doubles. Lane W1d transcribed the
// oracle's own `pow` (`rng/libm.ts`), so this file calls that, not V8's `Math.pow`.
import { pow } from '../rng';

/* ------------------------------------------------------------------------------------ */
/* values                                                                                */
/* ------------------------------------------------------------------------------------ */

/** A Python value, as the evaluator models it. */
export type PyValue =
  | { readonly kind: 'None' }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'int'; readonly value: bigint }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'str'; readonly value: string }
  | { readonly kind: 'list'; readonly items: readonly PyValue[] }
  | { readonly kind: 'tuple'; readonly items: readonly PyValue[] }
  | { readonly kind: 'dict'; readonly entries: readonly (readonly [PyValue, PyValue])[] }
  | { readonly kind: 'set'; readonly items: readonly PyValue[] };

/** A Python exception, with CPython's message text (native prints `[Python] <msg>`). */
export class PythonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PythonError';
  }
}

export const PY_NONE: PyValue = { kind: 'None' };
export const PY_TRUE: PyValue = { kind: 'bool', value: true };
export const PY_FALSE: PyValue = { kind: 'bool', value: false };

export function pyInt(value: bigint | number): PyValue {
  return { kind: 'int', value: typeof value === 'bigint' ? value : BigInt(Math.trunc(value)) };
}

export function pyFloat(value: number): PyValue {
  return { kind: 'float', value };
}

export function pyStrValue(value: string): PyValue {
  return { kind: 'str', value };
}

export function pyBool(value: boolean): PyValue {
  return value ? PY_TRUE : PY_FALSE;
}

export function pyList(items: readonly PyValue[]): PyValue {
  return { kind: 'list', items };
}

export function pyTuple(items: readonly PyValue[]): PyValue {
  return { kind: 'tuple', items };
}

/** CPython's type name for a value, as its error messages spell it. */
export function pyTypeName(v: PyValue): string {
  switch (v.kind) {
    case 'None':
      return 'NoneType';
    case 'bool':
      return 'bool';
    case 'int':
      return 'int';
    case 'float':
      return 'float';
    case 'str':
      return 'str';
    case 'list':
      return 'list';
    case 'tuple':
      return 'tuple';
    case 'dict':
      return 'dict';
    case 'set':
      return 'set';
  }
}

/** Python truthiness. */
export function pyTruthy(v: PyValue): boolean {
  switch (v.kind) {
    case 'None':
      return false;
    case 'bool':
      return v.value;
    case 'int':
      return v.value !== 0n;
    case 'float':
      return v.value !== 0;
    case 'str':
      return v.value.length > 0;
    case 'list':
    case 'tuple':
    case 'set':
      return v.items.length > 0;
    case 'dict':
      return v.entries.length > 0;
  }
}

/* ------------------------------------------------------------------------------------ */
/* str() / repr()                                                                        */
/* ------------------------------------------------------------------------------------ */

/**
 * Python's float `repr` (CPython `PyOS_double_to_string` with format `r`, "short" mode):
 * the shortest decimal that round-trips, in positional notation while the decimal exponent
 * is in `[-4, 16)` and in `1.5e-05` / `1e+16` form outside it, `inf`/`-inf`/`nan` for the
 * non-finite values. ECMAScript's `Number.prototype.toExponential()` already produces the
 * shortest round-tripping digit string (V8's dtoa), so the digits are taken from it and only
 * the *formatting* differs.
 *
 * PORT-NOTE(proplib/python-float-repr): this is the one place a JS reimplementation has to
 * re-derive a formatting rule rather than an arithmetic one. It is verified against the
 * recorded worldfile values and against the vector set in `tests/proplib.test.ts`
 * (`str()` of `0.1`, `1.0`, `1e16`, `1e-5`, `0.0001`, `inf`, `-0.0`, ...).
 */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';

  const exponential = x.toExponential();
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exponential);
  if (!match) return String(x); // unreachable for a finite non-zero double

  const sign = match[1] ?? '';
  const digits = (match[2] ?? '') + (match[3] ?? '');
  const exponent = Number(match[4]);

  if (exponent < -4 || exponent >= 16) {
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const magnitude = Math.abs(exponent).toString().padStart(2, '0');
    return `${sign}${mantissa}e${exponent < 0 ? '-' : '+'}${magnitude}`;
  }

  let body: string;
  if (exponent >= 0) {
    if (digits.length <= exponent + 1) {
      body = digits + '0'.repeat(exponent + 1 - digits.length) + '.0';
    } else {
      body = `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
    }
  } else {
    body = `0.${'0'.repeat(-exponent - 1)}${digits}`;
  }
  return sign + body;
}

const REPR_QUOTE = /'|"/;

/** A Python string literal for `value` (CPython `repr`), used by `repr()` and by `str()` of
 * containers (which repr their members). */
export function pyStringRepr(value: string): string {
  const hasSingle = value.includes("'");
  const hasDouble = value.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";

  let out = quote;
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch < ' ' || ch === '\x7f') out += `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out + quote;
}

/** Python `repr()` — `str()` for everything except strings and containers of them. */
export function pyRepr(v: PyValue): string {
  switch (v.kind) {
    case 'str':
      return pyStringRepr(v.value);
    case 'list':
      return `[${v.items.map(pyRepr).join(', ')}]`;
    case 'tuple': {
      const body = v.items.map(pyRepr).join(', ');
      return v.items.length === 1 ? `(${body},)` : `(${body})`;
    }
    case 'dict':
      return `{${v.entries.map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`).join(', ')}}`;
    case 'set':
      return v.items.length === 0 ? 'set()' : `{${v.items.map(pyRepr).join(', ')}}`;
    default:
      return pyStr(v);
  }
}

/** Python `str()` — what native stores as the property's value text. */
export function pyStr(v: PyValue): string {
  switch (v.kind) {
    case 'None':
      return 'None';
    case 'bool':
      return v.value ? 'True' : 'False';
    case 'int':
      return v.value.toString();
    case 'float':
      return pyFloatRepr(v.value);
    case 'str':
      return v.value;
    default:
      return pyRepr(v);
  }
}

/* ------------------------------------------------------------------------------------ */
/* operator semantics                                                                    */
/* ------------------------------------------------------------------------------------ */

/** Binary `+ - * / // % ** & | ^ << >>` etc. */
function pyBinaryOp(op: string, a: PyValue, b: PyValue): PyValue {
  switch (op) {
    case '+': {
      const n = numeric(a, b);
      if (n !== undefined) return n.add();
      if (a.kind === 'str' && b.kind === 'str') return pyStrValue(a.value + b.value);
      if (a.kind === 'list' && b.kind === 'list') return pyList([...a.items, ...b.items]);
      if (a.kind === 'tuple' && b.kind === 'tuple') return pyTuple([...a.items, ...b.items]);
      // CPython's messages for the sequence cases, then the generic operand message.
      if (a.kind === 'str') {
        throw new PythonError(`can only concatenate str (not "${pyTypeName(b)}") to str`);
      }
      if (a.kind === 'list') {
        throw new PythonError(`can only concatenate list (not "${pyTypeName(b)}") to list`);
      }
      if (a.kind === 'tuple') {
        throw new PythonError(`can only concatenate tuple (not "${pyTypeName(b)}") to tuple`);
      }
      throw operandError('+', a, b);
    }
    case '-': {
      const n = numeric(a, b);
      if (n !== undefined) return n.sub();
      throw operandError('-', a, b);
    }
    case '*': {
      const n = numeric(a, b);
      if (n !== undefined) return n.mul();
      const seq = repeatTarget(a) ?? repeatTarget(b);
      const times = repeatCount(a) ?? repeatCount(b);
      if (seq !== undefined && times !== undefined) {
        if (times <= 0n) return seq.kind === 'list' ? pyList([]) : pyStrValue('');
        const count = Number(times);
        if (seq.kind === 'str') return pyStrValue(seq.value.repeat(count));
        if (seq.kind === 'list') return pyList(Array.from({ length: count }, () => seq.items).flat());
        if (seq.kind === 'tuple') return pyTuple(Array.from({ length: count }, () => seq.items).flat());
      }
      throw operandError('*', a, b);
    }
    case '/': {
      if (!isNumber(a) || !isNumber(b)) throw operandError('/', a, b);
      if (floatValue(b) === 0) {
        throw new PythonError(a.kind === 'float' || b.kind === 'float' ? 'float division by zero' : 'division by zero');
      }
      return pyFloat(floatValue(a) / floatValue(b));
    }
    case '//': {
      if (!isNumber(a) || !isNumber(b)) throw operandError('//', a, b);
      if (floatValue(b) === 0) {
        throw new PythonError(
          a.kind === 'float' || b.kind === 'float' ? 'float floor division by zero' : 'integer division or modulo by zero',
        );
      }
      if (isIntLike(a) && isIntLike(b)) {
        return pyInt(floorDiv(intValue(a), intValue(b)));
      }
      return pyFloat(Math.floor(floatValue(a) / floatValue(b)));
    }
    case '%': {
      if (isNumber(a) && isNumber(b)) {
        if (floatValue(b) === 0) {
          throw new PythonError(
            a.kind === 'float' || b.kind === 'float' ? 'float modulo' : 'integer division or modulo by zero',
          );
        }
        if (isIntLike(a) && isIntLike(b)) {
          const x = intValue(a);
          const y = intValue(b);
          return pyInt(((x % y) + y) % y);
        }
        return pyFloat(pyFloatMod(floatValue(a), floatValue(b)));
      }
      if (a.kind === 'str') {
        throw new PythonError("port: '%-formatting is not implemented (no worldfile expression uses it)");
      }
      throw operandError('%', a, b);
    }
    case '**': {
      if (!isNumber(a) || !isNumber(b)) throw operandError('**', a, b);
      if (isIntLike(a) && isIntLike(b)) {
        const base = intValue(a);
        const exponent = intValue(b);
        if (exponent >= 0n) return pyInt(base ** exponent);
        if (base === 0n) throw new PythonError('0.0 cannot be raised to a negative power');
        // CPython's `long_pow` returns a *float* here and says so: "This works because we know
        // that this calls float_pow() which converts its arguments to double" — libm `pow`.
        return pyFloat(pow(Number(base), Number(exponent)));
      }
      return pyFloat(powFloat(floatValue(a), floatValue(b)));
    }
    case '&':
      return bitwise('&', a, b, (x, y) => x & y);
    case '|':
      return bitwise('|', a, b, (x, y) => x | y);
    case '^':
      return bitwise('^', a, b, (x, y) => x ^ y);
    case '<<':
      return shift(a, b, '<<');
    case '>>':
      return shift(a, b, '>>');
    case '@':
      throw new PythonError(
        `unsupported operand type(s) for @: '${pyTypeName(a)}' and '${pyTypeName(b)}'`,
      );
    default:
      throw new PythonError(`port: unsupported operator '${op}'`);
  }
}

function operandError(op: string, a: PyValue, b: PyValue): PythonError {
  return new PythonError(
    `unsupported operand type(s) for ${op}: '${pyTypeName(a)}' and '${pyTypeName(b)}'`,
  );
}

function isIntLike(v: PyValue): boolean {
  return v.kind === 'int' || v.kind === 'bool';
}

function isNumber(v: PyValue): boolean {
  return v.kind === 'int' || v.kind === 'bool' || v.kind === 'float';
}

function intValue(v: PyValue): bigint {
  if (v.kind === 'int') return v.value;
  if (v.kind === 'bool') return v.value ? 1n : 0n;
  throw new PythonError(`port: expected an integer, got '${pyTypeName(v)}'`);
}

function floatValue(v: PyValue): number {
  if (v.kind === 'float') return v.value;
  if (v.kind === 'int') return Number(v.value);
  if (v.kind === 'bool') return v.value ? 1 : 0;
  throw new PythonError(`port: expected a number, got '${pyTypeName(v)}'`);
}

/** Python's floor division on integers (rounds toward negative infinity). */
function floorDiv(x: bigint, y: bigint): bigint {
  const q = x / y;
  return x % y !== 0n && x < 0n !== y < 0n ? q - 1n : q;
}

/** Python's float `%` (C `fmod` with the divisor's sign). */
function pyFloatMod(x: number, y: number): number {
  const r = x % y;
  if (r !== 0 && r < 0 !== y < 0) return r + y;
  return r;
}

/**
 * `**` on floats: CPython calls libm `pow` with two doubles (`float_pow` → `pow(iv, iw)`), and
 * the oracle's expression evaluator ran as a Python child process on this machine, so the
 * function native actually called is Apple's `_pow` — transcribed in `rng/libm.ts` (W1d,
 * bit-exact on its 4,471-value corpus and a 189,368-pair sweep). This helper is the one the
 * AST's `BinOp`/`Pow` path reaches, so the swap is only the function called: both operands are
 * already f64 here.
 *
 * What it does *not* change: integer `**` stays exact `bigint` arithmetic (the branch above),
 * and Python's domain handling is whatever the branch structure already decides. The recorded
 * worldfiles never raise a float to a power, so no golden moves — this is port fidelity, not a
 * measured parity improvement. Cost: the transcription is not free — measured (2026-09-28,
 * `tools/measure_proplib_pow_cost.ts`) 251–748 ns/call on its fast path and 1070–1169 ns on
 * the negative-exponent ladder, against V8's 4–12 ns on constant arguments (PORT-NOTE
 * `W1d-fu/pow-is-transcribed…`'s ~20x). On this file's own path that takes a full
 * `evaluatePythonExpressionText('2.0 ** 3.5')` from 0.78 us to 1.07–1.14 us, over a
 * 0.38–0.42 us lex+parse+eval floor — worth knowing, not worth calling a different function.
 */
function powFloat(base: number, exponent: number): number {
  return pow(base, exponent);
}

/** Arithmetic promotion: `bool` behaves as `int`, any `float` makes the result a `float`. */
function numeric(a: PyValue, b: PyValue): {
  add(): PyValue;
  sub(): PyValue;
  mul(): PyValue;
} | undefined {
  if (!isNumber(a) || !isNumber(b)) return undefined;
  const floating = a.kind === 'float' || b.kind === 'float';
  if (floating) {
    const x = floatValue(a);
    const y = floatValue(b);
    return {
      add: () => pyFloat(x + y),
      sub: () => pyFloat(x - y),
      mul: () => pyFloat(x * y),
    };
  }
  const x = intValue(a);
  const y = intValue(b);
  return {
    add: () => pyInt(x + y),
    sub: () => pyInt(x - y),
    mul: () => pyInt(x * y),
  };
}

function repeatTarget(v: PyValue): PyValue | undefined {
  return v.kind === 'str' || v.kind === 'list' || v.kind === 'tuple' ? v : undefined;
}

function repeatCount(v: PyValue): bigint | undefined {
  return isIntLike(v) ? intValue(v) : undefined;
}

function bitwise(
  op: string,
  a: PyValue,
  b: PyValue,
  fn: (x: bigint, y: bigint) => bigint,
): PyValue {
  if (!isIntLike(a) || !isIntLike(b)) throw operandError(op, a, b);
  return pyInt(fn(intValue(a), intValue(b)));
}

function shift(a: PyValue, b: PyValue, op: '<<' | '>>'): PyValue {
  if (!isIntLike(a) || !isIntLike(b)) throw operandError(op, a, b);
  const count = intValue(b);
  if (count < 0n) throw new PythonError('negative shift count');
  if (count > 4096n) throw new PythonError('port: shift count too large');
  return pyInt(op === '<<' ? intValue(a) << count : intValue(a) >> count);
}

/** Python `==` (no coercion between types; containers compare elementwise). */
export function pyEquals(a: PyValue, b: PyValue): boolean {
  if (isNumber(a) && isNumber(b)) {
    if (a.kind === 'float' || b.kind === 'float') return floatValue(a) === floatValue(b);
    return intValue(a) === intValue(b);
  }
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'None':
      return true;
    case 'str':
      return a.value === (b as { value: string }).value;
    case 'list':
    case 'tuple':
    case 'set': {
      const other = b as { items: readonly PyValue[] };
      if (a.items.length !== other.items.length) return false;
      return a.items.every((item, index) => pyEquals(item, other.items[index]!));
    }
    case 'dict': {
      const other = b as { entries: readonly (readonly [PyValue, PyValue])[] };
      if (a.entries.length !== other.entries.length) return false;
      return a.entries.every(([key, value]) => {
        const found = other.entries.find(([k]) => pyEquals(k, key));
        return found !== undefined && pyEquals(found[1], value);
      });
    }
    default:
      return true;
  }
}

/** `is` / `is not`: identity. The port's values are immutable, so interned scalars compare
 * by value (`None`, `bool`) and the rest by reference (PORT-NOTE). */
function pyIdentity(a: PyValue, b: PyValue): boolean {
  if (a.kind === 'None' || b.kind === 'None') return a.kind === b.kind;
  if (a.kind === 'bool' && b.kind === 'bool') return a.value === b.value;
  return a === b;
}

function pyContains(needle: PyValue, haystack: PyValue): boolean {
  switch (haystack.kind) {
    case 'str':
      if (needle.kind !== 'str') {
        throw new PythonError(
          `'in <string>' requires string as left operand, not ${pyTypeName(needle)}`,
        );
      }
      return haystack.value.includes(needle.value);
    case 'list':
    case 'tuple':
    case 'set':
      return haystack.items.some((item) => pyEquals(item, needle));
    case 'dict':
      return haystack.entries.some(([key]) => pyEquals(key, needle));
    default:
      throw new PythonError(`argument of type '${pyTypeName(haystack)}' is not iterable`);
  }
}

/** One comparison. `==`/`!=` are total; the orderings need comparable operands. */
function pyCompare(op: string, a: PyValue, b: PyValue): boolean {
  switch (op) {
    case '==':
      return pyEquals(a, b);
    case '!=':
      return !pyEquals(a, b);
    case 'is':
      return pyIdentity(a, b);
    case 'is not':
      return !pyIdentity(a, b);
    case 'in':
      return pyContains(a, b);
    case 'not in':
      return !pyContains(a, b);
  }

  if (isNumber(a) && isNumber(b)) {
    const x = floatValue(a);
    const y = floatValue(b);
    // NaN: every ordering is False, as in Python (IEEE).
    switch (op) {
      case '<':
        return x < y;
      case '<=':
        return x <= y;
      case '>':
        return x > y;
      case '>=':
        return x >= y;
    }
  }

  if (a.kind === 'str' && b.kind === 'str') {
    switch (op) {
      case '<':
        return a.value < b.value;
      case '<=':
        return a.value <= b.value;
      case '>':
        return a.value > b.value;
      case '>=':
        return a.value >= b.value;
    }
  }

  if ((a.kind === 'list' || a.kind === 'tuple') && a.kind === b.kind) {
    const other = b as { items: readonly PyValue[] };
    switch (op) {
      case '<':
        return compareSequence(a.items, other.items) < 0;
      case '<=':
        return compareSequence(a.items, other.items) <= 0;
      case '>':
        return compareSequence(a.items, other.items) > 0;
      case '>=':
        return compareSequence(a.items, other.items) >= 0;
    }
  }

  throw new PythonError(
    `'${op}' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`,
  );
}

function compareSequence(a: readonly PyValue[], b: readonly PyValue[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (pyEquals(a[i]!, b[i]!)) continue;
    return pyCompare('<', a[i]!, b[i]!) ? -1 : 1;
  }
  return a.length - b.length;
}

function unaryMinus(v: PyValue): PyValue {
  if (v.kind === 'int') return pyInt(-v.value);
  if (v.kind === 'bool') return pyInt(v.value ? -1n : 0n);
  if (v.kind === 'float') return pyFloat(-v.value);
  throw new PythonError(`bad operand type for unary -: '${pyTypeName(v)}'`);
}

function unaryPlus(v: PyValue): PyValue {
  if (v.kind === 'int' || v.kind === 'bool') return pyInt(intValue(v));
  if (v.kind === 'float') return v;
  throw new PythonError(`bad operand type for unary +: '${pyTypeName(v)}'`);
}

function unaryInvert(v: PyValue): PyValue {
  if (isIntLike(v)) return pyInt(~intValue(v));
  throw new PythonError(`bad operand type for unary ~: '${pyTypeName(v)}'`);
}

/* ------------------------------------------------------------------------------------ */
/* builtins                                                                              */
/* ------------------------------------------------------------------------------------ */

type Builtin = (args: readonly PyValue[]) => PyValue;

function arity(name: string, args: readonly PyValue[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    const expected = min === max ? `exactly ${min}` : `at least ${min}`;
    throw new PythonError(`${name}() takes ${expected} argument${max === 1 ? '' : 's'} (${args.length} given)`);
  }
}

function iterableItems(v: PyValue): readonly PyValue[] {
  switch (v.kind) {
    case 'str':
      return [...v.value].map(pyStrValue);
    case 'list':
    case 'tuple':
    case 'set':
      return v.items;
    case 'dict':
      return v.entries.map(([key]) => key);
    default:
      throw new PythonError(`'${pyTypeName(v)}' object is not iterable`);
  }
}

function toIntValue(v: PyValue, base?: bigint): bigint {
  switch (v.kind) {
    case 'int':
      return v.value;
    case 'bool':
      return v.value ? 1n : 0n;
    case 'float':
      if (!Number.isFinite(v.value)) throw new PythonError('cannot convert float NaN to integer');
      return BigInt(Math.trunc(v.value));
    case 'str': {
      const text = v.value.trim();
      const radix = Number(base ?? 10n);
      const parsed = parseIntValue(text, radix);
      if (parsed === undefined) {
        throw new PythonError(
          radix === 10
            ? `invalid literal for int() with base 10: ${pyStringRepr(v.value)}`
            : `invalid literal for int() with base ${radix}: ${pyStringRepr(v.value)}`,
        );
      }
      return parsed;
    }
    default:
      throw new PythonError(
        `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`,
      );
  }
}

function parseIntValue(text: string, radix: number): bigint | undefined {
  const sign = text.startsWith('-') ? -1n : 1n;
  const body = text.replace(/^[+-]/, '');
  if (body.length === 0) return undefined;

  let digits = body;
  if (radix !== 16) {
    if (/^0[xX]/.test(body)) return radix === 16 ? undefined : undefined;
    if (radix === 10 && /^0[oObB]/.test(body)) return undefined;
  } else if (/^0[xX]/.test(body)) {
    digits = body.slice(2);
  }
  if (![...digits].every((ch) => digitValue(ch) < radix)) return undefined;
  const base = BigInt(radix);
  let result = 0n;
  for (const ch of digits) result = result * base + BigInt(digitValue(ch));
  return sign * result;
}

function digitValue(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 122) return code - 97 + 10;
  if (code >= 65 && code <= 90) return code - 65 + 10;
  return 99;
}

function toFloatValue(v: PyValue): number {
  switch (v.kind) {
    case 'float':
      return v.value;
    case 'int':
      return Number(v.value);
    case 'bool':
      return v.value ? 1 : 0;
    case 'str': {
      const text = v.value.trim();
      if (/^[+-]?(inf|infinity)$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
      if (/^[+-]?nan$/i.test(text)) return NaN;
      const parsed = Number(text);
      if (text.length === 0 || Number.isNaN(parsed)) {
        throw new PythonError(`could not convert string to float: ${pyStringRepr(v.value)}`);
      }
      return parsed;
    }
    default:
      throw new PythonError(
        `float() argument must be a string or a real number, not '${pyTypeName(v)}'`,
      );
  }
}

/** CPython's `round`: half-to-even on the *exact* value, not on a decimal approximation. */
function pyRound(x: number, ndigits: number | undefined): PyValue {
  if (!Number.isFinite(x)) {
    if (ndigits === undefined) {
      throw new PythonError('cannot convert float infinity to integer');
    }
    return pyFloat(x);
  }

  const { numerator, denominator } = exactRatio(x);
  let digits = ndigits ?? 0;

  // Round `x * 10**digits` to an integer, half-to-even.
  let num = numerator;
  let den = denominator;
  if (digits >= 0) num *= 10n ** BigInt(digits);
  else den *= 10n ** BigInt(-digits);

  const rounded = roundHalfEven(num, den);
  if (ndigits === undefined) return pyInt(rounded);

  // `round(x, n)` returns a float: the rounded decimal, as the nearest double.
  return digits >= 0
    ? pyFloat(Number(rounded) / 10 ** digits)
    : pyFloat(Number(rounded) * 10 ** -digits);
}

/** Exact `x = numerator / denominator` (both `bigint`), for a finite double. */
function exactRatio(x: number): { numerator: bigint; denominator: bigint } {
  const sign = x < 0 ? -1n : 1n;
  const magnitude = Math.abs(x);
  // Decompose the double: value = mantissa * 2**exponent.
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, magnitude);
  const bits = view.getBigUint64(0);
  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  const mantissaBits = bits & 0xfffffffffffffn;

  if (rawExponent === 0) {
    return { numerator: sign * mantissaBits, denominator: 2n ** 1074n };
  }
  const mantissa = mantissaBits | 0x10000000000000n;
  const exponent = rawExponent - 1075;
  return exponent >= 0
    ? { numerator: sign * mantissa * 2n ** BigInt(exponent), denominator: 1n }
    : { numerator: sign * mantissa, denominator: 2n ** BigInt(-exponent) };
}

function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const num = numerator < 0n ? -numerator : numerator;
  const den = denominator < 0n ? -denominator : denominator;

  const quotient = num / den;
  const remainder = num % den;
  const doubled = remainder * 2n;

  let result = quotient;
  if (doubled > den || (doubled === den && quotient % 2n !== 0n)) result += 1n;
  return negative ? -result : result;
}

function pyLen(v: PyValue): PyValue {
  switch (v.kind) {
    case 'str':
      return pyInt(BigInt(v.value.length));
    case 'list':
    case 'tuple':
    case 'set':
      return pyInt(BigInt(v.items.length));
    case 'dict':
      return pyInt(BigInt(v.entries.length));
    default:
      throw new PythonError(`object of type '${pyTypeName(v)}' has no len()`);
  }
}

function pyMinMax(name: 'min' | 'max', args: readonly PyValue[]): PyValue {
  const values = args.length === 1 ? iterableItems(args[0]!) : args;
  if (values.length === 0) {
    throw new PythonError(`${name}() arg is an empty sequence`);
  }
  let best = values[0]!;
  for (const candidate of values.slice(1)) {
    const replace =
      name === 'min'
        ? pyCompare('<', candidate, best)
        : pyCompare('>', candidate, best);
    if (replace) best = candidate;
  }
  return best;
}

function pySorted(v: PyValue): PyValue {
  const items = [...iterableItems(v)];
  items.sort((a, b) => (pyEquals(a, b) ? 0 : pyCompare('<', a, b) ? -1 : 1));
  return pyList(items);
}

const BUILTINS: ReadonlyMap<string, Builtin> = new Map<string, Builtin>([
  ['len', (args) => (arity('len', args, 1), pyLen(args[0]!))],
  [
    'int',
    (args) => {
      if (args.length === 0) return pyInt(0n);
      if (args.length > 2) throw new PythonError(`int() takes at most 2 arguments (${args.length} given)`);
      return pyInt(args.length === 2 ? toIntValue(args[0]!, intValue(args[1]!)) : toIntValue(args[0]!));
    },
  ],
  [
    'float',
    (args) => {
      if (args.length === 0) return pyFloat(0);
      arity('float', args, 1);
      return pyFloat(toFloatValue(args[0]!));
    },
  ],
  [
    'str',
    (args) => {
      if (args.length === 0) return pyStrValue('');
      arity('str', args, 1);
      return pyStrValue(pyStr(args[0]!));
    },
  ],
  [
    'bool',
    (args) => {
      if (args.length === 0) return PY_FALSE;
      arity('bool', args, 1);
      return pyBool(pyTruthy(args[0]!));
    },
  ],
  ['repr', (args) => (arity('repr', args, 1), pyStrValue(pyRepr(args[0]!)))],
  [
    'abs',
    (args) => {
      arity('abs', args, 1);
      const v = args[0]!;
      if (v.kind === 'float') return pyFloat(Math.abs(v.value));
      if (v.kind === 'bool') return pyInt(v.value ? 1n : 0n);
      if (v.kind === 'int') return pyInt(v.value < 0n ? -v.value : v.value);
      throw new PythonError(`bad operand type for abs(): '${pyTypeName(v)}'`);
    },
  ],
  ['min', (args) => (arity('min', args, 1, Number.MAX_SAFE_INTEGER), pyMinMax('min', args))],
  ['max', (args) => (arity('max', args, 1, Number.MAX_SAFE_INTEGER), pyMinMax('max', args))],
  [
    'sum',
    (args) => {
      if (args.length < 1 || args.length > 2) {
        throw new PythonError(`sum() takes at most 2 arguments (${args.length} given)`);
      }
      let total: PyValue = args[1] ?? pyInt(0n);
      for (const item of iterableItems(args[0]!)) total = pyBinaryOp('+', total, item);
      return total;
    },
  ],
  [
    'round',
    (args) => {
      if (args.length < 1 || args.length > 2) {
        throw new PythonError(`round() takes at most 2 arguments (${args.length} given)`);
      }
      const digits = args.length === 2 ? Number(toIntValue(args[1]!)) : undefined;
      const v = args[0]!;
      if (v.kind === 'int' || v.kind === 'bool') return pyInt(intValue(v));
      if (v.kind !== 'float') throw new PythonError(`type ${pyTypeName(v)} doesn't define __round__ method`);
      return pyRound(v.value, digits);
    },
  ],
  [
    'pow',
    (args) => {
      if (args.length === 2) return pyBinaryOp('**', args[0]!, args[1]!);
      if (args.length === 3) {
        const base = toIntValue(args[0]!);
        const exponent = toIntValue(args[1]!);
        const modulus = toIntValue(args[2]!);
        if (modulus === 0n) throw new PythonError('pow() 3rd argument cannot be 0');
        const negativeExponent = exponent < 0n;
        let exp = negativeExponent ? -exponent : exponent;
        const mod = modulus < 0n ? -modulus : modulus;
        const baseMod = ((base % mod) + mod) % mod;
        let result = 1n;
        let factor = baseMod;
        while (exp > 0n) {
          if (exp & 1n) result = (result * factor) % mod;
          factor = (factor * factor) % mod;
          exp >>= 1n;
        }
        return pyInt(negativeExponent ? result : (((result % mod) + mod) % mod));
      }
      throw new PythonError('pow() takes 2 or 3 arguments');
    },
  ],
  [
    'ord',
    (args) => {
      arity('ord', args, 1);
      const v = args[0]!;
      if (v.kind !== 'str' || v.value.length !== 1) {
        throw new PythonError(
          `ord() expected a character, but string of length ${v.kind === 'str' ? v.value.length : 0} found`,
        );
      }
      return pyInt(BigInt(v.value.codePointAt(0) ?? 0));
    },
  ],
  [
    'chr',
    (args) => {
      arity('chr', args, 1);
      const code = Number(toIntValue(args[0]!));
      if (code < 0 || code > 0x10ffff) throw new PythonError('chr() arg not in range(0x110000)');
      return pyStrValue(String.fromCodePoint(code));
    },
  ],
  ['sorted', (args) => (arity('sorted', args, 1), pySorted(args[0]!))],
  ['list', (args) => (args.length === 0 ? pyList([]) : (arity('list', args, 1), pyList([...iterableItems(args[0]!)])))],
  ['tuple', (args) => (args.length === 0 ? pyTuple([]) : (arity('tuple', args, 1), pyTuple([...iterableItems(args[0]!)])))],
  [
    'set',
    (args) => {
      if (args.length === 0) return { kind: 'set', items: [] } as PyValue;
      arity('set', args, 1);
      const items: PyValue[] = [];
      for (const item of iterableItems(args[0]!)) {
        if (!items.some((existing) => pyEquals(existing, item))) items.push(item);
      }
      return { kind: 'set', items };
    },
  ],
  [
    'dict',
    (args) => {
      if (args.length === 0) return { kind: 'dict', entries: [] } as PyValue;
      arity('dict', args, 1);
      const source = args[0]!;
      const entries: (readonly [PyValue, PyValue])[] = [];
      if (source.kind === 'dict') {
        for (const [key, value] of source.entries) entries.push([key, value]);
      } else {
        for (const item of iterableItems(source)) entries.push([item, PY_NONE]);
      }
      return { kind: 'dict', entries };
    },
  ],
  [
    'divmod',
    (args) => {
      arity('divmod', args, 2);
      return pyTuple([
        pyBinaryOp('//', args[0]!, args[1]!),
        pyBinaryOp('%', args[0]!, args[1]!),
      ]);
    },
  ],
]);

/* ------------------------------------------------------------------------------------ */
/* lexer                                                                                 */
/* ------------------------------------------------------------------------------------ */

type TokenKind =
  | 'number'
  | 'string'
  | 'name'
  | 'op'
  | 'end';

interface LexToken {
  readonly kind: TokenKind;
  readonly text: string;
  readonly value?: PyValue;
}

const OPERATORS = [
  '**',
  '//',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '<>',
  ':=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '@',
  '&',
  '|',
  '^',
  '~',
  '<',
  '>',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ':',
  '.',
  '=',
];

const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'in',
  'is',
  'if',
  'else',
  'True',
  'False',
  'None',
]);

/** Keywords that are statements, not expression syntax: `eval` rejects them as syntax. */
const NON_EXPRESSION_KEYWORDS = new Set([
  'lambda',
  'for',
  'while',
  'yield',
  'await',
  'async',
  'import',
  'from',
  'del',
  'pass',
  'assert',
  'class',
  'def',
  'return',
  'try',
  'except',
  'finally',
  'raise',
  'break',
  'continue',
  'global',
  'nonlocal',
  'with',
  'as',
  'elif',
]);

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isNameStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function lex(source: string): LexToken[] {
  const tokens: LexToken[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i += 1;
      continue;
    }
    if (ch === '\\' && source[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] ?? ''))) {
      const match = /^(0[bB][01_]+|0[oO][0-7_]+|0[xX][0-9a-fA-F_]+|(\d[\d_]*)?\.?[\d_]*([eE][+-]?[\d_]+)?)/.exec(
        source.slice(i),
      );
      const text = match?.[0] ?? '';
      if (text.length === 0) throw new PythonError('invalid syntax');
      i += text.length;
      if (source[i] === 'j' || source[i] === 'J') {
        throw new PythonError('port: complex literals are not implemented');
      }
      tokens.push({ kind: 'number', text, value: numberLiteral(text) });
      continue;
    }

    if (isNameStart(ch)) {
      // A string prefix (`r`, `u`, `f`, `b`, `rb`, ...) is part of the literal.
      const prefixMatch = /^([rbufRBUF]{0,2})('''|"""|'|")/.exec(source.slice(i));
      if (prefixMatch) {
        const prefix = prefixMatch[1]!.toLowerCase();
        const quote = prefixMatch[2]!;
        if (prefix.includes('b') || prefix.includes('f')) {
          throw new PythonError(
            `port: ${prefix.includes('f') ? 'f-string' : 'bytes'} literals are not implemented`,
          );
        }
        // `start` is the first byte *after* the opening quote (the reader's loop checks for
        // the closing quote before reading anything, so passing the opening quote itself
        // would make it read an empty string).
        const body = readStringLiteral(source, i + prefix.length + quote.length, quote);
        i += prefix.length + quote.length + body.consumed;
        tokens.push({
          kind: 'string',
          text: quote + body.text + quote,
          value: pyStrValue(prefix.includes('r') ? body.text : interpretEscapes(body.text)),
        });
        continue;
      }

      let end = i;
      while (end < source.length && isNameChar(source[end]!)) end += 1;
      const text = source.slice(i, end);
      i = end;
      tokens.push({ kind: 'name', text });
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = source.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      const body = readStringLiteral(source, i + quote.length, quote);
      i += quote.length + body.consumed;
      tokens.push({ kind: 'string', text: quote + body.text + quote, value: body.value });
      continue;
    }

    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (operator === undefined) throw new PythonError(`invalid character in expression: '${ch}'`);
    i += operator.length;
    tokens.push({ kind: 'op', text: operator });
  }

  tokens.push({ kind: 'end', text: '' });
  return tokens;
}

interface ReadString {
  readonly text: string;
  readonly value: PyValue;
  readonly consumed: number;
}

/**
 * Read a quoted string literal body, honouring Python's escapes. The literal's *value* is
 * what native's `eval` produced (escapes interpreted, quotes stripped), because that is what
 * `str()` returns.
 */
function readStringLiteral(source: string, start: number, quote: string): ReadString {
  const triple = quote.length === 3;
  let i = start;
  let raw = '';

  for (;;) {
    if (i >= source.length) throw new PythonError('EOL while scanning string literal');
    if (source.startsWith(quote, i)) {
      i += quote.length;
      break;
    }
    const ch = source[i]!;
    if (!triple && ch === '\n') throw new PythonError('EOL while scanning string literal');
    if (ch === '\\') {
      raw += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    raw += ch;
    i += 1;
  }

  return {
    text: source.slice(start, i - quote.length),
    value: pyStrValue(interpretEscapes(raw)),
    consumed: i - start,
  };
}

const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['\\n', '\n'],
  ['\\t', '\t'],
  ['\\r', '\r'],
  ['\\\\', '\\'],
  ["\\'", "'"],
  ['\\"', '"'],
  ['\\a', '\x07'],
  ['\\b', '\b'],
  ['\\f', '\f'],
  ['\\v', '\v'],
  ['\\0', '\0'],
]);

function interpretEscapes(raw: string): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    const pair = raw.slice(i, i + 2);
    const simple = SIMPLE_ESCAPES.get(pair);
    if (simple !== undefined) {
      out += simple;
      i += 2;
      continue;
    }
    const hex = /^\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/.exec(raw.slice(i));
    if (hex) {
      const digits = hex[1]!.slice(1);
      out += String.fromCodePoint(parseInt(digits, 16));
      i += hex[0].length;
      continue;
    }
    // Unknown escapes are left as written, as Python does (`'\\d'` is two characters).
    out += pair;
    i += 2;
  }
  return out;
}

function numberLiteral(text: string): PyValue {
  const clean = text.replace(/_/g, '');
  if (/^0[xX]/.test(clean)) return pyInt(BigInt(clean));
  if (/^0[oO]/.test(clean)) return pyInt(BigInt(clean));
  if (/^0[bB]/.test(clean)) return pyInt(BigInt(clean));
  if (/[.eE]/.test(clean)) return pyFloat(Number(clean));
  if (clean.length > 1 && clean.startsWith('0')) {
    throw new PythonError(
      'leading zeros in decimal integer literals are not permitted; use an 0o prefix for octal integers',
    );
  }
  return pyInt(BigInt(clean));
}

/* ------------------------------------------------------------------------------------ */
/* parser                                                                                */
/* ------------------------------------------------------------------------------------ */

type Ast =
  | { readonly t: 'const'; readonly value: PyValue }
  | { readonly t: 'name'; readonly id: string }
  | { readonly t: 'attr'; readonly object: Ast; readonly name: string }
  | { readonly t: 'binary'; readonly op: string; readonly left: Ast; readonly right: Ast }
  | { readonly t: 'unary'; readonly op: string; readonly operand: Ast }
  | { readonly t: 'bool'; readonly op: 'and' | 'or'; readonly left: Ast; readonly right: Ast }
  | { readonly t: 'not'; readonly operand: Ast }
  | { readonly t: 'compare'; readonly ops: readonly string[]; readonly operands: readonly Ast[] }
  | { readonly t: 'cond'; readonly cond: Ast; readonly whenTrue: Ast; readonly whenFalse: Ast }
  | { readonly t: 'call'; readonly fn: Ast; readonly args: readonly Ast[] }
  | { readonly t: 'subscript'; readonly object: Ast; readonly index: Ast }
  | { readonly t: 'slice'; readonly lower: Ast | null; readonly upper: Ast | null; readonly step: Ast | null }
  | { readonly t: 'sequence'; readonly kind: 'list' | 'tuple' | 'set'; readonly items: readonly Ast[] }
  | { readonly t: 'dict'; readonly entries: readonly (readonly [Ast, Ast])[] };

class ExpressionParser {
  private index = 0;

  constructor(private readonly tokens: readonly LexToken[]) {}

  parse(): Ast {
    const first = this.ternary();

    // A bare comma at the top level builds a tuple, as Python's `eval` does (`1, 2`).
    if (this.at(',')) {
      const items: Ast[] = [first];
      while (this.eat(',')) {
        if (this.peek().kind === 'end') break;
        items.push(this.ternary());
      }
      if (this.peek().kind !== 'end') this.rejectLeftover();
      return { t: 'sequence', kind: 'tuple', items };
    }

    if (this.peek().kind !== 'end') this.rejectLeftover();
    return first;
  }

  /** A token the grammar did not consume: the port's own refusal, or Python's syntax error. */
  private rejectLeftover(): never {
    const token = this.peek();
    if (token.kind === 'op' && token.text === ':=') {
      throw new PythonError('port: the walrus operator is not implemented');
    }
    this.refuseComprehension();
    throw new PythonError('invalid syntax');
  }

  /** `for`/`async` where a value was expected can only be a comprehension: refused loudly. */
  private refuseComprehension(): void {
    if (this.at('for') || this.at('async')) {
      throw new PythonError(
        'port: comprehensions and generator expressions are not implemented',
      );
    }
  }

  private peek(offset = 0): LexToken {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }

  private next(): LexToken {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private at(text: string): boolean {
    const token = this.peek();
    return (token.kind === 'op' || token.kind === 'name') && token.text === text;
  }

  private eat(text: string): boolean {
    if (!this.at(text)) return false;
    this.index += 1;
    return true;
  }

  private expect(text: string): void {
    if (!this.eat(text)) throw new PythonError('invalid syntax');
  }

  private ternary(): Ast {
    // Python's `A if C else B`: the *first* operand is the value when the condition holds.
    const whenTrue = this.orExpression();
    if (this.eat('if')) {
      const cond = this.orExpression();
      this.expect('else');
      return { t: 'cond', cond, whenTrue, whenFalse: this.ternary() };
    }
    return whenTrue;
  }

  private orExpression(): Ast {
    let left = this.andExpression();
    while (this.eat('or')) left = { t: 'bool', op: 'or', left, right: this.andExpression() };
    return left;
  }

  private andExpression(): Ast {
    let left = this.notExpression();
    while (this.eat('and')) left = { t: 'bool', op: 'and', left, right: this.notExpression() };
    return left;
  }

  private notExpression(): Ast {
    if (this.eat('not')) return { t: 'not', operand: this.notExpression() };
    return this.comparison();
  }

  private comparison(): Ast {
    const operands: Ast[] = [this.bitOr()];
    const ops: string[] = [];
    for (;;) {
      const op = this.comparisonOperator();
      if (op === undefined) break;
      ops.push(op);
      operands.push(this.bitOr());
    }
    if (ops.length === 0) return operands[0]!;
    return { t: 'compare', ops, operands };
  }

  private comparisonOperator(): string | undefined {
    const token = this.peek();
    if (token.kind === 'op' && ['<', '>', '<=', '>=', '==', '!=', '<>', 'in'].includes(token.text)) {
      this.index += 1;
      return token.text === '<>' ? '!=' : token.text;
    }
    if (token.kind === 'name' && token.text === 'in') {
      this.index += 1;
      return 'in';
    }
    if (token.kind === 'name' && token.text === 'is') {
      this.index += 1;
      if (this.at('not')) {
        this.index += 1;
        return 'is not';
      }
      return 'is';
    }
    if (token.kind === 'name' && token.text === 'not' && this.peek(1).text === 'in') {
      this.index += 2;
      return 'not in';
    }
    return undefined;
  }

  private binaryLevel(
    next: () => Ast,
    operators: readonly string[],
  ): Ast {
    let left = next.call(this);
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'op' || !operators.includes(token.text)) break;
      this.index += 1;
      left = { t: 'binary', op: token.text, left, right: next.call(this) };
    }
    return left;
  }

  private bitOr(): Ast {
    return this.binaryLevel(this.bitXor, ['|']);
  }

  private bitXor(): Ast {
    return this.binaryLevel(this.bitAnd, ['^']);
  }

  private bitAnd(): Ast {
    return this.binaryLevel(this.shift, ['&']);
  }

  private shift(): Ast {
    return this.binaryLevel(this.arith, ['<<', '>>']);
  }

  private arith(): Ast {
    return this.binaryLevel(this.term, ['+', '-']);
  }

  private term(): Ast {
    return this.binaryLevel(this.factor, ['*', '/', '//', '%', '@']);
  }

  private factor(): Ast {
    const token = this.peek();
    if (token.kind === 'op' && (token.text === '-' || token.text === '+' || token.text === '~')) {
      this.index += 1;
      return { t: 'unary', op: token.text, operand: this.factor() };
    }
    return this.power();
  }

  private power(): Ast {
    const base = this.postfix();
    if (this.eat('**')) return { t: 'binary', op: '**', left: base, right: this.factor() };
    return base;
  }

  private postfix(): Ast {
    let value = this.atom();
    for (;;) {
      if (this.at('.')) {
        this.index += 1;
        const name = this.next();
        if (name.kind !== 'name') throw new PythonError('invalid syntax');
        value = { t: 'attr', object: value, name: name.text };
        continue;
      }
      if (this.at('(')) {
        this.index += 1;
        const args: Ast[] = [];
        if (!this.at(')')) {
          do {
            if (this.at('*') || this.at('**')) {
              throw new PythonError('port: star-arguments are not implemented');
            }
            args.push(this.ternaryStarArg());
          } while (this.eat(',') && !this.at(')'));
        }
        this.expect(')');
        value = { t: 'call', fn: value, args };
        continue;
      }
      if (this.at('[')) {
        this.index += 1;
        value = { t: 'subscript', object: value, index: this.subscript() };
        this.expect(']');
        continue;
      }
      break;
    }
    return value;
  }

  /** A call argument: a full expression, or a generator/comprehension (unsupported). */
  private ternaryStarArg(): Ast {
    if (this.at('for')) throw new PythonError('port: generator expressions are not implemented');
    return this.ternary();
  }

  private subscript(): Ast {
    const lower = this.at(':') ? null : this.ternary();
    if (!this.eat(':')) return lower!;
    const upper = this.at(':') || this.at(']') ? null : this.ternary();
    if (!this.eat(':')) return { t: 'slice', lower, upper, step: null };
    const step = this.at(']') ? null : this.ternary();
    return { t: 'slice', lower, upper, step };
  }

  private atom(): Ast {
    const token = this.next();

    if (token.kind === 'number' || token.kind === 'string') {
      return { t: 'const', value: token.value! };
    }

    if (token.kind === 'name') {
      if (NON_EXPRESSION_KEYWORDS.has(token.text)) {
        throw new PythonError('port: statement keywords are not expressions');
      }
      if (token.text === 'True') return { t: 'const', value: PY_TRUE };
      if (token.text === 'False') return { t: 'const', value: PY_FALSE };
      if (token.text === 'None') return { t: 'const', value: PY_NONE };
      if (KEYWORDS.has(token.text)) throw new PythonError('invalid syntax');
      return { t: 'name', id: token.text };
    }

    if (token.kind === 'op' && token.text === '(') {
      if (this.eat(')')) return { t: 'const', value: pyTuple([]) };
      const first = this.ternary();
      this.refuseComprehension();
      if (!this.eat(',')) {
        this.expect(')');
        return first;
      }
      const items: Ast[] = [first];
      while (!this.at(')')) {
        items.push(this.ternary());
        this.refuseComprehension();
        if (!this.eat(',')) break;
      }
      this.expect(')');
      return { t: 'sequence', kind: 'tuple', items };
    }

    if (token.kind === 'op' && token.text === '[') {
      const items: Ast[] = [];
      if (!this.at(']')) {
        for (;;) {
          items.push(this.ternary());
          this.refuseComprehension();
          if (!this.eat(',')) break;
          if (this.at(']')) break;
        }
      }
      this.expect(']');
      return { t: 'sequence', kind: 'list', items };
    }

    if (token.kind === 'op' && token.text === '{') {
      return this.dictOrSet();
    }

    throw new PythonError('invalid syntax');
  }

  private dictOrSet(): Ast {
    if (this.eat('}')) return { t: 'dict', entries: [] };

    const first = this.ternary();
    if (this.eat(':')) {
      const entries: (readonly [Ast, Ast])[] = [[first, this.ternary()]];
      while (this.eat(',')) {
        if (this.at('}')) break;
        const key = this.ternary();
        this.expect(':');
        entries.push([key, this.ternary()]);
      }
      this.refuseComprehension();
      this.expect('}');
      return { t: 'dict', entries };
    }

    const items: Ast[] = [first];
    while (this.eat(',')) {
      if (this.at('}')) break;
      items.push(this.ternary());
    }
    this.refuseComprehension();
    this.expect('}');
    return { t: 'sequence', kind: 'set', items };
  }
}

/* ------------------------------------------------------------------------------------ */
/* evaluation                                                                            */
/* ------------------------------------------------------------------------------------ */

function evaluate(ast: Ast): PyValue {
  switch (ast.t) {
    case 'const':
      return ast.value;
    case 'name': {
      const constant = ast.id;
      if (constant === 'True') return PY_TRUE;
      if (constant === 'False') return PY_FALSE;
      if (constant === 'None') return PY_NONE;
      if (BUILTINS.has(constant)) {
        // Native would return the function object (`str(len)` is `<built-in function len>`).
        throw new PythonError(`port: builtin '${constant}' used as a value is not implemented`);
      }
      throw new PythonError(`name '${constant}' is not defined`);
    }
    case 'attr': {
      // Every enum/class path in a worldfile expression is substituted during code
      // generation, so real attribute access only reaches here for a *Python* attribute
      // (`1 .real`), which no worldfile uses: refused loudly rather than approximated.
      const object = evaluate(ast.object);
      throw new PythonError(
        `port: attribute access is not implemented ('${pyTypeName(object)}.${ast.name}')`,
      );
    }
    case 'unary': {
      const operand = evaluate(ast.operand);
      if (ast.op === '-') return unaryMinus(operand);
      if (ast.op === '+') return unaryPlus(operand);
      return unaryInvert(operand);
    }
    case 'binary': {
      const left = evaluate(ast.left);
      const right = evaluate(ast.right);
      return pyBinaryOp(ast.op, left, right);
    }
    case 'bool': {
      const left = evaluate(ast.left);
      if (pyTruthy(left)) {
        if (ast.op === 'and') {
          const right = evaluate(ast.right);
          return pyTruthy(right) ? right : left;
        }
        return left;
      }
      if (ast.op === 'and') return left;
      const right = evaluate(ast.right);
      return pyTruthy(right) ? right : left;
    }
    case 'not':
      return pyBool(!pyTruthy(evaluate(ast.operand)));
    case 'compare': {
      const values = ast.operands.map(evaluate);
      for (let i = 0; i < ast.ops.length; i += 1) {
        if (!pyCompare(ast.ops[i]!, values[i]!, values[i + 1]!)) return PY_FALSE;
      }
      return PY_TRUE;
    }
    case 'cond':
      return pyTruthy(evaluate(ast.cond)) ? evaluate(ast.whenTrue) : evaluate(ast.whenFalse);
    case 'call': {
      if (ast.fn.t !== 'name') throw new PythonError('port: only builtin calls are implemented');
      const builtin = BUILTINS.get(ast.fn.id);
      if (builtin === undefined) throw new PythonError(`name '${ast.fn.id}' is not defined`);
      return builtin(ast.args.map(evaluate));
    }
    case 'subscript': {
      const object = evaluate(ast.object);
      if (ast.index.t === 'slice') {
        return pySlice(
          object,
          ast.index.lower === null ? null : evaluate(ast.index.lower),
          ast.index.upper === null ? null : evaluate(ast.index.upper),
          ast.index.step === null ? null : evaluate(ast.index.step),
        );
      }
      const index = evaluate(ast.index);
      return pySubscript(object, index);
    }
    case 'slice': {
      throw new PythonError('port: a bare slice is not a value');
    }
    case 'sequence': {
      const items = ast.items.map(evaluate);
      if (ast.kind === 'list') return pyList(items);
      if (ast.kind === 'tuple') return pyTuple(items);
      const unique: PyValue[] = [];
      for (const item of items) {
        if (!unique.some((existing) => pyEquals(existing, item))) unique.push(item);
      }
      return { kind: 'set', items: unique };
    }
    case 'dict': {
      const entries: (readonly [PyValue, PyValue])[] = [];
      for (const [key, value] of ast.entries) {
        entries.push([evaluate(key), evaluate(value)]);
      }
      return { kind: 'dict', entries };
    }
  }
}

/**
 * Python slicing (`s[a:b:c]`) for the three sequence kinds native's expressions can hold.
 * Index arithmetic is CPython's: negative indices count from the end, a missing bound is the
 * sequence's edge, `step` defaults to 1, and a `step` of 0 is a `ValueError`.
 */
function pySlice(
  object: PyValue,
  lower: PyValue | null,
  upper: PyValue | null,
  step: PyValue | null,
): PyValue {
  if (object.kind !== 'str' && object.kind !== 'list' && object.kind !== 'tuple') {
    throw new PythonError(`'${pyTypeName(object)}' object is not subscriptable`);
  }

  const items: readonly PyValue[] | string =
    object.kind === 'str' ? object.value : object.items;
  const length = typeof items === 'string' ? items.length : items.length;

  const stepValue = step === null ? 1 : Number(toIntValue(step));
  if (stepValue === 0) throw new PythonError('slice step cannot be zero');

  const clamp = (value: number): number => {
    const index = value < 0 ? value + length : value;
    return stepValue > 0
      ? Math.min(Math.max(index, 0), length)
      : Math.min(Math.max(index, -1), length - 1);
  };

  const boundary = (value: PyValue | null, isStart: boolean): number => {
    if (value === null) {
      if (stepValue > 0) return isStart ? 0 : length;
      return isStart ? length - 1 : -1;
    }
    return clamp(Number(toIntValue(value)));
  };

  const start = boundary(lower, true);
  const stop = boundary(upper, false);

  const picked: number[] = [];
  if (stepValue > 0) {
    for (let i = start; i < stop; i += stepValue) picked.push(i);
  } else {
    for (let i = start; i > stop; i += stepValue) picked.push(i);
  }

  if (typeof items === 'string') {
    return pyStrValue(picked.map((index) => items[index]!).join(''));
  }
  const selected = picked.map((index) => items[index]!);
  return object.kind === 'tuple' ? pyTuple(selected) : pyList(selected);
}

function pySubscript(object: PyValue, index: PyValue): PyValue {
  if (object.kind === 'dict') {
    const found = object.entries.find(([key]) => pyEquals(key, index));
    // CPython's `KeyError` carries the key's *repr* (`str(KeyError(3))` is `'3'`).
    if (found === undefined) throw new PythonError(pyRepr(index));
    return found[1];
  }

  if (object.kind !== 'str' && object.kind !== 'list' && object.kind !== 'tuple') {
    throw new PythonError(`'${pyTypeName(object)}' object is not subscriptable`);
  }

  if (!isIntLike(index)) {
    throw new PythonError(
      object.kind === 'str'
        ? `string indices must be integers, not '${pyTypeName(index)}'`
        : `${object.kind} indices must be integers or slices, not ${pyTypeName(index)}`,
    );
  }

  const raw = Number(intValue(index));
  const length = object.kind === 'str' ? object.value.length : object.items.length;
  const position = raw < 0 ? length + raw : raw;
  if (position < 0 || position >= length) {
    throw new PythonError(
      object.kind === 'str' ? 'string index out of range' : `${object.kind} index out of range`,
    );
  }
  return object.kind === 'str' ? pyStrValue(object.value[position]!) : object.items[position]!;
}

/**
 * `str( eval( text ) )` — what native's `interpreter.py` returned for the same text.
 *
 * Throws `PythonError` with CPython's message when the expression does not evaluate, and the
 * message native's own `[Python] ...` prefix wraps.
 */
export function evaluatePythonExpression(source: string): PyValue {
  const ast = new ExpressionParser(lex(source)).parse();
  return evaluate(ast);
}

/** As `evaluatePythonExpression`, as the *text* native stores (`str()` of the result). */
export function evaluatePythonExpressionText(source: string): string {
  return pyStr(evaluatePythonExpression(source));
}

/** True when a name is one of the implemented builtins (used by the inline evaluator's
 * diagnostics, and by tests that assert the builtin table is the documented one). */
export function isBuiltinName(name: string): boolean {
  return BUILTINS.has(name);
}
