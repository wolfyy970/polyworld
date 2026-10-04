/* The C transcription's driver: same interface as `libm_census`, so a diff is a diff.
 *
 *   clang -O2 -ffp-contract=off sincos_cand.c -o /tmp/sincos_cand
 *   /tmp/sincos_cand < raw/libm_args_sin.txt | diff - raw/libm_native_sin.txt
 *   /tmp/sincos_cand < raw/libm_args_cos.txt | diff - raw/libm_native_cos.txt
 *
 * `-ffp-contract=off` is deliberate: the source writes every fused step as an explicit
 * `fma()`, so the only contractions that can appear are the ones this file asks for.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "apple_sincos_impl.h"

int main (void)
{
	char line[512];
	while (fgets (line, sizeof line, stdin)) {
		char fn[16];
		char ha[32];
		if (sscanf (line, "%15s %31s", fn, ha) < 2) continue;
		uint64_t a = strtoull (ha, 0, 16);
		double x = asc_from (a);
		if (!strcmp (fn, "sin"))
			printf ("sin %016llx %016llx\n", (unsigned long long) a,
				(unsigned long long) asc_bits (apple_sin (x)));
		else if (!strcmp (fn, "cos"))
			printf ("cos %016llx %016llx\n", (unsigned long long) a,
				(unsigned long long) asc_bits (apple_cos (x)));
		else {
			fprintf (stderr, "sincos_cand: only sin/cos, not '%s'\n", fn);
			continue;
		}
	}
	return 0;
}
