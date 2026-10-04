/* The oracle's `sin` and `cos`, transcribed instruction by instruction from the shipped
 * machine code.
 *
 *   clang -O2 -ffp-contract=off -I. sincos_cand.c -o sincos_cand     (see sincos_cand.c)
 *
 * `sin` and `cos` are one unit in libsystem_m: `sin` is at the symbol, `cos` at +0x16c, and
 * they share the polynomial tails, the Payne-Hanek continuations and the data.  Read off
 * `objdump -d` of the 5120-byte dump `raw/sincos_bytes.bin` (`raw/dump_libm2.c`; the
 * line-by-line reading is in this lane's PORT-NOTE):
 *
 *   sin(x), ux = bits(x), ax = |x|:
 *     if (x == 0) return x                                  ; fcmp/fabs/b.eq
 *     if (ax <= pi/4)              return sin_tail(0, x)     ; d6 = 0, d7 = x
 *     if (ax < 524288.61698514968)                           ; the medium reduction
 *         n = rint(x * 2/pi), i = (int64) n
 *         r = x - n*pi2hi; d6 = r - n*pi2mid
 *         d7 = ((r - d6) - n*pi2mid) - n*pi2lo
 *         x10 = (i << 62) & 2^63
 *         return (i & 1) ? cos_tail(d6, d7, x10) : sin_tail(d6, d7, x10)
 *     if (!(ax < inf)) return x - x                          ; inf/nan
 *     <Payne-Hanek, below>
 *
 *   cos(x): the same shape with ax everywhere (cos is even), `x10 = ((i ^ (i>>1)) << 63)`,
 *   and the opposite tail selection (`tst x0,#1; b.eq 0x808`).
 *
 *   sin_tail(d6, d7, x10):                      cos_tail(d6, d7, x10):
 *     r = d6 + d7                                 z = 2*(d6*d7) + d6^2        (fma)
 *     z = r*r                                     out = 1 + z*poly_cos(z)     (fma, 7 coeffs)
 *     out = d6 + (r*(z*poly_sin(z)) + d7)         return flip(out, x10)
 *     return flip(out, x10)
 *
 *   `flip(v, x10)` is the sign toggle: `eor.16b v0, v0, v10` in the sin tail, and
 *   `add d0, d0, x10` in the cos tail -- an INTEGER add of the double's pattern (+-0.0), which
 *   is an XOR of bit 63.
 *
 *   Payne-Hanek (|x| >= 524288.61698514968).  x = M*2^(e-52) with M in [2^52,2^53):
 *     x9 = bits(ax) << 11 | 2^63        ; == M << 11: the significand as fixed point
 *     k = e >> 6, s = e & 63
 *     (w0..w3) = ASC_TAB[15-k .. 18-k]  ; four consecutive 1/pi words, LITTLE-endian
 *     if (s) { t = 64 - s;  x4 = (w0>>t)|(w1<<s); x5 = (w1>>t)|(w2<<s); x6 = (w2>>t)|(w3<<s); }
 *     else   { x4 = w1; x5 = w2; x6 = w3; }
 *     (x1:x0) = the top 128 bits of the 192x64-bit product (x6:x5:x4) * x9   (umulh/mul/adc)
 *     x2c   = -(bit 61 of x1)            ; `asr x2, x1<<2, #63` -- the one's complement
 *     x10   = sin: bits(x) ^ x1 ; cos: x1 ^ (x1<<1)          ; then & 2^63
 *     cos_tail? = bit61(x1) ^ bit62(x1)  ; sin: `b.mi`, cos: `b.pl`
 *     v = (x1 ^ x2c) & 0x1fffffffffffffff                     ; drop three quadrant bits
 *     clz = clz(v)                       ; >= 3, because the mask keeps 61 bits
 *     x1 = (v << clz) | ((x0 ^ x2c) >> (64 - clz))
 *     ; the two continuations, both feeding the ORIGINAL x10:
 *     sin:  x4 = umulh(MAGIC, x1)
 *           d0 = (double) x4 / 2^61     with `clz` subtracted from its EXPONENT field
 *           d6 = the same for x4 & 0xffff000000000000
 *           d7 = the same for x4 & 0x0000ffffffffffff
 *           out = d6 + (d0*(d0^2 * poly_sin(d0^2)) + d7)
 *     cos:  x3 = umulh(MAGIC, umulh(MAGIC, x1))
 *           z  = (double) x3 / 2^58     with `2*clz` subtracted from its exponent field
 *           out = 1 + z*poly_cos(z)
 *
 * Four things a source-level port gets wrong:
 *
 *  * the mask+normalise is not a scale change: the continuations read the *normalised*
 *    mantissa but then undo the factor 2^clz by subtracting `clz << 52` from the converted
 *    double's bit pattern -- an integer SUB on a double register (the vector-integer `sub`
 *    the compiler emits), i.e. an exact division by a power of two.  The cos continuation
 *    subtracts `2*clz << 52`, because its value is squared and so carries the normalisation
 *    twice.
 *  * the windows are LITTLE-endian: the word at the lowest address (`sin-0x50-8k`) is the
 *    least significant of the four, and the 256-bit slice is `floor(1/pi * 2^(64(k+3)))`.
 *    Reading them the other way round gives a value that is 64 bits off.
 *  * both sign flips are bit-pattern operations, not FP ones.
 *  * the flip must be applied exactly once: the tails flip, and the Payne-Hanek
 *    continuations return through the same flip, so the caller must not flip again.
 */
