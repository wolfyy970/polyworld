/* The oracle's `pow`, transcribed instruction by instruction from the shipped machine code.
 *
 *   clang -O2 -ffp-contract=off -I. pow_cand.c -o pow_cand           (see pow_cand.c)
 *
 * Read off `objdump -d` of the 5120-byte dump `raw/pow_bytes.bin` (`raw/dump_libm2.c`, `pow`
 * at +0x400, so every address below is pow-relative) plus its data window
 * `raw/pow_tables.bin` (129-entry log table at +0x470, exp polynomial at +0x888, 128-entry exp
 * table at +0xcb0, all ~170 kB away from the code and reached by `adrp`+`add` pairs).  The
 * tables themselves come from `gen_pow_table.py` -- nothing here is typed by hand.
 *
 * `pow(x, y)`, x0 = bits(x) = ux, x1 = bits(y) = uy, x7 = the sign to apply at the end (set
 * only for a negative base with an odd integer exponent; it is folded into the exponent-field
 * trick, never an FP op):
 *
 *   if (ux - 2^52) >= 0x7fe0000000000000            -> special ladder   (0x418, 0x428)
 *   if (uy - 0x3be0000000000000) > 0x0810000000000000 -> special ladder  (0x42c, 0x440)
 *   ; the fast path is therefore x a positive normal and y in [2^-65, 2^64) -- and note the
 *   ; second test is a 64-bit *unsigned* subtract, so any negative y falls through to the
 *   ; ladder, which is where the negative-y handling (and the odd-integer sign) lives.
 *   if (!(ux & 2^52 - 1)) goto log2_x_is_exact                     (0x444)
 *
 *   log2(x) as a two-part value (0x44c..0x558):
 *     i = ((2^44 + mantissa) & 0x1fe00000000000) >> 41      ; 16 * (rounded top 7 bits)
 *     k = ((int64) (ux + 0xc018100000000000)) >> 52         ; floor(log2 x) + 1
 *     invc = LOG_INVC[i]                                    ; the high 32 bits only (see below)
 *     z = 1.f (mantissa)                                    ; 1 <= z < 2
 *     p = invc*z; r = p - 1; err = the exact product error of p
 *     log2(1+r) = r * (A + B r + C r^2) + r^4 * poly(r)     ; A = 1/ln2, B = -1/(2 ln2), ...
 *     loghi = (((k + LOG_LOGC[i]) + r*(A + C r^2 ...)) + r^4 poly)
 *     loghi &= 0xfffffffffffffffe                           ; (the shipped code clears the last
 *                                                           ; bit before the split)
 *     loglo = (k - loghi + LOG_LOGC[i] + <the same two terms>) + LOG_LOGC_LO[i] + <low part>
 *
 *   exp2(y * log2(x)) (0x570..0x608):
 *     t = (y*128) * loghi ; residual = the exact error of that product, plus (y*128)*loglo
 *     if (t > 131200) return +-inf ; if (t < -137600) return +-0      (0x578, 0x580)
 *     n = floor(t) ; z = t - n ; j = n & 127
 *     r = z + (residual - EXP_TAB[j].corr)                  ; note the *subtract*
 *     poly = r * ((((c0*z + c1)*z + c2)*r + c3)*r + c4)
 *     result = (2^(n>>8) + EXP_TAB[j].x) * (1 + poly) * 2^((n>>7) - (n>>8))
 *
 * The three things a source-level port gets wrong:
 *
 *  * the exp assembly is *bit-pattern* arithmetic, not floating point: `add d0, d0, d2` is an
 *    integer add of the two doubles' patterns (the 2^(n>>8) exponent field plus the table's
 *    mantissa), and the final scale `2^((n>>7)-(n>>8))` is built out of two masked `lsl`s of
 *    n that land in the exponent field.  The two-shift split is what keeps the exponent field
 *    in range for the whole n domain.
 *  * the log table's 16-byte entries are NOT two little-endian doubles.  The first 8 bytes are
 *    two 32-bit halves packed `{ high word of invc, high word of logc_lo }`, and only those
 *    high words are meaningful: the code loads the first with `ldr s2` + `shl.2d v2, v2, #32`
 *    (the low half is zero by construction) and the second with `and 0xffffffff00000000`.  The
 *    remaining 8 bytes are an ordinary little-endian double, logc_hi.  `logc_hi + logc_lo` is
 *    the *exact* `-log2(invc)` (minus one for the index >= 64 entries), while `invc` itself is
 *    a coarse hand-chosen reciprocal -- it only has to hold the reduction's |r| under 1/256.
 *  * the sign for a negative base with an odd integer exponent is not applied to the result:
 *    it is XORed into the pattern that carries `2^(n>>8)`, so it rides through both multiplies.
 *
 * One property of the dispatch is easy to misread: the fast path is *only* for a positive
 * normal x and a y in [2^-65, 2^64) (the second guard is an unsigned 64-bit subtract, so
 * every negative y lands in the ladder), and then the *signed* y drives the exponent
 * arithmetic -- the ladder sets no reciprocal and no `|y|` for the main path, because
 * `t = (y*128) * log2 x` is negative for a negative y and the two-shift exponent assembly
 * handles negative n directly.  The ladder's `|y|`, by contrast, is only ever used for the
 * range tests and the parity test (`fcvtzs` after clamping to 2^53, which is what makes the
 * `y` is an odd integer` question answerable at all).
 *
 * Which pieces are load bearing was settled by *experiment*, not by reading: on the 4,471-value
 * corpus, the `and 0xfffffffffffffffe` on loghi moves 28 values, the log table's logc_lo column
 * 108, the exp table's correction 1055, and replacing the exp assembly's integer pattern add
 * with an FP multiply 4262 -- it is not the same operation.
 */
