/* W1d follow-up: the libm census and the exp/sin/cos corpus.
 *
 * Reads `<fn> <argbits> [<argbits2>]` lines (64-bit hex, IEEE-754) on stdin and prints
 * `<fn> <argbits> [<argbits2>] <resultbits>` for the *shipped* libSystem function, so the
 * ported transcription can be diffed against the oracle's own libm.
 *
 *   clang -O2 raw/libm_census.c -o /tmp/libm_census
 *   /tmp/libm_census < raw/libm_args_exp.txt > raw/libm_native_exp.txt
 *
 * Only the functions the model actually calls are exposed (`exp`, `pow`, `sin`, `cos`,
 * plus `log2ceil`-free helpers the port needs nothing from). `pow` takes two arguments;
 * the others take one. Everything is bit-exact by construction: the arguments are read as
 * raw bits, never parsed from decimal text, and the result is printed as raw bits.
 *
 * A caveat that matters for `sin`/`cos`: the model calls them with a *float* argument
 * promoted to double (`agent.cc:1150-1151`), so the corpus includes the double value of
 * float32 inputs. The probe prints whatever libm returns for the double it is handed.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>

static uint64_t d2b (double d) { union { double d; uint64_t u; } v; v.d = d; return v.u; }
static double b2d (uint64_t u) { union { double d; uint64_t u; } v; v.u = u; return v.d; }

int main (void)
{
	char line[512];
	while (fgets (line, sizeof line, stdin))
	{
		char fn[16];
		char ha[32];
		char hb[32];
		int n = sscanf (line, "%15s %31s %31s", fn, ha, hb);
		if (n < 2) continue;
		uint64_t a = strtoull (ha, 0, 16);

		if (!strcmp (fn, "exp"))
			printf ("exp %016llx %016llx\n", (unsigned long long) a,
				(unsigned long long) d2b (exp (b2d (a))));
		else if (!strcmp (fn, "sin"))
			printf ("sin %016llx %016llx\n", (unsigned long long) a,
				(unsigned long long) d2b (sin (b2d (a))));
		else if (!strcmp (fn, "cos"))
			printf ("cos %016llx %016llx\n", (unsigned long long) a,
				(unsigned long long) d2b (cos (b2d (a))));
		/* the float overloads: the argument is the *double* the corpus gives, cast to
		 * float (which is what `CameraController.cc` does when it passes a C++ float),
		 * and the float result is printed as the double it promotes to. */
		else if (!strcmp (fn, "sinf"))
			printf ("sinf %016llx %016llx\n", (unsigned long long) a,
				(unsigned long long) d2b ((double) sinf ((float) b2d (a))));
		else if (!strcmp (fn, "cosf"))
			printf ("cosf %016llx %016llx\n", (unsigned long long) a,
				(unsigned long long) d2b ((double) cosf ((float) b2d (a))));
		else if (!strcmp (fn, "pow") && n >= 3)
		{
			uint64_t b = strtoull (hb, 0, 16);
			printf ("pow %016llx %016llx %016llx\n", (unsigned long long) a,
				(unsigned long long) b, (unsigned long long) d2b (pow (b2d (a), b2d (b))));
		}
		/* the float overload: both arguments are cast to `float` (which is what the
		 * C++ call sites do) and the float result is printed as the double it promotes to. */
		else if (!strcmp (fn, "powf") && n >= 3)
		{
			uint64_t b = strtoull (hb, 0, 16);
			printf ("powf %016llx %016llx %016llx\n", (unsigned long long) a,
				(unsigned long long) b,
				(unsigned long long) d2b ((double) powf ((float) b2d (a), (float) b2d (b))));
		}
		else
			fprintf (stderr, "libm_census: unknown function '%s'\n", fn);
	}
	return 0;
}
