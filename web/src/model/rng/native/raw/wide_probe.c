/* Wide-range log corpus + a direct check of the FMA emulation vs the hardware fma. */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <gsl/gsl_rng.h>

static inline uint64_t fbits (double d) { uint64_t u; memcpy (&u, &d, 8); return u; }
static inline double ffrom (uint64_t u) { double d; memcpy (&d, &u, 8); return d; }

static inline double two_prod_err (double a, double b)
{
	double p = a * b;
	double ca = 134217729.0 * a, cb = 134217729.0 * b;
	double ah = ca - (ca - a), bh = cb - (cb - b);
	double al = a - ah, bl = b - bh;
	return ((ah * bh - p) + ah * bl + al * bh) + al * bl;
}

static inline double emul_fma (double a, double b, double c)
{
	double p = a * b;
	double e = two_prod_err (a, b);
	double s = p + c;
	double bb = s - p;
	double t = (p - (s - bb)) + (c - bb);
	double u = t + e;
	return s + u;
}

int main (void)
{
	gsl_rng *g = gsl_rng_alloc (gsl_rng_mt19937);
	gsl_rng_set (g, 987654321);

	printf ("### LOG_WIDE\n");
	for (int e = -1070; e <= 1020; e += 7)
		{
			double m = 1.0 + gsl_rng_uniform (g);          /* [1,2) */
			double x = ldexp (m, e);
			if (x > 0.0 && !isinf (x)) printf ("%.17g %.17g\n", x, log (x));
		}
	/* exact powers of two and their neighbours, extremes, subnormals */
	for (int e = -1074; e <= 1023; e += 1)
		{
			double x = ldexp (1.0, e);
			if (x > 0.0 && !isinf (x)) printf ("%.17g %.17g\n", x, log (x));
			if (e > -1074 && x > 0.0) printf ("%.17g %.17g\n", nextafter (x, 0.0), log (nextafter (x, 0.0)));
			if (e < 1023) printf ("%.17g %.17g\n", nextafter (x, INFINITY), log (nextafter (x, INFINITY)));
		}
	for (double x = 5e-324; x < 1e-300; x *= 3.0) printf ("%.17g %.17g\n", x, log (x));
	/* near 1 from both sides */
	for (int i = 1; i <= 2000; i++)
		{
			double d = i * 1.0e-16;
			printf ("%.17g %.17g\n", 1.0 + d, log (1.0 + d));
			printf ("%.17g %.17g\n", 1.0 - d, log (1.0 - d));
		}
	for (int i = 1; i <= 2000; i++)
		{
			double d = i * 1.0e-8;
			printf ("%.17g %.17g\n", 1.0 + d, log (1.0 + d));
			printf ("%.17g %.17g\n", 1.0 - d, log (1.0 - d));
		}
	/* smooth sweep over (0,1) and (1,2) with dense irrationals */
	for (int i = 1; i <= 3000; i++)
		{
			double x = (double) i / 3001.0;
			printf ("%.17g %.17g\n", x, log (x));
			printf ("%.17g %.17g\n", 1.0 + x, log (1.0 + x));
		}
	for (int i = 1; i <= 3000; i++)
		{
			double x = exp (gsl_rng_uniform (g) * 700.0 - 350.0);
			printf ("%.17g %.17g\n", x, log (x));
		}

	printf ("### FMA_STATS\n");
	{
		long bad = 0, n = 0;
		/* the triples the algorithm actually forms: |a| <= ~2, b in the table range,
		   c of any magnitude up to 1e3 */
		for (long i = 0; i < 2000000; i++)
			{
				double a = (gsl_rng_uniform (g) - 0.5) * 4.0;
				double b = (gsl_rng_uniform (g) - 0.5) * pow (10.0, (int) (gsl_rng_uniform (g) * 12) - 6);
				double c = (gsl_rng_uniform (g) - 0.5) * pow (2.0, (int) (gsl_rng_uniform (g) * 40) - 20);
				double hw = fma (a, b, c), em = emul_fma (a, b, c);
				n++;
				if (memcmp (&hw, &em, 8) != 0) bad++;
			}
		printf ("triples=%ld  emul!=hw %ld\n", n, bad);
	}
	return 0;
}
