#!/usr/bin/env python3
"""Emit `sin`/`cos`'s constants and tables from the *shipped* bytes.

The source of truth is `raw/sincos_bytes.bin`, the 5120-byte dump of the live
`/usr/lib/system/libsystem_m.dylib` `sin` (written by `raw/dump_libm2.c`), in which `sin`
sits at +0x400 (so every offset here is `sin-relative`).  This script reads that file,
checks the layout the disassembly implies against an independently computed `1/pi`, and
writes

  * `raw/apple_sincos_table.h` — the C constants + tables (for the C transcription), and
  * `../appleSinCosTable.ts`    — the TypeScript module the port imports.

    clang -O0 raw/dump_libm2.c -o /tmp/dump_libm2 && (cd raw && /tmp/dump_libm2)
    python3 gen_sincos_table.py
"""

import os
import struct
import sys
from decimal import Decimal, getcontext

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
BIN = os.path.join(RAW, 'sincos_bytes.bin')
SIN = 0x400

# offsets, read off `objdump -d` of sincos_bytes.bin (all relative to the `sin` symbol)
OFF_PI4 = -0x30             # the small/medium dispatch boundary
OFF_THRESH = -0x28          # the medium/Payne-Hanek dispatch boundary
OFF_INV_PI2 = -0x20         # 2/pi, the medium reduction's multiplier
OFF_PI2_HI = -0x18          # three-part pi/2
OFF_PI2_MID = -0x10
OFF_PI2_LO = -0x8
OFF_TAB_HI = -0x38          # the top of the little-endian 1/pi window (see below)
OFF_TAB_LO = -0xc8          # the lowest word the Payne-Hanek walk can read
OFF_MAGIC = 0x630           # pi/2 * 2^63, the fixed-point multiplier of both PH tails
OFF_SIN_POLY = 0x638        # 6 doubles
OFF_COS_POLY = 0x748        # 7 doubles
N_TAB = 19                  # sin-0xc8 .. sin-0x38 inclusive

getcontext().prec = 800          # 19 chunks of 64 bits is ~366 digits; leave plenty of slack


def u64(b, off):
    return struct.unpack_from('<Q', b, SIN + off)[0]


def dbl(b, off):
    return struct.unpack_from('<d', b, SIN + off)[0]


def one_over_pi_chunks(n):
    """the first `n` 64-bit chunks of 1/pi's fractional expansion, as integers"""
    val = Decimal(1) / Decimal(
        '3.1415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679821480865132823066470938446095505822317253594081284811174502841027019385211055596446229489549303819644288109756659334461284756482337867831652712019091456485669234603486104543266482133936072602491412737245870066063155881748815209209628292540917153643678925903600113305305488204665213841469519415116094330572703657595919530921861173819326117931051185480744623799627495673518857527248912279381830119491298336733624406566430860213949463952247371907021798609437027705392171762931767523846748184676694051320005681271452635608277857713427577896091736371787214684409012249534301465495853710507922796892589235420199561121290219608640344181598136297747713099605187072113499999983729780499510597317328160963185950244594553469083026425223082533446850352619311881710100031378387528865875332083814206171776691473035982534904287554687311595628638823537875937519577818577805321712268066130019278766111959092164201989')
    out = []
    for _ in range(n):
        val = val * (1 << 64)
        i = int(val)
        out.append(i)
        val -= i
    return out


