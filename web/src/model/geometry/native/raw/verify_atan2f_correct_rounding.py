#!/usr/bin/env python3
"""Which of the two is the wrong one? — high-precision check of the atan2f census rows.

    python3 verify_atan2f_correct_rounding.py [n] [native.txt] [args.txt]

Reads the census (`atan2f_native.txt`) and, for a sample of rows, computes `atan2` to 60 decimal
digits with the `decimal` module (exact inputs, `Decimal.sqrt` for the argument-halving identity)
and asks which of the two float32 candidates — the shipped `atan2f` (column 3) or
`f32(atan2(double, double))` (column 4) — the true value is nearer to, and by how much (in
float32 ulps).  A row is *decided* when the true value is more than 0.01 ulp away from the
midpoint between the two candidates: then the farther candidate is genuinely 1 ulp wrong rather
than a coin flip on a midpoint.

This is what turns "the two disagree" into "the shipped `atan2f` is the one that is a ulp low",
which is the fact a transcription has to reproduce.
"""

from __future__ import annotations

import os
import struct
import sys
from decimal import Decimal, getcontext

getcontext().prec = 60


def f32_from_bits(u: int) -> float:
    return struct.unpack("<f", struct.pack("<I", u & 0xFFFFFFFF))[0]


def f32_bits(x: float) -> int:
    return struct.unpack("<I", struct.pack("<f", x))[0]


def d_from_bits(u: int) -> Decimal:
    """The exact value of a float32 as a Decimal."""
    return Decimal(f32_from_bits(u))


def atan_series(z: Decimal) -> Decimal:
    """atan(z) for |z| <= 1/4 via its Taylor series (term-by-term until it stops moving)."""
    z2 = z * z
    term = z
    total = z
    k = 1
    while True:
        term = -term * z2
        add = term / (2 * k + 1)
        if add == 0:
            break
        total += add
        k += 1
    return total


def atan_hp(z: Decimal) -> Decimal:
    """atan(z) for z >= 0 by halving the argument until the series is fast:
    atan(z) = 2*atan(z / (1 + sqrt(1 + z^2)))."""
    halvings = 0
    while z > Decimal("0.25"):
        z = z / (1 + (1 + z * z).sqrt())
        halvings += 1
    return atan_series(z) * (2 ** halvings)


def atan2_hp(y: Decimal, x: Decimal) -> Decimal:
    """atan2 in the four quadrants, with the exact +-pi and +-pi/2 arms."""
    if y == 0:
        if x > 0:
            return Decimal(0)
        if x < 0:
            return Decimal("3.1415926535897932384626433832795028841971693993751058209749445923078164062862")
        return Decimal(0)
    if x == 0:
        half_pi = Decimal("1.5707963267948966192313216916397514420985846996875529104874722961539082031431")
        return half_pi if y > 0 else -half_pi
    if x > 0:
        a = atan_hp(abs(y) / x)
    else:
        pi = Decimal("3.1415926535897932384626433832795028841971693993751058209749445923078164062862")
        a = pi - atan_hp(abs(y) / abs(x))
    return a if y > 0 else -a


def ulp_between(a: float, b: float) -> int:
    ia = f32_bits(a)
    ib = f32_bits(b)
    order = lambda u: (0x80000000 - (u & 0x7FFFFFFF)) if u & 0x80000000 else u
    return abs(order(ia) - order(ib))


def distance_in_ulps(value: Decimal, lo: float, hi: float) -> Decimal:
    """Where `value` sits between the two float32 neighbours `lo` < `hi`, in ulps of `lo`."""
    step = Decimal(hi) - Decimal(lo)
    return (value - Decimal(lo)) / step


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    native_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, "atan2f_native.txt")

    rows = []
    with open(native_path) as fh:
        for line in fh:
            t = line.strip()
            if not t.startswith("atan2f"):
                continue
            f = t.split()
            rows.append((int(f[1], 16), int(f[2], 16), int(f[3], 16), int(f[4], 16)))

    differing = [r for r in rows if r[2] != r[3]]
    agreeing = [r for r in rows if r[2] == r[3]]
    # Deterministic sample: evenly spaced through both populations.
    def sample(pop, k):
        if not pop:
            return []
        step = max(1, len(pop) // k)
        return pop[::step][:k]

    for name, pop in (("differing", differing), ("agreeing", agreeing)):
        decided = 0
        native_is_far = 0   # the shipped atan2f is the 1-ulp-off one
        native_is_near = 0  # f32(atan2) is the 1-ulp-off one
        worst_agree = Decimal(0)
        over_half = 0
        margins = []
        for yb, xb, nat, cr in sample(pop, n):
            y = d_from_bits(yb)
            x = d_from_bits(xb)
            if not (abs(y) < Decimal("1e30") and abs(x) < Decimal("1e30")) or y == 0 or x == 0:
                continue  # inf/NaN/axis arms: no midpoint question
            true = atan2_hp(y, x)
            a = f32_from_bits(nat)
            b = f32_from_bits(cr)
            lo, hi = (a, b) if a < b else (b, a)
            if hi == lo:
                # the two candidates agree: is the agreed value the correctly rounded one?
                step = Decimal(f32_from_bits(nat + 1)) - Decimal(a) if a >= 0 else Decimal(a) - Decimal(f32_from_bits(nat - 1))
                err = abs(true - Decimal(a)) / abs(step)
                worst_agree = max(worst_agree, err)
                if err > Decimal("0.5"):
                    over_half += 1
                continue
            pos = distance_in_ulps(true, lo, hi)  # in (0,1) between them
            # How far the true value is from the midpoint, in ulps of lo.
            margin = abs(pos - Decimal("0.5"))
            margins.append(float(margin))
            if margin < Decimal("0.01"):
                continue  # too close to call: the two candidates are both defensible
            decided += 1
            near_is_hi = pos > Decimal("0.5")
            # which candidate is nearer
            near_is_atan2 = (hi == b) == near_is_hi
            if near_is_atan2:
                native_is_far += 1
            else:
                native_is_near += 1
        if not margins:
            print(
                f"{name}: no midpoint question in the sample | max error of the agreed value "
                f"against the true one: {worst_agree:.6f} ulp, rows above 0.5 ulp: {over_half} "
                f"(a shared 1-ulp error would be near 1.0)"
            )
            continue
        margins.sort()
        print(
            f"{name}: decided {decided} of {len(margins)} sampled (margin >= 0.01 ulp) | "
            f"true value nearer f32(atan2) {native_is_far}, "
            f"nearer shipped atan2f {native_is_near} | "
            f"median margin {margins[len(margins) // 2]:.3f} ulp, min {margins[0]:.4f}"
        )
    print(f"rows: {len(rows)} total, {len(differing)} differ between the two candidates, "
          f"{len(agreeing)} agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
