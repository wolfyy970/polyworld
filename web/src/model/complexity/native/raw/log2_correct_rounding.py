#!/usr/bin/env python3
"""Measure how far the oracle's `log2` is from a correctly rounded one.

`log2.ts` claims the transcription is unavoidable because this machine's `log2` is
**accurate but not correctly rounded**. That claim is a measurement, so it is re-runnable
here rather than asserted in a comment:

    python3 raw/log2_correct_rounding.py

It reads the *committed* corpus (`raw/log2_args.txt` plus the machine's own answers in
`raw/log2_native.txt`, both written by `raw/gen_log2_corpus.py`), computes the correctly
rounded `log2` of every value (`decimal` at 80 significant digits, then one correctly-rounded
conversion to `float`), and reports how many corpus values a correctly rounded `log2`
disagrees with the oracle on. A non-zero count is the proof that "just implement correct
rounding" is not an option for this lane.

No value here is typed by hand; the number the lane's documentation quotes comes from this
program's output.
"""

import json
import os
import struct
import sys
from decimal import Decimal, localcontext

HERE = os.path.dirname(os.path.abspath(__file__))


def from_hexbits(h: str) -> float:
    return struct.unpack('>d', bytes.fromhex(h))[0]


def bits(x: float) -> str:
    return struct.pack('>d', x).hex()


def read_lines(path: str) -> list:
    with open(path) as f:
        return [ln.strip() for ln in f if ln.strip()]


def log2_correctly_rounded(x: float, prec: int = 80) -> float:
    """`log2(x)` rounded to nearest (ties-to-even), via `decimal` at `prec` digits."""
    if x != x or x < 0.0:
        return float('nan')
    if x == 0.0:
        return float('-inf')
    if x == float('inf'):
        return float('inf')
    with localcontext() as ctx:
        ctx.prec = prec
        # Decimal(x) is exact for a finite double and Decimal.ln() is correctly rounded to the
        # context precision, so the quotient is good to ~prec digits *relative to its own
        # value* -- far below the 53 bits `float()` then rounds to.
        q = Decimal(x).ln() / Decimal(2).ln()
    return float(q)


def main() -> None:
    args_path = os.path.join(HERE, 'log2_args.txt')
    native_path = os.path.join(HERE, 'log2_native.txt')
    if not (os.path.exists(args_path) and os.path.exists(native_path)):
        print(f'corpus missing: run {os.path.join(HERE, "gen_log2_corpus.py")} first',
              file=sys.stderr)
        raise SystemExit(1)

    args = [from_hexbits(h) for h in read_lines(args_path)]
    native = read_lines(native_path)
    if len(args) != len(native):
        raise SystemExit(f'corpus mismatch: {len(args)} args vs {len(native)} native values')

    differing = 0
    examples = []
    for i, x in enumerate(args):
        want = native[i]
        got = bits(log2_correctly_rounded(x))
        if got != want:
            differing += 1
            if len(examples) < 10:
                examples.append({'x': bits(x), 'native': want, 'correctly_rounded': got})

    print(json.dumps({
        'corpus': len(args),
        'correctly_rounded_differs_from_native': differing,
        'examples': examples,
    }, indent=2))


if __name__ == '__main__':
    main()