#ifndef APPLE_SINCOS_IMPL_H
#define APPLE_SINCOS_IMPL_H

#include <math.h>
#include <stdint.h>
#include <string.h>

#include "apple_sincos_table.h"

#define ASC_SIGN 0x8000000000000000ull

static inline uint64_t asc_bits (double d) { uint64_t u; memcpy (&u, &d, 8); return u; }
static inline double asc_from (uint64_t u) { double d; memcpy (&d, &u, 8); return d; }

static inline uint64_t asc_umulh (uint64_t a, uint64_t b)
{
	return (uint64_t) (((unsigned __int128) a * (unsigned __int128) b) >> 64);
}

/* `sub Dd, Dd, Xscale` with Xscale = clz << 52: an integer SUB of the double's bit pattern,
 * i.e. the exact division by 2^clz the machine code performs to undo the normalisation. */
static inline double asc_unscale (double v, uint64_t clz)
{
	return asc_from (asc_bits (v) - (clz << 52));
}

/* the sign toggle both tails end with (XOR of bit 63) */
static inline double asc_flip (double v, uint64_t x10)
{
	return asc_from (asc_bits (v) ^ (x10 & ASC_SIGN));
}

static inline double asc_sin_eval (double r, double d6, double d7)
{
	double z = r * r;
	double p = ASC_SIN_POLY[0];
	for (int i = 1; i < 6; i++) p = fma (z, p, ASC_SIN_POLY[i]);
	return d6 + fma (r, z * p, d7);
}

/* `1 + z*poly(z)` -- the cos polynomial in its own variable */
static inline double asc_cos_poly (double z)
{
	double p = ASC_COS_POLY[0];
	for (int i = 1; i < 7; i++) p = fma (z, p, ASC_COS_POLY[i]);
	return fma (z, p, 1.0);
}

static inline double asc_cos_eval (double d6, double d7)
{
	return asc_cos_poly (fma (d6, d6, 2 * (d6 * d7)));
}

/* the cos-poly continuation (0x78c) */
static inline double asc_ph_cos (uint64_t x, uint64_t clz, uint64_t x10)
{
	uint64_t x3 = asc_umulh (ASC_MAGIC, x);
	x3 = asc_umulh (x3, x3);                 /* `umulh x3, x3, x3`: the square */
	return asc_flip (asc_cos_poly (asc_unscale ((double) x3 * 0x1p-58, clz + clz)), x10);
}

/* the sin-poly continuation (0x674) */
static inline double asc_ph_sin (uint64_t x, uint64_t clz, uint64_t x10)
{
	uint64_t x4 = asc_umulh (ASC_MAGIC, x);
	double d0 = asc_unscale ((double) x4 * 0x1p-61, clz);
	double d6 = asc_unscale ((double) (x4 & 0xffff000000000000ull) * 0x1p-61, clz);
	double d7 = asc_unscale ((double) (x4 & 0x0000ffffffffffffull) * 0x1p-61, clz);
	return asc_flip (asc_sin_eval (d0, d6, d7), x10);
}

