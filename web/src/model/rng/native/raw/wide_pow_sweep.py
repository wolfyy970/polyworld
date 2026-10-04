#!/usr/bin/env python3
"""The wide sweep behind "the port reproduces the shipped `pow` bit-for-bit".

The committed corpus (`raw/libm_args_pow.txt`, 4,471 values) is the auditable fixture; this is
the *development* evidence, and it is regenerated on demand because it is large:

    clang -O2 raw/libm_census.c -o /tmp/libm_census
    clang -O2 -ffp-contract=off raw/pow_cand.c -o /tmp/pow_cand
    python3 raw/wide_pow_sweep.py [N]

It builds (x, y) pairs that hit every branch of the transcription -- the two dispatch guards
and their ulp neighbours, the whole special ladder (negative bases with even/odd integer
exponents, ±0, ±inf, NaN, subnormal and zero bases, |y| at 2^-65 and 2^64), the two
overflow/underflow thresholds, uniform samples over the ranges the model feeds it, and raw bit
patterns -- then runs the *shipped* `pow` (via `libm_census`) and the C transcription
(`pow_cand`) over them and diffs the results as bits.  Two binaries, one diff: nothing here can
agree by accident.

The random stream is seeded, so a re-run is reproducible.
"""

import os
import random
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CENSUS = '/tmp/libm_census'
CAND = '/tmp/pow_cand'


def bits(x: float) -> str:
    return struct.pack('>d', float(x)).hex()


def from_bits(h: str) -> float:
    return struct.unpack('>d', bytes.fromhex(h))[0]


def raw_bits(u: int) -> float:
    return struct.unpack('>d', struct.pack('>Q', u & 0xffffffffffffffff))[0]


def ulp_neighbours(x: float, k: int = 8) -> list[float]:
    u = struct.unpack('>Q', struct.pack('>d', x))[0]
    out = []
    for d in range(-k, k + 1):
        p = u + d
        if 0 <= p < (1 << 64):
            out.append(raw_bits(p))
    return out


