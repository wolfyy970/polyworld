#!/usr/bin/env python3
"""Emit arm64 `atan2f`'s nine polynomial constants and eight angle constants from the *shipped*
bytes.

The source of truth is `raw/atan2f_bytes.bin`, the 768-byte window dumped from the live
`/usr/lib/system/libsystem_m.dylib` by `raw/dump_libm5.c`, in which `atan2f` sits at +0x40 — so
every offset below is `atan2f`-relative *plus* that file offset.  The script reads that window,
**checks the layout against the code that reads it**, and writes

  * `raw/apple_atan2f_table.h` — the C constants (for the C transcription), and
  * `../appleAtan2fTable.ts`    — the TypeScript module the port imports.

    clang -O0 raw/dump_libm5.c -o /tmp/dump_libm5 && (cd raw && /tmp/dump_libm5)
    python3 gen_atan2f_table.py

What the shipped code does with them (see `raw/apple_atan2f_impl.h` for the transcription):

  * the **ratio polynomial** is nine `double`s at `+0x220`.  It is *not* a Horner chain: it is a
    product of four quadratics in `u = r*r` times `T8` (evaluated with `fadd.2d`/`fmla.2d` so
    that the four factors are built two at a time, and with the last multiplies paired
    `(F0*F2)*T8` and `(F1*F3)*r`), i.e.
    `atan(r) ~ T8 * (u^2+T0 u+T2) * (u^2+T4 u+T6) * (u^2+T1 u+T3) * (u^2+T5 u+T7) * r`.
    Each `fmla` fuses (`T2 + (u+T0)*u`), so the order of the multiplies is load-bearing; the
    generator checks the fit is normalised (`T2*T3*T6*T7*T8 == 1` to 1 double ulp) and *measures*
    its accuracy: **0.36 float32 ulp** worst case over [-1,1] — which is exactly why arm64's
    `atan2f` is a >0.5 ulp implementation and cannot be `f32(atan2)`.  The coefficients are a
    *fit* of that product form (they are not the Taylor coefficients: the `u^1` coefficient is
    `-0.333331738`, off by 4.8e-6 relative, and `u^8` is `0.0029` against `1/17`).
  * the **small-argument threshold** is `2^-22` at `+0x268`, compared against `|y/x|` with
    `fcmp d1, d3` / `b.mi`; below it the `x < 0` arm answers the constant at `+0x290` instead of
    `pi + atan`.
  * the eight **angle constants** are `+-pi` (`+0x270`, a two-entry table indexed by the sign of
    `y`: `ldr d2, [x1, w0, uxtw #3]`), `+-pi/2` (`+0x280`/`+0x288`), `+-3pi/4` (`+0x298`/`+0x2a0`)
    and `+-pi/4` (`+0x2a8`/`+0x2b0`).  Each is checked against an independently computed
    `math.pi` expression, bit for bit.
  * the constant at `+0x290` is **not** `pi` and not `(double)(float)pi`: it is
    `0x1.921fb4008p+1`, i.e. `float32(pi)` rounded *toward zero* (`0x1.921fb4p+1`, the same low
    pi Swift ships as `Float.pi`) plus exactly `2**-32`.  It is the value the exact `+-pi` arm
    returns, and it is the reason arm64's `atan2f(0, -1)` is `0x40490fda` while the correctly
    rounded `f32(atan2)` is `0x40490fdb` — the census' measured +-pi behaviour.  The checks below
    pin both properties with exact rational arithmetic.

Nothing here is typed by hand: every constant is read from the dump at the offset an instruction
in the same dump points at, and the *displacements* are decoded from those instruction words
(`adr`/`adrp`+`add`/`ldr <label>`) rather than copied from a listing.
"""

import os
import struct
import sys
from decimal import Decimal, getcontext, localcontext
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
BIN = os.path.join(RAW, 'atan2f_bytes.bin')
IDENT = os.path.join(RAW, 'atan2f_bytes.identity.txt')

ATAN2F = 0x40               # file offset 0 of the dump == atan2f-0x40, so the symbol is here
CODE_END = 0x214            # the last instruction before the constants
IDENTITY_HASH = '7beb2da6bc6b17d4'   # fnv1a256 of atan2f's first 256 bytes (the census' pin)