/* Returns the flipped result; `want_sin` selects sin's (signed bits, `b.mi`) or cos's
 * (|x|, `b.pl`) flavour.  The inf/nan row is handled by the caller (`x - x`). */
static inline double asc_ph (uint64_t ux, int want_sin)
{
	uint64_t e = ((ux & ~ASC_SIGN) >> 52) - 0x3ff;
	uint64_t x9 = ASC_SIGN | (ux << 11);
	uint64_t k = e >> 6, s = e & 63;
	const uint64_t *w = &ASC_TAB[15 - k];
	uint64_t x4, x5, x6;
	if (s) {
		uint64_t t = 64 - s;
		x4 = (w[0] >> t) | (w[1] << s);
		x5 = (w[1] >> t) | (w[2] << s);
		x6 = (w[2] >> t) | (w[3] << s);
	} else {
		x4 = w[1]; x5 = w[2]; x6 = w[3];
	}
	uint64_t h4 = asc_umulh (x4, x9);
	uint64_t l5 = x5 * x9;
	uint64_t a = h4 + l5;                       /* adds, setting the carry */
	uint64_t x0 = a;
	uint64_t x1 = asc_umulh (x5, x9) + (x6 * x9) + (a < h4 ? 1u : 0u);   /* adc */
	uint64_t x2c = (uint64_t) -((int64_t) ((x1 >> 61) & 1));
	uint64_t x10 = (want_sin ? (ux ^ x1) : (x1 ^ (x1 << 1))) & ASC_SIGN;
	int test = (int) ((((x1 << 2) ^ (x1 << 1)) >> 63) & 1);
	int cos_tail = want_sin ? test : !test;
	uint64_t v = (x1 ^ x2c) & 0x1fffffffffffffffull;
	uint64_t clz = (uint64_t) __builtin_clzll (v);
	x1 = (v << clz) | ((x0 ^ x2c) >> (64 - clz));
	return cos_tail ? asc_ph_cos (x1, clz, x10) : asc_ph_sin (x1, clz, x10);
}

static inline double apple_sin (double x)
{
	if (x == 0.0) return x;
	double ax = fabs (x);
	if (ax <= ASC_PI4) return asc_sin_eval (x, 0.0, x);
	if (ax < ASC_THRESH) {
		double t = x * ASC_INV_PI2;
		double n = rint (t);
		int64_t i = (int64_t) n;
		double r = x - n * ASC_PI2_HI;
		double d6 = r - n * ASC_PI2_MID;
		double d7 = ((r - d6) - n * ASC_PI2_MID) - n * ASC_PI2_LO;
		uint64_t x10 = ((uint64_t) i << 62) & ASC_SIGN;
		return (i & 1) ? asc_flip (asc_cos_eval (d6, d7), x10)
			       : asc_flip (asc_sin_eval (d6 + d7, d6, d7), x10);
	}
	if (!(ax < INFINITY)) return x - x;
	return asc_ph (asc_bits (x), 1);
}

static inline double apple_cos (double x)
{
	double ax = fabs (x);
	if (ax <= ASC_PI4) return asc_cos_eval (ax, 0.0);
	if (ax < ASC_THRESH) {
		double t = ax * ASC_INV_PI2;
		double n = rint (t);
		int64_t i = (int64_t) n;
		double r = ax - n * ASC_PI2_HI;
		double d6 = r - n * ASC_PI2_MID;
		double d7 = ((r - d6) - n * ASC_PI2_MID) - n * ASC_PI2_LO;
		uint64_t x10 = ((uint64_t) (i ^ (i >> 1))) << 63;
		return (i & 1) ? asc_flip (asc_sin_eval (d6 + d7, d6, d7), x10)
			       : asc_flip (asc_cos_eval (d6, d7), x10);
	}
	if (!(ax < INFINITY)) return ax - ax;
	return asc_ph (asc_bits (ax), 0);
}

#endif
