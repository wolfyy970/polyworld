#!/usr/bin/env python3
"""Build the W1e `atan2f` census corpus (argument bit patterns for the native probe).

    python3 gen_atan2f_corpus.py                    # -> raw/atan2f_args.txt (the committed corpus)
    python3 gen_atan2f_corpus.py --wide 400000 /tmp/atan2f_wide_args.txt

Lines are `<ybits> <xbits> <class>` in hex; `atan2fprobe.c` reads the first two tokens and the
class label is what `tools/measure_atan2f.ts` reports per-class counts with.

The classes are the argument pairs the model can reach — `frustumXZ::Inside` computes
`atan2f(x0 - p[0], z0 - p[2])` from two **world coordinates**, both floats, so the arguments are
differences of positions inside the world — plus the whole float range either side of that, so a
difference that only exists outside the reachable envelope still shows up as a *number* rather
than as an untested claim.  Sampling is deterministic (fixed seed) and bit-pattern based: no
value is ever produced by a decimal literal that cannot be a float32.
"""

from __future__ import annotations

import argparse
import math
import random
import struct
import sys

SEED = 0x4154414E  # "ATAN"


def f32(x: float) -> float:
    """Round a double to float32 (over/underflow goes to +-inf / +-0)."""
    try:
        return struct.unpack("<f", struct.pack("<f", x))[0]
    except OverflowError:
        return math.inf if x > 0 else -math.inf


def raw_bits(x: float) -> int:
    return struct.unpack("<I", struct.pack("<f", x))[0]


def from_bits(u: int) -> float:
    return struct.unpack("<f", struct.pack("<I", u & 0xFFFFFFFF))[0]


def nextafter32(x: float, toward: float) -> float:
    """math.nextafter in float32 (the generator's version of the C call)."""
    return f32(math.nextafter(x, toward))


MAXF = from_bits(0x7F7FFFFF)
TINY = from_bits(0x00000001)      # smallest subnormal
MIN_NORMAL = from_bits(0x00800000)


def uniform_bits(rng: random.Random, lo_exp: int, hi_exp: int) -> float:
    """A random float32 whose magnitude is uniform in exponent over [2**lo_exp, 2**hi_exp)."""
    e = rng.randint(lo_exp, hi_exp)
    m = rng.getrandbits(23)
    u = ((e + 127) << 23) | m
    if rng.getrandbits(1):
        u |= 0x80000000
    return from_bits(u)


def reachable_lattice(rng: random.Random, world: float, step: int) -> tuple[float, float]:
    """The model's own argument pair: `Inside` computes `atan2(x0 - p[0], z0 - p[2])`, i.e. the
    difference of two **x** coordinates as the sine argument and the difference of two **z**
    coordinates as the cosine argument. Positions are floats written by the worldfile / the walk,
    so the differences are float32 subtractions and two equal coordinates give an exact +-0."""
    ax = f32(round(rng.uniform(-world, world) * step) / step)
    bx = f32(round(rng.uniform(-world, world) * step) / step)
    az = f32(round(rng.uniform(-world, world) * step) / step)
    bz = f32(round(rng.uniform(-world, world) * step) / step)
    return f32(ax - bx), f32(az - bz)


