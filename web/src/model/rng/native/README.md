# src/model/rng/native — how every vector in this lane was captured

Everything in `../nativeVectors.ts` and `../appleLogTable.ts` comes from the *oracle*: the
native tree's own build (`../polyworld/bin/rancheck`, GSL 2.8) and this machine's libSystem.
Nothing here is invented, and nothing here is needed at runtime — the probes exist so the
fixtures can be audited and regenerated.

Requires: the native tree at `../polyworld` (built), Homebrew GSL (`/opt/homebrew`),
`clang`, `python3`. All commands are run from this directory unless noted.

## 1. The RNG streams (`raw/rng_probe.out`, `raw/rng_seed_vectors.out`)

```sh
# the lane's acceptance table, verbatim
../polyworld/bin/rancheck                      # → RANCHECK_STDOUT

# full-precision vectors: rand/drand48/lrand48/random/MT19937/GSL
# uniform|uniform_pos|ugaussian|range, nrand() (with its draw counts), interp()
clang++ -std=c++17 -O0 -I../polyworld/src/library/utils raw/rng_probe.cc \
    ../polyworld/.bld/library/utils/misc.o -lc++ \
    -I/opt/homebrew/include -L/opt/homebrew/lib -lgsl -lgslcblas -o rng_probe
./rng_probe > raw/rng_probe.out                # `nrand()` links the native misc.o

# five draws per stream for seeds 0, 1, 2, 42, 12345, 2^31-1, 2^32-1, and the 180,000-value
# log() sweep used while pinning libm
clang++ -std=c++17 -O0 -I/opt/homebrew/include raw/rng_vectors.cc \
    -L/opt/homebrew/lib -lgsl -lgslcblas -o rng_vectors
./rng_vectors > rng_vectors.out                # seeds → raw/rng_seed_vectors.out (first part)
```

`raw/rng_probe.out` is committed whole (~4 kB). `raw/rng_seed_vectors.out` is the seed-vector
part of `rng_vectors.out` (~3 kB); the 7 MB `LOG_BIG` section of that run is sampled into
`raw/log_big_sample.txt` (1500 stratified lines) because the full sweep is only needed as
evidence, and `gen_native_vectors.py` re-samples it to 800 for the test fixture.

All the probe *sources* referenced above are committed next to their outputs
(`raw/rng_probe.cc`, `raw/rng_vectors.cc`, `raw/libm_probe.cc`, `raw/wide_probe.c`,
`raw/apple_log_impl.h`, `raw/cand_filter.c`, `raw/dump_libm.c`, `raw/logdis.s`,
`raw/log_bytes.bin`, `raw/dump_tables.c`, `raw/zip_corpus.py`; for `pow` the drivers
`raw/powdis.s`, `raw/pow_cand.c` and `raw/wide_pow_sweep.py`; and for the float overloads
`raw/dump_libm3.c`, `raw/sinfdis.s`, `raw/sinf_cand.c`, `raw/sincosf_census.c`,
`raw/sincosf_cand.c`, `raw/sincos_identity.c` and `raw/wide_sinf_sweep.py`, next to their
dumps `raw/sinf_bytes.bin` and the corpora `raw/libm_native_{sinf,cosf,sincosf}.txt`; and for
`powf` the drivers `raw/dump_libm4.c`, `raw/powfdis.s`, `raw/powf_cand.c` and
`raw/wide_powf_sweep.py` with `raw/gen_libm_powf_corpus.py`, next to `raw/powf_bytes.bin`,
`raw/powf_tables.bin` and `raw/libm_native_powf.txt`), so every
fixture can be rebuilt without re-deriving the probes.

### 1a. The gaussian's polar draws (`raw/gsl_polar_probe.out`)

`gsl_ran_ugaussian` draws its two polar components through **`gsl_rng_uniform_pos`**, not
`gsl_rng_uniform` (GSL `gauss.c`): an exact 0 is rejected and redrawn instead of becoming
`u = -1`. A sampled stream can never show the difference (an MT19937 output is 0 with
probability 2^-32), but the two readings consume a different number of draws. So the probe
drives the shipped library — the very `/opt/homebrew/opt/gsl/lib/libgsl.28.dylib` the oracle
links — with a custom `gsl_rng_type` whose `get_double` injects an exact 0.0 at a chosen call:

```sh
clang -O2 -I/opt/homebrew/include raw/gsl_polar_probe.c \
    -L/opt/homebrew/lib -lgsl -lgslcblas -o /tmp/gsl_polar_probe
/tmp/gsl_polar_probe > raw/gsl_polar_probe.out       # byte-identical on re-run
```

It commits the verdict as vectors, not prose: `GSL_FIXED_A` (`[0, 0.75, …]` costs 3 draws —
`uniform` would need 4), `GSL_FIXED_B` (a rejected pair, then a zero in the second component:
5 draws, 1.604712017744792), `GSL_INJECT_1` / `GSL_INJECT_7` (a real `gsl_rng_mt19937(42)`
behind the probe, zero injected at that call: value + cumulative `outer`/`inner` counts per
gaussian), `GSL_NO_INJECT` (the same wrapper with nothing injected), and `GSL_DIRECT_MT42`
(the plain stream, to prove the wrapper itself is faithful). `tests/rng.test.ts` asserts all of
them, draw counts included.

The wide sample behind "the port reproduces the shipped GSL" is regenerated on demand (its
output is ~2 MB and stays out of the repo):

