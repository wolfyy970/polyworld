/* The oracle's `powf`, transcribed instruction by instruction from the shipped machine code.
 *
 *   clang -O2 -ffp-contract=off -I. powf_cand.c -o powf_cand        (see powf_cand.c)
 *
 * Read off `objdump -d` of the 5120-byte dump `raw/powf_bytes.bin` (`raw/dump_libm4.c`, `powf`
 * at +0x400, so every address below is powf-relative) plus its data window
 * `raw/powf_tables.bin` (the 128-entry log table at +0x2c8f0 with its 4-double polynomial just
 * before it, the 128-entry exp table at +0x2bca0 with its 2-double polynomial, all ~180 kB
 * away from the code and reached by `adrp`+`add` pairs).  The tables themselves come from
 * `gen_powf_table.py` -- nothing here is typed by hand.
 *
 * `powf(x, y)`, s0 = x, s1 = y, w0 = bits(x), w1 = bits(y), w7 = the sign to apply at the end
 * (set only for a negative base with an odd integer exponent):
 *
 *   if (x == 1.0f) return x                                             (0x14 -> 0x22c)
 *   if (y == 1.0f) return x * 1.0f                                      (0x1c -> 0x224)
 *   if ((|y| bits - 1) >= 0x7f7fffff) goto yladder                        (0x3c)
 *       ; y is +-0, +-inf or NaN -- decided on the *bit pattern*, because |y| bits - 1
 *       ; overflows to 0xffffffff for y = +-0
 *   if (w0 - 0x800000  >=  0x7f000000) goto xladder                       (0x4c)
 *       ; x is not a positive normal: +-0, negative, +-inf, NaN, subnormal
 *
 * yladder (0x10c): signed(w2) > 0x7f7fffff -> return y (NaN); unsigned -> return +-1.0f
 *   (y = +-0 and y = +-inf -- the +-inf case is part of the *same* ladder as +-0, and it is
 *   the `x` tests below that decide the +-inf answer, `|y|` narrowed by a bit mask); then
 *   x = +-0 -> 0x1d0, x NaN -> x*1.0f, |x| == 1 -> +-1.0f, otherwise
 *   `|y| & ~mask` with `mask = asr32((|x| bits - 0x3f800000) ^ y bits, 31)`.
 *
 * xladder (0x150): |x| in {0} U [inf, NaN] -> 0x1d0; x positive subnormal -> 0x1b4 (normalise);
 *   x negative -> only an integer y has a real result, the odd ones keep the sign (w7).
 *
 * 0x1d0 (|x| = 0 or inf, y finite nonzero): `fabs` unless y is an odd integer, then `1/x` for
 *   y < 0.  The integer test is the clamp-to-2^24 + `frintz` + `fcmp` + `fcvtzs` sequence, so
 *   anything above 2^24 counts as even.
 *
 * the fast path (0x50..0x108), for a positive normal base and a finite nonzero exponent:
 *   `128*log2(x)` is formed from a *float-indexed, double-valued* reduction:
 *     m   = w0 - 0x3f338000
 *     i   = (m >> 16) & 0x7f                      ; the 7-bit bin index
 *     k   = asr32(m & 0xff800000, 16)             ; 128 * the binade, plus the bin's carry
 *     w4  = w0 - (m & 0xff800000)                 ; the *float* residual, 1.mantissa
 *     z   = (double) float(w4)
 *     r   = z * invc[i] - 1                       ; an `fnmsub` (LLVM's operand order!)
 *     L   = k + logc[i] + ((c0*r + c1)*r^2 + (c2*r + c3))*r
 *         = k + logc[i] + 128*log2(z * invc[i])
 *   so `L` is `128*log2` of the base *exactly* up to the polynomial, no cancellation --
 *   `logc[i]` is `-128*log2(invc[i])`, and the table's lattice is the two-block
 *   `1/invc = n/256` (see the generator).
 *
 *   t = (double)y * L; clamp to +-2^15 (the `fmin`/`fmax` pair); n = rinta(t) (the `frinta` +
 *   `fcvtas` pair -- round to nearest, ties away from zero); f = t - n; j = n & 0x7f; then
 *     bits = EXPT[j] + (n << 45)                  ; one 64-bit *integer* add, in `% 2^64`
 *     d3   = (double)bits                         ; == 2^(n/128): the table entry is
 *                                                 ; `bits(2^(j/128)) - (j << 45)`, so the add
 *                                                 ; shifts the binade exactly
 *     res  = d3 + d3 * f*(e0*f + e1)              ; 2^(f/128)
 *   narrowed once, `fcvt s0, d0`, then the sign is XORed into the *pattern* (`eor.8b`).
 *
 * The three things a source-level port gets wrong:
 *
 *  * `L` is 128-scaled.  `powf` computes `2^(t/128)`, not `2^t`: the exp table's granularity
 *    and the log polynomial's `128/ln2` leading coefficient are the same factor.
 *  * the exp assembly is *bit-pattern* arithmetic: `add x1, x2, x1, lsl #45` is an integer add
 *    of `n << 45` to the table entry's pattern.  It is exact because `bits(2^(j/128)) - j*2^45`
 *    is the entry (never negative, since `2^(j/128) - 1 > j/128` for j in [0,127]).
 *  * `fnmsub d0, d2, d0, d3` is `z*invc - 1` -- LLVM's operand order (`Dn*Dm - Da`), the
 *    opposite of what the ARM manual's naming suggests; the double `pow` transcription ran
 *    into the same thing.  Reading it as `1 - z*invc` gives a *wrong-signed* correction and
 *    moves ~2 % of the corpus.
 *
 * A property worth recording: unlike the double `pow`, `powf` has no special-case ladder for a
 * negative base of magnitude 1 and never forms a reciprocal of the base for the fast path; the
 * sign of a negative base rides in `w7` into the final `eor.8b`, i.e. after the narrowing.
 */