#ifndef APPLE_POW_IMPL_H
#define APPLE_POW_IMPL_H

#include <math.h>
#include <stdint.h>
#include <string.h>

#include "apple_pow_table.h"

#define APOW_SIGN 0x8000000000000000ull
#define APOW_ONE  0x3ff0000000000000ull
#define APOW_INF  0x7ff0000000000000ull
#define APOW_2P53 0x4340000000000000ull
#define APOW_2P52 0x0010000000000000ull
#define APOW_MANT 0x000fffffffffffffull

static inline uint64_t apow_bits (double d) { uint64_t u; memcpy (&u, &d, 8); return u; }
static inline double apow_from (uint64_t u) { double d; memcpy (&d, &u, 8); return d; }

/* the packed log-table entry: the machine code loads its 8 bytes with `ldur` and masks them
 * with APOW_INVC_MASK (`and.16b`) to recover the logc_lo half, then reads the low half with
 * `ldr s2` + `shl.2d` to build invc.  `gen_pow_table.py` splits the same two halves into the
 * APOW_LOG_INVC and APOW_LOG_LOGC_LO columns, which is exactly what those two instructions
 * produce -- see the table header. */

/* LLVM's `fnmsub Dd,Dn,Dm,Da` is `Dn*Dm - Da` (the ARM manual's naming is the opposite; this
 * lane settled it by compiling every spelling and reading the encodings back -- raw/fmaenc2.c).
 * Every fused step is written out as an explicit fma() so nothing depends on the mnemonics. */
static inline double apow_madd (double n, double m, double a) { return fma (n, m, a); }
static inline double apow_nmsub (double n, double m, double a) { return fma (n, m, -a); }