```sh
clang -O2 -I/opt/homebrew/include raw/gsl_gaussian_sweep.c \
    -L/opt/homebrew/lib -lgsl -lgslcblas -o /tmp/gsl_gaussian_sweep
/tmp/gsl_gaussian_sweep 42 100000 > /tmp/gsl_gauss_42.txt   # %.17g, one per line
```

and compared against `Mt19937.gaussian()` over the same stream: **300,000/300,000 exact**
(seeds 42, 7, 12345). Note that this sweep passes with or without the `uniform_pos` fix —
an exact 0 never occurs in a sampled run, which is exactly why the injected-zero probe above
is the evidence that matters for that decision.

## 2. `log()` — the whole story, because no approximation matched

`nrand()` and `gsl_ran_ugaussian()` both call `log()` and their results are logged, so a
1-ulp difference breaks byte parity. Measured against this machine's libm:

| candidate | disagreement with native (180,000 samples) |
|---|---|
| V8 `Math.log` | ~4.6% |
| fdlibm `e_log.c` (the usual source of `log`) | ~5.7% |
| Arm optimized-routines `log` (12 variants: poly orders 10/11/12 × 6/7 × fma on/off) | 0.10% – 0.12% |
| correctly rounded `log` (double-double, verified against exact `ln` with Python `decimal`) | 0.06% |

So the oracle's `log` is very accurate but *not* correctly rounded, and it is not any of the
common implementations. It was therefore transcribed from its own disassembly:

```sh
clang -O0 dump_libm.c -o dump_libm && ./dump_libm     # writes log_bytes.bin: 4 kB of the
                                                      # shipped log() machine code
clang -c logdis.s -o logdis.o && objdump -d logdis.o  # logdis.s is `.incbin "log_bytes.bin"`
```

That gave the algorithm (see the PORT-NOTE in `../libm.ts`) and the location of its data:
`adrp x1, 0x2d000 / add x1, x1, #0xf90` → 6 polynomial coefficients followed by **129**
32-byte table entries (index `(2^44 + mantissa) >> 45` can be 128, and the 129th entry is
`{1/2, log(2)-ln2, 0, 0}` — the table's own boundary guard). `dump_tables.c` prints that
region as text; it is committed as `apple_log_table.txt` and converted to TypeScript by
`gen_apple_log_table.py`.

Two details that a source-only port would miss:

* LLVM's `fnmsub Dd, Dn, Dm, Da` means **`Dn*Dm - Da`** (its `fmsub` is `-(Dn*Dm) + Da`):
  the ARM manual's mnemonic naming is the opposite of the toolchain's. Confirmed by compiling
  `-(a*b)+c`, `(a*b)-c`, `-(a*b)-c`, `a*b+c` and reading the encodings (see the commit's
  scratch `fmaenc.c`); getting this backwards flips the sign of the whole remainder term.
* JS has no `fma`, so `libm.ts` emulates it (Dekker two-product + Knuth two-sum).

Verification of the transcription, in C first and then in TypeScript:

```sh
clang -O0 -ffp-contract=off raw/apple_log_impl.h cand_filter.c ... # C transcription
python3 zip_corpus.py LOG_WIDE ./cand_filter wide_probe.out        # 23,640/23,640 exact
```

and for the ported TypeScript: 204,766/204,766 exact over `raw/libm_probe.out`'s corpus,
`raw/log_big_sample.txt` and `raw/log_wide_sample.txt` (the last two are samples of
180,000- and 23,640-value sweeps; both full sweeps were checked during development).

## 3. `exp()` — the libm census, and the second transcription

`log` was not the only transcendental the model's *logged* numbers pass through: `exp` is on
the firing-rate path (`logistic`), the spiking model's bias coin, `utils/distributions.cc`,
`complexity_algorithm.cc` and `analysis.cc`; `sin`/`cos` are on the motion path
(`agent.cc:1150-1151`) and the camera; `pow` is in the genome and the distributions. The
census below is the step the card asks for first: **measure, then decide**. The reference is
a correctly rounded value computed with Python's `decimal` (`float()` of a `Decimal` is
correctly rounded), cross-checked at +40 digits so a precision-sensitive input cannot be
mistaken for a disagreement.

```sh
clang -O2 raw/libm_census.c -o /tmp/libm_census           # the shipped libSystem functions
python3 raw/gen_libm_corpus.py                            # raw/libm_args_<fn>.txt (+ meta)
for f in exp sin cos pow; do
    /tmp/libm_census < raw/libm_args_$f.txt > raw/libm_native_$f.txt
done
python3 raw/census_libm.py                                # + V8's Math.*, → raw/libm_census.out
```

| function | corpus | native == correctly rounded | native == V8 `Math.*` |
|---|---|---|---|
| `exp` | 8,261 | **8,255 (99.93 %)**, max 1 ulp | 7,883 (95.4 %), max 1 ulp |
| `sin` | 5,055 | 4,858 (96.10 %), max 1 ulp | 4,838 (95.7 %), max 1 ulp |
| `cos` | 5,055 | 4,860 (96.14 %), max 1 ulp | 4,845 (95.9 %), max 1 ulp |
| `pow` | 4,471 | 4,373 (97.81 %), max 1 ulp | 4,084 (91.3 %), max 1 ulp |

