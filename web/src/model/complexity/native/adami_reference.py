#!/usr/bin/env python3
"""Independent reference for native `complexity/adami.cc` -- lane L13.

`computeAdamiComplexity` is only reachable in the native tree from a booted
simulation (it reads `GenomeUtil::schema->getMutableSize()` and walks
`objectxsortedlist::gXSortedObjects`), so the lane cannot compile a probe that
drives the shipped symbol the way `complexityprobe.cc` drives
`CalcComplexity_brainfunction`. What the lane *can* do is reproduce the arithmetic
here, in another language, from the native source -- and pin the port against it.

This is that reference. It is deliberately not a transliteration of the port: the
float32 semantics come from numpy, `log2` from Python's `math` (a different libm
from the oracle's), and the four output files are assembled by a separate code
path. Where the port and this agree, the transcription's arithmetic is confirmed;
where the two disagree, one of them is wrong and the difference is real.

The algorithm (adami.cc:12-251): for each gene, the gene's byte is split into 8
bits per agent; then, for every 1-bit window, `1 - H(p)`; for every 2-bit window,
`2 - H(p)` over 4 outcomes; for every 4-bit window, `4 - H(p)` over 16 outcomes.
`0*log 0` is 0. Every symbol probability is a **float** (`float prob_1 = (float)
number_of_ones / (float) numagents`), `log2`'s double result is narrowed into a
float, and the three running sums are floats too -- the printed values are `%.4f`
of those floats, so each narrowing is load-bearing.

The input is a fixed synthetic agent set (`AGENTS_BY_GENE` below): 5 agents, 8
mutable genes, chosen so the three window widths produce several distinct
information values (constant, 1/5 and 2/5 symbol frequencies) instead of the
all-`1.0000` a freshly seeded population gives. The port's unit test uses the same
eight bytes, so the goldens in `../golden/adami/` pin the input as well.

Usage
    python3 adami_reference.py [outdir]      # default ../golden/adami

The output is four files, byte for byte what native's four `fprintf` sinks would
receive for one record: `1bit.txt`, `2bit.txt`, `4bit.txt`, `summary.txt`.
"""
import math
import os
import sys

import numpy as np
from numpy import float32 as f32

# The fixed synthetic input: AGENTS_BY_GENE[gene][agent] is the gene's raw byte
# (`Genes()->get_raw_uint( gene )`). 8 mutable genes, 5 agents.
AGENTS_BY_GENE = [
    [0x00, 0x7F, 0x80, 0xFF, 0x0F],
    [0x7F, 0x00, 0x02, 0x40, 0xA5],
    [0x80, 0x3C, 0x04, 0x20, 0x5A],
    [0xFF, 0xC3, 0x08, 0x10, 0x33],
    [0x0F, 0xF0, 0x10, 0x08, 0xAA],
    [0xA5, 0x5A, 0x20, 0x04, 0x55],
    [0x5A, 0xA5, 0x40, 0x02, 0x0F],
    [0x33, 0x0F, 0x80, 0x01, 0xF0],
]

TIMESTEP = 7


def bits_of(genevalue):
    """adami.cc:63-70 -- the eight `if( genevalue >= … )` tests, in order."""
    g = genevalue
    out = []
    for threshold in (128, 64, 32, 16, 8, 4, 2):
        if g >= threshold:
            out.append(1)
            g -= threshold
        else:
            out.append(0)
    out.append(1 if g == 1 else 0)
    return out


def windows(k):
    """The window layout: 8/k windows of k bits, bit-major."""
    out = []
    for i in range(8 // k):
        out.append(list(range(i * k, i * k + k)))
    return out


def record(k):
    """One record of the k-bit file (k in {1, 2, 4}) -> (text, three-sums entry)."""
    numagents = len(AGENTS_BY_GENE[0])
    outcomes = 1 << k
    cols = [[bits_of(gene[agent]) for agent in range(numagents)] for gene in AGENTS_BY_GENE]

    text = list()
    text.append("%% BitsInGenome: %d WindowSize: %d\n" % (len(AGENTS_BY_GENE) * 8, k))
    text.append("%d:" % TIMESTEP)
    total = f32(0.0)

    for column in cols:
        for window in windows(k):
            number_of = [0] * outcomes
            for agent in range(numagents):
                index = 0
                for bit in window:
                    index = (index << 1) | column[agent][bit]
                number_of[index] += 1

            # `float sum=0; sum += prob[j] * logprob[j];` -- one float accumulation
            # per outcome, in outcome order (adami.cc:139 / :232).
            s = f32(0.0)
            for j in range(outcomes):
                prob = f32(f32(number_of[j]) / f32(numagents))
                logprob = f32(0.0) if prob == 0.0 else f32(math.log2(float(prob)))
                s = f32(s + f32(prob * logprob))

            entropy = f32(s * f32(-1))
            # `informationOneBit[i] = 1.0 - entropyOneBit[i]` /
            # `informationTwoBit[i] = 2.0 - …` / `informationFourBit[i] = 4.0 - …`
            # -- the window width is log2(outcomes), i.e. the maximum entropy.
            information = f32(f32(float(k)) - entropy)
            total = f32(total + information)
            text.append(" {:.4f}".format(float(information)))

    text.append("\n")
    return "".join(text), total


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "golden", "adami"
    )
    os.makedirs(outdir, exist_ok=True)

    sums = {}
    for k in (1, 2, 4):
        text, total = record(k)
        sums[k] = total
        with open(os.path.join(outdir, "%dbit.txt" % k), "w") as f:
            f.write(text)

    summary = "%% Timestep 1bit 2bit 4bit\n%d %.4f %.4f %.4f\n" % (
        TIMESTEP,
        float(sums[1]),
        float(sums[2]),
        float(sums[4]),
    )
    with open(os.path.join(outdir, "summary.txt"), "w") as f:
        f.write(summary)

    print("wrote %s" % outdir)
    for name in ("1bit.txt", "2bit.txt", "4bit.txt", "summary.txt"):
        with open(os.path.join(outdir, name)) as f:
            print("-- %s\n%s" % (name, f.read()))


if __name__ == "__main__":
    main()
