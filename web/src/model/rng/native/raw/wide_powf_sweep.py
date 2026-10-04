#!/usr/bin/env python3
"""Wide `powf` sweep: the evidence that the transcription is not just corpus-shaped.

The committed corpus (`libm_args_powf.txt` / `libm_native_powf.txt`, 7 325 argument pairs) is
built from the model's own domains, a float lattice and the special-case ladder.  This script
adds the *random* half of the evidence, the same way `raw/wide_pow_sweep.py` does for `pow`:

  1. a deterministic sweep of (x, y) float32 pairs -- uniform bit patterns, biased exponents,
     the model's own `(e, ratio)` shape, and the integer/fraction exponents around the
     negative-base branch;
  2. the shipped `powf` per pair via `raw/libm_census.c` (the oracle),
  3. the C transcription `raw/powf_cand.c` per pair,
  4. a byte diff of the two -- 0 mismatches is the claim -- and

    clang -O2 raw/libm_census.c -o /tmp/libm_census
    clang -O2 -ffp-contract=off -I raw raw/powf_cand.c -o /tmp/powf_cand
    python3 raw/wide_powf_sweep.py 200000 /tmp/powf_wide.txt

The file it writes is `powf <argbits> <argbits> <native result bits>`, i.e. the same format as
the committed corpus, so the port can be diffed against it with the same reader:

    npx tsx tools/measure_powf.ts /tmp/powf_wide.txt

`tests/rng.test.ts` does not read the sweep (it is 20+ MB and regenerated on demand); the
committed corpus is what the test pins, and this script is what the corpus' *shape* claim rests
on.
"""

import math
import os
import random
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def f32bits(x: float) -> int:
    return struct.unpack('>I', struct.pack('>f', x))[0]


def f32from(u: int) -> float:
    return struct.unpack('>f', struct.pack('>I', u & 0xffffffff))[0]


def f32(x: float) -> float:
    try:
        return struct.unpack('>f', struct.pack('>f', x))[0]
    except OverflowError:
        return math.inf if x > 0 else -math.inf


def bits(x: float) -> str:
    return struct.pack('>d', float(x)).hex()


def pairs(n: int) -> list[tuple[float, float]]:
    rng = random.Random(20260928)
    out = []
    e_f = f32(2.7182818)
    for _ in range(n // 2):
        # uniform bit patterns: the dispatch ladders, the tables' full index range, NaNs
        out.append((f32from(rng.getrandbits(32)), f32from(rng.getrandbits(32))))
    for _ in range(n // 8):
        # positive normals against moderate exponents: the fast path's own domain
        x = f32(math.ldexp(1.0 + rng.random(), rng.randint(-120, 120)))
        y = f32(rng.choice([rng.uniform(-20, 20), rng.uniform(-1, 1), float(rng.randint(-9, 9))]))
        out.append((x, y))
    for _ in range(n // 8):
        # the model's own shape: base e, exponent -(x-mu)^2/(2 sigma^2)
        sigma = f32(10.0 ** rng.uniform(-1.5, 0.5))
        mu = f32(rng.uniform(-1.0, 1.0))
        x = f32(rng.random())
        top = f32(-(x - mu) * (x - mu))
        bottom = f32(2.0 * sigma * sigma)
        out.append((e_f, f32(top / bottom)))
    for _ in range(n // 8):
        # negative bases with integer / half-integer exponents (the parity branch)
        x = f32(-math.ldexp(1.0 + rng.random(), rng.randint(-20, 20)))
        y = f32(rng.choice([float(rng.randint(-40, 40)), rng.randint(-40, 40) + 0.5,
                            rng.uniform(-8, 8)]))
        out.append((x, y))
    return out


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 200000
    out_path = sys.argv[2] if len(sys.argv) > 2 else '/tmp/powf_wide.txt'
    args_path = out_path + '.args'
    got_path = out_path + '.cand'

    ps = pairs(n)
    with open(args_path, 'w') as f:
        for x, y in ps:
            f.write(f'powf {bits(x)} {bits(y)}\n')

    census = os.environ.get('LIBM_CENSUS', '/tmp/libm_census')
    cand = os.environ.get('POWF_CAND', '/tmp/powf_cand')
    with open(args_path, 'rb') as fi, open(out_path, 'wb') as fo:
        subprocess.run([census], stdin=fi, stdout=fo, check=True)
    with open(args_path, 'rb') as fi, open(got_path, 'wb') as fo:
        subprocess.run([cand], stdin=fi, stdout=fo, check=True)

    native = open(out_path, 'rb').read()
    cand_out = open(got_path, 'rb').read()
    nrows = native.count(b'\n')
    print(f'{nrows} pairs: census bytes {len(native)}, candidate bytes {len(cand_out)}')
    if native != cand_out:
        nl = native.split(b'\n')
        cl = cand_out.split(b'\n')
        bad = [i for i, (a, b) in enumerate(zip(nl, cl)) if a != b]
        print(f'MISMATCH: {len(bad)} rows, first: {nl[bad[0]]!r} vs {cl[bad[0]]!r}')
        sys.exit(1)
    print(f'C transcription == shipped powf on all {nrows} pairs (byte-identical files)')


if __name__ == '__main__':
    main()