def build(rng: random.Random, wide: int) -> list[tuple[str, float, float]]:
    rows: list[tuple[str, float, float]] = []

    def add(cls: str, y: float, x: float) -> None:
        rows.append((cls, y, x))

    # --- 1. the model's own lattice: differences of world coordinates (WorldSize 25) ---------
    nn = wide // 2 if wide else 2500
    for _ in range(nn):
        y, x = reachable_lattice(rng, 25.0, 64)
        add("reachable-lattice", y, x)
        y, x = reachable_lattice(rng, 25.0, 1)
        add("reachable-lattice", y, x)

    # --- 2. reachable-magnitude uniforms: any float32 in |v| < 256 --------------------------
    nn = wide // 4 if wide else 2000
    for _ in range(nn):
        add("reachable-uniform", uniform_bits(rng, -20, 8), uniform_bits(rng, -20, 8))

    # --- 3. the whole float range, both signs (unreachable magnitudes included on purpose) ---
    nn = wide // 4 if wide else 1500
    for _ in range(nn):
        add("all-magnitudes", uniform_bits(rng, -149, 127), uniform_bits(rng, -149, 127))

    # --- 4. exact powers of two, both operands (the binade lattice) --------------------------
    exps_y = list(range(-149, 128, 8)) + [-140, -130, -128, -127, -126, -100, -64, -32, -24,
                                         -16, -8, -1, 0, 1, 8, 16, 24, 32, 64, 100, 126, 127]
    exps_x = [-149, -126, -100, -64, -32, -16, -8, -4, -2, -1, 0, 1, 2, 4, 8, 16, 32, 64, 100, 127]
    for e in exps_y:
        for f in exps_x:
            y = f32(math.ldexp(1.0, e))
            x = f32(math.ldexp(1.0, f))
            if rng.getrandbits(1):
                y = -y
            if rng.getrandbits(1):
                x = -x
            add("binade-lattice", y, x)

    # --- 5. equal magnitudes (y = +-x, y = +-x*(1 +- ulp)): the octant boundaries ------------
    for k in range(-140, 120, 2):
        v = f32(math.ldexp(1.0, k))
        if not math.isfinite(v) or v == 0.0:
            continue
        for sgn in (1.0, -1.0):
            add("equal-magnitude", v, sgn * v)
            add("octant-neighbour", v, -sgn * v)
            add("octant-neighbour", v, -nextafter32(sgn * v, math.inf))
            add("octant-neighbour", v, -nextafter32(sgn * v, -math.inf))
    for _ in range(400):
        v = uniform_bits(rng, -120, 120)
        add("equal-magnitude", v, v)
        add("equal-magnitude", v, -v)
        add("octant-neighbour", v, nextafter32(v, math.inf))
        add("octant-neighbour", v, nextafter32(v, -math.inf))

    # --- 6. zeros: the exact +-pi / +-pi/2 and 0 / +-0 arms ---------------------------------
    for zy in (0.0, -0.0):
        for zx in (0.0, -0.0):
            add("zeros", zy, zx)
        for x in (1.0, -1.0, 0.5, -0.5, 2.0, -2.0, 1e-30, -1e-30, 1e30, -1e30,
                  MIN_NORMAL, -MIN_NORMAL, TINY, -TINY, MAXF, -MAXF):
            add("zeros", zy, x)
    for y in (1.0, -1.0, 0.5, -0.5, 2.0, -2.0, 1e-30, -1e-30, 1e30, -1e30,
              MIN_NORMAL, -MIN_NORMAL, TINY, -TINY, MAXF, -MAXF):
        for zx in (0.0, -0.0):
            add("zeros", y, zx)

    # --- 7. the +-pi boundary: tiny/zero y against a negative x -----------------------------
    # atan2's +-pi is the model's reachable boundary (x0 == p[0] exactly while the target is
    # behind), so this class is the one the port's PORT-NOTE(W1e/atan2f-pi) correction targets.
    for x in (-1.0, -0.5, -2.0, -3.0, -TINY, -MIN_NORMAL, -1e-30, -1e30, -MAXF, -0.9999999,
              -1.0000001, -1.5, -100.0, -0.01):
        for y in (0.0, -0.0, TINY, -TINY, f32(2 * TINY), -f32(2 * TINY), MIN_NORMAL,
                  -MIN_NORMAL, 1e-30, -1e-30, 1e-20, -1e-20, 1e-10, -1e-10, 1e-3, -1e-3,
                  0.5, -0.5, 1.0, -1.0, 1e30, -1e30, MAXF, -MAXF):
            add("pi-boundary", y, x)
    # the same from the other side: the argument pair that rounds *to* +-pi in float32
    for i in range(1, 400):
        y = f32(math.ldexp(i, -149))
        add("pi-boundary", y, -1.0)
        add("pi-boundary", -y, -1.0)
        add("pi-boundary", y, -1.0000001192092896)
        add("pi-boundary", -y, -1.0000001192092896)

    # --- 8. quadrant edges: x == +-0 and y == 0 across the whole range ----------------------
    for y in (TINY, f32(3 * TINY), MIN_NORMAL, f32(MIN_NORMAL * 3), 1e-10, 1e-3, 0.5, 1.0, 2.0,
              3.0, 100.0, 1e10, 1e30, MAXF):
        for x in (0.0, -0.0):
            add("quadrant-edge", y, x)
            add("quadrant-edge", -y, x)
    for x in (TINY, MIN_NORMAL, 1e-10, 1e-3, 0.5, 1.0, 2.0, 3.0, 100.0, 1e10, 1e30, MAXF):
        for zy in (0.0, -0.0):
            add("quadrant-edge", zy, x)
            add("quadrant-edge", zy, -x)

    # --- 9. denormals: both operands subnormal / at the subnormal boundary ------------------
    for _ in range(120 if not wide else wide // 20):
        y = from_bits(rng.randint(1, 0x007FFFFF) | (0x80000000 if rng.getrandbits(1) else 0))
        x = from_bits(rng.randint(1, 0x007FFFFF) | (0x80000000 if rng.getrandbits(1) else 0))
        add("denormals", y, x)
    for y in (TINY, -TINY, MIN_NORMAL, -MIN_NORMAL, f32(MIN_NORMAL / 2)):
        for x in (TINY, -TINY, MIN_NORMAL, -MIN_NORMAL, 1.0, -1.0, 0.0, -0.0,
                  f32(MIN_NORMAL * 2), -f32(MIN_NORMAL * 2)):
            add("denormals", y, x)

    # --- 10. dense grids straddling the rounding midpoints ----------------------------------
    # A dense sweep of y for a fixed x: the disagreements that are not the +-pi arm live where
    # the true angle sits next to a float32 midpoint, and only a dense local sweep finds them.
    grid_x = [1.0, -1.0, 0.5, -0.5, 2.0, -2.0, 3.0, -3.0, 0.1, -0.1, 1e-3, -1e-3, 1e3, -1e3,
              1e10, -1e10, 1e-30, -1e-30, TINY, -TINY, MIN_NORMAL, -MIN_NORMAL, 0.9999999404,
              -0.9999999404, 7.0, -7.0]
    span = 80 if not wide else 4000
    for x in grid_x:
        # around y = +-x (the octant boundary), around y = 0 (the +-pi / +-pi/2 arms), and
        # across a decade of y for a fixed x (the general midpoint population)
        for k in range(span):
            t = k / span
            add("midpoint-sweep", f32(x * (1.0 + 1e-7 * (2 * t - 1))), x)
            add("midpoint-sweep", f32(x * 1e-7 * (2 * t - 1)), x)
            add("midpoint-sweep", f32(x * 10.0 ** (2 * t - 1)), x)
            add("midpoint-sweep", f32(-x * 10.0 ** (2 * t - 1)), x)
            add("midpoint-sweep", f32(math.ldexp(1.0, -149) * (1 + k)), x)

    # --- 11. specials: inf / NaN operands ---------------------------------------------------
    specials = [math.inf, -math.inf, math.nan, -math.nan]
    for y in specials:
        for x in specials + [0.0, -0.0, 1.0, -1.0, TINY, MAXF, MIN_NORMAL]:
            add("specials", y, x)
    for x in specials:
        for y in specials + [0.0, -0.0, 1.0, -1.0, TINY, MAXF, MIN_NORMAL]:
            add("specials", y, x)

    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description="build the W1e atan2f census corpus")
    ap.add_argument("--wide", type=int, default=0, metavar="N",
                    help="emit an N-row wide sweep instead of the committed corpus (not committed)")
    ap.add_argument("out", nargs="?", help="output path (default: raw/atan2f_args.txt)")
    args = ap.parse_args()

    import os
    here = os.path.dirname(os.path.abspath(__file__))
    out = args.out or os.path.join(here, "atan2f_args.txt")

    rng = random.Random(SEED)
    rows = build(rng, args.wide)
    seen: set[tuple[int, int]] = set()
    kept: list[tuple[str, float, float]] = []
    for cls, y, x in rows:
        key = (raw_bits(y), raw_bits(x))
        if key in seen:
            continue
        seen.add(key)
        kept.append((cls, y, x))

    with open(out, "w") as fh:
        fh.write("# <ybits> <xbits> <class> -- the W1e atan2f census (gen_atan2f_corpus.py)\n")
        for cls, y, x in kept:
            fh.write("%08x %08x %s\n" % (raw_bits(y), raw_bits(x), cls))

    per: dict[str, int] = {}
    for cls, _, _ in kept:
        per[cls] = per.get(cls, 0) + 1
    print("%s: %d rows (%d dropped as duplicate bit patterns)" % (out, len(kept), len(rows) - len(kept)))
    for cls in sorted(per):
        print("  %-20s %6d" % (cls, per[cls]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
