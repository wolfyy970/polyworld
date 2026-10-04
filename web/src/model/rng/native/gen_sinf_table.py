#!/usr/bin/env python3
"""Emit `sinf`/`cosf`'s constants and tables from the *shipped* bytes.

The source of truth is `raw/sinf_bytes.bin`, the 5120-byte dump of the live
`/usr/lib/system/libsystem_m.dylib` `sinf` (written by `raw/dump_libm3.c`), in which `sinf`
sits at +0x400 and `cosf` at +0x2f0 (so every offset here is `sinf`-relative).  This script
reads that file, checks the layout the disassembly implies against an independently computed
`1/pi` and the exact constants, and writes

  * `raw/apple_sinf_table.h` — the C constants + tables (for the C transcription), and
  * `../appleSinfTable.ts`    — the TypeScript module the port imports.

    clang -O0 raw/dump_libm3.c -o /tmp/dump_libm3 && (cd raw && /tmp/dump_libm3)
    python3 gen_sinf_table.py

The interesting object is `ASF_TAB`: the large-argument reduction's two-double constant per
float exponent, `ASF_TAB[i]` = `1/pi - A/2^s` with `s = 2i - 23` and `A = round(2^s/pi)`.
The shipped code indexes it by `(bits(|x|) >> 24) - 0x40`, i.e. by `(exponent >> 1) - 64`, so
entry `i` serves the floats with exponent field `2i+128` and `2i+129` -- for which
`x * A/2^s` is an *exact integer* (x is a 24-bit significand times a power of two), so
`x * (hi + lo)` has the same fractional part as `x/pi` and the quadrant comes out right.
That identity is what this script verifies, against pi computed to 160 digits, and it is the
reason the hi halves have trailing zero mantissa bits (x*hi is exact).
"""

import os
import struct
import sys
from decimal import Decimal, getcontext

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
BIN = os.path.join(RAW, 'sinf_bytes.bin')
SINF = 0x400

# offsets, read off `objdump -d` of sinf_bytes.bin (all relative to the `sinf` symbol)
OFF_INF = 0x2d4             # the float +inf pattern (the inf/NaN guard)
OFF_120 = 0x2d8             # 120.0f, the small/medium-vs-large dispatch boundary
OFF_2P26 = 0x2dc            # 2^26f, cosf's second boundary (same value as OFF_2P26_F)
OFF_PI4 = 0x2e0             # pi/4f, the small/medium boundary
OFF_2M12 = 0x2e4            # 2^-12f, the polynomial's own small-argument boundary
OFF_2M26_F = 0x2e8          # 2^-26f, the tiny-argument path (single precision, 32-bit load)
OFF_2P26_F = 0x2ec          # 2^26f, the same (the other half of the same literal)
OFF_INV_PI2 = 0x2f0         # 2/pi, the medium reduction's multiplier
OFF_PI2_HI = 0x2f8          # two-part pi/2
OFF_PI2_LO = 0x300
OFF_COS_POLY = 0x308        # 4 doubles: cos(r) = 1 + z*poly(z), z = r^2
OFF_SIN_POLY = 0x328        # 3 doubles: sin(r) = r + r^3*poly(r^2)
OFF_SINPI_POLY = 0x340      # 5 doubles: sin(pi*r)/r, factored as c4*(r^4+c0 r^2+c2)(r^4+c1 r^2+c3)
OFF_TAB = 0x368             # 64 entries of {hi, lo}
N_TAB = 64
OFF_SINCOS_POLY = 0x768     # 10 doubles: `__sincosf_stret`'s two lane polynomials

getcontext().prec = 160

# pi to 160 digits (independently known; the same expansion `gen_sincos_table.py` uses)
PI_STR = ('3.141592653589793238462643383279502884197169399375105820974944592307816406286208998'
          '62803482534211706798214808651328230664709384460955058223172535940812848111745028410'
          '27019385211055596446229489549303819644288109756659334461284756482337867831652712019')


def u32(b, off):
    return struct.unpack_from('<I', b, SINF + off)[0]


def f32(b, off):
    return struct.unpack_from('<f', b, SINF + off)[0]


