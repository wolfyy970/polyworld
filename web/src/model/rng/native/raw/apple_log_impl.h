/* The transcribed shipped-libm `log` (macOS 26.5.2, arm64), as a header so both the corpus
 * driver and the filter tool share it.  Compile with -DEMULATE_FMA to use the portable
 * fma emulation instead of the hardware fma. */
#ifndef APPLE_LOG_IMPL_H
#define APPLE_LOG_IMPL_H

#include <stdint.h>
#include <string.h>
#include <math.h>
#include "apple_log_tables.h"

static inline uint64_t al_fbits (double d) { uint64_t u; memcpy (&u, &d, 8); return u; }
static inline double al_ffrom (uint64_t u) { double d; memcpy (&d, &u, 8); return d; }

static inline double al_two_prod_err (double a, double b)
{
	double p = a * b;
	double ca = 134217729.0 * a, cb = 134217729.0 * b;
	double ah = ca - (ca - a), bh = cb - (cb - b);
	double al = a - ah, bl = b - bh;
	return ((ah * bh - p) + ah * bl + al * bh) + al * bl;
}

static inline double al_emul_fma (double a, double b, double c)
{
	double p = a * b;
	double e = al_two_prod_err (a, b);
	double s = p + c;
	double bb = s - p;
	double t = (p - (s - bb)) + (c - bb);
	double u = t + e;
	return s + u;
}

#ifdef EMULATE_FMA
#define AL_FMA(a, b, c) al_emul_fma ((a), (b), (c))
#else
#define AL_FMA(a, b, c) fma ((a), (b), (c))
#endif

static double apple_log (double x)
{
	uint64_t ix = al_fbits (x);
	uint64_t x2 = ix - 0x10000000000000ULL;
	uint64_t mant, idx;
	int64_t k;
	double d0, d1, c0, c1, c2, c3, c4, c5, d4, d16, d18, d19, d20, d21, e0, e1, e2, z;

	if (x2 >= 0x7fe0000000000000ULL)
		{
			if (isnan (x)) return x;
			if (x == 0.0) return -INFINITY;
			if (x < 0.0) return NAN;
			if ((int64_t) x2 >= 0) return x; /* +inf */
			d0 = al_ffrom (0x3ff0000000000000ULL | ix);
			d0 = d0 - 1.0;
			ix = al_fbits (d0) + 0xC020000000000000ULL;
		}

	k = (int64_t) (K_BIAS + ix) >> 52;
	mant = ix & 0xfffffffffffffULL;
	idx = (0x100000000000ULL + mant) >> 45;
	e0 = APPLE_LOG_TAB[idx][0];
	e1 = APPLE_LOG_TAB[idx][1];
	e2 = APPLE_LOG_TAB[idx][2];
	z = al_ffrom (0x3ff0000000000000ULL | mant);

	d1 = AL_FMA (z, e0, -1.0);
	c0 = APPLE_LOG_POLY[0]; c1 = APPLE_LOG_POLY[1]; c2 = APPLE_LOG_POLY[2];
	c3 = APPLE_LOG_POLY[3]; c4 = APPLE_LOG_POLY[4]; c5 = APPLE_LOG_POLY[5];
	d16 = AL_FMA (d1, c1, c0);
	d19 = d1 + c3;
	d21 = d1 + c5;
	d4 = d1 * d1;
	d18 = AL_FMA (d1, d19, c2);
	d20 = AL_FMA (d1, d21, c4);
	d4 = d4 * d16;
	d4 = d4 * d18;
	d4 = d4 * d20;

	if (k == 0)
		{
			double d5 = e0 * z;
			double d6 = d5 - 1.0;
			double d5e = AL_FMA (e0, z, -d5);
			double dmask = al_ffrom (al_fbits (d6) & D6_MASK);
			double d2 = d6 - dmask;
			double out;
			d2 = d5e + d2;
			out = dmask + e1;
			d2 = d2 + e2;
			d2 = d2 + d4;
			out = out + d2;
			return out;
		}
	else
		{
			double kf = (double) k;
			double d2 = AL_FMA (kf, al_ffrom (C7), e2);
			double d3 = AL_FMA (kf, al_ffrom (C6), e1);
			d2 = d2 + d4;
			d1 = d1 + d2;
			d0 = d3 + d1;
			return d0;
		}
}

#endif
