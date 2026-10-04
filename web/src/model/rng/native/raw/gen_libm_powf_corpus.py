#!/usr/bin/env python3
"""Build the float32 argument corpus the `powf` transcription is measured on.

`powf` is the C++ `float` overload the oracle calls at two sites, and both of them are in the
model's own code — there is no double `pow` call to reuse:

  * `distributions.cc:41` (`normalPDF`, and the same expression inlined into `getNormal`):
    `pow( e, (rightTop / rightBottom) )` — the base is always the *float* literal
    `float e = 2.7182818` (= 0x402DF854) and the exponent is `f32(rightTop / rightBottom)`
    (`rightTop = -(x-mu)^2`, `rightBottom = 2*sigma^2`);
  * `Genome.cc:502` (`Genome::mateProbability`): `pow( fabs(cosa), get(MISC_INVIS_SLOPE) )`
    with both operands `float` (the gene is NULL in this build, so there is no default slope to
    read — the slope lattice below covers the plausible range).

So the corpus is built from three sources, all float32-valued doubles (the census casts each
argument to `float`, which is what the C++ overload does):

  * the **model's own** arguments: the `ratio` column re-derived from L10's pinned
    `normalpdf_sweep.tsv` (1 296 rows, each carrying the oracle's own `right`), plus the
    `mateProbability` base/slope lattice (every float in [0,1] on a 1/512 grid against the
    slopes {0.5, 1, 1.5, 2, 3, 4, 6});
  * a **wide sweep** over the float pattern lattice: bases across every binade (and their
    neighbours, including subnormals and the largest finite floats) against exponents that hit
    every branch of the internal log/exp tables (integers, halves, ±0.5-magnitude fractions,
    ±1e30, ±FLT_MAX);
  * the **special-case ladder**: +-0, +-inf and NaN on either side, negative bases with
    odd/even integer exponents, the base 1 and the exponent 1 shortcuts, and the
    overflow/underflow boundaries.

    clang -O2 raw/libm_census.c -o /tmp/libm_census
    python3 raw/gen_libm_powf_corpus.py
    /tmp/libm_census < raw/libm_args_powf.txt > raw/libm_native_powf.txt

`tests/rng.test.ts`'s `powf` block walks the result file and requires bit-equality; the C
transcription in `raw/apple_powf_impl.h` is diffed against the same file
(`raw/powf_cand.c`).
"""

import math
import os
import random
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
# L10's pinned corpus: x, sigma, mu, left, rightTop, rightBottom, right, pdf (all float32 bits)
L10_SWEEP = os.path.join(HERE, '..', '..', '..', 'environment', 'native', 'raw',
                         'normalpdf_sweep.tsv')


def f32(x: float) -> float:
    """the float32 value nearest `x`, as a double (+-inf outside the range)."""
    try:
        return struct.unpack('>f', struct.pack('>f', x))[0]
    except OverflowError:
        return math.inf if x > 0 else -math.inf


def bits(x: float) -> str:
    return struct.pack('>d', float(x)).hex()


def f32bits(x: float) -> int:
    return struct.unpack('>I', struct.pack('>f', x))[0]


def f32from(u: int) -> float:
    return struct.unpack('>f', struct.pack('>I', u & 0xffffffff))[0]


def model_args() -> list[tuple[float, float]]:
    """`normalPDF`'s own `(base, exponent)` pairs, re-derived from the L10 sweep."""
    out = []
    e_f = f32(2.7182818)                      # the float literal `float e` in distributions.cc
    with open(L10_SWEEP) as f:
        for line in f:
            p = line.split()
            if len(p) != 8:
                continue
            right_top = f32from(int(p[4], 16))
            right_bottom = f32from(int(p[5], 16))
            out.append((e_f, f32(right_top / right_bottom)))
    return out


def mate_args() -> list[tuple[float, float]]:
    """`mateProbability`'s `(fabs(cosa), MISC_INVIS_SLOPE)` lattice, both operands float."""
    out = []
    for i in range(0, 513, 4):
        base = f32(i / 512.0)                 # the float lattice in [0, 1]
        for slope in (0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0):
            out.append((base, f32(slope)))
    return out


