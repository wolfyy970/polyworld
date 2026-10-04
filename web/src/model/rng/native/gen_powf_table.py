#!/usr/bin/env python3
"""Emit `powf`'s constants and two tables from the *shipped* bytes.

The source of truth is `raw/powf_bytes.bin`, the 5120-byte dump of the live
`/usr/lib/system/libsystem_m.dylib` `powf` (written by `raw/dump_libm4.c`), in which `powf`
sits at +0x400 — so every offset below is `powf`-relative.  This script reads that file,
checks the layout against independently computed values, and writes

  * `raw/apple_powf_table.h` — the C constants + tables (for the C transcription), and
  * `../applePowfTable.ts`    — the TypeScript module the port imports.

    clang -O0 raw/dump_libm4.c -o /tmp/dump_libm4 && (cd raw && /tmp/dump_libm4)
    python3 gen_powf_table.py

What the shipped code does with them (see `raw/apple_powf_impl.h` for the transcription):

  * the **log table** is 128 entries of two `double`s, `{invc, logc}`, reached by
    `adrp+add` at `powf+0x2c8f0` and indexed with `(w0 - 0x3f338000) >> 16 & 0x7f`, where `w0`
    is the base's float bit pattern; the polynomial runs off the four `double`s immediately
    *before* the table (`powf+0x2c8d0`).  The reduction is `r = z*invc - 1` (an `fnmsub`) and
    the value is `128*log2(base) = k + logc + 128*log2(1 + r)` with `k = (w0 - C) & 0xff800000`
    arithmetic-shifted right 16 — i.e. every one of these is a *scaled* quantity: 128 is the
    table's resolution, which is why the exp side shifts the exponent by 45 and its
    polynomial carries `ln2/128`.
  * `invc[i]` is `fl(256/n_i)` for `n_i = 180 + i` (i <= 76) and `n_i = 256 + 2*(i - 76)`
    (i >= 76) — the two-block lattice this script checks entry by entry, so a wrong table
    offset cannot pass — and `logc[i]` is `-128*log2(invc[i])` to within a double ulp.
  * the **exp table** is 128 8-byte *bit patterns* at `powf+0x2bca0`, one per exponent of the
    fractional grid: `EXPT[j] + (n << 45)` is the pattern of `2^(n/128)` for the integer `n`
    with `n & 0x7f == j` (the `+ (n<<45)` is what turns the entry into the right binade, and it
    is exact).  Equivalently `EXPT[j] = bits(2^(j/128)) - (j << 45)`; this script checks that
    identity for all 128 entries.  The two `double`s before the table are the polynomial's
    coefficients, `2^(f/128) ~= 1 + f*(E0*f + E1)`.
"""

import os
import struct
import sys
from decimal import Decimal, getcontext, localcontext

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
BIN = os.path.join(RAW, 'powf_bytes.bin')
POWF = 0x400
TABLES = os.path.join(RAW, 'powf_tables.bin')
TABLES_BASE = 0x2b400      # file offset 0 of powf_tables.bin == powf+0x2b400

# offsets, read off `objdump -d` of powf_bytes.bin (all relative to the `powf` symbol)
OFF_FLTMAX = 0x25c          # the float FLT_MAX pattern (the |y| dispatch guard)
OFF_LOGBIAS = 0x260         # 0x3f338000: the log-index bias C
OFF_32768 = 0x270           # the +-2^15 clamp pair (fmin/fmax around the exp reduction)
OFF_EXP_POLY = 0x2bca0 - 0x10
OFF_EXP_TAB = 0x2bca0       # 128 x u64
OFF_LOG_POLY = 0x2c8f0 - 0x20
OFF_LOG_TAB = 0x2c8f0       # 128 x 2 doubles
N_TAB = 128

getcontext().prec = 60


def f64(b, off):
    return struct.unpack_from('<d', b, off - TABLES_BASE)[0]


def u64(b, off):
    return struct.unpack_from('<Q', b, off - TABLES_BASE)[0]


def u32(b, off):
    return struct.unpack_from('<I', b, off - TABLES_BASE)[0]


def bits_of(x):
    return struct.unpack('<Q', struct.pack('<d', float(x)))[0]


def f32_of(x):
    """the float32 value nearest `x`, as a double."""
    return struct.unpack('<f', struct.pack('<f', x))[0]


