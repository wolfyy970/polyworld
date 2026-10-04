/*
 * atan2fprobe.c — lane W1e's `atan2f` census (the last unverified libm unknown on the port's
 * books: PARITY.md *Open questions* 4).
 *
 * The model makes exactly one libm call whose *float* overload matters for a comparison rather
 * than a value: `frustumXZ::Inside` (`gmisc.cc:335`) computes
 *
 *     float ang = atan2(x0 - p[0], z0 - p[2]);      // float arguments -> atan2f, not atan2
 *
 * and compares `ang` against the wedge's two float limits.  The port stands in
 * `f32(Math.atan2(y, x))` with the two +-pi values corrected (PORT-NOTE(W1e/atan2f-pi)).  This
 * probe measures the difference the card asks about, natively: for every argument pair on
 * stdin it prints the bits of
 *
 *     (a) the *shipped* `atan2f`  — what the oracle calls, and
 *     (b) `(float)atan2((double)y, (double)x)` — the correctly rounded stand-in the port
 *         emulates, evaluated by this machine's `atan2`,
 *
 * so "does atan2f differ from f32(atan2) off the +-pi case?" is answered by the machine code
 * itself, not by a transcription of it.
 *
 * Both functions are fetched with `dlsym` and called through function pointers on purpose.
 * At -O2 LLVM's libcall simplifier folds `(float)atan2((double)y, (double)x)` into `atan2f`
 * when it can see both arguments as promoted floats — which would make this probe measure
 * "atan2f == atan2f" and report zero differences no matter what the machine code does.  The
 * indirect calls also let `--identity` print the two symbols' addresses and a hash of their
 * first bytes, so a census is pinned to one implementation of the library (the same reason the
 * lane's other probes dump the bytes they measure).
 *
 * Usage:
 *   atan2fprobe < raw/atan2f_args.txt > raw/atan2f_native.txt
 *   atan2fprobe --identity
 *
 * Input lines: `<ybits> <xbits> [class]` (hex float32 bit patterns; the class label, if any,
 * is ignored here — `tools/measure_atan2f.ts` reads it from the corpus).
 * Output lines: `atan2f <ybits> <xbits> <atan2f_result_bits> <f32_atan2_result_bits>`.
 */

#include <dlfcn.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef float (*atan2f_fn)(float, float);
typedef double (*atan2_fn)(double, double);

static float f32_from_bits(uint32_t u) {
    float f;
    memcpy(&f, &u, sizeof f);
    return f;
}

static uint32_t f32_bits(float f) {
    uint32_t u;
    memcpy(&u, &f, sizeof u);
    return u;
}

static uint64_t fnv1a(const unsigned char *p, size_t n) {
    uint64_t h = 1469598103934665603ULL; /* the 64-bit FNV offset basis */
    for (size_t i = 0; i < n; i++) {
        h ^= p[i];
        h *= 1099511628211ULL;
    }
    return h;
}

int main(int argc, char **argv) {
    void *af_sym = dlsym(RTLD_DEFAULT, "atan2f");
    void *ad_sym = dlsym(RTLD_DEFAULT, "atan2");
    if (af_sym == NULL || ad_sym == NULL) {
        fprintf(stderr, "atan2fprobe: dlsym failed for %s\n",
                af_sym == NULL ? "atan2f" : "atan2");
        return 2;
    }
    atan2f_fn native_atan2f = (atan2f_fn)af_sym;
    atan2_fn native_atan2 = (atan2_fn)ad_sym;

    if (argc > 1 && strcmp(argv[1], "--identity") == 0) {
        printf("atan2f %p fnv1a256 %016llx\n", af_sym,
               (unsigned long long)fnv1a((const unsigned char *)af_sym, 256));
        printf("atan2  %p fnv1a256 %016llx\n", ad_sym,
               (unsigned long long)fnv1a((const unsigned char *)ad_sym, 256));
        /* The two +-pi arms, which are where the port's correction lives. */
        float p = native_atan2f(0.0f, -1.0f);
        float d = (float)native_atan2(0.0, -1.0);
        printf("pi     atan2f %08x f32(atan2) %08x  delta_ulp 1 direction %s\n",
               f32_bits(p), f32_bits(d), f32_bits(p) < f32_bits(d) ? "atan2f low" : "atan2f high");
        return 0;
    }

    char line[512];
    while (fgets(line, sizeof line, stdin) != NULL) {
        unsigned yb, xb;
        if (sscanf(line, "%x %x", &yb, &xb) != 2) {
            continue; /* comments and blank lines */
        }
        float y = f32_from_bits((uint32_t)yb);
        float x = f32_from_bits((uint32_t)xb);
        float got = native_atan2f(y, x);
        float cr = (float)native_atan2(y, x); /* the double function, narrowed once */
        printf("atan2f %08x %08x %08x %08x\n", yb, xb, f32_bits(got), f32_bits(cr));
    }
    return 0;
}
