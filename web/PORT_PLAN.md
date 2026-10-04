# PORT PLAN — Polyworld (C++/OpenGL, ~60k lines, 1991–2019) → TypeScript + Three.js in the browser

**Decision:** full rewrite in TypeScript, model included, with the native C++ build kept
as the differential oracle. Chosen deliberately over the cheaper hybrid (compile the core
to WASM, rewrite only the ~7k-line GL/UI layer). See Risks for what that choice costs.

## Measured facts this plan rests on

1. **The core is one 52,079-line strongly-connected component.** `library/{agent, brain,
   genome, sim, environment, graphics, logs, complexity, proplib, utils}` cross-include
   each other. Lanes *cannot* be module boundaries; they must be **interface cuts plus
   disjoint behavior ownership**.
2. **Cross-cutting concerns are localized** (this is what makes parallelism viable):
   OpenMP → `complexity`, `tools/clustering`. Python (worldfile expressions) → `proplib`
   only. GSL → `utils`, `complexity`. GL → `graphics` + 2 call sites in `sim`. zlib →
   `utils/datalib`, `logs`, `clustering`. Each becomes one lane's problem, not everyone's.
3. **The GPU is removable from the loop.** `agent::UpdateVision()` is gated on
   `agent::config.vision`, so `Vision False` runs are pure arithmetic + RNG.
4. **The oracle works and is byte-exact.** `microtest_voff` (225 files) and
   `minitest_voff` (1,369 files) reproduce byte-for-byte; with vision **on**, 1,307 of
   1,308 files reproduce — the sole exception is the delta-compressed `movie.pmv`. The
   checker passes a clean copy and fails a one-byte perturbation (both verified).
5. **The logs are per-step**, which gives *step-localized* diffs: the first diverging
   step and column name the subsystem that broke. This is the property that lets 10–20
   agents work in parallel without a human in every loop.
6. **Measured cost (native, term mode, this machine):** ~6 s fixed startup (worldfile
   conversion + clang-compiling the runtime props library); **1.14 s/step at 192 agents**
   (0.41 s of work, the rest blocked on GPU readback — 64% of wall); **~15 ms/step at 25
   agents**. The stall fraction scales with agent count, because every agent's retina is
   a separate synchronous `glReadPixels`. Two consequences the plan depends on: the
   browser vision lane must batch or shader the readback (L16), and startup compilation
   must become a build-time step.

Oracle artifacts: `oracle/scenarios/scenarios.json`, `tools/record_oracle.py`,
`tools/check_parity.py`, `PARITY.md`, and `PORT_SPEC.md` for agent-facing rules
(rename to `CLAUDE.md` if your harness auto-loads that name).

## Interface cuts — do these first, in this order

Lanes import `src/model/types/*` and nothing else from another lane's internals.

1. `types/config` — config singletons (`agent::config`, `Brain::config`, `globals`,
   `genome::schema`, `sim` types), enums, event structs.