None of the four is correctly rounded, so — exactly as for `log` — a correctly rounded
reimplementation would be wrong on a fraction of inputs and the only route is transcription.
The corpora are structured so every branch is hit: the recorded 512-value `-30..30` sweep,
per-octave sweeps, the branch thresholds exactly `raw/gen_libm_corpus.py` writes (both
`sin`/`cos` dispatch boundaries and their ±3 ulp neighbours; the `pow` special-case ladder,
±0/±inf/NaN), the model's own argument ranges, and the special paths.

### 3a. `exp`, transcribed (`../libm.ts`, `../appleExpTable.ts`)

The shipped `exp` is a table-driven implementation: `t = x * (128/ln2)`, `n = floor(t)`,
`z = t - n`, a 128-entry table of `{2^(j/128), low correction}` at `n & 127`, a factored
polynomial `C4·r·(r(z+C0)+C2)·(r(z+C1)+C3)` ≈ `e^(r·ln2/128) - 1`, and the `2^(n>>7)` scale
applied by **adding `q << 52` to the bit pattern** (an integer add on the double register,
not an FP add); results below `2^-1022` take a separate branch that works in the `2^-1022`
domain and scales at the end.

```sh
clang -O0 raw/dump_exp_data.c -o /tmp/dump_exp_data && (cd raw && /tmp/dump_exp_data)
    # → raw/exp_bytes.bin (4096 bytes of the live /usr/lib/system/libsystem_m.dylib exp)
clang -c raw/expdis.s -o /tmp/expdis.o && objdump -d /tmp/expdis.o   # the algorithm
python3 gen_exp_table.py                 # → raw/apple_exp_table.h, ../appleExpTable.ts

clang -O2 -ffp-contract=off raw/exp_cand.c -o /tmp/exp_cand
/tmp/exp_cand < raw/libm_args_exp.txt | diff - raw/libm_native_exp.txt   # identical
python3 raw/wide_exp_sweep.py 200000     # 320,121 values, all bit-exact
```

Two details a source-level port gets wrong, both settled by experiment, not by reading:

* the `2^q` scaling is an **integer** add of the bit patterns. `objdump` prints it as
  `add d0, d0, d1` on the double registers (encoding `0x5ee18400`): that is the
  vector-integer ADD the compiler emits when both operands live in FP registers, and it adds
  `q` to the exponent field. In TypeScript it is `hi += q << 20` on the high word.
* LLVM's mnemonics: `fmsub Dd,Dn,Dm,Da` is `Da - Dn*Dm`, `fnmsub` is `-Dn*Dm + Da`. Settled by
  compiling `c - a*b`, `-(a*b) + c`, `a*b - c`, `a*b + c` and reading the encodings back
  (`raw/fmaenc2.c`): the first two are `fmsub`, the third `fnmsub`. The transcription writes
  every fused step as an explicit C `fma()`, so the port does not depend on the mnemonics.

`tests/rng.test.ts` replays all 8,261 corpus values through the port's `exp` and asserts the
bits, plus a guard that the port is *not* `Math.exp` (V8 disagrees with the oracle on 396 of
them) and the edge cases (overflow at `709.78271289338409`, `exp(-745.0)` = the smallest
subnormal, underflow to 0 at `-745.25`, `-inf`, NaN, ±0).

`sin`/`cos` are **no longer the measured-but-untranscribed pair**: they are transcribed the
same way (§3b below), and so is `pow` (§3c) — the census' last function and the lane's last
libm gap.  Every function in the table above is now a transcription, and so are the **float**
overloads the model's own call sites really reach: `sinf`/`cosf`/`__sincosf_stret` (§3d/§3e)
and `powf` (§3f), the last of the transcriptions.

### 3b. `sin`/`cos`, transcribed (`../libm.ts`, `../appleSinCosTable.ts`)

`sin` and `cos` are one unit in libsystem_m (`sin` at the symbol, `cos` at `+0x16c`); both are
on the model's **frozen** motion path (`agent.cc:1150-1151`) and in the camera, and the census
says neither is correctly rounded (96.10 % / 96.14 %), so both are transcriptions of the
shipped machine code:

```sh
clang -O0 raw/dump_libm2.c -o /tmp/dump_libm2 && (cd raw && /tmp/dump_libm2)
    # → raw/sincos_bytes.bin (5120 bytes: sin-0x400 .. sin+0x1000), raw/pow_bytes.bin
    #   (the same window around pow) and raw/pow_tables.bin (7168 bytes: pow's log table at
    #   +0x280, 16 entries, and its 128-entry exp table at +0xcb0, both reached by
    #   PC-relative `adrp`+`add` pairs ~170 kB away from pow's code)
python3 gen_sincos_table.py
    # → raw/apple_sincos_table.h + ../appleSinCosTable.ts; it checks the extracted 1/pi
    #   table against an independently computed expansion of 1/pi, and the constants'
    #   bit patterns against the exact values

clang -O2 -ffp-contract=off raw/sincos_cand.c -o /tmp/sincos_cand
(cd raw && /tmp/sincos_cand < libm_args_sin.txt | diff - libm_native_sin.txt)   # identical
(cd raw && /tmp/sincos_cand < libm_args_cos.txt | diff - libm_native_cos.txt)   # identical
```

`tests/rng.test.ts` replays all 5,055 + 5,055 corpus values through the port and asserts the
bits, plus that the port is *not* `Math.sin`/`Math.cos` (V8 disagrees with the oracle on 217 +
210 of them), the branch coverage (both dispatch boundaries and their ulp neighbours, ±inf,
NaN, 1e17/1e300) and the edge cases.

