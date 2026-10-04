/* Dump the shipped code+data windows the `sin`/`cos` and `pow` transcriptions read.
 *
 *   clang -O0 dump_libm2.c -o /tmp/dump_libm2 && (cd raw && /tmp/dump_libm2)
 *
 * Two files, each a window that starts 0x400 bytes *before* the symbol so the constants the
 * code loads with negative `adr`/`ldr` offsets are inside the dump:
 *
 *   raw/sincos_bytes.bin  [sin-0x400, sin+0x1000)   -> sin at +0x400, cos at +0x56c
 *   raw/pow_bytes.bin     [pow-0x400, pow+0x1000)   -> pow at +0x400
 *
 * The 1/pi table `sin`/`cos` walk backwards, the three-part pi/2 and the pi/2*2^63 fixed-point
 * constant they multiply by, the two polynomial tables and pow's log/exp tables are all read
 * from these dumps by `gen_sincos_table.py` / `gen_pow_table.py` -- nothing is typed by hand.
 *
 * It also prints the two symbols' offsets (so a re-run can be compared) and the words
 * immediately below `sin`.
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

typedef double (*fn1) (double);

static void dump (const char *name, const unsigned char *p, const char *path, long pre, long post)
{
	FILE *f = fopen (path, "wb");
	if (!f) { perror (path); return; }
	fwrite (p - pre, 1, (size_t) (pre + post), f);
	fclose (f);
	printf ("%-8s @ %p   [%s: %ld bytes, -0x%lx..+0x%lx]\n", name, (const void *) p, path,
		pre + post, pre, post);
}

int main (void)
{
	const unsigned char *s = (const unsigned char *) (void *) sin;
	const unsigned char *c = (const unsigned char *) (void *) cos;
	const unsigned char *t = (const unsigned char *) (void *) tan;
	const unsigned char *p = (const unsigned char *) (void *) pow;

	printf ("sin  %p\ncos  %p  (sin%+ld)\ntan  %p  (sin%+ld)\npow  %p\n",
		(const void *) s, (const void *) c, (long) (c - s),
		(const void *) t, (long) (t - s), (const void *) p);

	/* the words immediately below sin: pi/4, the dispatch threshold, 2/pi and the
	   three-part pi/2 (see the PORT-NOTE in ../../libm.ts) */
	for (int off = -0x60; off < 0; off += 8) {
		uint64_t u;
		memcpy (&u, s + off, 8);
		printf ("  sin%+4d: 0x%016llx\n", off, (unsigned long long) u);
	}

	dump ("sin/cos", s, "sincos_bytes.bin", 0x400, 0x1000);
	dump ("pow", p, "pow_bytes.bin", 0x400, 0x1000);
	/* pow's data tables are ~170 kB away from its code: the log table is reached by
	 * `adrp x1, 0x2b000 / add x1, x1, #0x870` and the exp table by `adrp x0, 0x2c000 /
	 * add x0, x0, #0xb0`.  Those are PC-relative, so the object address objdump printed
	 * is an offset from (pow - 0x400) -- this window covers both. */
	dump ("pow tables", p + 0x2b400, "pow_tables.bin", 0, 0x1c00);
	return 0;
}
