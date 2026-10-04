/* The C transcription's driver: same interface as `libm_census`, so a diff is a diff.
 *
 *   clang -O2 -ffp-contract=off exp_cand.c -o /tmp/exp_cand
 *   /tmp/exp_cand < raw/libm_args_exp.txt | diff - raw/libm_native_exp.txt
 *
 * `-ffp-contract=off` is deliberate: the source writes every fused step as an explicit
 * `fma()`, so the only contractions that can appear are the ones this file asks for.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "apple_exp_impl.h"

int main (void)
{
	char line[512];
	while (fgets (line, sizeof line, stdin)) {
		char fn[16];
		char ha[32];
		if (sscanf (line, "%15s %31s", fn, ha) < 2) continue;
		if (strcmp (fn, "exp") != 0) {
			fprintf (stderr, "exp_cand: only exp, not '%s'\n", fn);
			continue;
		}
		uint64_t a = strtoull (ha, 0, 16);
		printf ("exp %016llx %016llx\n", (unsigned long long) a,
			(unsigned long long) aexp_bits (apple_exp (aexp_from_bits (a))));
	}
	return 0;
}