Four things a source-level port gets wrong (all four documented in the header comments of
`raw/apple_sincos_impl.h` and `../../libm.ts`):

* the Payne-Hanek mask+normalise is **not** a scale change: the continuations undo the
  `clz` normalisation by subtracting `clz << 52` from the converted double's *bit pattern* —
  an integer `sub` on a double register, i.e. an exact division by a power of two (the same
  family of trick as `exp`'s integer exponent add, and `2*clz` in the cos continuation
  because its value is squared).
* the 2/π… table the walk reads is really **1/π**, stored with the most significant 64-bit
  chunk at the *highest* address, and the four-word window is a **little-endian** 256-bit
  slice `floor(1/pi * 2^(64*(k+3)))`.  Reading it big-endian is 64 bits off.
* both sign flips are bit-pattern operations (`eor.16b v0, v0, v10`; `add d0, d0, ±0.0` for
  cos), never FP ops.
* the flip must be applied exactly once — the two Payne-Hanek continuations return through
  the same flip the medium tails use.

### 3c. `pow`, transcribed (`../libm.ts`, `../applePowTable.ts`)

`pow` is the census' last function and the lane's last libm gap: it is on three genome paths
(`GeneInterpolationPower` → `interpolate`, `mutateBytes` → `2^MutationStdevPower`,
`mateProbability`) and in `utils/distributions.cc` (`Patch::setPoint`'s GAUSSIAN).  The oracle's
is **not** correctly rounded (4,373/4,471 = 97.81 %; V8 4,084 = 91.3 %), so it is a
transcription like the others — except that it calls none of them: `pow` inlines its own log2
(a 129-entry table) and its own exp2 (a 128-entry table), and both tables sit ~170 kB away from
its code, reached by `adrp`+`add` pairs (`adrp x1, 0x2b000 / add x1, x1, #0x870` for the log
table, `adrp x0, 0x2c000 / add x0, x0, #0xb0` for the exp table).

```sh
clang -O0 raw/dump_libm2.c -o /tmp/dump_libm2 && (cd raw && /tmp/dump_libm2)
    # → raw/pow_bytes.bin (5120 B of the live pow, pow at +0x400) and raw/pow_tables.bin
    #   (7168 B of its data window: the log table at +0x470, the exp polynomial at +0xc88 and
    #   the exp table at +0xcb0; the polynomial/logc constants are at +0x418..+0x468)
clang -c raw/powdis.s -o /tmp/powdis.o && objdump -d /tmp/powdis.o   # powdis.s is an .incbin
python3 gen_pow_table.py
    # → raw/apple_pow_table.h + ../applePowTable.ts; it checks the extracted tables against
    #   independently computed values (see below) and asserts every constant's bit pattern

clang -O2 -ffp-contract=off raw/pow_cand.c -o /tmp/pow_cand
(cd raw && /tmp/pow_cand < libm_args_pow.txt | diff - libm_native_pow.txt)   # identical
clang -O2 raw/libm_census.c -o /tmp/libm_census
python3 raw/wide_pow_sweep.py 40000    # 189,368 (x, y) pairs, all bit-exact
```

The C transcription is bit-exact on all **4,471** corpus values and on the **189,368**-pair
wide sweep (which covers what the committed corpus does not: `y = ±0`, `x = 1`, `|y|` at the
2^-65 / 2^64 guards, subnormal bases, and raw bit patterns for both operands).  The port then
matches both.  `tests/rng.test.ts` replays the corpus, carries the sweep's ladder rows as a
table, and asserts the port is *not* `Math.pow` (V8 disagrees on 387 of the 4,471).

Four things a source-level port gets wrong (all documented in the header comments of
`raw/apple_pow_impl.h` and `../../libm.ts`), with the number of corpus values that move if the
reading is changed:

* the exp assembly is **bit-pattern arithmetic**: `2^(n>>8)` is the bare exponent field
  `(n<<44) & 0xfff0000000000000`, the table entry's pattern is *integer-added* to it (that add
  is what supplies the +1023 bias), and the trailing factor is
  `((n<<45)&mask) - ((n<<44)&mask)` added to 1.0's pattern — the two-shift split that keeps the
  exponent field in range for the whole `n` domain, negative `n` included.  An FP multiply
  instead of the add moves 4,262 of the 4,471.
* the log table's 16-byte entries are **not two little-endian doubles**: the first 8 bytes are
  two 32-bit halves packed `{high word of invc, high word of logc_lo}`, read as `ldr s2` +
  `shl.2d v2, v2, #32` and as `and 0xffffffff00000000`; the low halves are zero by
  construction.  `invc` is only a coarse hand-chosen reciprocal (within 2.4e-4 of
  `1/(1+i/128)` — enough to hold |r| under 1/256) and the accuracy lives in
  `logc_hi + logc_lo`, which the generator checks to be the **exact** `-log2(invc)` (4.5e-26
  over all 128 non-boundary entries), minus one for the `i >= 64` rows — the same
  `k = floor(log2 x) + 1` convention the shipped `log` table uses.  Dropping that column moves
  108 values.
* the shipped code **clears loghi's last mantissa bit** (`and 0xfffffffffffffffe`) before the
  hi/lo split; 28 corpus values move if it is dropped.
