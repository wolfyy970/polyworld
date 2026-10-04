/* Dump the shipped code+data windows the `powf` transcription reads.
 *
 *   clang -O0 dump_libm4.c -o /tmp/dump_libm4 && (cd raw && /tmp/dump_libm4)
 *
 * Same pattern as `dump_libm3.c` (sinf/cosf): a window that starts 0x400 bytes *before* the
 * symbol, so the constants the code loads with negative `adr`/`ldr` offsets are inside the dump:
 *
 *   raw/powf_bytes.bin   [powf-0x400, powf+0x1000)   -> powf at +0x400
 *
 * It also prints the neighbouring libm symbols' offsets (powf relative to pow/expf/sinf) and
 * the words immediately below `powf`, and follows a jump-thunk if `powf` turns out to be one.
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <dlfcn.h>
#include <math.h>

typedef float (*fn1f)(float);
typedef float (*fn2f)(float, float);
typedef double (*fn1)(double);
typedef double (*fn2)(double, double);

static void note (const char *name, void *p)
{
	Dl_info info;
	if (dladdr (p, &info))
		printf ("%-6s @ %p  (image %s, sym %s)\n", name, p, info.dli_fname,
			info.dli_sname ? info.dli_sname : "-");
	else
		printf ("%-6s @ %p\n", name, p);
}

static void dump (const char *name, void *p, const char *file, size_t back, size_t fwd)
{
	const unsigned char *b = (const unsigned char *) p;
	FILE *f = fopen (file, "wb");
	if (!f) { perror (file); return; }
	fwrite (b - back, 1, back + fwd, f);
	fclose (f);
	printf ("   wrote %zu bytes -> %s  (%s at +0x%zx)\n", back + fwd, file, name, back);
}

int main (void)
{
	void *p_powf = (void *) (fn2f) powf;
	const unsigned char *b = (const unsigned char *) p_powf;

	note ("powf", p_powf);
	note ("pow", (void *) (fn2) pow);
	note ("expf", (void *) (fn1f) expf);
	note ("exp", (void *) (fn1) exp);
	note ("sinf", (void *) (fn1f) sinf);
	printf ("   powf - pow   = %+ld\n", (long) (b - (const unsigned char *) (void *) (fn2) pow));
	printf ("   powf - expf  = %+ld\n", (long) (b - (const unsigned char *) (void *) (fn1f) expf));
	printf ("   powf - sinf  = %+ld\n", (long) (b - (const unsigned char *) (void *) (fn1f) sinf));

	for (int off = -0x40; off < 0; off += 4) {
		uint32_t u;
		memcpy (&u, b + off, 4);
		printf ("   powf%+4d: 0x%08x\n", off, u);
	}
	printf ("   powf+0:   0x%08x 0x%08x\n",
		(unsigned) ((const uint32_t *) (const void *) b)[0],
		(unsigned) ((const uint32_t *) (const void *) b)[1]);

	dump ("powf", p_powf, "powf_bytes.bin", 0x400, 0x1000);
	/* powf's data tables are ~180 kB away from its code (like pow's): the log table is
	 * reached by `adrp x1, 0x2d000 / add x1, x1, #0x790` and the exp table by
	 * `adrp x0, 0x2c000 / add x0, x0, #0xb40`.  Those are PC-relative, so the page objdump
	 * prints is relative to (powf - 0x400) -- this window covers both tables and the two
	 * polynomial blocks that sit immediately *before* them. */
	dump ("powf tables", (void *) (b + 0x2b400), "powf_tables.bin", 0, 0x2000);
	return 0;
}
