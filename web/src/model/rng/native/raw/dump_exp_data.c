/* Dump the shipped `exp`'s machine code AND its data, so the transcription in
 * `apple_exp_impl.h` can be checked against the same bytes it was read from.
 *
 *   clang -O0 dump_exp_data.c -o /tmp/dump_exp_data && /tmp/dump_exp_data
 *
 * The layout is read straight off the disassembly (`expdis.s` + `objdump -d`):
 *
 *   adr  x0, 0x180            ; x0 = the table
 *   ldr  x2, [pc, #0x120]     ; 0x120: the |x| threshold for the special path
 *   ldr  x2, [pc, #0x118]     ; 0x118: the second (very negative) threshold
 *   ldr  d2, [pc, #0x128]     ; 0x128: the subnormal path's tail scale
 *   ldr  d1, [pc, #0x130]     ; 0x130: the overflow path's multiplier
 *   ldp  d3, d4, [x0, #-0x40] ; 0x140: two-part 128/ln2
 *   ldp  d16,d17,[x0, #-0x30] ; 0x150: polynomial coefficients (first pair)
 *   ldp  d18,d19,[x0, #-0x20] ; 0x160: polynomial coefficients (second pair)
 *   ldur d20,   [x0, #-0x10]  ; 0x170: polynomial coefficient
 *   ... 128 x 16-byte table entries at 0x180 { a, b }
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <dlfcn.h>
#include <math.h>

typedef double (*fn1) (double);

static uint64_t bits (double d) { uint64_t u; memcpy (&u, &d, 8); return u; }
static double unbits (uint64_t u) { double d; memcpy (&d, &u, 8); return d; }

int main (void)
{
	Dl_info info;
	void *p = (void *) (fn1) exp;
	dladdr (p, &info);
	printf ("exp @ %p (image %s, sym %s)\n", p, info.dli_fname, info.dli_sname);
	FILE *f = fopen ("exp_bytes.bin", "wb");
	fwrite (p, 1, 4096, f);
	fclose (f);
	printf ("wrote 4096 bytes -> exp_bytes.bin\n");

	const unsigned char *code = (const unsigned char *) p;
	printf ("\n// 64-bit literals loaded by ldr (bit patterns, compared as unsigned)\n");
	const int lits[4] = { 0x118, 0x120, 0x128, 0x130 };
	const char *names[4] = { "T_neg  (0x118)", "T_hi   (0x120)", "S_tail (0x128)", "O_mul  (0x130)" };
	for (int i = 0; i < 4; i++) {
		uint64_t u;
		memcpy (&u, code + lits[i], 8);
		printf ("  %s 0x%016llx  as double %.17g\n", names[i], (unsigned long long) u, unbits (u));
	}

	printf ("\n// constants at 0x140..0x180 (7 doubles)\n");
	for (int off = 0x140; off < 0x180; off += 8) {
		uint64_t u;
		memcpy (&u, code + off, 8);
		double d = unbits (u);
		printf ("  0x%03x  %.17g   /* 0x%016llx */\n", off, d, (unsigned long long) u);
	}

	printf ("\n// the 128 x {a, b} table at 0x180\n");
	printf ("static const double EXP_TAB[128][2] = {\n");
	for (int i = 0; i < 128; i++) {
		uint64_t ua, ub;
		memcpy (&ua, code + 0x180 + i * 16, 8);
		memcpy (&ub, code + 0x180 + i * 16 + 8, 8);
		printf ("  { %.17g, %.17g }, /* 0x%016llx 0x%016llx */\n",
			unbits (ua), unbits (ub), (unsigned long long) ua, (unsigned long long) ub);
	}
	printf ("};\n");
	printf ("\n// sanity: exp(1) = %.17g (0x%016llx)\n", exp (1.0), (unsigned long long) bits (exp (1.0)));
	return 0;
}
