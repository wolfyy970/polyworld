/* Dump the shipped code+data windows the `sinf`/`cosf` transcription reads.
 *
 *   clang -O0 dump_libm3.c -o /tmp/dump_libm3 && (cd raw && /tmp/dump_libm3)
 *
 * Same pattern as `dump_libm2.c`: a window that starts 0x400 bytes *before* the symbol, so
 * the constants the code loads with negative `adr`/`ldr` offsets are inside the dump:
 *
 *   raw/sinf_bytes.bin   [sinf-0x400, sinf+0x1000)   -> sinf at +0x400, cosf at +0x400+d
 *
 * It also prints the two symbols' offsets and the words immediately below `sinf`.
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

int main (void)
{
	const unsigned char *s = (const unsigned char *) (void *) sinf;
	const unsigned char *c = (const unsigned char *) (void *) cosf;

	printf ("sinf %p\ncosf %p  (sinf%+ld)\n", (const void *) s, (const void *) c,
		(long) (c - s));

	for (int off = -0x80; off < 0; off += 4) {
		uint32_t u;
		uint64_t v;
		memcpy (&u, s + off, 4);
		memcpy (&v, s + off, 8);
		printf ("  sinf%+4d: 0x%08x   (u64 0x%016llx)\n", off, u,
			(unsigned long long) v);
	}

	FILE *f = fopen ("sinf_bytes.bin", "wb");
	if (!f) { perror ("sinf_bytes.bin"); return 1; }
	fwrite (s - 0x400, 1, 0x1400, f);
	fclose (f);
	printf ("sinf_bytes.bin: 5120 bytes [sinf-0x400, sinf+0x1000)\n");
	return 0;
}