# offsets, decoded from the instruction displacements in this dump (all atan2f-relative)
OFF_POLY = 0x220            # the nine-double ratio polynomial (four `adr x2, #492`)
OFF_SMALL = 0x268           # 2^-22: the `|y/x|` threshold (`ldr d3, <label>` @0x1a0)
OFF_ANGLE = 0x270           # [+pi, -pi]: the sign-indexed table (`adrp`+`add` @0x16c/@0x170)
OFF_HPI = 0x280             # +pi/2   (@0x17c)
OFF_NEG_HPI = 0x288         # -pi/2   (@0x108)
OFF_PI_HI = 0x290           # the small-|r| arm's pi (@0x238 and @0x1f8's fall-through)
OFF_3PI4 = 0x298            # +3pi/4  (@0x204)
OFF_NEG_3PI4 = 0x2a0        # -3pi/4  (@0x214)
OFF_PI4 = 0x2a8             # +pi/4   (@0x220)
OFF_NEG_PI4 = 0x2b0         # -pi/4   (@0x114)
N_POLY = 9
N_ANGLE = 9   # +pi, -pi, +pi/2, -pi/2, the small-arm pi, +3pi/4, -3pi/4, +pi/4, -pi/4

# the `ldr dN, <label>` sites the layout check expects: instruction -> target
LDR_SITES = {
    0x0c8: OFF_NEG_HPI,     # 0x108: the `-pi/2 - P(x/y)` arm
    0x0d4: OFF_NEG_PI4,     # 0x114: the exact `y == -x` arm
    0x13c: OFF_HPI,         # 0x17c: the `pi/2 - P(x/y)` arm
    0x160: OFF_SMALL,       # 0x1a0: the |y/x| threshold
    0x1c4: OFF_3PI4,        # 0x204: the exact `y == -x` arm of the `x <= 0` ladder
    0x1d4: OFF_NEG_3PI4,    # 0x214: the exact `y == x < 0` arm
    0x1e0: OFF_PI4,         # 0x220: the exact `y == x > 0` arm
    0x1f8: OFF_PI_HI,       # 0x238: the small-|y/x| arm
}
ADR_SITES = [0x034, 0x090, 0x104, 0x180]   # the four `adr x2, <the polynomial>` blocks
ADRP_SITE = 0x16c            # `adrp x1, #0` ... and the `add x1, x1, #0x990` that follows

getcontext().prec = 60


def f64(b, off):
    """`off` is a file offset into the dump (the symbol sits at file offset 0x40)."""
    return struct.unpack_from('<d', b, off)[0]


def u32(b, off):
    return struct.unpack_from('<I', b, off)[0]


def bits_of(x):
    return struct.unpack('<Q', struct.pack('<d', float(x)))[0]


def f32_bits_of(x):
    return struct.unpack('<I', struct.pack('<f', float(x)))[0]


def sign_extend(v, bits):
    m = 1 << (bits - 1)
    return (v & (m - 1)) - (v & m)


def decode_adr(word):
    """`ADR Xd, label` -> (Rd, byte immediate, relative to the instruction)."""
    assert (word >> 24) == 0x10, hex(word)
    immlo = (word >> 29) & 0x3
    immhi = (word >> 5) & 0x7ffff
    return word & 0x1f, sign_extend((immhi << 2) | immlo, 21)


def decode_adrp(word):
    """`ADRP Xd, label` -> (Rd, page immediate, a multiple of 2^12)."""
    assert (word >> 24) == 0x90, hex(word)
    immlo = (word >> 29) & 0x3
    immhi = (word >> 5) & 0x7ffff
    return word & 0x1f, sign_extend((immhi << 2) | immlo, 21) << 12


def decode_add_imm(word):
    """`ADD Xd, Xn, #imm` (64-bit, shift 0) -> (Xn, imm)."""
    assert (word >> 23) == 0x122, hex(word)          # 0x91_0_00000
    return (word >> 5) & 0x1f, (word >> 10) & 0xfff


def decode_ldr_literal(word):
    """`LDR Dt, label` -> (Rt, byte immediate, relative to the instruction)."""
    assert (word >> 24) == 0x5c, hex(word)
    return word & 0x1f, sign_extend((word >> 5) & 0x7ffff, 19) << 2