* the fast path is a positive normal `x` with a `y` in [2^-65, 2^64) only — the second guard is
  an *unsigned* 64-bit subtract, so every negative `y` takes the ladder — and then the *signed*
  `y` drives the exponent arithmetic: `t = (y*128)·log2 x` is negative for a negative `y` and
  the two-shift assembly handles a negative `n` directly, so no reciprocal is needed.  The
  ladder's `|y|` is only used for the range tests and the parity question (`fcvtzs` after
  clamping to 2^53), which is what makes "y is an odd integer" answerable for a negative base —
  and it is what feeds the sign that rides through the exponent fields.

### 3d. `sinf`/`cosf` — the float overloads, decided with numbers

`CameraController.cc:78-80` passes a C++ `float`, so L14 calls **`sinf`/`cosf`**, not `sin`/
`cos`; L14 currently computes `Math.fround( sin( x ) )` off the double transcription.  The
question (PARITY.md open question 9) is whether that is enough.  Measured over
`raw/libm_native_{sinf,cosf}.txt` — 5,016 distinct float32 arguments (the double corpus's
arguments cast to float32, plus the camera's own `yaw * DEGTORAD` for 1,000 yaws; built by
`raw/gen_libm_sinf_corpus.py`, captured by `raw/libm_census.c`'s `sinf`/`cosf` cases):

| | disagreements with the shipped `sinf` / `cosf` |
|---|---|
| `Math.fround( Math.sin )` / `Math.fround( Math.cos )` | 304 / 5,016 (6.1 %), 135 / 5,016 (2.7 %) |
| `Math.fround( ported sin )` / `Math.fround( ported cos )` | 304 / 5,016, 135 / 5,016 |

So rounding the *double* function to float32 is not the float overload: the failures are
where the float32 argument sits close enough to a midpoint that the intermediate double
rounding decides the result, and no double-precision transcription can fix that.

**Resolved (`t_05611902`):** the float overloads are transcribed, and doing it turned up a
second finding — **the camera does not call them, and the 117 recorded frames are what say so.**

```sh
clang -O0 raw/dump_libm3.c -o /tmp/dump_libm3 && (cd raw && /tmp/dump_libm3)
    # → raw/sinf_bytes.bin (5120 B: `sinf` at +0x400, `cosf` at +0x2f0,
    #   `__sincosf_stret` at +0x5ac -- all one unit, sharing one reduction table)
clang -c raw/sinfdis.s -o /tmp/sinfdis.o && objdump -d /tmp/sinfdis.o
python3 gen_sinf_table.py          # → raw/apple_sinf_table.h + ../appleSinfTable.ts
python3 raw/sinf_decision.py       # the measurement above, re-runnable

clang -O2 -ffp-contract=off raw/sinf_cand.c -o /tmp/sinf_cand
(cd raw && /tmp/sinf_cand < libm_args_sinf.txt | diff - libm_native_sinf.txt)   # identical
(cd raw && /tmp/sinf_cand < libm_args_cosf.txt | diff - libm_native_cosf.txt)   # identical
clang -O2 raw/sincosf_census.c -o /tmp/sincosf_census    # the shipped two-output entry (dlsym)
clang -O2 -ffp-contract=off raw/sincosf_cand.c -o /tmp/sincosf_cand
(cd raw && /tmp/sincosf_cand < libm_args_sinf.txt | diff - libm_native_sincosf.txt)  # identical
python3 raw/wide_sinf_sweep.py 20000   # 105,119 arguments x 3 functions, all bit-exact
```

`sinf`/`cosf` are *not* the double transcriptions narrowed: they have their own tables, their
own dispatch (`2^-12`, the float neighbour of `pi/4`, `120`, `2^26`), **no Payne-Hanek at all**
(one-part `pi/2`, one fused step) and a medium index that is `n+1` for `cosf` — and their
large-argument reduction multiplies by a **per-exponent** constant `1/pi - A/2^s` (`s = 2i-23`,
`A = round(2^s/pi)`), a dyadic ghost of `1/pi` whose denominator divides any float32 of that
entry's exponent, so `x*(hi+lo)` differs from `x/pi` by an *exact integer* and the `rint()`
yields `x/pi`'s own quadrant. The C transcription is bit-exact on all **5,016 + 5,016** corpus
values and the port matches every one; `Math.fround( Math.sin )` / `Math.fround( ported sin )`
stay wrong on the 304 + 135 cases above.

### 3e. `__sincosf_stret` — what the camera actually calls (`t_05611902`)

Switching `src/model/monitor/cameraController.ts` onto the transcribed `sinf`/`cosf` moved a
recorded frame (`rotate[3]` frame 3: `1123315326` instead of the recorded `1123315328`). The
cause is not the argument path (the shipped `setRotationAngle(float)` computes
`float camrad = angle * DEGTORAD` in double and narrows, exactly as the port does, and the
accumulated `angle` is a `float` member — the port already narrows it in `step()`): it is the
**call**, which the disassembly shows directly —

```
bl 0xa3994 ; symbol stub for: ___sincosf_stret
```

— LLVM's sincos combine merged the two adjacent `sin(camrad)`/`cos(camrad)` calls into the
two-output entry point at `sinf + 0x1ac` (`dlsym` confirms the address). That function is a
*different algorithm* from the scalar pair: it reduces with the **doubled** argument against the
same per-exponent table (no `+0.5`), gives the medium path no `pi/2` subtraction at all
(`u = x*2/pi - rint(x*2/pi)`), evaluates the sine and cosine lanes in one 2-vector pass (its own
10-coefficient table, checked in `gen_sinf_table.py` against `pi/2` and `1` at `u = 0` and the
next Taylor terms), and saturates its quadrant conversion for `|x| > 2^63`. Over the same 5,016
float32 arguments its sine disagrees with `sinf` on **305** rows and its cosine with `cosf` on
**133** — and one of those is the frame's argument (`cosf` → `0x3ee29cc2`, `__sincosf_stret` →
`0x3ee29cc3`). `raw/libm_native_sincosf.txt` is that function's own corpus (captured through
`dlsym` by `raw/sincosf_census.c`), the C transcription (`raw/sinf_cand.c`'s `apple_sincosf`) is
bit-exact on it and on the wide sweep, and `libm.ts#sincosf` reproduces both.

**Decision:** the float surface is `sinf`, `cosf` **and** `sincosf` in `src/model/rng/libm.ts`;
L14 calls `sincosf`, and all 117 recorded camera frames are bit-exact against it with no
double-rounding stand-in. The lesson generalises past this card: at `-O2` the compiler decides
which libm entry a call reaches (it fused two `float` calls into one two-output call), so a
transcription has to be pinned by the *shipped binary's* disassembly, not by the source's
argument types.

### 3f. `powf` — the float overload both `_powf` sites call (`t_29e0a2fc`)

`pow`'s transcription (`t_c10975cb`) found that **two of the four "`pow`" call sites in the
model are not `pow` calls at all**, so `pow` could not be switched there: the oracle calls the
C++ `float` overload `powf`.  Measured on those two sites' own argument domains — the base ×
slope lattice for `mateProbability` and the `(e, -(x-mu)^2/(2 sigma^2))` shape for
`normalPDF`/`getNormal`, 797,034 pairs in all — the double transcription and V8's `Math.pow` are
bit-identical to *each other* (0 pairs differ) and each disagrees with the shipped `powf` on
0.13-0.90 % of them, every difference 1 ulp: rounding the double function to float32 is not the
float overload, exactly the finding §3d measured for `sinf`/`cosf`.  So `powf` is its own
transcription:

```sh
clang -O0 raw/dump_libm4.c -o /tmp/dump_libm4 && (cd raw && /tmp/dump_libm4)
    # → raw/powf_bytes.bin (5120 B: powf at +0x400) and raw/powf_tables.bin
    #   (8192 B of the data window: the exp polynomial at +0x2bc90, the 128-entry exp table at
    #   +0x2bca0, the log polynomial at +0x2c8d0 and the 128-entry log table at +0x2c8f0; the
    #   float constants are in powf_bytes.bin at +0x25c..+0x27c)
clang -c raw/powfdis.s -o /tmp/powfdis.o && objdump -d /tmp/powfdis.o   # an .incbin
python3 gen_powf_table.py
    # → raw/apple_powf_table.h + ../applePowfTable.ts; it *checks* the tables (below)

clang -O2 raw/libm_census.c -o /tmp/libm_census        # now has a `powf` case
python3 raw/gen_libm_powf_corpus.py                    # → raw/libm_args_powf.txt (7,325 pairs)
(cd raw && /tmp/libm_census < libm_args_powf.txt > libm_native_powf.txt)
clang -O2 -ffp-contract=off raw/powf_cand.c -o /tmp/powf_cand
(cd raw && /tmp/powf_cand < libm_args_powf.txt | diff - libm_native_powf.txt)   # identical
python3 raw/wide_powf_sweep.py 200000 /tmp/powf_wide.txt   # 175,000 pairs: census == candidate
npx tsx tools/measure_powf.ts /tmp/powf_wide.txt           # port == native on all of them
```

The corpus is built from four sources so a port cannot pass one of them and be wrong where the
model calls it: the model's own `(e, ratio)` pairs re-derived from L10's pinned
`normalpdf_sweep.tsv` (1,296 rows), `mateProbability`'s `(fabs(cosa), slope)` lattice, a wide
float lattice (every binade, the binade boundaries, subnormals, the model's exponent grid) and
the special-case ladder.  It is `raw/libm_census.c`'s second two-argument function, so the
`powf` line is `powf <argbits> <argbits> <resultbits>` with both arguments cast to `float` —
which is what the C++ overload does.

The C transcription is byte-identical to the shipped `powf` on all **7,325** corpus values and
on all **175,000** pairs of the wide sweep, and the port matches both
(`npx tsx tools/measure_powf.ts`; V8's `Math.pow` misses 196 of the corpus rows and the double
`pow` narrowed to float32 misses 37 — neither is a substitute).  Cost: **0.16 us/call** against
`Math.pow`'s 0.05, i.e. 3x, not `pow`'s 26x (`npx tsx tools/measure_powf_cost.ts`) — `powf`
needs no BigInt exponent assembly.

Three things a source-level port gets wrong (documented in `raw/apple_powf_impl.h` and
`../../libm.ts`):

* everything is **128-scaled**.  The shipped code computes `L = k + logc[i] + 128*log2(z*invc[i])`,
  which is *exactly* `128*log2(x)` because `logc[i]` is `-128*log2(invc[i])` — so nothing
  cancels — and the exp side is `2^(t/128)`, assembled from a table whose entries are
  `bits(2^(j/128)) - (j << 45)`.  That subtraction is what makes the single 64-bit
  `add x1, x2, x1, lsl #45` exact for every integer `n` with `n & 0x7f == j` (it never borrows:
  `2^(j/128) - 1 > j/128` on [0,127]); reading the table as plain `2^(j/128)` and multiplying
  instead of adding is a different function.
* `fnmsub d0, d2, d0, d3` is **`z*invc - 1`**, LLVM's operand order (`Dn*Dm - Da`), the same
  trap §3a/§3c document.  Reading it as `1 - z*invc` flips the sign of the correction and moves
  every row whose `z` is not exactly on the table's lattice — the model's own 1,296 rows among
  them.
* the reduction's *float* half is only ever an **index**: `m = bits(x) - 0x3f338000` supplies the
  7-bit bin index (`(m >> 16) & 0x7f`) and the binade `k = asr32(m & 0xff800000, 16)`, and the
  residual is the *float* pattern `w4 = bits(x) - (m & 0xff800000)` (i.e. `1.mantissa`) converted
  to double.  The generator checks the lattice that makes this work: `1/POWF_LOG_INVC[i]` is
  `n_i/256` with `n_i = 180 + i` up to `i = 76` and `256 + 2*(i - 76)` above it (the step doubles
  once the lattice crosses 1.0), and `POWF_LOG_LOGC[i]` is `-128*log2(invc[i])` to within
  ~2e-14 (the table was built with a slightly coarser log2 than the exact one), while
  `POWF_EXP_TAB[j] == bits(2^(j/128)) - (j << 45)` holds for all 128 entries.

Two behaviours of the shipped code worth recording because they look like bugs and are not:
`powf` answers `y = ±0` *and* `y = ±inf` in the same ladder (the sign/±inf decision is a bit mask
on `(|x| - 1) ^ y`, so `powf(2, +inf)` is `+inf` and `powf(0.5, +inf)` is `+0`), and the parity
test for a negative base **clamps `|y|` to 2^24**, so every `|y| >= 2^24` counts as an even
integer (`powf(-1.5, 33554433)` is `+inf`, not `-inf`).  The port reproduces both, and the
corpus carries the neighbours of every one of those boundaries.

### 3g. `atan2f` — the other float overload, and the end of the census (`t_4bb10112`)

The last libm unknown on the port's books, and the one lane W1e's census measured *before* the
transcription existed: `frustumXZ::Inside` (`gmisc.cc:335`) is the native tree's only `atan` call
site and it computes `float ang = atan2(x0 - p[0], z0 - p[2])` from two `float`s, so the oracle
calls **`atan2f`**.  The port stood in `f32(Math.atan2)` plus the two ±π values; on the census'
20,050 committed argument pairs that stand-in differed from the shipped function by 1 ulp on
**460** rows (2.3 %) — every one of them outside the ±π family the correction covered, the
model's own `reachable-lattice` class included (204/4,532) — and on 18,279 of a 606,583-pair wide
sweep (3.0 %).  A 60-digit reference decided which side was wrong: **the shipped `atan2f` is the
1-ulp-off one** (`geometry/native/raw/verify_atan2f_correct_rounding.py`: the true angle is
nearer `f32(atan2)` on 177/179 decided rows), so this is a transcription, not a "fix".

```sh
clang -O0 raw/dump_libm5.c -o /tmp/dump_libm5 && (cd raw && /tmp/dump_libm5)
    # → raw/atan2f_bytes.bin (768 B: atan2f at +0x40, the nine-double polynomial at +0x220, the
    #   eight angle constants at +0x270..+0x2b8 — one window, nothing reached by an off-page
    #   `adrp`) and raw/atan2f_bytes.identity.txt (the same fnv1a256 the census' `--identity`
    #   prints, plus the symbol's page offset, which the `adrp`+`add` displacement needs)
clang -c raw/atan2fdis.s -o /tmp/atan2fdis.o && objdump -d /tmp/atan2fdis.o   # an .incbin
python3 gen_atan2f_table.py
    # → raw/apple_atan2f_table.h + ../appleAtan2fTable.ts; it *decodes the displacements* from
    #   the code words and refuses to emit if an `adr`/`adrp`+`add`/`ldr <label>` stops pointing
    #   at its constant
clang -O2 -ffp-contract=off -I. raw/atan2f_cand.c -o /tmp/atan2f_cand
(cd raw && /tmp/atan2f_cand < ../geometry/native/raw/atan2f_native.txt \
     | diff - <(cut -d' ' -f1-4 ../geometry/native/raw/atan2f_native.txt))   # identical
npx tsx tools/measure_atan2f.ts          # port != native: 0 in every class
npx tsx tools/measure_atan2f_cost.ts     # the cost line (0.060 us/call)
```

The census itself is lane W1e's (`src/model/geometry/native/**`, `PARITY.md` → *The `atan2f`
census*): 20,050 argument pairs over 12 argument classes, built by `raw/gen_atan2f_corpus.py`
and captured from the shipped function by `raw/atan2fprobe.c`, which `dlsym`s `atan2f` **and**
`atan2` and calls both through function pointers so LLVM cannot fold
`(float)atan2((double)y,(double)x)` into `atan2f` and make the census measure "atan2f == atan2f".

The C transcription is byte-identical to the shipped `atan2f` on all **20,050** census rows and
on all **606,583** rows of the wide sweep (`atan2fprobe.sh wide 200000`), and the port matches
both.  What is left of the old residual is *recorded*, not smuggled away: `f32(Math.atan2)` still
differs from the shipped function on 3,924/20,050 (19.571 %), and `tools/
witness_atan2f_wedge.ts` — which now reconstructs the deleted stand-in locally — still finds
**187 of 244** differing reachable pairs whose wedge limit lands exactly on the differing float
and flips an `Inside` verdict, with the transcription agreeing with the shipped function on all
460 of the rows that used to differ.

The algorithm (instruction by instruction in `raw/apple_atan2f_impl.h`):

* a four-arm ladder on **float** comparisons of `y` against `x` and `-x`, so every arm evaluates
  the *reduced* ratio with `|r| <= 1`: `P(y/x)` for `-x < y < x`, `pi/2 - P(x/y)` for
  `y >= x > -y`, `-pi/2 - P(x/y)` for `y < x <= -y`, and — for the `x <= 0` quadrant —
  `sign(y)*pi + P(y/x)`, plus the exact `+-pi/4` / `3pi/4` arms at `y == x` and `-x == y`;
* `P` is a **double-interior polynomial in the ratio**: both operands `fcvt`'d to double, a
  double `fdiv`, then four quadratics in `u = r*r` evaluated two-at-a-time with
  `fadd.2d`/`fmla.2d`: `T8*(u^2+T0 u+T2)(u^2+T4 u+T6)*(u^2+T1 u+T3)(u^2+T5 u+T7)*r`, every fused
  step a single rounding, one `fcvt s0, d0` at the end.  It is a *float-accuracy* fit — the
  generator measures 0.36 float32 ulp over [-1,1], and the `u^1` coefficient is `-0.333331738`,
  4.8e-6 off the Taylor `-1/3` — which is exactly why the shipped function is **not**
  `f32(atan2)`;
* the `x <= 0` arm's `|y/x| < 2^-22` branch (`fcmp` + `b.mi`) answers `ATAN2F_PI_HI`, which is
  **`f32(pi)` rounded toward zero plus exactly `2^-32`** (`0x1.921fb4008p+1`) — *not* `pi`.
  That is where arm64's `atan2f(0, -1) == 0x40490fda` comes from (the correctly rounded
  `f32(atan2)` is `0x40490fdb`): the ±π behaviour the port used to special-case by hand.  `pi/2`,
  `pi/4` and `3pi/4` are the exact doubles, so those boundaries *do* round correctly;
