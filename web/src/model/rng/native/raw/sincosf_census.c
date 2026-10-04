/* Capture the *shipped* `__sincosf_stret` — the entry point the native `CameraController`
 * actually calls (LLVM merges the adjacent `sin(camrad)`/`cos(camrad)` into it; the call site
 * in libpolyworld.dylib is `bl ___sincosf_stret`, measured from the symbol stub).
 *
 *   clang -O2 sincosf_census.c -o /tmp/sincosf_census
 *   /tmp/sincosf_census < raw/libm_args_sinf.txt > raw/libm_native_sincosf.txt
 *
 * Same interface as `libm_census`: `<fn> <argbits>` on stdin (the argument is read as raw bits,
 * cast to the float32 the call receives, and printed promoted to double) and
 * `sincosf <argbits> <sinbits> <cosbits>` out.  `__sincosf_stret` is not a public declaration,
 * so it comes from `dlsym` — the two-float result is returned in s0/s1 (verified: its address
 * is `sinf + 0x1ac`, the two-output function in the `sinf`/`cosf` unit).
 */
#include <dlfcn.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { float s, c; } scf_t;
typedef scf_t (*scf_fn) (float);

static uint64_t d2b (double d) { union { double d; uint64_t u; } v; v.d = d; return v.u; }
static double b2d (uint64_t u) { union { double d; uint64_t u; } v; v.u = u; return v.d; }

int main (void)
{
	scf_fn f = (scf_fn) (void *) dlsym (RTLD_DEFAULT, "__sincosf_stret");
	if (!f) {
		fprintf (stderr, "sincosf_census: no __sincosf_stret\n");
		return 1;
	}
	fprintf (stderr, "sincosf_census: __sincosf_stret at %p (sinf%+ld)\n", (void *) f,
		(long) ((const char *) (void *) f - (const char *) (void *) sinf));

	char line[512];
	while (fgets (line, sizeof line, stdin)) {
		char fn[16];
		char ha[32];
		if (sscanf (line, "%15s %31s", fn, ha) < 2) continue;
		uint64_t a = strtoull (ha, 0, 16);
		scf_t r = f ((float) b2d (a));
		printf ("sincosf %016llx %016llx %016llx\n", (unsigned long long) a,
			(unsigned long long) d2b ((double) r.s),
			(unsigned long long) d2b ((double) r.c));
	}
	return 0;
}
