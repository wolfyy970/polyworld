#!/usr/bin/env python3
"""Emit the `log2` corpus the port is verified against.

`complexity_algorithm.cc`'s `c_log` is `log2`, and every Integration value is a sum of
`log2`s, so the port carries a transcription of this machine's `log2` (`appleLog2Table.ts` +
`log2.ts`). This script writes the corpus that transcription is pinned against:

    raw/log2_args.txt     one input per line, as 16 hex digits of the double's bit pattern
    raw/log2_native.txt   the machine's own `log2()` for that input, same encoding

The second file is produced by `raw/log2probe.c` (compile and pipe the first into it), so no
value here is typed by hand:

    clang -O2 raw/log2probe.c -o /tmp/log2probe
    python3 raw/gen_log2_corpus.py
    /tmp/log2probe < raw/log2_args.txt > raw/log2_native.txt

The corpus is deliberately the *hard* set: every exponent, the model's own ranges (variances
around 1e-3..2, determinants down to 1e-200), the whole subnormal range, ±0/±1/±inf/NaN and the
ulp neighbours of the octave boundaries. Measured on the committed corpus: V8's `Math.log2`
differs from the machine's own `log2` on 68 of its 22,312 values, so `tests/complexity.test.ts`
also asserts that the corpus discriminates (an all-matching corpus would prove nothing).
"""

import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = HERE  # this script lives in native/raw/


def hexbits(x: float) -> str:
    return struct.pack('>d', x).hex()


def lcg(seed):
    state = seed

    def nxt():
        nonlocal state
        state = (state * 6364136223846793005 + 1442695040888963407) % (1 << 64)
        return ((state >> 11) & ((1 << 53) - 1)) / float(1 << 53)

    return nxt


def main() -> None:
    xs = []

    def push(x: float) -> None:
        if x == x:  # drop NaN duplicates; NaN is added explicitly below
            xs.append(x)

    # exact powers of two, their neighbours, and the octave midpoints
    for e in range(-1074, 1024, 1):
        try:
            p = math.ldexp(1.0, e)
        except OverflowError:
            continue
        push(p)
        push(math.nextafter(p, math.inf))
        push(math.nextafter(p, -math.inf))
        try:
            push(1.5 * p)
        except OverflowError:
            pass
    # the model's own ranges: variances of brain-function columns, determinants
    rnd = lcg(0x9E3779B97F4A7C15)
    for _ in range(1500):
        push(0.001 + rnd() * 2.0)
    for _ in range(1500):
        push(10.0 ** (-rnd() * 250.0))
    # the octave interiors: this is where the oracle's `log2` and a correctly rounded one part
    # ways, so the corpus needs density here rather than only at the octave boundaries
    for _ in range(4000):
        e = int(rnd() * 40) - 20
        push(math.ldexp(1.0 + rnd(), e))
    for _ in range(4000):
        e = int(rnd() * 8) - 4
        push(math.ldexp(1.0 + rnd(), e))
    # random doubles across the whole exponent range
    for _ in range(3000):
        e = int(rnd() * 2200) - 1100
        try:
            push(math.ldexp(1.0 + rnd(), e))
        except OverflowError:
            pass
    # specials
    for x in (0.0, -0.0, 1.0, -1.0, 2.0, 0.5, float('inf'), float('-inf'), float('nan'),
              5e-324, 1e-300, 1.0 - 2 ** -53, 2.0 - 2 ** -52):
        xs.append(x)

    args = os.path.join(RAW, 'log2_args.txt')
    with open(args, 'w') as f:
        for x in xs:
            f.write(hexbits(x) + '\n')
    print(f'wrote {args} ({len(xs)} values)')

    native = os.path.join(RAW, 'log2_native.txt')
    probe = os.path.join(RAW, 'log2probe')
    if not os.path.exists(probe):
        # Build it on demand: the probe binary is a build artifact and is not committed, so a
        # fresh checkout reaches `log2_native.txt` with one command (raw/log2probe.c is the
        # source, and the header documents the same one-liner by hand).
        import subprocess
        import shutil

        if shutil.which('clang') is None:
            print(f'clang not found: cannot build {probe} to refresh {native}', file=sys.stderr)
            return
        print(f'building {probe} (clang -O2 raw/log2probe.c -o raw/log2probe)')
        subprocess.run(['clang', '-O2', os.path.join(RAW, 'log2probe.c'), '-o', probe], check=True)

    import subprocess

    out = subprocess.run([probe], stdin=open(args), capture_output=True, text=True,
                         check=True).stdout
    with open(native, 'w') as f:
        f.write(out)
    print(f'wrote {native} ({len(out.splitlines())} values)')


if __name__ == '__main__':
    main()
