/* The C transcription's driver: reads the *census'* own corpus format and prints the bits of
 * this transcription's result, so a diff against the native column is a diff.
 *
 *   clang -O2 -ffp-contract=off -I. atan2f_cand.c -o /tmp/atan2f_cand
 *   (cd raw && /tmp/atan2f_cand < ../geometry/native/raw/atan2f_native.txt \
 *        | diff - <(cut -d' ' -f1-3 ../geometry/native/raw/atan2f_native.txt))
 *
 * The corpus line is `atan2f <ybits> <xbits> <atan2f_result_bits> <f32_atan2_result_bits>`
 * (`src/model/geometry/native/atan2fprobe.c`), so the first three fields are what this driver
 * has to reproduce -- the fourth is the *stand-in* the port used before this transcription and
 * is ignored here.
 *
 * `-ffp-contract=off` is deliberate: the source writes every fused step as an explicit `fma()`,
 * so the only contractions that can appear are the ones this file asks for.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "apple_atan2f_impl.h"

static float f_from (uint32_t u) { float f; memcpy (&f, &u, 4); return f; }
static uint32_t f_bits (float f) { uint32_t u; memcpy (&u, &f, 4); return u; }

int main (void)
{
	char line[512];
	while (fgets (line, sizeof line, stdin)) {
		char fn[16];
		unsigned yb;
		unsigned xb;
		if (sscanf (line, "%15s %x %x", fn, &yb, &xb) < 3) continue;
		if (strcmp (fn, "atan2f") != 0) {
			fprintf (stderr, "atan2f_cand: only atan2f, not '%s'\n", fn);
			continue;
		}
		float r = aatan2f (f_from ((uint32_t) yb), f_from ((uint32_t) xb));
		printf ("atan2f %08x %08x %08x\n", yb, xb, f_bits (r));
	}
	return 0;
}