def main():
    with open(BIN, 'rb') as f:
        code = f.read()
    with open(TABLES, 'rb') as f:
        tables = f.read()
    if len(code) < POWF + OFF_32768 + 16:
        sys.exit(f'{BIN} is too short; run raw/dump_libm4.c first')
    if len(tables) < OFF_LOG_TAB + N_TAB * 16 - TABLES_BASE:
        sys.exit(f'{TABLES} is too short; run raw/dump_libm4.c first')

    fltmax = struct.unpack_from('<I', code, POWF + OFF_FLTMAX)[0]
    logbias = struct.unpack_from('<I', code, POWF + OFF_LOGBIAS)[0]
    clamp_hi = struct.unpack_from('<d', code, POWF + OFF_32768)[0]
    clamp_lo = struct.unpack_from('<d', code, POWF + OFF_32768 + 8)[0]
    exp_poly = [f64(tables, OFF_EXP_POLY + 8 * i) for i in range(2)]
    exp_tab = [u64(tables, OFF_EXP_TAB + 8 * j) for j in range(N_TAB)]
    log_poly = [f64(tables, OFF_LOG_POLY + 8 * i) for i in range(4)]
    log_tab = [(f64(tables, OFF_LOG_TAB + 16 * i), f64(tables, OFF_LOG_TAB + 16 * i + 8))
               for i in range(N_TAB)]

    # ---- the constants, checked against their exact values ----------------------------
    assert fltmax == 0x7f7fffff, hex(fltmax)
    assert logbias == 0x3f338000, hex(logbias)
    assert clamp_hi == 32768.0 and clamp_lo == -32768.0, (clamp_hi, clamp_lo)

    # ---- the log table ----------------------------------------------------------------
    # invc[i] is fl(256/n_i) on a two-block lattice; logc[i] is -128*log2(invc[i]).
    with localcontext() as ctx:
        ctx.prec = 60
        ln2 = Decimal(2).ln()
        worst = Decimal(0)
        worst_at = None
        for i in range(N_TAB):
            n = 180 + i if i <= 76 else 256 + 2 * (i - 76)
            invc, logc = log_tab[i]
            assert invc == 256.0 / n, (i, n, invc, 256.0 / n)
            exact = -128 * Decimal(invc).ln() / ln2
            d = abs(Decimal(logc) - exact)
            if d > worst:
                worst, worst_at = d, i
        # every entry is `-128*log2(invc)` to within ~2e-14 (5.7e-15 relative, ~26 double
        # ulps: the table was built with a slightly coarser log2 than the exact one), which is
        # what identifies the layout; the transcribed code uses the stored bits either way.
        assert worst < Decimal('1e-13'), (worst, worst_at)
        log_worst = worst

    # the polynomial is the 128-scaled log2 series: 128*log2(1+r) = (128/ln2)*(r - r^2/2 + ...)
    # (the coefficients are a minimax fit of that series: the leading one is exact to 6e-12, the
    # others sit ~1e-5 relative from their Taylor values, which is why this checks the *shape*)
    with localcontext() as ctx:
        ctx.prec = 40
        c0, c1, c2, c3 = (Decimal(v) for v in log_poly)
        assert abs(c3 - 128 / Decimal(2).ln()) / abs(c3) < Decimal('1e-9'), c3
        assert abs(c1 / c3 - Decimal(1) / 3) < Decimal('1e-4'), c1 / c3
        assert abs(c2 / c3 + Decimal(1) / 2) < Decimal('1e-4'), c2 / c3
        assert abs(c0 / c3 + Decimal(1) / 4) < Decimal('1e-4'), c0 / c3

    # ---- the exp table ----------------------------------------------------------------
    # EXPT[j] = bits(2^(j/128)) - (j << 45): the entry plus `n << 45` is the pattern of
    # 2^(n/128) for every integer n with n & 0x7f == j.
    with localcontext() as ctx:
        ctx.prec = 60
        for j in range(N_TAB):
            exact = float(Decimal(2) ** (Decimal(j) / 128))
            assert exp_tab[j] == bits_of(exact) - (j << 45), j
            # and the sliding-window identity for a few n on the same bin
            for n in (j, j + 128, j - 128, j + 128 * 300, j - 128 * 300):
                want = bits_of(float(Decimal(2) ** (Decimal(n) / 128)))
                assert (exp_tab[j] + (n << 45)) & 0xffffffffffffffff == want, (j, n)
    with localcontext() as ctx:
        ctx.prec = 40
        assert abs(Decimal(exp_poly[1]) - Decimal(2).ln() / 128) < Decimal('1e-7'), exp_poly
        # 1 + f*(E0*f + E1) must reproduce 2^(f/128) over the reduction's f in [-1/2, 1/2]
        worst = Decimal(0)
        for k in range(-500, 501):
            f = Decimal(k) / 1000
            approx = 1 + f * (Decimal(exp_poly[0]) * f + Decimal(exp_poly[1]))
            want = Decimal(2) ** (f / 128)
            worst = max(worst, abs(approx - want) / want)
        # ~8.3e-10 worst case (2^-30) -- two terms of `2^(f/128)`, far below the float32
        # narrowing's 2^-24, which is exactly why the shipped `powf` is only 97-99 % correctly
        # rounded; the port reproduces the values, not an ideal.
        assert worst < Decimal('1e-8'), worst
        exp_worst = worst

    # ---- emit -------------------------------------------------------------------------
    ts = [
        '/**',
        " * The constants and the two tables of the oracle's `powf`, extracted from the shipped",
        ' * machine code (`src/model/rng/native/raw/powf_bytes.bin`, a 5120-byte dump of the',
        ' * live `/usr/lib/system/libsystem_m.dylib` `powf` symbol, which sits at +0x400).',
        ' *',
        ' * GENERATED by `src/model/rng/native/gen_powf_table.py` -- do not edit by hand.',
        ' *',
        ' * Everything here is *128-scaled*: the shipped code computes `128*log2(x)` in the log',
        ' * reduction and `2^(n/128)` in the exp assembly, so `POWF_LOG_LOGC[i]` is',
        ' * `-128*log2(POWF_LOG_INVC[i])` and `POWF_EXP_TAB[j] + (n << 45)` is the bit pattern of',
        ' * `2^(n/128)`.  See `libm.ts` -> `powf` and `native/raw/apple_powf_impl.h`.',
        ' */',
        '',
        f'export const POWF_LOG_BIAS = 0x{logbias:08x};',
        f'export const POWF_FLT_MAX_BITS = 0x{fltmax:08x};',
        'export const POWF_T_CLAMP = 32768.0;',
        '',
        '/** the 128-scaled log-series coefficients: `128*log2(1+r) = ((c0 r + c1) r^2 + (c2 r + c3)) r`. */',
        'export const POWF_LOG_POLY: readonly number[] = [',
    ]
    ts += [f'  {trunc16(v)},' for v in log_poly]
    ts += [
        '];',
        '',
        '/** the exp-side polynomial: `2^(f/128) ~= 1 + f*(e0*f + e1)`, `f` in [-1/2, 1/2]. */',
        'export const POWF_EXP_POLY: readonly number[] = [',
    ]
    ts += [f'  {trunc16(v)},' for v in exp_poly]
    ts += [
        '];',
        '',
        '/** the reduction constant per bin: `1/invc[i]` is the lattice value `n_i/256`. */',
        'export const POWF_LOG_INVC = new Float64Array([',
    ]
    ts += [f'  {trunc16(invc)},' for invc, _ in log_tab]
    ts += [
        ']);',
        '',
        '/** `-128*log2(POWF_LOG_INVC[i])`, the exact value for the *stored* reciprocal. */',
        'export const POWF_LOG_LOGC = new Float64Array([',
    ]
    ts += [f'  {trunc16(logc)},' for _, logc in log_tab]
    ts += [
        ']);',
        '',
        '/** `POWF_EXP_TAB[j] + (n << 45)` is the pattern of `2^(n/128)` when `n & 0x7f == j`. */',
        'export const POWF_EXP_TAB: readonly bigint[] = [',
    ]
    ts += [f'  0x{v:016x}n,' for v in exp_tab]
    ts += ['];', '']
    with open(os.path.join(HERE, '..', 'applePowfTable.ts'), 'w') as f:
        f.write('\n'.join(ts))

    h = [
        '/* The constants and tables of the oracle\'s `powf`.',
        ' *',
        ' * GENERATED by `gen_powf_table.py` from `raw/powf_bytes.bin` -- do not edit by hand.',
        ' * Offsets are `powf`-relative; see the script and `apple_powf_impl.h` for the layout.',
        ' */',
        '#ifndef APPLE_POWF_TABLE_H',
        '#define APPLE_POWF_TABLE_H',
        '',
        '#include <stdint.h>',
        '',
        f'#define APOWF_LOG_BIAS 0x{logbias:08x}u',
        f'#define APOWF_FLT_MAX  0x{fltmax:08x}u',
        '#define APOWF_T_CLAMP  32768.0',
        '',
        'static const double APOWF_LOG_POLY[4] = {',
    ]
    h += [f'\t{trunc17(v)},' for v in log_poly]
    h += ['};', '', 'static const double APOWF_EXP_POLY[2] = {']
    h += [f'\t{trunc17(v)},' for v in exp_poly]
    h += ['};', '', 'static const double APOWF_LOG_INVC[128] = {']
    h += [f'\t{trunc17(invc)},' for invc, _ in log_tab]
    h += ['};', '', 'static const double APOWF_LOG_LOGC[128] = {']
    h += [f'\t{trunc17(logc)},' for _, logc in log_tab]
    h += ['};', '', 'static const uint64_t APOWF_EXP_TAB[128] = {']
    h += [f'\t0x{v:016x}ull,' for v in exp_tab]
    h += ['};', '', '#endif /* APPLE_POWF_TABLE_H */', '']
    with open(os.path.join(RAW, 'apple_powf_table.h'), 'w') as f:
        f.write('\n'.join(h))

    print('wrote ../applePowfTable.ts and raw/apple_powf_table.h')
    print(f'  log table: {len(log_tab)} entries, worst |logc - (-128*log2(invc))| = {log_worst:.3e}')
    print(f'  exp table: {len(exp_tab)} entries, all bits(2^(j/128)) - (j<<45);'
          f' exp poly worst rel = {exp_worst:.3e}')


def trunc16(v):
    """`repr` with enough digits for a round trip, but no more."""
    return repr(float(v))


def trunc17(v):
    return f'{float(v)!r}'


if __name__ == '__main__':
    main()
