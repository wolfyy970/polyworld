/* Dump the machine code of the libm function the oracle links against, so the algorithm
 * can be read (the port must reproduce it bit-for-bit).
 *   clang -O0 dump_libm.c -o dump_libm && ./dump_libm
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <dlfcn.h>
#include <math.h>

typedef double (*fn1)(double);
typedef double (*fn2)(double, double);

static void dump (const char *name, void *p, const char *file, size_t n)
{
	Dl_info info;
	if (dladdr (p, &info))
		printf ("%s @ %p  (image %s, sym %s)\n", name, p, info.dli_fname, info.dli_sname);
	else
		printf ("%s @ %p\n", name, p);
	FILE *f = fopen (file, "wb");
	fwrite (p, 1, n, f);
	fclose (f);
	printf ("   wrote %zu bytes -> %s\n", n, file);
}

int main (void)
{
	void *p;

	p = (void *) (fn1) log;
	dump ("log", p, "log_bytes.bin", 4096);

	p = (void *) (fn2) fma;
	dump ("fma", p, "fma_bytes.bin", 1024);

	p = (void *) (fn1) sqrt;
	dump ("sqrt", p, "sqrt_bytes.bin", 1024);

	p = (void *) (fn1) exp;
	dump ("exp", p, "exp_bytes.bin", 2048);

	/* sanity: the dumped code must be the one the process actually calls */
	volatile double x = 0.32352970400825143;
	printf ("log(%.17g) = %.17g\n", (double) x, log (x));
	return 0;
}
