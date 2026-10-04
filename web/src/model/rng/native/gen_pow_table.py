#!/usr/bin/env python3
"""Emit `pow`'s constants and its two tables from the *shipped* bytes.

`pow` is not a wrapper around the `exp`/`log` entry points: it inlines its own copies of both
reductions and has its own tables, ~170 kB away from its code. The source of truth is

  * `raw/pow_bytes.bin`   -- 5120 bytes of the live `/usr/lib/system/libsystem_m.dylib` `pow`
                             (`pow` at +0x400, so every offset here is pow-relative), which
                             also carries the log/exp polynomial constants in its own literal
                             pool (0x418..0x468, 0x830..0x888), and
  * `raw/pow_tables.bin`  -- 7168 bytes of pow's *data* window, which holds the 129-entry log
                             table at +0x470, the exp polynomial at +0x888 and the 128-entry
                             exp table at +0xcb0,

both written by `raw/dump_libm2.c`. This script reads them, checks the tables against
independently computed values, and writes

  * `raw/apple_pow_table.h` -- the C constants + tables (for the C transcription), and
  * `../applePowTable.ts`   -- the TypeScript module the port imports.

    clang -O0 raw/dump_libm2.c -o /tmp/dump_libm2 && (cd raw && /tmp/dump_libm2)
    python3 gen_pow_table.py

The log table's entry is 16 bytes and is *not* two little-endian doubles: the first 8 bytes
are two 32-bit halves packed `{ high word of invc, high word of logc_lo }` and the second 8
are an ordinary little-endian double (logc_hi).  The machine code reads the first field as
`ldr s2` + `shl.2d v2, v2, #32` (the high word moved into place, the low half being zero by
construction) and the second as `ldur d4, [x3]` + `and 0xffffffff00000000` (the *other* half
of the same 8 bytes, i.e. the logc_lo correction).  So:

    invc    = the double whose high word is bytes [0:4] and whose low word is 0
    logc_lo = the double whose high word is bytes [4:8] and whose low word is 0
    logc_hi = the little-endian double at bytes [8:16]

and `logc_hi + logc_lo` is `-log2(invc)` -- minus 1 for the entries with index >= 64, the same
"the exponent k is floor(log2 x) + 1" convention the shipped `log` table uses.  That identity
is what the checks below assert: the pair is a double-double of the reference point and it is
exact to ~4e-26, while `invc` itself is only a coarse (hand-chosen) reciprocal -- it only has
to keep the reduction's `|r|` under 1/256.
"""

import os
import struct
import sys
from decimal import Decimal, getcontext

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
CODE_BIN = os.path.join(RAW, 'pow_bytes.bin')
TAB_BIN = os.path.join(RAW, 'pow_tables.bin')
POW = 0x400                 # pow's offset inside pow_bytes.bin

# the log/exp polynomial and chain constants live in the *data* window (pow's `[x1, #-0x58]`
# loads reach back from the table base at 0x470), while the masks and thresholds the code
# loads with a bare `ldr`/`adr` live in the code window's own literal pool
OFF_LOG_C = 0x418           # 5 doubles: the r^4 polynomial, in load order
OFF_LOG_H0 = 0x440          # the log2(1+r)/r coefficient chain: (C, C_lo), (B, B_lo), (A, A_lo)
OFF_LOG_H1 = 0x450
OFF_LOG_A = 0x460
OFF_K_BIAS = 0x830          # 0xc018100000000000: k = (bits(x) + K_BIAS) >> 52
OFF_ZERO_BIAS = 0x838       # 0xc020000000000000: the subnormal normaliser
OFF_LOG_HI_MASK = 0x840     # 0xfffffffffffffffe: applied to loghi before the hi/lo split
OFF_INVC_MASK = 0x848       # 0xffffffff00000000: extracts the entry's logc_lo half
OFF_SCALE = 0x850           # 128.0: t = (y*128) * log2(x)
OFF_OVER_MUL = 0x858        # 0x7fe0000000000001: squared in the overflow path
OFF_UNDER_MUL = 0x860       # 0x0010000000000001: squared in the underflow path
OFF_T_LIMITS = 0x870        # 131200.0, -137600.0: the |t| bail-out thresholds
OFF_Y_LIMITS = 0x880        # 2^64, 2^-65: the |y| special-case thresholds

# data-window offsets
OFF_LOG_TAB = 0x470         # 129 x {u32 invc_hi, u32 logc_lo, double logc_hi}
OFF_EXP_POLY = 0xc88        # 5 doubles, in load order (they sit just below the exp table)
OFF_EXP_TAB = 0xcb0         # 128 x {double 2^(j/128), double correction}
N_LOG = 129
N_EXP = 128

