// Lane L13 — `log2` corpus recorder.
//
// Reads double bit patterns (16 hex digits per line) on stdin and prints this machine's own
// `log2()` for each of them, in the same encoding. `raw/gen_log2_corpus.py` writes the input
// corpus and refreshes `raw/log2_native.txt` with this program's output:
//
//     clang -O2 raw/log2probe.c -o raw/log2probe
//     python3 raw/gen_log2_corpus.py
//
// `tests/complexity.test.ts` then asserts that `src/model/complexity/log2.ts` reproduces every
// recorded value bit for bit, and that V8's `Math.log2` does *not* (i.e. that the corpus is
// discriminating).

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
	char line[64];
	while (fgets(line, sizeof line, stdin)) {
		uint64_t u = 0;
		if (sscanf(line, "%llx", (unsigned long long *) &u) != 1) continue;
		double x;
		memcpy(&x, &u, 8);
		double y = log2(x);
		uint64_t v;
		memcpy(&v, &y, 8);
		printf("%016llx\n", (unsigned long long) v);
	}
	return 0;
}