def wide(rng: random.Random) -> list[tuple[float, float]]:
    out = []
    # bases: 24-bit mantissas across the whole float range (normal, then subnormal) ...
    for e in range(-40, 39):
        for i in range(24):
            m = f32(1.0 + (i + rng.random()) / 24.0)
            out.append((f32(math.ldexp(m, e)), f32(rng.choice([-3.0, -2.0, -1.0, 0.5, 1.0, 2.0, 3.0, 7.0]))))
    # ... the binade boundaries themselves (where the index/k extraction changes) ...
    for e in range(-40, 39):
        for base in (math.ldexp(1.0, e), math.ldexp(1.0 - 2 ** -24, e + 1)):
            b = f32(base)
            for y in (2.0, 3.0, -2.0, 0.5, -0.5, 1.0):
                out.append((b, f32(y)))
    # ... the subnormal lattice, the smallest/largest finite floats, and
    # the float32 representation of the double `pow` corpus' exponents
    for m in (1, 2, 3, 0x7fffff, 0x400000, 0x123456):
        out.append((f32from(m), 2.0))
        out.append((f32from(m), -1.0))
    for base in (f32(3.4028235e38), f32(1.1754944e-38), f32(1.4012984643e-45)):
        for y in (0.5, 1.5, 2.0, -1.0, 127.0, 128.0, 200.0):
            out.append((base, f32(y)))
    # exponents on their own lattice, against the model's own base
    e_f = f32(2.7182818)
    for i in range(-4000, 1, 2):              # -(x-mu)^2/(2 sigma^2) is always <= 0 here
        out.append((e_f, f32(i / 2000.0)))
    # generic pairs, both signs (negative bases are legal for integer exponents)
    for _ in range(600):
        base = f32(math.ldexp(rng.uniform(-2.0, 2.0), rng.randint(-40, 40)))
        y = rng.choice([rng.randint(-8, 8), rng.uniform(-8.0, 8.0), 0.5, 2.0, 3.0, -0.5])
        out.append((base, f32(y)))
    return out


