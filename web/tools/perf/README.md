# L19 — measure first, then decide about WASM

Card: **L19 WASM/perf: measure first, then compile the hot paths**. Its own order is
"1. MEASURE → 2. DECIDE with numbers → 3. *only if* TS is more than ~2x native, compile the
proven hot kernels → 4. report before/after steps-per-second and the parity result".

This directory is step 1's instrument, step 2's rule, and the two bases the rule is applied to.
It writes no model code (`src/model/**`), it changes no golden, and it does not decide anything by
itself — it produces the numbers, and `decide()` in `l19Perf.ts` states the card's verdict next to
them.

**Where the verdict is.** The decision of record is in "The decision (the card's step 2) — closed":
**no WASM boundary was written**, and the numbers that close it are in "Results", labelled
**pre-fix** (`t_b9a4665b`, the 4–6x that triggered the card) and **post-fix** (`t_cfd271a8`, commit
`b50626d`, which removed the logging/formatting cost the profile ranked first). The post-fix tables
carry a re-measurement taken for this revision on HEAD `1a41ff4` (2026-09-29) with both agent counts
and the native basis re-timed in the same hour.

```
tools/perf/l19-native.sh --worldfiles minitest --steps 1   --reps 3   # native, boot-equivalent
tools/perf/l19-native.sh --worldfiles minitest --steps 301 --reps 3   # native, the long run
tools/perf/l19-bench.sh --reps 3                                      # TS, the recorded 25-agent world
tools/perf/l19-bench.sh --agents 192 --steps 301 --reps 3             # TS, the plan's big world
tools/perf/l19-bench.sh --only report                                 # re-combine what is on disk
```

Output under `.candidate/l19-perf/`: `latest.md` (the human report), `report-<scenario>-<agents>-
<steps>reps.md` (a per-configuration copy), `report-*.json`, `phases/*.json` (one file per phase, so
every number is auditable), the raw `.cpuprofile.json`, `native-runs.jsonl` (the native side), and
the run trees under `trees/`.

## One `runScenario` per process — the instrument's first, invisible bug

PORT-NOTE(`L19/one-run-per-process`). Native boots exactly one worldfile per process, and the port
transcribes that: `FoodType.foodTypes`, the nerve table and the other model registries are
**process-global statics**. The first version of this instrument measured the boot with a
`maxSteps: 0` run and then the step loop with a second run **in the same process**, so the second
run saw the first run's definitions and died in `processWorldFile` with

```
sim: duplicate FoodType name 'Standard' (native errs)
```

Every measurement reported `steps=0` and "the run tree cannot be produced yet" — an instrument
artifact that read exactly like a model blocker, and it was reported as one (see the t_b9a4665b
comment history). The phases below exist so that each timed run is its own process; `report` never
simulates.

| phase | what it does | why it is separate |
|---|---|---|
| `boot` | one `maxSteps: 0` run | the fixed cost the step loop is separated from |
| `steps` (`--reps N`) | N timed runs, reported best/median/worst | the number the card asks for |
| `profile` | the same run under `node:inspector`'s `Profiler.*` | a profile has overhead; its wall time is *not* the number |
| `contract` | the recorded configuration of `microtest_voff` | the byte-parity verdict any WASM boundary would have to keep at exit 0 |
| `report` | combines the phase JSON, asks `./oracle/run_parity.sh`, writes the report | no simulation: a mis-shaped phase cannot corrupt a measurement |

The reported `ms/step` is the **best** repetition, not the median: this machine is shared with other
lanes and their native probes, so the best sample is the least contended one — the same convention
the native side uses (min wall). The median and the worst are printed beside it.

## What it measures, and how

