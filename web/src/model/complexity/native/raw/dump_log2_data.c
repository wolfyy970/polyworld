// Lane L13 — extract the oracle's `log2` code bytes and data table from the running libSystem.
//
// `complexity/complexity_algorithm.cc` defines `c_log` as `log2`, and every value the
// complexity machinery produces goes through it. The port therefore needs a bit-exact
// `log2`, and this machine's `log2` is **not** correctly rounded (measured on the committed
// 22,312-value corpus: a correctly rounded `log2` differs from it on 4 values, 1 ulp each —
// `raw/log2_correct_rounding.py`; see also `src/model/complexity/log2.ts` and the PARITY.md
// L13 row), so it is transcribed from the shipped machine code exactly like lane W1d's
// `log`/`exp`.
//
// This program dumps the bytes the transcription needs into `raw/log2_bytes.bin`:
// the function's own instructions, its literal pool, its six polynomial coefficients and its
// 129 x {1/c, log2(c)} entries. `native/gen_log2_table.py` then decodes that file into
// `raw/apple_log2_table.h` (for the C transcription) and `appleLog2Table.ts` (the module the
// port imports), so no constant is ever typed by hand.
//
// Build and run (from this directory):
//   clang -O2 raw/dump_log2_data.c -o /tmp/dump_log2_data && /tmp/dump_log2_data
//
// Layout, read off `lldb -o "disassemble -n log2"` (offsets relative to the entry point):
//
//   0x000  code (0x160 bytes; the literal pool and constants are interleaved)
//   0x160  the bias added to the argument's bit pattern before the shift (0xc0181000...)
//   0x168  1/ln2, the multiplier used on the polynomial's linear term
//   0x170  +Infinity (the `x - x` for the negative-argument path)
//   0x178  0xfffffffff8000000, the mask that splits a table value into its top 25 bits
//   0x180  1.0
//   0x188  1/ln2, high half (the k == 0 branch)
//   0x190  1/ln2, low half  (the k == 0 branch)
//   0x198  6 doubles: the polynomial coefficients
//   0x1c8  129 x 2 doubles: { 1/c, log2(c) } per interval
//
// The native tree is read-only for lane agents and this file does not touch it: it only calls
// the running system's own `log2` and copies bytes out of the (read-only) code page.

#include <dlfcn.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define DUMP_LEN 0x1d00

int main(void)
{
	double (*f)(double) = log2;
	const unsigned char *p = (const unsigned char *)(uintptr_t)f;

	FILE *out = fopen("raw/log2_bytes.bin", "wb");
	if (!out) {
		fprintf(stderr, "dump_log2_data: cannot write raw/log2_bytes.bin (run from native/)\n");
		return 1;
	}
	size_t written = fwrite(p, 1, DUMP_LEN, out);
	fclose(out);

	printf("log2 @ %p -> raw/log2_bytes.bin (%zu bytes)\n", (void *)f, written);

	/* Sanity: the two constants the disassembly names as bit patterns, and the table's
	   first/last entries, so a drift in the layout is loud rather than silent. */
	const uint64_t *w = (const uint64_t *)(p + 0x160);
	printf("bias      = 0x%016llx\n", (unsigned long long)w[0]);
	printf("log2e     = 0x%016llx\n", (unsigned long long)w[1]);
	printf("mask      = 0x%016llx\n", (unsigned long long)*(const uint64_t *)(p + 0x178));
	printf("one       = 0x%016llx\n", (unsigned long long)*(const uint64_t *)(p + 0x180));
	printf("log2e_hi  = 0x%016llx\n", (unsigned long long)*(const uint64_t *)(p + 0x188));
	printf("log2e_lo  = 0x%016llx\n", (unsigned long long)*(const uint64_t *)(p + 0x190));

	const uint64_t *tab = (const uint64_t *)(p + 0x1c8);
	printf("tab[  0]  = 0x%016llx 0x%016llx\n", (unsigned long long)tab[0],
	       (unsigned long long)tab[1]);
	printf("tab[128]  = 0x%016llx 0x%016llx\n", (unsigned long long)tab[256],
	       (unsigned long long)tab[257]);
	return 0;
}