def check_layout(code):
    """Decode the code's own displacements and require them to point at the offsets above."""
    ident = {}
    page_off = None
    for line in open(IDENT):
        f = line.split()
        if not f or f[0] == 'image':
            continue
        name = f[0]
        if 'fnv1a256' in f:
            ident[name] = f[f.index('fnv1a256') + 1]
        if 'page_offset' in f:
            page_off = int(f[f.index('page_offset') + 1], 16)
    if page_off is None:
        sys.exit(f'{IDENT}: no page_offset line; re-run raw/dump_libm5.c')

    # the census' own pin: this dump is the library the corpus was measured against
    if ident.get('atan2f') != IDENTITY_HASH:
        sys.exit(f'{IDENT}: atan2f fnv1a256 is {ident.get("atan2f")}, expected {IDENTITY_HASH}')

    # `adr x2, #492` in all four polynomial blocks: same table, and it is +0x220
    for site in ADR_SITES:
        rd, imm = decode_adr(u32(code, ATAN2F + site))
        if rd != 2 or site + imm != OFF_POLY:
            sys.exit(f'gen_atan2f_table: adr at +0x{site:x} -> x{rd}+{imm}, expected x2+{OFF_POLY - site}')

    # the sign-indexed +-pi table: `adrp x1, #0` + `add x1, x1, #0x990` resolves to it
    rd, page = decode_adrp(u32(code, ATAN2F + ADRP_SITE))
    if rd != 1 or page != 0:
        sys.exit(f'gen_atan2f_table: adrp at +0x{ADRP_SITE:x} -> x{rd} page {page}')
    rn, add = decode_add_imm(u32(code, ATAN2F + ADRP_SITE + 4))
    if rn != 1:
        sys.exit(f'gen_atan2f_table: add at +0x{ADRP_SITE + 4:x} uses x{rn}, expected x1')
    target = (page + add - page_off) & 0xfffff   # x1 is `(page containing the code) + add`
    if target != OFF_ANGLE:
        sys.exit(f'gen_atan2f_table: adrp+add resolves to +0x{target:x}, expected +0x{OFF_ANGLE:x}')

    # every `ldr dN, <label>` literal: `(instruction + imm)` must be the documented constant
    for site, off in LDR_SITES.items():
        rt, imm = decode_ldr_literal(u32(code, ATAN2F + site))
        if site + imm != off:
            sys.exit(f'gen_atan2f_table: ldr d{rt} at +0x{site:x} -> +0x{site + imm:x}, expected +0x{off:x}')
    return page_off


def check_polynomial(poly):
    """The four quadratics in `u`, times `T8`, are a *normalised* fit of atan(r)/r."""
    T = poly
    # (a) the u^0 coefficient is 1: T2*T3*T6*T7*T8, within one double ulp of 1
    lead = T[2] * T[3] * T[6] * T[7] * T[8]
    if abs(lead - 1.0) > 5e-16:
        sys.exit(f'gen_atan2f_table: leading coefficient {lead!r} is not 1')
    # (b) measure the fit's own error (exact double arithmetic, no fused steps -- the point is
    #     the *coefficients*; the fused evaluation is checked against the shipped code instead)
    import math

    def P(r):
        u = r * r
        return (T[8] * (u * u + T[0] * u + T[2]) * (u * u + T[4] * u + T[6])
                * (u * u + T[1] * u + T[3]) * (u * u + T[5] * u + T[7])) * r

    worst = 0.0
    worst_at = 0.0
    for i in range(200001):
        r = -1.0 + 2.0 * i / 200000.0
        if r == 0.0:
            continue
        rel = abs(P(r) - math.atan(r)) / abs(math.atan(r))
        if rel > worst:
            worst, worst_at = rel, r
    # the implementation is *float* accurate (0.3-0.5 float32 ulp) -- not a correctly rounded
    # double approximation, and not the truncated Taylor series either (see the docstring)
    if not (1e-9 < worst < 1e-6):
        sys.exit(f'gen_atan2f_table: fit error {worst!r} is not float-scale')
    return worst, worst_at


def f32_toward_zero(x):
    """The float32 in `x`'s binade, rounded *toward zero*, as a double."""
    import math
    with localcontext() as ctx:
        ctx.prec = 60
        e = math.frexp(x)[1] - 1                       # x in [2^e, 2^(e+1))
        m = int(Decimal(x) * Decimal(2) ** (23 - e))  # truncates toward zero
        return float(Fraction(m, 1) * Fraction(2) ** (e - 23))


