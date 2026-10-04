# src/model/geometry/native — the lane's probes

Everything here regenerates a *golden* or answers a *measured* question; nothing here is needed
at runtime, and nothing here writes inside the native tree. Requires `clang`/`cc`, `python3`
(stdlib), and — for `glprobe.sh`/`bodyprobe.sh` only — a **built** native tree at
`POLYWORLD_NATIVE` (default `../polyworld`).

## `glprobe.{cpp,sh}` + `bodyprobe.{cpp,sh}`

The camera/GL and agent-body-mesh goldens: they link the real `gcamera`/`frustumXZ`/`gpolyobj`
objects out of the oracle's `libpolyworld.dylib` and drive the same fixed-function GL the oracle
binary links. See `../../geometry`'s PORT-NOTEs and PARITY.md → lane W1e.

## `atan2fprobe.{c,sh}` + `raw/**` — the `atan2f` census (`t_d3f63606`)

`frustumXZ::Inside` (`gmisc.cc:335`) is the native tree's **only** `atan2` call site and it calls
the *float* overload (`float ang = atan2(x0 - p[0], z0 - p[2]);`). This census measures what that
overload does, against the port's `f32(Math.atan2)` stand-in, bit pattern by bit pattern:

```sh
bash src/model/geometry/native/atan2fprobe.sh identity   # the two dlsym'd symbols, + the +-pi arm
bash src/model/geometry/native/atan2fprobe.sh census     # raw/atan2f_args.txt -> raw/atan2f_native.txt
npx tsx tools/measure_atan2f.ts                          # the port vs the shipped atan2f, per class
npx tsx tools/witness_atan2f_wedge.ts                    # can a wedge limit land on a differing point?
python3 src/model/geometry/native/raw/verify_atan2f_correct_rounding.py 200   # which side is wrong

bash src/model/geometry/native/atan2fprobe.sh wide 200000 /tmp/atan2f_wide_args.txt
npx tsx tools/measure_atan2f.ts /tmp/atan2f_wide_args_native.txt /tmp/atan2f_wide_args.txt
```

Unlike the lane's other probes this one needs **no native tree**: `atan2f` is the platform's libm,
and the native code's only contribution to the question is the *argument types* at that one call
site. The probe `dlsym`s `atan2f` **and** `atan2` and calls both through function pointers on
purpose — at `-O2` LLVM's libcall simplifier folds `(float)atan2((double)y, (double)x)` into
`atan2f` when it can see promoted-float arguments, which would make it measure `atan2f == atan2f`.

* `raw/gen_atan2f_corpus.py` — the 20,050-pair corpus (deterministic; 12 argument classes, from
  the model's own world-coordinate differences out to the whole float range, the ±0/±π/quadrant
  edges, denormals and the specials). Lines are `<ybits> <xbits> <class>`.
* `raw/atan2f_native.txt` — the census' output: `atan2f <ybits> <xbits> <atan2f_bits> <f32atan2_bits>`,
  one native process for the whole corpus.
* `raw/verify_atan2f_correct_rounding.py` — a 60-digit `decimal` reference (exact float32 inputs,
  the argument-halving identity for `atan`) that says *which* of the two candidates is wrong.
* The numbers these produce, and the residual they leave behind, are in PARITY.md → lane W1e
  (*The `atan2f` census*) and in `../float.ts`'s `PORT-NOTE(W1e/atan2f-census)`.  **The census is
  now the acceptance corpus of the transcription it forced** (`t_4bb10112`): the shipped function
  is transcribed in lane L1's `src/model/rng/libm.ts` (constants from
  `rng/native/raw/atan2f_bytes.bin`, extracted and checked by `rng/native/gen_atan2f_table.py`,
  C transcription `rng/native/raw/apple_atan2f_impl.h` diffed against `raw/atan2f_native.txt`
  first — byte-identical on all 20,050 rows here and all 606,583 rows of the wide sweep above; see
  `rng/native/README.md` §3g), `nativeAtan2f` now delegates to it, and `measure_atan2f.ts` reports
  `port != native` **0** in every class while still reporting the pre-transcription stand-in's old
  residue (`f32(Math.atan2)` is 1 ulp off on 3,924 rows) as measured history.
