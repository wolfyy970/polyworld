/* The C transcription's driver: same interface as `libm_census`, so a diff is a diff.
 *
 *   clang -O2 -ffp-contract=off pow_cand.c -o pow_cand
 *   (cd raw && /tmp/pow_cand < libm_args_pow.txt | diff - libm_native_pow.txt)
 *
 * `-ffp-contract=off` is deliberate: the source writes every fused step as an explicit
 * `fma()`, so the only contractions that can appear are the ones this file asks for.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "apple_pow_impl.h"

int main (void)
{
	char line[512];
	while (fgets (line, sizeof line, stdin)) {
		char fn[16];
		char ha[32];
		char hb[32];
		if (sscanf (line, "%15s %31s %31s", fn, ha, hb) < 3) continue;
		if (strcmp (fn, "pow") != 0) {
			fprintf (stderr, "pow_cand: only pow, not '%s'\n", fn);
			continue;
		}
		uint64_t a = strtoull (ha, 0, 16);
		uint64_t b = strtoull (hb, 0, 16);
		printf ("pow %016llx %016llx %016llx\n", (unsigned long long) a,
			(unsigned long long) b,
			(unsigned long long) apow_bits (apow_pow (apow_from (a), apow_from (b))));
	}
	return 0;
}
