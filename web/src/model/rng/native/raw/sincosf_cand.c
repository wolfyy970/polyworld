/* The C transcription of `__sincosf_stret`, diffed against the shipped function itself.
 *
 *   clang -O2 -ffp-contract=off sinf_cand.c -o sinf_cand            # also handles sincosf
 *   (cd raw && /tmp/sinf_cand < libm_args_sinf.txt | diff - libm_native_sincosf.txt)
 *
 * Same interface as `sincosf_census.c` (which captures the native rows via `dlsym`): reads
 * `<fn> <argbits>` and prints `<fn> <argbits> <sinbits> <cosbits>`, both floats printed
 * promoted to double.
 *
 *   clang -O2 -ffp-contract=off sincosf_cand.c -o sincosf_cand
 *   (cd raw && /tmp/sincosf_cand < libm_args_sinf.txt | diff - libm_native_sincosf.txt)
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
		float s = 0, c = 0;
		apple_sincosf ((float) b2d (a), &s, &c);
		printf ("sincosf %016llx %016llx %016llx\n", (unsigned long long) a,
			(unsigned long long) d2b ((double) s), (unsigned long long) d2b ((double) c));
	}
	return 0;
}