#ifndef APPLE_POWF_IMPL_H
#define APPLE_POWF_IMPL_H

#include <math.h>
#include <stdint.h>
#include <string.h>

#include "apple_powf_table.h"

#define APOWF_INF     0x7f800000u
#define APOWF_ONE     0x3f800000u
#define APOWF_2P23    0x00800000u
#define APOWF_2P24B   0x4b800000u
#define APOWF_NAN     0x7fc00000u

static inline uint32_t apowf_bits (float f) { uint32_t u; memcpy (&u, &f, 4); return u; }
static inline float apowf_from (uint32_t u) { float f; memcpy (&f, &u, 4); return f; }
static inline uint32_t apowf_u32 (uint32_t v) { return v; }

/* the machine's `sub`/`and`/`asr` on 32-bit words */
static inline int32_t apowf_asr16 (uint32_t v)
{
	/* `asr w2, w2, #16` on the 32-bit word: sign-extending */
	return (int32_t) v >> 16;
}

/* FRINTA + FCVTAS: round to nearest, ties away from zero (|t| <= 2^15 here, so the
 * `+ 0.5` is exact and the truncation is the machine's rounding). */
static inline int64_t apowf_rinta (double t)
{
	return (int64_t) (t + (t >= 0.0 ? 0.5 : -0.5));
}

static inline int apowf_y_parity (uint32_t w1)
{
	/* 0x168..0x198: `|y| >= 1`, `min(|y|, 2^24)`, `frintz`, `fcmp`, `fcvtzs`, `tbz #0`.
	 * Returns -1 when |y| is not an integer (the machine's 0x244 NaN), else the parity. */
	uint32_t ay = w1 & 0x7fffffffu;
	if (ay < APOWF_ONE) return -1;
	float s = apowf_from (ay < APOWF_2P24B ? ay : APOWF_2P24B);
	int32_t n = (int32_t) s;
	if ((float) n != s) return -1;
	return n & 1;
}

static inline float apowf_zero (uint32_t w0, uint32_t w1, uint32_t w7)
{
	/* 0x1d0: x = +-0 or +-inf (x NaN is handled by the callers) */
	uint32_t ab = w1 & 0x7fffffffu;
	float sc = apowf_from (ab < APOWF_2P24B ? ab : APOWF_2P24B);
	int32_t ni = (int32_t) sc;
	int keep = ((float) ni == sc && (ni & 1) != 0);
	float s0 = keep ? apowf_from (w0) : fabsf (apowf_from (w0));
	if (w1 & 0x80000000u) s0 = 1.0f / s0;
	return s0;
}

