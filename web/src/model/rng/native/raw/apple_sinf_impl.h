/* The oracle's `sinf` and `cosf`, transcribed instruction by instruction from the shipped
 * machine code.
 *
 *   clang -O2 -ffp-contract=off -I. sinf_cand.c -o sinf_cand     (see sinf_cand.c)
 *
 * Read off `objdump -d` of `raw/sinf_bytes.bin` (the 5120-byte window `raw/dump_libm3.c`
 * dumps; `sinf` is at +0x400 in it, `cosf` at +0x2f0).  `sinf`, `cosf` and `sincosf` (at
 * +0x1ac) share one reduction table and three polynomial tables; this file transcribes the
 * two scalar entry points the camera calls (`CameraController.cc:78-80` passes a C++ float).
 *
 *   sinf(x):
 *     if (x == +-0) return x                              ; through the tiny path below
 *     if (|x| < 2^-12)  return fmaf(x, 2^26, x) * 2^-26    ; the tiny-argument correction
 *     if (|x| < pi/4)   return sin_tail(x)                 ; plain polynomial
 *     if (|x| < 120)    n = rint(x * 2/pi)
 *                       r = x - n*(pi/2)                   ; single-part, one fused step
 *                       return quadrant(r, n)
 *     if (|x| >= inf)   return x - x                       ; NaN
 *     i = (bits(|x|) >> 24) - 0x40                         ; one table entry per *two*
 *     r = frac(x*hi) + x*lo                                ; exponents; A/2^(2i-23) is the
 *     return quadrant_pi(r, rint(x*hi))                    ; dyadic ghost of 1/pi
 *
 *   cosf(x) is the same shape with |x| from the start and two differences: the medium range
 *   splits at 2^26 instead of 120 (from 120 up it subtracts a *two-part* pi/2), and every
 *   quadrant index is `n + 1` -- cos(x) = sin(x + pi/2), and the index is only ever read for
 *   its two low bits.
 *
 *   quadrant(r, i):
 *     if (i & 1) cos_tail(r) else sin_tail(r), then XOR bit 63 with ((i >> 1) & 1) << 63,
 *     and narrow to float32 (`fcvt s0, d0`).
 *
 *   quadrant_pi(r, n) is the same but the tails are one `sin(pi*r)/r` polynomial factored as
 *   c4*(r^4 + c0 r^2 + c2)*(r^4 + c1 r^2 + c3) and the sign is `n & 1` -- because this
 *   reduction is modulo *pi*, not pi/2.  Its sign flip is an integer XOR of the *value's*
 *   bit pattern (`eor.8b v3, v0, v3` with v0 = r), so it rides through the multiply as a
 *   `+-r` factor; the medium tails' flip is `eor.8b v0, v0, v1` on the finished result, with
 *   `fmov d1, x0` moving the mask into the FP register first.
 *
 * Five things a source-level port gets wrong:
 *
 *  * the large-argument reduction multiplies by `1/pi - A/2^s`, *not* by `1/pi`.  A/2^s is the
 *    dyadic approximation of 1/pi whose denominator divides x for every float32 of the
 *    entry's exponent, so `x*(hi+lo)` differs from `x/pi` by an exact integer and the rint()
 *    yields x/pi's own quadrant.  Using the plain 1/pi constant destroys the reduction (and
 *    the entries are per-exponent-pair for exactly that reason).
 *  * the cosf medium index is `n+1` while the reduction still uses `n`: the shipped code adds
 *    one to the *merged* index and never computes the +pi/2.  (The vectorised `sincosf` at
 *    +0x1ac does the same thing with the roles of the two lanes swapped.)
 *  * `fmadd s0, s0, s2, s0` in the tiny path is a *single*-precision fused step, and the
 *    following `fmul s0, s0, s4` a single-precision multiply: `2^26` and `2^-26` are read as
 *    32-bit literals (`ldr s2`/`ldr s4`), not as doubles.
 *  * the sin tail's polynomial is evaluated in the order the machine code does, with `r^5`,
 *    `r^3` and `r` in different roles than the `sin(r) = r + r^3*poly(r^2)` shape suggests:
 *    `r + r^3*c2 + r^5*(c1 + r^2*c0)`, three mul/fma steps, each rounded once.
 *  * the cos tail is `1 + z*(z^2*(z*c0 + c1) + (z*c2 + c3))` with z = r^2 -- a nested form
 *    whose intermediate rounding is visible at the last bit.
 */
#ifndef APPLE_SINF_IMPL_H
#define APPLE_SINF_IMPL_H

#include <math.h>
#include <stdint.h>
#include <string.h>

#include "apple_sinf_table.h"

