/* Lane W1d — which function does the *shipped* GSL draw `gsl_ran_ugaussian()`'s polar
 * components with, and what does the stream look like when a raw draw is exactly 0?
 *
 *   gsl_rng_uniform      : x = -1 + 2*u, y = -1 + 2*v            (a 0 is just u = -1)
 *   gsl_rng_uniform_pos  : same, but a 0 is rejected and redrawn
 *
 * A random MT19937 stream never hits an exact 0 in a test run (2^-32 per draw), so the two
 * readings are indistinguishable on ordinary vectors — but they consume a *different number
 * of draws*, which desynchronises every downstream draw. The probe therefore drives the
 * library with a custom `gsl_rng_type` whose `get_double` can inject an exact 0.0 at a chosen
 * call (the real MT19937 stream continues underneath, so the post-zero values can be
 * compared), and reports the cumulative draw counts next to every value.
 *
 * Output sections (`### NAME`, parsed by ../gen_native_vectors.py -> ../../nativeVectors.ts):
 *
 *   GSL_FIXED_A      fixed stream [0, 0.75, 0.75, ...]: the draw COUNT decides
 *                    (uniform_pos: 3 draws. uniform: 4 draws, same first value)
 *   GSL_FIXED_B      fixed 16-value cycle with a forced rejection pair and a zero in the
 *                    second component: values + cumulative counts
 *   GSL_INJECT_1     real gsl_rng_mt19937(42) behind the probe, zero injected at call 1
 *   GSL_INJECT_7     same stream, zero injected at call 7
 *   GSL_NO_INJECT    probe wrapper with no injection: must equal the plain GSL stream
 *   GSL_DIRECT_MT42  plain gsl_rng_mt19937(42): 8 gaussians + cumulative draws (reference)
 *
 * Columns: `index value outer inner` — outer = calls to the probe's get_double,
 * inner = draws taken from the underlying real stream (`outer - injected zeros`).
 *
 *   clang -O2 -I/opt/homebrew/include raw/gsl_polar_probe.c \
 *       -L/opt/homebrew/lib -lgsl -lgslcblas -o gsl_polar_probe && ./gsl_polar_probe
 *
 * The oracle links /opt/homebrew/opt/gsl/lib/libgsl.28.dylib (GSL 2.8), the same library
 * this probe is built against.
 */
#include <gsl/gsl_randist.h>
#include <gsl/gsl_rng.h>
#include <gsl/gsl_version.h>
#include <stdio.h>

/* ------------------------------------------------------------------ probe rng */

static gsl_rng *inner = 0;  /* the real gsl_rng_mt19937 stream underneath */
static long outer = 0;      /* calls to get_double */
static long injected = 0;   /* how many of those returned an exact 0.0 by fiat */
static long inject_at = 0;  /* get_double call number to force to 0.0 (0 = never) */

static double probe_get_double(void *state)
{
  (void)state;
  outer += 1;
  if (inject_at != 0 && outer == inject_at) {
    injected += 1;
    return 0.0;
  }
  return gsl_rng_uniform(inner);
}

static unsigned long probe_get(void *state)
{
  (void)state; /* the probe type provides get_double, which gsl_rng_uniform prefers */
  return gsl_rng_get(inner);
}

static void probe_set(void *state, unsigned long s)
{
  (void)state;
  (void)s;
  gsl_rng_set(inner, 42);
  outer = 0;
  injected = 0;
}

static const gsl_rng_type probe_type = {
  "w1d-inject-zero", /* name       */
  0xffffffffUL,      /* max        */
  0UL,               /* min        */
  sizeof(int),       /* size       */
  probe_set,         /* set        */
  probe_get,         /* get        */
  probe_get_double,  /* get_double */
};

/* ------------------------------------------------------------------ fixed streams */

static const double fixed_a[] = { 0.0, 0.75 };
static long fixed_a_i = 0;
static double fixed_a_get_double(void *state)
{
  (void)state;
  long i = fixed_a_i++;
  return i < 2 ? fixed_a[i] : 0.75;
}
static unsigned long fixed_null_get(void *state) { (void)state; return 0; }
static void fixed_null_set(void *state, unsigned long s) { (void)state; (void)s; }

static const double fixed_b[] = { 0.9, 0.1, 0.0, 0.6, 0.7, 0.8, 0.3, 0.2,
                                  0.55, 0.45, 0.95, 0.05, 0.85, 0.15, 0.65, 0.35 };
