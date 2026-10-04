/* Lane W1d — the wide sample behind the `gsl_ran_ugaussian` claim: 100,000 gaussians per
 * seed from a real `gsl_rng_mt19937`, printed with %.17g so the port can be compared
 * bit-for-bit. The output is NOT committed (it is ~2 MB); it is regenerated on demand:
 *
 *   clang -O2 -I/opt/homebrew/include raw/gsl_gaussian_sweep.c \
 *       -L/opt/homebrew/lib -lgsl -lgslcblas -o gsl_gaussian_sweep
 *   ./gsl_gaussian_sweep 42 100000 > /tmp/gsl_gauss_42.txt
 *
 * The TypeScript side prints the same stream from `Mt19937` (see native/README.md §3).
 */
#include <gsl/gsl_randist.h>
#include <gsl/gsl_rng.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv)
{
  unsigned long seed = argc > 1 ? strtoul(argv[1], 0, 10) : 42UL;
  long n = argc > 2 ? strtol(argv[2], 0, 10) : 100000L;
  gsl_rng *r = gsl_rng_alloc(gsl_rng_mt19937);
  long i;
  gsl_rng_set(r, seed);
  for (i = 0; i < n; i++) {
    printf("%.17g\n", gsl_ran_ugaussian(r));
  }
  gsl_rng_free(r);
  return 0;
}
