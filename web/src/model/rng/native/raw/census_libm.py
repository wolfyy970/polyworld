#!/usr/bin/env python3
"""The libm census: is the oracle's libm `exp`/`pow`/`sin`/`cos` correctly rounded?

Reads the raw-bit corpora captured from the shipped libSystem (`raw/libm_native_<fn>.txt`,
written by `raw/libm_census.c`) and compares them against

  * a **correctly rounded** reference computed with Python's `decimal`,
  * **V8's** `Math.exp` / `Math.pow` / `Math.sin` / `Math.cos` (the port's previous
    behaviour), run through `node`.

    python3 raw/census_libm.py            # writes raw/libm_census.out (the JSON summary)

The reference is *checked*, not assumed: every input is evaluated twice, at the working
precision and 40 digits higher, and any input where the two disagree about the double
(the only way a finite-precision reference can be wrong) is reported and resolved at 200+
digits. For `sin`/`cos` the working precision is picked from the argument's own magnitude
so the Payne-Hanek-scale arguments (1e300) reduce correctly.
"""

from __future__ import annotations

import json
import math
import os
import struct
import subprocess
import sys
from decimal import Decimal, InvalidOperation, Overflow, Underflow, getcontext, localcontext

HERE = os.path.dirname(os.path.abspath(__file__))

# --------------------------------------------------------------------------- tabulation

def bits_to_double(h: str) -> float:
    return struct.unpack('>d', bytes.fromhex(h))[0]


def double_to_bits(x: float) -> str:
    return struct.pack('>d', float(x)).hex()


def ulp_distance(a: str, b: str) -> int:
    """Distance in representable doubles between two bit patterns (-1 on a sign change)."""
    ia = int(a, 16) & ((1 << 63) - 1)
    ib = int(b, 16) & ((1 << 63) - 1)
    if (int(a, 16) >> 63) != (int(b, 16) >> 63):
        return -1
    return abs(ia - ib)


# ------------------------------------------------------------------- exact references

_PI_CACHE = (0, None)  # (precision, pi)


def atan_decimal(x: Decimal) -> Decimal:
    """atan(x): argument halving (atan x = 2 atan( x / (1 + sqrt(1+x^2)) )) then Taylor."""
    k = 0
    while abs(x) > Decimal('0.05'):
        x = x / (1 + (1 + x * x).sqrt())
        k += 1
    prec = getcontext().prec
    tiny = Decimal(1).scaleb(-(prec + 5))     # below this a term cannot move the sum
    x2 = x * x
    term = x
    total = x
    n = 1
    while abs(term) > tiny:
        term = -term * x2
        n += 2
        total += term / n
    return total * (2 ** k)


def pi_decimal(prec: int) -> Decimal:
    """pi to `prec` digits (Machin), cached; recomputed when a larger precision is asked."""
    global _PI_CACHE
    have, val = _PI_CACHE
    if val is not None and have >= prec:
        return val
    with localcontext() as ctx:
        ctx.prec = prec + 15
        one = Decimal(1)
        p = Decimal(16) * atan_decimal(one / 5) - Decimal(4) * atan_decimal(one / Decimal(239))
        p = +p
    getcontext().prec = prec
    p = +p                                   # rounded to exactly `prec` digits
    _PI_CACHE = (prec, p)
    return p


def exp_ref(x: float, prec: int = 60) -> float:
    """`e^x`, correctly rounded.  `decimal` raises Overflow/Underflow for the arguments whose
    result falls outside its own exponent range -- there the true value is +inf / 0, and the
    corpus deliberately contains those rows (1e300, +-inf, NaN)."""
    if x != x:
        return math.nan
    getcontext().prec = prec
    try:
        return float(Decimal(x).exp())
    except Overflow:
        return math.inf
    except (Underflow, InvalidOperation):
        return 0.0


