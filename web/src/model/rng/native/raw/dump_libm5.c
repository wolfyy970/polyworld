/* Dump the shipped code+data window the `atan2f` transcription reads.
 *
 *   clang -O0 dump_libm5.c -o /tmp/dump_libm5 && (cd raw && /tmp/dump_libm5)
 *
 * Same pattern as `dump_libm4.c` (powf): a window that starts 0x40 bytes *before* the symbol, so
 * the words immediately below `atan2f` are inside the dump:
 *
 *   raw/atan2f_bytes.bin   [atan2f-0x40, atan2f+0x2c0)    -> atan2f at +0x40
 *
 * Unlike `powf` -- whose two tables are ~180 kB away and need a second window -- this one is
 * self-contained: the 9-double polynomial the ratio is evaluated with sits at `atan2f+0x220`,
 * immediately after the code, and the eight angle constants (the 4-way table at `atan2f+0x270`
 * and the five `ldr` literals) follow it at `+0x268`..`+0x2b8`.  Every one of them is reached by
 * a PC-relative `adr`/`ldr` from the code in the same dump, which is what `objdump -d` on
 * `atan2fdis.s` shows (see `gen_atan2f_table.py`, which reads this file and checks each offset).
 *
 * It also prints the neighbouring libm symbols' offsets (atan2f relative to atan2/sinf/powf) and
 * the words immediately below `atan2f`, and follows a jump-thunk if `atan2f` turns out to be one.
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

/* The same hash the atan2f census' `--identity` mode prints, so a dump can be pinned to the
 * library a corpus was measured against (`native/atan2fprobe.c`). */
static uint64_t fnv1a (const unsigned char *p, size_t n)
{
	uint64_t h = 1469598103934665603ULL;
	for (size_t i = 0; i < n; i++) {
		h ^= p[i];
		h *= 1099511628211ULL;
	}
	return h;
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
	void *p_atan2f = (void *) (fn2f) atan2f;
	const unsigned char *b = (const unsigned char *) p_atan2f;

	note ("atan2f", p_atan2f);
	note ("atan2", (void *) (fn2) atan2);
	note ("sinf", (void *) (fn1f) sinf);
	note ("powf", (void *) (fn2f) powf);
	printf ("   atan2f - atan2 = %+ld\n", (long) (b - (const unsigned char *) (void *) (fn2) atan2));
	printf ("   atan2f - powf  = %+ld\n", (long) (b - (const unsigned char *) (void *) (fn2f) powf));

	for (int off = -0x40; off < 0; off += 4) {
		uint32_t u;
		memcpy (&u, b + off, 4);
		printf ("   atan2f%+4d: 0x%08x\n", off, u);
	}
	printf ("   atan2f+0:   0x%08x 0x%08x\n",
		(unsigned) ((const uint32_t *) (const void *) b)[0],
		(unsigned) ((const uint32_t *) (const void *) b)[1]);

	/* The code runs to +0x214 and the polynomial + the angle table follow it immediately, so
	 * one window covers both -- nothing here is reached by an `adrp` that leaves this page's
	 * 0x990 offset, so there is no second page to fetch.  `+0x2c0` is the next symbol's entry
	 * (its `pacibsp`). */
	dump ("atan2f", p_atan2f, "atan2f_bytes.bin", 0x40, 0x2c0);

	/* The identity the generator checks: the same fnv1a256 the census' `--identity` mode
	 * prints, plus the symbol's page offset (the `adrp`+`add` that reaches the +-pi table is
	 * page-relative, so the generator needs it to resolve that displacement). */
	{
		FILE *f = fopen ("atan2f_bytes.identity.txt", "w");
		if (f) {
			uint64_t h;
			unsigned char buf[256];
			memcpy (buf, b, sizeof buf);
			h = fnv1a (buf, sizeof buf);
			fprintf (f, "atan2f 0x%llx fnv1a256 %016llx page_offset 0x%llx\n",
				 (unsigned long long) (uintptr_t) p_atan2f, (unsigned long long) h,
				 (unsigned long long) ((uintptr_t) p_atan2f & 0xfff));
			fprintf (f, "atan2  0x%llx\n", (unsigned long long) (uintptr_t) (void *) (fn2) atan2);
			fprintf (f, "image  %s\n", "libsystem_m.dylib (dladdr above)");
			fclose (f);
			printf ("   wrote atan2f_bytes.identity.txt (fnv1a256 %016llx, page offset 0x%llx)\n",
				(unsigned long long) h,
				(unsigned long long) ((uintptr_t) p_atan2f & 0xfff));
		}
	}
	return 0;
}
