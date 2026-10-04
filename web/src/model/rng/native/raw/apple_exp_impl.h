/* The oracle's `exp`, transcribed instruction by instruction from the shipped machine code.
 *
 *   clang -O2 -ffp-contract=off -I. exp_cand.c -o exp_cand     (see exp_cand.c)
 *
 * Read off `objdump -d` of a 4096-byte dump of the live `exp`
 * (`raw/dump_exp_data.c` -> `raw/exp_bytes.bin`; the disassembly is in this lane's
 * PORT-NOTE and in `raw/expdis.s`):
 *
 *     x0 = bits(x)
 *     if (x0 >= 0x40862e42fefa39f0)              ; |x| large, or x < 0, or inf/nan
 *         if (signed(x0) < signed(0xc0874a0000000000))  goto main
 *         if (x >= 0.0, or unordered) return x * DBL_MAX
 *         s = (x0 >= 0xfff0000000000000 ? 0.0 : 0x1p-1022)   ; the csel: -inf vs finite
 *         return s * s                                       ; 0 either way, flags differ
 *   main:
 *     t    = x * 184.66496523378731      ; 128/ln2, high part  (fmul)
 *     n    = floor(t)                    ;                         (fcvtms)
 *     z    = t - n                       ;                         (scvtf/fsub)
 *     e1   = t - x * 184.66496523378731  ; exact error, fused    (fmsub)
 *     tail = e1 - x * 2.6054750388391722e-15 ; the low part      (fnmsub)
 *     a, b = EXP_TAB[n & 127]
 *     r    = z + (b + tail)
 *     p    = C4 * r * (r * (z + C0) + C2) * (r * (z + C1) + C3)
 *     q    = n >> 7
 *     if (q + 1022 < 0)  ; subnormal result: compute it in the 2^-1022 domain
 *         d0 = asdouble(bits(a) + ((q + 1022) << 52))    ; an INTEGER add of bit patterns
 *         d3 = d0 + 1.0
 *         d4 = d0 - (d3 - 1.0)
 *         d4 = fma(d0, p, d4)
 *         return ((d3 + d4) - 1.0) * 0x1p-1022
 *     return asdouble(bits(a * (1 + p)) + (q << 52))     ; an INTEGER add of bit patterns
 *
 * Two things a source-level port gets wrong:
 *
 *  * `add d0, d0, d1` on the double registers is an **integer** add of the bit patterns --
 *    that is how the 2^q scaling is applied (adding q to the exponent field). It is not an
 *    FP add, and `0x5ee18400` is the vector-integer form the compiler emits when both
 *    operands live in FP registers.
 *  * LLVM's mnemonic naming: `fmsub Dd,Dn,Dm,Da` is `Da - Dn*Dm` and `fnmsub` is
 *    `-Dn*Dm + Da` -- the two mnemonics are the same instruction with different operand
 *    order, and here they are used for `Da - Dn*Dm` twice (the fused errors of the two
 *    halves of 128/ln2). Both come out of `fma(-x, C, acc)` in C, which is what this file
 *    writes, so the port never depends on reading the mnemonics right.
 */
#ifndef APPLE_EXP_IMPL_H
#define APPLE_EXP_IMPL_H

#include <stdint.h>
#include <string.h>
#include <math.h>

#include "apple_exp_table.h"

static inline uint64_t aexp_bits (double d) { uint64_t u; memcpy (&u, &d, 8); return u; }
static inline double aexp_from_bits (uint64_t u) { double d; memcpy (&d, &u, 8); return d; }

static inline double apple_exp (double x)
{
	uint64_t ux = aexp_bits (x);

	if (ux >= AEXP_T_HI) {
		if ((int64_t) ux >= (int64_t) AEXP_T_NEG) {
			if (!(x < 0.0))                     /* x >= 0, +inf, +nan */
				return x * aexp_from_bits (AEXP_O_MUL);
			uint64_t s = (ux >= 0xfff0000000000000ull) ? 0ull : AEXP_S_TAIL;
			double d = aexp_from_bits (s);
			return d * d;
		}
	}

	double t = x * AEXP_LN2HI_N;
	int64_t n = (int64_t) floor (t);
	double z = t - (double) n;
	double e1 = fma (-x, AEXP_LN2HI_N, t);          /* t - x*ln2hiN, fused (fmsub) */
	double tail = fma (x, AEXP_LN2LO_N, -e1);       /* x*ln2loN - e1, fused (fnmsub) */

	double a = AEXP_TAB[n & 127][0];
	double b = AEXP_TAB[n & 127][1];

	double d16 = z + AEXP_C0;
	double s1 = b + tail;
	double d17 = z + AEXP_C1;
	double r = z + s1;
	double d18 = fma (r, d16, AEXP_C2);
	double d19 = fma (r, d17, AEXP_C3);
	double p = r * AEXP_C4;
	p = p * d18;
	p = p * d19;

	int64_t q = n >> 7;

	if (q + 1022 < 0) {
		double d0 = aexp_from_bits (aexp_bits (a) + ((uint64_t) (q + 1022) << 52));
		double one = 1.0;
		double d3 = d0 + one;
		double d4 = d3 - one;
		d4 = d0 - d4;
		d4 = fma (d0, p, d4);
		return ((d3 + d4) - one) * aexp_from_bits (AEXP_S_TAIL);
	}

	return aexp_from_bits (aexp_bits (fma (p, a, a)) + ((uint64_t) q << 52));
}

#endif
