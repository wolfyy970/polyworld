/* Dump the shipped libm function's machine code AND its data tables (the table is at
 * (log & ~0xfff) + 0x2d000 + 0xf90 for this build, as decoded from log's disassembly:
 * adrp x1, 0x2d000 / add x1, x1, #0xf90 loads 6 polynomial coefficients, then the
 * 128 x 32-byte entries follow). */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <dlfcn.h>
#include <math.h>

typedef double (*fn1)(double);

static uint64_t bits (double d) { uint64_t u; memcpy (&u, &d, 8); return u; }

int main (void)
{
	void *p = (void *) (fn1) log;
	uintptr_t fn = (uintptr_t) p;
	uintptr_t page = fn & ~(uintptr_t) 0xfff;
	uintptr_t tbl = page + 0x2d000 + 0xf90;

	printf ("log @ 0x%lx   table @ 0x%lx\n", fn, tbl);

	FILE *f = fopen ("log_bytes.bin", "wb");
	fwrite (p, 1, 0x158, f);
	fclose (f);

	/* 6 polynomial coefficients, then 128 entries of 4 doubles */
	const double *coef = (const double *) tbl;
	printf ("// poly coefficients\n");
	for (int i = 0; i < 6; i++) printf ("  %.17g /* 0x%016llx */\n", coef[i], (unsigned long long) bits (coef[i]));

	const double *e = (const double *) (tbl + 48);
	printf ("// table entries: {e0, e1, e2, e3} -- 129 of them: index i is z near 1 + i/128,\n");
	printf ("// the code's index (2^44 + mantissa) >> 45 reaches 128 for z >= 1.96875\n");
	for (int i = 0; i < 129; i++) {
		printf ("  { ");
		for (int j = 0; j < 4; j++) printf ("%.17g /* 0x%016llx */, ", e[i * 4 + j], (unsigned long long) bits (e[i * 4 + j]));
		printf ("},\n");
	}
	return 0;
}