def ladder() -> list[tuple[float, float]]:
    nan, inf = math.nan, math.inf
    e_f = f32(2.7182818)
    return [
        # the two shortcuts the shipped code tests first: x == 1.0f / y == 1.0f
        (1.0, 1.0), (1.0, 1e30), (1.0, -1e30), (1.0, nan), (1.0, inf), (1.0, -inf), (1.0, 0.5),
        (2.0, 1.0), (-2.0, 1.0), (0.0, 1.0), (-0.0, 1.0), (inf, 1.0), (-inf, 1.0), (nan, 1.0),
        # y = +-0 / +-inf / NaN (the first ladder), against every kind of base
        (2.0, 0.0), (2.0, -0.0), (-2.0, 0.0), (0.0, 0.0), (-0.0, -0.0), (inf, 0.0), (nan, 0.0),
        (1.5, 0.0), (0.5, -0.0),
        (2.0, inf), (2.0, -inf), (0.5, inf), (0.5, -inf), (1.5, inf), (1.5, -inf),
        (-1.0, inf), (-1.0, -inf), (-0.0, inf), (-0.0, -inf), (0.0, inf), (0.0, -inf),
        (inf, inf), (inf, -inf), (-inf, inf), (-inf, -inf), (nan, inf), (nan, -inf),
        (2.0, nan), (0.5, nan), (-2.0, nan), (0.0, nan), (inf, nan), (-inf, nan), (nan, nan),
        # x isn't a positive normal: +-0, negative, +-inf, NaN, subnormal
        (0.0, 2.0), (0.0, -2.0), (0.0, 3.0), (0.0, -3.0), (0.0, 2.5), (0.0, -2.5), (0.0, 0.5),
        (-0.0, 2.0), (-0.0, 3.0), (-0.0, -3.0), (-0.0, 2.5), (-0.0, -2.5), (-0.0, 1.5),
        (0.0, 1e30), (-0.0, 1e30), (0.0, -1e30), (-0.0, -1e30),
        (-2.0, 2.0), (-2.0, 3.0), (-2.0, 4.0), (-2.0, -2.0), (-2.0, -3.0), (-2.0, 2.5),
        (-2.0, -2.5), (-2.0, 0.5), (-2.0, -0.5), (-0.5, 3.0), (-0.5, 4.0), (-0.5, -3.0),
        (-0.5, 0.5), (-1.5, 5.0), (-1.5, 4.0), (-3.0, 7.0), (-3.0, 6.0), (-1.0, 2.0),
        (inf, 2.0), (inf, 3.0), (inf, -2.0), (inf, 0.5), (inf, -0.5), (inf, 1e30),
        (-inf, 2.0), (-inf, 3.0), (-inf, -3.0), (-inf, 0.5), (-inf, -0.5),
        (nan, 2.0), (nan, -2.0), (nan, 0.5),
        # subnormal bases (the normalising branch) against integers and fractions
        (f32from(1), 2.0), (f32from(1), 3.0), (f32from(1), -1.0), (f32from(0x7fffff), 2.0),
        (f32from(0x123456), 2.0), (f32(2 ** -126 * 1.5), 2.0), (f32(2 ** -140), -2.0),
        (f32(1e-40), 2.0), (f32(1e-40), -0.5), (f32(5.9e-39), 3.0),
        # the overflow / underflow ends of the result range
        (2.0, 200.0), (2.0, -200.0), (10.0, 100.0), (10.0, -100.0), (3.4028235e38, 2.0),
        (1.1754944e-38, 2.0), (1.1754944e-38, -2.0), (1e30, 3.0), (1e-30, 3.0),
        (f32(2.0 ** 64), 3.0), (f32(2.0 ** 64), 0.5), (f32(2.0 ** -64), 3.0),
        # the float neighbours of the internal thresholds (127.0, 128.0 in y, and x near 1)
        (2.0, 127.0), (2.0, 128.0), (2.0, -127.0), (2.0, -128.0),
        (f32from(f32bits(1.0) + 1), 1e6), (f32from(f32bits(1.0) - 1), 1e6),
        (f32from(f32bits(1.0) + 1), -1e6), (f32from(f32bits(1.0) - 1), -1e6),
        (3.3, -0.0078125), (3.3, -0.001953125), (e_f, -0.03125),
        # the |y| dispatch guard itself: FLT_MAX takes the *fast* path, its neighbours and inf
        # do not; the smallest subnormal y does, and the 2^24 integer-parity clamp boundary
        # (above it every y counts as "even") decides the sign of a negative base
        (2.0, f32(3.4028235e38)), (2.0, f32(-3.4028235e38)), (0.5, f32(3.4028235e38)),
        (2.0, f32from(f32bits(f32(3.4028235e38)) - 1)), (2.0, f32from(f32bits(2.0 ** 24))),
        (e_f, f32(3.4028235e38)), (e_f, f32from(f32bits(f32(3.4028235e38)) - 1)),
        (2.0, f32from(1)), (2.0, -f32from(1)), (0.5, f32from(1)),
        (-2.0, f32(2.0 ** 24)), (-2.0, 2.0 ** 24 + 2.0), (-2.0, f32(2.0 ** 24 + 1)),
        (-2.0, 16777215.0), (-2.0, -16777215.0), (-0.5, f32(2.0 ** 24 + 1)),
        (-1.5, 8388609.0), (-3.0, f32(2.0 ** 25)), (-2.0, f32(2.0 ** 24 - 1)),
    ]


def main() -> None:
    rng = random.Random(20260928)
    args = model_args() + mate_args() + wide(rng) + ladder()
    seen = set()
    out = []
    for a, b in args:
        key = (bits(a), bits(b))
        if key in seen:
            continue
        seen.add(key)
        out.append(f'powf {key[0]} {key[1]}')
    path = os.path.join(HERE, 'libm_args_powf.txt')
    with open(path, 'w') as f:
        f.write('\n'.join(out) + '\n')
    print(f'{path}: {len(out)} argument pairs')


if __name__ == '__main__':
    main()
