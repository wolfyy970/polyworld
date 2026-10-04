#!/usr/bin/env python3
"""The wide sweep behind "the port reproduces the shipped `sinf`/`cosf`/`__sincosf_stret`".

The committed corpora (`raw/libm_args_{sinf,cosf}.txt` -> `raw/libm_native_{sinf,cosf}.txt`,
and `raw/libm_native_sincosf.txt`) are the auditable fixtures; this is the *development*
evidence, regenerated on demand because it is large:

    clang -O2 raw/libm_census.c -o /tmp/libm_census          # sinf/cosf
    clang -O2 raw/sincosf_census.c -o /tmp/sincosf_census    # __sincosf_stret (via dlsym)
    clang -O2 -ffp-contract=off raw/sinf_cand.c -o /tmp/sinf_cand
    clang -O2 -ffp-contract=off raw/sincosf_cand.c -o /tmp/sincosf_cand
    python3 raw/wide_sinf_sweep.py [N]

The argument lists hit every branch of the three transcriptions: the float32 dispatch
boundaries (pi/4, 120, 2^26) and their ulp neighbours, the tiny path, +-0, +-inf, NaN,
uniform samples over each range, raw float32 bit patterns with every exponent field, and -- the
case the corpus does *not* cover -- arguments past 2^63, where the quadrant's integer
conversion saturates.  The shipped functions and the C transcriptions are run over the same
list and diffed as bits; two binaries, one diff, nothing can agree by accident.

`N` is the number of values per range (~7.5 x N total; N = 40000 -> ~300,000 values).
"""

import os
import random
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CENSUS = '/tmp/libm_census'
SC_CENSUS = '/tmp/sincosf_census'
CAND = '/tmp/sinf_cand'
SC_CAND = '/tmp/sincosf_cand'

PI4F = struct.unpack('<f', struct.pack('<f', 0.7853981852531433))[0]


def bits(x: float) -> str:
    """the double bits of the float32 value, the form both censuses read"""
    f = struct.unpack('>f', struct.pack('>f', float(x)))[0]
    return struct.pack('>d', f).hex()


def from_bits(h: str) -> float:
    return struct.unpack('>d', bytes.fromhex(h))[0]


def from_f32bits(u: int) -> float:
    return struct.unpack('>f', struct.pack('>I', u & 0xffffffff))[0]


def ulp_neighbours(x: float, k: int = 8) -> list[float]:
    u = struct.unpack('<I', struct.pack('<f', float(x)))[0]
    out = []
    for d in range(-k, k + 1):
        p = u + d
        if 0 <= p < (1 << 32):
            out.append(from_f32bits(p))
    return out


def corpus(n: int, rng: random.Random) -> list[float]:
    out = []
    # every dispatch boundary, +-8 ulp (the small/medium boundary is the *float32* neighbour
    # of pi/4, so ulp steps are taken in float32)
    for x in (PI4F, 120.0, 67108864.0, 2.44140625e-4, 0.0, 1.0, -1.0):
        out += ulp_neighbours(x)
    # the special rows and the raw bit patterns the comparisons use
    for u in (0x7f800000, 0xff800000, 0x7fc00000, 0xffc00000, 0x00000001, 0x80000001,
              0x00000000, 0x80000000):
        out.append(from_f32bits(u))
    # uniform over each range
    for _ in range(n):
        out.append(from_f32bits(rng.randrange(0x39800000, 0x3f490fdb)))      # tiny/small
    for _ in range(n):
        out.append(rng.uniform(-120.0, 120.0))                               # medium
    for _ in range(n // 2):
        out.append(rng.uniform(120.0, 67108864.0))                           # cosf's two-part
    for _ in range(n // 2):
        out.append(rng.uniform(-67108864.0, -120.0))
    # the large table path, including past 2^63 where the integer conversion saturates
    for _ in range(n):
        out.append(rng.uniform(-1e24, 1e24))
    for _ in range(n // 4):
        out.append(rng.uniform(-3.4e38, 3.4e38))
    # raw bit patterns with every exponent field, sign mixed in (skipping inf/NaN)
    for _ in range(n):
        e = rng.randint(0, 0xfd)
        out.append(from_f32bits((rng.getrandbits(1) << 31) | (e << 23) | rng.getrandbits(23)))
    return out


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 40000
    rng = random.Random(20260928)
    xs = corpus(n, rng)
    args = '\n'.join(f'sinf {bits(x)}\ncosf {bits(x)}' for x in xs) + '\n'
    sc_args = '\n'.join(f'sincosf {bits(x)}' for x in xs) + '\n'

    def run(cmd: str, payload: str) -> list[str]:
        return subprocess.run([cmd], input=payload, capture_output=True, text=True,
                              check=True).stdout.split('\n')

    want_s = [l for l in run(CENSUS, args) if l.startswith('sinf')]
    want_c = [l for l in run(CENSUS, args) if l.startswith('cosf')]
    want_sc = [l for l in run(SC_CENSUS, sc_args) if l.startswith('sincosf')]
    got_s = [l for l in run(CAND, args) if l.startswith('sinf')]
    got_c = [l for l in run(CAND, args) if l.startswith('cosf')]
    got_sc = [l for l in run(SC_CAND, sc_args) if l.startswith('sincosf')]

    total = 0
    for name, want, got in (('sinf', want_s, got_s), ('cosf', want_c, got_c),
                            ('sincosf', want_sc, got_sc)):
        assert len(want) == len(got) == len(xs), (name, len(want), len(got), len(xs))
        bad = 0
        for i in range(len(xs)):
            if want[i] != got[i]:
                bad += 1
                if bad <= 5:
                    print(f'  DIFF {name} x={xs[i]!r} native={want[i]} cand={got[i]}')
        print(f'{name:8s}: {len(xs) - bad}/{len(xs)} bit-exact')
        total += bad
    print(f'wide float sweep: {len(xs)} arguments, '
          f'{3 * len(xs) - total}/{3 * len(xs)} results bit-exact')


if __name__ == '__main__':
    main()
