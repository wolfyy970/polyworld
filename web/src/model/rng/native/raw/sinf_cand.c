/* The C transcription's driver: same interface as `libm_census`, so a diff is a diff.
 *
 *   clang -O2 -ffp-contract=off sinf_cand.c -o sinf_cand
 *   (cd raw && /tmp/sinf_cand < libm_args_sinf.txt | diff - libm_native_sinf.txt)
 *   (cd raw && /tmp/sinf_cand < libm_args_cosf.txt | diff - libm_native_cosf.txt)
 *
 * `-ffp-contract=off` is deliberate: the source writes every fused step as an explicit
 * `fma()`/`fmaf()`, so the only contractions that can appear are the ones this file asks for.
 * The argument the corpus stores is the *double* its float32 value promotes to (that is what
 * `libm_census` did too), so it is cast back to float here and the float result is printed
 * promoted, exactly like the native rows.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "apple_sinf_impl.h"

static uint64_t d2b (double d) { union { double d; uint64_t u; } v; v.d = d; return v.u; }
static double b2d (uint64_t u) { union { double d; uint64_t u; } v; v.u = u; return v.d; }

int main (void)
{
	char line[512];
	while (fgets (line, sizeof line, stdin)) {
		char fn[16];
		char ha[32];
		if (sscanf (line, "%15s %31s", fn, ha) < 2) continue;
		uint64_t a = strtoull (ha, 0, 16);
		if (!strcmp (fn, "sinf"))
			printf ("sinf %016llx %016llx\n", (unsigned long long) a,
				(unsigned long long) d2b ((double) apple_sinf ((float) b2d (a))));
		else if (!strcmp (fn, "cosf"))
			printf ("cosf %016llx %016llx\n", (unsigned long long) a,
				(unsigned long long) d2b ((double) apple_cosf ((float) b2d (a))));
		else
			fprintf (stderr, "sinf_cand: only sinf/cosf, not '%s'\n", fn);
	}
	return 0;
}
