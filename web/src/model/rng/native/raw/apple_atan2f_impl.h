/* The oracle's arm64 `atan2f`, transcribed instruction by instruction from the shipped machine
 * code.
 *
 *   clang -O2 -ffp-contract=off -I. atan2f_cand.c -o /tmp/atan2f_cand     (see atan2f_cand.c)
 *
 * Read off `objdump -d` of the 768-byte window `raw/atan2f_bytes.bin` (`raw/dump_libm5.c`, the
 * symbol at +0x40, so every address below is `atan2f`-relative), whose constants
 * `raw/gen_atan2f_table.py` extracts and checks -- nothing here is typed by hand.
 *
 * `atan2f(y, x)`, s0 = y, s1 = x (both `float`).  The whole function is a four-arm ladder on
 * `y` against `x` and `-x` -- the ratio is always evaluated on the *reduced* argument `r` with
 * `|r| <= 1` -- plus the axis/quadrant boundaries, which are answered with a constant:
 *
 *   fcmp s0, s1 ; b.pl                       ; y >= x (or unordered)
 *   y <  x, -x <  y  (s0 < s1 and -s1 < s0): r = y/x              ->  P(r)
 *   y <  x, -x >= y                         : r = x/y             -> -pi/2 - P(r)
 *                                             (-x == y exactly    -> -pi/4)
 *   y >= x, -x <  y  (s0 > s1 case)         : r = x/y             ->  pi/2 - P(r)
 *   y >= x, -x >= y  (x <= 0)               : r = y/x, |r| < 2^-22 -> +-pi_hi
 *                                             otherwise           -> sign(y)*pi + P(r)
 *                                             (-x == y exactly    -> +3pi/4)
 *   y == x                                  : +-pi/4, -3pi/4 (y < 0), or +-0/+-pi at the origin
 *   unordered (NaN on either side)          : s0 + s1
 *
 * `P(r)` is the double-interior polynomial in the *ratio*: both operands are converted to double
 * (`fcvt d0, s0` / `fcvt d1, s1`), the division is a double `fdiv`, and the polynomial is a
 * product of four quadratics in `u = r*r` -- packed two-at-a-time into `d` lanes and evaluated
 * with `fadd.2d`/`fmla.2d`, so each `fmla` is a *fused* `T + (u + A)*u`:
 *
 *   u  = r*r
 *   F0 = fma(u + T0, u, T2)      F1 = fma(u + T1, u, T3)
 *   F2 = fma(u + T4, u, T6)      F3 = fma(u + T5, u, T7)
 *   P  = (F0*F2)*T8 * ((F1*F3)*r)
 *
 * i.e. `P(r) = T8 * (u^2+T0 u+T2)(u^2+T4 u+T6)(u^2+T1 u+T3)(u^2+T5 u+T7) * r`.  The *pairing and
 * the order of the last three multiplies are load-bearing*: lane 0 is
 * `fl(fl(fl(F0*F2)*T8) * fl(fl(F1*F3)*r))`, so `(F0*F2)*T8` is rounded before it meets
 * `(F1*F3)*r`, and the two `fadd.2d` steps add the small `u + A` pairs, not `A + u^2`.  The
 * result is narrowed once (`fcvt s0, d0`).
 *
 * Three things a source-level port gets wrong:
 *
 *  * **it is not `f32(atan2)`.** The fit is only *float* accurate (`gen_atan2f_table.py`
 *    measures 0.36 float32 ulp over [-1,1]; the `u^1` coefficient is `-0.333331738`, 4.8e-6
 *    off the Taylor `-1/3`), so the shipped function disagrees with the correctly rounded
 *    `f32(atan2)` on ~15-20 % of arguments.  Reproducing the platform means reproducing the
 *    error.
 *  * the `x <= 0` arm's `|r| < 2^-22` branch (`fcmp d1, d3` / `b.mi`) answers the constant at
 *    `+0x290`, which is **`f32(pi)` rounded toward zero plus `2^-32`** (`0x1.921fb4008p+1`),
 *    *not* `pi`: this is where arm64's `atan2f(0, -1) == 0x40490fda` comes from (the correctly
 *    rounded value is `0x40490fdb`), and it is the whole of the census' measured +-pi family.
 *    `+pi/2`, `+-pi/4` and the `+-3pi/4` arms use the exact double constants.
 *  * the ladder's `b.pl`/`b.mi` are `N`-based: `pl` is `!(a < b)`, which is *also* taken when
 *    the comparison is unordered, and the `b.vs` at 0x11c is what actually catches a NaN -- so
 *    the NaN answer (`s0 + s1`) is only reached through the `y >= x` arm.  Written as plain
 *    comparisons the order matters, not just the predicates.
 *
 * A property worth recording: the four ladders are not four copies of the polynomial.  All four
 * share the *same* nine constants at `+0x220` (each block's `adr x2, <table>` differs only in
 * its immediate), and the three sign/quadrant corrections are applied as `fsub`/`fadd` on the
 * double *after* the polynomial, before the single narrowing.
 */