2. `types/rng` — the exact PRNG surface (`rand()`, `drand48()`, `gsl_rng_mt19937` +
   GSL's uniform mapping). Verified against native `rancheck` vectors.
3. `types/datalib` — the columnar log schema/type registry; the format the oracle's
   files are written in.
4. `types/geometry` — Vector/Color/matrix/frustum primitives.

These four are owned by the plan, frozen early, and are the only shared surface.

## Lanes (each = one branch, one owner, one oracle)

| # | Lane | Native source | Lines | Depends on | Acceptance oracle |
|---|---|---|---|---|---|
| L1 | rng + math + misc | `utils/*` (RNG, error, misc) | 7.6k | types | PRNG sequences match `bin/rancheck` |
| L2 | datalib + files | `utils/{datalib,AbstractFile}`, zip | 4.3k | types | byte-compare `*.txt`/`*.log` writers |
| L3 | proplib core | `proplib/{lexer,parser,dom,model}` | 4.0k | types | `run/normalized.wf` byte-compare |
| L4 | proplib expressions | replace `interpreter.py` (out-of-process python) | 0.8k | L3 | `normalized.wf` (all evaluated expressions) |
| L5 | genome | `genome/**` (layout, groups, mutation) | 6.1k | L1 | `run/genome/**` byte-compare |
| L6 | brain core | `brain/{sheets,groups,models}` | 4.7k | L5 | `run/brain/function/**`, `anatomy/**` |
| L7 | brain recording | `brain/**` record paths | — | L6, L2 | `run/brain/**` inclusive |
| L8 | agent core | `agent/agent.cc` (energy, lifespan, motion) | 3.6k | L5, L1 | `energy/**`, `motion/**`, `lifespans.txt` |
| L9 | agent senses | `agent/Retina.*` + vision encoding | — | L8, L15 | model logs with `Vision True` byte-exact |
| L10 | environment | `environment/**` (food, bricks, patches) | 2.3k | L1 | `events/**`, food-energy columns |
| L11 | simulation | `sim/Simulation.cc` (loop, fitness, epochs, seeds) | 7.4k | L8, L10, L5 | whole-run Tier A byte-exact |
| L12 | logs | `logs/**` (all recorders) | 2.8k | L2, L11 | every logged artifact |
| L13 | complexity | `complexity/**` (Adami, GSL) | 2.6k | L1, L6 | complexity columns |
| L14 | monitor | `monitor/**` (trackers, cameras) | 1.8k | L11 | POV/scene selection parity |
| L15 | graphics scene | `graphics/**` minus rasterizer | 3.9k | types | camera/frustum vectors |
| L16 | vision raster | fixed-function GL → WebGL2 or shader | — | L15, L9 | model logs stay byte-exact (fast, not pixel-faithful) |
| L17 | tools | `tools/**` (nullevo, passive, clustering, …) | 9.6k | L11+ | tool outputs |
| L18 | browser shell | `app/ui`, `qtrenderer` → Three.js UI | 3.3k | L11, L16 | run-tree artifacts byte-exact; the **render is a fidelity surface** since L18d (see PORT_SPEC) — the scene must look like native, values from the native source |

**Order:** types → L1 → (L2, L3, L5, L15) → (L4, L6, L8, L10) → (L7, L9, L11, L12, L13,
L14) → (L16, L17, L18). The four widest-fanout leaves land first; L11/L12 are fan-in
lanes and get separate translator and tester agents.

## Running 10–20 agents on this

- One lane = one worktree + one branch + a status file (`lane.ready` / `lane.green` /
  `lane.failed`). Merge only green.
- `oracle/**` is read-only for lane agents; editing it fails review.
- Brief each agent with: the native source excerpt, the frozen types it may import, its
  scenario, the golden diff (first differing step + column), and two already-ported units
  as style examples.
- Retry with the *error* (diff), not with a better prompt. Cap at 10 attempts, then
  escalate to a human.
- The tester who owns the oracle is never the translator who writes the lane.
- Long tail: sample failures → fix the shared cause in `types/` or the brief → re-sweep.

## Risks

1. **A rewrite means two implementations.** The native tree stays the definition of
   correct; a fix there must be re-applied by hand to TS. Budget review for both.
2. **Libm drift.** `exp/pow/sqrt/sin/cos/log` can differ 1 ulp between libms; the model
   uses them ~60 times. Where a byte-diff traces to one, implement a bit-exact version
   and PORT-NOTE it. This is the most likely source of "correct code, failing oracle".
3. **Scope creep.** L17 (tools) and L18 (UI) are not needed for a browser demo; they can
   be deferred without weakening Tier A.
4. **Performance is a goal, not a side effect.** The native path stalls 61% of its time
   in `glReadPixels`; the browser version must batch or shader the vision readback.

## Cutover

- [x] Tier A + vision-on model scenarios byte-exact in the browser (movie excluded)
  - `demoEvidence.mjs "<url>/?scenario=<s>" --export <dir>` → `./oracle/run_parity.sh <s> --candidate <dir>`: `hello` **PASS (19/19 files)**, vision-on `minitest_von` **PASS (1308/1308 files)**, both `differing=0 missing=0 extra=0`, page `flavour=model`, `errors=[] warnings=[] offOriginRequests=[]` (t_e7d2c384); node runner all six strict: `hello 19/19 · microtest_voff 225/225 · minitest_voff 1369/1369 · microtest_von 225/225 · minitest_von 1308/1308 · minitest_adami 1373/1373`.
- [x] Tier B movie recording deterministic by construction (record on step boundaries)
  - Superseded by the decision of record, not measured: the movie is free at every tier (`t_588c28e1` — PORT_SPEC *Frozen surface*, PARITY.md *The movie is not a frozen artifact*) and the port mounts the null movie writer (`src/browser/sim/nodeSources.ts`, `src/browser/app.ts`), so no candidate run tree contains a `run/movie.pmv` to be deterministic; the comparator reports it `IGNORED`.
- [x] Shipped as an opt-in demo page; native binary stays the research artifact
  - `npm run build` (vite → `dist/`, 217 modules) served statically by `vite preview`: the bundle boots the model and its page's own run tree is byte-parity — `hello PASS (19/19 files)`, `minitest_von PASS (1308/1308 files)`, `ended=true` at each run's own `MaxSteps` (500 / 301), first load 4 requests (document + JS + CSS + favicon), none off-origin, `errors=[] warnings=[]` (t_e7d2c384).
- [x] Old implementation never deleted — it is the oracle
  - `git ls-files oracle | wc -l` → 21, `git log --oneline -- oracle` → last touched by `dee87f8` (0 commits since), read-only per PORT_SPEC ground rule 8.