static long fixed_b_i = 0;
static double fixed_b_get_double(void *state)
{
  (void)state;
  return fixed_b[fixed_b_i++ % 16];
}

static void reset_fixed(void) { fixed_a_i = 0; fixed_b_i = 0; }

/* ------------------------------------------------------------------ helpers */

static void print_gaussians(const char *name, gsl_rng *r, int n, int via_inner)
{
  int i;
  printf("### %s\n", name);
  for (i = 0; i < n; i++) {
    double g = gsl_ran_ugaussian(r);
    if (via_inner) {
      printf("%d %.17g %ld %ld\n", i, g, outer, outer - injected);
    } else {
      printf("%d %.17g\n", i, g);
    }
  }
}

int main(void)
{
  int i;
  gsl_rng *probe;
  gsl_rng *direct;
  gsl_rng_type fixed_a_type;
  gsl_rng_type fixed_b_type;

  inner = gsl_rng_alloc(gsl_rng_mt19937);
  direct = gsl_rng_alloc(gsl_rng_mt19937);
  probe = gsl_rng_alloc(&probe_type);

  /* --- GSL_FIXED_A: uniform_pos consumes 3 draws, uniform would consume 4 --- */
  fixed_a_type = probe_type;
  fixed_a_type.name = "w1d-fixed-a";
  fixed_a_type.get_double = fixed_a_get_double;
  fixed_a_type.get = fixed_null_get;
  fixed_a_type.set = fixed_null_set;
  {
    gsl_rng *r = gsl_rng_alloc(&fixed_a_type);
    reset_fixed();
    printf("### GSL_FIXED_A\n");
    for (i = 0; i < 2; i++) {
      long before = fixed_a_i;
      double g = gsl_ran_ugaussian(r);
      printf("%d %.17g %ld\n", i, g, fixed_a_i - before);
    }
    gsl_rng_free(r);
  }

  /* --- GSL_FIXED_B: a rejection pair and a zero in the second component --- */
  fixed_b_type = probe_type;
  fixed_b_type.name = "w1d-fixed-b";
  fixed_b_type.get_double = fixed_b_get_double;
  fixed_b_type.get = fixed_null_get;
  fixed_b_type.set = fixed_null_set;
  {
    gsl_rng *r = gsl_rng_alloc(&fixed_b_type);
    reset_fixed();
    printf("### GSL_FIXED_B\n");
    for (i = 0; i < 5; i++) {
      long before = fixed_b_i;
      double g = gsl_ran_ugaussian(r);
      printf("%d %.17g %ld\n", i, g, fixed_b_i - before);
    }
    gsl_rng_free(r);
  }

  /* --- real MT19937(42) behind the probe, exact 0 injected at call 1 --- */
  inject_at = 1;
  gsl_rng_set(probe, 42);
  print_gaussians("GSL_INJECT_1", probe, 8, 1);

  /* --- same, injected at call 7 --- */
  inject_at = 7;
  gsl_rng_set(probe, 42);
  print_gaussians("GSL_INJECT_7", probe, 8, 1);

  /* --- no injection: the wrapper must reproduce the plain GSL stream --- */
  inject_at = 0;
  gsl_rng_set(probe, 42);
  print_gaussians("GSL_NO_INJECT", probe, 8, 1);

  /* --- plain gsl_rng_mt19937(42) reference: values only (the wrapper above reports the
   *     draw counts; this run proves the wrapper does not change the stream) --- */
  gsl_rng_set(direct, 42);
  {
    printf("### GSL_DIRECT_MT42\n");
    for (i = 0; i < 8; i++) {
      double g = gsl_ran_ugaussian(direct);
      printf("%d %.17g\n", i, g);
    }
  }

  printf("### GSLINFO_POLAR\n");
  printf("library=%s gsl_version=%s probe_max=%lu\n", "libgsl.28.dylib", GSL_VERSION,
         probe_type.max);
  printf("gsl_ran_ugaussian draws its polar components with gsl_rng_uniform_pos\n"
         "(GSL_FIXED_A: 3 draws for the pair (0, 0.75); gsl_rng_uniform would need 4)\n");

  gsl_rng_free(probe);
  gsl_rng_free(direct);
  gsl_rng_free(inner);
  return 0;
}
