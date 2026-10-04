// W1d native vector probe #2 — seed coverage for every stream, plus a large
// log() corpus used to validate the port's correctly-rounded log.
//
//   clang++ -std=c++17 -O0 -I/opt/homebrew/include rng_vectors.cc \
//       -L/opt/homebrew/lib -lgsl -lgslcblas -o rng_vectors
//   ./rng_vectors > rng_vectors.out

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <gsl/gsl_rng.h>

static const unsigned seeds[] = { 0u, 1u, 2u, 42u, 12345u, 2147483647u, 4294967295u };
static const char *seedNames[] = { "0", "1", "2", "42", "12345", "2147483647", "4294967295" };
#define NSEEDS (sizeof(seeds) / sizeof(seeds[0]))

int main(void)
{
	for (unsigned s = 0; s < NSEEDS; s++)
	{
		printf("### RAND_SEED %s\n", seedNames[s]);
		srand(seeds[s]);
		for (int i = 0; i < 5; i++) printf("%d\n", rand());

		printf("### DRAND48_SEED %s\n", seedNames[s]);
		srand48((long)seeds[s]);
		for (int i = 0; i < 5; i++) printf("%.17g\n", drand48());

		printf("### LRAND48_SEED %s\n", seedNames[s]);
		srand48((long)seeds[s]);
		for (int i = 0; i < 5; i++) printf("%ld\n", lrand48());

		printf("### RANDOM_SEED %s\n", seedNames[s]);
		srandom(seeds[s]);
		for (int i = 0; i < 5; i++) printf("%ld\n", random());

		printf("### MT_SEED %s\n", seedNames[s]);
		{
			gsl_rng *g = gsl_rng_alloc(gsl_rng_mt19937);
			gsl_rng_set(g, seeds[s]);
			for (int i = 0; i < 5; i++) printf("%.17g\n", gsl_rng_uniform(g));
			gsl_rng_free(g);
		}
	}

	/* large log() corpus: 120k inputs, mixed magnitudes, for CI-free validation */
	printf("### LOG_BIG\n");
	{
		srand48(20260928);
		gsl_rng *g = gsl_rng_alloc(gsl_rng_mt19937);
		gsl_rng_set(g, 20260928);
		for (int i = 0; i < 60000; i++)
		{
			double x = drand48();                       /* (0,1): nrand/gaussian domain */
			if (x > 0.0) printf("%.17g %.17g\n", x, log(x));
			double y = gsl_rng_uniform(g);              /* (0,1) from MT */
			if (y > 0.0) printf("%.17g %.17g\n", y, log(y));
		}
		for (int i = 0; i < 20000; i++)
		{
			double x = drand48() * 1000.0;              /* (0,1000) */
			if (x > 0.0) printf("%.17g %.17g\n", x, log(x));
		}
		for (int i = 1; i <= 20000; i++)
		{
			double x = 1.0 + i * 1.0e-14;               /* near 1 from above */
			printf("%.17g %.17g\n", x, log(x));
			double z = (double)i / 20000.0;             /* dense in (0,1) */
			printf("%.17g %.17g\n", z, log(z));
		}
		gsl_rng_free(g);
	}
	return 0;
}