* the ladder's `b.pl`/`b.mi` are `N`-based, so `!(a < b)` is taken when the comparison is
  unordered as well — the `fadd s0, s0, s1` NaN answer is only reached through the `y >= x`
  half — and the `y == x` / `-x == y` boundary tests are *float* equalities (`-0 == +0` counts),
  which is what makes the origin's `+-0` / `+-pi` and the exact `+-pi/4` / `3pi/4` arms work.

Cost: **0.060 us/call** on the model's own lattice, against the deleted stand-in's 0.174 and
`f32(Math.atan2)`'s 0.021 (`tools/measure_atan2f_cost.ts`) — ~3x *cheaper* than what it replaces,
and `Inside` has no call site in `src/model/**` today anyway, so this is a latent-divergence fix
rather than a scenario fix.

## 4. FMA contraction in the *model's* code

The oracle's build contracts `a*b + c` into a fused multiply-add. Two places in this lane's
surface are affected, both measured against the oracle's own output:

* `nrand()`: `s = u*u + v*v` ships as `fma(u, u, v*v)` (`misc.cc`, compiled without
  `-ffp-contract=off`);
* `gsl_ran_ugaussian()`: `r2 = x*x + y*y` ships as `fma(x, x, y*y)`.

While in that function: GSL's `gauss.c` also draws the components with `gsl_rng_uniform_pos`
(see §1a) — a `uniform` reading is wrong and desynchronises the stream once a raw draw is
exactly 0.

