#!/usr/bin/env python3
"""Build the float32 corpora the `sinf`/`cosf` decision is measured on.

`CameraController.cc` computes `sin( camrad )` where `camrad` is a `float` (PARITY.md open
question 9), i.e. it calls C++'s `float` overload -> libm's `sinf`.  L14 currently computes
`Math.fround( Math.sin( x ) )`.  Those two can differ when the float32 argument sits close to
a midpoint of the correctly rounded float result, so the question "does L14 need its own
transcription of the float overloads?" is answered with numbers over

  * the double corpus's arguments cast to float32 (deduplicated), and
  * the camera's own range: `yaw * DEGTORAD` for yaw in 0..360, as a float.

    clang -O2 raw/libm_census.c -o /tmp/libm_census
    python3 raw/gen_libm_sinf_corpus.py
    /tmp/libm_census < raw/libm_args_sinf.txt > raw/libm_native_sinf.txt
    /tmp/libm_census < raw/libm_args_cosf.txt > raw/libm_native_cosf.txt

The comparison itself (`native sinf` vs `fround(ported sin)` vs `fround(Math.sin)`) is run by
`tests/rng.test.ts`'s `sinf` check and the numbers are recorded in `native/README.md` §3c.
"""

import math
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))


def b2d(h: str) -> float:
    return struct.unpack('>d', bytes.fromhex(h))[0]


def d2b(x: float) -> str:
    return struct.pack('>d', float(x)).hex()


def f32(x: float) -> float:
    """the float32 value nearest `x` (round-to-nearest, ties to even); +-inf outside the range"""
    try:
        return struct.unpack('>f', struct.pack('>f', x))[0]
    except OverflowError:
        return math.inf if x > 0 else -math.inf


def main() -> None:
    args: list[float] = []
    for line in open(os.path.join(HERE, 'libm_args_sin.txt')):
        p = line.split()
        if p:
            args.append(f32(b2d(p[1])))
    deg = math.pi / 180.0
    args += [f32(360.0 * i / 1000.0 * deg) for i in range(1000)]
    seen: list[float] = []
    for a in args:
        if a != a or math.isinf(a):
            continue
        if not any(a == b for b in seen):
            seen.append(a)
    for fn in ('sinf', 'cosf'):
        with open(os.path.join(HERE, f'libm_args_{fn}.txt'), 'w') as f:
            f.write('\n'.join(f'{fn} {d2b(a)}' for a in seen) + '\n')
    print(f'{len(seen)} distinct float32 arguments -> raw/libm_args_{{sinf,cosf}}.txt')


if __name__ == '__main__':
    main()
