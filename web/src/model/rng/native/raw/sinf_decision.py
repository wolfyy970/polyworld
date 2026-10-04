#!/usr/bin/env python3
"""Settle L14's question with numbers: do the oracle's `sinf`/`cosf` need their own
transcription, or is `Math.fround(sin(x))` of the double transcription exactly the float
overload on the arguments the camera actually passes?

`CameraController.cc` computes `sin( camrad )` where `camrad` is a `float` (PARITY.md open
question 9), i.e. it calls the C++ `float` overload -> libm's `sinf`.  L14 currently computes
`Math.fround( Math.sin( x ) )` / the ported double `sin`.  The two can differ by a step when
the float32 arg sits close to a midpoint of the correctly rounded float result.

    clang -O2 raw/libm_census.c -o /tmp/libm_census
    python3 - <<'PY'   # build the float corpus from the double one (args cast to float)
    ...
    /tmp/libm_census < raw/libm_args_sinf.txt > raw/libm_native_sinf.txt
    python3 raw/sinf_decision.py

The decisive comparison is (b) below: how often the *double* transcription, rounded to float32,
disagrees with the shipped `sinf` on the same float32 argument.
"""

from __future__ import annotations

import math
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def b2d(h: str) -> float:
    return struct.unpack('>d', bytes.fromhex(h))[0]


def d2b(x: float) -> str:
    return struct.pack('>d', float(x)).hex()


def f2b(x: float) -> str:
    return struct.pack('>f', float(x)).hex()


def build_corpus() -> int:
    """the double corpus's arguments, cast to float32 (deduplicated, finite ones kept)"""
    seen = []
    for name in ('sin',):
        for line in open(os.path.join(HERE, f'libm_args_{name}.txt')):
            p = line.split()
            if not p:
                continue
            f = struct.unpack('>f', struct.pack('>f', b2d(p[1])))[0]      # the float32 arg
            if f != f:
                continue
            if not any(f == g for g in seen):
                seen.append(f)
    with open(os.path.join(HERE, 'libm_args_sinf.txt'), 'w') as fh:
        fh.write('\n'.join(f'sinf {d2b(f)}' for f in seen) + '\n')
    with open(os.path.join(HERE, 'libm_args_cosf.txt'), 'w') as fh:
        fh.write('\n'.join(f'cosf {d2b(f)}' for f in seen) + '\n')
    return len(seen)


def main() -> None:
    # node evaluates the ported double sin/cos (the same file the tests use)
    node = r'''
const fs = require('fs');
const lines = fs.readFileSync(0, 'utf8').split('\n').filter(l => l.length);
const b2d = h => Buffer.from(h, 'hex').readDoubleBE(0);
const d2b = d => { const b = Buffer.alloc(8); b.writeDoubleBE(d, 0); return b.toString('hex'); };
for (const line of lines) {
  const [fn, ha, hb] = line.split(' ');
  process.stdout.write(`${fn} ${ha} ${hb} ${d2b(Math.fround(Math[fn](b2d(ha))))}\n`);
}
'''
    for fn in ('sinf', 'cosf'):
        path = os.path.join(HERE, f'libm_native_{fn}.txt')
        if not os.path.exists(path):
            print(f'missing {path}', file=sys.stderr)
            continue
        lines = [l for l in open(path).read().split('\n') if l]
        # (a) the double Math.sin/cos rounded to float32, per V8
        p = subprocess.run(['node', '-e', node.replace("Math[fn]", "Math['sin']" if fn == 'sinf' else "Math['cos']")],
                           input='\n'.join(lines) + '\n', capture_output=True, text=True)
        if p.returncode != 0:
            raise RuntimeError(p.stderr)
        v8 = {tuple(l.split()[:2]): l.split()[3] for l in p.stdout.split('\n') if l}
        # (b) the ported *double* sin/cos (libm.ts), rounded to float32
        p2 = subprocess.run(['node', '-e', PORT_SNIPPET], input='\n'.join(lines) + '\n',
                            capture_output=True, text=True)
        if p2.returncode != 0:
            raise RuntimeError(p2.stderr)
        port = {tuple(l.split()[:2]): l.split()[3] for l in p2.stdout.split('\n') if l}
        n = len(lines)
        v8_bad = port_bad = 0
        examples = []
        for line in lines:
            f = line.split()
            key = tuple(f[:2])
            native = f[2]
            if v8.get(key) != native:
                v8_bad += 1
            if port.get(key) != native:
                port_bad += 1
                if len(examples) < 4:
                    examples.append((key, native, port.get(key)))
        print(f'{fn}: n={n}  Math.*+fround disagrees {v8_bad}  port+Math.fround disagrees {port_bad}')
        for e in examples:
            print('   ', e)


PORT_SNIPPET = r'''
const fs = require('fs');
const lines = fs.readFileSync(0, 'utf8').split('\n').filter(l => l.length);
const b2d = h => Buffer.from(h, 'hex').readDoubleBE(0);
const d2b = d => { const b = Buffer.alloc(8); b.writeDoubleBE(d, 0); return b.toString('hex'); };
const m = require('/tmp/libm_port.cjs');
for (const line of lines) {
  const [fn, ha, hb] = line.split(' ');
  const g = fn === 'sinf' ? m.sin : m.cos;
  process.stdout.write(`${fn} ${ha} ${hb} ${d2b(Math.fround(g(b2d(ha))))}\n`);
}
'''

if __name__ == '__main__':
    count = build_corpus()
    print(f'float corpus: {count} distinct float32 arguments')
    main()