With the plain sums the port reproduces most draws but misses ~1 in 10 (for `nrand`) by 1 ulp.
Anyone porting another module should assume the same contraction is present wherever the C
source has a multiply feeding an add, and check the captured vectors rather than the source.

## 5. Regenerating the fixtures

```sh
python3 prep_raw.py <dir-with-the-probe-outputs>   # copies/samples raw/*.out
python3 gen_native_vectors.py                      # → ../nativeVectors.ts
python3 gen_apple_log_table.py                     # → ../appleLogTable.ts
python3 gen_exp_table.py                           # → ../appleExpTable.ts
python3 gen_sincos_table.py                        # → ../appleSinCosTable.ts
python3 gen_sinf_table.py                          # → ../appleSinfTable.ts
python3 gen_pow_table.py                           # → ../applePowTable.ts
python3 gen_powf_table.py                          # → ../applePowfTable.ts
python3 gen_atan2f_table.py                        # → ../appleAtan2fTable.ts
```

All the generators are deterministic; `../nativeVectors.ts`, `../appleLogTable.ts`,
`../appleExpTable.ts`, `../appleSinCosTable.ts`, `../applePowTable.ts`, `../applePowfTable.ts` and
`../appleAtan2fTable.ts` are generated files and should not be edited by hand.  Each one reads a dump of the *running* libSystem and asserts
the values it extracted against independently computed references (the log table's `1/pi`-style
identities, the exp table's `2^(j/128)`, the log table's `inv*c` and `-log2(invc)` identities,
`atan2f`'s `+-pi/2`/`+-pi/4`/`+-3pi/4` against `math.pi` bit for bit and its polynomial's fit
error), so a table cannot silently drift from the machine code.