static inline uint32_t asf_fbits (float f) { uint32_t u; memcpy (&u, &f, 4); return u; }
static inline float asf_ffrom (uint32_t u) { float f; memcpy (&f, &u, 4); return f; }
static inline uint64_t asf_dbits (double d) { uint64_t u; memcpy (&u, &d, 8); return u; }
static inline double asf_dfrom (uint64_t u) { double d; memcpy (&d, &u, 8); return d; }

/* `eor.8b v0, v0, v1` with the mask in v1: bit 63 of the double, i.e. a sign toggle. */
static inline double asf_xor (double v, uint64_t mask)
{
	return asf_dfrom (asf_dbits (v) ^ mask);
}

/* sin(r) = r + r^3*(c1 + r^2*c0) + r^5*... -- the shipped tail, r^2/r^3/r^5 in its roles. */
static inline double asf_sin_poly (double r)
{
	double z = r * r;
	double r3 = r * z;
	double a = fma (z, ASF_SIN_POLY[0], ASF_SIN_POLY[1]);
	double r5 = z * r3;
	double b = fma (r3, ASF_SIN_POLY[2], r);
	return fma (r5, a, b);
}

/* cos(r) = 1 + z*(z^2*(z*c0 + c1) + (z*c2 + c3)), z = r^2 */
static inline double asf_cos_poly (double r)
{
	double z = r * r;
	double a = fma (z, ASF_COS_POLY[0], ASF_COS_POLY[1]);
	double b = fma (z, ASF_COS_POLY[2], ASF_COS_POLY[3]);
	double c = z * z;
	double d = fma (c, a, b);
	return fma (z, d, 1.0);
}

/* the pi/2-reduction tail: pick the tail by bit 0 of the quadrant, flip by bit 1 */
static inline float asf_quadrant (double r, int64_t i)
{
	uint64_t mask = ((uint64_t) i >> 1) << 63;
	double out = (i & 1) ? asf_cos_poly (r) : asf_sin_poly (r);
	return (float) asf_xor (out, mask);
}

/* the large-argument (mod pi) tail, shared by the table paths of both overloads */
static inline float asf_pi_tail (double d4, double d5)
{
	double nd = rint (d4);
	int64_t n = (int64_t) nd;
	double r = (d4 - nd) + d5;
	/* the sign rides through the multiply as a +-r factor (an integer XOR of r's bits) */
	double sr = asf_xor (r, (uint64_t) n << 63);
	double z = r * r;
	double a = z + ASF_SINPI_POLY[0];
	double b = z + ASF_SINPI_POLY[1];
	double p = fma (z, a, ASF_SINPI_POLY[2]);
	double q = fma (z, b, ASF_SINPI_POLY[3]);
	return (float) ((sr * p) * (ASF_SINPI_POLY[4] * q));
}

/* sinf's tiny path (`fmadd s0, s0, s2, s0` + `fmul s0, s0, s4`, both single precision) */
static inline float asf_sin_tiny (float x)
{
	return fmaf (x, ASF_C2P26B, x) * ASF_C2M26;
}

/* cosf's tiny path: (2^26 - |x|) * 2^-26, i.e. 1 - |x|*2^-26, which rounds to 1.0f */
static inline float asf_cos_tiny (float ax)
{
	return (ASF_C2P26B - ax) * ASF_C2M26;
}

static inline float apple_sinf (float x)
{
	uint32_t w0 = asf_fbits (x) & 0x7fffffffu;
	double d0, t, nd;

	if (w0 >= 0x42f00000u) {                                /* |x| >= 120.0f */
		if (w0 >= ASF_INF_BITS) return (float) (x - x); /* +-inf / NaN */
		const double *e = ASF_TAB[(w0 >> 24) - 0x40];
		d0 = (double) x;
		return asf_pi_tail (d0 * e[0], d0 * e[1]);
	}
	if (w0 < 0x3f490fdbu) {                                 /* |x| < pi/4 */
		if (w0 < 0x39800000u) return asf_sin_tiny (x);  /* |x| < 2^-12 */
		return (float) asf_sin_poly ((double) x);
	}
	/* pi/4 <= |x| < 120: one-part pi/2 reduction */
	d0 = (double) x;
	t = d0 * ASF_INV_PI2;
	nd = rint (t);
	return asf_quadrant (fma (-nd, ASF_PI2_HI, d0), (int64_t) nd);
}