def pairs(n: int, rng: random.Random) -> list[tuple[float, float]]:
    out = []
    # every threshold the code compares against, both operands, ±8 ulp (the masks/limits are
    # compared as *patterns*, so the raw-bit neighbours matter as much as the values)
    for v in (131200.0, -137600.0, 1.0, 0.0, -0.0, float('inf'), float('-inf'), float('nan'),
              2.0 ** 64, 2.0 ** -65, 2.0 ** 53, 2.0 ** 52, 2.0 ** -1022, 5e-324):
        for p in ulp_neighbours(v):
            out.append((1.5, p))
            out.append((2.0, p))
            out.append((0.5, p))
            out.append((-2.0, p))
            out.append((0.1, p))
    for u in (0x3ff0000000000000, 0x3be0000000000000, 0x43f0000000000000, 0x4340000000000000,
              0x0010000000000000, 0x0000000000000001, 0x7fefffffffffffff, 0x7ff0000000000000,
              0x7ff8000000000000, 0x8000000000000000, 0x40862e42fefa39f0):
        for p in ulp_neighbours(1.5):
            out.append((raw_bits(u), p))
    # the model's own ranges (genome `pow`, distributions): positive bases near 1, modest |y|
    for _ in range(n):
        out.append((rng.uniform(0.5, 2.0), rng.uniform(-8.0, 8.0)))
    # the fast path's full span, plus its edges
    for _ in range(n):
        e = rng.randint(-60, 60)
        out.append((rng.uniform(1.0, 2.0) * 2.0 ** e, rng.uniform(-200.0, 200.0)))
    # x < 1 (log2 x < 0, so t crosses zero inside the fast path)
    for _ in range(n // 2):
        out.append((rng.uniform(0.5, 1.0), rng.uniform(1.0, 300.0)))
    # negative bases with *exactly* integral y, odd and even, small and huge (the parity test)
    for _ in range(n // 2):
        out.append((-rng.uniform(0.5, 4.0), float(rng.randint(-40, 40))))
        out.append((-rng.uniform(0.5, 4.0), float(rng.randrange(-2 ** 60, 2 ** 60, 2))))
    # near the over/underflow thresholds: t = (y*128)*log2 x lands next to ±131200 / -137600
    for _ in range(n // 2):
        lg = rng.uniform(-4.0, 4.0)
        out.append((2.0 ** lg, rng.choice([-1.0, 1.0]) * (1024.0 + rng.uniform(-2.0, 4.0))))
    # subnormal bases (the normalising branch)
    for _ in range(n // 5):
        out.append((raw_bits(rng.getrandbits(52)), rng.uniform(-20.0, 20.0)))
    # the ladder rows `tests/rng.test.ts` carries, as (x, y) pairs -- the cases the *committed*
    # corpus does not happen to contain (y = +-0 with a generic base, x = 1, the two |y| guards'
    # exact patterns, integral/odd negative bases, subnormal and extreme bases).  Captured from
    # the shipped libm here, so the test's literal bit patterns are re-derivable from this list.
    ladder = [
        (2.0, 0.0), (2.0, -0.0), (-0.0, 0.0), (-2.0, -0.0), (float('nan'), 0.0),
        (1.0, 1.0), (1.0, float('inf')), (1.0, float('-inf')), (1.0, float('nan')),
        (1.0, 1e300), (1.0, -1e300),
        (-2.0, 3.0), (-2.0, 4.0), (-2.0, -3.0), (-2.0, -4.0), (-2.0, 0.5), (-2.0, -0.5),
        (-0.0, 3.0), (-0.0, 4.0), (-0.0, -3.0), (-0.0, -4.0), (-0.0, 3.5), (-0.0, -3.5),
        (0.0, 1.0), (0.0, -1.0), (0.0, 0.5), (0.0, -0.5),
        (float('inf'), 1.0), (float('inf'), -1.0), (float('inf'), 0.5), (float('inf'), -0.5),
        (float('-inf'), 3.0), (float('-inf'), 4.0), (float('-inf'), -3.0), (float('-inf'), -4.0),
        (float('-inf'), 0.5), (float('-inf'), -0.5),
        (float('nan'), 3.0), (2.0, float('nan')),
        (2.0, float('inf')), (2.0, float('-inf')), (0.5, float('inf')), (0.5, float('-inf')),
        (raw_bits(0x43f0000000000000), 3.0), (raw_bits(0xc3f0000000000000), 3.0),
        (raw_bits(0x43f0000000000000), 0.5),
        (3.0, raw_bits(0x43f0000000000000)), (3.0, raw_bits(0xc3f0000000000000)),
        (0.5, raw_bits(0x43f0000000000000)), (0.5, raw_bits(0xc3f0000000000000)),
        (-3.0, raw_bits(0x43f0000000000000)), (-3.0, raw_bits(0xc3f0000000000000)),
        (3.0, raw_bits(0x3be0000000000000)), (0.5, raw_bits(0x3be0000000000000)),
        (3.0, raw_bits(0x3be0000000000001)), (0.5, raw_bits(0x3be0000000000001)),
        (1.0, raw_bits(0x3be0000000000000)),
        (5e-324, 1.0), (1e-310, 1.0), (-5e-324, 1.0), (-1e-310, 3.0),
        (5e-324, 2.0), (2.0, 5e-324), (1e-310, 1e-310),
        (raw_bits(0x0010000000000000), 1.0), (raw_bits(0x7fefffffffffffff), 1.0),
    ]
    # raw bit patterns for both operands: the ladder's whole surface
    for _ in range(n // 2):
        out.append((raw_bits(rng.getrandbits(64)), raw_bits(rng.getrandbits(64))))
    return out + ladder


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 40000
    if not os.path.exists(CENSUS) or not os.path.exists(CAND):
        sys.exit('build /tmp/libm_census (clang -O2 raw/libm_census.c) and /tmp/pow_cand '
                 '(clang -O2 -ffp-contract=off raw/pow_cand.c) first')
    rng = random.Random(20260928)
    ps = pairs(n, rng)
    lines = '\n'.join(f'pow {bits(x)} {bits(y)}' for x, y in ps) + '\n'
    a = subprocess.run([CENSUS], input=lines, capture_output=True, text=True, check=True).stdout
    b = subprocess.run([CAND], input=lines, capture_output=True, text=True, check=True).stdout
    na, nb = a.split('\n'), b.split('\n')
    assert len(na) == len(nb), (len(na), len(nb))
    bad = 0
    for i in range(len(ps)):
        if na[i] != nb[i]:
            bad += 1
            if bad <= 10:
                print(f'  DIFF x={ps[i][0]!r} y={ps[i][1]!r} native={na[i]} cand={nb[i]}')
    print(f'pow wide sweep: {len(ps) - bad}/{len(ps)} bit-exact ({len(ps)} pairs)')


if __name__ == '__main__':
    main()
