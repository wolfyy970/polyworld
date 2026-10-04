/* The C transcription's driver: same interface as `libm_census`, so a diff is a diff.
 *
 *   clang -O2 -ffp-contract=off -I. powf_cand.c -o powf_cand
 *   (cd raw && /tmp/powf_cand < libm_args_powf.txt | diff - libm_native_powf.txt)
 *
 * The corpus hands the arguments over as *doubles* (the census casts them to `float`, which is
 * what the C++ call sites do), so this driver does the same two casts, and prints the float
 * result as the double it promotes to.
 *
 * `-ffp-contract=off` is deliberate: the source writes every fused step as an explicit `fma()`,
 * so the only contractions that can appear are the ones this file asks for.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "apple_powf_impl.h"

static double d_from (uint64_t u) { double d; memcpy (&d, &u, 8); return d; }
static uint64_t d_bits (double d) { uint64_t u; memcpy (&u, &d, 8); return u; }

int main (void)
{
	char line[512];
	while (fgets (line, sizeof line, stdin)) {
		char fn[16];
		char ha[32];
		char hb[32];
		if (sscanf (line, "%15s %31s %31s", fn, ha, hb) < 3) continue;
		if (strcmp (fn, "powf") != 0) {
			fprintf (stderr, "powf_cand: only powf, not '%s'\n", fn);
			continue;
		}
		uint64_t a = strtoull (ha, 0, 16);
		uint64_t b = strtoull (hb, 0, 16);
		float r = apowf_powf ((float) d_from (a), (float) d_from (b));
		printf ("powf %016llx %016llx %016llx\n", (unsigned long long) a,
			(unsigned long long) b, (unsigned long long) d_bits ((double) r));
	}
	return 0;
}