POLY_NAMES = ['C0', 'C1', 'C2', 'C3', 'C4']

getcontext().prec = 60


def u32(b, off):
    return struct.unpack_from('<I', b, off)[0]


def u64(b, off):
    return struct.unpack_from('<Q', b, off)[0]


def dbl(b, off):
    return struct.unpack_from('<d', b, off)[0]


def from_high_word(h):
    """the double whose high 32 bits are `h` and whose low 32 bits are zero"""
    return struct.unpack('<d', struct.pack('<Q', (h & 0xffffffff) << 32))[0]


def main():
    code = open(CODE_BIN, 'rb').read()
    tab = open(TAB_BIN, 'rb').read()
    if len(code) < POW + 0x1000 or len(tab) < OFF_EXP_TAB + N_EXP * 16:
        sys.exit('run raw/dump_libm2.c first (need both pow_bytes.bin and pow_tables.bin)')

    # ---- the code-window constants: checked by bit pattern, not by value ----
    fixed = {
        'K_BIAS': (u64(code, OFF_K_BIAS), 0xc018100000000000),
        'ZERO_BIAS': (u64(code, OFF_ZERO_BIAS), 0xc020000000000000),
        'LOG_HI_MASK': (u64(code, OFF_LOG_HI_MASK), 0xfffffffffffffffe),
        'INVC_MASK': (u64(code, OFF_INVC_MASK), 0xffffffff00000000),
        'OVER_MUL': (u64(code, OFF_OVER_MUL), 0x7fe0000000000001),
        'UNDER_MUL': (u64(code, OFF_UNDER_MUL), 0x0010000000000001),
        'Y_HUGE': (u64(code, OFF_Y_LIMITS), 0x43f0000000000000),
        'Y_TINY': (u64(code, OFF_Y_LIMITS + 8), 0x3be0000000000000),
    }
    for name, (got, want) in fixed.items():
        assert got == want, (name, hex(got), hex(want))
    scale = dbl(code, OFF_SCALE)
    t_max = dbl(code, OFF_T_LIMITS)
    t_min = dbl(code, OFF_T_LIMITS + 8)
    assert scale == 128.0, scale
    assert t_max == 131200.0 and t_min == -137600.0, (t_max, t_min)

    log_poly = [dbl(tab, OFF_LOG_C + 8 * i) for i in range(5)]
    log_h0 = dbl(tab, OFF_LOG_H0)
    log_h0_lo = dbl(tab, OFF_LOG_H0 + 8)
    log_h1 = dbl(tab, OFF_LOG_H1)
    log_h1_lo = dbl(tab, OFF_LOG_H1 + 8)
    log_a = dbl(tab, OFF_LOG_A)
    log_a_lo = dbl(tab, OFF_LOG_A + 8)
    # the chain is the expansion of log2(1+r)/r = A + B r + C r^2 + ...: A = 1/ln2,
    # B = -1/(2 ln2), C = 1/(3 ln2) and the r^4 polynomial's constant term is -1/(4 ln2)
    assert abs(log_a - 1.0 / 0.6931471805599453) < 1e-15, log_a
    assert abs(log_h1 + 1.0 / (2 * 0.6931471805599453)) < 1e-15, log_h1
    assert abs(log_h0 - 1.0 / (3 * 0.6931471805599453)) < 1e-14, log_h0
    assert abs(log_poly[4] + 1.0 / (4 * 0.6931471805599453)) < 1e-12, log_poly[4]

    exp_poly = [dbl(tab, OFF_EXP_POLY + 8 * i) for i in range(5)]
    # the exp2 polynomial: exp2(u) - 1 for the reduced argument u, so its five coefficients
    # climb from ~2^-45 to ln2/128 in load order (a structural check that also pins the
    # offset: reading the region 0x400 bytes too low would find five ~0.4 values instead)
    assert abs(exp_poly[4] - 0.6931471805599453 / 128) < 1e-18, exp_poly[4]
    assert abs(exp_poly[0]) < 1e-12 and abs(exp_poly[1]) < 1e-9 and abs(exp_poly[2]) < 1e-6 \
        and abs(exp_poly[3]) < 1e-3, exp_poly

    # ---- the log table ----
    log_invc, log_hi, log_lo = [], [], []
    worst_invc = Decimal(0)
    worst_logc = Decimal(0)
    for i in range(N_LOG):
        off = OFF_LOG_TAB + 16 * i
        invc = from_high_word(u32(tab, off))
        corr = from_high_word(u32(tab, off + 4))
        tail = dbl(tab, off + 8)
        # the low half of each packed field is zero by construction: the machine code only
        # ever reads the high word (that is what makes `ldr s2`+`shl` a complete load)
        assert struct.unpack('<d', struct.pack('<Q', u32(tab, off) << 32))[0] == invc
        log_invc.append(invc)
        log_hi.append(tail)
        log_lo.append(corr)
        if i in (0, N_LOG - 1):
            assert invc == (1.0 if i == 0 else 0.5) and tail == 0.0 and corr == 0.0, i
            continue
        # invc is a coarse reciprocal: the reduction only needs |invc*z - 1| < 1/256 + slack
        worst_invc = max(worst_invc, abs(Decimal(invc) * (1 + Decimal(i) / 128) - 1))
        # ... and the (logc_hi, logc_lo) pair is the *exact* -log2(invc), minus the table's
        # own `-1` for the x >= 2.0 entries (k = floor(log2 x) + 1)
        exact = -(Decimal(invc).ln() / Decimal(2).ln()) - (1 if i >= 64 else 0)
        worst_logc = max(worst_logc, abs(Decimal(tail) + Decimal(corr) - exact))
    assert worst_invc < Decimal('5e-4'), worst_invc
    assert worst_logc < Decimal('1e-24'), worst_logc

    # ---- the exp table (the same 128 points `exp` itself uses, with the correction stored
    # negated and both parts rounded up: pow subtracts it, exp adds it) ----
    exp_tab = []
    worst_exp = Decimal(0)
    for j in range(N_EXP):
        off = OFF_EXP_TAB + 16 * j
        a, c = dbl(tab, off), dbl(tab, off + 8)
        exact = Decimal(2) ** (Decimal(j) / 128)
        assert a == float(exact), (j, a, float(exact))     # the first field is correctly rounded
        worst_exp = max(worst_exp, abs((Decimal(a) - Decimal(c)) - exact) / exact)
        exp_tab.append((a, c))
    assert worst_exp < Decimal('1e-13'), worst_exp

    # ---- emit ----
    scalars = [('K_BIAS', '0x%016xull' % fixed['K_BIAS'][1]),
               ('ZERO_BIAS', '0x%016xull' % fixed['ZERO_BIAS'][1]),
               ('LOG_HI_MASK', '0x%016xull' % fixed['LOG_HI_MASK'][1]),
               ('INVC_MASK', '0x%016xull' % fixed['INVC_MASK'][1]),
               ('SCALE', repr(scale)),
               ('OVER_MUL', '0x%016xull' % fixed['OVER_MUL'][1]),
               ('UNDER_MUL', '0x%016xull' % fixed['UNDER_MUL'][1]),
               ('T_MAX', repr(t_max)),
               ('T_MIN', repr(t_min)),
               ('Y_HUGE', '0x%016xull' % fixed['Y_HUGE'][1]),
               ('Y_TINY', '0x%016xull' % fixed['Y_TINY'][1])]
    logc = [('H0', log_h0), ('H0_LO', log_h0_lo), ('H1', log_h1), ('H1_LO', log_h1_lo),
            ('A', log_a), ('A_LO', log_a_lo)]

    hi = ['/* Generated by gen_pow_table.py from raw/pow_bytes.bin + raw/pow_tables.bin',
          ' * -- do not edit. */',
          '#ifndef APPLE_POW_TABLE_H',
          '#define APPLE_POW_TABLE_H',
          '',
          '/* The constants the shipped pow() loads from its own literal pool. */']
    for n, v in scalars:
        hi.append(f'#define APOW_{n} {v}')
    hi.append('')
    hi.append('/* log2(1+r)/r = A + B r + C r^2 + ...: the pair coefficients the chain uses,')
    hi.append(' * each a rounded part plus its exact low correction. */')
    for n, v in logc:
        hi.append(f'#define APOW_LOG_{n} {v!r}')
    hi.append('')
    hi.append('/* The r^4 refinement of that series (5 coefficients, in load order). */')
    hi.append('static const double APOW_LOG_POLY[5] = {')
    for v in log_poly:
        hi.append('  %r,' % v)
    hi.append('};')
    hi.append('')
    hi.append('/* The exp(y*log2 x) polynomial (5 coefficients, in load order). */')
    hi.append('static const double APOW_EXP_POLY[5] = {')
    for v in exp_poly:
        hi.append('  %r,' % v)
    hi.append('};')
    hi.append('')
    hi.append('/* The 129-entry log table: index i is the mantissa bin around z = 1 + i/128.')
    hi.append(' * INVC[i] is the reduction constant (a coarse reciprocal, high 32 bits only),')
    hi.append(' * LOGC[i] + LOGC_LO[i] is the exact -log2(INVC[i]) -- minus 1 for i >= 64. */')
    hi.append('static const double APOW_LOG_INVC[129] = {')
    for v in log_invc:
        hi.append('  %r,' % v)
    hi.append('};')
    hi.append('static const double APOW_LOG_LOGC[129] = {')
    for v in log_hi:
        hi.append('  %r,' % v)
    hi.append('};')
    hi.append('static const double APOW_LOG_LOGC_LO[129] = {')
    for v in log_lo:
        hi.append('  %r,' % v)
    hi.append('};')
    hi.append('')
    hi.append('/* EXP_TAB[j] = { 2^(j/128), correction } -- the correction is what exp() itself')
    hi.append(' * stores negated (pow subtracts it from the reduction residual). */')
    hi.append('static const double APOW_EXP_TAB[128][2] = {')
    for a, c in exp_tab:
        hi.append('  { %r, %r },' % (a, c))
    hi.append('};')
    hi.append('')
    hi.append('#endif')
    with open(os.path.join(RAW, 'apple_pow_table.h'), 'w') as f:
        f.write('\n'.join(hi) + '\n')

    ts = ['/**',
          " * The constants and the two tables of the oracle's `pow`, extracted from the shipped",
          ' * machine code (`src/model/rng/native/raw/pow_bytes.bin` + `pow_tables.bin`, dumps of',
          ' * the live `/usr/lib/system/libsystem_m.dylib` symbol and of the data window its',
          ' * `adrp`-relative table loads reach).',
          ' *',
          ' * GENERATED by `src/model/rng/native/gen_pow_table.py` -- do not edit by hand.',
          ' *',
          ' * `POW_LOG_INVC[i]` is the reduction constant for the mantissa bin around',
          ' * `z = 1 + i/128`; `POW_LOG_LOGC[i] + POW_LOG_LOGC_LO[i]` is the exact',
          ' * `-log2(POW_LOG_INVC[i])` (minus 1 for `i >= 64`, because `k = floor(log2 x) + 1`).',
          ' * `POW_EXP_TAB[j] = [ 2^(j/128), correction ]`.',
          ' */',
          '']
    for n, v in scalars:
        if v.startswith('0x'):
            ts.append(f'export const POW_{n} = {v[:-3]}n;')
        else:
            ts.append(f'export const POW_{n} = {v};')
    for n, v in logc:
        ts.append(f'export const POW_LOG_{n} = {v!r};')
    ts.append('')
    ts.append('export const POW_LOG_POLY: readonly number[] = [')
    for v in log_poly:
        ts.append('  %r,' % v)
    ts.append('];')
    ts.append('')
    ts.append('export const POW_EXP_POLY: readonly number[] = [')
    for v in exp_poly:
        ts.append('  %r,' % v)
    ts.append('];')
    ts.append('')
    ts.append('export const POW_LOG_INVC = new Float64Array([')
    for v in log_invc:
        ts.append('  %r,' % v)
    ts.append(']);')
    ts.append('')
    ts.append('export const POW_LOG_LOGC = new Float64Array([')
    for v in log_hi:
        ts.append('  %r,' % v)
    ts.append(']);')
    ts.append('')
    ts.append('export const POW_LOG_LOGC_LO = new Float64Array([')
    for v in log_lo:
        ts.append('  %r,' % v)
    ts.append(']);')
    ts.append('')
    ts.append('export const POW_EXP_TAB: readonly (readonly [number, number])[] = [')
    for a, c in exp_tab:
        ts.append('  [%r, %r],' % (a, c))
    ts.append('];')
    ts.append('')
    ts_path = os.path.normpath(os.path.join(HERE, '..', 'applePowTable.ts'))
    with open(ts_path, 'w') as f:
        f.write('\n'.join(ts) + '\n')

    print('wrote raw/apple_pow_table.h and ../applePowTable.ts')
    print('log table: worst |invc*(1+i/128) - 1| = %.3e, worst |logc - (-log2 invc)| = %.3e'
          % (float(worst_invc), float(worst_logc)))
    print('exp table: worst |(a - c) - 2^(j/128)| / 2^(j/128) = %.3e' % float(worst_exp))
    print('log poly:', ', '.join(repr(v) for v in log_poly))
    print('exp poly:', ', '.join(repr(v) for v in exp_poly))


if __name__ == '__main__':
    main()
