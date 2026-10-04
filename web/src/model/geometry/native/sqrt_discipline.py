"""Scratch probe: the float `sqrt` discipline of the native agent geometry path.

`agent::SetGeometry` (agent.cc:999-1000) and `agent::setradius` (agent.cc:790) call `sqrt` on
`float` operands. Whether the oracle's build picks `sqrtf` (Apple's `<math.h>` C++ overload) or
the double `sqrt` moves the result by 1 ulp on ~10 % of the recorded agents.

Run: python3 src/model/geometry/native/sqrt_discipline.py
"""
import math
import re
import struct

GOLDEN = "src/model/geometry/golden/nativeBodyMesh.ts"


def f32(x: float) -> float:
    return struct.unpack(">f", struct.pack(">f", x))[0]


def bits(x: float) -> str:
    return "0x%08x" % struct.unpack(">I", struct.pack(">f", f32(x)))[0]


def fma(a: float, b: float, c: float) -> float:
    """`a * b + c` as one rounded float step (the contraction the oracle's -O2 build does)."""
    exact = float(a) * float(b) + float(c)
    return f32(exact)


def main() -> int:
    text = open(GOLDEN).read()
    rows = re.findall(r"\{ number: (\d+), size: ([\d.eE+-]+), maxSpeed: ([\d.eE+-]+),"
                      r" lengthX: ([\d.eE+-]+), lengthZ: ([\d.eE+-]+), lx: ([\d.eE+-]+),"
                      r" ly: ([\d.eE+-]+), lz: ([\d.eE+-]+), radius: ([\d.eE+-]+),"
                      r" carryRadius: ([\d.eE+-]+) \}", text)
    n = len(rows)
    print("bodies in the golden:", n)

    x_double = x_float = x_diff = 0
    z_double = z_float = z_diff = 0
    variants = {
        "two-step, double sqrt, halve after": 0,
        "two-step, float  sqrt, halve after": 0,
        "two-step, double sqrt * 0.5": 0,
        "two-step, float  sqrt * 0.5": 0,
        "fma sum,  double sqrt, halve after": 0,
        "fma sum,  float  sqrt, halve after": 0,
        "fma sum,  double sqrt * 0.5": 0,
        "fma sum,  float  sqrt * 0.5": 0,
    }
    carry_ok = 0
    for r in rows:
        size, ms = float(r[1]), float(r[2])
        lx_g, lz_g, radius_g, carry_g = float(r[5]), float(r[7]), float(r[8]), float(r[9])
        a = f32(size / math.sqrt(ms))
        b = f32(size / f32(math.sqrt(ms)))
        c = f32(size * math.sqrt(ms))
        d = f32(size * f32(math.sqrt(ms)))
        x_double += a == lx_g
        x_float += b == lx_g
        x_diff += a != b
        z_double += c == lz_g
        z_float += d == lz_g
        z_diff += c != d

        exact2 = f32(lx_g * lx_g) + f32(lz_g * lz_g)   # two rounded float products, added
        sum2 = f32(exact2)                              # ... then rounded to float
        fma2 = fma(lx_g, lx_g, lz_g * lz_g)             # contracted: one rounding
        cands = {
            "two-step, double sqrt, halve after": f32(math.sqrt(sum2) / 2),
            "two-step, float  sqrt, halve after": f32(f32(math.sqrt(sum2)) / 2),
            "two-step, double sqrt * 0.5": f32(math.sqrt(sum2) * 0.5),
            "two-step, float  sqrt * 0.5": f32(f32(math.sqrt(sum2)) * 0.5),
            "fma sum,  double sqrt, halve after": f32(math.sqrt(fma2) / 2),
            "fma sum,  float  sqrt, halve after": f32(f32(math.sqrt(fma2)) / 2),
            "fma sum,  double sqrt * 0.5": f32(math.sqrt(fma2) * 0.5),
            "fma sum,  float  sqrt * 0.5": f32(f32(math.sqrt(fma2)) * 0.5),
        }
        for name, v in cands.items():
            variants[name] += v == radius_g
        carry_ok += carry_g == radius_g

    print("fLengthX: double-sqrt matches %d/%d, float-sqrt matches %d/%d (differ on %d)"
          % (x_double, n, x_float, n, x_diff))
    print("fLengthZ: double-sqrt matches %d/%d, float-sqrt matches %d/%d (differ on %d)"
          % (z_double, n, z_float, n, z_diff))
    print("carryRadius == radius: %d/%d" % (carry_ok, n))
    for name, hits in variants.items():
        print("radius variant %-36s %d/%d" % (name, hits, n))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
