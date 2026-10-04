# src/model/complexity

Lane L13 (`library/complexity/**`): the Adami complexity and heuristic-fitness machinery —
`complexity_algorithm.cc`, `complexity_brain.cc`, `adami.cc` — behind the frozen types.

Only the owning lane writes files here.

## What is in here

| File | Contents |
|---|---|
| `algorithm.ts` | `complexity_algorithm.cc`: `Matrix`, `next_combination`, the cross-section/column helpers, `gsamp` + the noise stage, `calcCOV`/`calcC_k(_exact)`/`calcI`, `CalcApproximateFullComplexityWithMatrix` (+ the vector form) |
| `brain.ts` | `complexity_brain.cc`: the brain-function file reader (`readinBrainfunction`/`readinBrainanatomy`, the agent/neuron/lifespan header, the event filter), the `parts` language and `CalcComplexity_brainfunction`/`CalcComplexityWithMatrix_brainfunction` |
| `adami.ts` | `adami.cc`: `computeAdamiComplexity` over the x-sorted agent list, written through lane L12's `TextSink` |
| `gsl.ts` | the two GSL kernels the algorithm calls — `gsl_stats_mean`/`gsl_stats_covariance` (online recurrences) and `gsl_linalg_LU_decomp`/`LU_det` |
| `log2.ts`, `appleLog2Table.ts` | `c_log`'s `log2`, transcribed from the oracle's libm (this machine's `log2` is not correctly rounded) |
| `index.ts` | the lane's public surface |
| `golden/` | the committed differentials: `brain.txt` (the native `CalcComplexity_brainfunction` over the recorded fixtures), `pieces-*.txt` (the pipeline, stage by stage) and `adami/` (the independent reference's output) |
| `native/` | the probes and the reference (`complexityprobe.cc` + `run_complexityprobe.sh`, `gslprobe.c` + `run_gslprobe.sh`, `adami_reference.py`, the corpus/table generators) and their raw output. `log2`'s corpus and its two checks re-run from scratch: `raw/gen_log2_corpus.py` (writes `raw/log2_args.txt` + `raw/log2_native.txt`) and `raw/log2_correct_rounding.py` (how far the machine's own `log2` is from a correctly rounded one) |

## Tests

`tests/complexity.test.ts` (the algorithm, the brain-function differential, the log2 corpus) and
`tests/complexity-adami.test.ts` (Adami: the independent reference, and the recorded-scenario
differential).

## The sim's two call sites

`src/model/sim/agents.ts` used to throw at `analyzeBrain`'s complexity call and at `AgentFitness`'s
weighted branch; **both are wired now** (`t_20d5ff13`, 2026-09-28): `analyzeBrain` reads
`brainAnalysisParms.functionPath` with `parts = ComplexityType` and `AgentFitness` re-reads
`run/brain/function/brainFunction_<n>.txt` when the complexity is still unset, through this lane's
`calcComplexityBrainfunction`. The read-back is injected (`SimulationOptions.brainFunctionBytes`),
and the file open is the sim's `openBrainFunctionFile` — this lane's `openBrainFunctionFile(bytes)`
over the bytes the sim supplies. Verified end to end against the native build:
`tests/sim-complexity-seam.test.ts` and the synthesized `RecordComplexity` fixtures named in
PARITY.md → Gaps.
