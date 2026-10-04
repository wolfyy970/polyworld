// W1d native RNG probe — prints exact vectors for the PRNG surface, in full
// precision, from the same libc/GSL the oracle binary uses.
//
//   clang++ -std=c++17 -Ipolyworld/src/library/utils \
//       rng_probe.cc polyworld/.bld/library/utils/misc.o \
//       -I/opt/homebrew/include -L/opt/homebrew/lib -lgsl -lgslcblas -o rng_probe
//
// nrand() comes from the native tree's compiled utils/misc.o (unmodified).

#include <stdio.h>
#include <stdlib.h>
#include <limits.h>
#include <gsl/gsl_rng.h>
#include <gsl/gsl_randist.h>
#include <gsl/gsl_version.h>

double nrand();
double nrand(double mean, double stdev);

static const int SEED = 42;

static void section(const char* name) { printf("\n### %s\n", name); }

int main(int argc, char** argv)
{
	printf("# RAND_MAX=%d sizeof_long=%zu\n", RAND_MAX, sizeof(long));
	printf("# gsl_version=%s\n", GSL_VERSION);

	/* ---- 1. rancheck replica (byte-identical to bin/rancheck stdout) ---- */
	section("RANCHECK");
	{
		int i;
		srand(SEED);
		srand48(SEED);
		srandom(SEED);
		gsl_rng *gsl = gsl_rng_alloc(gsl_rng_mt19937);
		gsl_rng_set(gsl, SEED);
		for (i = 0; i < 10; i++)
			printf("%d:  srand = %10d,  drand48 = %06.4f,  random = %10ld,  gsl = %lf\n",
				   i, rand(), drand48(), random(), gsl_rng_uniform(gsl));
		gsl_rng_free(gsl);
	}

	/* ---- 2. rand() exact ---- */
	section("RAND");
	srand(SEED);
	for (int i = 0; i < 10; i++) printf("%d %d\n", i, rand());
	section("RAND_SEED1");
	srand(1);
	for (int i = 0; i < 5; i++) printf("%d %d\n", i, rand());

	/* ---- 3. drand48()/lrand48() exact ---- */
	section("DRAND48");
	srand48(SEED);
	for (int i = 0; i < 12; i++) printf("%d %.17g\n", i, drand48());
	section("LRAND48");
	srand48(SEED);
	for (int i = 0; i < 12; i++) printf("%d %ld\n", i, lrand48());
	section("DRAND48_SEED0");
	srand48(0);
	for (int i = 0; i < 5; i++) printf("%d %.17g\n", i, drand48());
	section("DRAND48_INTERLEAVED");
	/* lrand48 and drand48 share one LCG state; check the draw order. */
	srand48(SEED);
	for (int i = 0; i < 6; i++)
	{
		long l = lrand48();   /* explicit order: lrand48 first, then drand48 */
		double d = drand48();
		printf("%d %ld %.17g\n", i, l, d);
	}

	/* ---- 4. random()/srandom() exact (TYPE_3 additive feedback) ---- */
	section("RANDOM");
	srandom(SEED);
	for (int i = 0; i < 10; i++) printf("%d %ld\n", i, random());
	section("RANDOM_SEED1");
	srandom(1);
	for (int i = 0; i < 5; i++) printf("%d %ld\n", i, random());
	section("RANDOM_SEED0");
	srandom(0);
	for (int i = 0; i < 5; i++) printf("%d %ld\n", i, random());

	/* ---- 5. MT19937 + GSL uniform mapping ---- */
	section("GSLINFO");
	{
		gsl_rng *gsl = gsl_rng_alloc(gsl_rng_mt19937);
		printf("name=%s min=%lu max=%lu size=%zu\n", gsl_rng_name(gsl),
			   gsl_rng_min(gsl), gsl_rng_max(gsl), gsl_rng_size(gsl));
		gsl_rng_free(gsl);
	}
	section("GSL_UNIFORM_42");
	{
		gsl_rng *gsl = gsl_rng_alloc(gsl_rng_mt19937);
		gsl_rng_set(gsl, SEED);
		for (int i = 0; i < 12; i++) printf("%d %.17g\n", i, gsl_rng_uniform(gsl));
		gsl_rng_free(gsl);
	}
	section("GSL_UNIFORM_0");
	{
		gsl_rng *gsl = gsl_rng_alloc(gsl_rng_mt19937);
		gsl_rng_set(gsl, 0);
		for (int i = 0; i < 5; i++) printf("%d %.17g\n", i, gsl_rng_uniform(gsl));
		gsl_rng_free(gsl);
	}
	section("GSL_UNIFORM_1");
	{
		gsl_rng *gsl = gsl_rng_alloc(gsl_rng_mt19937);
		gsl_rng_set(gsl, 1);
		for (int i = 0; i < 5; i++) printf("%d %.17g\n", i, gsl_rng_uniform(gsl));
		gsl_rng_free(gsl);
	}
	section("GSL_UNIFORM_BIGSEED");
	{
		gsl_rng *gsl = gsl_rng_alloc(gsl_rng_mt19937);
		gsl_rng_set(gsl, 4294967295L);
		for (int i = 0; i < 5; i++) printf("%d %.17g\n", i, gsl_rng_uniform(gsl));
		gsl_rng_free(gsl);
	}
	section("GSL_UNIFORM_POS_42");
	{
		gsl_rng *gsl = gsl_rng_alloc(gsl_rng_mt19937);
		gsl_rng_set(gsl, SEED);
		for (int i = 0; i < 12; i++) printf("%d %.17g\n", i, gsl_rng_uniform_pos(gsl));
		gsl_rng_free(gsl);
	}
	section("GSL_UGAUSSIAN_42");
	{
		gsl_rng *gsl = gsl_rng_alloc(gsl_rng_mt19937);
		gsl_rng_set(gsl, SEED);
		for (int i = 0; i < 12; i++) printf("%d %.17g\n", i, gsl_ran_ugaussian(gsl));
		gsl_rng_free(gsl);
	}
	section("GSL_RANGE_42");
	{
		gsl_rng *gsl = gsl_rng_alloc(gsl_rng_mt19937);
		gsl_rng_set(gsl, SEED);
		for (int i = 0; i < 8; i++)
			printf("%d %.17g\n", i, 10.0 + gsl_rng_uniform(gsl) * (20.0 - 10.0));
		gsl_rng_free(gsl);
	}

	/* ---- 6. nrand() (Marsaglia polar over drand48, static spare) ---- */
	section("NRAND_42");
	srand48(SEED);
	for (int i = 0; i < 12; i++) printf("%d %.17g\n", i, nrand());
	section("NRAND_DRAWCOUNT");
	{
		/* First nrand() consumes two drand48 draws; the second call is free
		   (returns the spare).  Print the raw stream around it. */
		srand48(SEED);
		double a = nrand();
		double afterFirst = drand48();
		double b = nrand();
		double afterSecond = drand48();
		printf("nrand0=%.17g\n", a);
		printf("drand48_after_nrand0=%.17g\n", afterFirst);
		printf("nrand1=%.17g\n", b);
		printf("drand48_after_nrand1=%.17g\n", afterSecond);
	}
	section("NRAND_SCALED_42");
	srand48(SEED);
	for (int i = 0; i < 6; i++) printf("%d %.17g\n", i, nrand(100.0, 15.0));

	/* ---- 7. interp()/rrand() forms ---- */
	section("INTERP");
	{
		srand48(SEED);
		for (int i = 0; i < 5; i++)
		{
			double x = drand48();
			printf("%d %.17g %.17g\n", i, x, 10.0 + x * (20.0 - 10.0));
		}
	}

	return 0;
}