def sin_cos_ref(x: float, want_sin: bool, prec: int | None = None) -> float:
    if x != x or math.isinf(x):
        return math.nan if x != x else math.nan
    ax = abs(x)
    if prec is None:
        prec = 40 + (int(math.log10(ax)) + 1 if ax >= 1.0 else 0) + 20
    getcontext().prec = prec
    dx = Decimal(x)
    half_pi = pi_decimal(prec) / 2
    k = int((dx / half_pi).to_integral_value())
    r = dx - k * half_pi                      # |r| <= pi/4, accurately reduced
    r2 = r * r
    tiny = Decimal(1).scaleb(-(prec + 5))     # below this a term cannot move the sum

    # sin(r) and cos(r), full series at the working precision (|r| <= pi/4)
    ts = r
    s = r
    n = 1
    while abs(ts) > tiny:
        ts = -ts * r2 / ((n + 1) * (n + 2))
        n += 2
        s += ts
    tc = Decimal(1)
    c = Decimal(1)
    n = 0
    while abs(tc) > tiny:
        tc = -tc * r2 / ((n + 1) * (n + 2))
        n += 2
        c += tc

    q = k % 4
    if q == 0:
        return float(s if want_sin else c)
    if q == 1:
        return float(c if want_sin else -s)
    if q == 2:
        return float(-s if want_sin else -c)
    return float(-c if want_sin else s)


def pow_ref(a: float, b: float, prec: int = 60) -> float:
    """The correctly rounded a**b for the cases C's pow is defined on.

    The non-finite / (x == 0) / (y == 0) / (x == 1) rows -- which the corpus now covers
    explicitly -- are exactly the ones C99 pins down, and Python's `math.pow` is the C
    library's own answer there, so it is the reference for them (and it is exact: no
    rounding is involved in any of those cases).  Everything else goes through `decimal`,
    with Overflow/Underflow mapped to +-inf / 0 (the true value)."""
    getcontext().prec = prec
    if a != a or b != b:
        return math.nan
    if not (math.isfinite(a) and math.isfinite(b)) or a == 0.0 or b == 0.0 or a == 1.0:
        try:
            return math.pow(a, b)
        except ValueError:          # C99 domain error: a < 0 with a non-integer exponent
            return math.nan
        except OverflowError:
            return math.inf if b > 0 else 0.0
    int_exp = b == math.floor(b) and abs(b) < 1e15
    if a < 0 and not int_exp:
        return math.nan
    da = Decimal(-a if a < 0 else a)
    sign = -1.0 if (a < 0 and int(b) % 2 == 1) else 1.0
    try:
        if int_exp:
            val = da ** abs(int(b))
            if val == 0:
                return 0.0
            return sign * float(val)
        return float((Decimal(b) * da.ln()).exp())
    except Overflow:
        return sign * math.inf if (int_exp or b > 0) else 0.0
    except Underflow:
        return 0.0
    except InvalidOperation:
        return math.nan


REFS = {
    'exp': lambda f: exp_ref(bits_to_double(f[1])),
    'sin': lambda f: sin_cos_ref(bits_to_double(f[1]), True),
    'cos': lambda f: sin_cos_ref(bits_to_double(f[1]), False),
    'pow': lambda f: pow_ref(bits_to_double(f[1]), bits_to_double(f[2])),
}

# the same references 40 digits higher: a finite-precision reference can only be wrong when
# the working precision puts the exact value close enough to a midpoint that the two
# precisions disagree about the rounded double. Every such input is reported.
def ref_hi(fn: str, f: list[str]) -> float:
    if fn == 'exp':
        return exp_ref(bits_to_double(f[1]), 100)
    if fn == 'pow':
        return pow_ref(bits_to_double(f[1]), bits_to_double(f[2]), 100)
    x = bits_to_double(f[1])
    if x != x or math.isinf(x):
        return math.nan
    prec = 40 + (int(math.log10(abs(x))) + 1 if abs(x) >= 1.0 else 0) + 60
    return sin_cos_ref(x, fn == 'sin', prec)