| quantity | how | why that way |
|---|---|---|
| steps/second, ms/step | `runScenario` (lane L11's own code path, the one the parity harness grades), minus a separate `maxSteps: 0` boot run | the native baseline excludes native's fixed startup; startup is not a step-loop cost in either implementation |
| agent count | `MaxAgents` read back from the tree the run itself wrote (`run/normalized.wf`) | the ratio is computed against the world that actually ran |
| the 192-agent world | `--agents 192` applies `MaxAgents 192` through the worldfile parameter path native's argv uses; a test pins that `InitAgents MaxAgents` follows and that the *recorded* scenario still resolves to 25 | both recorded scenarios are 25-agent worlds, and a perf run must never contaminate the parity world |
| the flame profile | `node:inspector`, reduced to **self time** per function (`topFunctions`), plus the GC / `(program)` / harness attribution (`profileSummary`) | self time is what ranks a *kernel*; the attribution says how much of the run a compiled kernel could touch at all |
| the parity contract | `./oracle/run_parity.sh <scenario> --candidate <tree>` over a tree this harness wrote | PORT_SPEC.md: byte-parity is the contract |

## The native basis — two of them, and they disagree by 4x

PORT_PLAN.md §Measured facts item 6 publishes ~15 ms/step at 25 agents and 1.14 s/step at 192
(0.41 s of work). This machine's own recorded runs already contradict it:
`oracle/minitest_voff/meta.json` records `wall_sec: 1.98` for the *whole* 301-step native run, and
`oracle/microtest_voff/meta.json` records 1.10 s for a **1-step** run. A port that lands near the
card's 2x line cannot be judged against a basis the host contradicts, so
`tools/perf/l19-native.sh` times the native binary first-hand:

* it runs native from a **farm of symlinks** to the real native tree
  (`staging/l19-natlink`), so native's
  `run/` lands in scratch and the shared tree — whose `run/` may belong to another lane's probe —
  is never touched, and no native lock is needed;
* native resolves `Resources::find` and the worldfile against its **cwd** (`src/app/main.cc`,
  `src/library/utils/Resources.cc` `RPATH = {"./", ...}`), so the farm needs `etc`, `lib`,
  `worldfiles`, `bin`, `src` links; without `src` it execs `python3` on an empty script path and
  hangs;
* it subtracts a boot-equivalent run (`--MaxSteps 1`) from a long run, per world, per agent count —
  exactly the subtraction the TS side does with its `boot` phase — and records one JSON line per
  run in `native-runs.jsonl`.

Measured on 2026-09-28, this host, `minitest.wf`, `--Vision False`, min wall of 3 runs each:

| agents | 1 step | 301 steps | native ms/step |
|---:|---:|---:|---:|
| 25 | 2.146 s | 3.302 s | **3.853** |
| 192 | 2.101 s | 6.436 s | **14.45** |

The published 15 ms/step and 1140 ms/step are 3.9x and 79x away from that. The plan's numbers are
consistent with a run that keeps the GPU readback in the loop (the plan says 64 % of the 192-agent
wall was `glReadPixels`); the byte-exact tier is `Vision False`, so the honest comparator is this
one. **The report prints both and the decision names which it used** — the first-hand measurement.

Re-timed on 2026-09-29 (HEAD `1a41ff4`, same host, same world, min wall of 3 runs each):

| agents | 1 step | 301 steps | native ms/step |
|---:|---:|---:|---:|
| 25 | 2.039 s | 3.053 s | **3.380** |
| 192 | 2.038 s | 6.082 s | **13.48** |

The published 15 ms/step and 1140 ms/step are 4.4x and 85x away from the re-measurement. The
2026-09-28 windows are the basis the **pre-fix** ratios in "Results" were computed against; the
2026-09-29 re-measurement (12 % lower at 25 agents, 6.7 % lower at 192 — this machine is shared
with other lanes' native probes) is the basis the **post-fix** ratios in the next section use. Both
are stated with their own window so no ratio in this file is read against a basis it was not taken
against.

## Results

Both configurations were measured in several windows (each window = 3 timed repetitions), because
this machine is shared: a window's best-of-3 moves by up to 14 % between windows, so the tables
below give the best sample seen and the range across windows. Every window's report is kept in
`.candidate/l19-perf/` (`report-<config>-<epoch>.md`), and the raw phases/JSON and the raw
`.cpuprofile` belong to the last window that ran.

**Two generations of numbers, labelled.** Everything from here to "After `t_cfd271a8`" is
**pre-fix** (`t_b9a4665b`, 2026-09-28): the step loop still formatted every value through
`printf`/`cformat` and wrote every datalog row and log line through its own `writeSync`. The
follow-up that paragraph ends with ("the honest next step is a decision about that path")
**landed** as `t_cfd271a8` (commit `b50626d`), which removed that cost and reports its own
before/after window; the **post-fix** numbers — including a re-measurement made for this README on
the current HEAD — are under "After `t_cfd271a8` (commit `b50626d`)" below. Read the pre-fix
tables as the basis the card's step-3 trigger was judged on, not as current measurements.

### 25 agents, `minitest_voff`, 301 steps, the recorded configuration — **pre-fix** (`t_b9a4665b`)

12 timed repetitions over 5 windows.

| | |
|---|---|
| TS port | **16.451 ms/step** best (per-window best-of-3: 16.451 / 16.472 / 16.706 / 16.767 / 18.737) = **60.8 steps/s**, 53.4 steps/s in the worst window |
| boot | 231–237 ms (excluded) |
| native, first-hand | 3.853 ms/step → the port is **4.27x** (best window) to **4.86x** (worst) |
| native, PORT_PLAN.md | 15 ms/step → 1.10–1.25x |
| profile attribution | 49.9–52.4 % of samples in real functions, 4.3–4.8 % V8 GC, 43.1–45.8 % `(program)`/`(idle)` |
| the card's candidate kernels | **9.5–14.7 %** of the ranked functions' self time (RNG 7.8–13.6 %, libm 0–0.3 %, neural 1.2–2.5 %) |

The hot path is **not** the card's candidate kernels (last window):

| self % | fn | where |
|---:|---|---|
| 23.45 | `formatFixed` | `src/model/datalib/printf.ts:76` |
| 20.74 | `exactDecimal` | `src/model/datalib/printf.ts:50` |
| 8.33 | `iterate` | `src/model/rng/drand48.ts:51` |
| 6.59 | `computeStats` | `src/model/sim/geneStats.ts:75` |
| 5.04 | `roundSignificant` | `src/model/brain/core/cformat.ts:71` |
| 4.65 | `exactScaled` | `src/model/brain/core/cformat.ts:44` |
| 4.46 | `printf` | `src/model/logs/nodeFiles.ts:61` |
| 4.26 | `processEvent` | `src/model/logs/genomeLogs.ts:57` |
| 2.52 | `postEvent` | `src/model/logs/registry.ts:75` |
| 2.33 | `updateBody` | `src/model/agent/agent.ts:754` |
| 1.94 | `encodeLatin1` | `src/model/datalib/sink.ts:30` |

The number-formatting family (`datalib/printf.ts` + `brain/core/cformat.ts`) is ≈ **57 %** of the
ranked self time, the log recorders that drive it ≈ **14 %** more. The RNG — the one candidate
kernel that is genuinely hot — is 8–14 % and moves with the window.

### 192 agents, `minitest_voff`, 301 steps — **pre-fix** (`t_b9a4665b`)

Two windows, 3 timed repetitions each.

| | |
|---|---|
| TS port | **88.337 ms/step** best (windows: 88.337 / 93.612) = **11.32 steps/s**, 10.68 in the other window |
| boot | 1.23–1.26 s (excluded) |
| native, first-hand | 14.45 ms/step → the port is **6.11x** (best window) to **6.48x** |
| native, PORT_PLAN.md | 1140 ms/step wall, 410 work-only → 0.08x / 0.22–0.23x |
| profile attribution | 59.8–60.5 % in real functions, 3.7–3.9 % GC, 35.8–36.3 % `(program)`/`(idle)` |
| the card's candidate kernels | **13.1–14.1 %** of the 40 ranked functions' self time (RNG 10.5–11.3 %, libm 0 %, neural 2.6–2.9 %) |

| self % | fn | where |
|---:|---|---|
| 11.27 | `iterate` | `src/model/rng/drand48.ts:51` |
| 10.96 | `separation` | `src/model/genome/genome.ts:311` |
| 5.82 | `roundSignificant` | `src/model/brain/core/cformat.ts:71` |
| 5.65 | `createEntry` | `src/model/genome/separationCache.ts:26` |
| 5.27 | `formatFixed` | `src/model/datalib/printf.ts:76` |
| 5.10 | `exactDecimal` | `src/model/datalib/printf.ts:50` |
| 4.48 | `exactScaled` | `src/model/brain/core/cformat.ts:44` |
| 3.98 | `computeStats` | `src/model/sim/geneStats.ts:75` |
| 3.57 | `longestMatch` | `src/model/compress/zlibDeflate.ts:871` |
| 2.81 | `updateBody` | `src/model/agent/agent.ts:754` |
| 2.34 | `sprintfC` | `src/model/brain/core/cformat.ts:240` |

At this size the RNG becomes the single hottest function, the genome separation cache appears
(`separation` + `createEntry` = 16.6 %), and the compression lane's `deflate` shows up; the
formatting + log family is still ≈ 30 %. Only 0.57 % of the ranked self time is the harness itself
here, against 2.3–3.3 % at 25 agents (the runner's module resolution is a fixed cost, so it shrinks
as a share of a longer run).

### After `t_cfd271a8` (commit `b50626d`) — the current numbers, re-measured on HEAD `1a41ff4`

`t_cfd271a8` removed the `printf`/`cformat`/`logs` cost the pre-fix profile ranked at ≈ 71 % of the
25-agent ranked self time (native's stdio buffer for the file seam in `datalib/nodeFile.ts`, exact
decimal `%f`/`%g` rounding in `datalib/printf.ts` + `brain/core/cformat.ts`, cached parsed format
specs). It reports its own before/after window; the tables below add a **third** window, taken for
this README revision on **2026-09-29** on HEAD **`1a41ff4`**, with no modified tracked file
(`git status` was clean when the measurement started and shows no change to a port source at the
end; another lane dropped untracked probe files under `src/model/geometry/native/` and `tools/`
while the 192-agent run was in flight, none of them imported by the port — unlike the fix's own
window, which shared the tree with other lanes' *edits*), with the native side
re-timed in the same hour. Same instrument: `tools/perf/l19-bench.sh --reps 3` and
`tools/perf/l19-bench.sh --agents 192 --steps 301 --reps 3`, best of 3, native =
`tools/perf/l19-native.sh`, min wall of 3.

| 25 agents, `minitest_voff`, 301 steps | ms/step (best) | steps/s | native, first-hand | ratio |
|---|---:|---:|---:|---:|
| pre-fix — this README's window (`t_b9a4665b`) | 16.451 (per-window bests 16.451 / 16.472 / 16.706 / 16.767 / 18.737) | 60.8 | 3.853 ms/step | **4.27–4.86x** |
| pre-fix — `t_cfd271a8`'s own before-window | 16.167 (median 16.489, worst 16.842) | 61.85 | 3.853 ms/step | **4.20x** |
| post-fix — `t_cfd271a8`'s after-window | 5.808 (median 5.923, worst 5.926) | 172.18 | 3.853 ms/step | **1.51x** |
| **post-fix — re-measured on HEAD `1a41ff4` (2026-09-29)** | **6.286** (median 6.296, worst 6.427; 2.2 % spread) | **159.08** | **3.380 ms/step** (2.039 s for 1 step, 3.053 s for 301) | **1.86x** |

| 192 agents, `minitest_voff`, 301 steps | ms/step (best) | steps/s | native, first-hand | ratio |
|---|---:|---:|---:|---:|
| pre-fix — this README's window (`t_b9a4665b`) | 88.337 (second window 93.612) | 11.32 | 14.45 ms/step | **6.11–6.48x** |
| pre-fix — `t_cfd271a8`'s own before-window | 87.268 (median 90.854, worst 93.240) | 11.46 | 14.45 ms/step | **6.04x** |
| post-fix — `t_cfd271a8`'s after-window | 58.758 (median 61.703, worst 62.601) | 17.02 | 14.45 ms/step | **4.07x** |
| **post-fix — re-measured on HEAD `1a41ff4` (2026-09-29)** | **57.981** (median 58.036, worst 58.416; 0.8 % spread) | **17.25** | **13.48 ms/step** (2.038 s for 1 step, 6.082 s for 301) | **4.30x** |

Both post-fix windows agree to 8 % at 25 agents and 1.4 % at 192; the pre-fix pair agrees to 2 %.
The native basis itself moved ~12 % between the two days (3.853 → 3.380 ms/step at 25 agents,
14.45 → 13.48 at 192 — this host is shared with other lanes' native probes), which is why each row
names the basis it was taken against and why a ratio is never quoted here without its window. Boot
fell with the fix too: 228.6 → 208.7 ms at 25 agents and 1188.9 → 1052.8 ms at 192 in the fix's
window; 210.35 / 1016.2 ms in this re-measurement.

The hot path after the fix (post-fix, HEAD `1a41ff4`, `phases/profile.cpuprofile.json`):

| self % | fn | where |
|---:|---|---|
| 16.06 | `iterate` | `src/model/rng/drand48.ts:51` |
| 10.61 | `computeStats` | `src/model/sim/geneStats.ts:75` |
| 9.08 | `formatFixed` | `src/model/datalib/printf.ts:132` |
| 5.73 | `processEvent` | `src/model/logs/genomeLogs.ts:57` |
| 5.17 | `updateBody` | `src/model/agent/agent.ts:842` |
| 5.03 | `longestMatch` | `src/model/compress/zlibDeflate.ts:871` |
| 4.61 | `fma64` | `src/model/brain/core/nativeMath.ts:117` |
| 4.33 | `separation` | `src/model/genome/genome.ts:311` |
| 3.21 | `postEvent` | `src/model/logs/registry.ts:75` |
| 2.65 | `mutateBits` | `src/model/genome/genome.ts:213` |
| 2.51 | `applyConversion` | `src/model/brain/core/cformat.ts:224` |

| self % | fn | where |
|---:|---|---|
| 13.87 | `separation` | `src/model/genome/genome.ts:311` |
| 13.85 | `iterate` | `src/model/rng/drand48.ts:51` |
| 12.72 | `forEachSorted` | `src/model/logs/seams.ts:17` |
| 4.46 | `computeStats` | `src/model/sim/geneStats.ts:75` |
| 4.06 | `longestMatch` | `src/model/compress/zlibDeflate.ts:871` |
| 2.66 | `fma64` | `src/model/brain/core/nativeMath.ts:117` |
| 2.56 | `updateBody` | `src/model/agent/agent.ts:842` |
| 2.19 | `update` | `src/model/brain/core/firingRateModel.ts:80` |
| 1.64 | `formatFixed` | `src/model/datalib/printf.ts:132` |
| 1.61 | `mutateBits` | `src/model/genome/genome.ts:213` |
| 1.58 | `deflateSlow` | `src/model/compress/zlibDeflate.ts:924` |

(first table 25 agents, second 192 agents; the full 40-row tables are in
`.candidate/l19-perf/latest.md` and the `report-*.md` copies.)

* profile attribution: 71.59 % of samples in real functions, 4.12 % V8 GC, 24.29 %
  `(program)`/`(idle)` at 25 agents; 77.57 % / 3.21 % / 19.22 % at 192;
* the formatting family (`datalib/printf.ts` + `brain/core/cformat.ts`: `formatFixed` 9.08,
  `applyConversion` 2.51, `roundScaled` 2.37, `roundSignificant` 1.54, `formatGeneral` 1.40,
  `sprintfC` 0.42, `decomposeBinary` 1.26) is **18.6 %** of the 25-agent ranked self time, and the
  recorders that drive it (`processEvent`(genomeLogs) 5.73, `postEvent` 3.21, `writeText`/`writeBytes`
  1.40 + 0.42, `onBodyUpdated` 0.42, `processEvent`(brainLogs) 0.56, `encodeLatin1` 1.26) **13.0 %**
  more — **31.6 %** against the ≈ 71 % the pre-fix window ranked there. At 192 agents the formatting
  family is **6.8 %** (`formatFixed` 1.64 + `applyConversion` 1.46 + `roundScaled` 1.22 +
  `roundSignificant` 0.89 + `formatGeneral` 0.97 + `sprintfC` 0.61);
* the card's step-3 candidate kernels are **27.94 %** (25 agents: RNG 16.06, libm 0, neural 11.88)
  and **21.48 %** (192: RNG 13.85, libm 0, neural 7.63) of the 40 ranked functions' self time; the
  fix's own window put them at 21.81 % and 16.34 %. The 25-agent share *rose* between the two
  generations even though the run got 2.6x faster, because a share is a fraction of a set whose
  denominator shrank with the run — the comparable quantities across generations are the ms/step
  and steps/s rows above, not the percentages;
* `0.84 %` (25 agents) / `0.88 %` (192) of the ranked self time is the harness itself (vitest/vite
  module resolution and this instrument).

### Parity

Both verdicts come out of `./oracle/run_parity.sh`, over trees this harness wrote:

* `microtest_voff` (the `contract` phase): **PASS 225/225**;
* `minitest_voff` (the 25-agent benchmark's own tree — the recorded configuration, so it *is* the
  golden world): **PASS 1369/1369**, 1167 gz payloads identical.

A perf run that overrides the world (192 agents) or truncates the step count gets **no** parity
claim, and the report says so rather than implying one: byte-parity is only defined for the world
the oracle recorded. **A benchmark tree makes no parity claim of its own — only the recorded
configuration does** (the 25-agent `minitest_voff` tree above is that configuration; the 192-agent
tree is not).

**The parity state these numbers were measured on** (2026-09-29, HEAD `1a41ff4`, clean tree). All
six recorded scenarios were re-run through the port's own runner at that revision and every one is
byte-exact, `differing=0 missing=0 extra=0`:

| scenario | verdict | tier |
|---|---|---|
| `hello` | **PASS 19/19** | A |
| `microtest_voff` | **PASS 225/225** | A |
| `microtest_von` | **PASS 225/225** | B (`movie.pmv` ignored) |
| `minitest_voff` | **PASS 1369/1369** | A |
| `minitest_von` | **PASS 1308/1308** | B (`movie.pmv` ignored) |
| `minitest_adami` | **PASS 1373/1373** | A |

(`npx tsx src/model/sim/runner.ts <scenario> <dir>`, then
`./oracle/run_parity.sh <scenario> --candidate <dir>`; the trees, the runner logs and the parity
transcripts are under `.candidate/l19-perf/t_6ed88f3b/`. The tiers are the harness's own —
`run_parity.sh list`.) The two verdicts above are those trees: the bench's own `contract` and
25-agent trees at the same revision. So the post-fix numbers in this file were taken on an
implementation whose output is byte-exact for every recorded scenario — a cost measurement of that
implementation, not an approximation of it.

## The decision (the card's step 2) — closed

`decide()` states it in the report next to the numbers. **The decision of record is: no WASM
boundary was written, and the card's step 3 is not owed on the current numbers at the recorded
configuration.** This is a closed decision, not a pending one.

* **Pre-fix** (the pre-fix tables above, `t_b9a4665b`, first-hand native basis): **25 agents
  4.27–4.86x** native (published basis 1.10–1.25x) and **192 agents 6.11–6.48x** (published basis
  0.08x) — both outside the ~2x line, which is what *triggered* the card's step 3 at the time;
* **post-fix** `t_cfd271a8` (commit `b50626d`): **25 agents 1.51x** in the fix's own window
  (5.808 ms/step, 172.18 steps/s, against that window's 3.853 ms/step native) and **1.86x**
  re-measured on HEAD `1a41ff4` (6.286 ms/step, 159.08 steps/s, against 3.380 ms/step native);
  **192 agents 4.07x** then and **4.30x** now.

The card's step 3 is conditional — "*only if* TS is more than ~2x native". On the configuration the
card measures (`minitest_voff`, 25 agents) that condition is **not met** post-fix: the 4–6x that
triggered the card was the logging/formatting path, and that path was the follow-up card that
landed. At 192 agents the condition is still met, and the profile still says its premise fails:

* the candidate kernels the card names (RNG streams, libm `exp`/`pow`, neural update inner loops)
  were 9.5–14.7 % of the ranked self time at 25 agents and 13.1–14.1 % at 192 pre-fix, with libm at
  0–0.3 %. Post-fix they are **27.9 % / 21.5 %** of a *shrunken* ranked set (a share rose because
  the run got 2.6x faster — see the note in the post-fix section), and **libm is 0.0 % in both
  counts**;
* the port's remaining loss is elsewhere: at 25 agents the number-formatting residue and the log
  recorders that drive it are ≈ **32 %** against ≈ 71 % before, and the top of the table is
  `iterate` (16.06 %) then `computeStats` (10.61 %, L11 gene stats — not a card kernel); at 192
  agents it is `separation` (13.87 %, the genome byte loop the fix shape-benchmarked at 0.60
  ns/byte — V8's floor for that shape), `iterate` (13.85 %) and the `forEachSorted` per-object log
  walk (12.72 %), with the compression lane at ≈ 6.7 % (`longestMatch` 4.06 + `deflateSlow` 1.58 +
  `crc32` 1.07).

The three reasons, in the order that closes the question:

1. **On the configuration the card measures, the port is inside the line** (1.51x / 1.86x at 25
   agents), so step 3 is not reached there.
2. **Where it is still outside the line (192 agents), the profile does not back the card's
   kernels.** The ranking is `separation` (a genome byte loop, measured at its floor), `iterate`,
   then the log walk; `libm` does not appear in the profile at all and the neural inner loops are
   7.6 %.
3. **The one candidate kernel that is genuinely hot is a per-draw boundary.** `iterate` (`drand48`)
   is called once per draw, at 13–16 % of ranked self time post-fix. A compiled kernel there pays a
   boundary crossing per draw, so that share is an *upper bound* on what a boundary could return,
   not a saving — the same per-call cost that made the plan's own deck reject the hybrid ("compile
   the core to WASM, rewrite only the ~7k-line GL/UI layer") in favour of the full rewrite, whose
   price `PORT_PLAN.md` §Risks 1 records: the port stays a second implementation of the hot path,
   kept byte-exact by hand. That is also why "compile the port's log writing instead" is not the
   follow-up this README recommends — it is a second implementation of the byte-exact surface, for
   a path that is now ≈ 32 % of a run already inside the line.

**What that leaves for a next reader.** The remaining 192-agent levers are JS-side shape work (the
per-object log walk, the compression lane, `GeneStatsLog.processEvent`'s one `printf` per mutable
gene per step — ≈ 2 % of the run, at the cost of moving a partial line's bytes on a crash path).
They are measured, not assumed, and they are not a WASM question. "Should this be compiled?" does
not need to be reopened from the pre-fix table above: no WASM boundary was written, none is owed at
the recorded configuration, and the only card kernel the profile ever ranks first is the per-draw
RNG of point 3 — whose boundary cost is exactly what closes it.

## What stays in `npm test`

`tests/l19-perf.test.ts` runs nine instrument self-checks on every suite run and **simulates
nothing**: the 192-agent parameter path, the profile ranking *in the shape `Profiler.stop` really
returns* (`callFrame`, not flat fields — reading the flat shape was a real bug here, and the
original fixture hid it), the `profileSummary` attribution, the native-basis derivation and its
selection, the candidate-kernel share (including that `brain/core/cformat.ts` is a `printf`, not a
kernel), the phase combiner, the parity-claim rule, and the parity-verdict plumbing. The tenth case
is the phase runner itself, opt-in (`L19_RUN=1`, which `l19-bench.sh` sets) because it costs seconds
per step.

## Known limitations, stated rather than hidden

* The published baseline in `nativeBaseline()` is still PORT_PLAN.md's plan-time number. The
  report prefers the first-hand measurement when `native-runs.jsonl` exists, and says when it does
  not.
* The native subtraction assumes the 1-step run's fixed cost equals the long run's. Both write the
  same world's files (the 1-step run writes a strict subset), so the difference is an upper bound
  on the step loop, and the report says the numbers are the same subtraction on both sides. The
  same caveat applies to the TS `boot` phase (`maxSteps: 0` writes no per-step artifacts).
* The profile is taken **inside vitest**, so 1.5–3 % of the pre-fix ranked self time was the
  runner's own module resolution; in the post-fix windows the report measures 0.84 % (25 agents) /
  0.88 % (192). A profile of a bare `node` process would be cleaner and is a follow-up, not a
  blocker.
* `iterate` (`drand48`) is the one candidate kernel that is genuinely hot — 8–14 % of ranked self
  time at 25 agents pre-fix, 16.06 % post-fix (it is ranked **first** there) and 13.85 % at 192. If
  anyone wants a WASM experiment, that is the only function worth trying it on — with the boundary
  cost measured **per draw**, not assumed, and against the closed answer in "The decision" above
  (it is the per-draw boundary, so its share is an upper bound, and the port is already inside the
  ~2x line at the configuration the card measures).
* `native-runs.jsonl` is append-only evidence; the first three native windows were recorded before
  the script started writing `MaxAgents` into each line, and are kept alongside as
  `native-runs.legacy-19xx.jsonl`. They are not used for the ratios — a measurement whose world
  does not say how many agents ran cannot be the basis for a per-agent comparison (the picker
  prefers a measurement that does, and the report names the agent count it compared against).