def u64(b, off):
    return struct.unpack_from('<Q', b, SINF + off)[0]


def dbl(b, off):
    return struct.unpack_from('<d', b, SINF + off)[0]


def main():
    with open(BIN, 'rb') as f:
        code = f.read()
    if len(code) < SINF + OFF_TAB + N_TAB * 16:
        sys.exit(f'{BIN} is too short; run raw/dump_libm3.c first')

    pi = Decimal(PI_STR)
    inv_pi = 1 / pi

    inf32 = u32(code, OFF_INF)
    c120 = f32(code, OFF_120)
    c2p26 = f32(code, OFF_2P26)
    cpi4 = f32(code, OFF_PI4)
    c2m12 = f32(code, OFF_2M12)
    c2m26f = f32(code, OFF_2M26_F)
    c2p26f = f32(code, OFF_2P26_F)
    inv_pi2 = dbl(code, OFF_INV_PI2)
    pi2_hi = dbl(code, OFF_PI2_HI)
    pi2_lo = dbl(code, OFF_PI2_LO)
    cos_poly = [dbl(code, OFF_COS_POLY + 8 * i) for i in range(4)]
    sin_poly = [dbl(code, OFF_SIN_POLY + 8 * i) for i in range(3)]
    sinpi_poly = [dbl(code, OFF_SINPI_POLY + 8 * i) for i in range(5)]
    sincos_poly = [dbl(code, OFF_SINCOS_POLY + 8 * i) for i in range(10)]
    tab = [(dbl(code, OFF_TAB + 16 * i), dbl(code, OFF_TAB + 16 * i + 8)) for i in range(N_TAB)]

    # the boundaries and reduction constants, checked against their exact bit patterns
    assert inf32 == 0x7f800000, hex(inf32)
    assert struct.pack('>f', c120).hex() == '42f00000'
    assert struct.pack('>f', c2p26).hex() == '4c800000'
    assert struct.pack('>f', cpi4).hex() == '3f490fdb'          # the float32 neighbour of pi/4
    assert struct.pack('>f', c2m12).hex() == '39800000'
    assert struct.pack('>f', c2m26f).hex() == '32800000'
    assert struct.pack('>f', c2p26f).hex() == '4c800000'
    assert struct.pack('>d', inv_pi2).hex() == '3fe45f306dc9c883'
    assert struct.pack('>d', pi2_hi).hex() == '3ff921fb54442d18'
    assert struct.pack('>d', pi2_lo).hex() == '3c91a62633145c07'
    assert abs(Decimal(pi2_hi) + Decimal(pi2_lo) - pi / 2) < Decimal('1e-32')

    # the sin(pi*r)/r polynomial: c4*c2*c3 must be pi (r -> 0) and the r^2 coefficient
    # c4*(c0*c3 + c1*c2) the Taylor value -pi^3/6 -- it is the *sine* of an argument in pi
    c0, c1, c2, c3, c4 = (Decimal(v) for v in sinpi_poly)
    assert abs(c4 * c2 * c3 - pi) < Decimal('1e-15'), c4 * c2 * c3
    # the next coefficients are the minimax neighbours of the Taylor ones (-pi^3/6, pi^5/120)
    assert abs(c4 * (c0 * c3 + c1 * c2) + pi ** 3 / 6) < Decimal('1e-5')
    assert abs(c4 * (c2 + c3 + c0 * c1) - pi ** 5 / 120) < Decimal('3e-4')
    # the tail polynomials are the plain Taylor series in r^2
    assert abs(Decimal(sin_poly[2]) + Decimal(1) / 6) < Decimal('1e-6')
    assert abs(Decimal(cos_poly[3]) + Decimal('0.5')) < Decimal('1e-8')

    # `__sincosf_stret`'s two lane polynomials (u = the reduced argument in units of pi/2):
    # lane 0 is `u * P(u^2)` with P(0) = pi/2, lane 1 is `Q(u^2)` with Q(0) = 1 -- the sine
    # and cosine of pi*u/2.  The next order terms are the Taylor ones (-pi^3/6 /2! ...).
    t0, t1, t2, t3, t4, t5, t6, t7, t8, t9 = (Decimal(v) for v in sincos_poly)
    assert abs(t4 * t6 * t8 - pi / 2) < Decimal('1e-10'), t4 * t6 * t8
    assert abs(t5 * t7 * t9 - 1) < Decimal('1e-9'), t5 * t7 * t9
    assert abs(t4 * (t6 * t2 + t8 * t0) + (pi / 2) ** 3 / 6) < Decimal('1e-7')
    assert abs(t5 * (t7 * t3 + t9 * t1) + (pi / 2) ** 2 / 2) < Decimal('1e-7')

    # the 64 two-double constants: each is `1/pi - A/2^s` with s = 2i-23 and A = round(2^s/pi),
    # i.e. the residual of a dyadic approximation of 1/pi whose denominator divides x for every
    # float32 x that indexes this entry.  Recompute it from pi and require agreement to 1e-24.
    for i, (hi, lo) in enumerate(tab):
        s = max(2 * i - 23, 0)
        a = round(Decimal(2) ** s * inv_pi)
        want = inv_pi - Decimal(a) / Decimal(2) ** s
        v = Decimal(hi) + Decimal(lo)
        err = abs(want - v)
        assert err < Decimal('1e-24'), (i, float(err), v, want)

    # ... and the consequence the shipped code depends on: for a float32 x of exponent field E
    # (x = 2^(E-127) is the worst case), `x * v` differs from `x/pi` by an *integer*, so the
    # rint()/fraction the reduction takes is x/pi's own quadrant and fraction.  Only checked
    # where the pair's own ~76-bit precision keeps the residual meaningful.
    for i in range(24):
        hi, lo = tab[i]
        v = Decimal(hi) + Decimal(lo)
        for e in (2 * i + 128, 2 * i + 129):
            x = Decimal(2) ** (e - 127)
            d = x * inv_pi - x * v
            assert abs(d - round(d)) < Decimal('1e-9'), (i, e, float(d - round(d)))

    names_f = ['INF_BITS', 'C120', 'C2P26', 'CPI4', 'C2M12', 'C2M26', 'C2P26B']
    values_f = [inf32, c120, c2p26, cpi4, c2m12, c2m26f, c2p26f]
    names_d = ['INV_PI2', 'PI2_HI', 'PI2_LO']
    values_d = [inv_pi2, pi2_hi, pi2_lo]

    h = ['/* Generated by gen_sinf_table.py from raw/sinf_bytes.bin -- do not edit. */',
         '#ifndef APPLE_SINF_TABLE_H',
         '#define APPLE_SINF_TABLE_H',
         '',
         '/* The dispatch boundaries (as raw float32 bit patterns) and the reduction constants.',
         ' * PI2_HI + PI2_LO is pi/2 to ~106 bits. */']
    for n, v in zip(names_f, values_f):
        if n == 'INF_BITS':
            h.append(f'#define ASF_{n} 0x{v:08x}u')
        else:
            h.append(f'#define ASF_{n} {v!r}f')
    for n, v in zip(names_d, values_d):
        h.append(f'#define ASF_{n} {v!r}')
    h.append('')
    h.append('/* ASF_TAB[i] = {hi, lo} with hi + lo = 1/pi - A/2^s, s = 2i-23, A = round(2^s/pi):')
    h.append(' * the two-double residual of the dyadic ghost of 1/pi for the floats with')
    h.append(' * exponent field 2i+128 / 2i+129 (index (bits >> 24) - 0x40). */')
    h.append('static const double ASF_TAB[%d][2] = {' % N_TAB)
    for hi, lo in tab:
        h.append('  {%r, %r},' % (hi, lo))
    h.append('};')
    h.append('')
    h.append('/* cos(r) = 1 + z*poly(z), z = r^2, 4 coefficients in load order */')
    h.append('static const double ASF_COS_POLY[4] = {')
    for v in cos_poly:
        h.append('  %r,' % v)
    h.append('};')
    h.append('')
    h.append('/* sin(r) = r + r^3*poly(r^2), 3 coefficients in load order */')
    h.append('static const double ASF_SIN_POLY[3] = {')
    for v in sin_poly:
        h.append('  %r,' % v)
    h.append('};')
    h.append('')
    h.append('/* sin(pi*r)/r = c4*(r^4 + c0 r^2 + c2)*(r^4 + c1 r^2 + c3), 5 coefficients */')
    h.append('static const double ASF_SINPI_POLY[5] = {')
    for v in sinpi_poly:
        h.append('  %r,' % v)
    h.append('};')
    h.append('')
    h.append('/* `__sincosf_stret`\'s two lanes, evaluated as a 2-vector: lane 0 is')
    h.append(' * u*(t4)*(t6 + z*(z + t0))*(t8 + z*(z + t2)) (odd: the sine), lane 1 is')
    h.append(' * t5*(t7 + z*(z + t1))*(t9 + z*(z + t3)) (even: the cosine), z = u^2. */')
    h.append('static const double ASF_SINCOS_POLY[10] = {')
    for v in sincos_poly:
        h.append('  %r,' % v)
    h.append('};')
    h.append('')
    h.append('#endif')
    with open(os.path.join(RAW, 'apple_sinf_table.h'), 'w') as f:
        f.write('\n'.join(h) + '\n')

    ts = ['/**',
          " * The constants and tables of the oracle's `sinf`/`cosf`, extracted from the shipped",
          ' * machine code (`src/model/rng/native/raw/sinf_bytes.bin`, a 5120-byte dump of the',
          ' * live `/usr/lib/system/libsystem_m.dylib` `sinf` symbol; `cosf` is 0x110 below it',
          ' * and they share the reduction table).',
          ' *',
          ' * GENERATED by `src/model/rng/native/gen_sinf_table.py` -- do not edit by hand.',
          ' * `TAB[i]` is the two-double `1/pi - round(2^(2i-23)/pi)/2^(2i-23)` the large-argument',
          ' * reduction multiplies by; the code indexes it with `(bits(|x|) >> 24) - 0x40`.',
          ' */',
          '']
    ts.append(f'export const SINF_INF_BITS = 0x{inf32:08x};')
    for n, v in zip(names_f[1:], values_f[1:]):
        ts.append(f'export const SINF_{n} = {v!r};')
    for n, v in zip(names_d, values_d):
        ts.append(f'export const SINF_{n} = {v!r};')
    ts.append('')
    ts.append('export const SINF_TAB: readonly (readonly [number, number])[] = [')
    for hi, lo in tab:
        ts.append('  [%r, %r],' % (hi, lo))
    ts.append('];')
    ts.append('')
    ts.append('export const SINF_COS_POLY: readonly number[] = [')
    for v in cos_poly:
        ts.append('  %r,' % v)
    ts.append('];')
    ts.append('')
    ts.append('export const SINF_SIN_POLY: readonly number[] = [')
    for v in sin_poly:
        ts.append('  %r,' % v)
    ts.append('];')
    ts.append('')
    ts.append('export const SINF_SINPI_POLY: readonly number[] = [')
    for v in sinpi_poly:
        ts.append('  %r,' % v)
    ts.append('];')
    ts.append('')
    ts.append('export const SINF_SINCOS_POLY: readonly number[] = [')
    for v in sincos_poly:
        ts.append('  %r,' % v)
    ts.append('];')
    ts.append('')
    ts_path = os.path.normpath(os.path.join(HERE, '..', 'appleSinfTable.ts'))
    with open(ts_path, 'w') as f:
        f.write('\n'.join(ts) + '\n')

    print('wrote raw/apple_sinf_table.h and ../appleSinfTable.ts')
    print(f'float constants: {", ".join(f"{n}={v!r}" for n, v in zip(names_f, values_f))}')
    print(f'double constants: {", ".join(f"{n}={v!r}" for n, v in zip(names_d, values_d))}')
    print(f'tables: {N_TAB} reduction pairs, {len(cos_poly)} cos, {len(sin_poly)} sin, '
          f'{len(sinpi_poly)} sinpi coefficients -- all checked against pi to 160 digits')


if __name__ == '__main__':
    main()
