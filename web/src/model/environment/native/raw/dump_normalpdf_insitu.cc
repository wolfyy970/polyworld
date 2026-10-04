/*
 * Lane L10 — the **in-situ** `normalPDF` corpus (`normalpdf_insitu.tsv`).
 *
 * WHY THIS EXISTS (card t_bb4630da)
 * `native/raw/normalpdf_sweep.tsv` passes *exact float32* `sigma`/`mu`/`x`. The port's own call
 * site does not: `Patch::setPoint` (`environment/Patch.cc:78-81`) declares
 *
 *     float sigma = .3; float mu = 0.5; float slope = -0.4; float yIntercept = 0.4;
 *
 * so the oracle hands `normalPDF` the **float** `0.3f` (`0x3e99999a`), while a port that
 * transcribes those literals as JS doubles hands it `0.3` (`0.299999999999999988897769753748…`).
 * `normalPDF`'s first instruction is `fcvt d1, s1` (0xfb78) — it widens its `float` parameter —
 * so the two differ in `left`, `rightBottom` and the return value on *every* x (measured: the
 * whole grid below). This corpus is the oracle's answer for the operands the call site really
 * passes: `sigma = 0.3f`, `mu = 0.5f`, `x = i/10000` for `i` in `[0, 10000)` — the sampler's own
 * domain (`randpw()` is in [0,1), `Patch.cc` passes it straight through), on a grid four
 * hundred times denser than the sweep's 24 x values.
 *
 * WHAT IT EMITS
 * The same eight `\t`-separated float32 bit-pattern fields as `normalpdf_sweep.tsv`:
 *
 *   x  sigma  mu  left  rightTop  rightBottom  right  pdf
 *
 * `left`/`rightTop`/`rightBottom`/`right` are the four expressions as the *binary* evaluates them
 * (the same `volatile`-per-step replica as `dump_normalpdf.cc`), and `pdf` is the return value of
 * the **shipped** `normalPDF`, called out of `libpolyworld.dylib` — so the corpus checks its own
 * decomposition (`pdf` must equal `left * right` exactly on every row).
 *
 * REGENERATE
 *   native=polyworld      # or set POLYWORLD_NATIVE
 *   clang++ -std=c++17 -O1 -I"$native/src/library" \
 *       src/model/environment/native/raw/dump_normalpdf_insitu.cc \
 *       -L"$native/lib" -lpolyworld -Wl,-rpath,"$native/lib" -o /tmp/dump_normalpdf_insitu
 *   /tmp/dump_normalpdf_insitu > src/model/environment/native/raw/normalpdf_insitu.tsv
 *
 * Re-running it is byte-identical (no RNG, no timing, no address-dependent output); the committed
 * corpus is `sha256 b30d73fdc81a2d281ebca82816013c27f1e4afe78111b1c7dcf764b3f2fb6501`.
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
 * The binary, step for step, with the register width of each instruction (addresses from
 * `otool -tvV lib/libpolyworld.dylib`, `__Z9normalPDFfff` @0xfb6c). Identical to the replica in
 * `dump_normalpdf.cc`; kept local so each dumper is self-contained.
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
    // The call site's own literals, as the binary's `float` parameters hold them.
    const float sigma = 0.3f;  // Patch.cc:78  `float sigma = .3;`
    const float mu = 0.5f;     // Patch.cc:79  `float mu = 0.5;`
    const int nx = 10000;

    for (int i = 0; i < nx; i++) {
        const float x = (float)(i / 10000.0);  // randpw()'s domain, [0, 1)
        float left, rightTop, rightBottom, right;
        oracleNormalPDF(x, sigma, mu, &left, &rightTop, &rightBottom, &right);
        const float pdf = normalPDF(x, sigma, mu);  // the shipped function itself
        printf("0x%08x\t0x%08x\t0x%08x\t0x%08x\t0x%08x\t0x%08x\t0x%08x\t0x%08x\n",
               bits(x), bits(sigma), bits(mu), bits(left), bits(rightTop),
               bits(rightBottom), bits(right), bits(pdf));
    }
    return 0;
}