def check_pi_hi(pi_hi):
    """`float32(pi)` rounded toward zero (the low `0x1.921fb4p+1`), plus exactly `2**-32`."""
    import math
    f32_tz = f32_toward_zero(math.pi)
    if Fraction(pi_hi) - Fraction(f32_tz) != Fraction(1, 2 ** 32):
        sys.exit(f'gen_atan2f_table: the small-|r| constant {pi_hi!r} is not '
                 f'{f32_tz!r} + 2**-32')
    if f32_bits_of(f32_tz) != 0x40490fda:
        sys.exit(f'gen_atan2f_table: f32(pi) toward zero is 0x{f32_bits_of(f32_tz):08x}?')
    if f32_bits_of(pi_hi) != 0x40490fda:
        sys.exit('gen_atan2f_table: the small-|r| constant does not round to 0x40490fda')
    if f32_bits_of(math.pi) != 0x40490fdb:
        sys.exit('gen_atan2f_table: f32(pi) is not 0x40490fdb?')
    return f32_tz


def main():
    with open(BIN, 'rb') as f:
        code = f.read()
    if len(code) < ATAN2F - 0x40 + OFF_NEG_PI4 + 8:
        sys.exit(f'{BIN} is too short; run raw/dump_libm5.c first')
    page_off = check_layout(code)

    poly = [f64(code, ATAN2F + OFF_POLY + 8 * i) for i in range(N_POLY)]
    small = f64(code, ATAN2F + OFF_SMALL)
    angles = [f64(code, ATAN2F + OFF_ANGLE + 8 * i) for i in range(N_ANGLE)]

    # ---- the constants, checked against independently computed values -------------------
    if small != 2.0 ** -22:
        sys.exit(f'gen_atan2f_table: the |y/x| threshold is {small!r}, expected 2**-22')
    import math
    # indices 0..8 as laid out at +0x270..+0x2b0; index 4 (the small-|r| arm's pi) is *not*
    # a multiple of pi and is pinned by `check_pi_hi` instead
    expected = [math.pi, -math.pi, math.pi / 2, -math.pi / 2, None,
                3 * math.pi / 4, -3 * math.pi / 4, math.pi / 4, -math.pi / 4]
    for i, want in enumerate(expected):
        if want is None:
            continue
        if bits_of(angles[i]) != bits_of(want):
            sys.exit(f'gen_atan2f_table: angle constant {i} is {angles[i]!r}, expected {want!r}')
    f32_tz = check_pi_hi(angles[4])
    worst_rel, worst_at = check_polynomial(poly)

    print(f'atan2f @ page offset 0x{page_off:x}; code displacements all resolve '
          f'(4x adr -> +0x{OFF_POLY:x}, adrp+add -> +0x{OFF_ANGLE:x}, {len(LDR_SITES)} ldr literals)')
    print(f'  angle constants: 8 x +-pi/{2,4},3pi/4 exact; small-arm pi = f32(pi)+2**-32, '
          f'f32 -> 0x{f32_bits_of(angles[4]):08x}')
    print(f'  polynomial fit: worst relative error {worst_rel:.3e} = '
          f'{worst_rel / 2 ** -24:.2f} float32 ulp (at r={worst_at!r})')

    ts = [
        '/**',
        ' * The constants of the oracle\'s arm64 `atan2f` (lane W1e -> L1 libm transcription).',
        ' *',
        ' * GENERATED by `src/model/rng/native/gen_atan2f_table.py` from',
        ' * `src/model/rng/native/raw/atan2f_bytes.bin` -- do not edit by hand.  The offsets are',
        ' * `atan2f`-relative; the script decodes the displacements of the `adr`/`adrp`+`add`/',
        ' * `ldr <label>` instructions that read these words and refuses to emit if any of them',
        ' * stops pointing at the offsets below.',
        ' *',
        ' * `ATAN2F_POLY` is the ratio polynomial, evaluated as a product of four quadratics in',
        ' * `u = r*r` (see `libm.ts`\'s `atan2f`): `atan(r) ~ T8*(u^2+T0 u+T2)*(u^2+T4 u+T6)*',
        ' * (u^2+T1 u+T3)*(u^2+T5 u+T7)*r`, each fused step a single rounding.  It approximates',
        f' * `atan(r)` to {worst_rel / 2 ** -24:.2f} float32 ulp over [-1, 1] -- the implementation is',
        ' * *float* accurate, which is why the shipped `atan2f` disagrees with the correctly',
        ' * rounded `f32(atan2)` on ~15-20 % of arguments.',
        ' */',
        '',
        '/** the `|y/x|` threshold `2^-22`: below it the `x < 0` arm answers `+-ATAN2F_PI_HI` */',
        f'export const ATAN2F_SMALL = {small!r};',
        '',
        '/**',
        ' * The four quadratics\' coefficients, in memory order (`+0x220`..`+0x260`).  The code',
        ' * groups them as `(u^2 + T0*u + T2)`, `(u^2 + T1*u + T3)`, `(u^2 + T4*u + T6)`,',
        ' * `(u^2 + T5*u + T7)` -- the "+u" and the constant alternate -- and scales the product',
        ' * by `T8`, so the evaluated quantity is `T8 * ... * r`.',
        ' */',
        'export const ATAN2F_POLY: readonly number[] = [',
    ]
    ts += [f'  {float(v)!r},' for v in poly]
    ts += [
        '];',
        '',
        '/** `+-pi` (`+0x270`, a two-entry table the code indexes with the sign of `y`) */',
        f'export const ATAN2F_PI = {angles[0]!r};',
        f'export const ATAN2F_NEG_PI = {angles[1]!r};',
        '',
        '/** `+-pi/2` (`+0x280`/`+0x288`) */',
        f'export const ATAN2F_HPI = {angles[2]!r};',
        f'export const ATAN2F_NEG_HPI = {angles[3]!r};',
        '',
        '/**',
        ' * The small-`|y/x|` arm\'s `pi`: `f32(pi)` rounded toward zero plus exactly `2**-32`,',
        ' * i.e. `0x1.921fb4008p+1`.  It is the reason arm64\'s `atan2f(0, -1)` is `0x40490fda`',
        ' * (the correctly rounded `f32(atan2)` is `0x40490fdb`) -- the census\' +-pi behaviour.',
        ' */',
        f'export const ATAN2F_PI_HI = {angles[4]!r};',
        '',
        '/** `+-3pi/4` (`+0x298`/`+0x2a0`), and `+-pi/4` (`+0x2a8`/`+0x2b0`) */',
        f'export const ATAN2F_3PI4 = {angles[5]!r};',
        f'export const ATAN2F_NEG_3PI4 = {angles[6]!r};',
        f'export const ATAN2F_PI4 = {angles[7]!r};',
        f'export const ATAN2F_NEG_PI4 = {angles[8]!r};',
        '',
    ]
    with open(os.path.join(HERE, '..', 'appleAtan2fTable.ts'), 'w') as f:
        f.write('\n'.join(ts))

    h = [
        '/* The constants of the oracle\'s arm64 `atan2f`.',
        ' *',
        ' * GENERATED by `gen_atan2f_table.py` from `raw/atan2f_bytes.bin` -- do not edit by hand.',
        ' * Offsets are `atan2f`-relative (plus the dump\'s 0x40); see the script and',
        ' * `apple_atan2f_impl.h` for the layout and the checks.',
        ' */',
        '#ifndef APPLE_ATAN2F_TABLE_H',
        '#define APPLE_ATAN2F_TABLE_H',
        '',
        'static const double AATAN2F_POLY[9] = {',
    ]
    h += [f'\t{float(v)!r},' for v in poly]
    h += ['};', '']
    h += [f'static const double AATAN2F_SMALL = {small!r}; /* 2^-22 */', '']
    h += [f'static const double AATAN2F_PI = {angles[0]!r};',
          f'static const double AATAN2F_NEG_PI = {angles[1]!r};',
          f'static const double AATAN2F_HPI = {angles[2]!r};',
          f'static const double AATAN2F_NEG_HPI = {angles[3]!r};',
          f'static const double AATAN2F_PI_HI = {angles[4]!r}; /* f32(pi)+2^-32 */',
          f'static const double AATAN2F_3PI4 = {angles[5]!r};',
          f'static const double AATAN2F_NEG_3PI4 = {angles[6]!r};',
          f'static const double AATAN2F_PI4 = {angles[7]!r};',
          f'static const double AATAN2F_NEG_PI4 = {angles[8]!r};',
          '', '#endif /* APPLE_ATAN2F_TABLE_H */', '']
    with open(os.path.join(RAW, 'apple_atan2f_table.h'), 'w') as f:
        f.write('\n'.join(h))
    print('wrote ../appleAtan2fTable.ts and raw/apple_atan2f_table.h')


if __name__ == '__main__':
    main()
