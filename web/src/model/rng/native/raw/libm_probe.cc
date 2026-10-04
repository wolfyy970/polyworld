// W1d native libm probe — is the 1-ulp divergence in log()?
//
//   clang++ -std=c++17 -O0 -I/opt/homebrew/include libm_probe.cc \
//       -L/opt/homebrew/lib -lgsl -lgslcblas -o libm_probe
//
// Emits (input, log(input)) pairs for the exact inputs nrand()/gsl_ran_ugaussian()
// feed to log(), plus a deterministic corpus covering log's branches.

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <gsl/gsl_rng.h>
#include <gsl/gsl_randist.h>

int main(void)
{
	/* ---- 1. log() inputs from nrand(seed 42) (Marsaglia polar over drand48) ---- */
	printf("### NRAND_INPUTS\n");
	srand48(42);
	for (int i = 0; i < 10; i++)
	{
		double u, v, s, c;
		do
		{
			u = 2.0 * drand48() - 1.0;
			v = 2.0 * drand48() - 1.0;
			s = u * u + v * v;
		} while (s == 0.0 || s >= 1.0);
		c = sqrt(-2.0 * log(s) / s);
		printf("%d s=%.17g log=%.17g c=%.17g val=%.17g\n", i, s, log(s), c, c * u);
	}

	/* ---- 2. log() inputs from gsl_ran_ugaussian(seed 42) ---- */
	printf("### GAUSS_INPUTS\n");
	{
		gsl_rng *gsl = gsl_rng_alloc(gsl_rng_mt19937);
		gsl_rng_set(gsl, 42);
		for (int i = 0; i < 10; i++)
		{
			double x, y, r2;
			do
			{
				x = -1 + 2 * gsl_rng_uniform(gsl);
				y = -1 + 2 * gsl_rng_uniform(gsl);
				r2 = x * x + y * y;
			} while (r2 > 1.0 || r2 == 0);
			printf("%d r2=%.17g log=%.17g val=%.17g\n", i, r2, log(r2),
				   1.0 * y * sqrt(-2.0 * log(r2) / r2));
		}
		gsl_rng_free(gsl);
	}

	/* ---- 3. corpus: branch coverage of e_log.c ---- */
	printf("### LOG_CORPUS\n");
	{
		/* uniform-ish draws in (0,1): the domain nrand/gaussian use */
		srand48(987654321);
		for (int i = 0; i < 400; i++)
		{
			double x = drand48();
			if (x > 0.0) printf("%.17g %.17g\n", x, log(x));
		}
		/* the "close to 1" branch: |f| < 2^-20 */
		for (int i = 1; i <= 60; i++)
		{
			double d = i * 1.0e-17;
			printf("%.17g %.17g\n", 1.0 + d, log(1.0 + d));
			printf("%.17g %.17g\n", 1.0 - d, log(1.0 - d));
		}
		/* the s-table branches: spread across magnitudes */
		for (int i = 1; i <= 60; i++)
		{
			double x = i / 71.0;
			printf("%.17g %.17g\n", x, log(x));
			printf("%.17g %.17g\n", x * 4294967296.0, log(x * 4294967296.0));
			printf("%.17g %.17g\n", x / 4294967296.0, log(x / 4294967296.0));
		}
		/* powers of two and neighbours, extremes, subnormals */
		double specials[] = {
			0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 0.75, 1.25, 1.9999999999999998, 1.0000000000000002,
			1e-300, 1e-308, 5e-324, 1e-320, 1e300, 1e308, 1.7976931348623157e308,
			2.2250738585072014e-308, 4.450147717014403e-308, 0.99999999999999989,
			6.661338147750939e-16, 1.1102230246251565e-16, 3.141592653589793,
			2.718281828459045, 1.4142135623730951, 0.7071067811865476,
		};
		for (unsigned i = 0; i < sizeof(specials) / sizeof(double); i++)
			printf("%.17g %.17g\n", specials[i], log(specials[i]));
		/* exp(1) scaled: exercise the polynomial branch (i>0) hard */
		srand48(13579);
		for (int i = 0; i < 400; i++)
		{
			double x = drand48() * 100.0;   /* (0,100) */
			if (x > 0.0) printf("%.17g %.17g\n", x, log(x));
		}
	}

	/* ---- 4. other transcendentals the RNG surface touches ---- */
	printf("### FMA_CHECK\n");
	{
		volatile double a = 1.0000000000000002, b = 2.9999999999999996, c = -3.0;
		printf("a*b+c=%.17g fma=%.17g\n", a * b + c, fma(a, b, c));
	}
	return 0;
}