#ifndef APPLE_ATAN2F_IMPL_H
#define APPLE_ATAN2F_IMPL_H

#include <math.h>
#include <stdint.h>
#include <string.h>

#include "apple_atan2f_table.h"

static inline uint32_t aatan2f_bits (float f) { uint32_t u; memcpy (&u, &f, 4); return u; }
static inline float aatan2f_from (uint32_t u) { float f; memcpy (&f, &u, 4); return f; }

/* `|r| < 2^-22`: the `x <= 0` arm's small-argument branch.  The sign comes from the *bit
 * pattern* of y (`lsr w0, w0, #31`), so a negative zero counts as negative. */
static inline double aatan2f_small_pi (float y)
{
	return (aatan2f_bits (y) & 0x80000000u) ? -AATAN2F_PI_HI : AATAN2F_PI_HI;
}

/* the polynomial in the reduced ratio (0x20..0x6c and its three sibling blocks) */
static inline double aatan2f_poly (double r)
{
	const double *T = AATAN2F_POLY;
	double u = r * r;
	double f0 = fma (u + T[0], u, T[2]);      /* fmla.2d: T2 + (u + T0)*u, one rounding */
	double f1 = fma (u + T[1], u, T[3]);
	double f2 = fma (u + T[4], u, T[6]);
	double f3 = fma (u + T[5], u, T[7]);
	return ((f0 * f2) * T[8]) * ((f1 * f3) * r);
}

static inline float aatan2f (float y, float x)
{
	uint32_t wy = aatan2f_bits (y);

	if (!(y < x)) {
		/* 0x11c: y >= x, or unordered */
		if (y == x) {                                     /* 0x20c */
			if (!(y >= 0.0f)) return (float) AATAN2F_NEG_3PI4;
			if (y != 0.0f) return (float) AATAN2F_PI4;
			/* y == x == 0: +-0, or +-pi when x is a negative zero */
			if (aatan2f_bits (x) & 0x80000000u)
				return (float) aatan2f_small_pi (y);
			return y;                                     /* s0, untouched (b 0xb0) */
		}
		if (y != y || x != x) return y + x;                /* 0x24c: fadd s0, s0, s1 */
		if (!(-x < y)) {
			/* 0x188: x <= 0 and y <= -x */
			if (-x == y) return (float) AATAN2F_3PI4;      /* 0x204 */
			{
				double r = (double) y / (double) x;
				if (fabs (r) < AATAN2F_SMALL) return (float) aatan2f_small_pi (y);
				return (float) (aatan2f_poly (r)
						+ ((wy & 0x80000000u) ? AATAN2F_NEG_PI : AATAN2F_PI));
			}
		}
		{ /* 0xf0: -x < y, so |x| < y */
			double r = (double) x / (double) y;
			return (float) (AATAN2F_HPI - aatan2f_poly (r));
		}
	}

	if (!(-x < y)) {
		/* 0xb8: y < x and y <= -x */
		if (-x == y) return (float) AATAN2F_NEG_PI4;       /* 0x114 */
		{
			double r = (double) x / (double) y;
			return (float) (AATAN2F_NEG_HPI - aatan2f_poly (r));
		}
	}
	/* 0x20: y < x and -x < y */
	{
		double r = (double) y / (double) x;
		return (float) aatan2f_poly (r);
	}
}

#endif /* APPLE_ATAN2F_IMPL_H */
