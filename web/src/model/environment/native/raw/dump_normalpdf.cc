/*
 * Lane L10 — `normalPDF` value corpus (`normalpdf_sweep.tsv`).
 *
 * WHY THIS EXISTS
 * `utils/distributions.cc:32-43` is four expressions, and three of them are the *folded*
 * forms of `pow` calls — so `tests/distributions-normalpdf.test.ts` cannot be written from the
 * C source, only from the binary. `normalPDF` is also not a float chain: `__Z9normalPDFfff`
 * (`0xfb6c`) keeps `sigma^2`, the `fl(2*pi) * sigma^2` product, the `sqrt` and the reciprocal
 * in **double** and narrows to float once per store (`fcvt s8, d3` at `0xfba0`,
 * `fcvt s1, d1` at `0xfbb0`). A port that transcribes the C source instead of the binary (or
 * that puts an `f32` at every arithmetic step) rounds three times more than the oracle does,
 * which is what this corpus measured: see `tools/measure_normalpdf_f32.ts`.
 *
 * WHAT IT EMITS
 * One `\t`-separated row per `(x, sigma, mu)`, every field a float32 **bit pattern** so nothing
 * can drift through a decimal parse:
 *
 *   x  sigma  mu  left  rightTop  rightBottom  right  pdf
 *
 * `left`/`rightTop`/`rightBottom`/`right` are the four expressions as the *binary* evaluates
 * them (below), and `pdf` is the return value of the **shipped** `normalPDF` itself, called out
 * of `libpolyworld.dylib` — so the corpus checks its own decomposition: `pdf` must equal
 * `left * right` exactly on every row (the test asserts it).
 *
 * HOW THE INTERMEDIATES ARE OBTAINED
 * Every step is a `volatile` whose type is the register width the disassembly uses, so nothing
 * can be folded or re-associated (`-O1` is enough for that; this file is not a codegen
 * experiment). The reading was validated against the library itself: over this corpus the
 * replica's `left * right` equals the shipped `normalPDF`'s return value on **every** row, so a
 * wrong reading of the disassembly cannot survive here. That is the same trick the
 * `src/model/rng/native` lane uses for the libm functions, applied to the folded multiplies.
 *
 * REGENERATE
 *   native=polyworld      # or set POLYWORLD_NATIVE
 *   clang++ -std=c++17 -O1 -I"$native/src/library" \
 *       src/model/environment/native/raw/dump_normalpdf.cc \
 *       -L"$native/lib" -lpolyworld -Wl,-rpath,"$native/lib" -o /tmp/dump_normalpdf
 *   /tmp/dump_normalpdf > src/model/environment/native/raw/normalpdf_sweep.tsv
 *
 * Re-running it is byte-identical (no RNG, no timing, no address-dependent output); the committed
 * corpus is `sha256 2399c45f2719a42496c6473c753b9f130e2aa01c5d8b4d4c78a3d1a2d8b39bfb`.
 */
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "utils/distributions.h"

static uint32_t bits(float v) {
    uint32_t b;
    memcpy(&b, &v, sizeof(b));
    return b;
}

/*
 * The binary, step for step, with the register width of each instruction. Comments are the
 * addresses from `otool -tvV lib/libpolyworld.dylib`.
 */
static void oracleNormalPDF(float x, float sigma, float mu, float* left, float* rightTop,
                            float* rightBottom, float* right) {
    const double twoPi = 6.2831854820251465;  // fb8c: the fl(2*pi_f) constant, widened
    volatile double d = (double)sigma;        // fb78: fcvt d1, s1
    volatile double sigma2 = d * d;           // fb7c: fmul d1, d1, d1   (pow(sigma,2) folded)
    volatile double prod = sigma2 * twoPi;    // fb90: fmul d3, d1, d3
    volatile double root = sqrt(prod);        // fb94: fsqrt d3, d3
    volatile double inv = 1.0 / root;         // fb98: fdiv d3, 1.0, d3
    *left = (float)inv;                       // fba0: fcvt s8, d3        <- the only narrowing
    volatile float xm = x - mu;               // fba4: fsub s0, s0, s2
    *rightTop = -(xm * xm);                   // fba8: fnmul s0, s0, s0
    volatile double twosig = sigma2 + sigma2; // fbac: fadd d1, d1, d1
    *rightBottom = (float)twosig;             // fbb0: fcvt s1, d1        <- the only narrowing
    volatile float ratio = *rightTop / *rightBottom;  // fbb4: fdiv s1, s0, s1
    *right = powf(2.7182817f, (float)ratio);          // fbc0/fbc4: fmov s0; bl _powf
}

int main() {
    // The grid. `x` spans the sampler's own domain (`randpw()` is in [0,1); `Patch.cc` passes it
    // straight through) with a margin either side; `sigma`/`mu` are the model's values
    // (`Patch.cc:78-79`: sigma = .3f, mu = .5f) crossed with a worldfile-reachable spread
    // (`EllipseGauss`/`RectGauss` set them).
    const int nx = 24, ns = 9, nm = 6;
    float xs[nx], ss[ns], ms[nm];
    for (int i = 0; i < nx; i++) xs[i] = (float)(-0.25 + 1.5 * i / (nx - 1));
    const float sigmaVals[ns] = {0.05f, 0.1f, 0.3f, 0.5f, 0.7f, 1.0f, 2.0f, 3.3f, 10.0f};
    const float muVals[nm] = {-0.5f, 0.0f, 0.25f, 0.5f, 0.75f, 1.0f};
    for (int i = 0; i < ns; i++) ss[i] = sigmaVals[i];
    for (int i = 0; i < nm; i++) ms[i] = muVals[i];

    for (int a = 0; a < nx; a++)
        for (int b = 0; b < ns; b++)
            for (int c = 0; c < nm; c++) {
                const float x = xs[a], sigma = ss[b], mu = ms[c];
                float left, rightTop, rightBottom, right;
                oracleNormalPDF(x, sigma, mu, &left, &rightTop, &rightBottom, &right);
                const float pdf = normalPDF(x, sigma, mu);  // the shipped function itself
                printf("0x%08x\t0x%08x\t0x%08x\t0x%08x\t0x%08x\t0x%08x\t0x%08x\t0x%08x\n",
                       bits(x), bits(sigma), bits(mu), bits(left), bits(rightTop),
                       bits(rightBottom), bits(right), bits(pdf));
            }
    return 0;
}