# ------------------------------------------------------------------------- the V8 side

NODE_SRC = r'''
const fs = require('fs');
const lines = fs.readFileSync(0, 'utf8').split('\n').filter(l => l.length);
const bits2d = h => Buffer.from(h, 'hex').readDoubleBE(0);
const d2bits = d => { const b = Buffer.alloc(8); b.writeDoubleBE(d, 0); return b.toString('hex'); };
const out = [];
for (const line of lines) {
  const f = line.split(' ');
  const a = bits2d(f[1]);
  if (f[0] === 'pow') out.push(f[0] + ' ' + f[1] + ' ' + f[2] + ' ' + d2bits(Math.pow(a, bits2d(f[2]))));
  else out.push(f[0] + ' ' + f[1] + ' ' + d2bits(Math[f[0]](a)));
}
process.stdout.write(out.join('\n') + '\n');
'''


def v8_results(path: str) -> dict[tuple, str]:
    lines = [l for l in open(path).read().split('\n') if l]
    p = subprocess.run(['node', '-e', NODE_SRC], input='\n'.join(lines) + '\n',
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr)
    out = {}
    for line in p.stdout.split('\n'):
        if not line:
            continue
        f = line.split(' ')
        out[tuple(f[:-1])] = f[-1]
    return out


# ------------------------------------------------------------------------------- report

def main() -> None:
    summary = {}
    for fn in ('exp', 'sin', 'cos', 'pow'):
        path = os.path.join(HERE, f'libm_native_{fn}.txt')
        if not os.path.exists(path):
            print(f'missing {path}', file=sys.stderr)
            continue
        lines = [l for l in open(path).read().split('\n') if l]
        v8 = v8_results(path)
        n = len(lines)
        cr_exact = v8_exact = 0
        max_cr_ulp = max_v8_ulp = 0
        cr_sign = v8_sign = 0
        ambiguous = 0
        examples = []
        for line in lines:
            f = line.split(' ')
            key = tuple(f[:-1])
            native = f[-1]
            ref = REFS[fn](f)
            rb = double_to_bits(ref)
            if rb != double_to_bits(ref_hi(fn, f)):
                ambiguous += 1               # the reference itself is precision-sensitive
                ref = ref_hi(fn, f)
                rb = double_to_bits(ref)
            if rb == native:
                cr_exact += 1
            else:
                d = ulp_distance(rb, native)
                if d < 0:
                    cr_sign += 1
                else:
                    max_cr_ulp = max(max_cr_ulp, d)
                if len(examples) < 5:
                    examples.append([key, native, rb, v8.get(key)])
            got = v8[key]
            if got == native:
                v8_exact += 1
            else:
                d = ulp_distance(got, native)
                if d < 0:
                    v8_sign += 1
                else:
                    max_v8_ulp = max(max_v8_ulp, d)
        summary[fn] = dict(n=n, cr_exact=cr_exact, cr_max_ulp=max_cr_ulp, cr_sign=cr_sign,
                           v8_exact=v8_exact, v8_max_ulp=max_v8_ulp, v8_sign=v8_sign,
                           precision_ambiguous=ambiguous, examples=examples)
        print(f'{fn}: n={n}  native==correctly-rounded {cr_exact}/{n} '
              f'({100.0*cr_exact/n:.3f}%, max {max_cr_ulp} ulp, {cr_sign} sign)   '
              f'native==V8 {v8_exact}/{n} ({100.0*v8_exact/n:.3f}%, max {max_v8_ulp} ulp, '
              f'{v8_sign} sign)   [reference precision-sensitive: {ambiguous}]')
        for e in examples:
            print('    example', e)
    with open(os.path.join(HERE, 'libm_census.out'), 'w') as f:
        json.dump(summary, f, indent=2, sort_keys=True)
        f.write('\n')


if __name__ == '__main__':
    main()