def main():
    with open(BIN, 'rb') as f:
        code = f.read()
    if len(code) < SIN + OFF_COS_POLY + 7 * 8:
        sys.exit(f'{BIN} is too short; run raw/dump_libm2.c first')

    pi4 = dbl(code, OFF_PI4)
    thr = dbl(code, OFF_THRESH)
    inv_pi2 = dbl(code, OFF_INV_PI2)
    pi2_hi = dbl(code, OFF_PI2_HI)
    pi2_mid = dbl(code, OFF_PI2_MID)
    pi2_lo = dbl(code, OFF_PI2_LO)
    magic = u64(code, OFF_MAGIC)
    sin_poly = [dbl(code, OFF_SIN_POLY + 8 * i) for i in range(6)]
    cos_poly = [dbl(code, OFF_COS_POLY + 8 * i) for i in range(7)]
    tab = [u64(code, OFF_TAB_LO + 8 * i) for i in range(N_TAB)]

    # checked, not assumed: the window the code reads is a little-endian 256-bit slice of
    # 1/pi.  The shipped table is stored with the most significant chunk at the HIGHEST
    # address: ASC_TAB[i] (address sin-0xc8+8i) holds 1/pi's chunk 17-i, so ASC_TAB[15-j]
    # (address sin-0x50-8j, the word the code calls S(j)) holds chunk j+2 -- and the words
    # above sin-0x40 that a k = 0 window reads hold the zero chunk in front of 1/pi's point.
    chunks = one_over_pi_chunks(N_TAB)
    for i in range(N_TAB):
        want = chunks[17 - i] if 17 - i >= 0 else 0
        assert tab[i] == want, (i, hex(tab[i]), hex(want))
    assert tab[15] == 0x6DB14ACC9E21C820, hex(tab[15])       # S(0) == chunk 2
    assert tab[17] == 0x517CC1B727220A94 and tab[18] == 0, [hex(v) for v in tab[15:]]

    # the boundaries and the reduction constants, again checked against exact values
    assert struct.pack('>d', pi4).hex() == '3fe921fb54442d18'
    assert struct.pack('>d', thr).hex() == '412000013be57a40'
    assert struct.pack('>d', inv_pi2).hex() == '3fe45f306dc9c883'
    assert magic == 0xC90FDAA22168C235

    names = ['PI4', 'THRESH', 'INV_PI2', 'PI2_HI', 'PI2_MID', 'PI2_LO']
    values = [pi4, thr, inv_pi2, pi2_hi, pi2_mid, pi2_lo]

    hi = ['/* Generated by gen_sincos_table.py from raw/sincos_bytes.bin -- do not edit. */',
          '#ifndef APPLE_SINCOS_TABLE_H',
          '#define APPLE_SINCOS_TABLE_H',
          '',
          '/* The dispatch boundaries and the three-part pi/2 the medium reduction uses.',
          ' * `PI2_HI + PI2_MID + PI2_LO` is pi/2 to ~130 bits. */']
    for n, v in zip(names, values):
        hi.append(f'#define ASC_{n} {v!r}')
    hi.append('#define ASC_MAGIC 0x%016xull' % magic)
    hi.append('')
    hi.append('/* ASC_TAB[j] is the 1/pi word at sin-0x50-8j (j = 0..15); ASC_TAB[i] here is')
    hi.append(' * the word at sin-0xc8+8i, so ASC_TAB[15-j] is that word.  ASC_TAB[16..18]')
    hi.append(' * are the words *above* sin-0x50 that a k = 0 Payne-Hanek window reads. */')
    hi.append('static const uint64_t ASC_TAB[19] = {')
    for v in tab:
        hi.append('  0x%016xull,' % v)
    hi.append('};')
    hi.append('')
    hi.append('/* sin(r) = r + r^3 * poly(r^2), 6 coefficients in load order */')
    hi.append('static const double ASC_SIN_POLY[6] = {')
    for v in sin_poly:
        hi.append('  %r,' % v)
    hi.append('};')
    hi.append('')
    hi.append('/* cos(r) = 1 + z * poly(z) with z = r^2, 7 coefficients in load order */')
    hi.append('static const double ASC_COS_POLY[7] = {')
    for v in cos_poly:
        hi.append('  %r,' % v)
    hi.append('};')
    hi.append('')
    hi.append('#endif')
    with open(os.path.join(RAW, 'apple_sincos_table.h'), 'w') as f:
        f.write('\n'.join(hi) + '\n')

    ts = ['/**',
          " * The constants and tables of the oracle's `sin`/`cos`, extracted from the shipped",
          ' * machine code (`src/model/rng/native/raw/sincos_bytes.bin`, a 5120-byte dump of the',
          ' * live `/usr/lib/system/libsystem_m.dylib` `sin` symbol; `cos` shares the unit).',
          ' *',
          ' * GENERATED by `src/model/rng/native/gen_sincos_table.py` -- do not edit by hand.',
          ' * `TAB[15-j]` is the 1/pi word the Payne-Hanek walk reads for `e >> 6 == j`.',
          ' */',
          '']
    for n, v in zip(names, values):
        ts.append(f'export const {n} = {v!r};')
    ts.append(f'export const MAGIC_PI2 = 0x{magic:016x}n;')
    ts.append('')
    ts.append('export const TAB: readonly bigint[] = [')
    for v in tab:
        ts.append('  0x%016xn,' % v)
    ts.append('];')
    ts.append('')
    ts.append('export const SIN_POLY: readonly number[] = [')
    for v in sin_poly:
        ts.append('  %r,' % v)
    ts.append('];')
    ts.append('')
    ts.append('export const COS_POLY: readonly number[] = [')
    for v in cos_poly:
        ts.append('  %r,' % v)
    ts.append('];')
    ts.append('')
    ts_path = os.path.normpath(os.path.join(HERE, '..', 'appleSinCosTable.ts'))
    with open(ts_path, 'w') as f:
        f.write('\n'.join(ts) + '\n')

    print('wrote raw/apple_sincos_table.h and ../appleSinCosTable.ts')
    print('constants:', ', '.join(f'{n}={v!r}' for n, v in zip(names, values)))
    print('magic: 0x%016x   1/pi chunks checked: %d' % (magic, N_TAB))


if __name__ == '__main__':
    main()
