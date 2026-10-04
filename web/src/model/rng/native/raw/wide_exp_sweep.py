#!/usr/bin/env python3
"""The wide sweep behind "the port reproduces the shipped `exp` bit-for-bit".

The committed corpus (`raw/libm_args_exp.txt`, 8,261 values) is the auditable fixture; this
is the *development* evidence, and it is regenerated on demand because it is large:

    python3 raw/wide_exp_sweep.py [N]

It builds argument lists that hit every branch of the transcription -- the two dispatch
thresholds and their ulp neighbours, the overflow / underflow / special paths, the
subnormal-result window, uniform samples over the finite range, and raw bit patterns --
then runs the *shipped* `exp` (via `libm_census`) and the C transcription (`exp_cand`) over
them and diffs the results as bits. Two binaries, one diff: nothing here can agree by
accident.
"""

import os
import random
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CENSUS = '/tmp/libm_census'
CAND = '/tmp/exp_cand'


def bits(x: float) -> str:
    return struct.pack('>d', float(x)).hex()


def from_bits(h: str) -> float:
    return struct.unpack('>d', bytes.fromhex(h))[0]


def ulp_neighbours(x: float, k: int = 8) -> list[float]:
    u = struct.unpack('>Q', struct.pack('>d', x))[0]
    out = []
    for d in range(-k, k + 1):
        p = u + d
        if 0 <= p < (1 << 64):
            out.append(struct.unpack('>d', struct.pack('>Q', p))[0])
    return out


def corpus(n: int, rng: random.Random) -> list[float]:
    out = []
    # every threshold, ±8 ulp
    for x in (709.78271289338409, -745.25, -708.39641853226408, 0.0,
              5.551115123125783e-17, 1.0, -1.0):
        out += ulp_neighbours(x)
    # the two dispatch boundaries in raw bit form as well (the code compares bit patterns)
    out += [from_bits('%016x' % v) for v in (0x40862e42fefa39ef, 0x40862e42fefa39f0,
                                             0xc0874a0000000000, 0xc0874a0000000001,
                                             0x7ff0000000000000, 0xfff0000000000000,
                                             0x7ff8000000000000, 0xfff8000000000000,
                                             0x0000000000000001, 0x8000000000000001)]
    # uniform over the whole finite range exp() handles
    for _ in range(n):
        out.append(rng.uniform(-745.3, 709.79))
    # the subnormal-result window, densely (results below 2^-1022)
    for _ in range(n // 5):
        out.append(rng.uniform(-745.25, -708.4))
    # near zero, where the poly's small terms matter most
    for _ in range(n // 10):
        out.append(rng.uniform(-1e-8, 1e-8))
        out.append(rng.uniform(-1.0, 1.0))
    # raw bit patterns with every exponent field, sign mixed in
    for _ in range(n // 5):
        e = rng.randint(0, 0x7ff)
        frac = rng.getrandbits(52)
        sign = rng.getrandbits(1)
        u = (sign << 63) | (e << 52) | frac
        out.append(from_bits('%016x' % u))
    return out


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 200000
    rng = random.Random(20260928)
    xs = corpus(n, rng)
    lines = '\n'.join(f'exp {bits(x)}' for x in xs) + '\n'

    a = subprocess.run([CENSUS], input=lines, capture_output=True, text=True, check=True).stdout
    b = subprocess.run([CAND], input=lines, capture_output=True, text=True, check=True).stdout
    na = a.split('\n')
    nb = b.split('\n')
    assert len(na) == len(nb), (len(na), len(nb))
    bad = 0
    for i in range(len(xs)):
        if na[i] != nb[i]:
            bad += 1
            if bad <= 10:
                print(f'  DIFF x={xs[i]!r} native={na[i]} cand={nb[i]}')
    print(f'exp wide sweep: {len(xs) - bad}/{len(xs)} bit-exact ({len(xs)} values)')


if __name__ == '__main__':
    main()