static inline float apowf_fast (uint32_t w0, float y, uint32_t w7)
{
	uint32_t m = w0 - (uint32_t) APOWF_LOG_BIAS;
	uint32_t idx = (m >> 16) & 0x7fu;
	uint32_t hi = m & 0xff800000u;
	uint32_t w4 = w0 - hi;
	int32_t k = apowf_asr16 (hi);
	float zf = apowf_from (w4);                       /* fcvt d2, s2 */
	double z = (double) zf;
	double invc = APOWF_LOG_INVC[idx];
	double r = fma (z, invc, -1.0);                   /* fnmsub: Dn*Dm - Da */
	double d7 = APOWF_LOG_LOGC[idx] + (double) k;     /* fadd d7, d7, scvtf(k) */
	double d2 = r * r;
	double d3 = fma (r, APOWF_LOG_POLY[0], APOWF_LOG_POLY[1]);
	double d5 = fma (r, APOWF_LOG_POLY[2], APOWF_LOG_POLY[3]);
	d3 = fma (d3, d2, d5);
	double L = fma (d3, r, d7);
	double t = (double) y * L;
	if (!(t <= APOWF_T_CLAMP)) t = APOWF_T_CLAMP;     /* fmin */
	if (!(t >= -APOWF_T_CLAMP)) t = -APOWF_T_CLAMP;   /* fmax */
	int64_t n = apowf_rinta (t);
	double f = t - (double) n;
	uint32_t j = (uint32_t) ((uint64_t) n & 0x7fu);
	uint64_t bits = APOWF_EXP_TAB[j] + ((uint64_t) n << 45);   /* the integer pattern add */
	double d3v;
	memcpy (&d3v, &bits, 8);
	double p = fma (APOWF_EXP_POLY[0], f, APOWF_EXP_POLY[1]);
	double res = fma (p * f, d3v, d3v);
	float out = (float) res;                          /* fcvt s0, d0 */
	return apowf_from (apowf_bits (out) ^ w7);        /* eor.8b: the sign, applied last */
}

static inline float apowf_powf (float x, float y)
{
	uint32_t w0 = apowf_bits (x), w1 = apowf_bits (y), w7 = 0;

	if (x == 1.0f) return x;                          /* 0x14 -> 0x22c (the fmul is skipped) */
	if (y == 1.0f) return x * 1.0f;                   /* 0x1c -> 0x224 */

	uint32_t w2 = (w1 & 0x7fffffffu) - 1u;
	if (w2 >= APOWF_FLT_MAX) {
		/* 0x10c: y is +-0, +-inf or NaN */
		if ((int32_t) w2 > (int32_t) APOWF_FLT_MAX) return y;       /* NaN y */
		if (w2 > APOWF_FLT_MAX) return apowf_from (w7 | APOWF_ONE); /* +-0 / +-inf -> 1.0f */
		uint32_t ax = w0 & 0x7fffffffu;
		if (ax == 0) return apowf_zero (w0, w1, w7);
		if (ax > APOWF_INF) return x * 1.0f;                        /* NaN x */
		if (ax == APOWF_ONE) return apowf_from (w7 | APOWF_ONE);    /* |x| == 1 */
		{
			uint32_t mask = (uint32_t) ((int32_t) ((ax - APOWF_ONE) ^ w1) >> 31);
			return apowf_from (apowf_bits (fabsf (y)) & ~mask);
		}
	}
	if (w0 - APOWF_2P23 >= 0x7f000000u) {
		/* 0x150: x is not a positive normal */
		uint32_t ax = w0 & 0x7fffffffu;
		uint32_t w3 = ax - 1u;
		if (w3 >= APOWF_FLT_MAX) {
			if ((int32_t) w3 > (int32_t) APOWF_FLT_MAX) return x * 1.0f;   /* NaN x */
			return apowf_zero (w0, w1, w7);                                /* +-0 / +-inf */
		}
		if (w0 & 0x80000000u) {
			/* x < 0: only an integer y is real, and only an odd one keeps the sign */
			int par = apowf_y_parity (w1);
			if (par < 0) return apowf_from (APOWF_NAN);
			if (par == 1) w7 = 0x80000000u;
		}
		w0 = ax;                                                       /* 0x1a0: continue with |x| */
		if (w0 >= APOWF_2P23) return apowf_fast (w0, y, w7);
		/* 0x1b4: normalise the positive subnormal */
		{
			float s0 = apowf_from (apowf_bits (apowf_from (w0)) | APOWF_ONE) - 1.0f;
			w0 = apowf_bits (s0) - 0x3f000000u;
		}
		return apowf_fast (w0, y, w7);
	}
	return apowf_fast (w0, y, w7);
}

#endif /* APPLE_POWF_IMPL_H */