static inline float apple_cosf (float x)
{
	float ax = fabsf (x);
	uint32_t w0 = asf_fbits (ax);
	double d0, t, nd, r;

	if (w0 >= 0x42f00000u) {                                /* |x| >= 120.0f */
		if (w0 >= 0x4c800000u) {                        /* |x| >= 2^26 */
			if (w0 >= ASF_INF_BITS) return (float) (ax - ax);
			const double *e = ASF_TAB[(w0 >> 24) - 0x40];
			d0 = (double) ax;
			r = d0 * e[0];
			return asf_pi_tail (r + 0.5, d0 * e[1]);
		}
		/* 120 <= |x| < 2^26: a two-part pi/2 */
		d0 = (double) ax;
		t = d0 * ASF_INV_PI2;
		nd = rint (t);
		r = fma (-nd, ASF_PI2_HI, d0);
		return asf_quadrant (fma (-nd, ASF_PI2_LO, r), (int64_t) nd + 1);
	}
	if (w0 < 0x3f490fdbu) {                                 /* |x| < pi/4 */
		if (w0 < 0x39800000u) return asf_cos_tiny (ax); /* |x| < 2^-12 */
		return (float) asf_cos_poly ((double) ax);
	}
	/* pi/4 <= |x| < 120: one-part reduction, index n+1 (cos(x) = sin(x + pi/2)) */
	d0 = (double) ax;
	t = d0 * ASF_INV_PI2;
	nd = rint (t);
	return asf_quadrant (fma (-nd, ASF_PI2_HI, d0), (int64_t) nd + 1);
}

/* `__sincosf_stret`'s two-lane tail: `(sin, cos)` of `pi*(n + u)/2` for a reduced argument `u`
 * and quadrant `n` (the vectorised polynomial the shipped code evaluates in one 2-lane pass). */
static inline void asf_sincos_tail (double u, int64_t n, float *sp, float *cp)
{
	double z = u * u;
	/* v5 = [t6, t7] + z*[z+t0, z+t1], v6 = [t8, t9] + z*[z+t2, z+t3], v1 = [u*t4, t5] */
	double ev0 = fma (z, z + ASF_SINCOS_POLY[0], ASF_SINCOS_POLY[6]);
	double ev1 = fma (z, z + ASF_SINCOS_POLY[1], ASF_SINCOS_POLY[7]);
	double od0 = fma (z, z + ASF_SINCOS_POLY[2], ASF_SINCOS_POLY[8]);
	double od1 = fma (z, z + ASF_SINCOS_POLY[3], ASF_SINCOS_POLY[9]);
	/* the lanes are narrowed to float32 (`fcvtn`) *before* the sign is applied */
	float f0 = (float) ((u * ASF_SINCOS_POLY[4]) * ev0 * od0);
	float f1 = (float) (ASF_SINCOS_POLY[5] * ev1 * od1);
	if (n & 2) {
		f0 = -f0;                                        /* fneg.2s v0, v0 */
		f1 = -f1;
	}
	if (n & 1) {
		*sp = f1;                                        /* mov s0, v0[1] / fneg s1, v0[0] */
		*cp = -f0;
	} else {
		*sp = f0;
		*cp = f1;
	}
}

/* `__sincosf_stret( float )` -- the two-output entry point the native `CameraController`
 * actually calls (`CameraController.cc:78-80` has adjacent `sin(camrad)`/`cos(camrad)` calls
 * and LLVM's sincos combine merges them; the shipped libpolyworld calls it directly).  It
 * reduces *modulo pi/2 with the doubled argument*: the medium path never subtracts n*pi/2 from
 * x, it takes `u = t - rint(t)` with `t = x*2/pi` and lets the quadrant do the work, and the
 * table path feeds the same tail `2x` instead of `x`. */
static inline void apple_sincosf (float x, float *sp, float *cp)
{
	uint32_t w0 = asf_fbits (x) & 0x7fffffffu;

	if (w0 >= 0x42f00000u) {                                 /* |x| >= 120.0f */
		if (w0 >= ASF_INF_BITS) {                        /* the inf/NaN row (0x6c4) */
			/* `fsub s0, s0, s0` leaves NaN in s0 (= v0[0]) and `mov s1, v0[0]`
			 * copies it into the cosine -- both outputs are NaN, measured. */
			float nan = (float) (x - x);
			*sp = nan;
			*cp = nan;
			return;
		}
		const double *e = ASF_TAB[(w0 >> 24) - 0x40];
		double d0 = (double) x;
		d0 = d0 + d0;                                    /* fadd d0, d0, d0 -- 2x, exact */
		double d4 = d0 * e[0];
		double nd = rint (d4);
		asf_sincos_tail ((d4 - nd) + d0 * e[1], (int64_t) nd, sp, cp);
		return;
	}
	if (w0 < 0x39800000u) {                                  /* |x| < 2^-12 (0x6a0) */
		*cp = (ASF_C2P26B - fabsf (x)) * ASF_C2M26;
		*sp = fmaf (x, ASF_C2P26B, x) * ASF_C2M26;
		return;
	}
	/* pi/4..120 and beyond: `t = x*2/pi`, `u = t - rint(t)`, no pi/2 subtraction at all */
	double t = (double) x * ASF_INV_PI2;
	double nd = rint (t);
	asf_sincos_tail (t - nd, (int64_t) nd, sp, cp);
}

#endif
