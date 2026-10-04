/*
 * Lane L10 — the **in-situ** `linearPDF` corpus (`linearpdf_insitu.tsv`).
 *
 * WHY THIS EXISTS (card t_bb4630da)
 * `Patch::setPoint` reaches `linearPDF` with the *float* literals `slope = -0.4f`,
 * `yIntercept = 0.4f` (`environment/Patch.cc:80-81`), and the else arm's shipped form is the
 * **fused** `fmadd s1, s1, s0, s2` (0xfbdc) — so the value the sampler's rejection test compares
 * against is `f32( slope*x + yIntercept )` with *binary32* operands. A port that transcribes the
 * same two literals as JS doubles feeds the fusion the wrong operands: measured on this grid the
 * else arm disagrees on ~20 % of `x`, and a 1-ulp disagreement in `linearPDF`'s return value is
 * the *argument of `getLinear`'s rejection test* — a draw-count difference, not a last bit.
 *
 * `tests/distributions-normalpdf.test.ts` cannot decide this from the sweep: its rows pass exact
 * float32 operands only. This corpus is the shipped `linearPDF`'s own answer for the operands the
 * call site really passes, plus both arms as the binary computes them, on
 * `x = i/40000` for `i` in `[0, 40001]` — the arm boundary `x = 0.5` included (it takes the
 * `fnmul` arm: `fcmp s0, 0.5f` / `fcsel s0, s1, s3, hi`).
 *
 * WHAT IT EMITS
 * Four `\t`-separated float32 bit-pattern fields:
 *
 *   x  lo  hi  pdf
 *
 * `lo` = the `x <= 0.5` arm (`0xfbd8 fnmul s3, s1, s0`), `hi` = the else arm
 * (`0xfbdc fmadd s1, s1, s0, s2`; computed in double, which is exact for binary32 operands —
 * a `float * float` product needs ≤ 48 significand bits and the sum fits with it, so the one
 * `(float)` narrowing *is* the fused rounding), and `pdf` = the value the **shipped** function
 * returns, called out of `libpolyworld.dylib` — so the corpus checks its own arm selection and
 * its own fusion (`pdf == (x <= 0.5f ? lo : hi)` on every row).
 *
 * REGENERATE
 *   native=polyworld      # or set POLYWORLD_NATIVE
 *   clang++ -std=c++17 -O1 -I"$native/src/library" \
 *       src/model/environment/native/raw/dump_linearpdf_insitu.cc \
 *       -L"$native/lib" -lpolyworld -Wl,-rpath,"$native/lib" -o /tmp/dump_linearpdf_insitu
 *   /tmp/dump_linearpdf_insitu > src/model/environment/native/raw/linearpdf_insitu.tsv
 *
 * Re-running it is byte-identical; the committed corpus is
 * `sha256 c3984885c5833de425c4c9f5db4ce5bc07f7172644a1a6b0fda5f9f562923b7c`.
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

int main() {
    // The call site's own literals, as the binary's `float` parameters hold them.
    const float slope = -0.4f;      // Patch.cc:80  `float slope = -0.4;`
    const float yIntercept = 0.4f;  // Patch.cc:81  `float yIntercept = 0.4;`

    for (int i = 0; i <= 40000; i++) {
        const float x = (float)(i / 40000.0);  // [0, 1], the arm boundary at i = 20000
        const volatile float lo = -(slope * x);              // 0xfbd8 fnmul s3, s1, s0
        const volatile float hi = (float)((double)slope * (double)x + (double)yIntercept);  // 0xfbdc fmadd
        const float pdf = linearPDF(x, slope, yIntercept);   // the shipped function itself
        (void)lo;
        (void)hi;
        printf("0x%08x\t0x%08x\t0x%08x\t0x%08x\n", bits(x), bits(lo), bits(hi), bits(pdf));
    }
    return 0;
}