static inline double apow_pow (double x, double y)
{
	uint64_t ux = apow_bits (x), uy = apow_bits (y), xsign = 0;
	uint64_t axb, ayb;
	double d0 = x, d1 = y, d2, d3, d4, d5, d6, d7, ax, ay;
	uint64_t scratch;
	int64_t k, n;

	/* ------------------------------------------------------------------ the dispatch */
	if (ux - APOW_2P52 >= 0x7fe0000000000000ull) goto special;          /* 0x418/0x428 */
	if (uy - 0x3be0000000000000ull > 0x0810000000000000ull) goto special;  /* 0x42c/0x440 */
	if ((ux & APOW_MANT) == 0) goto power_of_two;                        /* 0x444/0x448 */

	/* ------------------------------------------------------------------ log2 x */
logarithm:
	scratch = (((ux & APOW_MANT) + 0x100000000000ull) & 0x1fe00000000000ull) >> 41;
	k = (int64_t) (ux + APOW_K_BIAS) >> 52;                              /* 0x45c..0x464 */
	{
		size_t i = (size_t) (scratch >> 4);
		double invc = APOW_LOG_INVC[i];
		double z = apow_from (APOW_ONE | (ux & APOW_MANT));              /* 0x47c */
		d7 = 1.0;                                                        /* 0x488 */
		d0 = invc * z;                                                   /* 0x484 */
		d4 = apow_from (apow_bits (z) & 0xffffffffffe00000ull);          /* 0x48c */
		d3 = z - d4;                                                     /* 0x494 */
		d4 = apow_nmsub (invc, d4, d0);                                  /* 0x498 */
		d0 = d0 - d7;                                                    /* 0x49c: r */
		d2 = apow_madd (invc, d3, d4);                                   /* 0x4a0: the product error */
		d3 = apow_madd (d0, APOW_LOG_POLY[0], APOW_LOG_POLY[1]);         /* 0x4a4..0x4bc */
		d3 = apow_madd (d0, d3, APOW_LOG_POLY[2]);
		d3 = apow_madd (d0, d3, APOW_LOG_POLY[3]);
		d3 = apow_madd (d0, d3, APOW_LOG_POLY[4]);
		d4 = d0 * d0;                                                    /* 0x4c0 */
		d4 = d4 * d4;                                                    /* 0x4c4: r^4 */
		d3 = d4 * d3;                                                    /* 0x4c8 */
		/* log2(1+r)/r = A + B r + C r^2 + ..., carried as an accurate two-part value:
		   each fmadd's exact error is recovered with an fnmsub and folded into d7/d5 */
		d6 = apow_madd (APOW_LOG_H0, d0, APOW_LOG_H1);                   /* 0x4cc..0x4d8 */
		d7 = apow_madd (APOW_LOG_H0_LO, d0, APOW_LOG_H1_LO);
		d5 = d6 - APOW_LOG_H1;                                           /* 0x4dc */
		d5 = apow_nmsub (APOW_LOG_H0, d0, d5);                           /* 0x4e0 */
		d7 = apow_madd (APOW_LOG_H0, d2, d7);                            /* 0x4e4 */
		d7 = d5 + d7;                                                    /* 0x4e8 */
		d4 = apow_madd (d6, d0, APOW_LOG_A);                             /* 0x4ec..0x4f4 */
		d5 = apow_madd (d7, d0, APOW_LOG_A_LO);
		d7 = d4 - APOW_LOG_A;                                            /* 0x4f8 */
		d7 = apow_nmsub (d6, d0, d7);                                    /* 0x4fc */
		d5 = apow_madd (d6, d2, d5);                                     /* 0x500 */
		d5 = d7 + d5;                                                    /* 0x504 */
		d6 = d4 * d0;                                                    /* 0x508 */
		d5 = d5 * d0;                                                    /* 0x50c */
		d7 = apow_nmsub (d4, d0, d6);                                    /* 0x510 */
		d5 = apow_madd (d4, d2, d5);                                     /* 0x514 */
		d7 = d7 + d5;                                                    /* 0x518 */
		/* the hi/lo split (0x51c..0x558) */
		d2 = (double) k;                                                 /* 0x51c scvtf */
		d4 = APOW_LOG_LOGC[i];                                           /* 0x520 */
		d0 = (d2 + d4) + d6 + d3;                                        /* 0x524..0x52c */
		d0 = apow_from (apow_bits (d0) & APOW_LOG_HI_MASK);              /* 0x530/0x534 */
		d5 = (((d2 - d0) + d4) + d6) + d3;                               /* 0x538..0x544 */
		d2 = APOW_LOG_LOGC_LO[i];                                        /* 0x548..0x550 */
		d2 = d2 + d5 + d7;                                               /* 0x554/0x558 */
	}

	/* ------------------------------------------------------------------ exp2(y*log2 x) */
exp_part:
	d3 = APOW_SCALE;                                                          /* 0x55c */
	d1 = d1 * d3;                                                             /* 0x560: y*128 */
	d3 = d1 * d0;                                                             /* 0x564: t */
	d4 = apow_nmsub (d1, d0, d3);                                             /* 0x568 */
	d4 = apow_madd (d1, d2, d4);                                              /* 0x56c: the residual */
	goto exp_common;

power_of_two:                                                                 /* 0x60c */
	scratch = ux - APOW_ONE;
	if (scratch == 0) return apow_from (xsign | APOW_ONE);                    /* 0x610/0x614 */
	/* x = 2^k, so log2 x is an exact integer and 128*k needs no log reduction at all */
	d0 = (double) (int64_t) scratch * 0x1p-45;                                /* 0x618 scvtf #45 */
	d3 = d0 * d1;                                                             /* 0x61c */
	d4 = apow_nmsub (d0, d1, d3);                                             /* 0x620 */

exp_common:                                                                   /* 0x570 */
	if (d3 > APOW_T_MAX) goto overflow;                                       /* 0x578/0x57c */
	if (d3 < APOW_T_MIN) goto underflow;                                      /* 0x580/0x584 */
	d0 = floor (d3);                                                          /* 0x588 frintm */
	n = (int64_t) floor (d3);                                                 /* 0x58c fcvtms */
	d0 = d3 - d0;                                                             /* 0x590: z */
	{
		size_t j = (size_t) (n & 127);                                    /* 0x59c..0x5a0 */
		double a = APOW_EXP_TAB[j][0], b = APOW_EXP_TAB[j][1];
		d1 = d4 - b;                                                      /* 0x5a8 */
		d1 = d1 + d0;                                                     /* 0x5ac */
		d3 = apow_madd (APOW_EXP_POLY[0], d0, APOW_EXP_POLY[1]);          /* 0x5b0..0x5c8 */
		d3 = apow_madd (d3, d0, APOW_EXP_POLY[2]);
		d3 = apow_madd (d3, d1, APOW_EXP_POLY[3]);
		d3 = apow_madd (d3, d1, APOW_EXP_POLY[4]);
		d3 = d1 * d3;                                                     /* 0x5cc */
		/* the exponent-field assembly: 2^(n>>8) as a bare pattern, XORed with the sign,
		   integer-added to the table's 2^(j/128) pattern, then scaled by 2^((n>>7)-(n>>8)) */
		scratch = ((uint64_t) n << 44) & 0xfff0000000000000ull;            /* 0x5d0/0x5d4 */
		d5 = apow_from ((uint64_t) ((((uint64_t) n << 45) & 0xfff0000000000000ull) - scratch));  /* 0x5d8..0x5e0 */
		d0 = apow_from (scratch ^ xsign);                                 /* 0x5e4/0x5e8 */
		d0 = apow_from (apow_bits (d0) + apow_bits (a));                   /* 0x5ec: integer add */
		d0 = apow_madd (d0, d3, d0);                                       /* 0x5f0: *(1 + poly) */
		d5 = apow_from (apow_bits (d5) + APOW_ONE);                        /* 0x5f4/0x5f8 */
		return d0 * d5;                                                    /* 0x600 */
	}

	/* ------------------------------------------------------------------ the special ladder */
special:                                                                      /* 0x628 */
	if (ux == APOW_ONE) return x;                                              /* 0x62c..0x764 */
	if (uy == APOW_ONE) {                                                      /* 0x634..0x758 */
		if (x == x) return x;
		return x + x;                                                      /* 0x760 */
	}
	axb = ux & ~APOW_SIGN;                                                     /* 0x63c */
	ayb = uy & ~APOW_SIGN;                                                     /* 0x644 */
	ax = apow_from (axb);
	ay = apow_from (ayb);
	if (ayb == 0) goto ret_one;                                                /* 0x64c/0x64c */
	if (ayb >= APOW_INF) goto y_inf;                                           /* 0x650..0x658 */
	if (axb == 0) goto x_zero;                                                 /* 0x65c */
	if (axb >= APOW_INF) goto x_inf;                                           /* 0x660..0x664 */
	if (!(ux & APOW_SIGN)) goto y_range;                                       /* 0x668: x > 0 */
	/* x < 0: the result exists only for an integral y */
	if (ay < 1.0) goto invalid;                                                /* 0x66c..0x670 */
	/* the clamp goes to its own register (d2 in the machine code): the |y| range tests at
	   0x6b0/0x6b8 read the *unclamped* |y| */
	{
		double aclamp = apow_from (ayb < APOW_2P53 ? ayb : APOW_2P53);      /* 0x674..0x680 */
		double awhole = trunc (aclamp);                                    /* 0x684 frintz */
		if (awhole != aclamp) goto invalid;                                /* 0x688/0x68c */
		k = (int64_t) awhole;                                              /* 0x690 fcvtzs */
		if (k & 1) xsign = ux & APOW_SIGN;                                 /* 0x694/0x698 */
	}
	ux = axb;                                                                  /* 0x69c */
	d0 = ax;                                                                   /* 0x6a0 */

y_range:                                                                       /* 0x6a4 */
	if (ay > apow_from (APOW_Y_HUGE)) goto y_huge;                             /* 0x6b0/0x6b4 */
	if (ay < apow_from (APOW_Y_TINY)) goto y_tiny;                             /* 0x6b8/0x6bc */
	if (ux >= APOW_2P52) goto logarithm;                                       /* 0x6c0..0x6c8 */
	/* a subnormal base: normalise it into the exponent field, then take the log path
	   (`|x| | 1.0` - 1.0 is m * 2^-52, and the constant addition moves the exponent back
	   down by the 1022 the exponent field gained) */
	d0 = apow_from (apow_bits (d0) | APOW_ONE) - 1.0;                          /* 0x6cc/0x6d0 */
	ux = apow_bits (d0) + APOW_ZERO_BIAS;                                      /* 0x6d4..0x6dc */
	goto logarithm;                                                            /* 0x6e0 */

y_inf:                                                                         /* 0x6e4 */
	if (ayb > APOW_INF) return y + y;                                          /* 0x6e4..0x76c: NaN */
	if (axb == 0) goto x_zero;                                                 /* 0x6e8 */
	if (axb > APOW_INF) return x + x;                                          /* 0x6ec..0x760: NaN */
	scratch = axb - APOW_ONE;                                                  /* 0x6f4/0x6f8 */
	if (scratch == 0) goto ret_one;                                            /* 0x6f8..0x778 */
	scratch ^= uy;                                                             /* 0x6fc */
	/* x^+inf is +inf iff |x| > 1, x^-inf iff |x| < 1, and 0 otherwise (an infinite
	   exponent is not an odd integer, so the sign is never negative) */
	return apow_from (APOW_INF & ~(uint64_t) ((int64_t) scratch >> 63));       /* 0x700..0x70c */

x_inf:                                                                         /* 0x710 */
	if (axb > APOW_INF) return x + x;                                          /* 0x710..0x760: NaN */
	/* |x| is infinite: the `x == 0` block below is the machine code's shared handler */

x_zero:                                                                        /* 0x714 */
	if (ay >= 1.0) {                                                            /* 0x718 */
		double aclamp = apow_from (ayb < APOW_2P53 ? ayb : APOW_2P53);       /* 0x71c..0x724 */
		double awhole = trunc (aclamp);                                      /* 0x72c frintz */
		if (awhole == aclamp) {                                              /* 0x730/0x734 */
			if (((int64_t) awhole) & 1) {                                /* 0x738/0x73c */
				if (!(uy & APOW_SIGN)) return d0;                    /* 0x744: keeps x's sign */
				return 1.0 / d0;                                    /* 0x748/0x74c */
			}
		}
	}
	d0 = apow_from (axb);                                                       /* 0x740 */
	if (!(uy & APOW_SIGN)) return d0;
	return 1.0 / d0;

y_huge:                                                                        /* 0x798 */
	if (y < 0.0) {                                                             /* 0x79c */
		if (ax == 1.0) goto ret_one;                                       /* 0x7c8/0x778 */
		if (ax > 1.0) goto underflow;                                      /* 0x7cc/0x7ac */
		goto overflow;                                                     /* 0x7d0 */
	}
	if (ax == 1.0) goto ret_one;                                               /* 0x7a0/0x7a4 */
	if (ax > 1.0) goto overflow;                                               /* 0x7a8/0x7d0 */
	goto underflow;                                                            /* 0x7ac */

y_tiny:                                                                        /* 0x7e8 */
	{
		double one = apow_from (xsign | APOW_ONE);                         /* 0x7e8..0x7f4 */
		double tiny = apow_from (xsign | APOW_Y_TINY);
		if (y >= 0.0) {                                                    /* 0x7f8 */
			if (ax == 1.0) goto ret_one;                               /* 0x800/0x804 */
			return ax > 1.0 ? one + tiny : one - tiny;                 /* 0x808/0x824/0x80c */
		}
		if (ax == 1.0) goto ret_one;                                       /* 0x818/0x81c */
		return ax > 1.0 ? one - tiny : one + tiny;                         /* 0x820/0x80c, 0x824 */
	}

ret_one:                                                                       /* 0x778 */
	return apow_from (xsign | APOW_ONE);

invalid:                                                                       /* 0x788 */
	{
		double inf = apow_from (APOW_INF);
		return inf - inf;
	}

overflow:                                                                      /* 0x7d0 */
	{
		double t = apow_from (APOW_OVER_MUL);
		return t * apow_from (xsign | apow_bits (t));                      /* -> +-inf */
	}

underflow:                                                                     /* 0x7ac */
	{
		double t = apow_from (APOW_UNDER_MUL);
		return t * apow_from (xsign | apow_bits (t));                      /* -> +-0 */
	}
}

#endif
