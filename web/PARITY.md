# PARITY — Polyworld C++ → TypeScript (browser rewrite)

Updated: 2026-09-28. Source of truth for what is verified and what is known to differ.

## Oracle (recorded, working)

| Scenario | Tier | Files hashed | Native wall | End reason | Reproducible? |
|---|---|---|---|---|---|
| microtest_voff | A | 225 | 1.1 s | MaxSteps | **yes** (byte-identical across runs) |
| microtest_von | B | 225 | 1.2 s | MaxSteps | **yes** (movie included; a vision-off run of the same world differs in 83 files) |
| minitest_voff | A | 1369 | 2.0 s | MaxSteps | **model artifacts yes**; `run/movie.pmv` no (see *The movie is not a frozen artifact*) |
| minitest_von | B | 1308 | 10.3 s | MaxSteps | **no** — differs run-to-run, see below |

Harness: `tools/record_oracle.py` (run native → snapshot `run/` → sha256 manifest,
excluding `run/.cppprops/`), `tools/check_parity.py` (candidate tree vs manifest).
Oracle proven to fail: one flipped byte turns 1368/1369 → exit 1 (verified).
Oracle proven to pass on a clean copy: 1369/1369 → exit 0 (verified).

**The port is byte-exact against every recorded scenario** (measured 2026-09-28; re-measured
strict 2026-09-29) — the registry's six and no exceptions: `microtest_voff` **PASS 225/225**,
`minitest_voff` **PASS 1369/1369**, `microtest_von` **PASS 225/225**, `minitest_von`
**PASS 1308/1308**, `hello` **PASS 19/19**, `minitest_adami` **PASS 1373/1373**, each with
`differing=0 missing=0 extra=0` and every `.gz` compared by **container bytes** (`container
differs 0`) — that is the default again since 2026-09-29: the registry's `content_compare` rule
list is **empty** (t_9c9fa3de, the t_091ec5b8 amendment reverted once t_431ed2f0 landed), so
nothing is content-compared and no flag is needed — from the node
runner (`npx tsx src/model/sim/runner.ts <scenario> <dir>`) and, on the two vision-on scenarios,
from the **running page** as well. `run/movie.pmv` is the only ignored file. (`minitest_von`'s
**no** in the `Reproducible?` column above is about the *native recording* and stays true: the
native run is not repeatable run-to-run; the port's reproduction of the recorded tree is.)

## The golden contract — `oracle/<scenario>/run/**` is frozen (t_37bf7212)

**The rule.** `oracle/<scenario>/run/**` is the contract; `run/manifest.sha256` is the only listing
of it that means anything. **Only `--record` may write a byte there** — and it installs by
`stage → verify → move`, never in place. Everything else a lane produces is a **candidate**: it
stages under `oracle/_t_*` (the prefix `.gitignore` reserves) or `$TMPDIR`, and if it is installed
at all it is installed the same way. A path is judged by the **real path it resolves to**, so a
worktree's `oracle/<scenario>/run` symlink *is* the golden and is refused as a write target, as
`--candidate`, as `--candidate-out`, as a candidate root and as a staging root — and it is judged
by the **manifest marker** as well as by the configured root, so *which* root is configured
decides nothing about what a golden is: `run/manifest.sha256` is the harness's own listing of a
golden, and a resolved `run/` dir that holds one is a golden wherever it lives
(`tools/parity_common.py` → `golden_write_target` and `src/oracle/guard.ts` → `goldenWriteTarget`
are the same predicate, held in step by t_f049065c). `POLYWORLD_ORACLE_ROOT` only points a fresh
worktree at goldens it does not have; it is not the boundary.

**A candidate root is per process.** Two runs verifying at the same time must never share one
staging root: `freshDir` is `rmSync(recursive)` + `mkdir` and the recorders write as they go, so a
shared root is wiped and rebuilt under the other run's feet — `ENOTEMPTY … rmdir`, `EEXIST` on a
hard link, `ENOENT` on a rename, wrong artifact counts — which is a false red for both lanes, the
same class of false red as the incident below. The logs corpus therefore keys its default root by
pid and worker thread (`defaultLogsCandidateRoot` in `tests/logsCorpus.ts`:
`oracle/_t_logs_candidates/pid-<pid>[-t<thread>]`; `POLYWORLD_LOGS_CANDIDATE_ROOT` still pins it
for a caller that wants a known path). A lane that stages a tree anywhere else owns that decision
and must make it per process too. **It is also self-reaping:** the process removes its own
`pid-*` dirs when it ends — on `exit` *and* on the `SIGTERM`/`SIGINT` a harness kills a worker with,
because a process that dies by a signal runs no `exit` listener — and reaps the dirs of pids that are
no longer alive, once, never touching a live pid's tree (`src/oracle/logsStaging.ts`); the two
overrides that turn it off are `POLYWORLD_LOGS_CANDIDATE_ROOT` (a pinned root is the caller's) and
`POLYWORLD_KEEP_LOGS_CANDIDATES=1` (keep a failed replay's tree for inspection).

**The browser lane's root is keyed the same way, and names itself (t_1ce9957f).**
`src/browser/sim/nodeSources.ts`'s `writeCandidateTree` writes `<root>/<scenario>/run/**` file by
file and `worldBoot.test.ts` reads each artifact straight back, so the lane's one shared
`$TMPDIR/polyworld-browser-candidates` was the same false red one resource over —
`run/original.wfs: expected '' to be '###…'` at `worldBoot.test.ts:250`, measured 2 red runs of 32 at
4-way concurrency on that file (and ~1 full-suite pair in 12). `candidateRoot()`
(`src/browser/sim/candidateRoots.ts`) now defaults to
`<tmpdir>/polyworld-browser-candidates/pid-<pid>[-t<thread>]`. Because that path is **documented** —
`src/browser/README.md`, the `runTree.*.test.ts` headers and the recipe below all point a human at
`<POLYWORLD_BROWSER_CANDIDATE_ROOT>/<scenario>` — the keyed tree names itself instead of moving
silently: a `PROVENANCE.txt` **beside** `run/` (never inside it: the harness compares `run/**`) carries
the tree's own path and the `run_parity.sh --candidate` line for it, and the path is printed on
stderr by the run that wrote it. `POLYWORLD_BROWSER_CANDIDATE_ROOT` still pins a caller's root
**verbatim** — no key is appended and nothing is written beside its `run/`, which is the shape the
human recipe assumes. A keyed `pid-*` directory whose owning process is gone is reaped once per
unpinned run (`POLYWORLD_KEEP_BROWSER_CANDIDATES=1` disables the sweep, for inspecting a red); a
`pid-*` directory whose owner is **alive**, a non-`pid-*` entry (the old shared root's
scenario-named dirs), the candidate base itself and anything that resolves into a golden are never
removed, and `tools/browser_candidates_probe.ts` is the re-runnable evidence for all of it.

**The whole run's temp footprint is keyed, and dies with the run (t_841decd7).** Those per-process
roots bounded *sharing*, but nothing removed the trees a finished run left behind, and a run leaves
a lot: `$TMPDIR` had grown to **19,013 entries / ~67 GB** and the boot volume to **1.6 GB free**.
Measured at this commit, this checkout: **14,386 directories / 60.1 GB** — vitest's own transform
cache (`<nanoid>/ssr/<sha1>`, one per run, `join(os.tmpdir(), nanoid())` in vitest 5's
`ModuleFetcher`, 8.2 GB), the tests' `mkdtempSync(join(tmpdir(), …))` run trees (whole candidate
worlds, `adami-*` alone 31 GB) and the per-process candidate roots above. `vitest.config.ts` now
calls `installRunTempRoot()` (`src/hygiene/runTempRoot.ts`) before vitest constructs its project,
which points `$TMPDIR` at one directory keyed by the process —
**`<real $TMPDIR>/polyworld-run-tmp/pid-<pid>/`** — so *every* one of those families lands under the
key without a single call site changing, and removes it when the process ends (`exit`, and the
`SIGTERM`/`SIGINT` a harness or a supervisor sends). A keyed root whose owner is gone is reaped by
the next run, and by `tools/tmp_prune.ts`, which is the re-runnable evidence **and** the prune the
unattended supervisor can run on its own (it cannot `rm -rf`): it reclaims only entries it can
*prove* are this checkout's — the keyed roots of dead pids, a world-file pair
(`run/original.wf` + `original.wfs`), a `#datalib` `population.txt`, a transform cache whose file's
own `//# vitestCache=` trailer records a module id the file is named `sha1(<id>)` of and that id's
path here is a file of this checkout (measured: all 80 retained dirs were written by *copies* of this
checkout that are now gone, so naming this checkout's own paths could never fire — t_0ee3e965), a
file naming this checkout's path — and
only when untouched for `--min-age` (120 min by default), and it reports with its reason everything
it refuses (`omlx-update-*`, Chromium profiles, `pytest-of-*`, another clone's caches).
`POLYWORLD_RUN_TMP_ROOT` pins a caller's root verbatim (never swept) and
`POLYWORLD_KEEP_RUN_TMP=1` keeps this run's root for inspection.

**The repo-local scratch root is walked by the same prune (t_4f775095).** `$TMPDIR` is not the only
scratch root this checkout mints: the parity lane leaves one graded tree per run at
`.candidate/parity/pid-<pid>/<scenario>` (`tools/parity_candidate.sh`) and the vision gate one per
worker at `.candidate/vision-gate-von/pid-<pid>[-t<thread>]/`
(`tests/vision-on-is-not-a-noop.test.ts`) — and nothing reclaimed either. Measured 2026-09-29:
**1.8 G / 187 dead `pid-*` trees, growing every graded run**. `tools/tmp_prune.ts` now walks
`<repo>/.candidate` in the same report/reap pass: a `pid-*` tree under a lane base is reclaimed when
the owner pid is **gone** *and* the tree has gone untouched for `--min-age` — **both terms**, because
a tree here survives its writer by design (it is graded afterwards), so liveness alone is not the
whole proof, and the age gate is never a replacement for liveness: a **live** owner's tree is not
touched whatever its mtime says (a lane runs two graded scenarios back to back under one
`pid-<pid>/`), and a lane child that names no key is reported and left. `oracle/**` is refused as
always — proven by a fixture that verifies the golden against its own `run/manifest.sha256` before
and after the reap. Measured on this checkout the day it landed: `report` named 154 reclaimable
trees (67 `parity` + 87 `vision-gate-von`, 966 MB), `reap` removed exactly those and nothing else,
and the 33 younger than `--min-age` plus every non-`pid-*` child stayed.

**A golden is recognised by its manifest too, not only by the oracle root.** `run/manifest.sha256`
is the harness's own listing of a golden, so a resolved `run/` dir that holds one is refused as a
write target *wherever it lives* — a lane's worktree reaches the canonical goldens by symlinking the
per-scenario `run` dirs (`ln -sfn <canonical>/oracle/<s>/run <worktree>/oracle/<s>/run`, the shape
measured in t_4bb10112's log), and that path resolves outside the oracle root the worktree hands the
guard. Removing a **link** (`unlink`/`rmdir`/`rm`/`rename` of a symlink) is not a write and stays
allowed: it drops the link, never what it points at. **Both halves apply it** (t_f049065c): the TS
guard since t_37bf7212 round 2, and the python harness (`tools/parity_common.py:
golden_write_target`, the one predicate `check_parity.py --candidate` / `record_oracle.py
--candidate-out` refuse with) since t_f049065c — until then the python half judged by the
*configured* root alone, so in a bare worktree (`POLYWORLD_ORACLE_ROOT` unset → root
`<worktree>/oracle`) the symlinked spelling was **not** refused and
`./oracle/run_parity.sh microtest_voff --candidate <wt>/oracle/microtest_voff/run` printed
**`parity: PASS (225/225 files)`** — the frozen golden compared with itself, a false green — while
the scenario-dir spelling of the same path was refused at exit 2. Measured at d150ac6 and d0231eb,
reproduced in a real `git worktree` with the `run/` symlinks and again on a `$TMPDIR` fixture
(`tests/oracle-guard.test.ts`); both spellings are exit 2 now, with or without
`POLYWORLD_ORACLE_ROOT`. `$TMPDIR` and any `oracle/_t_*` path stay candidates (a lane's own staged
copy holds a manifest too, and perturbing it is the point of `tests/parity-runner.test.ts`), which
is also why a golden copy to perturb belongs under those two and not beside the repo.

**Why it is stated this loudly (measured 2026-09-29 00:51–01:03, reproduced twice).** A lane's
acceptance pass ran `npx vitest run` in a git worktree whose `oracle/<scenario>/run` was a symlink
at the canonical golden (that is how a worktree gets the gitignored goldens).
`tests/parity-runner.test.ts` copies the golden and perturbing the copy is the point of the file —
but **`cpSync` preserves symlinks**, so the "copy" was a tree of links into the frozen tree and
every perturbation (`rmSync` a manifested file, `writeFileSync` `population.txt`/`movie.pmv`, and a
`reGZip()` walk over every `.gz`) wrote the golden itself. `shasum -a 256 -c` afterwards:
**97/225 OK**, with `run/events/carry.log` and `run/brain/anatomy/brainAnatomy_10_birth.txt.gz`
gone and `run/stats/stat.1` truncated. **15 tests went red across 6 files** for every lane that
graded in that window — none of them touched by the change that ran them.

**How it is enforced (both halves are load-bearing).**

* **Prevention at every writer we own** (`src/oracle/guard.ts`): `assertNotGoldenWrite`,
  `assertUsableStagingRoot` / `assertUsableCandidateRoot`, and `stageGoldenCopy` (a copy that
  dereferences and *proves* the result holds no symlinks). Wired into `writeCandidateTree` and
  `POLYWORLD_BROWSER_CANDIDATE_ROOT` (`src/browser/sim/nodeSources.ts`), the logs corpus'
  `freshDir`/`POLYWORLD_LOGS_CANDIDATE_ROOT` (`tests/logsCorpus.ts`, `tests/logsReplay.ts`),
  `POLYWORLD_GENOME_CANDIDATE_ROOT` (`tests/genome.test.ts`), `regenerateStatTree`
  (`tests/monitor.test.ts`), the native probes (`stepprobe`/`contactprobe`/`bootorderprobe`),
  `runScenario` — the `npx tsx src/model/sim/runner.ts <scenario> <outDir>` entry point every lane
  grades with (`src/model/sim/runner.ts`),
  `demoEvidence.mjs --export`, and the harness itself: `check_parity.py --candidate` and
  `record_oracle.py --candidate-out` refuse a golden at exit 2.
* **A tripwire over `node:fs` for everything else** (`tests/setup/fsGuard.ts`, aliased over the
  `node:fs` specifier in `vitest.config.ts`): a write into `oracle/<scenario>/run/**` from *any*
  test or helper throws `GoldenWriteRefused` instead of landing — including a write that reaches a
  golden through a symlink whose target sits outside the configured oracle root, because the
  predicate is the real path plus the manifest marker (`goldenWriteTarget`). The alias is not
  decoration — a Node builtin's named bindings are a snapshot, so patching the builtin's own object
  does **not** intercept the ordinary `import { writeFileSync } from 'node:fs'` (measured), which is
  the import every test in this repo uses.
  **The boundary, measured (t_833bee5f).** The alias covers the *import-style* surface (all four
  styles of the `node:fs` specifier); the runtime tripwire below covers the *object* surface —
  the builtin's own members, so `import fs from 'fs'` / `require('fs')` callers go through the net
  for every call shape, **top-level async/callback names included** (`fs.rm(dir, {recursive:true}, cb)`
  deleted a golden with the tripwire armed until t_833bee5f: only the 16 `…Sync` names and the 13
  `fs.promises` names were patched on the builtin's own object, and the callback form is the spelling
  the alias does not cover when the specifier is unaliased `fs`). The one surface **neither** half
  reaches is the ESM namespace of the *unaliased* `fs` specifier — a builtin's namespace is frozen at
  link time, before any setup file runs, so `import { rm } from 'fs'` / `import * as fs from 'fs'`
  hold un-patched bindings (measured node 22.22.2; their `.default` is the live object and *is*
  patched). Nothing in the repo writes through that hole: the only writers that name the unaliased
  specifier are `src/oracle/guard.ts` (the net's own implementation) and `tests/oracle-guard.test.ts`'s
  deliberately unguarded `rawRmSync` cleanup.
  Both halves decide with one predicate (`goldenWriteHit`, `src/oracle/guard.ts`) and one entry-point
  list (`SYNC_WRAPPERS`/`ASYNC_WRAPPERS`), so what is covered cannot drift between them — it had
  (t_06238505): `rmSync`/`rm` were in neither list, and the wipe only *looked* refused because
  node ≤ 22 implements `rmSync(recursive)` by calling the public `unlinkSync`/`rmdirSync` the net does
  wrap. Measured, the same committed test, one engine per run: node 22.22.2 refused the wipe,
  **node 24.21.0 and node 26.7.0 deleted the tree** — the engines a login shell resolves to. The
  removal entry points are therefore judged at the call, where no engine's internal walk can bypass
  them, and a recursive removal of anything inside the oracle namespace that is not `oracle/_t_*`
  (`oracle/<scenario>`, the oracle root itself) is refused as a wipe. Removing a *link* stays legal
  (`removesLinkOnly`): dropping a link is how a lane cleans its worktree's `oracle/<s>/run`.
* `tests/oracle-guard.test.ts` covers both, including the worktree-symlink shape that caused the
  incident, the removal entry points (`rmSync`/`rm`, the incident's own wipe), the builtin's **own**
  top-level async/callback names reached through the unaliased `fs` spelling (t_833bee5f) and every
  import style of `node:fs` the net claims (named, namespace, default, dynamic) — and writes only into
  `$TMPDIR` fixtures, so a reverted guard fails the test without touching a golden.

## Lane harness (W1f) — `./oracle/run_parity.sh`

One entry point, so a lane never has to know where the native tree is, which args
belong to a worldfile, or which files are allowed to differ:

| Command | Meaning | Exit |
|---|---|---|
| `run_parity.sh <scenario> --candidate <dir>` | candidate run tree vs golden | 0 pass / 1 fail / 2 usage |
| `run_parity.sh <scenario> --record [--force]` | record the golden from the native build | 0 / 1 / 2 |
| `run_parity.sh <scenario> --selfcheck` | re-run native, compare it to its own golden | 0 / 1 / 2 |
| `run_parity.sh add <name> --worldfile <wf> [--tier A\|B] [--record]` | register a lane scenario | 0 / 2 |
| `run_parity.sh list [--json]` | registry + golden status | 0 |

`--candidate` is either a directory containing `run/` or the run tree itself. The run-tree
spelling is the one a golden can be *spelled* into a free pass with, so it is the shape the
refusal above judges twice (t_f049065c): a resolved `run/` dir holding `manifest.sha256` is
refused as a candidate even when the caller only names the `run` dir, unless it is under
`$TMPDIR` or an `oracle/_t_*` staging path — a copy of a golden to perturb therefore belongs
under one of those two (`mkdtemp`/`oracle/_t_*`), which is what every test and recipe in this
repo does.
`--json` gives lanes a machine-readable verdict (`verdict`, `failed`, `missing`,
`differing`, `extra`, `ignored`, `divergence`); `--max-detail` / `--max-diffs`
bound the report, `--quiet` prints only the verdict. The command PORT_SPEC.md's
definition of done names still works verbatim:
`python3 tools/check_parity.py --golden oracle/<scenario> --candidate <dir>`.

Environment: `POLYWORLD_NATIVE` (native tree), `POLYWORLD_WEB` (repo root),
`POLYWORLD_ORACLE_ROOT` (where the goldens live), `PARITY_PYTHON`; the same values
can be pinned in `tools/parity.config.json` as `native_dir` / `oracle_dir`.
`POLYWORLD_ORACLE_ROOT` is what makes the harness usable from a lane's own git
worktree: `oracle/*/run/**` is gitignored (~35 MB of generated goldens), so a fresh
worktree has none and every check would report "no golden" — point it at the
canonical recorded ones instead of re-recording per worktree. It is a **pointer, not the
boundary**: whether a candidate *is* a golden is decided by the resolved path and its manifest
marker, so the refusals hold with the variable set, unset, or pointed at the lane's own bare
`oracle/` (t_f049065c — the unset case was the false green).

Diff output is step-localized (PORT_PLAN.md point 5): a differing datalib log is
reported with line number, the step (its first column) and the column name from
the `#@L` header row, e.g.
`FIRST DIVERGENCE in run/population.txt at line 10 (step 1), column T`.

Acceptance, demonstrated (and re-run by `tests/parity-runner.test.ts`, 15 tests):
a clean copy of `oracle/microtest_voff` → `match 225/225`, exit 0; a one-byte
perturbation of `run/population.txt` → exit 1 with `DIFFERS run/population.txt`;
a missing manifested file → exit 1 with `MISSING`; an unknown scenario → exit 2.

Safety rules encoded in the harness:

* the native tree's `run/` is **never** deleted — it is moved to
  `run.previous.<epoch>` before every native run (that tree is the only copy of
  the previous native result);
* an existing golden is **never** overwritten or deleted: `--record` refuses
  (exit 2; the golden's manifest hash was verified unchanged after the refusal)
  and `--record --force` moves the old one to
  `oracle/_native_previous/<scenario>.previous.<epoch>`;
* native runs are serialised on `<native>/.parity-native.lock`, so parallel lanes
  cannot interleave two runs into one `run/` tree;
* `--selfcheck` re-runs the native build into `oracle/_t_selfcheck_<scenario>_<pid>`
  (the `.gitignore` reserves `oracle/_t_*/`) and removes only that staging
  directory, so a lane can tell "I broke it" from "the golden is flaky".

Re-measured through the harness on 2026-09-28: `microtest_voff` clean copy
225/225 exit 0; one perturbed byte 224/225 exit 1; `--selfcheck` of `minitest_von`
(vision on, 1308 files) re-ran the native build and matched **1307/1308**, the one
exception being `run/movie.pmv`, reported as `IGNORED` (not hidden) — the second
independent native run confirming the vision finding below. Since `t_588c28e1`
**every** tier defaults to `ignore: ["run/movie.pmv"]` (PORT_SPEC declares it free;
the movie also turned out not to reproduce between two *vision-off* native runs of
`minitest_voff` on this machine — see *The movie is not a frozen artifact*), so an
`IGNORED run/movie.pmv` is now reported at any tier, and the checker always says
when it fires. Note the movie *is* reproducible for `microtest_von` and
`microtest_voff` (MaxSteps 1, 225 files): the ignore fires only when the run is
long enough to expose the unpinned sampling path.

Read a verdict carefully: `match 1307/1308 … differing=0 ignored=1` means **every compared file
matched** — an ignored file stays in the denominator and is never counted as `differing`, and the
checker never prints it after `DIFFERS`. The file a selfcheck *does* name when it fails is
`run/energy/agents/max.txt`: its `AgentGrown` rows are appended in thread-completion order under
`ParallelInitAgents True`, so native disagrees with its own golden there (3 of 4 `minitest_von`
selfchecks and 1 of 6 `minitest_voff` selfchecks, measured 2026-09-28) with no candidate in the
loop. That is native's scheduling, never a candidate regression — the *Deviations* row `L16 vision
raster` and the `--selfcheck` row below carry the mechanism and the measurement.

`microtest_von` (microtest.wf, vision on, MaxSteps 1, 225 files, ~1.2 s) is
recorded for the vision lanes: a run of the same world with vision off differs in
83 of its 225 files, so it is a cheap, real retina-in-the-loop oracle.


## The vision finding (measured — it decides the vision lane)

Two native runs of `minitest.wf` **with vision on** differ in exactly **one file out
of 1308**: `run/movie.pmv`. Every model artifact — `genome/**`, `brain/**`,
`energy/**`, `motion/**`, `lifespans.txt`, `BirthsDeaths.log` — is byte-identical
across runs. Vision-off runs differ in no *model* artifact at all; the vision-off
movie alone is also not stable — three native runs of `minitest_voff` produced two
distinct movies (`run/movie.pmv`), one of them the golden (measured 2026-09-28,
t_588c28e1; the vision finding above was recorded against model artifacts, and the
movie has since been removed from every tier's comparison — see *The movie is not a
frozen artifact*).

So:

- The **model is deterministic on this platform, retina-driven behavior included**.
  The only irreproducible artifact is the recorded movie — a presentation artifact
  written incrementally with frame-delta compression, sampled on a path that is not
  pinned to step boundaries.
- **Tier A and Tier B therefore share one oracle: byte-exact model artifacts.** The
  movie is excluded (Tier C, not frozen).
- Nobody should chase byte-exact `movie.pmv`; the browser port should instead make
  recording deterministic by construction (record on step boundaries).
- This *frees* the vision lane to be **fast rather than pixel-faithful** — batched
  readback or a shader — provided the retina values it feeds the brain keep the
  logged model outputs byte-exact. Retina pixel diffs are a debugging aid, not the
  acceptance gate; the acceptance gate is the model's own logs.

## Parity by lane

| Lane | Status | Parity | Notes |
|---|---|---|---|
| L1 rng+math | **W1d landed (PRNGs) + `exp` (`t_12c76fc3`), `sin`/`cos` (`t_5221d534`), `pow` (`t_9ed428d7`), `powf` (`t_29e0a2fc`), `atan2f` (`t_4bb10112`)** | **bit-exact, incl. the seven transcribed libm functions and their float overloads (`log`, `exp`, `sin`, `cos`, `pow`; `sinf`, `cosf`, `sincosf`, `powf`, `atan2f`)** | `src/model/rng/**`: `rand`/`srand` (Apple/FreeBSD Park–Miller), `random`/`srandom` (TYPE_3), `drand48`/`lrand48`/`srand48` (48-bit LCG in 16-bit limbs), MT19937 + GSL's uniform/uniform_pos/ugaussian/range (the polar normal draws both components with `gsl_rng_uniform_pos`, pinned against the shipped library), `nrand()` (polar + spare), `log`, `exp`, **`sin`/`cos`**, **`pow`** (all five transcribed from the oracle's libSystem), `RngSurface`/`globalRngSurface`/`RandomNumberGenerator`. Acceptance: **`../polyworld/bin/rancheck` reproduced byte-for-byte** (`diff` against the live binary: identical, 10 lines — all four columns), plus ~203k captured native `log()` samples, every stream's seed vectors and 300,000 native gaussians (seeds 42/7/12345, bit-for-bit); for `exp`, **8,261 captured native values bit-for-bit** (every branch: the two dispatch thresholds exactly, overflow, subnormals, underflow, ±0/±inf/NaN) plus a 320,121-value sweep, and the C transcription of the same disassembly diffed against the corpus. `tests/rng.test.ts` **46/46**, `npx tsc --noEmit` clean, `npm run build` ✅. L6's `logistic` and the spiking bias coin now call this `exp` — its own probe is **exp 512/512 and logistic 2048/2048 bit-exact** (was 464/512 and 1,976/2,048 against `Math.exp`). `sin`/`cos` landed in the follow-up `t_5221d534`: both transcribed (the C transcription diffed against `raw/libm_native_{sin,cos}.txt`, then the port matches **all 5,055 + 5,055** corpus values bit-for-bit, including the Payne-Hanek range), with the float overloads (`t_05611902`) measured as **not** reducible to the double transcription (`Math.fround( double sin )` off on 304/5,016 float32 arguments, `cosf` 135/5,016) and then transcribed anyway — `sinf`, `cosf` and the two-output `__sincosf_stret` the camera's fused `sin`/`cos` calls actually reach, each bit-exact against its own 5,016-row native corpus and a 105,119-argument sweep. **`pow`** — the census' last function and the last libm gap — landed in the follow-up **`t_9ed428d7`**. It is a self-contained unit (its own log2 + exp2 and its own tables, ~170 kB away from its code), transcribed from `raw/pow_bytes.bin` + `raw/pow_tables.bin`, with `native/gen_pow_table.py` extracting *and checking* both tables (the 129-entry log table's `logc` against the exact `-log2(invc)`, the 128-entry exp table against `2^(j/128)`). The C transcription (`raw/apple_pow_impl.h` + `pow_cand.c`) diffs identical to all **4,471** corpus values and to a **189,368-pair** wide sweep (`raw/wide_pow_sweep.py`), and the port matches both (4,471/4,471 and 189,368/189,368). `tests/rng.test.ts` **55/55**, `npx tsc --noEmit` clean. PORT-NOTE rows `W1d-fu/pow-*`; the genome call sites were switched in `t_c10975cb` — with the finding that only two of the four are `_pow` calls (one is a clang-folded `_exp2`, which `pow` reproduces exactly, and one is `_powf`, filed as `t_29e0a2fc` because the double `pow` is not that function), and that `distributions.ts` has no `pow` site at all (its `normalPDF`/`getNormal` call `_powf` too). **`powf` — the float overload both of those `_powf` sites call — landed in the follow-up `t_29e0a2fc`**, the sixth transcribed libm function: its own code plus two tables (`raw/powf_bytes.bin` + `raw/powf_tables.bin` from `raw/dump_libm4.c`, `native/gen_powf_table.py` extracting *and checking* them — the 128-entry log table against the exact `-128*log2(invc)` on a checked `n/256` lattice, the 128-entry exp table against `bits(2^(j/128)) - (j << 45)`), with the C transcription `raw/apple_pow_impl.h` **byte-identical to the shipped `powf` on all 7,325 corpus values and on all 175,000 pairs of a wide sweep** (`raw/wide_powf_sweep.py`), and the port matching both (7,325/7,325 and 175,000/175,000). Both `_powf` sites are switched — `distributions.ts`'s `normalPDF`, closing L10's last 11-row residual, and `genome.ts`'s `mateProbability` — and `powf` is **3x** the cost of V8's `Math.pow` (0.16 us vs 0.05 us on the model's own domain) rather than `pow`'s 26x (`npx tsx tools/measure_powf_cost.ts`), so the perf caveat on the `pow` row does not carry over. **`atan2f` — the last float overload, and the one with a *measured* residual already behind it** — landed in **`t_4bb10112`** (lane W1e's census, `PARITY.md` → *The `atan2f` census*): `frustumXZ::Inside`'s `float ang = atan2(…)` picks the float overload, and the `f32(Math.atan2)` + two ±π stand-in it replaced was **not** exact off the ±π case (1 ulp off on 460/20,050 census rows and 18,279/606,583 wide-sweep rows, `reachable-lattice` 204/4,532). Transcribed from `raw/atan2f_bytes.bin` (`raw/dump_libm5.c` → one 768-byte window: the code at +0x40, the nine-double polynomial at +0x220, the angle constants at +0x270..+0x2b8), with `native/gen_atan2f_table.py` *decoding the `adr`/`adrp`+`add`/`ldr` displacements* out of the code words and checking the angle constants against `math.pi` bit-for-bit, the C transcription `raw/apple_atan2f_impl.h` **byte-identical to the shipped `atan2f` on all 20,050 census rows and all 606,583 wide-sweep rows**, the port matching both, and the corpus replayed in `tests/rng.test.ts` (which also pins "not `Math.atan2`": 3,924 rows differ). Cost **0.060 us/call** — ~3x *cheaper* than the stand-in it replaced (`tools/measure_atan2f_cost.ts`). `nativeAtan2f` (`src/model/geometry/float.ts`) is now a one-line delegation and the two ±π values are deleted |
| L2 datalib (W1c) | landed | **byte-exact** | `src/model/datalib/**`: writer + reader + `BirthsDeaths.log` line format + the plain/gzip file backends. Re-writes **every datalib artifact the oracle recorded byte-for-byte** from its own parsed rows — `microtest_voff` 60 files / 83 tables / 416 rows, `minitest_voff` 184 files / 269 tables / 25,630 rows (all four header variants + a 24-table log) — plus `lifespans.txt` and `BirthsDeaths.log` reproduced from fixed row sets, `%f` pinned against clang/glibc vectors, and the gzip path pinned against a zlib `gzopen` reference. 20 vitest tests, `npx tsc --noEmit` clean for the lane |
| L3 proplib (W1b) | landed | **byte-exact** | `src/model/proplib/**`: tokenizer (with decoration), parser, DOM, builder, editor, schema (defaults/`@defaults`/runtime/validate), worldfile converter, writer. Reproduces **both frozen worldfile artifacts for all four recorded variants, byte for byte** — `minitest_voff` / `minitest_von` / `microtest_voff` / `microtest_von`: `run/normalized.wf` 11,889 / 11,888 / 11,887 / 11,886 B (sha256 `51d19575…7c47f`, `929fe27b…e810b`, `2e8ea4a9…3ace`, `b23243b6…23b7`) and `run/converted.wf` 187 / 172 / 185 / 170 B, each identical to `oracle/<scenario>/run/**`. `--Vision False` goes through the parameter path; `*_von` passes **no** parameters, which is a different map from passing the default. The suite's live-run check compares against `<native>/run/**` only after identifying the run from its own bytes (`run/original.wf` + a golden-matching `normalized.wf`) and skips otherwise — that directory is rewritten by every native record, which is what made the shared `npm test` gate red before (PORT-NOTE `W1b-tests/live-run-is-not-a-fixture`). 36 vitest tests; `npx tsc --noEmit` clean for the lane. Expression *evaluation* is lane L4 (seam + Gaps row below) |
| L4 proplib-expr | **landed** | **byte-exact, and the language matches the native interpreter on every recorded vector** | `src/model/proplib/{evaluator,pythonExpression}.ts` + `native/record_python_vectors.py` + `native/vectors/pythonExpressions.json`. Native never evaluates in C++: `interpreter.cc` renders the expression's tokens as Python source and pipes it to `python3` (`interpreter.py`), storing `str( eval( text ) )`. The port reproduces both halves: `generatePythonExpression()` is the code generation (decoration, dropped trailing `;`, enum/class → quoted literal, property → its evaluated value, unresolved → verbatim Python symbol), and `pythonExpression.ts` is the language (Python ints as `bigint`, `/` true division, `//` floor, `%` sign-of-divisor, chained comparisons, operand-returning `and`/`or`, `A if C else B`, Python `str()`/`repr()` — including the float repr switch at `1e16`/`1e-4`). `interpreterEvaluator` is now the default for every document build. Evidence: **377 recorded `python3` vectors reproduced exactly** (121 of them the Python text the port's own code generation produced while building the four recorded scenarios with the validation pass on, plus 261 language/adversarial cases with 26 recorded failures matched message-for-message); **`run/{converted,normalized}.wf` byte-for-byte for all four variants with `validate: true`** and every scalar in the document readable (`Config`'s boot reads); `tests/proplib.test.ts` **49 passed | 1 skipped** (re-measured 2026-09-29); `npx tsc --noEmit` exit 0; `npx vitest run` green for the whole project (449 passed / 1 skipped at this run; the count moves as other lanes land their tests); L14's monitor documents (89 + 89 native leaves) and the L18 browser read plan both now run on this evaluator. The two things it refuses on purpose (`lambda`/comprehensions/f-strings/`bytes`/complex/`%`-formatting/walrus, and Python attribute access) fail loudly (`port: …`) — see the Gaps/Deviations rows |
| L5 genome | landed | **byte-exact for everything the lane can produce without the simulation** | `src/model/genome/**`: `Gene`/`GeneSchema`/`GenomeSchema`/`GenomeLayout`/`Genome`/`GenomeUtil`/`SeparationCache` + `groups/**` (gene schema, neuron-group genes, the layout walk, `GroupsGenome`). Oracle: `./oracle/run_parity.sh microtest_voff --candidate …` → **match 30/225, differing 0, exit 0**; `minitest_voff` → **match 30/1369, differing 0, exit 0** (the 30 = `run/genome/meta/*.txt` (5) + the 25 initial-population `agents/genome_<n>.txt.gz`). `tests/genome.test.ts` 35/35; `npx tsc --noEmit` clean for the lane. The lane also owns the cpp-props `$[gene,…]` symbol (a `dyn` property whose storage *is* the gene's `Scalar`): `tools/cppprops/bindings/gene.mjs` + `tests/cppprops-gene-binding.test.ts` **24/24**, pinned against the native run's own `generange.txt`, the new union-read probe and a 300-step native farm-log replay — see *PORT-NOTEs (L5 genome)* and `docs/specs/cppprops.md` §3 |
| L6 brain-core | landed (differential + whole-run, via L7) | **byte-exact vs the oracle's own code**; and whole-run measured — the L7 row is that check (1,080 / 1,031 / 125 / 125 / 1,080 `run/brain/**` paths byte-identical) | `src/model/brain/core/**`: `NeuronModel`/`FiringRateModel`/`SpikingModel`, `Nerve`/`NervousSystem`/`Sensor`, the `Brain` base (dumps, prebirth, freeze), `GroupsBrain`, `SheetsModel`/`SheetsBrain`, `RqNervousSystem`, plus a native differential harness (`native/brainprobe.cc` + `run_brainprobe.sh`, linked against the oracle's `libpolyworld.dylib`). `tests/brain-core.test.ts` **76/76** (41 native differential plus `t_89eb5e66`'s 14 for the `SeedSynapsesFromRun` reader/writer pair — 12 replay tests over the corpus committed in `native/vectors/` that need no C++, and 2 that fail if the probe's regenerated corpus differs from it, see Gaps; `t_b20ef448` added the three `clamp*` families that pin the learning rule's clamp chain — 1,024 driven synapses each, *Round 7* — and `t_efc4dc64` added `native parity: learndelta`, which pins the same rule's fused delta on 16 saturated-destination rows, *Round 8*). **Byte-identical for all three probe variants** on the `run/brain/{function,synapses,anatomy}/**` *shapes* (native `startFunctional`/`writeFunctional`/`endFunctional`, `dumpSynapses` after learning, `dumpAnatomical`), and on `%g`/`%G`/`%f`/`%+06.4f`/`%hd`/`%ld` formatting (model values + 37 adversarial vectors). **Activations and efficacies are now bit-exact on all three variants** — 96/96 · 96/96 · 102/102 and 23/23 · 23/23 · 26/26, up from 87/96 · 83/96 · 101/102 and 23/23 · 23/23 · 23/26. **`t_da2ab201` (2026-09-28) closed that residual, and it was not the libm: it was clang's `-ffp-contract=on`.** Lane L1's transcribed `exp` had already made this lane's own census exact (`exp` 512/512, `logistic` 2048/2048, 0 ulp), which left "a store width, an evaluation order, a `float`/`double` mix somewhere in the propagation" as the suspect set — and the shipped disassembly answers all three at once: every `a*b + c` on this lane's path is a **hardware `fmadd`** (`FiringRateModel::update` `0x5e704`/`0x5e7c8` accumulation, `0x5e744`/`0x5e804` tau/gain, `0x5e8a8` learning; `SpikingModel::update` `0x678cc` accumulation, `0x67964`/`0x67988` Izhikevich voltage, `0x67990`-`0x67994` recovery, `0x67d80` smoothed firing rate), while the port rounded the product and then the sum (~1 ulp per site per step, amplified by the model's own recurrence). `nativeMath.ts`'s new `fma64` is the correctly rounded **binary64** FMA — `f32Fma`'s double sibling, emulated exactly because JavaScript has no `Math.fma` (Dekker two-product + round-to-odd) — and is pinned against the hardware's own `fmadd` on **57,539/57,539** probe rows (`brainprobe fma` → `describe('fma64 (native differential)')`, which measures the rounds-per-operation form wrong on 7,103 of them). The `dyn` growers worlds' `Yaw`-nerve drift goes with it: those two knife edges are gone (the L11 Gaps row). Whole-run `run/brain/**` parity is no longer blocked: L5 (genome) and L11 (sim) have both landed, and lane L7's row carries that check over this lane's own dumps — **1,080 `run/brain/**` paths on `minitest_voff`, 1,031 on `minitest_von`, 125 on each `micro*`, 1,080 on `minitest_adami`**, every one byte-identical in the whole-run PASSes (`differing=0 missing=0 extra=0`; counts are the goldens' own `oracle/<scenario>/run/manifest.sha256` lines, each candidate file byte-compared). What is still open on this lane is `GroupsBrain::grow`, recorded in Gaps (its two `-ffp-contract=on` sites, `0x66b70`/`0x66dc0`, were adjudicated by `t_7d391d0f`: the first is provably bit-identical, the second is contracted and pinned, *Round 6* of the contraction sweep). Whole-point: the lane's `%g` implementation is new (W1c's `printf` throws on `%g`) and is pinned against this machine's printf
| L7 brain-record | **landed (`run/brain/**` inside the whole-run PASSes)** | **byte-exact**: **1,080 `run/brain/**` paths on `minitest_voff`** (89 `Recent/**`, 120 `bestRecent/**`, 308 `bestSoFar/**`, 238 `anatomy/**`, 238 `synapses/**`, 87 `function/**`), **1,031 on `minitest_von`** (82 `Recent/**`, 120 `bestRecent/**`, 296 `bestSoFar/**`, 225 `anatomy/**`, 225 `synapses/**`, 83 `function/**`), **125 on each `micro*`** and **1,080 on `minitest_adami`** — every one byte-identical to the golden in the runner's own candidate tree (`differing=0 missing=0 extra=0`) | The *recording* half of L6's dumps: `run/brain/{function,anatomy,synapses,bestRecent,bestSoFar,Recent}/**`, written per agent per record by the run itself. `PORT_PLAN.md`'s acceptance column for this lane is "`run/brain/**` inclusive", and it is measured through the harness on the runner's tree — `./oracle/run_parity.sh minitest_voff --candidate <tree>` → `match 1368/1369, differing=0, missing=0, extra=0`, **`PASS (1369/1369 files)`** — and the same holds for the other five scenarios. The path counts are the goldens' own manifest lines (`oracle/<scenario>/run/manifest.sha256`), each re-checked file-by-file against the candidate tree. L6's row still says whole-run `run/brain/**` "cannot be checked until L5 (genome) and L11 (sim) exist": both exist, and this row is that check |
| L8 agent-core | W1 landed (interface-cut) | differential: **3022/3022 bit-exact** (the 65 residuals the first round measured were clang `-ffp-contract=on` in the native build — now transcribed from the shipped disassembly, `f32Fma`; see *the float-contraction rule*); config + lifespan 100%; 26 lane tests | `src/model/agent/**`; ported behind seams (genome L5, brain L6, environment L10, graphics L15, sim L11). `run/energy/**`, `run/motion/**`, `run/lifespans.txt` are no longer waiting on those lanes: all three exist and are byte-identical in the whole-run PASS — `minitest_voff` carries 90 `run/energy/**` paths, 87 `run/motion/**` and `run/lifespans.txt`, all manifested, `differing=0 missing=0 extra=0`; see Gaps + the float-contraction rule |
| L9 agent-sensors | **landed — acceptance met end-to-end** | **byte-exact with `Vision True`**: `minitest_von` **PASS 1308/1308** and `microtest_von` **PASS 225/225**, node runner **and** running page | `PORT_PLAN.md`'s acceptance for this lane is "model logs with `Vision True` byte-exact", and it is met by the two vision-on scenarios: `./oracle/run_parity.sh minitest_von --candidate <tree>` → `match 1307/1308, differing=0, missing=0, extra=0`, **`PASS (1308/1308 files)`**, 1114/1114 `.gz` containers byte-identical, `container differs 0`; `microtest_von` → **`PASS (225/225 files)`**, 150/150. The page half is measured, not inferred: `src/browser/verify/demoEvidence.mjs` exports the **page's own** run tree (1,307 files / 10.5 MB) and the harness returns the same verdict from it. **The shape of this evidence is stated plainly, because it is not the shape L6/L10/L13 have:** there is **no standalone native differential probe** for the non-retina senses — the six proprioceptive sensors (`agent/{Energy,Random,MateWait,Speed,Carrying,BeingCarried}Sensor.cc` → `src/model/agent/sensors.ts`) and the retina-bound-as-`Sensor` object (`src/model/sim/retinaSensor.ts`) have no probe of their own and are covered *end-to-end* by those two vision-on PASSes, i.e. by the model's own logs from a run in which every sense was live. The **retina half** does have its own evidence, in L16: `native/retinadump.cpp` → the **7,315-row** `minitest_von` dump (`golden/*.retina.jsonl.gz`, every row compared in `tests/vision-native-rows.test.ts`), the executable reference encoder (`tests/vision-encoder.test.ts`) and the sub-pixel grid sweep. `tests/vision-on-is-not-a-noop.test.ts` pins the gate a silently-vision-off run would otherwise pass: a `*_von` world differs from its `*_voff` twin in 83 of 225 files, so no no-op retina can satisfy both PASSes. This row supersedes the L18 row's vision-on control reading (`minitest_von` 168/1308, `differing=684`): that was the model half's divergence, measured while L11/L16 were still landing it, and it is closed |
| L10 environment | landed (review round 2) | **bit-exact vs the oracle's own code**; and whole-run: `run/events/**` (4 files) and the food-energy columns of `run/energy/food.txt` are byte-identical in the six whole-run PASSes | `src/model/environment/**`: `object`/`patch`/`foodType`/`food`/`foodPatch`/`brick`/`brickPatch`/`barrier`/`objectXSortedList` + `distributions`. Goldens come from a native differential probe (`native/envprobe.cc` + `native/run_envprobe.sh`, links `libpolyworld.dylib`); `tests/environment.test.ts` replays every fixture in the probe's order — **13/13 tests, 1,959 golden pins consumed, 0 mismatches**, every `f32` compared as a raw bit pattern. It also checks the recorded run: all **1,490 `barrier` rows of `minitest_voff/events/collisions.log` lie inside the barrier x-window** computed from this lane's geometry at the worldfile's own `MaxAgentMaxSpeed = 1.5` (negative control: 100+ `edge` rows are outside it), and `run/energy/food.txt`'s column names are this lane's `FoodType` registry in definition order. Review round 1 returned the card for a real defect — `objectXSortedList.sort()`, which `TSimulation::Interact` runs every step, dropped native's `o = p;` rebind — now fixed and pinned by 7 fixtures × 2 passes, with the mutation check recorded in the L10 section. Round 3 (`t_113978a6`/`t_df1eb21b`) fixed the second list defect: the key read the radius as a **field**, which is `NaN` for lane L8's `agent` (`radius()` over private state, no field), so the port's agent list stayed in insertion order, `sort()` relocated nothing and `Interact`'s contact walk never reached a pair. Now pinned by a new `objectlist.accessor.*` probe section — **1,959 pins, 13/13 tests**, and restoring the field read fails 18 of those pins and nothing else. Measured on the run: `contacts.log` carries both of the golden's contacts and `match` went **215/225 → 217/225, differing 9 → 7** (`energy/agents/agent_{2,15}.txt` and `energy/food.txt` now match). Two residuals are handed to L11 (`t_d5ca0870`): that log's `Events` column, and a step-1 row-order change in `collisions.log` — both recorded in the L10 section. **`t_4e856769` (2026-09-28) closed this lane's two module-ownership hops and re-ran the milestone**: `Energy` now lives in `energy.ts` here (moved out of L8's `agent/energy.ts`, with `MAX_ENERGY_TYPES`/`ENERGY_EPSILON` out of `agent/numeric.ts` — one definition, `grep` counts in the Gaps rows), and the `gbox` radius rule this lane's `object.ts` carried is now L15's one function (`geometry/primitives.ts`, re-exported as `focusRadius`) — `grep -rn 'f32(f32(f32(root' src` 6 → 1 — with `tests/environment.test.ts`'s whole fixture set green (**15/15**). Both hops are byte-null on the recorded runs: the whole six-scenario milestone re-PASSed unchanged (`microtest_voff` 225/225, `minitest_voff` 1369/1369, `microtest_von` 225/225, `minitest_von` 1308/1308, `hello` 19/19, `minitest_adami` 1373/1373, `differing=0 missing=0 extra=0` throughout, every `.gz` payload identical), so `run/energy/**` — the point of the `Energy` move — is byte-identical |
| L11 sim | **landed (whole-run Tier A byte-exact)** | **byte-exact**: `microtest_voff` **PASS 225/225**, `minitest_voff` **PASS 1369/1369**, `hello` **PASS 19/19**, `minitest_adami` **PASS 1373/1373** — `differing=0 missing=0 extra=0` in all four — and the vision-on pair `microtest_von` 225/225 · `minitest_von` 1308/1308 | `PORT_PLAN.md`'s acceptance ("whole-run Tier A byte-exact") is met on the runner's own tree: `npx tsx src/model/sim/runner.ts <scenario> <dir>`, then `./oracle/run_parity.sh <scenario> --candidate <dir>` — every manifest line of every scenario, `differing=0 missing=0 extra=0`, every content-compared `.gz` container byte-identical (150/150, 1167/1167, 150/150, 1114/1114, 0/0, 1167/1167; `container differs 0` in all six). This is the fan-in the other rows were waiting on: L6's `run/brain/**` (1,080 paths), L8's `run/energy/**` (90) · `run/motion/**` (87) · `run/lifespans.txt`, L10's `run/events/**` (4) and the food-energy columns, L12's artifacts, L13's Adami scenario (`minitest_adami`) and L7's recording paths are all whole-run checked once this lane raises the events, so those rows' "blocked on L11" clauses are satisfied by these runs. **Nothing on this row is open:** the bounded `dyn` growers drift (`t_05b45824`) was closed by `t_da2ab201` — behaviourally, not by tolerance: `tests/cppprops-sim-engine-growers-{dyn,small}.test.ts` now take their `divergenceCount === 0` branch and return there (`cppprops-sim-engine-growers-dyn.test.ts:92`, `-small.test.ts:56`). The full record, including the mutation that pins the cause (L6's brain-arithmetic contractions), is the Gaps row *L11: the `dyn` growers worlds*, paragraph *(6)* |
| L12 logs | landed (recorder layer) | **byte-exact for every artifact this lane decides** | `src/model/logs/**`: the 23 recorders, the `Logger`/`Logs` registry, the per-agent state slots, the file seam and its node adapter. `./oracle/run_parity.sh minitest_voff --candidate <tree>` -> **match 186/1369, differing=0, missing=0, extra=0, exit 0**; `microtest_voff` -> **match 62/225, differing=0, exit 0** (the ignored remainder is other lanes' artifacts: `brain/**` (L6 content), `genome/agents/**` + `genome/meta/**` (L5 content), `stats/**` (L14), `movie.pmv`, `endStep/endReason` (L11), the worldfiles (L3), `manifest.sha256`). The same numbers come from `tests/logs-replay.test.ts` (13 tests) replaying the goldens; `run/brain/**`'s 1,080 paths are reproduced as a set by `tests/logs.test.ts`; whole-run parity is no longer blocked either: L11 raises the events and all six recorded scenarios PASS — `run/events/**` (4 files) and the food-energy columns of `run/energy/food.txt` byte-identical, `differing=0 missing=0 extra=0` |
| L13 complexity | landed (native differential + independent reference) | **byte-exact vs the oracle's own code** for the brain-function path and for every pipeline stage; Adami pinned against a second implementation and against a new recorded run | `src/model/complexity/**`: `complexity_algorithm.cc`, `complexity_brain.cc`, `adami.cc` behind the frozen types, plus the two GSL kernels (`gsl.ts`; measured by `native/gslprobe.c` + `run_gslprobe.sh` → `native/raw/gsl_kernels.txt`) and a transcribed `log2` (this machine's is accurate but *not* correctly rounded: on the committed 22,312-value corpus (`native/raw/gen_log2_corpus.py`) V8's `Math.log2` differs on 68 of them and a correctly rounded `log2` still differs on 4, 1 ulp each — `native/raw/log2_correct_rounding.py`). **Differential** (`native/complexityprobe.cc` + `run_complexityprobe.sh`, linked against the oracle's own `libpolyworld.dylib`): `golden/brain.txt` = the real `CalcComplexity_brainfunction()` over **all 87 recorded `run/brain/function/brainFunction_*.txt.gz` fixtures × 7 `parts` strings** (609 rows: complexity bits, agent number, neuron counts, lifespan); `golden/pieces-*.txt` = `CalcApproximateFullComplexityWithMatrix` **stage by stage** over two matrices the probe generates itself (noise + `gsamp`, `calcCOV`, `determinant`, `CalcI`, `calc_C_k_exact`, and every cross-section's determinant, integration and **LU factors**, so the subset *order* is pinned); the probe also checks its own replication against the library's end-to-end value and exits non-zero if they disagree. `tests/complexity.test.ts` **15/15** (incl. `log2` bit-exact on the corpus, and a rebuild that regenerates the committed goldens byte for byte). **Adami** cannot be reached from a probe (`computeAdamiComplexity` reads `GenomeUtil::schema` and walks live agents), so it is pinned twice: `native/adami_reference.py` — a second implementation of the same arithmetic (numpy float32, Python's libm) whose output `golden/adami/` the port reproduces byte for byte — and end to end against the lane's new recorded scenario `minitest_adami` (`tools/scenarios.d/minitest_adami.json`: `minitest_voff`'s worldfile + `--RecordAdamiComplexity True --AdamiComplexityRecordFrequency 1`, 301 records × 2,843 genes recorded from the native build). `tests/complexity-adami.test.ts` **3 passed (3), 0 skipped** (re-measured 2026-09-29 on `b2bbcaf`) — the end-to-end half **now runs and passes**: the port completes `minitest_voff`'s 301 steps with births in it, so the old "the port cannot complete a run" skip (`steps=0`, then `datalib: addRow without a table` — L11's double-kill in the contact walk, closed by `sim/interact.ts`'s `Fight` out-params) is gone, and the comparison is gated on **the replayed run's own population history** (`run/BirthsDeaths.log` + `run/population.txt`, PORT-NOTE `l13/adami-is-a-function-of-the-run`) — a gate that **no longer trips**: `firstHistoryDivergence()` returns `null`, so every one of the 301 rows per record is asserted. Its former trip point was `run/BirthsDeaths.log` line 77 (`197 DEATH 47` golden vs `198 DEATH 47` port — the *former* `minitest_voff` divergence, closed by L11's run 7), which had put **one differing row of 301 per record** behind the skip; all four records are now compared byte for byte in full. **The comparison's first executing run also found a real defect in this lane** (PORT-NOTE `l13/adami-entropy-is-contracted`): `adami.cc:97`'s one-bit entropy sum and `:139`'s two-bit `sum += prob*logprob` *are* contracted in the shipped binary (`fmul`+`fmadd` at `0xebc0`/`0xebc4`; four `fmadd`s at `0xefe0-0xf04c`) while the 16-outcome loop is **not** (clang vectorised it: `fmul.4s` + scalar `fadd`s at `0xf25c-0xf440`), so the rounds-per-operation transcription was 1 ulp out — invisible in the `%.4f` window files, but not in `AdamiComplexity-summary.txt`'s float accumulation, which diverged from step 148 (`18603.6172` golden / `18603.6191` port). Fixed with `f32Fma`; mutation check: revert the fusion and the recorded-run differential fails at summary line 150, inside the gate's forced prefix. `npx tsc --noEmit` clean; whole suite **48 files / 729 passed | 1 skipped** (measured 2026-09-29, tree `b2bbcaf`). PORT-NOTEs: `l13/single-column-aborts`, `l13/logfile-listing-order`, `l13/batch-is-sequential`, `l13/gsamp-sort-is-stable`, `l13/gsamp-takes-a-pointer`, `l13/k0-aborts`, `l13/vector-block-underflow`, `l13/lu-multipliers-are-reciprocal-scaled`, `l13/lu-update-is-fused-dger`, `l13/adami-first-record`, `l13/adami-header-format`, `l13/adami-entropy-is-contracted`, `l13/adami-is-a-function-of-the-run`, `L13/log2-is-transcribed-not-correctly-rounded`, `L13/log2-belongs-in-rng` |
| L14 monitor | landed | **byte-exact** (the frozen part) | `src/model/monitor/**`: the nine monitors, `AgentTracker`, `CameraController`, `MovieSettings`/`SceneMovieController`, monitor selection (`MonitorManager`) and the monitor-document loader — pure data, no UI. **Frozen artifact:** `run/stats/stat.<timestep>`. The goldens' four (resp. one) files are predicted from `endStep.txt` + the resolved `FrequencyStore`, then reproduced **byte for byte** from the golden's own status lines, and a candidate tree whose `run/stats/**` this lane wrote passes the checker: `./oracle/run_parity.sh microtest_voff --candidate <tree>` → **match 225/225** and `./oracle/run_parity.sh minitest_voff --candidate <tree>` → **match 1369/1369** (`differing=0 missing=0 extra=0`, exit 0; both re-run inside `tests/monitor.test.ts`). **Movie frame schedule:** the goldens' `movie.pmv` headers give `frameCount` 301/301/1/1 = exactly what `MovieSettings::shouldRecord` selects over `1..MaxSteps`, with the DIMENSIONS meta entry equal to the resolved 640×480 buffer. **Arithmetic:** pinned bit-for-bit against the linked native library (`native/monitorprobe.sh` → `camera.json` 117 frames over all three camera modes, `moviesettings.json` a 60-case grid incl. `timestep 0`, `enums.json`, `monitorConfig.{term,gui}.json` = 89+89 resolved document leaves). 18 vitest tests; `npx tsc --noEmit` clean for the lane |
| L15 graphics-scene | **landed (body mesh; renderer still open)** | **bit-exact for the model-visible half** — the collision radius | `src/model/geometry/body.ts`: the native `pw1` loader (`Resources::loadPolygons`/`operator>>`) + `AgentBodyGeometry` (`gpolyobj::clonegeom`/`setlen`/`setradius` + `agent::SetGeometry`'s in-place vertex scaling + the `fRadiusScale`/`fScale`/`fRadiusFixed` state), over `etc/objects/agent.obj` bundled **verbatim** (sha256-pinned) in `golden/nativeBodyMesh.ts`. Goldens come from a native differential probe (`native/bodyprobe.{cpp,sh}`) that links the real `libpolyworld.dylib` and drives the **real `agent::SetGeometry()`** on a real `agent` for the recorded scenarios' own genomes: **112/112 recorded agents** (`microtest_voff` 25, `minitest_voff` 87) reproduce `fLengthX`/`fLengthZ`/`fLength[0..2]`/`fRadius`/`fCarryRadius` **bit-for-bit** through the port, and the mesh's bounding box/radius match the native loader exactly. `tests/geometry.test.ts` 47/47; the run tree's `run/events/collisions.log` (the barrier pass reads `CarryRadius()`) is **byte-identical** to the golden (it still was as of the L15 pass; the L10 list fix later reordered step 1's two `edge` rows — that is a pre-`sort()` walk order in L11's phase, recorded in the L10 section under *the accessor-radius fix and its whole-run effect*). **Defect found and fixed in this pass:** `agent::SetGeometry`'s `sqrt` is the single-precision overload and lane L8's port used `Math.sqrt` — 1 ulp off native on 7 (`fLengthX`) / 13 (`fLengthZ`) of the 112 agents; see the L15 section. The **renderer** half (`gstage`, the draw calls, the `SceneRenderer`) is not part of this pass — L16/L18's seam is unaffected |
| L16 vision-raster | **landed (node scanner: `microtest_von` + `minitest_von` byte-exact; browser atlas landed with L18)** | **byte-exact**: `minitest_von` **PASS 1308/1308** (`differing=0 missing=0 extra=0`, `run/movie.pmv` ignored, 1114/1114 `.gz` containers byte-identical), `microtest_von` 225/225, and every vision-*off* scenario untouched | The node-side `AgentPovRenderer` is `vision/povScan.ts` + `vision/povRaster.ts`: `beginStep()` snapshots the world in native display-list order (the `fStage.Compile()` point), and `render(agent)` reproduces `QtAgentPovRenderer::render` → `Retina::updateBuffer`'s single row by **rasterizing it the way the GL driver did** — f32 `P·V`, near/far clip, viewport transform, snap to the driver's sub-pixel grid (`SUB_PIXEL_BITS = 8`, measured), three edge functions at the pixel centres with the top-left fill rule, and `GL_LESS` on the screen-space-interpolated `z/w` (24-bit fixed point) in draw order. It replaces `t_83dc2e2c`'s f64 ray cast, which was the same arithmetic only in the limit: the recorded run's first divergence was a **0.00145-pixel knife edge** (step 12, agent 23, pixel 13 — window x 13.501451 against the 13.5 centre) and one flipped retina byte poisons every downstream artifact of a chaotic model. Grid sweep against the 7315-row native dump, first differing row: unsnapped → step 12, 4 bits → step 1, **8 bits → step 71**, 12/16 bits → step 12. The step-71 residual was the *second* mechanism, outside this lane: one run-wide `deps.geometry` shared by every agent, rescaled in place by each birth (native keeps `agent::fPolygon` per agent) — fixed in `src/model/agent/agent.ts` (`bodyGeometry()`), see the L16 section's finding 7. `tests/vision-pov-scan.test.ts` 7/7 (knife edge, fill rule, depth ties, near/far clip, `SUB_PIXEL_BITS`, per-agent mesh); the browser half (batched WebGL2 atlas, 16/16 on a real context, ~22× the per-agent shape) is the `vision/raster.ts` row above |
| L17 tools | **landed (the parity harness; the native `tools/**` programs are outside the demo's path)** | **the instrument** — not a measured artifact itself: it is what produced every PASS above | `tools/record_oracle.py` (native run → `run/` snapshot → sha256 manifest), `tools/check_parity.py` + `tools/parity_common.py` (candidate vs golden, `--json`, step-localized first divergence), `tools/add_scenario.py` + `tools/scenarios.d/*.json` (the lane scenario registry), `src/model/sim/runner.ts` (run the port into a candidate tree) and `./oracle/run_parity.sh` (the one entry point); `tools/perf/**` is L19's. `PORT_PLAN.md`'s acceptance column is "tool outputs", and the harness's own acceptance is pinned by `tests/parity-runner.test.ts` — **15 tests**, 15/15 green on the tree these PASSes were measured on: a clean goldens copy → exit 0; a one-byte perturbation → exit 1 naming the file and the first divergence; a missing manifested file → `MISSING`; an unknown scenario → exit 2; the tier-A movie exemption; machine-readable JSON for lane tooling; the oracle is never written into while comparing; and the content-compare rules including `--no-content-compare`. The six PASSes above were all produced *through* it (the runner writes the candidate tree, `record_oracle.py` wrote the goldens). The native `tools/**` programs the plan names (`nullevo`, `passive`, `clustering`) are not ported; `PORT_PLAN.md` → Risks 3 says they "are not needed for a browser demo; they can be deferred without weakening Tier A" |
| L18 browser shell + wiring | **landed (L18c: the page mounts the monitors too; L20: the demo runs end to end and the page's own tree is parity-checked)** | **byte-exact**: 224/225 (`microtest_voff`), 1368/1369 (`minitest_voff`) and 18/19 (`hello`) with `differing=0, missing=0`; UX not frozen | The shell *boots a worldfile* through lane W1b's converter (`sim/worldBoot.ts`: schema → worldfile → `original.{wf,wfs}` → `converted.wf` → `apply()` → `normalized.wf`) **and steps lane L11's simulation in the page** — `sim/modelWorld.ts` builds `TSimulation` from the boot's document + artifact texts and hands it `sim/browserFiles.ts`, an in-memory lane-L12 `RecordFileSystem` (no `node:fs` anywhere in the bundle). The rendered agents are the run's live roster: `x()`/`z()`/`yaw()`/`radius()`/`color()` read per step from `gXSortedObjects` in native order. **Oracle evidence** (`./oracle/run_parity.sh <scenario> --candidate <tree>`, every byte the page's own run wrote): `microtest_voff` → **match 224/225, differing=0, missing=0, extra=0** and `minitest_voff` → **match 1368/1369, differing=0, missing=0, extra=0** — the verdict lines read **`parity: PASS (225/225 files)`** and **`PASS (1369/1369 files)`** (`ignored=1` = `run/movie.pmv` in both; `match`'s denominator counts the ignored file). The monitor's `run/stats/stat.{1,100,200,300}` are written **by the page** now — lane L14's `MonitorManager`, mounted off `stepEnding` exactly as native's app mounts it, over monitor documents bundled verbatim (`L18/monitors-in-the-page`, `L18/bundled-monitor-documents`, `L18/status-text-store`) — and they are sha256-identical to the goldens; the gzip containers compare byte-identical too (150/1167 payloads). The only golden files a page run still does not produce are `run/movie.pmv` (Tier C, free: the null movie writer lane L11's node runner also mounts) and the harness's own `run/manifest.sha256`, and `runTreeSuite.ts` pins exactly that pair so a lost artifact cannot hide in a count. The four `*.wf` boot artifacts are byte-for-byte inside that tree. Vision-on control (re-measured today, page vs lane L11's node runner on the same scenarios): `microtest_von` **match 143/225, differing=81, missing=0, extra=0** (runner: 143/81/0/0) and `minitest_von` **168/1308, differing=684, missing=455, extra=516** (runner: identical) — **the page and the runner now agree file for file, with no delta at all** (the 4-file difference the L18b row carried was the monitor's `stat.*`, which the page writes too since L18c), i.e. the vision-on divergence was the model lane's, not the browser binding — **closed since**: with L16/L11 landed the page's own tree reproduces `minitest_von` byte-exact (`parity: PASS (1308/1308 files)`, 1114/1114 containers) and `microtest_von` `PASS (225/225 files)`, see L9. `src/browser/**` 79 vitest tests (boot parity + the bundled monitor documents, the seam contract, three run trees — `hello`'s is its own file, its worldfile records a different artifact set — step maths, config); `npx tsc --noEmit` clean; `npm run build` ✅; headless Chrome over CDP — **60 fps, 30 steps/s at 1× and 240 at 8×**, pause freezes the counter, step +1, "New run" reloads with the next `InitSeed` (a run cannot be rewound in-process: the model's table are process-wide, as native's are), camera reset works, 7 draw calls for 25 agents, **0 console errors/warnings**; the panel's `world data` row reads `model` and a new `run files` row reports the files the run has written. **L20 (the demo card) closed the loop end to end** — the page itself exports what it wrote (`__polyworld.runTreeManifest/runTreeFile/runTreeFiles`, `verify/demoEvidence.mjs`) and that tree is what the harness compares: `microtest_voff` 224 files, `minitest_voff` 1368 files and `hello` 18 files all **`PASS` with `differing=0, missing=0`**, byte-identical to the node-side tree as well; the dev server serves the same page with **215 same-origin requests and nothing that compiles in the page**, `npm run build` + a static server is **4 same-origin requests**; and the export exposed a real defect — `dispose()` had never disposed the *world*, so the page's tree was missing native's end phase (`run/endStep.txt` + the `DR_SIMEND` `lifespans.txt` rows) until `PORT-NOTE (L18/end-phase-is-the-destructor)` fixed it |
| W1h cppprops (run-time codegen → build-time data) | landed | **property values byte-exact vs the native FarmMonitor on all seven recorded traces; emitted C++ byte-identical to the run-generated `generated.cc`** | `tools/cppprops/**` replaces the native run-time `clang++`+`dlopen` step (`run/.cppprops`, ~6 s of every run) with **data + an interpreter**: `lib/proplib.py` is a port of exactly the proplib subset `cppprops.cc` walks (parser with decorations, DOM, `findSymbol`, schema class injection/defaults/`@defaults`/runtime injection, `getCppSymbol` macro expansion, the Python-substituted `eval` of constant symbols), `lib/cppprops_model.py` re-emits the native `generated.cc` (metadata table, init bindings, init/update bodies, antecedent sort) and `extract_cppprops.py --worldfile --schema` writes the spec. `lib/cppprops.mjs` interprets the spec - `Runtime` values come from the model, `Dynamic` bodies run in native update order with the exact-`!=` write-if-changed store and `Math.fround` at the `float` boundary - and renders `%d`/`%g`/`True|False`. Acceptance: `tools/cppprops/verify_cppprops.py` → **7/7 scenarios**, 301x4 + 1x4 + 300x9 + 300x10 + 300x9 + 300x9 + 301x5 values compared column-by-column against the native farm log, with the `node` child started under `PATH=/nonexistent` (nothing can be compiled or `dlopen`ed at run time - that is the proof, not a promise). The 4th scenario (`growers_dyn`) is recorded here (native run via `fixtures/harness/record_scenario.py`) with the `dyn` gate moved to `Step < 10` so the dynamic branch actually fires: `Barriers[0].Z2` walks -1 → -0.970895 (292 distinct `%g` values) and `Barriers[1].Z2` mirrors it, which pins the antecedent ordering. The 5th (`two_metabolisms`) defines two metabolisms, which is the gate that makes `Simulation::getStatusText` print the per-metabolism alive counts (` -<Name> = <n>`, `Simulation.cc:4894-4904`): its `AgentMetabolisms[0].MetabolismAgentCount` is replayed from the **recorded** `metabolism0` (12 at step 1, `agents` 25), not from `agents` - and the old mapping fails the check at step 1 (25 vs 12), so the comparison now distinguishes the two. The 6th (`growers_ring`) is the `FoodPatchTokenRing` fixture the earlier traces could not provide: `growers_dyn` holds `P0On=True, P1On=P2On=False` for all 300 steps, so the binding's engine input (`FoodPatch::agentInsideCount` — printed by `getStatusText` as the `  FP<i> …` lines, dropped by the harness until now, and recorded per step as the `foodPatches` block) was never exercised. Its worldfile is `growers_dyn` with the first `FoodPatchTokenRing::add( FoodPatches[0], 150, 2000, 400 )` lowered to `( 2, 20, 5 )`: the ring switches patch 35 times through all three branches (12 maxPopulation + delay-window, 12 delayEnd `findActive()`/`onActivatePatch` kills — alive 181 → 139 at step 7 — and 11 timeout/immediate). Both directions are measured, arbitrated by the native farm log: the recorded per-step inputs reproduce all 300 steps × 9 properties, while the old default (input 0 for every patch) diverges at **step 2** (`FoodPatches[0].On`: interpreter `True`, native `False`, 222/300 steps). The phase is measured, not fitted: `stepShift` -1 is exact, 0 diverges at step 26 and +1 at step 25 (`FoodPatches[1].On`) — the counts accumulate at the END of a step (`DeathAndStats`, after the agents move) while `CppProperties::update()` runs at the START of one (`Simulation.cc:648`). The 7th (`gene_dyn`) is the `$[gene,…]` class *registered in the verifier*: the added form is on `MinEnergyFractionToOffspring`, whose schema `cppsym` is the gene read, so the property's storage **is** `MateEnergyFraction.min` (`metadata[8].value = &(…->smin.__val)`) and the port serves it from L5's genome layer through a `genesFromGenerange` block whose values are parsed out of the recorded run's own `run/genome/meta/generange.txt` (`FLOAT 0.500000 / 0.800000`) rather than typed; its 300 farm lines replay exactly, the control with the oracle range (0.2) diverges on all 300, and the emitted C++ is byte-identical to the recording **including** the `./etc/worldfile.wfs:1619: Cannot find gene …` location (`Property::getLocation().getDescription()`, ported: the schema *document's own name* via `extract_cppprops.py --schema-name`, plus the line of the schema's `cppsym` property - the node native calls `propSym`). Unportable bodies (engine calls) are classified with the offending symbol named and served by `bindings/**` (the proplib `FoodPatchTokenRing` port) instead of being silently stubbed |

## Deviations (deliberate, reviewed)

| Where | Source behavior | Port behavior | Why |
|---|---|---|---|
| L16 vision raster | fixed-function GL, per-agent `glReadPixels`, ~64 % of wall in readback at 192 agents | a node-side window-space rasterizer for the parity path (`vision/povRaster.ts`) + a batched WebGL2 atlas for the browser (`vision/raster.ts`); the retina *bytes* are reproduced, not sampled | **native's *model* artifacts are reproducible run-to-run** — every `genome/**`, `brain/**`, `energy/**`, `motion/**`, `lifespans.txt`, `BirthsDeaths.log` is byte-identical across runs — so byte-exactness is a legitimate target, with **one measured exception that is native's own scheduling, not the port's**: `run/energy/agents/max.txt` (`Logs::AgentMaxEnergyLog`, `Logs.cc:250-283`: one row per `AgentGrownEvent`) is written in *thread-completion* order. The recorded `normalized.wf` sets `ParallelInitAgents True` (`:369`), so `Simulation.cc:410` runs `InitAgents()` non-serially, every `c->grow()` is posted to the scheduler's pool (`Simulation.cc:875-880`, under `!!! POST PARALLEL !!!`; `Scheduler.cc:14-62`, `ncores - 1` helpers), and `agent.cc:758`'s `AgentGrownEvent` is appended by whichever helper thread gets there first (`Logs::postEvent` calls `processEvent` on the *calling* thread, `Logs.h:55-68`). The row *set* is deterministic; two adjacent `AgentGrown` rows swap between native runs — measured 2026-09-28: `--selfcheck minitest_von` FAILs `differing=1 DIFFERS run/energy/agents/max.txt` on 3 of 4 runs (98 lines vs 98 lines, identical row multiset, agents 55 and 56 exchanged). `run/movie.pmv` is **never** part of that count: every tier *ignores* it, and an ignored file is reported `IGNORED`, never as `differing` — so a `match 1307/1308 … ignored=1` verdict is the ignore firing, not the movie differing, and the movie can never be the name printed after `DIFFERS`. Reproducible *through the port*: `minitest_von` **PASS 1308/1308**, `microtest_von` 225/225 — the port writes `max.txt` in submission order, which is the golden's order. The retina pixels are a debugging aid, the fed neurons are the contract — but on the vision-on scenarios the pixels are now a checked witness too (the 7315-row native dump) |
| W1f parity harness | `record_oracle.py` deleted the previous `oracle/<scenario>/` on re-record; scenarios lived only in the base registry | re-record displaces the old golden to `oracle/_native_previous/<scenario>.previous.<epoch>`; lane scenarios live in `tools/scenarios.d/*.json` overlays | a re-record must not destroy the only known-good artifact; 10–20 lanes cannot share one editable JSON file |
| W1f movie compare — every tier (amended by t_588c28e1) | the manifest compares every hashed file, `movie.pmv` included (and the base registry compares it for the vision-off scenarios too) | **every** tier defaults to `ignore: ["run/movie.pmv"]`; an ignored difference is reported as `IGNORED` with a count, never hidden; the file is still hashed into the manifest at record time | `PORT_SPEC.md` → *Frozen surface* declares the movie free, not frozen. Measured 2026-09-28: the movie differs between two native runs of the *same* scenario on *this* machine (three `minitest_voff` selfchecks → two distinct movies, one of them the golden), so it cannot be part of a byte-exact number at any tier. This supersedes the earlier tier-B-only row (narrower cause: "vision on") — the irreproducibility is the unpinned sampling path, not the retina |
| W1f `--selfcheck` — `run/energy/agents/max.txt` (t_934a16d3) | the selfcheck's premise is "native reproduces itself, so a difference is mine" | a FAIL whose **only** differing file is `run/energy/agents/max.txt` is native's parallel-init row order (row above), not a candidate defect — **sort both sides and compare the row *multiset*** (the same `AgentGrown` rows in both: 83 for `minitest_von`, 87 for `minitest_voff`) before reading anything into it | measured 2026-09-28 on the pristine build, with **no candidate in the loop**: 4 `minitest_von` selfchecks → **3 FAIL** (`differing=1 DIFFERS run/energy/agents/max.txt`, row multiset identical, two adjacent rows swapped) + 1 PASS; 6 `minitest_voff` selfchecks → **1 FAIL on the same file** + 5 PASS (so it is not a vision-on-only effect — the worldfile, not the retina, is what makes it possible); 3 `microtest_von` selfchecks → 3 PASS with the file identical (25 initial `AgentGrown` rows — not sighted there, but 3 runs is a small sample). Re-run native to reproduce the disagreement, and compare the *sorted* rows before believing a diff in this file |
| L4 expression language | the native evaluator is a real `python3` child: full Python 3 `eval` | the port implements a documented *subset* (operators, chained comparisons, conditional expression, subscripts/slices, container literals, 22 builtins) and **refuses** the rest (`lambda`, comprehensions, f-strings, `bytes`, complex literals, `%`-formatting, walrus, attribute access) with `PythonError('port: …')` | a browser cannot fork `python3`; refusing loudly is the only alternative to evaluating something native would not have produced (rule 1). No worldfile expression reaches the refused grammar — measured by recording every Python text the port's code generation produces while building the four scenarios (121 texts) and running the real interpreter on them |
| L4 float `repr` | CPython's `PyOS_double_to_string( format "r" )` | the shortest round-tripping digits come from ECMAScript's `toExponential()`, then CPython's positions/thresholds are applied | no CPython algorithm to transcribe; the digits are shortest-round-trip in both, and the 20+ recorded float vectors (`0.1`, `1e16`, `1e-5`, `1e309`, `-0.0`, `round(2.675,2)`, …) pin the result |
| L4 `is`/`is not` | identity, with CPython's interning of small ints and short strings | identity for `None`/`bool`, reference equality otherwise (so `1 is 1` is `False`) | the port's values are immutable objects; emulating interning would invent behavior nothing observes (no worldfile expression uses `is`). Recorded in the lane's Gaps table |
| W1c gzip backend | `gzopen`/`gzwrite` with `AbstractFile::flush(full)` → `gzflush( Z_SYNC_FLUSH )` mid-file | the port accumulates the uncompressed bytes and deflates once at `close()`; `flush` is a no-op on the gzip sink | the browser target has no `node:zlib` (there the sink is a `CompressionStream('gzip')` or a `Blob`), and a mid-file `Z_SYNC_FLUSH` only changes the *container* bytes, never the content. Verified byte-identical to `gzopen` when nothing flushes mid-file (which is how datalib logs are written — `DataLibWriter` uses `FILE *` and never compresses) — 2026-09-28, t_091ec5b8: that reference was local libz 1.2.12; the *node* sink deflates through `node:zlib`, whose bundled zlib is Google's patched fork and writes a different stream for the same content (unless the binary links upstream zlib — a node linked against 1.2.12 writes the golden container back, t_16ac7810). See the gzip-container row below and `docs/specs/gzip-containers.md` |
| W1c node file adapters | `AbstractFile` is one object switching on `ConcreteFileType` | `ByteSink` (portable) + `nodeFile.ts` (node:fs / node:zlib), and `nodeFile` is deliberately not re-exported from `src/model/datalib/index.ts` | keeping `node:fs`/`node:zlib` out of the module graph is what lets the browser bundle import the writer/reader at all; the seam is the sink, not the format |
| W1f gzip container compare (t_091ec5b8) | every manifested file is compared by sha256, gzip container included | the registry's `content_compare` rule (`tools/scenarios.d/content-compare.json`: every `.gz` below `run/`) compared the **decompressed payload** byte-for-byte and counted/printed every container that differs — **reverted 2026-09-29 (t_9c9fa3de):** that file now ships an **empty** rule list, so every `.gz` below `run/` is byte-compared by its container like every other manifested file. The mechanism survives for a future case (a rule makes the payload the contract, `--content-compare <glob>` re-selects a path for one check, `--no-content-compare` forces strict bytes); nothing ships using it | measured 2026-09-28 (`docs/specs/gzip-containers.md`): the `.gz` goldens are **upstream**-zlib level-6 deflate — apple libz 1.2.12, vanilla zlib 1.2.12 and vanilla zlib 1.3.1 each reproduce **all 1317** recorded containers byte-for-byte (150 `microtest_voff` + 1167 `minitest_voff`) — while the gzip implementations the port could then use speak Google's patched "motley" fork — a property of the **zlib the binary links against**, not of node, so the counts are per-engine. node 22.22.2 (`1.3.1-e00f703`) and nvm v24.21.0 (`1.3.2.1-motley-8002e91`): 25/150 and 25/1167; `/opt/homebrew/opt/node@24` v24.16.0, linked against upstream `1.2.12`: **150/150** and **1167/1167** (measured 2026-09-29, t_16ac7810/t_ceaf2128); Chrome 153 `CompressionStream`: 26/190. The container is the compression library's fingerprint, not the model's output. Amends `PORT_SPEC.md` → *Frozen surface*; the durable byte-exact fix was lane card `t_431ed2f0`, which landed (2026-09-28) and made this amendment unnecessary — it was reverted with the one registry file it promised (`t_9c9fa3de`, 2026-09-29) |
| W1c/L12 gzip container writer (t_431ed2f0) | native writes `.gz` through `gzopen`/`gzwrite` (upstream zlib); the node sinks wrote through `node:zlib`'s `gzipSync`, whose **bundled** zlib is Google's "motley" fork and cannot reproduce the goldens (a node linked against upstream zlib 1.2.12 can — 150/150, t_16ac7810) | the node sinks write through the transcribed upstream-zlib deflate in `src/model/compress/zlibDeflate.ts` (no new dependency, browser-safe); `gunzipSync` still reads (inflate is version-stable) | restores **container** byte-exactness: 2581/2581 recorded `.gz` containers (all five scenarios) rebuild byte-for-byte, so the `content_compare` rule is no longer needed to pass a lane — it was reverted to an empty rule list on 2026-09-29 (`t_9c9fa3de`), which makes every scenario strict by default. The transcription is level 6 / memLevel 8 / windowBits −15 / `Z_DEFAULT_STRATEGY` / single `Z_FINISH` — exactly what `docs/specs/gzip-containers.md` measured upstream 1.2.12 and 1.3.1 to emit |
| Shared toolchain | scaffold pinned `vite ^5.4.0` / `vitest ^2.1.0` | `vite ^8.3.1` / `vitest ^5.0.2` (see *Toolchain* below) | both majors were carrying advisory-listed vulnerabilities; `vitest.config.ts` needed **no** change (verified, not assumed) |
| W1b DOM error text | one error channel, `DocumentLocation::err` → `<path>:<lineno>: ERROR! <msg>` | the *frozen* `PropertyNode` surface (`get`/`elements`/`scalarText`) throws `ConfigError` mentioning the **property name**; the front end's own errors (parse, validation, conversion) keep the native `<path>:<lineno>` text | W1a froze the read-path failure shape and `memoryDocument.ts` implements it; if the real document differed, every lane test written against the double would stop meaning anything. Both shapes are native-faithful — native's other channel is `editor.cc`'s message-only `err()` |
| W1b validation pass is opt-in | `SchemaDocument::apply` always validates | `apply( doc, { validate } )`, and the `emitNormalizedWorldfile` facade passes `validate: false` unless asked | `validate` evaluates values, and a real evaluator is lane L4; the pass is **read-only** (it never mutates the document), so the emitted bytes are identical either way — the flag only suppresses checks the port cannot yet run, and `converted.wf` is written before `apply()` at all. Native behavior is the default for `apply` itself |
| W1h run-time code generation | `CppProperties::init()` writes `run/.cppprops/generated.cc`, shells out to `make`+`clang++` (~6 s) and `dlopen`s the result | the generated code is emitted at **build** time by `extract_cppprops.py`; the browser side is `cppprops.json` + `lib/cppprops.mjs`, and `run/.cppprops` disappears | a browser cannot compile C++ or `dlopen`; PORT_PLAN.md's measured startup cost (`~6 s fixed, worldfile conversion + clang`) is exactly this step. The emitted C++ is still produced (and byte-compared to a real run's `generated.cc`), so the *spec* is not a hand-written interpretation of the worldfile — it is the same text, reduced to data |
| W1h dyn-body interpretation | `dyn` bodies are compiled C++ with engine calls | bodies the extractor cannot reduce to the supported C++ subset are marked `portable: false` with the offending symbol named and must be served by a binding; a property with no binding is **reported and refused**, never silently zeroed | the native code is generated from worldfile text and may call straight into the model (`FoodPatchTokenRing::add`, `GenomeUtil::getGene`); pretending to interpret that would produce plausible-but-wrong values. `portable: true` is a claim the fixtures verify |

| L14 signal emit | `util::Signal::operator()` iterates the live `std::list`, so a slot that connects or disconnects *during* an emit is undefined behaviour; handles are list iterators | the port emits over a **snapshot** of the slot list and hands out opaque ids | no native call path connects/disconnects inside an emit (the only disconnect sites are `SceneMovieController::step` and `AgentTracker::setTarget`, neither reachable from a slot), so the snapshot is a strictly safer superset. Iterator-valued handles cannot be modelled in JS without the same corruption |
| L14 movie big-endian guard | `MovieSettings`' constructor disables recording at **compile time** on a big-endian host (`#if __BIG_ENDIAN__` + a one-shot stderr warning) | the guard is dropped; the port always honours `Record` | no browser target is big-endian (the guard is a constant-false branch everywhere the port runs), and the branch is dead code in every recorded scenario |
| L14 state-title buffer | `AgentTracker::getStateTitle()` formats into `char buf[128]`, so a long title truncates | the port returns the whole string | it is UI text (never a frozen artifact); truncation would be a lossy, hard-to-see difference, and no recorded path reaches 128 bytes |
| L14 document validation is opt-in | native `SchemaDocument::apply` always runs the validation pass | `loadMonitorDocument` passes `validate: false` by default (W1b's `emitNormalizedWorldfile` precedent) | the assertions need lane L4's expression language (`assert ( Rank != 0 )`, `len(Name) > 0`, `max SampleFrequency`); the pass is **read-only**, so the resolved document — every default, type and coercion — is identical either way. Native behaviour is still the default for `apply` itself, and `validate: true` is one option away |

### Gzipped artifacts: content, not container (t_091ec5b8) — decision, 2026-09-28, amendment reverted 2026-09-29 (t_9c9fa3de)

The card asked for a decision between transcribing zlib's deflate into TS (A),
amending the contract for containers (B) and a node-only sidecar writer (C). The
card's causal story — "goldens are 1.2.12, node's 1.3.1 cannot reproduce them" —
is **wrong, and the correction changes the options**: upstream zlib **1.3.1
reproduces every golden container byte-for-byte**, and apple libz 1.2.12 and
vanilla 1.2.12 agree with it on all 150 `microtest_voff` files. What actually
differs is that node's bundled zlib and Chromium's are **Google's patched
"motley" fork**, which picks different matches and emits a smaller stream for
identical content (the zlib the node binaries measured here link against: 25/150
on the `1.3.1-e00f703` and `1.3.2.1-motley-8002e91` builds, **150/150** on a node
linked against upstream 1.2.12 — the count is a property of the engine, not of
node; Chrome 153 `CompressionStream` 26/190 — measured in a real browser, not
assumed). So the `.gz` container is a property of the
compression library, not of the ported model.

Decision: **B now, A as the durable answer, C rejected** (C is node-only and L20
exports the run tree from the page).

* B is implemented in `tools/check_parity.py` + the registry
  (`tools/scenarios.d/content-compare.json`): the `.gz` payload is the contract,
  every content-compared file is counted and printed, `--no-content-compare`
  restores strict bytes. `PORT_SPEC.md` → *Frozen surface* carried the amendment
  (reverted 2026-09-29 — see the last bullet).
  Evidence on both scenarios (clean copy, node-written containers, strict mode,
  flipped payload, non-gzip container, missing file — six cases × two scenarios)
  is attached to the task and encoded in `tests/parity-runner.test.ts`.
* A is now cheaper than the card thought and no longer a version-archaeology
  exercise: the target is upstream zlib's `deflate_slow` + `trees.c` at level 6 /
  memLevel 8 / windowBits −15 / single shot, the sources are pinned and
  fetchable, and all 1317 recorded containers are a byte-oracle. Filed as lane
  card `t_431ed2f0`.
* **A landed** (t_431ed2f0, 2026-09-28): `src/model/compress/zlibDeflate.ts` is the
  transcription, the two node gzip sinks write through it, and
  `tests/gzip-deflate.test.ts` rebuilds **2581/2581** recorded `.gz` containers
  byte-for-byte (all five scenarios) plus an adversarial payload set, cross-checked
  against the platform zlib. The `content_compare` rule became optional at that point,
  and nothing uses it.
* **B reverted** (t_9c9fa3de, 2026-09-29): with A landed, the amendment bought nothing, so
  `tools/scenarios.d/content-compare.json` ships an **empty**
  `content_compare` rule list — still an overlay file (a document in this directory with
  no `scenarios` key carries registry-level keys), with its history and the reverted-at
  HEAD in its own `_comment`. Every `.gz` under `run/` is compared by container bytes
  again, which is what the shipped port produces. Measured on fresh candidate trees
  (`npx tsx src/model/sim/runner.ts <scenario> <dir>`, then
  `./oracle/run_parity.sh <scenario> --candidate <tree>` with **no flags**): `hello`
  **PASS 19/19**, `microtest_voff` **225/225**, `minitest_voff` **1369/1369**,
  `microtest_von` **225/225**, `minitest_von` **1308/1308**, `minitest_adami`
  **1373/1373** — all six `differing=0 missing=0 extra=0`, exit 0, and no
  `content-compared` line printed (nothing is content-compared). The container count, run
  one-off with `--content-compare 'run/**/*.gz'`: 0, 150, 1167, 150, 1114, 1167 files in
  that order, every one `container byte-identical`, `container differs 0`. `PORT_SPEC.md`
  → *Frozen surface* and the `W1f gzip container compare` row above carry the shipped
  state. The mechanism itself is untouched (registry globs, `--content-compare <glob>`,
  `--no-content-compare`), and `tests/parity-runner.test.ts` now selects the rule
  explicitly where it tests it, plus one new test that pins the strict default.
* Numbers, the browser measurement and the full repro recipe:
  `docs/specs/gzip-containers.md`.

### The movie is not a frozen artifact — decision, 2026-09-28 (t_588c28e1)

`minitest_voff --selfcheck` failed on exactly one file, `run/movie.pmv`, while
every model artifact matched. The card asked whether a tier-A scenario may
compare the movie at all.

Measured first (this machine, three fresh native runs of the **same** scenario,
same binary, right after each other):

| run | `--selfcheck minitest_voff` | `run/movie.pmv` sha256 (first 12) |
|---|---|---|
| a | `match 1369/1369` PASS | `711477856c8c` (== the golden) |
| b | `match 1368/1369` FAIL, only `DIFFERS run/movie.pmv` | `6ec01be5ee62` |
| c | `match 1368/1369` FAIL, only `DIFFERS run/movie.pmv` | `6ec01be5ee62` (== run b) |

`microtest_voff` (1 step) and `hello` (500 steps / 192 agents) selfchecked PASS.

So the movie is nondeterministic **between two native runs on one machine** — not
merely irreproducible across machines. That kills the alternative ("keep the
strict comparison and re-record the golden"): the oracle would flake roughly two
runs in three, and it would be *this* machine's scheduling, not the port, deciding
whether a lane's check is green.

Decision: **`PORT_SPEC.md`'s *Frozen surface* is authoritative — the movie is
never part of a byte-exact number, at any tier.**

* Implemented as a compare-time default: `FREE_ARTIFACTS` /
  `TIER_DEFAULT_IGNORE = {"A": …, "B": …}` in `tools/parity_common.py`, so
  `compare_ignores()` adds `run/movie.pmv` for every tier (tier B already did).
  `tools/add_scenario.py` now records the same default for any tier.
* The file is still written and still hashed into the manifest at record time —
  the movie remains evidence, it is just not a *failure*. The checker prints
  `ignored=N` and `IGNORED (N, not part of the contract): run/movie.pmv`.
* A matching movie is still counted as `matched` (`check_parity.py` classifies
  only missing/differing/extra), so a clean candidate is unchanged:
  `match 1369/1369 … ignored=0`. A **perturbed/absent** movie moves from a failure
  to `ignored` — no previously-failing *model* artifact is masked by this.
* `no_default_ignore: true` still lets a future encoder lane opt into the strict
  comparison (`t_431ed2f0` is about containers, not the movie; the encoder's byte
  fidelity was never a lane acceptance — PORT_SPEC's Tier C note).
* After: `--selfcheck minitest_voff` → `match 1368/1369 differing=0 missing=0
  extra=0 ignored=1` / `parity: PASS (1369/1369 files)`, exit 0; repeated twice
  more (one run with the golden's own movie, one without) — both PASS.
* `oracle/**` was not touched; nothing was re-recorded. No `--record` ran.
* Blast radius: the lane tests that assert numbers still hold —
  `tests/parity-runner.test.ts` (`matched === 225` on a clean copy is unaffected
  because a matching file is counted as matched) and `tests/monitor.test.ts`'s
  `match \d+/\d+ … differing=0` regex are wildcards, not `1369/1369` literals;
  `tests/logs-replay.test.ts` / `tests/logsCorpus.ts` already exclude the movie.
  A new assertion in `tests/parity-runner.test.ts` locks the decision: a tier-A
  candidate whose only difference is a flipped `movie.pmv` byte exits 0 and reports
  the movie under `IGNORED`.

## Toolchain (shared dev dependencies) — bumped 2026-09-28

`npm audit` on the scaffold reported 5 advisories in the dev toolchain (3 moderate,
1 high, 1 critical): `vitest` / `@vitest/mocker` (path traversal via redirect mock,
GHSA-82fw-gwwq-j7x9), `esbuild` (dev-server request proxy, GHSA-67mh-4wv8-2f99) reached
through `vite`, and `vite-node`. The tree now resolves `vite 8.3.1` + `vitest 5.0.2` and
`npm audit` reports **found 0 vulnerabilities** (exit 0).

The pair was **measured, not guessed**. Candidate pairs were resolved lockfile-only in
isolated directories before touching the shared tree:

| Candidate | Resolves to | `npm audit` |
|---|---|---|
| `vite ^6` + `vitest ^3` | vite 6.4.3, vitest 3.2.7 | **2 moderate** still open |
| `vite ^7` + `vitest ^3` | vite 7.3.6, vitest 3.2.7 | **2 moderate** still open |
| `vite ^8` + `vitest ^5` | vite 8.3.1, vitest 5.0.2 | **0** ✅ |

The card's initially proposed `vite 7 + vitest 3` does **not** clear the audit: the
`@vitest/mocker` advisory range in this registry is `2.1.0 – 4.1.10`, so *any* vitest
below 5 leaves the critical open even with vite 7. Only the current majors clear it, so
the current majors are what landed.

Regression check (no hand-waving): one frozen source snapshot was copied to two isolated
trees, one pinned to the old `vite ^5.4.0`/`vitest ^2.1.0` and one to the new pair, and
both gate sets were run. Results were **identical** — same 5 `tsc` errors (all in
`src/model/proplib/builder.ts`, lane W1b mid-flight) and the same 14 failing vitest tests
(all in `tests/datalib.test.ts`, lane W1c mid-flight), `npm run build` exit 0 in both.
Those two files were being written *during* this run (`tests/datalib.test.ts` 14:43:34,
`src/model/datalib/nodeFile.ts` 14:43:39); they are lane-in-flight state, not toolchain
fallout.

**Final state on the settled tree (all six gates green):** `npm audit` → 0 vulnerabilities
(exit 0); `npm ls --depth=0` → clean, no unmet deps; `npm run typecheck` → exit 0, no
errors; `npm test` → **70 passed / 70, 7 files** (that snapshot's own count — the suite has grown
since: **48 files / 729 passed | 1 skipped** on `b2bbcaf`, 2026-09-29), exit 0; `npm run build` →
exit 0;
`oracle/run_parity.sh microtest_voff --candidate oracle/microtest_voff/run` → **225/225,
exit 0**. The lanes' in-flight errors cleared on their own as W1b and W1c landed.

Also re-verified the dev server against *both* toolchains on the identical snapshot, driven
by the same CDP harness: `vite 5.4.21` and `vite 8.3.1` produced the same pause-frozen
counter (162/162), the same step delta, the same 30 steps/s at 1x and 120 at 4x, and 0
console errors/warnings/failed requests each — so the flow W1g's PARITY row records is
unchanged by the bump. (W1g's row says "step +1"; the harness actually clicks **Step**
twice and reports the raw delta, so `+2` is 2 clicks × 1 step — a harness reporting
detail, identical under both toolchains, not a behaviour change.)

Two measured toolchain differences worth knowing, neither of which this repo depends on:

* `vitest 5` **removed the `basic` reporter** (`--reporter=basic` is now a startup error).
  Nothing in this repo passes a reporter — `npm test` is plain `vitest run` — so no file
  changed. A lane that added `--reporter=basic` to a local command would need `default`.
* `vite 8` replaced Rollup + esbuild with **Rolldown** (`node_modules/rolldown`,
  `@rolldown/*`); `esbuild` and `vite-node` are no longer in the tree at all, which is why
  those advisories disappear rather than get patched. The build warning now points at
  `build.rolldownOptions.output.codeSplitting`.

`vitest.config.ts` is unchanged: `environment: 'node'` and the
`['tests/**/*.test.ts', 'src/**/*.test.ts']` include globs behave identically — both arms
collected the same 7 test files. Build output moved 515.65 kB → 525.10 kB
(131.35 → 132.78 kB gzip) under Rolldown; the >500 kB single-chunk notice is unchanged and
informational.

Dev server re-verified under `vite 8` with the real headless-Chrome CDP harness: serves
`index.html` and transforms `src/browser/main.ts` (both HTTP 200), WebGL2 via
ANGLE/Metal, 60 fps, 30 steps/s at 1x / 120 at 4x, pause freezes, orbit + reset reproduce
W1g's recorded camera position `[95.97, 74.01, 126.01]` exactly, and **0 console errors,
0 warnings, 0 failed requests**. Exposure unchanged: vite still binds `localhost` only
(`Network: use --host to expose`), and nothing in this repo runs `vitest --ui`.

## PORT-NOTEs (W1d exact PRNGs)

`src/model/rng/**` — the determinism backbone. Acceptance: **`../polyworld/bin/rancheck`
reproduced byte-for-byte** (`diff` against the live binary: identical, all four columns), the
captured `log()` corpora (~203k native samples) matched bit-for-bit, every stream's seed
vectors matched; `tests/rng.test.ts` **42/42**, `npx tsc --noEmit` clean, `npm run build` ✅.
Extraction and regeneration live in `src/model/rng/native/` (README + probes + generators).

Review round 1 (fullstack-dev-2) found one defect — `Mt19937.gaussian` drew the polar
components with `gsl_rng_uniform` where the shipped GSL draws them with `gsl_rng_uniform_pos`
— fixed here: see PORT-NOTE `W1d/gaussian-polar-uses-uniform-pos`, pinned by the
`GSL_FIXED_A/B` + `GSL_INJECT_1/7` sections from `native/raw/gsl_polar_probe.c`.

| PORT-NOTE | File | Decision |
|---|---|---|
| `W1d/rand-is-not-random` | `rand.ts` | The oracle's `rand()` is Apple Libc's Park–Miller (`16807*x mod 2^31-1`, seed 0 → 123459876) while `random()` is the TYPE_3 additive feedback — two *different* streams, printed as separate columns by `bin/rancheck`. `src/model/types/rng.ts` (W1a) calls `rand()` "glibc rand() (TYPE_3 …)"; on glibc `rand()` is indeed an alias of `random()`, but implementing that alias would move every frozen artifact that calls `rand()` (`graphics/gobject.cc`, `complexity/complexity_motion.cc`, `sim/Simulation.cc`'s `srand(1)`). The port follows the oracle — open question 7 |
| `W1d/drand48-limb-lcg` | `drand48.ts` | `(0x5DEECE66D*X + 0xB) mod 2^48` is formed from three 16-bit limbs with explicit carries: the product needs 83 bits, and a double (or a 32-bit `imul` trick) silently drops the low bits that decide the next state. Verified over 20,000 draws against a BigInt reference |
| `W1d/good-rand-is-int32` | `rand.ts` | `good_rand(int32_t)` takes the state word *signed*, so `/` and `%` truncate toward zero; a `Math.floor` port diverges once the top bit is set (e.g. `srandom(0xffffffff)`) |
| `W1d/gsl-mt19937-mapping` | `mt19937.ts` | `gsl_rng_uniform` is `mt_get()/2^32` (not 2^32−1); `uniform_pos` is GSL's rejection loop; `gsl_ran_ugaussian` is GSL's **polar** normal returning the `y` component (one value per call, no spare), with both components drawn through `gsl_rng_uniform_pos` (see the next row); seed 0 becomes GSL's default seed 4357 |
| `W1d/gaussian-polar-uses-uniform-pos` | `mt19937.ts`, `native/raw/gsl_polar_probe.c` | GSL's `gauss.c` draws the polar components with `gsl_rng_uniform_pos`, so a raw draw of exactly 0 is **rejected and redrawn**, not folded in as `-1`. On ordinary vectors the two readings are indistinguishable (an MT19937 output is 0 with probability 2^-32) but they consume a different number of draws, so a `uniform` port desynchronises the LOCAL stream from the first real zero on. Pinned by driving the *shipped* `/opt/homebrew/opt/gsl/lib/libgsl.28.dylib` (the one the oracle links) with fixed streams: `[0, 0.75, …]` costs **3** draws (uniform would need 4) and `[0.9, 0.1, 0, 0.6, 0.7, …]` costs **5** and returns 1.604712017744792 (uniform: 4 draws, different value); plus zero-injected real MT19937 streams with per-gaussian `outer`/`inner` draw counts. Sections `GSL_FIXED_A/B`, `GSL_INJECT_1/7`, `GSL_NO_INJECT`, `GSL_DIRECT_MT42` |
| `W1d/gaussian-is-fma-contracted` | `mt19937.ts` | GSL's source says `r2 = x*x + y*y`, but the build the oracle links contracted it to `fma(x, x, y*y)` — 1 ulp different, and the captured 5th gaussian from seed 42 only reproduces with the contracted form |
| `W1d/nrand-spare-draws` | `nrand.ts` | `nrand()` keeps a *static* spare: one call returns `c*u` after drawing a pair, the next returns `c*v` **without drawing**. The draw count per call alternates 2/0, so re-deriving the normal changes every downstream draw (pinned by the draw-count probe) |
| `W1d/nrand-is-fma-contracted` | `nrand.ts` | Same contraction story: `s = u*u + v*v` ships as `fma(u, u, v*v)`; the plain sum misses ~1 in 10 of the captured values by 1 ulp |
| `W1d/log-is-transcribed-not-approximated` | `libm.ts`, `native/` | Measured: `Math.log` ~4.6 % off native, fdlibm `e_log.c` ~5.7 %, Arm optimized-routines ~0.1 % (12 variants tried), a correctly rounded `log` still 0.06 % — so the oracle's `log` was transcribed from its disassembly plus its extracted data tables (129 intervals, `invc`, a two-part `log(c)`, a factored `r^2(c0+c1r)(c2+c3r+r^2)(c4+c5r+r^2)` and `k = floor(log2 x)+1`) |
| `W1d/log-is-platform-specific` | `libm.ts` | The transcription is *this* machine's libSystem (macOS 26.5.2, arm64). A golden recorded on another libc/CPU could differ by an ulp; the port follows the machine the goldens came from — the same rule `rand`/`drand48` follow |
| `W1d/libm-fma-emulation` | `libm.ts` | JS has no `fma` and the transcribed fused steps are load bearing, so `fma()` emulates it (Dekker two-product + Knuth two-sum): 0 mismatches against the hardware `fma` over 2,000,000 triples in the algorithm's ranges |
| `W1d-fu/exp-is-transcribed-not-approximated` | `libm.ts`, `appleExpTable.ts`, `native/` | the oracle's `exp` is **not** correctly rounded either (8,255/8,261 corpus values), so it is a transcription too: `n = floor(x·(128/ln2))`, a two-part reduction, a 128-entry `{2^(j/128), low}` table extracted from the running libSystem (`native/gen_exp_table.py` → `appleExpTable.ts`) and a factored polynomial. The C transcription (`native/raw/apple_exp_impl.h`) is bit-exact on the corpus and on a 320,121-value sweep *before* the port was written; the port matches all 8,261 |
| `W1d-fu/exponent-add-is-an-integer-add` | `libm.ts`, `native/raw/apple_exp_impl.h` | the `2^q` scale is `add d0, d0, d1` on the *double* registers (encoding `0x5ee18400`: the vector-integer ADD the compiler emits when both operands live in FP registers) — it adds `q` to the exponent field of the bit pattern, and in TypeScript that is `hi += q << 20` on the high word. An FP add here would be a different number, and the subnormal branch's `(q + 1022) << 52` is the same trick |
| `W1d-fu/fma-mnemonic-direction` | `native/raw/fmaenc2.c`, `native/raw/apple_exp_impl.h` | `fmsub Dd,Dn,Dm,Da` is `Da - Dn*Dm` and `fnmsub` is `-Dn*Dm + Da`; `exp` uses both mnemonics for the same operation, in the two fused halves of `128/ln2`. Settled by compiling all four spellings and reading the encodings back (the committed probe), and the port writes explicit `fma()` calls so it never depends on the mnemonics |
| `W1d-fu/libm-census` | `native/raw/{libm_census.c,gen_libm_corpus.py,census_libm.py}` | the census is a committed, re-runnable chain: the *shipped* libSystem functions over generated corpora (both dispatch thresholds and their ulp neighbours, per-octave sweeps, the model's own argument ranges, ±0/±inf/NaN/overflow/subnormal) against a correctly rounded Python `decimal` reference (cross-checked at +40 digits) and V8's `Math.*`; `raw/libm_census.out` is the summary. `sin`/`cos` were measured here and are now transcribed (`sin` 4,858/5,055, `cos` 4,860/5,055); `pow` was measured here too (4,373/4,471 correctly rounded, V8 4,084) and is now transcribed as well — `W1d-fu/pow-is-transcribed-not-approximated`; and the census' sixth function, the *float* overload `powf`, has its own 7,325-argument-pair corpus (`libm_args_powf.txt` / `libm_native_powf.txt`, built from the model's own arguments, a float lattice and the special-case ladder by `raw/gen_libm_powf_corpus.py`) where V8's `Math.pow` matches the shipped `powf` on 7,129 (97.32 %) and the double `pow` narrowed to float32 on 7,288 — i.e. neither is a substitute — and it is transcribed too — `W1d-fu/powf-is-transcribed-not-approximated` |
| `W1d-fu/sin-cos-are-transcribed-not-approximated` | `libm.ts`, `appleSinCosTable.ts`, `native/raw/apple_sincos_impl.h` | the oracle's `sin`/`cos` are on the frozen motion path and are **not** correctly rounded (96.10 % / 96.14 % over 5,055 corpus values each), so both are transcribed from the shipped machine code (`native/raw/dump_libm2.c` → `raw/sincos_bytes.bin`, tables extracted by `native/gen_sincos_table.py`, which checks the 1/π table against an independently computed expansion). The C transcription is **bit-exact on all 5,055 + 5,055 corpus values** (`diff` against `raw/libm_native_{sin,cos}.txt`, including both dispatch boundaries and their ulp neighbours, ±inf/NaN, 1e17 and 1e300) and the port matches every one of them; V8 disagrees on 217 + 210 |
| `W1d-fu/payne-hanek-undoes-its-own-normalisation` | `libm.ts`, `native/raw/apple_sincos_impl.h` | the Payne-Hanek path masks the top three quadrant bits off the 1/π product and normalises with `clz`, and the continuations then **undo the factor 2^clz by subtracting `clz << 52` from the converted double's bit pattern** — an integer `sub` on a double register (`0x7ef08400`), i.e. an exact division by a power of two (`2*clz` in the cos continuation, whose value is squared). Without it the argument is 2^clz too large: the port is off on *every* Payne-Hanek value, not a few |
| `W1d-fu/one-over-pi-table-is-little-endian` | `native/gen_sincos_table.py` | the table the backwards walk reads is **1/π** (not 2/π), stored with the most significant 64-bit chunk at the *highest* address; the four-word window is a little-endian 256-bit slice, `floor(1/pi * 2^(64*(k+3)))`. Reading the words in address order as big-endian is 64 bits off and only the generator's 1/π check catches it |
| `W1d-fu/float-overloads-are-transcribed` | `libm.ts`, `appleSinfTable.ts`, `native/{gen_sinf_table.py,raw/apple_sinf_impl.h,raw/dump_libm3.c}` | the C++ `float` overloads are transcribed like the doubles, from their own machine code (`raw/dump_libm3.c` → `raw/sinf_bytes.bin`; `sinf` at `+0x400`, `cosf` at `+0x2f0`, `__sincosf_stret` at `+0x5ac` of the same unit). The reduction is **per-exponent**: the table holds `1/pi - A/2^s` with `s = 2i-23` and `A = round(2^s/pi)` (a *dyadic ghost* of 1/pi whose denominator divides any float32 of the entry's exponent, so `x*(hi+lo)` differs from `x/pi` by an exact integer and `rint()` yields x/pi's own quadrant) — multiplying by the plain `1/pi` destroys the reduction. The medium path has **no Payne-Hanek at all** (one-part pi/2, one fused step) and the cos index is `n+1`, never a `+pi/2`. The C transcription is **bit-exact on all 5,016 + 5,016 corpus values** and on a 105,119-argument wide sweep per function (`raw/wide_sinf_sweep.py`, which also covers `|x| > 2^63`, where the quadrant's integer conversion *saturates*); the port matches all of them, and the residual disagreement with the doubled transcriptions (`Math.fround( Math.sin/cos )`, and this lane's own ported `sin`/`cos` narrowed the same way) is the measured 304 + 135 — i.e. **0 residual for the float transcriptions** |
| `W1d-fu/camera-calls-sincosf-not-sinf-cosf` | `libm.ts#sincosf`, `native/raw/{sincosf_census.c,apple_sinf_impl.h}`, `src/model/monitor/cameraController.ts` | the native camera does **not** call `sinf`/`cosf` as a pair: `CameraController::setRotationAngle( float )` has adjacent `sin(camrad)`/`cos(camrad)` calls and LLVM's sincos combine merges them, so the shipped `libpolyworld.dylib` contains `bl ___sincosf_stret` (read off the symbol stub) — the two-output entry at `sinf + 0x1ac`, a **different algorithm** (doubled argument against the same per-exponent table, no `+0.5`, no pi/2 subtraction at all, both lanes in one 2-vector pass). Its results differ from the scalar pair on 305 (sin) + 133 (cos) of the 5,016 float32 corpus arguments, and the recorded camera frames pin it: `camera.json` `rotate[3]` frame 3 is `1123315328` = `__sincosf_stret`'s cosine, while `cosf` gives one ulp less and lands on `1123315326`. The two-output function is transcribed (`libm.ts#sincosf`, corpus `raw/libm_native_sincosf.txt` captured through `dlsym`), bit-exact on the whole corpus and on the wide sweep, and L14's 117 frames stay exact |
| `W1d-fu/pow-is-transcribed-not-approximated` | `libm.ts`, `applePowTable.ts`, `native/gen_pow_table.py`, `native/raw/apple_pow_impl.h` | the oracle's `pow` is not correctly rounded either (4,373/4,471 = 97.81 %; V8 4,084 = 91.3 %), so it is transcribed like `log`/`exp`/`sin`/`cos` — except that `pow` calls none of them: it inlines its own log2 (a 129-entry table) and its own exp2 (a 128-entry table), both reached ~170 kB from its code by `adrp`+`add`. The C transcription (`raw/apple_pow_impl.h`, driver `raw/pow_cand.c`) is **bit-exact on all 4,471 corpus values** (`diff` against `raw/libm_native_pow.txt`) *and* on a **189,368-pair wide sweep** (`raw/wide_pow_sweep.py`: the two dispatch guards with their ulp neighbours, the whole ladder, both over/underflow thresholds, uniform samples and raw bit patterns), and the port matches both. The fast/slow split is easy to misread: the fast path is a positive normal `x` with a `y` in [2^-65, 2^64) only (the second guard is an unsigned subtract, so *every* negative `y` takes the ladder), and the signed `y` then drives the exponent arithmetic directly. Cost, measured: the port's `pow` is ~1.2 us/call (~20x `Math.pow`) because the exponent assembly is BigInt arithmetic — irrelevant at the recorded scenarios' call counts (three unreachable genome sites and `Distribution U`), but a lane that switches a per-agent-per-step site over should know |
| `W1d-fu/pow-log-table-is-packed-half-words` | `native/gen_pow_table.py`, `native/raw/apple_pow_impl.h` | the log table's 16-byte entries are **not** two little-endian doubles: the first 8 bytes are two 32-bit halves packed `{high word of invc, high word of logc_lo}` (read with `ldr s2` + `shl.2d v2,v2,#32` and `and 0xffffffff00000000`), and the low halves are zero by construction. `invc` is only a *coarse* hand-chosen reciprocal — within 2.4e-4 of `1/(1+i/128)`, which is all the reduction needs (|r| < 1/256 + slack) — and the accuracy lives in `logc_hi + logc_lo`, which the generator checks to be the **exact** `-log2(invc)` (4.5e-26 over all 128 entries), minus 1 for the index ≥ 64 rows (the `k = floor(log2 x) + 1` convention). Dropping the logc_lo column moves 108 of the 4,471 corpus values; reading the entry as a little-endian double gets the reduction constant 23 grid steps wrong |
| `W1d-fu/powf-is-transcribed-not-approximated` | `libm.ts`, `applePowfTable.ts`, `native/gen_powf_table.py`, `native/raw/apple_powf_impl.h` | the C++ **`float`** overload the model's two `_powf` sites call (`distributions.cc:41`'s `pow( e, rightTop/rightBottom )` and `Genome.cc:502`'s `pow( fabs(cosa), MISC_INVIS_SLOPE )`). `pow` is *not* a substitute: on those sites' own argument domains the double transcription and V8's `Math.pow` are bit-identical to each other on all 797,034 pairs and each disagrees with the shipped `powf` on 0.13-0.90 % of them (and on the 7,325-row corpus: 37 for the double `pow`, 196 for V8), so the float overload was transcribed from its own machine code. Same shape as `pow` — an inlined log reduction with a table and an inlined exp, in double until one `fcvt` at the end — but everything is **128-scaled**: `L = k + logc[i] + 128*log2(z*invc[i])` is exactly `128*log2(x)` (nothing cancels, because `logc[i]` *is* `-128*log2(invc[i])`), and the exp table's entries are `bits(2^(j/128)) - (j << 45)`, which is what makes the single `+ (n << 45)` pattern add exact. Three traps: the `fnmsub` is `z*invc - 1` (LLVM's operand order — reading it as `1 - z*invc` moves rows), the sign for a negative base with an odd integer exponent is an `eor.8b` on the *result pattern* after the narrowing (never an FP sign flip), and every `|y| >= 2^24` counts as an *even* integer because the parity test clamps `|y|` to 2^24 first. The C transcription is bit-exact on the whole corpus and on a 175,000-pair wide sweep (`raw/wide_powf_sweep.py`); the port matches both, and `tests/rng.test.ts` pins it. Cost: **0.16 us/call vs `Math.pow`'s 0.05**, i.e. 3x rather than `pow`'s 26x — no BigInt exponent assembly (`npx tsx tools/measure_powf_cost.ts`) |
| `W1d-fu/pow-exponent-assembly-is-pattern-arithmetic` | `libm.ts`, `native/raw/apple_pow_impl.h` | the exp2 half builds `2^(n/128)` out of **bit patterns**, not floats: `2^(n>>8)` is the bare exponent field `(n<<44) & 0xfff0000000000000`, the table entry's pattern is then **integer-added** to it (`add d0, d0, d2`, encoding `0x5ee28400` — the same vector-integer add `exp` uses, and the add is what supplies the +1023 bias), and the trailing factor is `((n<<45)&mask) - ((n<<44)&mask)` added to 1.0's pattern — the two-shift split that keeps the exponent field in range for the whole `n` domain, including negative `n`. A negative base's odd-integer sign is XORed into the first of those patterns, so it rides through both multiplies with no FP operation at all, and the shipped code clears loghi's last mantissa bit before the hi/lo split (28 corpus values move if that `and 0xfffffffffffffffe` is dropped). Swapping the integer add for an FP multiply moves 4,262 of the 4,471 |
| `W1d-fu/math-pow-is-engine-version-dependent` | `libm.ts`, `tests/rng.test.ts`, `tools/measure_powf.ts` | how far the transcribed `pow`/`powf` sit from V8's `Math.pow` is the **engine's** number, not the port's, and V8 changed it: over the committed corpora (macOS 26.5.2 arm64) `Math.pow` disagrees with the recorded oracle on **387 of 4,471 (`pow`) / 196 of 7,325 (`powf`)** rows under **V8 12.4** (node 22.22.2 — what an agent session gets) and on **9 / 42** under **V8 13.6 and 14.6** (node 24.21.0 / 26.7.0 — what a login shell resolves to, nvm `default -> 24`), while both ports are off on **0 rows under all three**.  `tests/rng.test.ts` therefore asserts the *differential* contract — the oracle bit-for-bit on every recorded row, and the oracle's side (never the engine's) wherever the engine disagrees — and keeps the engine count as a direction only (`> 0`).  The equalities that used to be there (`toBeGreaterThan(300)` for `pow`, `toBe(196)` for `powf`) were claims about V8, and that is what turned the lane red when the shell's node switched 22 -> 24 with no change in the transcription; measured with `npx vitest run` under both nodes, and re-derived per run by the two blocks themselves |
| `W1d/rng-surface-assembly` | `surface.ts`, `index.ts` | Native keeps process-global C state for `rand`/`drand48`/`nrand`; `globalRngSurface()` is the port's equivalent single instance and lanes must not create one per call site (draw *order* across callers is the contract). `RandomNumberGenerator` is a port of `utils/RandomNumberGenerator.{h,cc}` including its Role→Type table |

**Warning for every lane (measured, not theoretical): the oracle's build contracts `a*b + c`
into an FMA.** Two sites in this lane were affected (`nrand`, the GSL gaussian). Any lane whose
C source has a multiply feeding an add — `u*u + v*v`, `x*y + z`, polynomial evaluation, an
expression the compiler can rewrite as a fused step — should assume the contraction happened
in the oracle and check against captured vectors rather than against the C source. The port
must reproduce it rather than "clean it up" (`-ffp-contract=off` on the *oracle's* build would
have removed the difference, but the recorded goldens are what they are).

## PORT-NOTEs (W1f harness)

Every semantic decision in the harness carries an in-code `PORT-NOTE`; the tag and
its file (the harness adds no model behavior, only oracle mechanics):

| PORT-NOTE | File | Decision |
|---|---|---|
| `parity-runner` | `tools/parity_common.py` | shared plumbing: registry merge, run-tree location, lock, displacement |
| `parity-runner/excludes` | `tools/parity_common.py`, `tools/check_parity.py` | two lists: `record_exclude` (never manifested) vs `ignore` (may differ, reported) |
| `parity-runner/step-localized-diff` | `tools/parity_common.py` | report line + step + `#@L` column name for the first divergence |
| `parity-runner/record-isolation` | `tools/record_oracle.py` | displace, never delete, in both places (native `run/`, golden dir) |
| `parity-runner/native-lock` | `tools/record_oracle.py` | fcntl lock on `<native>/.parity-native.lock` serialises native runs |
| `parity-runner/stdout-encoding` | `tools/record_oracle.py` | stdout/stderr decoded latin-1 (byte-preserving); not part of the contract |
| `parity-runner/overlay-registry` | `tools/add_scenario.py` | lane scenarios in `tools/scenarios.d/<name>.json`, one file each |
| `parity-runner/movie-is-free` | `tools/parity_common.py`, `tools/add_scenario.py` | every tier defaults to ignoring `run/movie.pmv` (was tier-B only; PORT_SPEC declares it free) |
| `parity-runner/thin-wrapper` | `oracle/run_parity.sh` | dispatch only; tools keep their own CLIs |
| `parity-runner/selfcheck-staging` | `oracle/run_parity.sh` | `--selfcheck` stages under `oracle/_t_selfcheck_*` and removes only that |
| `parity-runner/oracle-root` | `tools/parity_common.py`, `oracle/run_parity.sh` | goldens location overridable (`POLYWORLD_ORACLE_ROOT` / `oracle_dir`); gitignored goldens do not travel to a lane's worktree |

## PORT-NOTEs (W1g browser shell)

The shell adds no model behavior; these are presentation/structure decisions, listed because
PORT_SPEC rule 6 requires every `PORT-NOTE` to appear here.

| PORT-NOTE | File | Decision |
|---|---|---|
| `W1g/design` | `src/browser/style.css` | no CSS framework, system fonts only, flat surfaces / one accent; zero blocking requests past the bundle |
| `W1g/visuals` | `scene/{palette,ground,agents,sceneRoot}.ts` | colours, ground checker, agent shapes and lighting are invented filler; visuals are outside the frozen surface |
| `W1g/rng` | `sim/presentationRandom.ts` | mulberry32 used **only** for filler motion; the model RNG streams (`rand`/`drand48`/MT19937, lane L1) are untouched and must never be merged with this |
| `W1g/placeholder` | `sim/placeholderWorld.ts` | invented wander motion, zero model behaviour; see Gaps |
| `W1g/loop` | `sim/fixedStep.ts`, `app.ts` | fixed dt accumulator; speed scales simulated time only, so a step boundary exists for anything that samples per step (the "deterministic by construction" requirement) |
| `W1g/perf` | `render/viewport.ts`, `app.ts` | pixel ratio ≤ 2, ResizeObserver sizing, instance-meshed agent field (agent count adds no draw calls), allocation-free frame, HUD refreshed at 5 Hz |
| `W1g/camera`, `L18d/default-view-is-native` | `render/cameraRig.ts`, `scene/palette.ts` | the default view is native's `MainScene` camera (`FieldOfView 90`, near `0.01`, far `1.5·worldsize`, the `Rotate` controller's fixation/radius/height pose — `monitor/CameraController.cc:44-81`, `etc/monitors.mfs`), and `followStep()` keeps it on native's orbit (angle `Rate·step`) until the viewer grabs the rig; `OrbitControls` stays for interaction and `reset()` returns to the native pose |
| `W1g/ui` | `ui/{dom,controlBar,statusPanel,keyboard,hud}.ts` | no UI framework: DOM built in TypeScript, real buttons with `aria-pressed`, one handler per action shared by button and key |
| `W1g/debug` | `main.ts` | always-on read-only `window.__polyworld` handle (diagnostics only) so a headless check can assert the shell is genuinely rendering |

## PORT-NOTEs (L18 browser wiring)

The wiring adds no model behaviour — it *reads* the model's own worldfile. These are the
decisions it had to make to do that; every one is in the code next to the line it describes.
(The W1g shell's presentation PORT-NOTEs are in the section above and still stand.)

| PORT-NOTE | File | Decision |
|---|---|---|
| `L18/scenarios` | `sim/scenarios.ts` | the browser boots the **recorded source files** of a golden scenario (`oracle/<scenario>/run/original.{wf,wfs}`, which native `Simulation.cc:450-451` `cp`s from the worldfile + `./etc/worldfile.wfs`; verified sha256-identical to `../polyworld/worldfiles/tests/low-spec-pc/*.wf`, `../polyworld/worldfiles/hello.wf` and `../polyworld/etc/worldfile.wfs`) |
| `L18/parameters` | `sim/scenarios.ts` | a scenario's native args (`--Vision False`) go through lane W1b's `setParameters` path; the parameter is part of the golden bytes (`*_voff` and `*_von` have different `normalized.wf`) |
| `L18/default-scenario` | `sim/scenarios.ts` | the demo defaults to `minitest_voff` (the recorded scenario with a non-trivial budget — `microtest` records a single step). Usability, not model behaviour |
| `L18/bundled-worldfiles` | `sim/bundledWorlds.ts`, `worldfiles/**` | the browser bundle carries **verbatim copies** of the native inputs (`minitest.wf`, `microtest.wf`, `hello.wf`, `worldfile.wfs`), because the recorded copies under `oracle/<scenario>/run/` are untracked and a lane in a fresh worktree must still `vite build`. `worldBoot.test.ts` byte-compares the copies with the recorded originals so the duplication cannot drift |
| `L18/hello-is-a-literal-world` | `sim/scenarios.ts`, `worldfiles/hello.wf`, `worldBoot.test.ts` | `hello` is a scenario whose worldfile pins **one** key (`MaxSteps 500`, 25 bytes) and takes everything else from the schema's defaults (`WorldSize 100`, `InitAgents 180` / `MinAgents 90` / `MaxAgents 300`, `RecordAll False` / `RecordFrequency 1000`, six `run/stats/stat.*`). It is registered like any other scenario, bundled like any other input (`worldfiles/hello.wf`, sha256 `0c59e47d…`, byte-compared with `oracle/hello/run/original.wf`), and the per-scenario expectations live in `worldBoot.test.ts`'s `WORLD_SHAPE` table rather than in a shared literal — the numbers there were measured through `bootWorld` on the recorded sources |
| `L18/end-phase-is-the-destructor` | `app.ts` | native's end phase is `~TSimulation`, not `End()`: the destructor writes `run/endStep.txt` and appends the `DR_SIMEND` rows to `run/lifespans.txt`. `PolyworldShell.dispose()` disposes the **world** first (the page's sink survives it, so the finished tree can still be exported) and only then tears the renderer down. Found by exporting the page's tree in L20: without it the page's tree was missing `run/endStep.txt` and the last 111 `lifespans.txt` rows the node path writes |
| `L18/run-tree-export` | `app.ts`, `main.ts` | `window.__polyworld.runTreeManifest()` / `runTreeFile(path, from, length)` / `runTreeFiles(paths)` hand back the run tree the **page** wrote (manifest = path + size; files = base64, byte ranges for a large artifact). Read-only, no setters; the transport exists because one CDP message cannot carry minitest's 16 MB tree, and it is what makes `./oracle/run_parity.sh <scenario> --candidate <dir>` compare the *running page's* bytes rather than a node-side re-run of the same code (`verify/demoEvidence.mjs` drives it) |
| `L18/boot-artifacts` | `sim/worldBoot.ts` | the boot stops where the native does before its first step, and the four artifacts it produces (`original.wf`, `original.wfs`, `converted.wf`, `normalized.wf`) are the frozen ones — byte-compared here, written as the parity candidate tree |
| `L18/inputs` | `sim/worldBoot.ts` | sources are read through a caller-supplied reader, so the browser (bundled text) and the node-side test (recorded `oracle/**`) run **one** code path; the artifacts and parameters cannot differ between them |
| `L18/read-plan` | `sim/worldParams.ts` | every `Config` read is recorded with the consumer that justifies it; a key whose value is an unevaluated expression is reported **blocked** with the evaluator's own message — a value is never substituted for one |
| `L18/required-vs-provisional` | `sim/worldParams.ts` | a `required` key that cannot be read fails the boot (`WorldBootError` → the fatal panel names it); `InitAgents` (the one key the shell only needs for the display count) is reported **provisional** and the demo draws `MaxAgents` — labelled as such in the panel and in the report |
| `L18/coordinates` | `sim/simSeam.ts` | the seam keeps the **native** coordinate convention verbatim (x ∈ [0, worldSize], z ∈ [-worldSize, 0], yaw in **degrees**, 0 = −z — `agent.cc:1150-1159`, `food.cc:151-152`) and does the three.js conversion in one place, so lane L11 hands over raw numbers |
| `L18/sim-seam` | `sim/simSeam.ts`, `app.ts` | the shell renders `SimulationLike`; `app.ts::bootedSimulation()` calls `createModelWorld` (`sim/modelWorld.ts`) — the single line the swap touched — and `flavour` names which world is running (`'model'` since L18b) |
| `L18/model-world` | `sim/modelWorld.ts` | lane L11's `TSimulation`, built from the boot's applied document + artifact texts and handed a **non-node** `RecordFileSystem`; the live roster is projected from `gXSortedObjects` in native iteration order (`instanceof Agent`, cursor saved and restored), memoised on `fStep`, and `flavour`/`ended`/`notice`/`runFiles()` report what is actually running |
| `L18/browser-fs` | `sim/browserFiles.ts` | the browser's lane-L12 `RecordFileSystem`: files are chunk lists in a `Map`, gzip is the transcribed `gzipContainer` (never `CompressionStream`), `link` gives the bytes a **second name** while `rename` moves it — getting that backwards silently deleted 521 of minitest_voff's 1369 artifacts while every remaining byte stayed exact. `SYSTEM()` refuses (a page has no shell; only lockstep mode reaches it) |
| `L18/one-run-per-process` | `sim/simSeam.ts`, `app.ts`, `sim/runTree*.test.ts` | the model's tables (`FoodType`, the RNG surfaces, `gXSortedObjects`) are **process-wide**, as native's are: a second `TSimulation` in one process throws (`sim: duplicate FoodType name 'Standard'`). There is no `reset()` on the seam — "New run" reloads the page with the next `InitSeed` (native runs one simulation per process too), and the lane's two tree tests are two files so vitest's per-file isolation gives each one process |
| `L18/seed-is-native-argv` | `config.ts`, `main.ts` | `?seed=` is native's **own** `--InitSeed` (the value `Simulation.cc:3899` hands `srand48`), applied through lane W1b's converter before `apply()` like `--Vision False`; absent, the page runs the recorded scenario untouched (`PositionSeed` is read and unused — PORT-NOTE(sim/position-seed-unused)) |
| `L18/monitors-in-the-page` | `sim/modelWorld.ts` | native's app hangs a `MonitorManager` off `stepEnding` (`main.cc:160` + `SimulationController.cc:26`) and the page does the same: one manager, built once from a document built once, driving `run/stats/stat.<t>` through the run's own sink. The renderer and movie writer stay the graphics lanes', injected as the same nulls lane L11's node runner mounts, so `run/movie.pmv` (free at every tier) is the one artifact a page run does not produce — reported, never hidden (`runTreeSuite.ts` pins the absent set) |
| `L18/bundled-monitor-documents` | `sim/bundledMonitors.ts`, `monitors/**` | the browser bundle carries **verbatim copies** of native's `etc/monitors.mfs` + `etc/term.mf` (the `--ui` the recorded runs used), because those live in the native tree, outside this repo. `worldBoot.test.ts` byte-compares them with the native files when that tree is present and *always* resolves them through lane L14's loader against the recorded 89-leaf native probe (`src/model/monitor/native/vectors/monitorConfig.term.json`), so the drift anchor survives a fresh worktree |
| `L18/status-text-store` | `sim/browserFiles.ts` | lane L14's `StatusTextStore` implemented over the `RecordFileSystem` seam (native `makeParentDir` + `fopen( …, "w" )` + one `fprintf( "%s\n" )` per line + `fclose`), so `run/stats/stat.<t>` lands in the page's in-memory run tree and in the parity candidate tree like every other artifact |
| `L18/preview` | ~~`sim/previewWorld.ts`~~ (deleted in L18b) | historical: the stub world the shell ran until lane L11 landed (PORT_SPEC rule 7). Superseded by `L18/model-world`; the file and its test are gone, and the status panel's `world data` row reads `model` |
| `L18/preview-motion` | ~~`sim/previewWorld.ts`~~ (deleted in L18b) | historical: the stub's per-step distance was native's own expression (`agent.cc:1147-1151`) with the worldfile's size/speed ranges, `MotionRate` and `MaxVelocity` clamp, and an invented yaw walk. The real motion is lane L11's `UpdateBody` now |
| `L18/preview-rng` | ~~`sim/presentationRandom.ts`~~ (deleted in L18b) | historical: the stub's mulberry32 stream. Deleted with the stub so nothing in the shell can perturb the model streams (`rand`/`drand48`/MT19937 — lane L1) |
| `L18/candidate-tree` | `sim/nodeSources.ts` | the lane's parity evidence is written by the same module the browser boots through: `runModelIntoTree` builds the world, runs it to its end, and dumps the *page's own* sink, so the harness compares the bytes the page would have written |
| `L18/ground`, `L18d/no-patch-rectangles` | `scene/ground.ts` | the ground is native's `etc/objects/ground.obj` (four unit quads) uniformly scaled by `WorldSize` and placed at `y = -GroundClearance` in `GroundColor` (`Simulation.cc:820-827`). Native draws **no** food-patch rectangle — a patch's only visual effect is the `food` boxes it spawns (`FoodPatch.cc:124-126`) — so the old per-patch tint quads are gone |
| `L18/draw`, `L18/demo-scenarios` | `scene/objects.ts`, `scene/barriers.ts`, `sim/worldParams.ts`, `sim/scenarios.ts` | L18c: the scene draws native's other world objects too — the model's `food`/`brick` boxes (centre + `fLength` + own colour), and one wall per worldfile `Barriers` segment (`barrier::updateVertices`' ratio scaling, `BarrierHeight`, `BarrierColor`), as one `InstancedMesh` per kind. `worldParams.ts` resolves the barrier/brick values (they are lane-L4-evaluable, measured) instead of reporting them unreadable; a worldfile with no `BrickPatches` draws none and the panel says `no BrickPatches`. `bricks_voff` is a browser-only demo world (native `growingBarriers_grayBricks.wf`, no golden) so the page can show bricks at all — the recorded fixtures declare none |
| `L18/agent-size`, `L18/agent-height`, `L18d/agents-sit-on-the-ground` | `scene/agents.ts`, `scene/agentMesh.ts`, `sim/simSeam.ts` | an agent draws native's `etc/objects/agent.obj` scaled by its own `(fLengthX, agentHeight, fLengthZ)` (`agent::SetGeometry`, `agent.cc:993-1013`) at `y = 0` (`agent::fPosition[1]` is never set) — not the old invented octahedron, and not a `radius` lift |
| `L18/agent-colour`, `L18d/agent-two-ranges` | `scene/agents.ts`, `scene/agentMesh.ts`, `sim/modelWorld.ts` | the body colour on screen is the **model's own** (`agent::color()`, the three native 0..1 floats `agent::UpdateColor()` writes per step); polygons 0..4 are painted in `agent::fNoseColor` (or the body colour when the worldfile's `NoseColor` is `B`, `agent.cc:1824`). The old palette-accent nose blend is gone |
| `L18/visuals`, `L18/camera-fit`, `L18d/faithful-scene`, `L18d/native-camera-is-the-contract` | `scene/palette.ts`, `scene/sceneRoot.ts`, `render/viewport.ts` | the scene is the native renderer's: `glClearColor(0,0,0,1)` (no fog), no lights (native never enables `GL_LIGHTING`), `etc/objects/ground.obj` at `-GroundClearance` in `GroundColor`, and raw `glColor` output (`ColorManagement` off, linear output so a `0.1/0.15/0.05` material renders as bytes `(25,38,13)`). The worldfile's colours are read, never invented |
| `L18/config-vs-worldfile` | `config.ts` | URL parameters are loop/presentation knobs only (`scenario`, `agents` as a capacity *floor*, `stepHz`, `speed`); anything *describing* the world comes from the worldfile, never the URL. The one exception is `seed`, and it is native's own argv parameter (see `L18/seed-is-native-argv`) |
| `L18/loop`, `L18/perf` | `app.ts` | inherited W1g decisions, re-stated for the wired shell: fixed-dt steps with a boundary to sample on, one allocation-free frame, HUD at 5 Hz. The roster is re-projected once per step, not per frame, and a finished run pauses itself instead of stepping into native's inert `Step()` |
| `L18/notice` | `app.ts` | the shell never hides a gap: every blocked worldfile key, the end of the run, and a lost WebGL context all surface in the status panel's notice line |
| `L18d/antialias` | `render/viewport.ts` | **the one deliberate render difference**: native's offscreen GL surface has no multisampling (hard edges); the browser keeps WebGL MSAA. Display quality only — objects, placement, colours and framing are identical (`docs/media/visual-parity-minitest_voff.png`) |
| `L18d/no-top-edge-line` | `scene/barriers.ts` | native `barrier::draw()` also strokes a one-pixel `GL_LINES` segment along the wall's top edge in `gBarrierColor`; a screen-space-width line has no three.js equivalent and is invisible at the recorded 640×480, so only the fill is drawn |
| `L18d/footage-is-minitest_von` | (evidence, not code) | the reference footage the card names (`polyworld-video/assets/native/frames.raw`) is a **vision-on** recording: the native `run/` it was made from has `Vision True` and its `normalized.wf` is byte-identical to `oracle/minitest_von/`, not `minitest_voff` (measured: the browser at `?scenario=minitest_von` matches movie frame 16 with 1 962 differing object pixels, vs 11 656 for `minitest_voff`). `frames.raw` is also stored bottom-up (a `vflip` is needed); `native.mp4` is correctly oriented. A fresh `--Vision False` native run reproduces `oracle/minitest_voff` exactly and is what the comparison image uses |
| `L18/boot-failure` | `main.ts` | a worldfile the browser cannot read produces a fatal panel listing the blocked keys and the lane that closes them — never a silently substituted world |
| `L18/debug` | `main.ts` | `window.__polyworld` now also carries the boot (scenario, artifacts, blocked keys) and `diagnostics()` carries the read report counts, so a headless check asserts the *boot*, not just the render |

Evidence (this machine): `src/browser/verify/headless.mjs` drives a real headless Chrome over
CDP against the dev server and prints one JSON report — `diagnostics()` (`scenario`, `worldSize`,
`agentCount`, `flavour`, `ended`, `runFiles`, `blockedKeys`, `artifacts`, `fps`,
`stepsPerSecond`, `drawCalls`, `cameraPosition`), a pause/step/speed/new-run sequence measured
through the real buttons and key handlers, the status panel's own text, and every console message
of type error/warning. It polls for the shell instead of guessing a load time (booting now
constructs lane L11's `TSimulation`). Measured against `?scenario=minitest_voff` (headless Chrome
154 + SwiftShader against the dev server): the panel reads `MINITEST_VOFF · MODEL`,
`WORLD DATA model`, `RUN FILES 196 · 377.9 kB`, `STATE running`, `notice: null`; `pauseFroze: true`,
`stepDelta: 1`, `speedAfterClick: 8`, `advancedWhileRunning: true`, 7 draw calls / 358 triangles for
25 agents, `errors: []`; pressing `r` reloads to `?scenario=minitest_voff&seed=43` with
`seed 42 → 43` and a different digest. Against `?scenario=microtest_voff` (native `MaxSteps 1`) the
run ends after its own single step: the panel reads `STATE ended`, the notice says `run ended at
step 1 (MaxSteps)`, `RUN FILES 222 · 409.7 kB`, and a step click is inert — native's `Step()` is
inert once `End()` has run. Against `?agents=64` the capacity row reads `25 / 64`; against
`?scenario=bogus` the shell falls back to the default scenario instead of failing. The numbers
quoted in the lane row above are from those runs.

**L18c (the monitor mount) — same driver, the built bundle.** `npm run build` → the tree served by
`python3 -m http.server` with Chrome's resolver pinned to it
(`--host-resolver-rules="MAP * 127.0.0.1:4173"`, so nothing outside the bundle *could* have been
fetched): the only three requests are the page, its JS and its CSS, all same-origin (`offOrigin: []`),
`failedLoads: []`. `?scenario=minitest_voff`: shell up, `WORLD DATA model`, `RUN FILES 197 · 551.7 kB`
(one more than L18b — `run/stats/stat.1`), `STATE running`, `notice: null`, `pauseFroze: true`,
`stepDelta: 1`, `speedAfterClick: 8`, `advancedWhileRunning: true`, 7 draw calls / 358 triangles,
`errors: []`, and `r` reloads to `?scenario=minitest_voff&seed=43` with a different digest.
`?scenario=microtest_voff`: `STATE ended`, the notice reads `run ended at step 1 (MaxSteps)`,
`RUN FILES 223 · 409.9 kB` (was 222), and a step click is inert. The monitor documents are strings
*inside* `dist/assets/index-*.js` (`FrequencyStore`, `@defaults term`), and the bundle carries no
child process of any kind — the one `python3` occurrence in it is the evaluator's own name
(`name: 'python3 (interpreter.py port)'`), not a spawn.

## Gaps (stubs, and the lane that closes each)

| Stub | Where | Closes with |
|---|---|---|
| ~~**Monitor artifacts in the page**~~ **closed by L18c (2026-09-28)**: a browser run wrote every artifact the *simulation* writes — `run/motion/**`, `run/genome/**`, `run/brain/**`, `run/energy/**`, `run/events/**`, `run/lifespans.txt`, `run/population.txt`, `run/BirthsDeaths.log`, the four `*.wf` texts, `run/endStep.txt`, `run/endReason.txt` — but **not** the monitor's `run/stats/stat.{1,100,200,300}` (lane L14's `MonitorManager`, which native's app hangs off `stepEnding`) | `src/browser/sim/modelWorld.ts` (`L18/monitors-in-the-page`), `src/browser/sim/bundledMonitors.ts`, `src/browser/monitors/**`, `src/browser/sim/browserFiles.ts` (`L18/status-text-store`) | closed: the monitor documents are bundled **verbatim** into the page (`etc/monitors.mfs` + `etc/term.mf`, `L18/bundled-monitor-documents`) and the `StatusTextStore` host is `recordFileStatusTextStore` over the page's own `RecordFileSystem`, so the manager's `run/stats/stat.<t>` lands in the run tree byte-identically. Measured today: microtest_voff `match 224/225, differing=0, missing=0` → `parity: PASS (225/225 files)`; minitest_voff `match 1368/1369, differing=0, missing=0` → `PASS (1369/1369 files)`. The only golden files a page run still does not produce are `run/movie.pmv` (Tier C, free — the null movie writer lane L11's node runner mounts) and `run/manifest.sha256` (the harness's own listing); `runTreeSuite.ts` pins exactly that pair so a *new* missing artifact cannot hide inside a count |
| ~~**Placeholder look**: the body octahedron/nose marker, the patch tints, the lighting, the fog, the outer plane and the scale grid~~ **closed by L18d (task `t_67dbaa3f`)**: the scene now draws what native draws — `etc/objects/agent.obj` in its two native polygon-range colours, native's black clear with no fog, no lights (native never enables `GL_LIGHTING`), `etc/objects/ground.obj` at `GroundColor`, the worldfile's barrier walls, the model's own boxes, and native's `MainScene` camera | `src/browser/scene/**`, `src/browser/render/**`, `src/browser/sim/{simSeam,modelWorld,worldParams}.ts` | closed. Evidence: `docs/media/visual-parity-minitest_voff.png` (native C++ frame 16 beside the browser at step 17, same objects/placement/colours/framing). The remaining deliberate differences are the two PORT-NOTEs below |
| No **movie recording** in the browser, and no worldfile *picking*: the four recorded scenarios are bundled and selected with `?scenario=` (`sim/bundledWorlds.ts`), there is no file-open/parameter-editor UI | `src/browser/sim/bundledWorlds.ts`, `src/browser/config.ts` | the tier-B recording rule in PORT_PLAN.md cutover ("record on step boundaries"; the fixed-step loop already provides the boundary) + lane L3/L4 (worldfile editor, expression evaluation). The *loading* half landed here: `sim/worldBoot.ts` boots a worldfile and reproduces its frozen artifacts |
| ~~The browser cannot read **expression-valued** worldfile keys~~ **closed by L4 (2026-09-28)**: measured, the recorded worldfiles have 12 expression-valued keys (`InitFood`, `GenomeLayout`, `MinMutationRate`, `MaxMutationRate`, `EnableSpikingGenes`, `MaxBiasWeight`, `SimpleSeedConnectionDensity`, `SimpleSeedIOConnectionDensity`, `RecordPosition`, `RecordEnergy`, `RecordBrain`, `RecordBirthsDeaths`, `MateThreshold`, `InitAgents` — plus the barrier `X1/Z1/X2/Z2`); with lane L4 landed **none** of them is blocked any more | `src/browser/sim/worldParams.ts` | closed: the read plan's `blocked` list is now empty and `InitAgents` reads 25 (`InitAgents MaxAgents`), which is why `worldBoot.test.ts` asserts `blocked === []` and `provisional[0].reason === 'read as 25'`. It still draws `MaxAgents` creatures until lane L11 creates the real population (that half is L11's, not L4's) |
| ~~Schema `assert` / range validation against **real** values, and every model-side `doc.get(...)` read~~ **closed by L4 (2026-09-28)** | `src/model/proplib/{evaluator,pythonExpression}.ts` | closed: the expression language (the out-of-process `interpreter.py`, ported) now runs every value read. The validation pass is exercised for all four recorded variants (`validate: true`) and every scalar in the document reads, which is what `Config`'s boot does. `schemaLiteralEvaluator` survives only as the seam's test harness — no production path defaults to it |
| The `Sheets` brain architecture is **not owed a transcription — measured 2026-09-29** — and the port's refusal is the honest equivalent: the shipped build cannot build a Sheets brain at all | `src/model/brain/core/sheets/**` (ported + unit-tested), `src/model/genome/genomeUtil.ts` (throws for `Sheets`) | `src/model/genome/native/probe_sheets_architecture.sh` — re-runnable, PASS/FAIL against the three measured verdicts (see the *Sheets architecture* finding above the L5 PORT-NOTEs). A minimal Sheets worldfile and a fully specified one (a recorded run's own `normalized.wf`, `BrainArchitecture Sheets`, the schema's Sheets defaults raised to brain sizes 8–16 / internal sheets 1–5) both run to completion — 25 agents, `exit 0` — with **every agent's brain empty**: anatomy `numneurons+1=1`, synapses `numsynapses=0`, and at step 60 `CurNeurons` / `CurInternalSheets` / `CurSynapses` all `0.0`; stderr carries `IMPLEMENT INDEX-BASED WEIGHT` (`SheetsGenomeSchema.cc:937`). It is not even reproducible: the minimal worldfile's gene pool is unseeded, and across 17 repeats 846 of 850 anatomy dumps read 0 neurons while 4 read 15 (one run) and one repeat died with `SIGABRT` (exit 134) — a run whose brains are 0-or-15 on the draw is not an oracle. Writing `GenomeLayout NeurGroup` explicitly — the only container layout the shipped build has (`GenomeLayout.cc:57`) — **SIGSEGVs (exit 139)** before the first dump. There is no native brain behaviour to reproduce and no worldfile the oracle completes, so no Sheets golden can be recorded while native stands as it is |
| `GroupsBrain::grow`/`growSynapses`' **connection walk** (which index a connection lands on, the `nearestFreeNeuron` repair, the draw order, the initial efficacies) is ported and is now **diffed end-to-end** — but through the L11 runner's candidate tree, not through `native/brainprobe.cc`: the probe still has no `genome->createBrain(cns)` mode | `src/model/brain/core/groups/groupsBrain.ts` | L6 itself, when a native grown-brain mode is wanted: the sim's `run/brain/**` diff already covers the walk (measured 2026-09-28: `microtest_voff` `anatomy` 50/50, `synapses` 50/50, `function` 25/25 payload-identical; `minitest_voff` `anatomy` 50/50, `synapses` 50/50 before that run aborts in lane L11's mate path), so the probe mode is now a convenience, not the only way to see the walk. The *arithmetic* the walk is built from is diffed by `growexpr`: 75,263/75,263 exact, `distort` 29,808 of them (see `l6/groups-grow-arithmetic`, `l6/groups-nint-double-evaluation`) |
| The `SheetsBrain`/`GroupsBrain` energy-use formula's **inputs** (`numNeurons`, `numSynapses` as a whole grown brain produces them) are not diffed, because `_energyUse` is only assigned inside `grow` | `src/model/brain/core/{groups,sheets}` | same as above: a native grown brain. The *formula* is diffed now (10,368 grid rows, exact — `growexpr` `energy`; note native assigns `_energyUse` only in `GroupsBrain::grow`, `GroupsBrain.cc:616`, so `Sheets` keeps `Brain.cc:150`'s 0) |
| ~~`Brain::loadSynapses`/`copySynapses`/`scaleSynapses` (the `SeedSynapsesFromRun` path) are ported but not diffed~~ **closed by `t_89eb5e66` (2026-09-29)**: measured on the oracle's own reader/writer pair and pinned against it bit-for-bit | `src/model/brain/core/brain.ts`, `baseNeuronModel.ts` | closed: `brainprobe synapses` (its own file, `native/brainprobe_synapses.inc`; corpus re-recordable with `native/record_synapses_vectors.sh`) grows a brain, dumps it through the shipped `Brain::dumpSynapses`, reads it back through the shipped `Brain::loadSynapses`, copies that through `Brain::copySynapses` and re-loads it with each of 7 `maxWeight` values, reporting raw IEEE-754 bits. The corpus is committed under `src/model/brain/core/native/vectors/` and `tests/brain-core.test.ts` replays it (12 tests + 2 drift checks, no C++ needed). **Two families bracket the dump's loss**: the dump is text, so `%g`'s six digits lose a real brain's efficacies — `synrandom` **0/48** values survive the round trip — while `synexact` (short decimals) is **48/48** lossless, and `copySynapses` is **48/48** exact on both (it never goes through text), re-deriving the same neuron ranges including the *unrewritten* range of a neuron with no incoming synapse (`setSynapses` never sees it). **The rescale path is where the port was wrong**: native reads the header's `maxweight=%g` into a `float fileMaxWeight` and divides `maxWeight / fileMaxWeight` in `float`, while the port kept `%g`'s `binary64` and divided in binary64 — measured **78/336** (`synrandom`) and **94/336** (`synexact`) rows one ulp off the shipped model; with the narrowing (`f32` on the field, the argument and the quotient, plus `scaleSynapses`' own `float` parameter) the port is **672/672 rows bit-exact**, and the `binary64` form's power is asserted rather than assumed (`legacyBad > 0`). No recorded scenario sets `SeedSynapsesFromRun`/`FreezeSeededSynapses` (both goldens: `False`), so no frozen artifact moves: the six scenario verdicts are unchanged (19/19 · 225/225 · 225/225 · 1369/1369 · 1308/1308 · 1373/1373). **Tree-state incident, resolved — not caused by this change**: during the run `oracle/microtest_voff/run` was found out of sync with its own `manifest.sha256` (2 files missing, 125 `.gz` containers re-deflated, `stats/stat.1` truncated — the shape of a run tree written into the golden directory and interrupted; `Brain::loadSynapses` has no caller outside tests, so nothing in this change could reach those consumers). 128 of the 129 damaged files were restored from a manifest-verified candidate tree and the last (`run/movie.pmv`, Tier C, `IGNORED … run/movie.pmv`, a file the port never writes) from `oracle/_native_previous`, each copy re-hashed before it was accepted. **Re-measured 2026-09-29 after the restore**: all six goldens verify **4519/4519** files against their own manifests (19/19 · 225/225 · 225/225 · 1369/1369 · 1308/1308 · 1373/1373), **0 mismatched, 0 missing**, `run/movie.pmv` hashing to its own manifest line `a439d56d…e64c`, and no file under any `oracle/*/run/` newer than the 2026-09-28 14:15 golden stamp |
| `genome/sheets/**` (`SheetsGenomeSchema`, `SheetsCrossover`, `SheetsGenome`) is **deliberately not ported** — `GenomeUtil.createSchema` throws for `BrainArchitecture Sheets`, a documented deviation rather than outstanding work | `src/model/genome/**` (no `sheets/` module), `src/model/genome/genomeUtil.ts` | the measurement above is the reason: the oracle's Sheets path builds no brain (`numneurons+1=1`, 0 synapses — under the schema's own `None` layout the `InputSheets`/`OutputSheets`/`InternalSheets` containers stay empty, `SheetsGenomeSchema.cc:678`) and crashes under the container layout. Transcribing `genome/sheets` + `brain/sheets` (~2.7k lines of C++) would buy fidelity to a path the oracle cannot complete; the throw is pinned by the genome tests and by `native/probe_sheets_architecture.sh` (A1/A2/B produce the same 125-file `run/brain` digest, so no parameter choice reaches a neuron; see the finding for the 0-or-15 spread and the one `SIGABRT` in 17 repeats). Reopen if a Sheets golden ever becomes recordable |
| ~~L5's `GroupsGenome` does not implement L6's `GroupsGenomeView` adapter~~ **satisfied by L11's own binding — verified 2026-09-29** | `src/model/genome/groups/groupsGenome.ts` (the `createBrain` stub), `src/model/sim/bindings.ts` | no lane calls `genome->createBrain`: the sim grows the brain through `NervousSystem.grow( factory )` with `GroupsGenomeViewAdapter` (`src/model/sim/bindings.ts:196` adapter, `:796-797` the factory it hands `cns.grow`), which is what every Tier-A scenario runs — a real `GroupsBrain` over L5's genome, byte-exact end to end. The stub in L5 keeps its PORT-NOTE (`genome/create-brain-stub`) and has no caller; no work owed |
| ~~`cos` is the JS one in one genome path (`mateProbability` → `pow`/`cos`) and `pow` in three (`GeneInterpolationPower` → `interpolate`, `mutateBytes` → `pow(2, MutationStdevPower)`, `mateProbability` → `pow`/`cos`)~~ **switched in `t_c10975cb` (L5/L10), with one correction to the row: of those four call sites only two are `pow` calls — one is `exp2` and one is `powf`** | `src/model/genome/gene.ts`, `genome.ts` | closed: `gene.ts:183` (`interpolate`), `genome.ts:264` (`mutateBytes`) and `genome.ts:385` (`mateProbability`) now call L1's transcribed `pow`/`cos` (`src/model/rng/libm.ts`), and the oracle's own disassembly is what says they are the right functions: `__InterpolatedGene::interpolate(unsigned char)` calls `bl _pow` @0x6ab48 (both operands double, `Scalar::operator double()` being `(double)(float)fval`), `Genome::mateProbability` calls `bl _pow` @0x760b8 and `bl _cos` @0x760d4, and `mutateBytes(float)` has **no `pow` call at all** — clang folds the constant-base-2 call to `bl _exp2` @0x75900, which agrees with `pow(2.0, y)` bit-for-bit on all 400,000 doubles of a `[-80, 80]` sweep. `mateProbability`'s **last** line is not a `pow` site either: it calls `bl _powf` @0x7611c on two floats, and the double `pow` is not a substitute — measured on the base × slope lattice, the transcribed `pow` and V8's `Math.pow` are bit-identical to each other (0 of 106,995 pairs) and each disagrees with the shipped `powf` on 138 of them, and that line was switched to L1's transcription of the float overload, `powf`, in `t_29e0a2fc` — the base × slope lattice that row measured is part of `powf`'s own corpus. For scale, V8 against the transcription at the switched sites: 14/768 on `interpolate`'s `(raw, power)` table, 207/2257 on `mutateBytes`' exponent grid over `[0, 6]`, 323/16,004 and (the `cos`) 631/16,004 on `mateProbability`'s own arguments — reproducible with `npx tsx tools/measure_pow_call_sites.ts`. All of these sites remain **unreachable in the recorded scenarios** (`GeneInterpolationPower []`, `GeneticOperatorResolution Bit`, no worldfile defines `MiscBias`/`MiscInvisSlope` so native's `mateProbability` would dereference `NULL`, and `agent::MateProbability` has no caller in the native build), so **no frozen artifact moves**: this is port fidelity, not a parity improvement the goldens can show |
| `sin`/`cos` were the JS ones on the **motion path** (`agent.cc:1150-1151`: `dx = -dpos * sin( yaw() * DEGTORAD )`, `dz = -dpos * cos( … )`) and in `CameraController.cc:78-80` and `graphics/gmisc.cc` | `src/model/agent/agent.ts`, `src/model/monitor/cameraController.ts`, `src/model/genome/genome.ts` | **CLOSED** by **`t_5221d534`**: `src/model/rng/libm.ts` now exports transcribed `sin`/`cos` (`appleSinCosTable.ts` generated from the dumped bytes), bit-exact on all 5,055 + 5,055 corpus values after the C transcription was diffed against `raw/libm_native_{sin,cos}.txt` first. The census (`t_12c76fc3`) measured them as not correctly rounded (4,858/5,055 and 4,860/5,055; V8 95.7 %/95.9 %), and the disassembly map in that card's body is what the transcription followed. The callers (`agent.ts`, `cameraController.ts`) still call `Math.sin`/`Math.cos` — **switching them over is a one-line change in those lanes**, and `run/motion/**` byte-parity needs it |
| ~~`sinf`/`cosf` (the C++ `float` overloads) are the JS `Math.fround( Math.sin/cos )` in `CameraController.cc:78-80`'s path (L14's recorded camera frames)~~ **CLOSED by `t_05611902`** | `src/model/monitor/cameraController.ts`, `src/model/rng/libm.ts` | closed: the float overloads are transcribed (`libm.ts`'s `sinf`/`cosf`, bit-exact on all 5,016 + 5,016 captured native rows) **and the path they were believed to serve actually calls something else**: the shipped `CameraController::setRotationAngle( float )` contains `bl ___sincosf_stret` (LLVM merges the adjacent `sin`/`cos` calls), so L14 now calls a transcription of the two-output `__sincosf_stret` — which differs from `cosf` by one ulp on `rotate[3]` frame 3's argument (`1123315328` vs `1123315326`). All 117 recorded frames stay bit-exact, and the port no longer relies on narrowing a double result. `t_5221d534`'s measurement stands: `Math.fround( double sin )` disagrees with the shipped float overloads on 304 + 135 of the 5,016 arguments |
| ~~`run/genome/genestats.txt`'s per-step body and the writer of `run/genome/separations.txt` are not produced~~ **both produced by L12 and byte-exact — verified 2026-09-29** | `src/model/logs/genomeLogs.ts` (`GeneStatsLog` `:57`, `SeparationLog` `:267`), `src/model/logs/seams.ts` (`GeneStats`) | the goldens carry both (`oracle/minitest_voff/run/genome/genestats.txt`, 7.7 MB; `separations.txt`, 31,776 B) and `minitest_voff` passes **1369/1369** with `differing=0`, a whole-run byte comparison that includes them — so the row's "not produced" was stale |
| ~~L14's monitor documents need **one** expression shape lane L4 has not landed~~ **closed by L4 (2026-09-28)**: `Movie.Record`'s schema default is the bare symbol `RecordMovie` (a reference to the top-level property), which without a language meant `MainScene.Movie.Record` could not be resolved at all | `src/model/monitor/monitorDocument.ts` | closed: the stand-in is **deleted** and `monitorDocumentEvaluator` is lane L4's `interpreterEvaluator` (PORT-NOTE `monitor/document-evaluator-cutover`). The same recording that proved the stand-in — 89 + 89 native leaves of `etc/term.mf`/`etc/gui.mf` in `native/vectors/monitorConfig.{term,gui}.json` — now proves the real evaluator, through `tests/monitor.test.ts` |
| The movie encoder (`PwMovieWriter`, `utils/PwMovieUtils.cc`) and the per-renderer `MovieRecorder` (`QtMovieRecorder`) are **not implemented**; `src/model/monitor/movieWriter.ts` declares the two interfaces the lane drives | `src/model/monitor/movieWriter.ts`, `native/vectors/*` | utils lanes (L1/L2 — `library/utils/**`) for the pmv container, and L15/L16/L18 for the renderer-side recorder. `run/movie.pmv` is Tier C (not frozen), so the encoder's byte fidelity is not this lane's acceptance — the **frame schedule** is, and it is pinned against the golden headers |
| The concrete scene renderer, `gcamera` and `gstage` are other lanes'; the monitor lane programs against `SceneRendererSurface` / `ControllerCamera` / an opaque `stage` and takes a `SceneRendererFactory` | `src/model/monitor/{sceneRenderer,cameraController}.ts`, `monitorManager.ts` (`createSceneRenderer`) | L15 graphics-scene / L16 vision-raster / L18 browser shell — the arms-length seam is what lets a scene be *selected* without a renderer existing, and the camera arithmetic is pinned against the native `gcamera` even though the object is not |
| The status file's I/O (`makeParentDir` + `fopen( "w" )` + `fprintf` + `fclose`) is injected as `StatusTextStore`; nothing in the lane writes a file itself | `src/model/monitor/statusTextMonitor.ts` | L18 browser shell (or any host): implement `writeTextFile( path, text )` with native's parent-directory and truncate semantics. The bytes and the path are this lane's and are compared with the golden; only the write is not |
| The farm monitor's run-time property metadata (`proplib::CppProperties::getMetadata`) is injected as `CppPropertyMetadataProvider`, and `system()` as `FarmRunner` | `src/model/monitor/farmMonitor.ts` | W1h run-time codegen (`docs/specs/cppprops.md`) for the metadata. Only reachable with `PWFARM_STATUS` set, which no recorded scenario does — so no frozen artifact depends on it |
| L8's lane boundary is a set of *interfaces*, not yet bound to the neighbour modules that have since landed | `src/model/agent/contracts.ts` (`GenomeLike`, `NervousSystemLike`, `SimulationLike`, `BarrierLike`, `SortedObjectListLike`, `BodyGeometryLike`, `CarryableLike`/`FoodLike`, `EventSinkLike`) | **bind, don't re-implement** — the concrete modules exist or are named: L5 `src/model/genome` (`genome.ts`/`genomeUtil.ts` for `GenomeLike` + `getMetabolism`), L6 `src/model/brain/core` (its barrel already says "the agent lane (L8) creates the nerves, adds its sensors and drives `update()`" — `Nerve`/`NervousSystem`/`Sensor` are the concrete side of L8's seam, and L6's own Gaps row asks for L8's **nerve set** to grow a real brain), L10 `src/model/environment` (`energy.ts` is the `Energy` module's home since `t_4e856769`; `food.ts`/`objectXSortedList.ts`/`patch.ts` are the concrete `FoodLike`/`SortedObjectListLike`), L12 `src/model/logs` (the concrete `EventSinkLike`), L15 `src/model/geometry`+graphics (`gobject`/`gpolyobj` — `BodyGeometryLike` and the kinematic fields L8 keeps locally). Each binding is one import at the seam; the agent code does not change |
| `agent::UpdateVision()`'s camera/frustum writes (`fCamera`, `fFrustum`) are behind `VisionCameraLike` and `AgentDeps.visionCamera` is `null` in the lane's tests | `src/model/agent/agent.ts` (`updateVision`), `contracts.ts` | L9/L16 (vision) + L15 (`gcamera`): supply the concrete camera. The *numbers* native computes (fov, pitch, yaw, aspect) are in the port and are what the retina lanes consume |
| `draw()`, `print()`, `agent::SetGraphics()` and the GL polygon load in `agentinit()` (`Resources::loadPolygons`) are not ported | `src/model/agent/agent.ts`; the polygon mesh arrives as `AgentDeps.geometry`/`bodyTemplate` | L15 graphics-scene / L18 browser shell. Nothing frozen depends on them: the agent-side consequences of the mesh (`fLengthX`/`fLengthZ`, `setlen`'s bounding box, `fCarryRadius`) *are* ported and are what the collision radius needs |
| `ReadSeedSynapseFilePaths`/`SeedSynapsesFromFile` (the `SeedSynapsesFromRun` path) stop at the file name: `seedSynapsePath()` is ported (native's `(fTypeNumber - 1) % paths.size()`), reading the file is not | `src/model/agent/agent.ts`, `agentConfig.ts` (`AgentStatics.seedSynapseFilePaths`) | L17 tools / the browser lane (file I/O), plus L6's `Brain::loadSynapses` (**diffed since `t_89eb5e66`** — see its Gaps row; the port was one ulp out on the rescale path). No recorded scenario sets `SeedSynapsesFromRun` (both goldens: `False`), so no frozen artifact depends on it |
| `AgentAttachedData`'s slot pool is ported (`alloc`/`createSlot`, zero-filled array) but the *slot users* are not | `src/model/agent/agent.ts` | L14 monitor (`src/model/logs/agentSlots.ts` + `monitor/agentTracker.ts`): the per-agent analysis state native keeps in attached data |
| The whole-run artifacts this lane is accepted against (`run/energy/**`, `run/motion/**`, `run/lifespans.txt`) cannot be produced by L8 alone | — | L11 sim (`t_d5ca0870`): once the step loop, the worldfile pipeline and the log recorders are wired to the agent, the lane's acceptance becomes the PORT_SPEC command, `./oracle/run_parity.sh minitest_voff --candidate <run tree>`. Until then L8's evidence is the native differential (`3022/3022` bit-exact, the contraction transcribed from the shipped disassembly; the 65 residuals of round 1 were clang `-ffp-contract=on`) plus the golden-anchored lifecycle invariants (all 87 agents) — see the L8 section |
| ~~`Energy`/`EnergyPolarity`/`EnergyMultiplier` are defined in `src/model/agent/energy.ts` (L8's file), not in `src/model/environment/energy.ts`, which **re-exports** them~~ **CLOSED by `t_4e856769` (2026-09-28)**: the module body moved *whole* into `src/model/environment/energy.ts` (`MAX_ENERGY_TYPES`/`ENERGY_EPSILON` came with it out of `agent/numeric.ts`), `src/model/agent/energy.ts` is **gone** — not left as a re-export — and the agent lane's four importers (`agent.ts`, `metabolism.ts`, `contracts.ts` and its barrel) point at the new file, which the barrel re-exports so `import { Energy } from '../model/agent'` still resolves. The moved body was diffed against the old file with comments/whitespace stripped: the only differences are the import line and the two constants. `grep -rn '^export class Energy\b' src` → **1**. Acceptance is the recorded bytes, not the types: all six scenarios still PASS after the move and `run/energy/**` is byte-identical in each | `src/model/environment/energy.ts`, `src/model/agent/energy.ts` (deleted) | closed: the "half-move = two definitions" failure mode is exactly what the acceptance measures, and there is exactly one definition |
| ~~the environment's slice of `gobject`/`gbox`/`gboxf` (`src/model/environment/object.ts`) duplicates what L15 will own~~ **CLOSED by `t_4e856769` (2026-09-28)**, resolved the way this row prescribes — **one re-exports the other**. The *radius rule* now has one definition, in L15's `src/model/geometry/primitives.ts` (`scaledRadius`, the two contracted square sums, `recordedSquareSum` and `boxRadius`); `environment/object.ts` imports `boxRadius` for its `GoBox` slice and re-exports it under the lane's old name `focusRadius`, `food.ts`'s x/z override and `agent.ts`'s 2-D override call the same helpers, and `primitives.ts`/`body.ts` use them for `gpoly`/`gpolyobj`/the agent mesh. `grep -rn 'f32(f32(f32(root' src` → **6 before, 1 after** (the definition itself). No arithmetic changed value: `gbox`'s recorded `f32(a*a + t)` spelling is kept verbatim (round 2 of *the contraction sweep* measured it equal to `f32Fma` on 0 of 200 000 samples — not churned here), each class keeps its own `fRadiusFixed` latch as native does, and both sides' pins were green at the hop's own measurement — `tests/environment.test.ts` **15/15** (its whole probe fixture set) and `tests/geometry.test.ts` **47/47**. (That file's later 1-ulp `world100_origin.proj[14]` failure is the separate **vision/gl-matrix ownership hop** landing in `geometry/matrix.ts`/`geometry/camera.ts` concurrently, *not* this hop: it reproduces identically with this hop reverted — see *Hotspots*) | `src/model/geometry/primitives.ts`, `src/model/environment/object.ts` | closed: the radius rule is in one place and both sides' pins are green |
| `proplib::CppProperties`'s dynamic-property binding (`FoodPatch::On`, `BrickPatch::On`) is not ported; the setters are exposed for it | `src/model/environment/{foodPatch,brickPatch}.ts` | the cppprops lane (`docs/specs/cppprops.md`, W1h): the generated `CppProperties_Update()` is a friend of these classes and writes `on`. Both recorded worldfiles use no `dyn(...)` form, so no frozen artifact depends on it. The probe reaches the removal edge by *defining* that friend (see `native/envprobe.cc`) |
| ~~`pow` is the JS/libm one in `distributions.ts`'s `getNormal`/`normalPDF` (and, transitively, `Patch::setPoint`'s GAUSSIAN distribution)~~ **`t_c10975cb` (L5/L10) checked it against the binary: there is no `pow` call site here — the oracle calls `powf`** | `src/model/environment/distributions.ts` | `normalPDF`/`getNormal` between them contain exactly **one** transcendental call, `bl _powf` (@0xfbc4 in `__Z9normalPDFfff`, @0xfce4 in `__Z9getNormalff`), and the *other* three `pow` calls in the C source do not survive as calls: clang folds `pow(sigma,2)` to a double `d*d` and `pow(x-mu,2)` to a single-precision `fnmul s0,s0,s0` (a 15-line replica of `distributions.cc:32-43`, built with the oracle's own flags, emits a byte-identical instruction sequence, which is how the folds were ruled in). So importing the transcribed **double** `pow` here would reproduce the wrong function: measured over this file's own argument domains — base `e` with `-(x-mu)^2/(2 sigma^2)` (10,005 pairs, mu=0.5, sigma ∈ {0.1,0.25,0.3,0.5,1.0}) and the float base lattice × slope (106,995 pairs, slopes 0.5…6) — plus a 680,034-pair float sweep, the transcribed `pow` and V8's `Math.pow` are bit-identical to **each other** on all 797,034 pairs and each disagrees with the shipped `powf` on 0.90 % / 0.13 % / 0.30 % of them. Swapping would change nothing, cost ~20x per call and label a `powf` site `pow`; the float overload was transcribed instead (`t_29e0a2fc`) and this site now calls it — **1,296/1,296** of this file's own sweep rows match with `powf`, against 1,285 with the double `pow`. Both recorded worldfiles use `Distribution U`, so no frozen artifact reaches it; the probe pins the gaussian set-point paths as far as this machine's `pow` agrees, and a divergence there changes the *draw count*, not just the last bits. Measured (`raw/libm_census.out`): the oracle's `pow` is not correctly rounded (4,373/4,471; V8 4,084/4,471) |
| ~~`normalPDF`'s `left`/`rightBottom` carry `f32` roundings the oracle does not have~~ **fixed in `t_8db5f338` (L10): both now narrow once, like the binary; the only residual left is the untranscribed `powf` (`t_29e0a2fc`)** | `src/model/environment/distributions.ts` | L10's (`t_8db5f338`), filed by `t_c10975cb`: the shipped `__Z9normalPDFfff` keeps `sigma^2` (from `pow(sigma,2)`), the `(double)fl(2*pi) * sigma^2` product and the `sqrt` in **double**, narrowing once into `left` (`fcvt s8, d3`), and narrows `2 * (double)sigma^2` once (`fcvt s1, d1`); the port's line 32 rounds `sigma^2`, the product *and* the root in binary32, and line 36 rounds `sigma^2` before the `2 *`. Line 34 is right — the oracle's `fnmul` *is* one rounding. Unobservable today (`Distribution U` in both recorded worldfiles, and the probe's `dist.*` fixtures are barrier distances, not PDFs). **Measured afterwards (`t_8db5f338`)**: over `native/raw/normalpdf_sweep.tsv` (1 296 `(x, sigma, mu)` rows dumped from the shipped `normalPDF`, `native/raw/dump_normalpdf.cc`) the port's `left` disagreed with the oracle on **576 (44.4 %)** rows and the return value on **537 (41.4 %)**; with the fix, `left`, `rightTop` and `rightBottom` match on **all 1 296** and 11 rows (0.85 %, every one 1 ulp) still differed in `right` — the oracle's `_powf` against the port's double `pow`. **`t_29e0a2fc` closed them**: with the float overload transcribed (`powf`), `right` and `pdf` match the oracle on **all 1 296** rows, and `tests/distributions-normalpdf.test.ts` pins both the 0 residual and the 11-row double-`pow` shortcut so that one cannot come back silently. The second half of this row's reading was **wrong**: line 36's extra `f32` is value-neutral (0 of 1 296 either way — `* 2` is exact in binary32, so the two roundings commute), so it was rewritten for the binary's operand types, not to move a bit |
| ~~`Patch::setPoint`'s four distribution parameters are native `float` literals (`Patch.cc:78-81`: `sigma = .3`, `mu = 0.5`, `slope = -0.4`, `yIntercept = 0.4`) and were transcribed as JS doubles~~ **fixed in `t_bb4630da` (L10): the literals are `f32(...)` and all four of `normalPDF`/`linearPDF`/`getNormal`/`getLinear` narrow their own parameters at entry (native's signatures are `float`)** | `src/model/environment/patch.ts`, `src/model/environment/distributions.ts` | filed by `t_8db5f338`'s review, which measured it in situ and found it unfiled anywhere (PARITY.md and every PORT-NOTE were silent on the literal widths). `normalPDF`'s `fcvt d1, s1` (0xfb78) widens its `float` parameter and `linearPDF`'s `fmadd s1, s1, s0, s2` (0xfbdc) fuses binary32 operands, so the doubles reached `(double)sigma` as `0.299999999999999988…` and fed the fusion the wrong operands. **Measured** over the new in-situ corpora (`native/raw/normalpdf_insitu.tsv`, `native/raw/linearpdf_insitu.tsv`, both dumped from `libpolyworld.dylib`): `left` the wrong float on **10 000/10 000** rows (`0x3faa3723` vs the oracle's `0x3faa3722`), `normalPDF`'s return value wrong on **9 456/10 000 (94.6 %)**, `linearPDF` wrong on **7 991/40 001 (20.0 %)** of `x` (else arm alone 3 999/20 000) — 0 for all after. Not reachable in the recorded scenarios (`Distribution U` in both worldfiles, so `setPoint`'s UNIFORM arm never calls either function) and sample-neutral in situ (0 differing samples in 20 000 draws of either sampler on one deterministic stream, since a rejection only flips when the draw lands inside the ulp window), so no golden moves; it is the same draw-count class as the pow-drift row, on the `Linear`/`Gauss` set-point paths. Pins: `tests/distributions-normalpdf.test.ts` (four in-situ tests, the pre-fix counts included; the four literals' bit patterns are asserted there too, since after the entry narrowing the call site's width is no longer observable in sampled output) |
| the concrete `Domain` (L11) and `gstage` (L15) are lane cuts here (`DomainLike`/`StageLike`), so a patch can only be driven with the four geometry fields and the two stage calls | `src/model/environment/patch.ts` | L11/L15 bind their real classes to those interfaces. `FoodPatch::addFood`/`BrickPatch::addBricks` are the only users; nothing else in the environment touches them |
| `objectxsortedlist`'s concrete walk is `src/model/environment/objectXSortedList.ts` while L8 and L12 declare their own seam interfaces for it | `src/model/environment/objectXSortedList.ts`, `src/model/agent/contracts.ts`, `src/model/logs/seams.ts` | L11/L12: bind `SortedObjectListLike`/`LogSortedObjectList` to this class. Two independent walks would disagree about object order — and `run/energy/food.txt` is a float sum *in x-sorted order*, so that would move a frozen artifact |
| the whole-run artifacts this lane is accepted against (`run/events/**`, the food-energy rows of `run/energy/food.txt`) cannot be produced by L10 alone | — | L11 sim: the rows are emitted from the simulation's step loop and its food population. L10's evidence until then is the native differential probe (1,909 pins) plus the golden-anchored barrier replay (all 1,490 rows) — see the L10 section |
| W1h: a `dyn` body that calls into the model is `portable: false` and needs a binding, and a property whose **cpp symbol** is such a call needs one too (the symbol is the property's *storage*, so no body ever names it). Bound today: the proplib-owned `FoodPatchTokenRing::{add,update}` and the gene read `$[gene,…]` → `genome::GenomeUtil::getGene` | `tools/cppprops/bindings/**`, `lib/cppprops.mjs` (`bindingKey`, `geneReadSymbol`), `lib/genesymbol.mjs` | the lane that owns the called symbol. **`$[gene,…]` landed for L5 (2026-09-28).** `bindings/gene.mjs` serves the emitted `genome::GeneType::to___Interpolated(genome::GenomeUtil::getGene(…))->smin|smax.__val` out of the port's genome layer (`genomeUtil.getGene` + `Gene::getMin/getMax` + native's union read — `*(T *)&(s.__val)`, with the FLOAT↔INT type punning reproduced and the BOOL read refused as undefined), a property that names a gene read without the binding is refused **by name** (`run_cppprops.mjs` exit 3), and the value is pinned against the native binary three ways: the recorded run's own `generange.txt` (`FLOAT 0.500000 MateEnergyFraction` for the new `gene_dyn` worldfile, `0.200000`/`0.800000` for the oracle scenarios), the probe `src/model/genome/native/genevalueprobe.cc` (8 rows of `Scalar` union reads, byte-identical over two runs), and the recorded farm log — 300/300 lines replayed with the gene table built from that same port genome layer. **Measured reachability** (`docs/specs/cppprops.md` §3, *The `$[gene, …]` class*): the symbol reaches generated code only as the metadata/storage binding, never inside a body (the seven gene cpp symbols sit on scalar constants, which are inlined as their evaluated value, and no non-scalar property carries one), and the property feeds the very range member it reads, so its value coincides with the worldfile value in every case a worldfile can reach. Two residuals on **W1h's** files: **both closed (2026-09-28, this lane's follow-up).** `gene_dyn` is registered in `fixtures/manifest.json` (the verifier grew the gene-source channel: a `genesFromGenerange` block whose values are parsed out of the run's own `run/genome/meta/generange.txt`, so `verify_cppprops.py` is back to **7/7** — six scenarios byte-unchanged), and the emitted `Cannot find gene` text now carries `Property::getLocation().getDescription()` (`path:line: `), so `gene_dyn`'s `--crosscheck` is byte-identical to the recorded `generated.cc` with no exemption. The location is the *schema* property's (`prop->getSchema()->get( "cppsym" )`, `cppprops.cc:817`/`:873` — `./etc/worldfile.wfs:1619`), not the worldfile's; `lib/proplib.py` now carries a location per node (`builder.cc:155` `createLocation`), `lib/cppprops_model.py`'s `_location_description` prints it, and the schema *document's own name* is an input (`extract_cppprops.py --schema-name`, native `Simulation.cc:270`'s literal) that `verify_cppprops.py` derives from the manifest. Not modelled, and only whole-sim parity could see it: the native write-back into the gene's `Scalar`. Still open from the original class: any `UpdateContext`-mediated engine mutation — **closed by L11 (2026-09-28, `t_23d13a7b`)**: `UpdateContext` is `{ TSimulation * sim; }` (`cppprops.h:32`), so the sim owns that half, and `src/model/sim/cppProperties.ts` now serves it — the live runtime values, `ctx.patchAgentInsideCount` (a live view over `FoodPatch::agentInsideCount`, so no `stepShift` is needed: the field *is* the previous step's accumulation), `ctx.engine.onActivatePatch` (native `state.cc:205-213`'s `SetDeathByPatch` walk, executed through the sim's own death gate) and the write-back of every `dyn` value into the model object its cpp symbol names — injected through `DynamicPropertySet` (`simulation.ts`: `init( sim )` at the ctor's `InitCppProperties` step, `update( sim )` at `Simulation.cc:648`). Measured: the recorded `growers_ring` worldfile replayed **through the sim's own step loop** reproduces **300/300** farm-log lines on all nine columns (`Step`, `AgentCount`, `FoodCount`, `Alive0`, `B0Z2`, `B1Z2`, `P0On/P1On/P2On`), with the recording's **35 `P*On` transitions**, `Alive0` 181 → 139 at step 7 and `fNumberDiedPatch` = the recorded **67**; `growers_dyn` matches every cppprops-owned column at all 300 steps. Controls: with the ring's engine input zeroed the same run diverges at **step 2** (`P0On` True vs False, 299/300 lines) and never kills by patch, and the input's phase is asserted against the recording's own state trace (the counts the ring reads at step N are the ones the recording printed at step N-1). An unportable body with no binding, or a runtime property the port has no live source for, is still a **refusal by name** (`CppPropertiesRefusalError` — the `run_cppprops.mjs` exit-3 contract), never a 0. Tests: `tests/cppprops-sim-engine.test.ts`, `-growers-dyn`, `-zero-input` (10 tests) over `tests/cpppropsSimWorld.ts` |
| W1h: the `FoodPatchTokenRing` binding's engine input `FoodPatch::agentInsideCount` — its recording, its step phase, and the binding's own parameter parsing | `tools/cppprops/{fixtures/harness/record_scenario.py, fixtures/manifest.json, verify_cppprops.py, lib/cppprops.mjs, bindings/foodpatch_tokenring.mjs}` | **closed by `growers_ring` (L10 environment).** `getStatusText` does print the counts (`Simulation.cc:5183-5214`, gate hard-coded on) — the harness dropped the lines, so `record_scenario.py` now records them per step (`foodPatches`) and the manifest's `engineFromState` feeds the binding a per-step table (`--engine`). Measured on the new fixture: the recorded inputs reproduce all 300 farm lines, the old default (0) diverges at step 2 (222/300 steps), and reading step N's counts instead of N-1's diverges at step 26 — the phase the native pins by construction (counts accumulate at the END of a step in `DeathAndStats`; the ring runs at the START of one, `Simulation.cc:648`). Two extra defects the fixture caught, both fixed: the binding never parsed `add()`'s parameters (the worldfile's inline `//` comments became the argument text, so `maxPopulation`/`timeout`/`delay` were `NaN` and every switching branch was silently off — the earlier agreement was vacuous), and `dyn` bodies must run against the previous step's runtime values (`Step` excepted — `lib/cppprops.mjs`, pinned by the farm log's `B0Z2` at step 186/187). Still delegated, not replayed: the `onActivatePatch` kill — **executed since L11's `t_23d13a7b`**: the sim's engine context runs it (`ctx.engine.onActivatePatch` → `state.cc:205-213`'s `SetDeathByPatch` walk in `src/model/sim/cppProperties.ts`), and the replay carries the deaths too (181 → 139 at step 7, `fNumberDiedPatch` = the recorded 67) |
| L11: the `dyn` growers worlds (`growers_ring`, `growers_dyn`, `growers_small`) are the first runs the port completes on a **Groups brain with the `LOCAL` wiring roles on** (`EnableTopologicalDistortionRngSeed`/`EnableInitWeightRngSeed True`) — every recorded Tier-A parity scenario keeps both `False`. **`t_05b45824` (2026-09-28): the `LOCAL` wiring is now differentially verified byte-for-byte, and the one-agent drift is bounded to a named mechanism — a knife-edge f32 rounding in the accumulated `fYaw`, flipped by this lane's activation residual, not a wiring error** | `src/model/sim/bindings.ts` (`PORT-NOTE(sim/brain-local-rng-provider)`), `src/model/brain/core/groups/groupsBrain.ts`, `src/model/agent/agent.ts` (`UpdateBody`'s yaw chain), `src/model/sim/native/simprobe_steps.cc` (`%a` nerve print, added here) | L6/L11: measured on `t_23d13a7b` (2026-09-28), all three worlds reproduce the recorded farm log exactly — every cppprops-owned column at **300/300** steps, and `growers_ring` at **300/300 on all nine columns** — and then their **agent count** drifts by one (`growers_dyn` first at step 239, `AgentCount` 273 vs 274; `growers_small` at step 267, 279 vs 280), and from there the count columns *oscillate* around the recording rather than sitting one off: re-measured from the port's farm lines against the pinned log, of the **62 steps from 239 in `growers_dyn` the port matches the recording on 15** with `port − native` = `−4:3, −3:7, −2:3, −1:24, 0:15, +1:7, +2:1, +3:1, +4:1` (step 274 `274 vs 272`, step 286 `271 vs 275`, step 297 `282 vs 278`), and `growers_small` matches on **7 of the 34 steps from 267** with `−1:13, 0:7, +1:8, +2:3, +3:2, +4:1` (step 300 `292 vs 288`); what is *permanent* is the **counter**, not the column — the port's birth count stays exactly one short (`born` 228 vs 229 from 246 in `growers_dyn`, 268 vs 269 from 267 in `growers_small`) while every `dyn`-owned column keeps agreeing at every step. `growers_ring`'s only late residue is a single read-point count (step 299, patch 2: 21 vs 20). **`t_05b45824` closed the question.** *(1) The wiring is right, byte-for-byte.* `--RecordSynapses True` on both sides (`record_scenario.py … --args '--Vision False --RecordSynapses True'` vs `runWorld( …, { args: […] } )`) writes `run/brain/synapses/synapses_<agent>_{incept,birth}.txt.gz` — the **grown synapse list** (`from to efficacy learnrate`) — for all 180 seeded agents, and every one of the port's **360 payloads is byte-identical to the native recording's** (0 differing; the growth is not a tie: agent 100's dump carries 77 synapses with real efficacies). The anatomy dumps match too (360/360) but their matrix is all-zero at those two dumps, so the synapse list is the evidence. *(2) The drift is one f32 rounding in the yaw accumulation, and its input is the brain's activation, not the wiring.* Bit-exact differential through this lane's own native step probe (`src/model/sim/native/run_simprobe_steps.sh <fixtures/worldfiles/growers_dyn.wf> 220 137 50`, `QT_QPA_PLATFORM=cocoa`, `%a` prints of `agent::x/z/yaw` plus the two steering nerves via `GetNervousSystem()->getNerve("Yaw"/"YawOppose")` — the nerve print is the probe extension this card added; the probe's x/z for the watched agents match the recorded run's to the print for all 170 steps, so it is the arbiter): agent 137's `yaw` is **bit-identical for 156 steps and then 1 ulp high at step 157** — `0x4561d76a` port vs `0x4561d769` native, i.e. `2.44e-4` degrees. The position follows one step later (1 ulp of x at 158; x heals by 167, z keeps a `2.3e-5` offset for the rest of the run), the first `run/events/energy.log` row that differs by 1 ulp is that agent's fight at step 170, the x-sorted contact order changes at 225, agent 326's fight **pairing** changes at 227 (port fights #60, native #362 — a `0.195` energy swing), and *that* is the entire cause of the extra `ENERGY` death at 239 (`died 123 · -energy 91` port vs `122 · 90` native) and of the permanent one-*birth* deficit that follows it (the birth counter one short from 246 — `born` 228 vs 229 — with the population columns oscillating around the recording as the row's first paragraph states). `growers_small` is the same class at its own knife edge, one decision later: **one `BIRTH` short, first at 267** (`born 268` vs `269`, population 279 vs 280), with its death counters still agreeing at that step. *(3) Negative controls, both directions.* Given the **native's** nerve values, the port's own chain — `dyaw = f32(yawNerve − yawOpposeNerve)`, `I = f32(f32(dyaw·geneCache.maxSpeed)·YawRate)`, `fYaw = f32(yaw + I)` — reproduces native's `yaw` **bit-for-bit** at every step through 157 (and at agent 50's step 213, the second sample), so the arithmetic and the chain are not the defect; and the disassembly agrees with the port's shape (`fmul d0…fcvt s0` on the `double` dpos chain, `__sincos_stret`, two `fmul s`, `fadd s`, `addyaw`; `DEGTORAD` is bit-identical to the binary's `0x3f91df469963e11d`). The difference is upstream, in the *activation*: the port's `Yaw` nerve differs from native's in the low mantissa bits from step 3 on — median `|Δ| / |native|` **8.9e-14** for agent 137's `Yaw` nerve over the probe's steps 1–170 (`n = 170`, bit-equal on 18 of them, max `2.4e-6`) — quoted with that window because the median is window-dependent (`5.4e-14` through step 157, `5.0e-13` through 213, and a rolling 20-step window anywhere in `0…6.1e-7` for windows starting ≤159 — over all 211 starts of the 220-step probe the rolling-20 median reaches `6.4e-6` from step 188 on, and the single-step max `2.7e-5` sits at step 217, which is why the row's `2.4e-6` is scoped to steps 1–170), and on `YawOppose`, whose values sit near zero, the same window's median is `5.4e-12` (~60× larger), so relative differences are quoted on the `Yaw` nerve only — which is *not* “one double ulp”: at those magnitudes `8.9e-14` is ≈ `800` double ulps, i.e. `1.5e-6` of a single `float` ulp — all of it far under the `%g` resolution both `run/brain/function/brainFunction_137.txt.gz` and the probe's first print showed (`0.639305` both sides). So the trigger is **L6's known activation residual class** (its own native differential: activations bit-exact 87/96 `firingrate` · 83/96 `taugain` · 101/102 `spiking`), amplified by a *float* accumulator: whenever the yaw sum lands within the increment difference (`~1e-5` of `~15`) of a rounding boundary, the last bit flips — a couple of agents per 300-step run, at steps nothing in the recording can predict. *(4) Pinned at the event level* in `tests/cppprops-sim-engine-growers-{dyn,small}.test.ts`: the sim's own `getStatusText` counters against the recording's own population history (`agents = created + born − died`, so through step 245/273 the recording's death/birth count is recoverable from the farm log alone) — exactly one extra `ENERGY` death from 239 in `growers_dyn`, exactly one missing `BIRTH` from 267 in `growers_small`, both guards released if another lane removes the drift. *(5) Two gaps found while measuring, both since closed, neither this drift's cause:* `agent::UpdateBody` reaches `__sincos_stret` (Apple's *double* pair) where `src/model/agent/agent.ts` called `Math.sin`/`Math.cos` — **landed (`t_1263719e`, 2026-09-28):** that motion site now calls lane W1d's transcribed `libm.sin`/`libm.cos` (the `_stret` pair), pinned in `tests/agent.test.ts` by the call site *and* by the measured disagreement with V8 — **847 (`sin`) / 953 (`cos`)** of 20,000 `f32` yaws in `[0, 360)`, with **0** flips of 80,000 (`yaw`, `dpos`) samples after the `f32` narrowing, which is why no recorded artifact can catch a revert; and the per-agent file recorders (`run/energy/agents/*`, `run/brain/{anatomy,synapses}/**`, `run/BirthsDeaths.log`) appeared to be written for the seeded agents only — 180 of native's 492 agents, 181 energy rows of 493 — for these `Groups`/`SeedAgents 0` worldfiles, which was **the harness's split run root plus a missing end phase, not a recorder gap** (measured and fixed by `t_1263719e`, 2026-09-28). `tests/cpppropsSimWorld.ts`'s `runWorld` constructed the `Simulation` with `cwd` = the invoking cwd and then `chdir`'d to its temp `outDir` **before** stepping, while the recorders open `run/**` relative to the cwd *at open time* — the `init`-time sinks (`BirthsDeaths.log`, `lifespans.txt`, `max.txt`, …) open during construction, every per-agent file opens later, during the run — so the 20:54 driver measured **half a tree**: 181 `run/energy/agents/*` (the 180 seeded agents + `max.txt`), 360 anatomy dumps and 180 position files in the repo, with the run-time half still sitting in the reference run's temp dir (`/var/folders/6h/0db3wp8x1pjgz3cymwh1xjtw0000gn/T/cppprops-sim-9B4ztr/run` → 314 `energy/agents`, 842 `brain/anatomy`, 314 `motion/position/agents`, 214 `brain/function`); the **union is native's set exactly — 493 energy = 492 agents + `max.txt`, 1195 anatomy, 492 position, 492 function**. The harness also stopped stepping **without native's end phase**, so the buffered and deferred sinks never reached disk (`run/BirthsDeaths.log` 0 bytes against native's 9,636; 121 of the 181 datalib files 0 bytes; the 281 survivors' `brain/function/incomplete_brainFunction_<n>.txt.gz` absent) — native's own recording is complete only because the process exits: `End("MaxSteps")` posts the `SimEnd` event, `~TSimulation` kills the survivors with `DR_SIMEND` (281 `SIMEND` rows in `lifespans.txt`) and then `delete logs` closes every recorder. `runWorld` now `chdir`s **before** constructing the sim (one run root, `<outDir>/run`, as native's `cwd` never moves), makes native's extra `Step()` call when the budget reached the worldfile's `MaxSteps`, and always calls `sim.dispose()`; for the same world and args its tree then matches native's — **2958 of 2959 common files byte-identical**, all 1195 anatomy, 492 function, 492 position and 493 energy containers included, `BirthsDeaths.log` 9,636 B / 524 lines / 312 BIRTH + 211 DEATH, `lifespans.txt` 492 rows — the one exception being `run/energy/agents/max.txt` (native's own thread-completion row order, the same 492-row multiset; the L16/W1f rows and §"native's *model* artifacts are reproducible run-to-run"); the `generange.txt` RNG-seed gene rows are no longer an exception — `t_cc4faf49` closed them (both genes are built from native's four `long` fields, hence `IntNearest INT 0 INT 255`). It does not touch the farm-log comparison, which is the cppprops monitor's own path *(6) **`t_da2ab201` closed this drift (2026-09-28).** The residual's own root cause was in the row above's class, one lane up: the port's brain arithmetic rounded the product and then the sum where the shipped `libpolyworld.dylib` contracts them (clang `-ffp-contract=on`), so the `Yaw` nerve was ~1e-13 relative off from step 3 and the `float` yaw accumulator flipped at the knife edges. With `FiringRateModel`'s contractions transcribed through the new `fma64`, **the drift is gone and not by tolerance**: `tests/cppprops-sim-engine-growers-{dyn,small}.test.ts` now take their `divergenceCount === 0` branch — zero differing lines on all 300 steps, the counter identity included (`AgentCount`, `Alive0` and `born`/`died` all match), so the `ENERGY` death at 239 and the missing `BIRTH` at 246/267 that paragraph *(4)* pins are gone too — and `tests/cppprops-sim-engine.test.ts`'s `growers_ring` read-point residue ("step 299 patch 2 reads 21 where the recording printed 20") is gone with them (the test's own log line no longer fires: `mismatched.length === 0`). The causal link is pinned by mutation rather than by correlation: reverting **only** the two accumulation `fmadd`s (`FiringRateModel::update`'s two loops) while leaving the rest of the fix in place brings `growers_dyn` back to `31/300` differing lines, and the L6 probe back to its 87/96 census. Whole-run parity for the recorded scenarios is unchanged by the fix: `microtest_voff` **PASS 225/225**, `minitest_voff` **PASS 1369/1369**, all payloads byte-identical; `growers_*` have no oracle harness (`run_parity.sh list`), so those two tests are their evidence |
| W1h: the interpreter evaluates the C++ subset, not C++ | `lib/cppprops.mjs` (`new Function`) | no lane can close this without a real C++ evaluator; it is bounded by the extractor's `PORTABLE_SYMBOLS` list and by the fixtures. Known gaps inside the subset: integer division (`int / int` truncates in C++, not in JS), casts, and `float`-*value* arithmetic beyond the `Math.fround` at the store boundary (only the `float`/`double` mix the bodies actually use is modelled). None of the recorded bodies reaches any of the three |
| W1h: `STRING` `cpp` properties have no rendering | `lib/cppprops.mjs` (`formatNative` throws) | nothing — native aborts too (`PropertyMetadata::toString()`'s `default: assert(false)`). Recorded as a gap so the throw is a documented parity, not a surprise |

## PORT-NOTEs (W1a types + config accessors)

The frozen shared surface (`src/model/types/**`): the property-document + config accessors,
the globals singleton, the event structs and lifecycle enums, and the contract modules for
the rng/datalib/geometry cuts. Every semantic decision, and what it is anchored to:

| PORT-NOTE | File | Decision |
|---|---|---|
| `types/property-node-interface` | `types/property.ts` | native `Property`'s virtual coercions are split: the node carries the evaluated text (`scalarText()` == `getEvaledString()`), coercion lives in `scalar.ts` and is applied by `Config`. One definition, no per-lane parsing |
| `types/identifier-order` | `types/property.ts` | native `PropertyMap` is `std::map` ordered by `strcmp(Identifier::getName())`, so `elements()` iterates `"0","1","10","11","2",…` for an 11+ element array — not numeric order |
| `types/globals-singleton` | `types/globals.ts` | one mutable value-typed singleton, zero-initialized like native statics; the `Edges` string → flag mapping stays in the sim lane |
| `types/scalar-coercion` | `types/scalar.ts` | `toInt`/`toFloat`/`toBool` reproduced exactly: all-or-nothing strtol/strtof, `""` is 0 while `" "` is an error, bool is only `1`/`True`/`0`/`False` |
| `types/scalar-int-truncation` | `types/scalar.ts` | `(int)strtol(...)` outside int range: x86-64 gcc truncates to the low 32 bits (`9223372036854775807` → `-1`) |
| `types/config-error-is-a-throw` | `types/errors.ts` | native `err()` → `exit(1)`; the port throws `ConfigError` with the native wording (`"Expecting integer."`, `"No such property: 'X'"`, `"Expecting Float"`) |
| `types/event-structs-are-generic` | `types/events.ts` | events are generic over `agent`/`gobject`/`Energy` (default `object`), so `types/` does not depend on or invent another lane's shape |
| `types/event-type-field` | `types/events.ts` | native dispatches by C++ overload (`getType()`); the port stores the native `sim::Event_*` bit in a literal `type` field so a switch narrows |
| `types/event-null-pointers` | `types/events.ts` | `AgentBirthEvent.a` is null for `BR_VIRTUAL` births (native `Birth()` comment: "a will NULL for virtual births only") and `parent1`/`parent2` are null for `BR_SIMINIT`; `CarryEvent.obj` is never null |
| `types/lifespan-enums` | `types/lifespan.ts` | `BirthReason`/`DeathReason` values **and** `BR_NAMES`/`DR_NAMES` are the contract (written to `lifespans.txt`); one definition for L8/L11/L12 |
| `types/simconst-masks` | `types/simconst.ts` | `MATE__*`/`FIGHT__*`/`GIVE__*` bit values frozen (decoded by the contact log); member names flattened from the native preprocessor spelling |
| `types/gobject-type-bits` | `types/simconst.ts` | `graphics/gobject.h` object-type bits (`1/2/4`) kept apart from `sim::ObjectType` (0..4) — both are written to logs (`collisions.log` uses the enum, `carry.log` the bits) |
| `types/datalib-type-registry` | `types/datalib.ts` | `datalib::Type` values + the `#@T` tokens (`int/float/string/bool`) and the file-header tokens (`#datalib`, `#version=3`, `#schema=single\|table`, `#colformat=fixed\|none`) are frozen because the checker compares those bytes |
| `types/rng-surface-naming` | `types/rng.ts` | the PRNG entry points and which generator each maps to: glibc `rand`, glibc `drand48` (`randpw`), GSL MT19937 `gsl_rng_uniform` (LOCAL streams only), `gsl_ran_ugaussian`, and `nrand()` = Marsaglia polar with the persistent spare |
| `types/geometry-boundary` | `types/geometry.ts` | vector/colour/matrix/frustum interfaces are the *lane boundary* shape; native carries `xa/ya/za` on `gobject` and the faithful port + maths is W1e's |
| `types/memory-document` | `types/memoryDocument.ts` | in-memory `PropertyNode` double that encodes the frozen semantics (strcmp order, index == decimal name, duplicate names are an error) for lane tests and canned browser worlds; not a parser |

Verification for W1a: `npx tsc --noEmit` clean for `src/model/types/**` and `tests/types.test.ts`
(26/26 vitest), including oracle-anchored assertions that read the recorded goldens and check
the frozen tables against them — `lifespan` reason names in `run/lifespans.txt`, the datalib header
tokens in `lifespans.txt`/`population.txt`, the `events/collisions.log` object-type tokens
(`agent/food/brick/barrier/edge`), and the worldfile keys/values the config fixtures mirror.
`BirthsDeaths.log` is asserted to be *not* datalib (plain `fprintf`, `% Timestep …`).

## PORT-NOTEs (W1c datalib + files)

The columnar log format (`src/model/datalib/**`), ported from `utils/datalib.{h,cc}` plus the
file/compression half of `utils/AbstractFile.{h,cc}`. Every semantic decision:

| PORT-NOTE | File | Decision |
|---|---|---|
| `w1c/printf-float` | `datalib/printf.ts` | `%f` is computed from the *exact* decimal expansion of the IEEE-754 double (BigInt mantissa/exponent) with round-half-to-**even**, i.e. glibc's `FE_TONEAREST`. `Number.prototype.toFixed` resolves ties upward (`0.0078125` → `'0.007813'`, glibc prints `0.007812`), so using it would be a silent one-byte divergence on a float column |
| `w1c/int32-wrap` | `datalib/printf.ts` | an `INT` column is a C `int`: values go through JS `ToInt32` (modulo 2^32, NaN/±∞ → 0). Out-of-range C conversion is UB and platform-dependent (clang/arm64 saturates, x86 truncates); the model only feeds in-range values (steps, agent ids, counts) |
| `w1c/float32-columns` | `datalib/printf.ts` | a `FLOAT` column is rounded to float32 (`Math.fround`) before formatting — native stores and prints a C `float` (`TOVARIANT(double,float)` then `TOBUF(float)`), per PORT_SPEC rule 3 |
| `w1c/writer` | `datalib/writer.ts` | native's state machine reproduced literally: `singleSchema` allows one table only (`assert( tables.empty() || !singleSchema )`), the `randomAccess` path enforces fixed record length (`assert( nwrite == rowlen )`), and the footer's `#SIZE` line has **no** trailing newline |
| `w1c/row-tabs` | `datalib/writer.ts` | native appends a `\t` after every value and then erases the last one (`b--`), then writes `\n`; the port does the same literally rather than `join('\t')`, so the two agree even for a zero-column table |
| `w1c/latin1-bytes` | `datalib/sink.ts` | formatted text is encoded latin-1 (one byte per UTF-16 code unit) because native writes its `char *` buffers verbatim; for the ASCII the model produces this is encoding-independent, and it can never expand a character and shift the footer offsets |
| `w1c/gzip-path-endscheck` | `datalib/sink.ts` | native's `.gz` suffix test is `strstr( &path[strlen(path)-3], ".gz" )`, a pointer read past the end for paths shorter than 3 chars; the port checks the suffix properly (identical observable behaviour for every path the model uses) |
| `w1c/abstract-file-autodetect` | `datalib/sink.ts` | when both `p` and `p.gz` exist, native resolves the ambiguity with `if( &abstractPath[len-3] )` — a non-null address, so the condition is always true and **gzip wins**, contradicting its own comment. Ported as-is (PORT_SPEC rule 1) |
| `w1c/reader-asserts` | `datalib/reader.ts` | native's reader has no error path (malformed file → `assert` → abort). The port throws `DataLibFormatError` with the same conditions (signature, version range, digest bounds, unknown table/column, row out of range) |
| `w1c/reader-bool-columns` | `datalib/reader.ts` | native's row parser asserts on a `bool` column (the `add_col` switch has no `BOOL` case), so reading one cannot work in native either; the port throws instead of inventing behaviour |
| `w1c/reader-no-formats` | `datalib/reader.ts` | a column's *format* is writer-only state; native's reader rebuilds columns from `#@L`/`#@T` with `format = NULL`. Re-writing a `%.2f` file (the position logs, `logs/Logs.cc:345`) therefore needs the format re-supplied by the owner of the schema — documented, not "fixed" |
| `w1c/birthsdeaths-seam` | `datalib/birthsDeaths.ts` | `run/BirthsDeaths.log` is a bare `fprintf` file, not datalib. W1c owns the *bytes* of a line (`BR_SIMINIT` and `DR_SIMEND` write nothing, `BR_VIRTUAL` prints a literal `0` for the agent id); L12 owns the event plumbing and L11 raises the events |
| `w1c/gzip-deferred` | `datalib/nodeFile.ts` | gzip is compressed once at `close()` (`flush` is a no-op) — see the Deviations row |
| `zlib-deflate/upstream-transcription` | `compress/zlibDeflate.ts` | dependency-free, browser-safe transcription of upstream zlib 1.3.1 `deflate_slow` + `trees.c` at the frozen configuration (level 6 / memLevel 8 / windowBits −15 / default strategy / one `Z_FINISH`). `tr_static_init` is computed, not tabulated; the gzip header is the goldens' `1f 8b 08 00 00 00 00 00 00 13`; CRC32 table generated. `deflate_stored`/`fast`/`rle`/`huff`, `detect_data_type` and the wrapper state machine are not ported (unreachable at level 6 / default strategy, or never reach the stream) |
| `w1c/gzip-upstream-writer` | `datalib/nodeFile.ts`, `logs/nodeFiles.ts`, `logs/seams.ts` | the container writer is `gzipContainer`, so the node and browser gzip paths agree byte-for-byte; `node:zlib`'s `gzipSync` and `CompressionStream('gzip'\|'deflate-raw')` are both a different deflate and must not be used to *write*. Reading keeps `gunzipSync` |
| `w1c/index-surface` | `datalib/index.ts` | `index.ts` re-exports the format and the frozen registry but **not** `nodeFile`, so importing the format never drags `node:fs`/`node:zlib` into the browser bundle |

Verification for W1c: `npx vitest run tests/datalib.test.ts` → **20/20**, `npx tsc --noEmit`
clean for the lane. The byte-for-byte evidence is the corpus test, which reads each recorded
artifact with the ported reader and re-writes it with the ported writer, then diffs bytes:

```
microtest_voff: 60 datalib files, 83 tables, 416 rows re-written
minitest_voff: 184 datalib files, 269 tables, 25630 rows re-written
```

That covers all recorded header variants (`single|table` × `none|fixed`), the padded
fixed-length `energy/agents/agent_*.txt` records, and the 24-table `genome/separations.txt`
(whose footer bookkeeping — `offset`/`data`/`nrows`/`rowlen` per table — is itself a byte
checksum). `run/lifespans.txt` is additionally reproduced from a literal row set, and both
`lifespans.txt` and `BirthsDeaths.log` (microtest header-only; minitest 62 BIRTH + 64 DEATH)
are diffed against the goldens. `%f`/`%.2f`/`%-20f`/`%d`/`%5d`/`%-20d`/`%s`/`%-20s` are
pinned against 168 vectors generated by clang on this machine (tie cases included), and the
gzip path is pinned against a `gzopen`/`gzwrite`/`gzclose` reference compiled in-test.

## PORT-NOTEs (W1b proplib core)

The property language front end (`src/model/proplib/**`), ported from
`library/proplib/{parser,dom,builder,editor,schema,convert,writer,expression,overlay}.*`. Its
output is `run/normalized.wf`, and every decision below exists because it can move a byte in
that file (or in `run/converted.wf`) or because it keeps a failure loud:

| PORT-NOTE | File | Decision |
|---|---|---|
| `proplib/throw-not-exit` | `error.ts`, `dom.ts` | native `err()`/`exit(1)` becomes `throw ProplibError`/`ConfigError`; both native message shapes are preserved (`<source>:<lineno>: <msg>` for parse/tokenizer, `<path>:<lineno>: ERROR! <msg>` for the document) |
| `proplib/source-encoding` | `error.ts`, `cli.ts` | documents are read and written **latin-1** (one JS char == one byte), so `parse → write` round-trips every byte and a byte-exact golden still compares equal |
| `proplib/token-decoration` | `lexer.ts` | whitespace and comments are *tokens*; each ordinary token carries the decoration chain that preceded it, and that chain **is** the output formatting (`writer` re-emits `decoration + text`). Native's intrusive list is kept as an ordered array |
| `proplib/istream-semantics` | `lexer.ts` | the exact `std::istream` behavior that matters: `get()` at end of input fails (only then — the final byte still reads), `peek()` → EOF, `_lineno` counts consumed newlines, `unget()` undoes one byte. A token's `lineno` is the line it *starts* on, and every token (decoration included) is numbered |
| `proplib/syntax-node-tokens` | `syntax.ts` | the parse tree keeps token *identity*, not copied text — locations (ordering, error text) and verbatim re-emission both depend on it |
| `proplib/synthesised-locations` | `parser.ts` | a synthesised value (`editor.set`, `--Key Value`) gets the location of the property it replaces, which is why `  Vision False` in `normalized.wf` is indented like the schema's `  default True` and not like the command line |
| `proplib/expression-clone` | `expression.ts` | native `Expression::clone()` is a `// todo` returning `this`, so a cloned default shares the *schema's tokens*. Load-bearing: it is why an injected value's text/indentation are the schema's. Kept as-is |
| `proplib/evaluator-seam` | `evaluator.ts` | native pipes Python to a child process per read; the port injects one `ExpressionEvaluator` per document build and calls it from `Property.getEvaledString()`. `Expression` is passed **by tokens** because native's code generator switches on token type and resolves symbol paths (enum value / class name → quoted literal, property → its value, otherwise a bare Python symbol) |
| `proplib/schema-literal-evaluator` | `evaluator.ts` | the pre-L4 stand-in, **no longer any default**: answers only when native's Python result is provably the identity — a number/string/`True`/`False`/`None` token, or a symbol resolving to an enum value or class name — drops a trailing `;` the way native does, and **throws** for anything else. Kept because it is how the seam's tests drive it (`scriptedEvaluator`, the "cannot silently disagree" harness); `interpreterEvaluator` is the default |
| `proplib/python-codegen` | `evaluator.ts` (`generatePythonExpression`) | native `ExpressionEvaluator::evaluate`'s code generation, rule for rule: decoration before each element (skipped for the first), a trailing `;` dropped, an enum value/class name → `"name"`, a property → its evaluated value (quoted when the property is an enum or a `String`), an unresolved path → verbatim ("Hopefully a Python symbol"), a non-scalar or runtime reference → native's error text. Exported so a test can assert what was handed to the interpreter |
| `proplib/python-expression-subset` | `pythonExpression.ts` | the language itself, ported: Python ints are `bigint` (`/` is true division, `//` floors, `%` takes the divisor's sign, `**` is right-associative), floats are f64 with Python's `str()`/`repr()` (shortest round-trip, positional in `[1e-4, 1e16)` and `1e+16`/`1e-05` outside, `inf`/`-inf`/`nan`), comparisons chain and never coerce across types, `and`/`or` return an operand, `A if C else B`, subscripts/slices, container literals, and a builtin table (`len int float str bool abs min max sum round pow repr ord chr sorted list tuple dict set divmod`). `round` is half-to-even on the *exact* value (BigInt ratio, not the decimal string). Model of the fallback for a failure: native's `[Python] <message>` (`interpreter.cc` wraps the child's `F`-frame) |
| `proplib/python-refusals` | `pythonExpression.ts` | grammar CPython evaluates but the port refuses **loudly** (`port: …`) instead of approximating: `lambda`, comprehensions, generator expressions, f-strings, `bytes`, complex literals, `%`-formatting (str `%`), the walrus operator, and Python attribute access (`1 .real`). No worldfile expression reaches any of them — every enum/class path is substituted during code generation — so these are `PythonError`s, never wrong values (rule 1) |
| `proplib/python-syntax-errors` | `pythonExpression.ts` | a syntax error's *text* is not reproduced verbatim (`invalid syntax` vs CPython's `invalid syntax (<string>, line 1)`); the contract is that it fails, at the owning property's location, which is what native's `prop->err( "[Python] " + msg )` did. Runtime failures **are** verbatim (`name 'X' is not defined`, `division by zero`, `can only concatenate str (not "int") to str`, `min() arg is an empty sequence`, …), pinned by the recorded vectors |
| `proplib/python-pow-float` | `pythonExpression.ts` | **closed in `t_6c85ff6f` (L4, 2026-09-28)**: `**` on floats called V8's `Math.pow` where CPython calls libm `pow`. Both sites now call L1's transcription (`src/model/rng/libm.ts`, `t_9ed428d7`): the float branch (`powFloat`, the helper the AST's `BinOp`/`Pow` path reaches) *and* the `int ** negative int` branch, which is the same function, not an integer one — CPython's `long_pow` hands that case straight to `float_pow` ("This works because we know that this calls float_pow() which converts its arguments to double"), so it is `pow` on two doubles like the float branch. The divergence was real, not theoretical: on a 360-pair sweep of the `b ** e` shapes an expression can write (24 bases × 15 exponents), V8's `Math.pow` disagrees with this machine's CPython 3.9.6 on **48/360 (13.3 %)** and the transcription on **0/360** — `2.0 ** 3.5` is `11.313708498984761` in CPython and `11.31370849898476` under V8, `2.0 ** -3.5` `0.08838834764831845` vs `0.08838834764831843`. No recorded worldfile raises a float to a power (no `.wf`/`.wfs` in the tree contains `**`), and the recorded vector corpus reaches the swapped branches only at `2.5 ** 2` and `2 ** -1`, where the two functions agree, so **no frozen artifact moves**: port fidelity, not a parity improvement the goldens can show. Integer `**` untouched (exact `bigint` arithmetic) and no domain handling changed. Cost, measured rather than assumed, because a `[user,…]`-style expression can be evaluated per agent per step: the transcription is 251–748 ns/call on its fast path and 1070–1169 ns on the negative-exponent ladder (V8's `Math.pow` 4–12 ns on constant arguments — the ~20x of `W1d-fu/pow-is-transcribed-not-approximated` holds for the ladder), which takes `evaluatePythonExpressionText('2.0 ** 3.5')` from 0.78 us to 1.07–1.14 us over a 0.38–0.42 us lex+parse+eval floor. Kept: the alternative is a function that computes a different number. Both halves are reproducible with `npx tsx tools/measure_proplib_pow_cost.ts` (the sweep, the per-call timings, the end-to-end timings) and pinned by a `tests/proplib.test.ts` case on the two inputs where the functions disagree |
| `proplib/python-float-repr` | `pythonExpression.ts` (`pyFloatRepr`) | the one formatting rule re-derived rather than computed: ECMAScript's shortest round-tripping digits (`toExponential()`), formatted with CPython's `repr` rules (positions, exponent thresholds, `inf`/`nan`). Pinned by the recorded vectors (`0.1`, `1.0`, `0.1 + 0.2`, `1e16`, `1e-5`, `0.0001`, `-0.0`, `1e309`, `float("nan")`, `round(2.675, 2)`) |
| `proplib/dependency-cycle` | `evaluator.ts` | native's `_isEvaluating` flag is per-property (`Dependency cycle` when an expression reaches its own property); the port's evaluator is document-wide, so the flag is the set of properties currently being evaluated — same semantics (A→A, A→B→A), pinned by a test |
| `proplib/property-map-order` | `dom.ts` | native `PropertyMap` is `std::map<Identifier,…>` compared with `strcmp`, so `props()` iterates `"0","1","10","11","2",…`; the port returns the same order. Array *output* stays numeric because `writeArray` looks elements up by index name |
| `proplib/scalar-error` | `dom.ts` | native `__ScalarProperty::getp/get` **error**; the frozen interface specifies `undefined` for `getp`, `0` for `size()`. The public surface follows the frozen contract (so the real document and `memoryDocument.ts` agree), while the front end's internal `getpProp`/`requireProp` keep the native failure |
| `proplib/error-text-split` | `dom.ts` | see the Deviations row: frozen read-path errors are name-based, front-end errors are location-based |
| `proplib/location-lineno-unsigned` | `dom.ts` | native `_lineno` is `unsigned int`, so the default `-1` reads back as 4294967295 in comparisons *and* in `getDescription()`. The port keeps the wrapping arithmetic (`(ua - ub) \| 0`) and the unsigned test rather than papering it over |
| `proplib/symbol-path-cursor` | `dom.ts` | native walks a symbol path as a linked list (`name->next`); the port passes the path plus an element index, traversing identically |
| `proplib/builder-takes-text` | `builder.ts` | native reads the worldfile with `ifstream` and `cp`s it beside the run; the port takes document *text* and keeps the path only as identity, so nothing under `src/model/**` imports `node:fs` (the browser bundle can load the parser) |
| `proplib/v1-conversion-path` | `builder.ts` | a v1 worldfile is converted to `<path>.v2` in native (on disk) and *parsed from there*, so the document's path — the first ordering key — is the `.v2` name. Reproduced in memory with the same identity |
| `proplib/isv1-empty-file` | `builder.ts` | native's `in.get() != '@'` is true for an empty file too, so an empty worldfile is reported as v1. Kept |
| `proplib/editor-err` | `editor.ts` | `editor.cc` has its own message-only `err()` (no location); those failures keep that shape |
| `proplib/converter-streams` | `convert.ts` | `convertV1SyntaxToV2` returns the converted text instead of writing `path.v2`; the `.v2` identity is preserved by the builder |
| `proplib/rawval-cast` | `convert.ts` | native `RAWVAL(prop)` is a `dynamic_cast` + null dereference if the property is not a const scalar; the port raises a clear error instead (every property it is applied to is a const scalar in the schema) |
| `proplib/schema-injected-default-location` | `schema.ts` | an injected default is a **clone of the schema's `default` property** and keeps the schema's file/line/token location. That single fact is why `normalized.wf`'s schema block is in schema-declaration order and why the schema's own indentation survives |
| `proplib/validate-option` | `schema.ts`, `index.ts` | `validate` is opt-in at the facade and the pass is read-only, so the emitted bytes cannot change (measured: `validate: true` reproduces the same bytes for all four variants). It used to be opt-in because it evaluates values (lane L4); now that the language exists, `apply` keeps the native default (on) and the facade keeps `false` so the browser boot and the sim runner can present the defaults/validation split — a caller reproducing native's ctor passes `validate: true` |
| `proplib/writer-returns-text` | `writer.ts` | native streams into an `ostream&`; the port accumulates and returns the text (byte-identical), keeping `write( doc )` and the "previous property's document" state |
| `proplib/writer-missing-token` | `writer.ts` | native dereferences NULL when a token a writer looks for is absent; the port raises a located error, because a silently short file is a worse failure than a stopped build |
| `proplib/cli-fs` | `cli.ts` | the lane's only `node:fs` user; nothing imports it, so it never enters the browser bundle |
| `W1b-tests/live-run-is-not-a-fixture` | `tests/proplib.test.ts` | the suite's first cut compared the minitest emission against `<native>/run/normalized.wf` whenever that file existed. That path is **not** a fixture: `tools/record_oracle.py` rotates `run/` to `run.previous.<epoch>` before every native run and every lane records its own scenarios, so the shared `npm test` gate went red — reading as a W1b parity break — whenever the last record belonged to another run. At the time of writing, `run/` held `microtest_von`'s bytes (11,886 B, `--Vision` unset) against the minitest golden's 11,889 B, and the *only* run tree on disk that held the minitest bytes was a displaced `run.previous.<epoch>` copy. The live tree is now *identified* before it is compared: `run/original.wf` names the worldfile, the variant comes from the run's own `normalized.wf` matching that variant's recorded golden, and anything else — another scenario, an unrecorded variant, a torn file from a record in flight — skips **visibly** instead of asserting |

Verification for W1b — `npx vitest run tests/proplib.test.ts` → **36/36** (30
lexer/parser/DOM/writer/schema/convert, 4 variant goldens + 1 live-run check, 1 public
surface), `npx tsc --noEmit` clean for the lane. The acceptance evidence is byte equality
with the frozen goldens, for **all four recorded variants** — `--Vision` *unset* is a
different parameter map from `--Vision False`, and both are exercised:

```
$ npx vite-node src/model/proplib/cli.ts -- --root ../polyworld \
    --worldfile worldfiles/tests/low-spec-pc/minitest.wf --set Vision=False \
    --converted-out /tmp/w1b/converted.wf --normalized-out /tmp/w1b/normalized.wf
proplib: worldfiles/tests/low-spec-pc/minitest.wf -> converted.wf 187 bytes, normalized.wf 11889 bytes

$ cmp /tmp/w1b/normalized.wf oracle/minitest_voff/run/normalized.wf          # identical
$ cmp /tmp/w1b/converted.wf  oracle/minitest_voff/run/converted.wf           # identical
$ shasum -a 256 /tmp/w1b/normalized.wf oracle/minitest_voff/run/normalized.wf
51d19575c2a84518c6c5e7b6aac9c8dc05ef5d06f4ae76eeeb0bbc3a1237c47f  (both)

| variant          | native args        | normalized.wf | converted.wf | sha256(normalized.wf) |
|------------------|--------------------|---------------|--------------|-----------------------|
| `minitest_voff`  | `--Vision False`   | 11,889 B      | 187 B        | `51d19575…7c47f`      |
| `minitest_von`   | *(none — default)* | 11,888 B      | 172 B        | `929fe27b…e810b`      |
| `microtest_voff` | `--Vision False`   | 11,887 B      | 185 B        | `2e8ea4a9…3ace`       |
| `microtest_von`  | *(none — default)* | 11,886 B      | 170 B        | `b23243b6…23b7`       |
```

all four byte-identical to `oracle/<scenario>/run/{normalized,converted}.wf`, emitted from
the native schema + worldfile with the native-relative document identities and the
scenario's own parameters (`--Vision False` through the parameter path,
`setParameters` → `editor.set`; `*_von` passes no parameters at all).

Both the `normalized.wf` (post-`apply`) and `converted.wf` (pre-`apply`) artifacts are
compared, which localizes any future divergence: `converted.wf` failing means
lexer/parser/builder/writer/converter, `normalized.wf` alone failing means the
defaults/validation pass.

`oracle/**` is the reference — never `<native>/run/**`. That directory is rewritten by every
native record on this board, so the suite compares against it only after *identifying* the
run from its own bytes, and skips (visibly) otherwise; see the
`W1b-tests/live-run-is-not-a-fixture` PORT-NOTE above for what that cost the shared gate
before it was fixed.

## Lane L4 — proplib expressions (`src/model/proplib/{evaluator,pythonExpression}.ts`)

Native evaluates no worldfile expression in C++: `interpreter.cc::ExpressionEvaluator::evaluate`
renders the expression's tokens as Python source (decoration, dropped trailing `;`, enum/class →
quoted literal, property → its evaluated value, unresolved → verbatim) and pipes it to a long-lived
`python3` child (`interpreter.py`) whose reply is `str( eval( text ) )`; a failure comes back as
`prop->err( "[Python] " + message )`. The port keeps the seam (`ExpressionEvaluator`, called from
`Property.getEvaledString()` with the token list and the owning property) and ports both halves:
`generatePythonExpression()` is the code generation, `pythonExpression.ts` is the language, and
`interpreterEvaluator` is the default for every document build (`DocumentBuilder`,
`emitNormalizedWorldfile`, the monitor documents, the browser boot, the sim runner).

**Acceptance (all reproduced in this run):**

* `npx vitest run proplib` → **49 passed / 1 skipped** (the skip is the shared-native-`run/` check,
  which skips when the recorded run is not identifiable — unchanged W1b behavior; 48 of the 49 are
  L4's own, the 49th is `t_6c85ff6f`'s `**`-calls-libm-`pow` case; re-measured 2026-09-29, same
  figures).
* **Byte comparison of both artifacts against `oracle/<scenario>/run/*.wf` for all four recorded
  variants, with the real evaluator and `validate: true`** (native's ctor validates): `converted.wf`
  and `normalized.wf` identical for `minitest_voff` / `minitest_von` / `microtest_voff` /
  `microtest_von`; and **every scalar in each document reads** (`Config`'s boot reads), which is the
  half that was blocked before.
* **The recorded native-interpreter vectors**: `native/record_python_vectors.py` runs the real
  `python3` over (a) the **121** Python texts this lane's *own* code generation produced while
  building those four variants with validation on, and (b) **261** curated language/adversarial
  cases — 377 vectors, of which 26 are failures whose message must match word for word (`name 'X' is not
  defined`, `division by zero`, `can only concatenate str (not "int") to str`, `min() arg is an
  empty sequence`, …). Recorded with `python3` **3.9.6** (the interpreter on `PATH`, which is what
  native's `execlp( "python3" )` used on this machine); `str()` of a float is version-independent
  since 3.1 and the fixture names the version it was recorded with. `tests/proplib.test.ts` compares
  every one, and a separate case pins that the grammar the port refuses (`lambda`, comprehensions,
  f-strings, `bytes`, complex, `%`-formatting, walrus, Python attribute access) is refused with
  `port: …` rather than evaluated wrongly.
* `npx tsc --noEmit` → exit 0; `npx vitest run` → **451 passed / 1 skipped** (whole project, as
  measured on this lane's acceptance pass; the count moves as lanes land — **48 files / 729 passed |
  1 skipped** on `b2bbcaf`, 2026-09-29).
* Cross-lane checks that now run on this evaluator: L14's monitor documents (**89 + 89** native
  leaves in `native/vectors/monitorConfig.{term,gui}.json`) and the L18 browser read plan
  (**nothing blocked**, `InitAgents` reads 25).

**The bug the bytes alone did not catch (why the recorded vectors matter).** `normalized.wf` is
written from the *schema's tokens*, so the stand-in reproduced it byte-for-byte while never reading a
value: the first real reads of the recorded scenarios (`Barriers.0.X1` = `( 0.3333 if
RatioBarrierPositions else (0.3333 * WorldSize) )`) came out as `True` under a first cut of this
language whose conditional expression mapped its operands backwards (`A if C else B` parsed as
`C if A else B`). The `validate: true` pass and the recorded vectors caught it in seconds; the
artifact comparison could not have.

**Runtime (`runtime True`) and `dyn(...)` properties — what this evaluator does *not* touch.**
`docs/specs/cppprops.md` (W1h) documents the other half of the same native machinery: a `dyn(...)`
body is not Python at all — `cppprops.cc` emits it as C++ and compiles it (the port interprets the
same text, `tools/cppprops/lib/cppprops.mjs`) — so it never reaches `interpreter.py`, and this lane
does not change how `$[sim]->fStep`-style references resolve: they are the W1h interpreter's, keyed
by the property's native full name. What *is* this lane's, and is reproduced exactly, is native's
refusal to read a runtime property from a Python expression:
`evaluate()` errors with `Illegal reference to runtime property <path>. Only dynamic expresssions may
use runtime properties.` (and `Illegal reference to non-scalar <path>.` for a container), before any
Python runs — pinned by `generatePythonExpression()`'s codegen test.

### Gaps this lane leaves open (all loud, none silent)

| Gap | Where | Note |
|---|---|---|
| Grammar CPython evaluates but the port refuses | `pythonExpression.ts` | `lambda`, comprehensions/generators, f-strings, `bytes`, complex literals, `%`-formatting, the walrus operator, Python attribute access — each raises `PythonError('port: …')` at the owning property's location. No worldfile expression reaches any of them (an enum/class path is always substituted during code generation), so this is a *refusal*, not an approximation (rule 7: nothing silently disagrees) |
| A syntax error's text is not verbatim | `pythonExpression.ts` | CPython names the file and line (`invalid syntax (<string>, line 1)`); the port says `invalid syntax`. The contract is that it fails, which is what native's handler reported |
| ~~`**` on floats is V8's `Math.pow`, not libm `pow`~~ **closed in `t_6c85ff6f` (L4, 2026-09-28): both float sites call the transcription** | `pythonExpression.ts` | closed: the `powFloat` helper (the AST's `BinOp`/`Pow` path) and the `int ** negative int` branch — which CPython also implements with libm `pow`, its `long_pow` delegating that case to `float_pow` — now call L1's transcribed `pow` (`rng/libm.ts`, `t_9ed428d7`). It was the PORT_SPEC rule 3 libm class, and measurably so, not nominally: over a 360-pair sweep of the `b ** e` shapes an expression can write, V8's `Math.pow` differed from this machine's CPython on 48 (13.3 %) and the transcription on 0. Unreachable in both recorded scenarios (no `.wf`/`.wfs` in the tree contains `**`; the recorded vector corpus reaches the branches only at `2.5 ** 2`/`2 ** -1`, where the functions agree), so no golden moves — see PORT-NOTE `proplib/python-pow-float` for the measured cost |
| `is`/`is not` compares by reference for non-`None`/`bool` values | `pythonExpression.ts` | CPython interns small ints and short strings; the port's values are immutable objects, so `1 is 1` is `False` here. No worldfile expression uses `is`; documented rather than emulated |
| The language is a *subset* of Python 3, not a Python implementation | `pythonExpression.ts` | no imports (native had none either — the child ran bare `eval`), no modules, no classes, no statements; the builtin table is the documented one (`len int float str bool abs min max sum round pow repr ord chr sorted list tuple dict set divmod`) |

## Lane W1e — geometry primitives (`src/model/geometry/**`)

Vectors/colours, GL-convention 4x4 matrices, `gcamera`, `frustumXZ`, the polygon/bounds/
radius machinery and ray/sphere/plane helpers — the native `graphics/` maths with **no
OpenGL**: rendering is L16's problem (`src/model/geometry/*.ts`, 8 modules + a generated
golden module).

Goldens are generated from the *native* code path, not re-derived by hand:
`src/model/geometry/native/glprobe.{cpp,sh}` links the real `gcamera`/`gpoint`/`gpolyobj`/
`frustumXZ` objects out of the native build's `libpolyworld.dylib` and drives the same
fixed-function GL (Apple OpenGL 2.1 “Metal 90.5” + GLU 1.3) the oracle binary links, printing
`glGetFloatv(GL_PROJECTION_MATRIX)`/`GL_MODELVIEW_MATRIX` and the native float members.
`native/` is a probe, not part of the shipped model (clang++ + python3 stdlib; it links the
already-built dylib and `-framework OpenGL` and installs nothing).

```
$ bash src/model/geometry/native/glprobe.sh --ts
wrote src/model/geometry/golden/nativeCameraVectors.ts: f32=44 mat4=48 f64=78 bool=14
  fixtures={'glrotatef': 18, 'glperspective': 7, 'objpose': 4, 'camuse': 1, 'camfix': 1,
            'fqcase': 6, 'fqrad': 3, 'geom': 1, 'scene': 6, 'gltranslate': 1}
$ bash src/model/geometry/native/glprobe.sh --ts && diff <old> <new>   # regeneration is byte-identical
$ npx vitest run tests/geometry.test.ts
Test Files 1 passed (1) | Tests 38 passed (38)
```

38+ tests: **bit-exact** for `glTranslatef`, all 18 `glRotatef` axis/angle matrices, all 4
object-pose matrices, the `gcamera`/`gpoint` modelviews of the primitive and unattached-camera
fixtures, **every entry of every projection** (`m[0][0]` included — see `W1e/glu-perspective-reciprocal`),
every `frustumXZ` case (including the two `Set` wrap branches and the radius overload), the `gpolyobj`
bounds/radius states and the retina colour-byte rule; **≤1 ulp** for `m[2][2]` of the two recorded
*unattached-camera* matrices (the residual row below); **≤1 ulp** on the modelview translation column;
plus self-consistency tests (frustum planes vs the clip matrix, ray/sphere/plane/box against analytic
values, radius fix/unfix rules).

### Known residuals (measured against the probe's GL output)

| What | Residual | Why it is accepted |
|---|---|---|
| `gluPerspective` `m[2][2]` for the two *unattached-camera* fixtures (`near/far` 0.25/64, 0.5/16) | ≤ 1 ulp (`0xbf810101` vs the native `0xbf810102`; `0xbf884211` vs `0xbf884210`) | these are the only two recorded projection entries the port does not reproduce. Fitted directly against Apple's GLU 1.3 output over a 288-point `(fov, aspect, near, far)` grid (see `W1e/glu-perspective-reciprocal`), the best formulation reproduces 13 of the 15 recorded camera projections and 951/1152 grid entries; every alternative (f64 delta, f32 delta, narrowed numerator, reciprocal forms) misses at least these two. `m[0][0]` — the entry the aspect actually scales with — is bit-exact everywhere, as is `m[1][1]` |
| modelview translation column | ≤ 1 ulp | the value is a difference of ~11-magnitude products; the composition's per-term rounding (`W1e/compose-rounding`) is pinned on every *scene* camera, and the single case that moves is the both-pitch-and-yaw camera |
| modelview near-zero entries (e.g. `cos 90°` products composed twice) | absolute < 1e-6, sign may differ | pure cancellation noise around 1e-8 |
| world-space frustum plane `d` for a long far plane | ~0.13 absolute at `far = 150` | the plane normaliser is `1 + m[2][2]`, a cancellation of ~1.3e-4, so it amplifies the f32 residual of the clip matrix; the normals agree to 1e-4 and the *eye-space* planes (near/far) are exact to 1e-6 |

### The `atan2f` census (`t_d3f63606`) — *Open questions* 4, answered

`frustumXZ::Inside` (`gmisc.cc:335`) is the native tree's **only** `atan2` call site, and it
computes `float ang = atan2(x0 - p[0], z0 - p[2])` from two floats — so the oracle calls the
*float* overload `atan2f`; the port stands in `f32(Math.atan2)` plus the two ±π values
(`W1e/atan2f-pi`). The census measures the residue on the argument classes the model can reach
plus the whole float range either side of them:

```sh
bash src/model/geometry/native/atan2fprobe.sh identity   # the two dlsym'd symbols + the ±π arm
bash src/model/geometry/native/atan2fprobe.sh census     # raw/atan2f_args.txt -> raw/atan2f_native.txt
npx tsx tools/measure_atan2f.ts                          # the port vs the shipped atan2f, per class
npx tsx tools/witness_atan2f_wedge.ts                    # can a wedge limit land on a differing point?
python3 src/model/geometry/native/raw/verify_atan2f_correct_rounding.py 150   # which side is wrong
```

| argument class | rows | shipped `atan2f` != `f32(atan2)` | port `nativeAtan2f` != shipped `atan2f` |
|---|---|---|---|
| **all** | **20,050** | **3,924 (19.571 %), 1 ulp** | **460 (2.3 %), 1 ulp** |
| the exact ±π family | 4,130 | 3,464 | **0** |
| `pi-boundary` (zero/subnormal/tiny `x0 - p[0]` against a negative `z0 - p[2]`) | 1,890 | 1,747 | 0 |
| `reachable-lattice` (differences of WorldSize-25 world coordinates, the model's own lattice) | 4,532 | 226 | 204 |
| `reachable-uniform` (any float32 with `\|v\| < 256`) | 2,000 | 34 | 27 |
| `midpoint-sweep` (dense local sweeps about `y = ±x`, about `y = 0`, and across a decade) | 7,623 | 1,283 | 223 |
| `all-magnitudes` (the whole float range, both signs) | 1,500 | 346 | 1 |
| `binade-lattice` (exact powers of two, both operands) | 1,134 | 252 | 0 |
| `denormals` | 144 | 6 | 5 |
| `zeros` / `quadrant-edge` / `specials` | 177 | 30 | 0 |
| `equal-magnitude` / `octant-neighbour` (`y = ±x`, `±x ± 1 ulp`) | 1,050 | **0** | 0 |

The ±π family is not a class of its own — it is the 4,130 rows **of the twelve classes above**
whose `atan2f` result is ±π (mostly `pi-boundary`, plus the `zeros`/`quadrant-edge`/`denormals`
rows that land there), so that line overlaps them; the twelve class rows sum to the 20,050.

The wide sweep (not committed; `atan2fprobe.sh wide 200000`) repeats it at scale: 606,583 pairs,
`atan2f` != `f32(atan2)` **89,866 (14.815 %)**, port != shipped `atan2f` **18,279 (3.0 %)**, the ±π
family 0/102,734, `reachable-lattice` 5,811/108,707, `reachable-uniform` 681/50,000. Every
difference in every class is **1 ulp**, and `f32(Math.atan2)` agrees with `f32`-narrowed libsystem
`atan2` on every row, so the two candidate readings are V8 and the C library agreeing with each
other against the oracle.

*Which side is wrong.* The 60-digit reference (`raw/verify_atan2f_correct_rounding.py 200`) decides
**177 of 179** sampled differing rows for the correctly rounded value: the true angle is nearer
`f32(atan2)` on all 177 (median margin 0.133 ulp, i.e. not a coin flip on a midpoint), and on the
sampled agreeing rows the agreed value is within half an ulp of the truth (one row sits exactly on
a rounding midpoint). So arm64's `atan2f` is a **>0.5 ulp** implementation (a double-interior
polynomial in the ratio — see the card), and the transcription has to reproduce the platform's
error, not the correctly rounded value.

*Which side matters.* A 1-ulp difference in `ang` can only change an `Inside` verdict if a wedge
limit sits exactly on one of the two adjacent floats. `tools/witness_atan2f_wedge.ts` searches the
model's own wedge domain (`fov ∈ [MinHorizontalFieldOfView, MaxHorizontalFieldOfView] = [20, 140]`,
`yaw ∈ [0, 360)`, apex at the centre of a WorldSize-25 world) and finds one for **187 of the 244**
differing reachable pairs (|`y`|,|`x`| ≤ 12.5) — e.g. `yaw = 46.16395568847656, fov = 20` puts
`angmin` exactly on `0x3f219505` (the shipped `atan2f`'s value for `atan2f(2.84375, 3.890625)`),
where the shipped `atan2f` says inside and the port says outside. So the wedge limit **can** land
on a differing point.

*What it costs today: nothing.* `Inside` has no call site in `src/model/**` — the ported
`frustumXZ` is the pinned culling semantics, exactly as `W1e/frustumxz-is-dead-for-the-retina`
records — and native's `infrustum`/`outfrustum` counters (`gmisc.cc:330-331`) are never printed, so
no recorded byte in any of the six scenarios can observe the difference (all six re-run byte-identical).

*Verdict.* The premise of *Open questions* 4 is **false as stated**: the transcribed/`f32` form is
**not** exact off the ±π case — it misses 1 ulp on 2.3 % of a broad census and on 4.5 % of the
model's own argument class. The residual is therefore carded for transcription as **`t_4bb10112`**
(assignee `fullstack-dev-2`, the lane that transcribed `powf`) rather than left as an untested
claim, and the census above is its acceptance corpus.

*Transcribed (`t_4bb10112`, 2026-09-29).* The card landed: the port's stand-in is **deleted** and
`f32(Math.atan2)` is no longer anywhere in the model maths. `src/model/rng/libm.ts` now exports a
real `atan2f` — transcribed from the shipped machine code like `powf`, its nine polynomial
constants and eight angle constants extracted by `native/gen_atan2f_table.py` from a dump of the
running libSystem (`raw/dump_libm5.c` → `raw/atan2f_bytes.bin`, `raw/atan2fdis.s`; the generator
*decodes* the `adr`/`adrp`+`add`/`ldr <label>` displacements and refuses to emit if one stops
pointing at its constant, and pins the dump to the census' own `fnv1a256`), with the C
transcription `raw/apple_atan2f_impl.h` diffed against the census first — **byte-identical on all
20,050 rows and on all 606,583 rows of the wide sweep**. `src/model/geometry/float.ts`'s
`nativeAtan2f` is now a one-line delegation to it (the two ±π values are gone), the corpus is
replayed in `tests/rng.test.ts` (bit-exact, plus "the port is not `Math.atan2`: it is the wrong
function on 3,924 rows"), and `npx tsx tools/measure_atan2f.ts` reports `port != native` **0** in
every class and on every corpus.  The two things the transcription had to reproduce rather than
"fix":

* the shipped function is **float accurate, not correctly rounded** — its polynomial is a fit of
  the form `T8*(u^2+T0 u+T2)(u^2+T4 u+T6)*(u^2+T1 u+T3)(u^2+T5 u+T7)*r` in `u = r*r` whose error is
  **0.36 float32 ulp** over [-1,1] (the generator measures it; the `u^1` coefficient is
  `-0.333331738`, 4.8e-6 off the Taylor `-1/3`), computed in a double interior and narrowed once;
* the `x <= 0` arm's `|y/x| < 2^-22` branch answers `ATAN2F_PI_HI` = `f32(pi)` rounded toward zero
  plus exactly `2^-32` (`0x1.921fb4008p+1`), **not** `pi`.  That *is* the 0x40490FDA of the ±π
  family; `±π/2`, `±π/4` and `±3π/4` are the exact doubles, so those boundaries round correctly.

The residual's *evidence* is kept, deliberately, because the fix is invisible to every recorded
artifact: `f32(Math.atan2)` still differs from the shipped `atan2f` on 19.571 % of the corpus,
`tools/witness_atan2f_wedge.ts` still shows **187 of 244** differing reachable pairs whose wedge
limit lands on the differing float and flips `Inside` (reconstructing the deleted stand-in
locally), and native's `infrustum`/`outfrustum` counters are still never logged — so all six
scenario verdicts are unchanged (19/19 · 225/225 · 225/225 · 1369/1369 · 1308/1308 · 1373/1373).
Cost, measured the way `tools/measure_powf_cost.ts` does: **0.060 us/call** on the model's own
lattice, against the deleted stand-in's 0.174 and `f32(Math.atan2)`'s 0.021
(`tools/measure_atan2f_cost.ts`) — the transcription is ~3x cheaper than what it replaces.

### PORT-NOTEs (W1e)

| PORT-NOTE | File | Decision |
|---|---|---|
| `W1e/f32-discipline` | `float.ts` | every native `float` store is `Math.fround`; `double` expressions (the `DEGTORAD`/`TWOPI` literals, libm calls, `fmod`) stay f64 |
| `W1e/twopi-truncated` | `float.ts` | `TWOPI` is the native `6.28318530717059647602` **verbatim** — it is *not* 2π (off by 9e-12) and it is fed to `fmod` |
| `W1e/degtorad-truncated` | `float.ts` | `DEGTORAD` is the native `0.017453292` verbatim, not π/180 |
| `W1e/rotatef-trig` | `matrix.ts` | `glRotatef` converts the angle with a **float** product of the degree value and the `π/180` constant and evaluates sin/cos in **float** (the goldens show `cos 90° = -4.3711388e-08`; the double value is 6.1e-17) |
| `W1e/rotatef-radians-measured` | `matrix.ts` | the radians are `f32(f32(deg)·f32(π/180))` — the **f32** constant, not the full-precision one narrowed once. Measured on this machine's GL 2.1: 4,323/4,323 angles over `[-180°,180°]` × {x,y,z} exact for the f32-product form, 3,939/4,323 for the double-product form (the recorded goldens cannot separate them — both reproduce all six recorded angles) |
| `W1e/rotatef-signed-zero` | `matrix.ts` | GL leaves `-0` in some zero entries where an exact product leaves `+0`; values are equal, so comparisons treat ±0 as equal |
| `W1e/compose-rounding` | `matrix.ts` | matrices are column-major `m[col*4+row]` and composed as GL post-multiplies (`M ← M·N`) with **one f32 rounding per term** (`s = f32(a·b + s)`, the FMA chain) — not one rounding of the four-term dot. Measured: the recorded `gl.obj->minitest_a10_focus_min.modelview[14] = 0x3fbbff8a` is reproduced by the FMA chain, missed by f64 accumulation (`0x3fbbff87`); against live GL over 20,000 random compositions the chain is 15,485 exact vs 6,964 |
| `W1e/glu-perspective` | `matrix.ts` | native GLU is the SGI route with **f32** half-extents (`ymax = f32(zNear·tan(fovy·π/360))`, `xmin/xmax = ±ymax·aspect`); `m[1][1]` comes from those extents, which is what the goldens pin to the float tangent |
| `W1e/glu-perspective-reciprocal` | `matrix.ts` | the near-plane entries are `f32(f32(2·zNear) · f32(1/f32(xmax-xmin)))` — a **rounded f32 reciprocal** of the frustum width, not a division. Measured against Apple's GLU 1.3 over 288 grid points + the 13 recorded projections: reciprocal 951/1152 and 52/52, division 808-835/1152 and 49-50/52; the reciprocal is also the only form insensitive to the last bit of `zNear`, which is observable because native hands GL the **promoted float** `fNear` (the division form misses the recorded `gl.obj->vision_pitch_yaw.projection[0]`) |
| `W1e/glFrustum-float-delta` | `matrix.ts` | the depth entries are `f32(f32(-(zFar+zNear))/(zFar-zNear))` and `f32(f32((-2·zFar)·zNear)/(zFar-zNear))`: the **numerators** are narrowed to f32, the plane delta stays double. Measured on the same 288-point grid: 52/52 recorded and 951/1152, against 42/52 and 870/1152 for the f32-delta form |
| `W1e/glfrustum` | `matrix.ts` | `glFrustum`/`gluOrtho2D` are ported although the model has no call site, so L18/L16 do not hand-roll a projection |
| `W1e/lookat-up-vector` | `matrix.ts` | `gcamera::UseLookAt` passes `fAngle[0..2]` as the **up vector**; with the defaults that is `(0,0,0)` and the construction is degenerate. The port returns `null` instead of a NaN matrix; nothing in the model reaches this path (`SetFixationPoint` has no call site) |
| `W1e/object-rotated-flag` | `matrix.ts` | `gobject::rotate()` is a no-op until an angle is set (`fRotated`); the port keeps the flag (`objectMatrix(..., rotated)`) |
| `W1e/camera-modelview` | `matrix.ts` | the exact `Use()` composition, including the agent's inverse rotation applied roll- then pitch- then yaw-wise, and `glTranslatef(-fPosition)` (the *negated* camera offset) |
| `W1e/camera-defaults` | `camera.ts` | FOV 90 / aspect 0 / near 1e-5 / far 10000 kept verbatim, degenerate aspect included |
| `W1e/fog-data-only` | `camera.ts` | `SetFog` keeps `{enabled, function, density, linearEnd}` as data; a renderer applies it. `'O'` means "leave the renderer's fog alone" (native never turns fog off) |
| `W1e/agent-pov-aspect` | `camera.ts` | `fovx * retinaHeight / (agentFOV * retinaWidth)` is a **float** expression with `short` retina dimensions, rounded per step, then stored by `SetAspect` (agrees with `docs/specs/vision-spec.md` §5.2). One implementation (`Camera.agentPovAspect`), also used by the vision lane's `visionAspect` |
| `W1e/agent-pov-precomputed-inputs` | `camera.ts` | `configureAgentPov` accepts the **already-derived** numbers (`fovx`/`aspect`/`pitchDeg`/`yawDeg`/`localPosition`) and uses them verbatim in place of the derivation: native's `UpdateVision` computes `fovx = FieldOfView()` **once** (`agent.cc:1070`) and hands that float to `SetAspect`, so re-deriving it from a focus round trip would be a second rounding of the same expression. The node POV scanner (`vision/povScan.ts`) is given exactly these |
| `W1e/frustumxz-is-dead-for-the-retina` | `frustum.ts` | the agent's `fFrustum` is written and never read (vision-spec PN-V4); ported as the native *culling* semantics for L14/L15, not as a retina input |
| `W1e/frustumxz-angmax-bug` | `frustum.ts` | `Set` normalises `angmax` with `angmax -= (angmin > 0.0) ? TWOPI : -TWOPI`, testing the **already-rewritten** `angmin`; the port reproduces it (golden `frustumQ.*`: 550° and 585° angles) |
| `W1e/radius-machinery` | `primitives.ts` | `radius = length(bbox diagonal) * radiusScale * scale * 0.5`, recomputed only while `fRadiusFixed` is false; `setradius` fixes, `setradiusscale`/`setscale` unfix |
| `W1e/vector-ops` | `vector.ts` | double-in/double-out helpers over the frozen shapes; f32 only where the native stores a `float` |
| `W1e/colour-quantization` | `vector.ts` | `round(255*clamp(c,0,1))` is *derived* (GL quantizes on write; the spec derives it from the goldens) and lives here so L16 has one copy |
| `W1e/ray-helpers-are-new` | `raycast.ts` | the native tree has **no** ray code (verified: no `ray` symbol outside “array”); these helpers are additions for L15/L16, and every native radius/plane semantic still comes from the ported code |
| `W1e/atan2f-is-transcribed` | `float.ts` | `frustumXZ::Inside` calls the **float** `atan2f`, and the real float overload is now transcribed in `src/model/rng/libm.ts` (`t_4bb10112`): constants extracted from the shipped bytes by `rng/native/gen_atan2f_table.py` (it decodes the `adr`/`adrp`+`add`/`ldr` displacements), the C transcription `rng/native/raw/apple_atan2f_impl.h` diffed against the census first — byte-identical on all 20,050 census rows and all 606,583 wide-sweep rows. `nativeAtan2f` is a one-line delegation and the `f32(Math.atan2)` stand-in **plus the two ±π values** is deleted: it missed 1 ulp on 460/20,050 rows (2.3 %) and 18,279/606,583 (3.0 %) — all *outside* the ±π family. arm64's `atan2f(0, -1)` is still `0x40490FDA`, now by construction (`ATAN2F_PI_HI` = `f32(pi)` toward zero `+ 2^-32`), which is what the `frustumQ.yaw90_fov180` golden pins |
| `W1e/atan2f-census` | `float.ts` | the arm64 `atan2f` census (`native/atan2fprobe.{c,sh}`, the corpus + native output under `native/raw/**`, `tools/measure_atan2f.ts`, `tools/witness_atan2f_wedge.ts`): over 20,050 committed argument pairs the shipped `atan2f` differs from `f32(atan2)` by **1 ulp on 3,924 (19.571 %)** and the *pre-transcription stand-in* differed from the shipped `atan2f` on **460 (2.3 %)** — all of them *outside* the ±π family, i.e. not covered by the two values that were corrected, and including the model's own argument class (`reachable-lattice`: 204/4,532; any float `|v| < 256`: 27/2,000). The shipped function is the inaccurate side (high-precision check: the true `atan2` is nearer `f32(atan2)` on 127/127 decided rows), and **187 of 244** differing reachable pairs have a wedge configuration in the model's own domain whose limit lands exactly on the differing float and flips `Inside`. No recorded byte moves (`Inside` has no call site in `src/model/**`, and native's `infrustum`/`outfrustum` counters are never logged) — so the census stayed exactly as it was and the transcription (`t_4bb10112`, `W1e/atan2f-is-transcribed`) landed behind it: `tools/measure_atan2f.ts` now prints `port != native` **0** in every class, and the witness tool still shows the 187/244 flips by reconstructing the deleted stand-in locally |
| `W1e/body-vec3-import` | `body.ts` | integration fix (supervisor card `t_d571f53a`): `body.ts` imported `{ vec3 }` from `../types/geometry`, which is lane W1a's **shape-only** module (`types/geometry-boundary`) and exports no constructor. The tree's existing spelling — used by `camera`/`primitives`/`raycast`/`matrix` — is the *shape* `type Vec3` from `../types/geometry` plus the *constructor* `vec3` from this lane's `./vector` (PN `W1e/vector-ops`); no alias was added to the types file (PORT_SPEC rule 4: do not invent API shapes). Type-level only — no runtime behaviour changed |

### Lane status

| Lane | Status | Parity | Notes |
|---|---|---|---|
| W1e geometry | landed | n/a — goldens, not a run tree | `npx vitest run tests/geometry.test.ts` → **47/47** (38 camera/frustum + 9 body mesh); `tsc --noEmit` clean for the lane; goldens regenerate byte-identically; no dependency added; **hotspot**: the L16/W1j lane's `src/model/vision/{camera,matrix}.ts` duplicates this maths and consumes these goldens — one of the two should re-export the other (flagged on the board). Separately, `nativeAtan2f` is a one-line delegation to the transcribed arm64 `atan2f` (`t_4bb10112`, PORT-NOTE `W1e/atan2f-is-transcribed`): the `f32(Math.atan2)` + ±π stand-in is **deleted** and the `frustumQ.*` goldens are unchanged |

## PORT-NOTEs (L6 brain core)

`src/model/brain/core/**` — the neuron/synapse models, nerve/activation wiring, brain base
(dumps, prebirth, freeze), the `Groups` and `Sheets` architectures, and the native
differential harness that verifies them. Every row is a decision a reviewer can disagree with.

| PORT-NOTE | File | Decision |
|---|---|---|
| `l6/lane-boundary` | `index.ts` | `src/model/brain/core`'s barrel is the only import path other lanes use (`brainConfig`, `groupsConfig`, `sheetsConfig`, `processBrainWorldfile` — which calls all three native `processWorldfile`s in `Brain.cc`'s order — the genome view types, the enums); the module layout inside is free to move |
| `l6/dimensions-shared-object` | `neuronModel.ts` | native hands out a `Dimensions *` the brain owns and everyone reads; the port passes the same mutable object, because `GroupsBrain::grow` fixes `numSynapses` up *after* the model is initialised and the loggers must see the corrected value |
| `l6/neuron-model-interface` | `neuronModel.ts` | native virtuals kept one-for-one (camelCase, out-params returned as records) so `NeuronModel.h` can be diffed line by line |
| `l6/neuron-attrs-union` | `neuronModel.ts` | native erases the attribute struct through `void *` + an anonymous union picked by `Brain::config.neuronModel`; the port types it as a union of the two attribute shapes, so the compiler enforces the pairing native only assumes |
| `l6/float-arrays` | `neuronModel.ts` | activations are `double[]` in native → `Float64Array`; per-neuron/-synapse state uses `Math.fround` at exactly the native float stores; `Float32Array` where native keeps an array of floats |
| `l6/float-discipline`, `l6/nint-macro` | `nativeMath.ts` | `f32` at every native float store; `nint` is the macro (test `< 0.0`, `0.499999999`, `(long)` truncation) — exact halves round *toward zero*, so `nint(0.5) == 0`, not `Math.round`'s 1; the `(long)` cast has no `-0`; and the macro mentions its argument **twice**, so the one call site that passes it an expression with a side effect (`GroupsBrain.cc:778`'s `range()`) consumes **two draws** — see `l6/groups-nint-double-evaluation` |
| `l6/to-short`, `l6/int32-wrap` | `nativeMath.ts` | `short(x)` wraps the low 16 bits (implementation-defined in C++, but this is the only behaviour that matters and `GroupsBrain` narrows through it); `GroupsBrain::init`'s `maxsynapses` estimate is C `int` arithmetic and wraps before it is stored in a `long` |
| `l6/logistic-libm` | `nativeMath.ts` | `logistic(x,slope) = 1/(1+exp(-x*slope))` and `gaussian(x,mean,variance)` call **lane L1's transcribed `exp`** (this row used to say "written against `Math.exp`, and the harness *measures* the divergence" — the measurement is what forced the transcription: `Math.exp` was 1 ulp off the oracle's `exp` on 396 of 8,261 corpus values). `SpikingModel.cc:214`'s bias coin calls it too (`l6/spiking-exp`). This lane's own probe is now exact on both: `exp` 512/512, `logistic` 2048/2048. See the libm finding below |
| `l6/asserts-are-throws` | `nerve.ts`, `brain.ts`, models | the native tree is built without `NDEBUG`, so every brain `assert` is live in the oracle; the port reproduces them as throws |
| `l6/brain-error-is-a-throw` | `errors.ts` | native `error(level, …)` prints and `exit(level)`s for `level > 1`; the port throws `BrainError` carrying the level and the native wording |
| `l6/cformat-g`, `l6/cformat-length`, `l6/cformat-float-reuse` | `cformat.ts` | `%g` per C99 7.19.6.1 with glibc's correct rounding (exact binary value, ties-to-even) — `toPrecision` is *not* equivalent; `%f` is delegated to W1c's already-verified `formatFixed`; `%d`/`%hd` narrow through int32/short while `%ld` (which carries `numSynapses`, a native `long`) truncates without 32-bit wrapping |
| `l6/textfile-boundary`, `l6/scanf-subset` | `textFile.ts` | the brain depends on a two-method text-file interface (`printf`/`scanf`), not on W1c's `ByteSink`/`AbstractFile`, so it stays bundleable; `loadSynapses` needs exactly two `fscanf` shapes, and anything else throws instead of mis-parsing |
| `l6/activation-buffer-handle`, `l6/activation-swap` | `nerve.ts`, `baseNeuronModel.ts` | native stores the *addresses* of the two activation pointers in every nerve and the models swap the pointers; the port owns one `ActivationBuffers` record and swaps its fields, so every holder follows |
| `l6/nerve-registry`, `l6/getNerve-missing` | `nervousSystem.ts` | nerve vectors keep creation order (the brain derives every neuron index from them); `getNerve(name)` throws on an unknown name instead of reproducing native's null-insert-then-dereference |
| `l6/sensors-are-ordered` | `nervousSystem.ts` | `grow`/`update`/`prebirthSignal`/`startFunctional`/`dumpAnatomical` walk the sensor list in insertion order — it decides both the neuron ranges and the RNG draw order |
| `l6/rq-sensor-factory` | `rqNervousSystem.ts` | `RqNervousSystem::createInput` builds an `RqSensor` (lane L8/L9); the port takes the factory as an argument so this lane keeps no agent dependency, while the nerve order (the part that is model behaviour) is ported verbatim |
| `l6/rng-roles`, `l6/grow-draw-surface` | `brainRng.ts`, `growRng.ts` | the three native RNG roles and their two types (`GLOBAL` = the shared glibc streams, `LOCAL` = a private MT19937) are kept distinct; `growRng.ts` is the single place they are reconciled against `types/rng.ts` — a port that merges the streams reproduces neither |
| `l6/brain-config-singleton` | `brain.ts` | `Brain::config` is a process-wide mutable struct (worldfile-filled, then *mutated* by `init`); the port keeps one exported object shared by models, loggers and the agent lane |
| `l6/prebirth-order` | `brain.ts` | `PreBirthCycles` × (`prebirthSignal()` then `update(false)`), both halves consuming the GLOBAL stream and applying learning unless frozen — this loop decides every recorded brain's initial efficacies |
| `l6/dump-formats` | `brain.ts`, `baseNeuronModel.ts` | the three dump formats are reproduced verbatim; the anatomy matrix accumulates connections into a C `float` C array (`+=`, so parallel e/i connections sum) and *assigns* the bias column, scaled by `1/max(maxWeight,maxbias)` |
| `l6/renderer-injection` | `neuralNetRenderer.ts` | `GroupsBrain::initNeuralNet` constructs a GL renderer; the port takes an injected factory instead, so the brain stays GL-free and a headless run builds no renderer (nothing in the model reads it) |
| `l6/genome-boundary`, `l6/genome-enums` | `brainGenome.ts` | the L5→L6 cut is the *resolved* operations `GroupsBrain` calls (`getNeuronCount(type,group)`, `getSynapseCount(type,from,to)`, `get(gene,…)`, `getOrderedGroups()`), not raw genes, so this lane holds no second copy of the genome arithmetic and the harness can drive the port from the oracle's own genome; `NeuronType`/`NeurGroupType` values are frozen |
| `l6/groups-agent-config` | `groups/groupsBrain.ts` | `GroupsBrain::init` derives the input/output group counts from `agent::config` flags; the port takes them as an explicit `BrainFlags` argument rather than importing the agent lane |
| `l6/groups-neuron-index-layout` | `groups/groupsBrain.ts` | the neuron array is `[inputs][outputs][internals]`, internal groups in `orderedGroups` order, E before I inside a group; `firsteneur`/`firstineur` are indexed by *ordered* index and the internal loop starts at `_cns.getNerveCount()` — the port keeps the assumption and the indexing rather than re-deriving "the first I/O groups" |
| `l6/groups-synapse-remainder` | `groups/groupsBrain.ts` | the per-group float remainder spreads `synapseCount_fromto` over the postsynaptic neurons in call order (`EE`,`IE` then `EI`,`II`); `short( nsynjiperneur + remainder + 1.e-5 )` is a **truncating** functional cast, and its operand types are the subtle part — both operands of the first `+` are `float`, so that addition **rounds to `float`** before the `double` literal `1.e-5` promotes the sum. (The pre-review revision of this row said "a *double* sum"; that reading was wrong and is what shipped the defect review round 1 found — see `l6/groups-grow-arithmetic`.) Either half wrong shifts one connection per group |
| `l6/groups-grow-arithmetic` | `groups/growArithmetic.ts` | `growSynapses`' arithmetic (and the energy formula at the end of `grow`) is factored out of the walk into one function per native expression, so each can be compiled-transcription-diffed (`native/brainprobe.cc` `growexpr`) while lanes L5/L8 are missing: `f32` where the C *store/operation* is float (`nsynjiperneur + remainder`, `nsynjiperneur - synapseCount_new`, the `stdev` product, `td_fromto_abs`, the energy terms), plain `double` where the C expression is double (`+ 1.e-5`, `* 0.5`, the `nint` macro, `range`), the C **left-to-right grouping** (the product before the division), and `short(...)` only where native narrows. Measured over **75,263** enumerated inputs (structural, uniform, truncation-window, group-shape, boundary and energy sweeps; the `td`/`distortion` ranges extend past the gene's reachable values; `distort` now feeds *two* draws per row — see `l6/groups-nint-double-evaluation`): the port is exact on all of them, while the pre-review all-double `synapseCount_new` is wrong on 494 and the pre-review `a * (n / m)` energy grouping on 759 |
| `l6/groups-nint-double-evaluation` | `groups/growArithmetic.ts` (`distortionIndex`), `groups/groupsBrain.ts`, `native/brainprobe.cc` (`distort`) | `GroupsBrain.cc:778` is the one place a **macro decides how many draws the model consumes**: `short distortion = short( nint( td_rng->range(-0.5,0.5) * td_fromto_abs * neuronCount_from ) )` passes `nint` an argument with a side effect, and `nint` names its argument twice, so `range()` runs **twice** (four draws on a connection whose `drand()` test passes — test, sum draw, sign draw, efficacy — two on one that fails). The port's `distortionIndex( termA, termB, … )` takes the two draws explicitly, with the compiled macro's order (first draw → the sum, second → only the sign test), pinned by the `distort` grid (29,808/29,808 across rows whose two draws are equal, negated and shifted). Found 2026-09-28 (`t_e970f22a`) by *index*, not value: the single-draw reading left `run/brain/anatomy\|synapses\|function/**` byte-exact for output neurons 29-31 and wrong for 32/33 — the first targets whose every connection takes the distortion branch, i.e. the first place the missing draw shifts the stream — and every post-prebirth activation wrong behind them, because `GroupsBrain::grow` and `NervousSystem::prebirthSignal` share one per-agent `NERVOUS_SYSTEM` MT19937 (LOCAL, seeded with the agent's 1-based `agentsEver`) |
| `l6/groups-short-narrowing` | `groups/groupsBrain.ts` | `short nint( … )`, `max<short>(0, min<short>(…))` and the `distortion` cast all narrow; the port narrows through `toShort` at the same statements (the base index is now `neuronLocalIndexFromBase` in `growArithmetic.ts` — `short(...)` of a **double** difference, with no float store before the cast) |
| `l6/groups-energy-use-float` | `groups/growArithmetic.ts` (`energyUseOf`) | `_energyUse` is float arithmetic end to end (float products, float divisions, float sum) **in native's left-to-right order, the product before the division** — the pre-review revision grouped it `a * (n / m)`, which is a different rounded float as soon as the denominator is not a power of two (measured: 759 of 10,368 grid rows). It is the only assignment to `_energyUse` in the native tree (`GroupsBrain.cc:616`), so `Sheets` keeps the 0 `Brain.cc:150` initialises |
| `l6/base-neuron-model-generics`, `l6/neuron-calloc` | `baseNeuronModel.ts` | the native template becomes a generic class; `calloc` means zeroed neuron/synapse records, including `startsynapses == endsynapses == 0` ("no synapses") for a neuron that was never wired |
| `l6/firingrate-float-stores`, `l6/firingrate-enablelearning` | `firingRateModel.ts` | every mixed-precision store is at the native statement, above all `float efficacy = syn.efficacy + learningrate*(…)` (double result, truncated to float) and the float-times-double decay expression; the learning loop is gated on `enableLearning && !isFrozen` and reads the *post*-update activation of the destination neuron |
| `l6/spiking-buffer-swap`, `l6/spiking-rng`, `l6/spiking-uninitialised-stack`, `l6/spiking-dead-debug` | `spikingModel.ts` | the brain-step loop swaps the activation pointers *every* step (so an odd `BrainStepsPerWorldStep` would reproduce native's lose-the-last-step quirk); 50 × (inputs + non-inputs) `drand` draws per world step in neuron order; the stack arrays are zero-initialised in the port because native leaves them lucky-but-well-defined; the `fHandle`-only debug matrix and the unused `loop_counter` are omitted |
| `l6/sheets-map-order` | `sheets/sheetsModel.ts` | `SynapseMap` is a `std::map` ordered by `nonCulledId` (construction order), and both the synapse layout and the cull walk it — the port reproduces that ordering explicitly |
| `l6/sheets-float-ops` | `sheets/sheetsModel.ts` | sheet geometry is `float`: spacings/insets/positions/distances round at each native float store, and `ceilf`/`floorf`/`round` are the C functions (`round` is half-away-from-zero, which `Math.round` only matches for non-negative arguments) |
| `l6/sheets-exp-libm` | `sheets/sheetsModel.ts` | `getProbabilitySynapse` uses `exp` and has no native counterpart to diff against (no scenario uses Sheets) — recorded in Gaps rather than measured away |
| `l6/sheets-sheet-indexing`, `l6/sheets-synapse-layout`, `l6/sheets-getnumsynapses-name` | `sheets/sheetsBrain.ts` | `sheetNeuronCount[]` is indexed by sheet id as native does (missing sheet throws instead of a null dereference); synapses are laid out in `getNeurons()` order and within a neuron in `synapsesIn` (nonCulledId) order; the two-argument `getNumSynapses` gets its own name because TypeScript has no C++ name hiding |

### Verification (L6)

The lane's stated oracle — `run/brain/function/**` and `run/brain/anatomy/**` byte-compare on
`minitest_voff` — needs a whole simulation (L11) driven by a genome (L5), neither of which
exists yet, so the lane verifies what it owns today: **byte-exact agreement with the oracle's
own code**, on brains the harness builds.

`src/model/brain/core/native/run_brainprobe.sh` compiles
`src/model/brain/core/native/brainprobe.cc` against the native tree's `libpolyworld.dylib`
(the real `FiringRateModel`, `SpikingModel`, `Brain::dumpAnatomical/startFunctional/
writeFunctional/dumpSynapses`, `AbstractFile::printf`) and drives three variants — `firingrate`
(learning on), `taugain` (tau/gain with the brain *frozen*, i.e. the learning loop skipped) and
`spiking` (50 brain steps per world step, ~2,600 `drand48` draws per step, STDP).
`tests/brain-core.test.ts` rebuilds each brain with the port from the probe's spec file and
diffs:

| Artifact | Result (measured 2026-09-28, macOS 26.5.2 arm64) |
|---|---|
| functional recording (`run/brain/function/**` shape) | **byte-identical**, all 3 variants |
| synapse dump after learning (`run/brain/synapses/**` shape) | **byte-identical**, all 3 variants |
| anatomy dump (`run/brain/anatomy/**` shape) | **byte-identical**, all 3 variants |
| `%g`/`%G`/`%f`/`%+06.4f`/`%hd`/`%ld` vs this machine's printf | **byte-identical** on the model's own activations/efficacies *and* on 37 adversarial vectors (tie cases, subnormals, exponent-boundary values) |
| glibc `drand48` sequence (the harness's stand-in for W1d's) | **identical** to the oracle's first 8 draws |
| activations | **bit-exact, all 3 variants: 96/96 · 96/96 · 102/102** — `t_da2ab201` closed the residual at clang's `-ffp-contract=on` sites (the history: 86/96 · 80/96 · 101/102 before this lane's `exp` cutover, then 87/96 · 83/96 · 101/102 with it) |
| learned efficacies | **bit-exact, all 3 variants: 23/23 · 23/23 · 26/26** (`spiking` was 23/26 — the `float` product in its learning rule, same card) |
| hardware `fma` vs the port's `fma64` (`brainprobe fma`, 2026-09-28) | **57,539/57,539 bit-exact** on the models' own shapes plus wide-random doubles; the rounds-per-operation form (`a*b + c`) is wrong on **7,103** of them, and 4,000 exact-midpoint ties are checked separately against exact rational arithmetic (0 mismatches) |
| `logistic` / `exp` vs the oracle's libm (2,048 + 512 samples) | **bit-exact: logistic 2,048/2,048, `exp` 512/512, both 0 ulp** (was 1,976/2,048 and 464/512 before the W1d `exp` transcription — see the libm finding) |
| the `growSynapses` + energy-use arithmetic (`growArithmetic.ts`, `brainprobe growexpr`) | **75,263/75,263 exact** — synnew 21,721, remupd 560, baseidx 7,272, tdabs 5,358, distort 29,808, stdev 176, energy 10,368; the two pre-review defects this found are wrong on **494** (the all-double `synapseCount_new`) and **759** (the re-ordered energy formula) of the same rows, i.e. the grid demonstrably catches what it was written for. The `distort` rows drive the macro through a **queued `range()` call**, so the macro's double evaluation and the order the compiler gives its two draws are pinned instead of assumed (see `l6/groups-nint-double-evaluation`) |
| `run/brain/**` **end-to-end** — the whole `Groups` walk through the L11 runner, compared with the recorded golden for `microtest_voff` (`npx tsx src/model/sim/runner.ts microtest_voff <out> --arg Vision False`, payload compare) | **byte-identical, 150/150** — `anatomy` 50/50, `synapses` 50/50, `function` 25/25 (all 25 `incomplete_brainFunction_*.txt.gz`), headers included. Whole-run harness `./oracle/run_parity.sh microtest_voff --candidate <tree>`: **`match 216/225`**, up from `44/225` before this fix; the 9 that still differ are `run/stats/stat.1` (missing — lane L14's monitor) and `energy/{agents/agent_2,agents/agent_15,consumption,food}.txt`, `events/{contacts,energy}.log`, `genome/separations.txt`, `lifespans.txt` — lane L8/L10 behaviour, not `brain/**` |

Note on the end-to-end row: the walk's correctness is what these 150 payloads measure — every
group's connection sources, efficacies, learning rates and bias column, plus the post-prebirth
activation of every neuron. They are the oracle's own `brain/**` bytes, not a proxy.

**Why the grow arithmetic is diffed separately from the walk.** `GroupsBrain::growSynapses` is
private and reaches its genome, its `agent::config`-derived group counts and its RNG roles
through the brain, so a native *end-to-end* diff needs lane L5 (a native `GroupsGenome`) and lane
L8 (the nerve set). The expressions do not need them: `brainprobe growexpr` transcribes each C
expression with its native operand types (each function cites its `GroupsBrain.cc` line), compiles
it with the oracle's own clang++, evaluates it over the enumerated grid and writes inputs *and*
results as raw bits, and `tests/brain-core.test.ts` replays the same inputs through
`growArithmetic.ts`. The transcription is by construction not the compiled `growSynapses` itself,
which is the same method the
review found the defect with; and it cannot see the *walk* (which index a connection lands on, the
draw order, the `nearestFreeNeuron` repair) — **that is what the end-to-end `run/brain/**` row
above now measures**, and it is exactly where this lane's remaining defect was: the walk's *draw
count*. `growexpr` could not have caught it, because it feeds `nint` a **value** while the walk
feeds it a **call**, and the macro evaluates its argument twice (`l6/groups-nint-double-evaluation`;
the `distort` grid now drives a queued call for that reason).

### The libm finding (L6, quantified — **closed for `exp` by the W1d follow-up `t_12c76fc3`**)

PORT_SPEC rule 3 predicted this and it is now measured, for every transcendental the model
calls. The oracle's libm is **not correctly rounded in any of the four**, so the only way to
reproduce it is transcription (the method W1d established for `log`). Census, against a
correctly rounded reference computed with Python's `decimal` (cross-checked at +40 digits):

| function | captured corpus | native == correctly rounded | native == V8 `Math.*` |
|---|---|---|---|
| `exp` | 8,261 | 8,255 (99.92 %), max 1 ulp | 7,876 (95.4 %), max 1 ulp |
| `sin` | 5,055 | 4,858 (96.10 %), max 1 ulp | 4,838 (95.7 %), max 1 ulp |
| `cos` | 5,055 | 4,860 (96.14 %), max 1 ulp | 4,845 (95.9 %), max 1 ulp |
| `pow` | 4,471 | 4,373 (97.81 %), max 1 ulp | 4,084 (91.3 %), max 1 ulp |

**`exp` is transcribed and bit-exact** (`src/model/rng/libm.ts` + `appleExpTable.ts`, 8,261/8,261
corpus values, 320,121/320,121 on the wide sweep; the C transcription of the same disassembly
diffs identical to the corpus first). The consequence for this lane, measured through its own
probe: `exp` **512/512** and `logistic` **2,048/2,048** bit-exact, both 0 ulp — the drift this
section used to attribute to `Math.exp` (464/512 and 1,976/2,048) is **gone**, and this lane's
`logistic`, `gaussian` and the spiking model's bias coin now call that `exp`.

What that changes here, honestly:

* **The activation residual was not a libm artifact, and it is now CLOSED (`t_da2ab201`,
  2026-09-28).** After the `exp` cutover the same probe measured firingrate 87/96 (was 86/96,
  max 13 ulp), taugain 83/96 (was 80/96) and spiking 101/102; efficacies 23/23, 23/23, 23/26 —
  a residual "on this lane's own path (a store width, an evaluation order, a `float`/`double`
  mix somewhere in the propagation)", recorded as an open lead. All three guesses were the same
  defect: clang's `-ffp-contract=on`. Every `a*b + c` on this path is a hardware `fmadd` in the
  shipped dylib (`FiringRateModel::update` `0x5e704`/`0x5e7c8` accumulate, `0x5e744`/`0x5e804`
  mix tau/gain, `0x5e8a8` learns; `SpikingModel::update` `0x678cc` accumulates, `0x67964`/
  `0x67988` are the Izhikevich voltage, `0x67990`-`0x67994` the recovery variable, `0x67d80` the
  smoothed firing rate), and the port rounded the product and then the sum — ~1 ulp per site per
  step, amplified by the recurrence, which is the whole of the 13-ulp spread. With the sites
  transcribed through `nativeMath.ts`'s new `fma64` the census is **96/96 · 96/96 · 102/102
  activations and 23/23 · 23/23 · 26/26 efficacies, max 0 ulp on every one**, the assertions in
  `tests/brain-core.test.ts` are equality rather than a tolerance, and the `dyn` growers worlds'
  `Yaw`-nerve drift is gone with it (L11 Gaps row). The `spiking` half needed one more thing the
  FMA alone does not fix: `SpikingModel.cc:353`'s `efficacy += (.01 + delta * learningrate)` is a
  **`float` product** (one rounding) before the `double` literal promotes it — measured as 23/26
  efficacies before, 26/26 after.
* **Every `%g`-formatted artifact remains byte-identical** in all three probe variants (the
  drift is ~1e-16 relative and `%g` prints six significant digits) — that is unchanged.
* `libm census` in `tests/brain-core.test.ts` now asserts *equality* for `exp` and `logistic`
  (and still measures `Math.exp`'s 464/512 alongside), so a future rewrite that reaches for
  `Math.exp` again fails instead of quietly moving the bits.
* `sin`/`cos` (`t_5221d534`) and `pow` (`t_9ed428d7`) are transcribed too — the census above
  said they would need the same treatment, and all four functions are now bit-exact on their
  corpora (with their C transcriptions diffed against those corpora first). The **float**
  overloads joined them: `sinf`/`cosf` in `t_05611902`, `powf` — the function both of
  the model's `_powf` sites call, which neither the double `pow` nor V8 reproduces (37 and
  196 of its 7,325 corpus rows) — in `t_29e0a2fc`, and `atan2f` — the arm64 `frustumXZ::Inside`
  calls, and the one float overload that had a *measured* residual behind it (the `f32(Math.atan2)`
  + ±π stand-in missed 1 ulp on 460/20,050 census rows and 18,279/606,583 wide-sweep rows) — in
  `t_4bb10112`.  `powf` and `atan2f` are also the two the *cost* line matters for: 0.16 us/call
  for `powf` (3x `Math.pow`) and **0.060 us/call for `atan2f`** — ~3x *cheaper* than the
  `f32(Math.atan2)` stand-in it replaced. The **float**
  overloads followed in `t_05611902`: `CameraController.cc:78-80` passes a C++ `float`, and the
  shipped build's adjacent `sin`/`cos` calls were fused by LLVM into `__sincosf_stret`, so
  `libm.ts` now exports `sinf`, `cosf` **and** `sincosf`, each bit-exact against its captured
  native corpus (5,016 rows each, plus a 105,119-argument sweep). The measurement that forced
  it: `Math.fround( double sin )` disagrees with the shipped `sinf` on 304/5,016 float32
  arguments (`cosf`: 135/5,016) — the double-rounding cases — and switching the camera onto
  those scalar transcriptions moved a recorded frame, which is what exposed the `sincosf` merge

### The `Sheets` architecture in the shipped oracle — measured, and why it is *not owed*

`BrainArchitecture` is an Enum with two values (`etc/worldfile.wfs:1903`) and the shipped
`lib/libpolyworld.dylib` exports the whole Sheets implementation (`SheetsBrain*`, `SheetsModel*`,
`SheetsGenomeSchema*`, `SheetsCrossover*`). No shipped worldfile uses it (`worldfiles/m-neurons/*`,
`worldfiles/social/feed_young.wf` all say `Groups`) and the port refuses it —
`GenomeUtil.createSchema` throws for `Sheets` (PORT-NOTE `genome/create-brain-stub`) — so the
*Gaps* table carried "port `genome/sheets/**`" as outstanding work. Measuring the target first
(`src/model/genome/native/probe_sheets_architecture.sh`; native runs in an isolated copy of the
tree's runtime pieces — a *real* copy: the probe materialises it with `cp -RL` and refuses both a
symlinked work copy and a work tree inside the native tree, after a symlink-farm `$NATIVE` was
measured writing the three generated worldfiles into `worldfiles/` at 06:01:20 on 2026-09-29
(t_96ac5a1b) — so the native repo itself is never written to) says there is no target:

| run | worldfile | exit | per-agent brain dumps | `numneurons+1` | `numsynapses` |
|---|---|---|---|---|---|
| A1, A2 | minimal, `BrainArchitecture Sheets`, `GenomeLayout` at the schema's own default (`None` for Sheets), 1 step, **run twice** | 0, 0 | 50 of 50 empty, both runs | `1` (**0 neurons**) | `0` |
| B | a recorded run's own `minitest_voff` `normalized.wf`, `BrainArchitecture Sheets`, Sheets params raised far above the schema defaults (brain sizes 8–16, internal sheets 1–5), 60 steps | 0 | 50 of 50 empty | `1` | `0` |
| C | B with `GenomeLayout NeurGroup` spelled out (the only container layout the shipped build has, `GenomeLayout.cc:57`) | **139 (SIGSEGV)** | none written | — | — |

A1, A2 and B even produce the **same `run/brain` tree** — 125 files, one sha256 over the payloads
(`55f76a6fd8e0c68b…`) — i.e. the Sheets configuration parameters change nothing. Two further facts
from the repeats (17 runs of the minimal worldfile): 846 of 850 anatomy dumps read 0 neurons and 4
read **15** (one run, agents 1–2 — that worldfile's gene pool is unseeded, so the few-brain case comes
and goes), one repeat died with `SIGABRT` (exit 134), and every run prints
`IMPLEMENT INDEX-BASED WEIGHT` (`SheetsGenomeSchema.cc:937`, the schema's own marker for the
`SynapseAttrEncoding` half it never implemented). The step-1 `CurNeurons` line is **not** a neuron
count for Sheets (`1.2 ± 4.1 [0, 15]` on a run whose 50 anatomy dumps all read 0): the architecture
never fills the shared brain-stat accumulator, so that line is uninitialised memory. At step 60 it
reads `0.0 ± 0.0 [0, 0]`.

Mechanism, from the oracle's own code: the worldfile schema's `GenomeLayout` default is
`NeurGroup if BrainArchitecture == BrainArchitecture.Groups else None` (`etc/worldfile.wfs:91`), so
Sheets gets the **flat** layout, and `SheetsGenomeSchema::createSheetsModel`
(`SheetsGenomeSchema.cc:678`) builds the sheet model out of the `InputSheets` / `OutputSheets` /
`InternalSheets` container genes — which the flat layout leaves empty, hence a brain with no neurons.
The one container layout that exists is the Groups one and crashes on a Sheets genome.

**Decision (orchestrator, 2026-09-29).** `genome/sheets/**` is **not transcribed** and no `sheets_*`
scenario is registered. A Sheets run grows no brain, is not byte-reproducible across the gene pool,
and crashes under the container layout: there is no behaviour to be faithful *to*, and a golden
cannot be recorded from a worldfile the oracle cannot complete. Transcribing ~2.7k lines of C++
(`genome/sheets` + `brain/sheets`) to reproduce an empty brain — or a segfault — would be fidelity
to a path upstream never finished. The port's `createSchema` throw therefore stays, documented by
this finding and by PORT-NOTE `genome/create-brain-stub`; the already-ported L6 `brain/core/sheets`
stays as the vocabulary it is. Reopen only if the native tree is rebuilt with Sheets repaired: the
probe prints `FAIL` the moment any of the three verdicts changes, which is the signal to re-measure
before trusting any Sheets claim.

## PORT-NOTEs (L5 genome)

`src/library/genome/**` ported to `src/model/genome/**` (core + `groups/**`). Every semantic
decision carries an in-code `PORT-NOTE`; the tag and what it decides:

| PORT-NOTE | File | Decision |
|---|---|---|
| `genome/scalar-value` | `values.ts` | native `Scalar` is a tagged union whose `float` member truncates to f32 on construction; the `assert`-guarded conversions throw instead of reinterpreting the union |
| `genome/printf-float6` | `values.ts` | `%f` is computed from the double's exact decimal expansion (bigint rational, ties-to-even once) — `Number.toFixed` does not guarantee C's rounding |
| `genome/graybin-tables` | `graybin.ts` | the two 256-entry tables transcribed verbatim (they are **not** the textbook Gray functions: `binofgray[4] == 7`, and `set_raw` stores through `grayofbin` while `get_raw` decodes through `binofgray`) |
| `genome/gene-type-tokens` | `vocabulary.ts` | native's runtime type tags are interned string tokens, not per-module `static` objects; the cast helpers keep the "NULL in, NULL out; a failed downcast errors" contract |
| `genome/flattened-diamonds` | `gene.ts` | native's multiple inheritance (`MutableScalarGene : NonVectorGene, __InterpolatedGene`, same for the group genes) is flattened into `Gene` with an `interpolated` flag that selects both `interpolate()` and which `printRanges` behaviour runs; `NonVectorGene` keeps the 1-byte size |
| `genome/interpolation-arithmetic` | `gene.ts` | the C expression reproduced with its **operand types**: `double ratio = float(raw) * OneOver255` is a float × float multiply, so the product is rounded to f32 before it widens (an f64 product is a different value); `interp(x,lo,hi) = lo + x*(hi-lo)` where the FLOAT case's `(hi-lo)` is a float − float subtraction (f32 again) and the INT cases subtract ints; `nint` = truncate-after-`±0.499999999`, `ROUND_INT_FLOOR` is truncation **not** floor, `ROUND_INT_BIN` is `min((int)interp(ratio,min,max+1), max)`, FLOAT results are `Math.fround`. Measured against a probe compiled from the oracle tree's own `Gene.cc`: the f64 variant differed on 540 of the 4,864 `(gene, raw)` pairs of the recorded schema, this one on 0 — see the verification block below |
| `genome/print-ranges` | `gene.ts` | the flattened `printRanges` checks the `interpolated` flag first (exactly native's class dispatch), then falls back to the title-line + `ismutable` rule of `Gene::printRanges` |
| `genome/container-in-gene-schema` | `geneSchema.ts` | `ContainerGene` and `GeneType::to_Container` live beside `GeneSchema` so the module graph stays one-way (`geneSchema.ts` → `gene.ts`) |
| `genome/layout-dispatch` | `genomeLayout.ts`, `genomeUtil.ts` | `GenomeLayout::create`'s `dynamic_cast`-driven dispatch moves to `GenomeUtil.createSchema` (its only caller); the NeurGroup mapping is a literal transcription in `groups/groupsLayout.ts` |
| `genome/layout-validate` | `genomeLayout.ts` | `validate()` throws with native's `[i]=count` wording (native prints and `exit(1)`); an unset slot (native indexes `present[-1]`) is reported as "maps to -1" |
| `genome/rng-injection` | `genome.ts` | every draw goes through the injected `RngSurface`; `randpw()` is `drand48()` on the shared global stream and the draw *order* is the contract. No `Math.random` (checked by a test that scans the lane) |
| `genome/seedval` | `genome.ts`, `groups/groupsGenome.ts` | `SEEDVAL(VAL) = (unsigned char)(VAL == 1 ? 255 : VAL * 256)` verbatim; `SEEDCHECK` is a throw, not a clamp |
| `genome/c-round` | `genome.ts` | `mutateOneByte` uses C's `round` (halves away from zero, unlike `Math.round`); `nint` returns `+0` where JS would return `-0` (C's `long` has no signed zero) |
| `genome/dump-seam` | `genome.ts` | `dump`/`load` take the datalib file seam as `write(text)`/`readInt()`; the byte format (`"%d\n"`, gray-decoded) stays here, the file belongs to L2/L12. `print()` returns a string instead of writing to `cout` |
| `genome/misc-genes-are-absent` | `genome.ts` | `gene("MiscBias")`/`gene("MiscInvisSlope")` exist in **no** schema in the oracle build (`NULL` in native, and `mateProbability` would dereference it); the port throws with that explanation instead of inventing the genes or a default |
| `genome/libm-pow-cos` | `gene.ts`, `genome.ts` | the four libm call sites now go to L1's transcriptions (`pow`, `cos`) in `t_c10975cb`, except `mateProbability`'s last line; the oracle's disassembly is what identifies each function — `_pow` at the `interpolate`/`mateProbability` sites, a clang-folded `_exp2` at `mutateBytes`' `pow(2.0, …)`, and `_powf` at that last line — the **float** overload, transcribed in `t_29e0a2fc` and now called there as `powf`. All four are unreachable in the recorded scenarios. Note the call site list is in `gene.ts` (`interpolate`), not `genomeSchema.ts` as this row used to say — `genomeSchema.ts` only parses `GeneInterpolationPower` into `GenomeSchemaConfig.geneInterpolationPower` |
| `genome/scalar-macros` | `genomeSchema.ts` | `SCALAR`/`INDEX`/`INTERPOLATED_IMMUTABLE` pick the gene class from `MIN == MAX` **and the C type of their arguments**; the port spells the kind out (`scalarInt`/`scalarFloat`) at the same call sites so every gene's scalar kind is still decided at its definition |
| `genome/foreign-config-seam` | `genomeSchema.ts`, `worldConfig.ts` | `define()`/`seed()` read `agent::config`/`Brain::config`/`GroupsBrain::config`/`Metabolism` through an explicit `GenomeSchemaInputs`, so the genome lane never declares a second copy of another lane's config singleton. Where native compares an enum, the seam carries the worldfile spelling that enum derives from |
| `genome/seed-rng` | `genomeSchema.ts` | `GenomeSchema::seed` draws `randpw()` off the process-global RNG; the port takes the same single `RngSurface` the rest of the model uses as an argument instead of reaching for a global |
| `genome/worldfile-spellings` | `worldfileSpellings.ts` | the word → enum mapping (`BodyGreenChannel` `I/L/E/F`, `YawEncoding` `Oppose/Squash`, `NeuronModel` `F/T/S`, `BrainArchitecture`) is transcribed; the enums themselves stay with L6/L8 |
| `genome/worldfile-reader-seam` | `worldConfig.ts` | the reader duplicates *reads*, not definitions (coercion is `types/scalar`); L6/L8/L11 pass their own values into `GenomeSchemaInputs` once they exist |
| `genome/max-bias-indirection` | `worldConfig.ts` | `MaxBiasWeight` may name another property (`MaxSynapseWeight`); the recorded `normalized.wf` keeps that text, so the *document* resolves it (proplib's identifier reference, lane L3/L4) and the reader only ever sees a number — a non-number throws native's "Expecting float.", never a default |
| `genome/cache-state` | `groups/groupsGenomeSchema.ts` | every cache getter keeps native's two phases (`STATE_COMPLETE` → cached, `STATE_CACHING` → compute+store) and throws outside them |
| `genome/groups-first-group-overloads` | `groups/groupsGenomeSchema.ts` | native overloads `getFirstGroup( Gene * )` / `getFirstGroup( NeurGroupType )`; the port spells them `getFirstGroup(gene)` / `getFirstGroupOfType(type)` |
| `genome/groups-overloaded-get` | `groups/groupsGenome.ts` | native's `get`/`seed` overloads become `getGroupAttr`/`getSynapseAttr` and `seedGroupAttr`/`seedSynapseAttr`; `getNeuronCountOfGroup`/`getSynapseCountOfGroups` name the two-argument `getNeuronCount`/`getSynapseCount` |
| `genome/synapse-attribute-matrix` | `groups/groupsSynapseType.ts` | the matrix arithmetic verbatim, including `index * mutableSize` (not a prefix sum) and `assert( to >= groupCount[INPUT] )` |
| `genome/synapse-count-arithmetic` | `groups/groupsGenome.ts` | `nint( cd * nfrom * nto )` rounds each multiply to f32 as C does; doing it in double changes the count for some densities |
| `genome/inhibitory-negation` | `groups/groupsGene.ts` | `min( -1.e-10, -(double)result )` resolves to `std::min<double>` in native, so the `LearningRate` negation returns a FLOAT scalar; both branches reproduced |
| `genome/group-titles` | `groups/groupsGene.ts` | `getTitle` returns a *label* (`InternalNeurGroup <n>`, else the gene name); `genetitle.txt` is built from it and the immutable case asserts the group index |
| `genome/seed-cast` | `groups/groupsGenomeSchema.ts` | `seed`'s `dynamic_cast<GroupsGenome*>` becomes an `instanceof` check that throws (native would dereference NULL) |
| `genome/designer-genes` | `genomeUtil.ts` | `#if DesignerGenes` is undefined in the oracle tree (grep-verified), so `GenomeUtil::randomize` is `g->randomize()`; `seed()` stays reachable but is never called from there |
| `genome/metabolism-seam` | `genomeUtil.ts` | `getMetabolism` returns the `MetabolismIndex` gene value; the metabolism *table* is built by L11 from the worldfile |
| `genome/separation-cache-key` | `separationCache.ts` | the per-agent attached slot becomes a `Map` keyed by `Number()` (unique and stable, it is the log identity); death now frees the entries (native leaks them) |
| `genome/meta-sort` | `metaFiles.ts` | `sort -n` on `genelayout.txt`: unique integer keys, byte tie-break, locale-independent |
| `genome/create-brain-stub` | `groups/groupsGenome.ts` | `GroupsGenome::createBrain` throws a lane-L6 error; PARITY.md → Gaps names the closing lane (PORT_SPEC rule 7) |
| `genome/cppprops-gene-symbol` | `src/model/genome/native/*`, `tools/cppprops/bindings/gene.mjs` | the `$[gene, NAME, min\|max]` cpp symbol is the *address of the gene's `Scalar`* (`metadata[i].value = &(…->smin.__val)`), so the property's value is the gene's range member and the *property's* type picks the union member the native reads (`*(float *)value`). The binding serves `getMin()`/`getMax()` through that read, bit-for-bit; the FLOAT↔INT punning is reproduced and a BOOL `Scalar` read as float/int is refused (native reads bytes `Scalar::Scalar(bool)` never writes). `native/genevalueprobe.cc` measures the read (8 rows, deterministic) — the *gene* whose `Scalar` is in play is native ground truth this lane already reproduces (`run/genome/meta/generange.txt`) |

Parity, measured through the harness (candidate tree = what `tests/genome.test.ts` writes,
`POLYWORLD_GENOME_CANDIDATE_ROOT=<dir>`):

```
./oracle/run_parity.sh microtest_voff --candidate <dir>/microtest_voff --ignore … \
  -> match 30/225  differing=0 missing=0 extra=0 ignored=195   PASS (225/225)  exit 0
./oracle/run_parity.sh minitest_voff --candidate <dir>/minitest_voff --ignore … \
  -> match 30/1369 differing=0 missing=0 extra=0 ignored=1339  PASS (1369/1369) exit 0
```

The 30 matching files are the five schema-derived `run/genome/meta/*.txt` (2,843 gene rows
each: gene order, layout order, the `sort -n` pass, titles and ranges — byte-for-byte) plus
the 25 initial-population `run/genome/agents/genome_<n>.txt.gz`. The agent genomes are
reachable *without* the simulation because `TSimulation::SeedGenome` seeds them with
`SeedMutationProbability 0.0` and `RawSeedMutationRate 0.0`: the draws happen but cannot flip
a bit, so the contents are RNG-free — which is why all 25 are byte-identical in the golden.
The gzip framing (`Z_DEFAULT_COMPRESSION`, mtime 0, OS byte 0x13, CRC32/ISIZE) is lane L2's
sink and was measured byte-identical here. `run/genome/genestats.txt` and
`run/genome/separations.txt` need the step loop (L11/L12); the 62 later-born agent genomes in
`minitest_voff` are crossover products of the run and are listed as ignored rather than
hidden.

Verification for L5: `tests/genome.test.ts` **35/35** (parity + semantics: interpolation per
rounding mode, the f32 ratio and range-difference roundings, a 2,816-row sweep against the
native expression written out longhand, the probe anchors below, the `nint` epsilon, the
schema state machine, layout validation, the gray tables, seeding/mutation/crossover draw
counts through a scripted `RngSurface`, separation's f32 division, the synapse-count rules,
the separation cache, `sort -n`, and a scan proving no `Math.random` anywhere in the lane).
`npx tsc --noEmit` is clean for `src/model/genome/**`. The lane's other cut — the cpp-props
`$[gene,…]` symbol, i.e. a `dyn` property whose *storage* is the gene's `Scalar` — is
covered by `tests/cppprops-gene-binding.test.ts` **24/24** together with lane W1h's
interpreter: the port's genome layer reproduces the native binary's own
`run/genome/meta/generange.txt` for the oracle scenarios *and* for the new
`tools/cppprops/fixtures/worldfiles/gene_dyn.wf`, the union read is pinned against
`native/genevalueprobe.cc`, and that fixture's 300 native farm lines replay through
`tools/cppprops/bindings/gene.mjs` with the gene table built from this lane's `GenomeUtil`
(details and residuals: `docs/specs/cppprops.md` §3, *The `$[gene, …]` class*).

**The interpolation-arithmetic finding (review round 1 → 2).** Review caught `gene.ts`
computing two of native's float operations in f64: `double ratio = float(raw) * OneOver255`
is a float × float multiply (f32 product, *then* widened) and the FLOAT case's
`interp` subtracts two floats. Differential evidence, collected here: a probe compiled from
the oracle tree's own sources (`clang++ -std=c++17 -O2` over `genome/Gene.cc`,
`genome/GeneSchema.cc`, `utils/Scalar.cc` — the same flags as the golden build) called
`__InterpolatedGene::interpolate( unsigned char )` for all 256 raw bytes of all 19
interpolated ranges `generange.txt` defines (min/max handed over as exact f32 bit patterns
dumped from the port, so only the arithmetic is under test):

```
native vs PRE-FIX  port : 540 of 4864 (gene, raw) rows differ in the f32 value
                          Bias 158, MutationRate 83, BitProbability 76, LearningRate 60,
                          MaxSpeed 54, MateEnergyFraction 41, Size 34, Strength 34
native vs POST-FIX port :   0 of 4864
rows the fix changed    : 540            (nothing at raw 0/1/2/4/8/…/128)
```

The recorded scenarios are structurally blind to it: the seeded genomes live at raw 0/128/255,
where a power-of-two raw makes the double product exact, so `run/genome/**` stays byte-identical
either way — measured after the fix: microtest 30/225, minitest 30/1369, `differing=0`, exit 0.
It is *not* blind in general: the golden's born-agent genomes carry 43 resp. 94 distinct byte
values against 3 in the seeded ones, so once L11 runs the loop, mutated genes are read at
arbitrary raws — and `Bias` feeds brain construction. Three of the eight affected genes were
already visible in the printed `%f` text (`Bias` raw 33 `-5.929411` → `-5.929412`,
`BitProbability` raw 123 `0.341177` → `0.341176`, `Strength` raw 208 `1.723529` → `1.723530`);
those rows, plus two rows the fix must *not* move, are asserted as anchors in
`tests/genome.test.ts` (they fail on the pre-fix arithmetic — checked by reverting it).

## PORT-NOTEs (L14 monitor)

The lane adds no model behaviour of its own — it observes, selects and records — but every one of
these decisions is a place where a plausible-looking port diverges silently. Tag → file →
decision:

| PORT-NOTE | File | Decision |
|---|---|---|
| `monitor/observer-only` | `simSurface.ts` | monitors consume **no RNG and no wall clock** (measured: `grep -rn "rand\|drand48\|hirestime" library/monitor/*.cc` → 0 hits; also `docs/specs/sim-spec.md:820`), so they can be stepped in any order without perturbing the model's bytes |
| `monitor/simconst-extras` | `simSurface.ts` | `AgentBirthType`/`FitnessWeightType`/`FitnessStatType`/`FoodEnergyStatType`/`FoodEnergyStatScope` live here, not in the frozen `types/simconst.ts`, which deliberately carries only cross-lane vocabulary; native member order kept |
| `monitor/agent-removeListener-alive-guard` | `simSurface.ts` | native `agent::removeListener` is a no-op for a dead agent (`agent.h:375`), so the death listener stays registered on the dying agent; the tracker calls it regardless, and lane L8 must apply the `fAlive` guard inside the implementation |
| `monitor/sim-status-text` | `simSurface.ts` | `getStatusText( out, statusFrequency )` appends and is synchronous; native `strdup`s lines the monitor frees, the port uses plain strings and `out.length = 0` |
| `monitor/type-enum` | `monitor.ts` | `Monitor::Type` values/order (CHART 0 … SCENE 5) are UI-dispatch ABI; pinned by `vectors/enums.json` |
| `monitor/dump-is-empty` | `monitor.ts` | native `Monitor::dump` is empty with no overrides (grep-verified); kept for surface fidelity, takes a text sink instead of an `ostream` |
| `monitor/signal-home`, `monitor/signal-handles` | `signal.ts` | `util::Signal.h` is a header template no lane owns; the lane implements it (lift into `types/` if another lane needs it) with opaque handles instead of list iterators |
| `monitor/birthrate-counter-choice` | `charts.ts` | the birth counter (`BORN` vs `BORN_VIRTUAL`) is chosen **once in the constructor** from lockstep/weights; a mid-run weight change does not switch it |
| `monitor/foodenergy-float-division` | `charts.ts` | `(in - out) / (in + out)` is f32 division of f32 operands; the port `Math.fround`s both the operands and the result |
| `monitor/population-curve-count` | `charts.ts` | `npops = domains < 2 ? 1 : domains + 1`, and `assert( ncolors >= npops )` is real (assertions are on in the recorded build: `nm -u lib/libpolyworld.dylib` lists `___assert_rtn`) → the port throws instead of clamping |
| `monitor/parms-union` | `agentTracker.ts` | native `Parms` is a tagged `union` whose inactive member reads uninitialized memory; the port models a discriminated union so the mis-read is unrepresentable |
| `monitor/setTarget-is-native-private` | `agentTracker.ts` | `setTarget` is native-private with `friend Listener/MonitorManager`; TS has no friendship, so it is public-but-documented and only those two may call it |
| `monitor/degtorad-is-a-literal` | `cameraController.ts` | `#define DEGTORAD 0.017453292`, a 7-digit literal, **not** `Math.PI/180` |
| `monitor/camera-single-precision-trig` | `cameraController.ts` | native picks the C++ **float** overloads (`sinf`/`cosf`) — measured `sizeof(sin(camrad)) == 4` — and, in the shipped build, LLVM's sincos combine merges the two adjacent calls into **`__sincosf_stret`** (`bl ___sincosf_stret` in `libpolyworld.dylib`; the two-output entry at `sinf + 0x1ac`). The port calls the transcribed `sincosf` and narrows at the product (`tests/rng.test.ts`, PARITY.md open question 9 → resolved) |
| `monitor/camera-float-narrowing` | `cameraController.ts` | `radius * sin(camrad)` is a float product, `0.5` is a double literal, `worldsize` is a float; the port narrows at the product and at the argument, nowhere else |
| `monitor/camera-undefined-mode` | `cameraController.ts` | native `step()`'s `default: assert(false)` aborts (assertions on) → the port throws |
| `monitor/camera-object-is-L15s` | `cameraController.ts` | the lane holds a `gcamera`-shaped interface and never a second camera implementation (the hazard `vision/camera.ts` recorded until the L15/L16 collapse — `t_1feec49a`, PARITY.md *Open questions* 6 — removed the last second copy) |
| `monitor/movie-should-record` | `movieController.ts` | `record && ((timestep - 1) % sampleFrequency < sampleDuration)`, integer modulo kept verbatim (C++ and JS agree on the sign of the dividend, incl. `timestep 0`) |
| `monitor/movie-big-endian-guard` | `movieController.ts` | the compile-time `__BIG_ENDIAN__` recording kill-switch is dropped (Deviations) |
| `monitor/movie-file-open` | `movieController.ts` | native opens the file in the constructor and asserts `shouldRecord()`; the port takes an injected writer and keeps the assert as a throw |
| `monitor/movie-writer-is-not-this-lane` | `movieWriter.ts` | `PwMovieWriter`/`MovieRecorder` are declared here, implemented by the utils/renderer lanes (Gaps) |
| `monitor/scene-renderer-surface`, `monitor/camera-perspective-args` | `sceneRenderer.ts` | the base renderer's surface is the seam; `SetPerspective( fov, float(w)/float(h), 0.01, 1.5 * worldsize )` is reproduced in `sceneCameraPerspective` with the same narrowings |
| `monitor/scene-monitor-title` | `sceneMonitor.ts` | native passes the scene **name** as the monitor title (`Monitor( SCENE, sim, id, name, name )`), unlike every other monitor |
| `monitor/scene-movie-writer-injection` | `sceneMonitor.ts` | the writer factory is called only when `shouldRecord()`, i.e. exactly when native would open the file |
| `monitor/status-text-gating` | `statusTextMonitor.ts` | display needs `timestep == 1 \|\| timestep % frequencyDisplay == 0` **and** a receiver; store needs only the modulo against `frequencyStore` — the asymmetry is native's |
| `monitor/status-text-rate-filter` | `statusTextMonitor.ts` | with `StorePerformance False` a line is dropped when its **first four bytes** are `Rate` (`EatRate`/`MateRate` survive; the appended performance lines do not) |
| `monitor/status-text-file-write` | `statusTextMonitor.ts` | `run/stats/stat.<%ld>` + `makeParentDir` + `"w"` + `"%s\n"` per line + `fclose`, with the I/O injected and a failed open a throw (`ERRIF`) |
| `monitor/brain-frequency-modulo` | `brainMonitor.ts` | `timestep % frequency == 0`, divisor never 0 (schema `min 1`) |
| `monitor/farm-is-present-not-truthy` | `farmMonitor.ts` | `getenv( "PWFARM_STATUS" ) != NULL` counts an **empty** value as "in a farm" |
| `monitor/farm-command-string` | `farmMonitor.ts` | the `bash -c 'PWFARM_STATUS Polyworld "[a=b c=d]"'` string is built byte for byte (space-separated, no trailing space) and handed to an injected runner; a non-zero result logs native's message |
| `monitor/farm-metadata-provider` | `farmMonitor.ts` | the name→metadata match is the monitor's, the metadata source is W1h's |
| `monitor/manager-takes-documents` | `monitorManager.ts` | native builds the two documents itself; the port takes the schema-applied root so a scene can be selected without a file system or a proplib import |
| `monitor/number-tracker-ignores-trackmode` | `monitorManager.ts` | native computes `bool trackTilDeath = trackMode == "Agent"` in **both** tracker arms (`MonitorManager.cc:69`, `:76`) but only the Fitness arm forwards it: the Number arm calls `AgentTracker::Parms::createNumber( number )` (`:78`), taking the factory default `true` (`AgentTracker.h:24`). The local at `:76` is **dead**, so a `SelectionMode Number` tracker holds its agent until death for *any* `TrackMode` (`Slot` included — `etc/monitors.mfs` is `Agent \| Slot`). The port reproduces the dead local by passing `createNumberParms( number )`; forwarding it would be a silent fix of C++ that looks wrong (rule 1). Pinned in band 2 from the in-memory document double (`Number`+`Slot` ⇒ `trackTilDeath true`, `Fitness`+`Slot` ⇒ `false`) |
| `monitor/fatal-errors-are-throws` | `monitorManager.ts` | `"Invalid CameraSettings Name:"`, `"Invalid CameraControllerSettings Name:"`, `"Invalid AgentTracker name:"` and three `assert(false)` all abort natively → the port throws with native's text |
| `monitor/scene-renderer-and-writer-seams` | `monitorManager.ts` | renderer + writer factories are injected; the *selection* is unchanged by the injection |
| `monitor/document-not-worldfile` | `monitorDocument.ts` | the monitor document is built with `buildDocument` (no v1 conversion, no `--Key value` overrides), exactly as native |
| `monitor/document-evaluator-cutover` | `monitorDocument.ts` | the L4 stand-in for property references and its default wiring are **deleted** (lane L4 landed): `monitorDocumentEvaluator` is `interpreterEvaluator`, and the 89 + 89 native leaves of both real monitor documents still match (`tests/monitor.test.ts`) |
| `monitor/apply-validate-opt-in` | `monitorDocument.ts` | `validate: false` by default, native default for `apply` itself (Deviations) |
| `L14/native-probe` | `native/monitorprobe.{cpp,sh}`, `native/vectors/*` | oracle tooling, not model code: links `libpolyworld.dylib`, reads the native tree, never writes it; `vectors/` are committed so `npm test` needs no C++ |

## PORT-NOTEs (L8 agent core)

`src/model/agent/**` — the agent's step, energy, lifespan, steering, eat/mate/carry,
collisions, the proprioceptive sensors and the native differential probe. Every semantic
choice, and what it is anchored to:

| PORT-NOTE | File | Decision |
|---|---|---|
| `L8/native-probe` | `native/agentprobe.cpp`, `native/agentprobe.sh` | the lane's evidence is generated by *calling the native build* (`<native>/lib/libpolyworld.dylib`), not by re-deriving it: `GetCollisionFixedCoordinates`, the whole `Energy` arithmetic surface, `agent::processWorldfile` (on the registered scenario's worldfile, through the same schema→worldfile→`apply` pipeline `Simulation.cc` uses) and `LifeSpan::BR_NAMES`/`DR_NAMES`. Floats are emitted as IEEE-754 bit patterns; the vectors are committed (`native/vectors/*.json`) so `npm test` needs no native tree. Tooling only — nothing in `src/model/**` imports it |
| `L8/energy-home` | `environment/energy.ts` (was `agent/energy.ts`) | native `environment/Energy.{h,cc}` is **there** now. The agent core cannot be expressed without it and L10's directory did not exist when L8 landed, so L8 carried the definition and asked for it to be *moved*, not copied, once both lanes were quiescent — done by `t_4e856769` (2026-09-28): the module body (and `MAX_ENERGY_TYPES`/`ENERGY_EPSILON`, out of `agent/numeric.ts`) lives in `src/model/environment/energy.ts`, L8's importers point at it, and this lane's barrel re-exports it so `import { Energy } from '../model/agent'` still resolves. Two definitions is the one outcome that silently changes every recorded energy log — `grep -rn '^export class Energy\b' src` is one line, and all six scenarios still PASS |
| `L8/float-narrowing-order` | `agent.ts`, `numeric.ts` | the model's floats round at every store *and* at every float-typed operand, so `f32` wraps each product/sum in the native evaluation order (left to right, no reassociation). Where native mixes in a `double` (a `double` local, `2.0`/`4.0` literals, `M_PI`-derived `DEGTORAD`, `TSimulation`'s `double` scale factors) the port keeps the double and narrows only at the native assignment. Getting the *site* of the narrowing wrong is a last-bits divergence — the vectors caught exactly that during this lane (a first transcription rounded `c = ... + 2.0 * (...)` one operation early). **Round-1 review (2026-09-28) found the rule had been applied at the wrong granularity in five more places** — one `f32` over a compound expression where native narrows every operand — and all five are fixed and pinned in `tests/agent.test.ts`: `fSpeed` (`agent.cc:1435`), `rewardmovement`'s `\|Δx\|+\|Δz\|` (`922-924`), `FieldOfView` (`1902-1903`), the vision pitch/yaw (`1079`/`1085`), `setradius`'s `sqrt(...)*rs*fs*0.5` (`790`), plus `dosquared`/`dssquared` (`1595`/`1608`), the size-penalty denominator's association (`741/747`), the barrier pass's float comparisons and `p` stores (`1280-1301`) and the collision range tests (`1566-1577`). `FF` is narrowed too (`const float FF = 1.01`, `agent.cc:1111`): a JS `1.01` double is a different float at every `FF * CarryRadius()` |
| `L8/contraction` | `agent.ts`, `numeric.ts` | native is built with clang `-O2`, whose `-ffp-contract=on` default makes a source `a*b + c` **one** rounding (a hardware `fmadd`/`fmsub`/`fnmsub`) wherever the product *and* the destination are `float`. The port therefore transcribes the **disassembly** of the shipped function, site by site, with `f32Fma` (an exactly rounded binary32 `a*b + c`; `Math.fround(a*b + c)` rounds twice and is not equivalent — see *the float-contraction rule*). Sites in this lane: the whole `GetCollisionFixedCoordinates` quadratic (`0x27504`), `fSpeed` (`UpdateBody 0x26da8`), `dosquared`/`dssquared` and the `xs`/`zs` step (`AvoidCollisionDirectional 0x27420-0x2746c`). `b*b - 4.0*a*c` is deliberately **not** fused: the source narrows `b*b` to `float` before the `double` subtraction |
| `L8/gobject-direction-constants` | `contracts.ts` | `GObject` carries two *different* native vocabularies: the object-type bits of `graphics/gobject.h` and the traversal directions of `utils/objectxsortedlist.h` (`#define NEXT 1` / `#define PREV 2`; `anotherObj` prints `"ERROR--Unknown direction"` and `exit(1)`s on anything else). The round-1 review caught the port declaring `PREV: 0` — a value the native walk aborts on — which lane L11 was papering over with a mapping at the seam; the constants are now native's, so that mapping is a pass-through. `NEXT` is 1 like `AGENTTYPE`, which is native's own collision, not an argument for merging them |
| `L8/mate-wait-cast` | `agent.ts` | a seeded mate wait is `fLastMate = (long)( randpw() * -mateWait )` (`agent.cc:680`) — a C cast, i.e. **truncation toward zero**, not the `nint` macro (`misc.h:36`, which rounds negatives away from zero and is what the Metabolism index uses). The round-1 review caught `nint` here: for `x = -17.6` native stores -17 and the port stored -18, a different mate wait for every seeded agent whenever a worldfile sets `RandomSeedMateWait True` |
| `L8/config-singleton` | `agentConfig.ts` | native's statics are zero-initialized and only overwritten by `processWorldfile`, so the port starts at zeros and takes no per-field default |
| `L8/config-error-is-a-throw` | `agentConfig.ts` | the `assert(false)` arms (unknown `YawEncoding`) and the `default:` arms of the three body-colour switches throw `AgentConfigError` with the native condition. A port that picked a branch would diverge with no message |
| `L8/out-params-returned` | `agent.ts` | `eat()`'s three `Energy&` out-parameters and `GetCollisionFixedCoordinates`'s `float*` outputs are returned as records; values identical, and a caller cannot forget to read one |
| `L8/event-sink-is-injected` | `contracts.ts` | native's `logs` is a process-wide pointer; the port injects `EventSinkLike` through `AgentDeps`. Structure, not behaviour (PORT_SPEC: behaviour frozen, structure free), and it is what lets the lane test drive an agent without the recorder stack |
| `L8/deps-bundle` | `contracts.ts` | `agent::agent(sim, stage)` plus everything it reaches through native globals (`agentobj`, `GenomeUtil::createGenome`, `new NervousSystem()`, `logs`, the `randpw()` stream, the environment statics) arrives explicitly. A native static read before the simulation sets it is silently zero; an explicit bundle cannot be |
| `L8/lane-seams` | `contracts.ts`, `nervousSystem.ts`, `sensors.ts` | the boundary is interfaces with the native calls and units spelled out, not imports of modules that did not exist at the time (see Gaps for the binding list). What is *not* here: anything the agent core only stores (Retina, the renderer are opaque), GL/drawing, and the worldfile→`Metabolism` wiring (L11 performs it; this lane declares the result type) |
| `L8/nerve-order-is-contract` | `nervousSystem.ts` | `createNerve` assigns indices in call order and the genome's topology refers to nerves by index, so the input/output nerve tables are transcribed in native order with their conditionals. Native **adds the speed sensor twice** (`agent.cc:575-578`) and the port reproduces the double registration |
| `L8/gene-cache-lifespan` | `agent.ts` | `geneCache.lifespan` is the gene's `LifeSpan` when `DieAtMaxAge`, otherwise `INT_MAX` — and `MaxAge()` divides a fair amount of the fitness code, so the fallback is not cosmetic |
| `L8/lifespan-struct` | `lifeSpan.ts` | native's nested `birth`/`death` structs (mutable, `-1`/`INVALID` initial state) are kept, because L11/L12 stamp and read them in place; the reason names/values come from the frozen `types/lifespan.ts` (verified against the native tables by the probe, byte-for-byte) |
| `L8/metabolism-registry` | `metabolism.ts` | definition order *is* the index (`get(index)` must return the same object), so the registry is an array in definition order and nothing may reorder it. `selectionMode` is process-wide (native static) |
| `L8/sensor-preproprioception-switches` | `sensors.ts` | the native per-file `DISABLE_PROPRIOCEPTION` values are transcribed (`MateWait`/`Speed` live, `Carrying`/`BeingCarried`'s macro only guards an unused local — the live value is what native computes) |
| `L8/carryable-kinematics` | `agent.ts` | an agent is itself carryable, so `PickedUp`/`Dropped` (native `gobject`) are ported here with the carry offset and the world-edge clamp, rather than being assumed to belong only to the environment's objects |
| `L8/native-probe-gotchas` | `native/README.md` | the two facts that cost time: `proplib::Interpreter::init()` must precede any `getEvaledString()` (else the first dynamic property read segfaults) and `dispose()` must precede exit (else the python child keeps the inherited stdout pipe open and a reader waits forever) |

Verification for L8: `npx vitest run tests/agent.test.ts` — **26/26 pass** (21 differential/golden
tests from the first round + 5 pins added by the round-1 review: the `NEXT`/`PREV` constants as
they reach `anotherObj`, the seeded mate-wait cast, `fSpeed`'s narrowed squares, the size-penalty
denominator's association, and a collision geometry where the per-operand narrowing *flips the
approaching decision*), `npx tsc --noEmit` clean (whole tree), and the lane's measured numbers are

* `agent::GetCollisionFixedCoordinates`: **3022/3022** native cases bit-for-bit — 16 crafted
  branch/early-out cases, 6 crafted *contraction* cases (added by t_4392393c) and 3000 random —
  with the tolerance branch deleted from `tests/agent.test.ts`. Round 1 measured 2951/3016 with
  the other 65 within 5.455e-4; t_4392393c disassembled the shipped function (0x27504) and
  transcribed the contraction it actually performs (`fmadd`/`fmsub`/`fnmsub` -> `f32Fma`), which
  accounts for the whole residual. Re-running `native/agentprobe.sh collision` against
  `<native>/lib/libpolyworld.dylib` keeps the original 3016 rows byte-identical, and the 6 added
  cases fail a rounds-per-operation transcription (see *the float-contraction rule*);
* `Energy`/`EnergyPolarity`/`EnergyMultiplier` arithmetic: **600/600** cases bit-for-bit
  (every operator, both constrain forms, depletion thresholds, NaN polarities, 1–4 energy types);
* `agent::processWorldfile` against the worldfile `minitest_voff` was recorded from:
  **every field** — 48 floats (bit-exact), 4 longs, 13 bools, 5 enum selections — equal to the
  native build's `agent::config`;
* `LifeSpan::BR_NAMES`/`DR_NAMES`: equal to the native tables;
* golden-anchored lifecycle invariants, all **87** agents of `minitest_voff`: each agent's
  `run/energy/agents/agent_N.txt` series is contiguous, starts at the birth step (the step
  after, for the `SIMINIT` agents born at step 0) and **ends exactly at the death step** in
  `lifespans.txt`; each `run/motion/position/agents/position_N.txt` series starts on the step
  after birth and also ends at the death step; every `SIMEND` death is on the final step.

The lane's own acceptance artifacts (`run/energy/**`, `run/motion/**`, `run/lifespans.txt`
byte-compare through `./oracle/run_parity.sh minitest_voff --candidate <run tree>`) need the
neighbour lanes' concrete modules and L11's step loop; the Gaps row above names the bindings.

## PORT-NOTEs (L12 logs)

`src/library/logs/**` (2,797 lines) ported to `src/model/logs/**`. Every semantic decision a
reviewer can disagree with, and what it is anchored to:

| PORT-NOTE | File | Decision |
|---|---|---|
| `l12/seam-not-import` | `seams.ts` | native `Logs.cc` includes `agent/agent.h`, `Brain.h`, `GenomeUtil.h`, `Simulation.h`, `datalib.h` and walks concrete objects; the port declares the *smallest* interface per collaborator (`LogAgent`, `LogSimulation`, `LogBrain`, `LogGenome`, `LogEnergy`, `LogFoodType`, `LogSortedObjectList`, `LogGeneStats`, `LogFittestList`) and never imports another lane's internals. Members are named after the native call site (`a->Number()` -> `number()`) so the recorder bodies can be diffed line by line |
| `l12/log-environment` | `seams.ts` | native reaches the file backends, `objectxsortedlist::gXSortedObjects`, `GenomeUtil`, `FoodType` and `computeAdamiComplexity` as process globals with argument-less recorder constructors. The port keeps one `LogContext` per run: the file seam has to be injectable (browser/headless) and a replay harness has to be able to drive the same recorders. `this.env.world` *is* `gXSortedObjects` at every call site that used it |
| `l12/file-system-seam` | `seams.ts`, `nodeFiles.ts` | native's three file kinds (`fopen`, `AbstractFile::open( globals::recordFileType, … )`, `DataLibWriter`) plus `AbstractFile`'s `exists`/`link`/`rename`/`unlink` statics and `makeDirs`/`makeParentDir` become one `RecordFileSystem`; the node adapter is the lane's only `node:*` user and is not re-exported, so the recorders stay bundleable |
| `l12/text-sink-format` | `seams.ts`, `formatSink.ts`, `logger.ts` | native writes through **two** `fprintf` shapes on the same `AbstractFile`: pre-formatted text (`fprintf( f, "%s", line )`) and format-plus-values (`fprintf( f, format, … )` — every `Brain::dump*` and all of `complexity/adami.cc`). The port froze only the first (`TextSink.printf( text )`), and a one-parameter method satisfies a rest-parameter signature in TS, so a caller using the second had its values **silently dropped and the format string written into the file** (measured: `run/brain/anatomy/brainAnatomy_10_birth.txt.gz` line 1 held `brain %ld fitness=%g …`). One sink now serves both: **no** extra arguments = the text is the line, written verbatim (`%` is literal — `'% Timestep Event Agent# …'` is a real `BirthsDeaths.log` line and native's own `fprintf( f, "%% Timestep …" )` prints one `%`, so a value-less format is rendered by its caller); **one or more** = native's format plus values, applied by lane L6's pinned `sprintfC` (`brain/core/cformat.ts`, the port's only C-format implementation and the one with `%g`). The lane's `FileLogger`/`AbstractFileLogger` wrap every sink they hand out, whatever backend opened it (node, browser, memory); a sink opened directly from `RecordFileSystem` is the raw backend sink and is only used by pre-formatted call sites |
| `l12/node-adapter` | `nodeFiles.ts` | `SystemCommand` is `child_process.execSync` (native `SYSTEM`), `openAbstract` chooses gzip from `recordFileType`, and `exists/link/rename/unlink` are `stat`/`::link`/`::rename`/`::unlink` |
| `l12/gzip-append` | `nodeFiles.ts` | native appends with `gzopen( path, "a" )`; the deferred-gzip sink (W1c's reason: no `node:zlib` in the browser, and mid-file `gzflush` only moves container bytes) decompresses, appends and re-compresses. Content-identical, container bytes need not be; nothing recorded appends to gzip (`AdamiComplexityLog` is the only appender and `CompressFiles` does not affect `fopen`) |
| `l12/system-call` | `simLogs.ts` | `SYSTEM( cmd )` (`utils/misc.h:135`) runs the command and `exit(1)`s on failure; the port routes it through the seam so a browser adapter can refuse. Both call sites are off in the recorded scenarios (`RecordGitRevision False`; the `sort -n` pass is done in-process by L5's renderer) |
| `l12/state-is-explicit` | `logger.ts` | native's `union { _nullScope; _simulationScope; _agentScope }` is a type-punned `void *`; the port keeps two live fields and asserts the same scope precondition on each accessor, so a wrong-scope read fails loudly instead of reinterpreting a pointer |
| `l12/agent-slot-store` | `agentSlots.ts` | `AgentAttachedData` (the per-agent `void *` array the loggers use for `FILE *`/`DataLibWriter *`/`AbstractFile *`) becomes a `Map`-backed store with lazy slot-array creation; L8 owns `alloc`/`dispose` (agent lifetime) |
| `l12/event-registry-bits` | `registry.ts` | `sim::EventType` is an `int`, so `registerEvents` walks **32** bits and builds each type as `EventType(1) << bit`; the port does the same with JS `<<` (bit 31 is negative, as in the C) |
| `l12/dispatch-order` | `registry.ts` | within one event type, loggers run in install order (= `Logs.h` declaration order); a recorder that registered for an event it does not handle hits the base `processEvent`, i.e. native `assert( false )`, which the port throws |
| `l12/recorder-construction-order` | `logs.ts` | the field order is `Logs.h`'s member order and is observable (dispatch order, `getMaxOpenFiles` sum) — not cosmetic, do not sort |
| `l12/recorders-take-the-environment` | `agentLogs.ts` … | native's recorders are default-constructed members; the port's constructors take the run's `LogContext`. Nothing else differs |
| `l12/destructor-order` | `logger.ts`, `logs.ts` | native closes the run's files in member-destructor (reverse declaration) order and only when the scope is `SimulationStateScope` and the logger recorded; the port's `dispose()` calls `close()` in reverse order |
| `l12/agent-file-per-type-number` | `agentLogs.ts` | per-agent paths are built from `agent::getTypeNumber()` (`agent_%ld.txt`, `position_%ld.txt`) while `lifespans.txt`/`BirthsDeaths.log` write `Number()` — both accessors kept |
| `l12/birthsdeaths-uses-w1c-formatters` | `agentLogs.ts` | the *bytes* of a `BirthsDeaths.log` line are W1c's (`datalib/birthsDeaths.ts`); this lane owns the plumbing: the header, `BR_SIMINIT`/`DR_SIMEND` silence, `BR_VIRTUAL` printing `0`, and `createFile` going through plain `fopen` even when `CompressFiles True` |
| `l12/sorted-list-order` | `seams.ts` | `AgentEnergyLog`/`FoodEnergyLog`/`BrainFunctionLog` walk the world in x-sorted order; the port takes the walk from the environment instead of owning the container, so the order stays the sim/environment lane's contract |
| `l12/event-token-tables` | `eventLogs.ts` | the logs store *words* where the model carries an enum: `{"P","D","Do"}` (carry action), `{"G","F","E"}` (energy action), `{"A","F","B"}` (gobject bits, with `assert(false)` for a barrier/edge). `{"agent","food","brick","barrier","edge"}` lives in `types/simconst.ts` because W1a froze it |
| `l12/contact-nul-terminator` | `eventLogs.ts` | the `Events` column is `encode(c) + 'C' + encode(d)`; the letters and their order (`M` then `p c w e f i d x t m v o`, `F` then `c s p`, `G` then `c e`) are the format. Native's `*(b++) = 0` terminator is not written (`%s` stops at it) and the port never puts it in the string; `MATE__PREVENTED__OF1` has no letter (`#ifdef OF1` is undefined) |
| `l12/food-energy-f32-accumulator` | `eventLogs.ts` | `FoodEnergyLog` accumulates per-food-type energy in a native `float[]`; the port `Math.fround`s at every add rather than summing in double and rounding once |
| `l12/brain-file-naming` | `brainLogs.ts` | the anatomy/synapse suffixes are `{incept, birth, death}` and the `bestRecent`/`bestSoFar` files are named `<rank>_…` (the rank in the fittest list, not the agent number); the `learningMode` gates are `!= LEARN_NONE` for `incept` and `== LEARN_ALL` for `death` |
| `l12/link-and-rename-refuse` | `brainLogs.ts` | `AbstractFile::link`/`::rename` are raw `::link`/`::rename` that do nothing when the destination exists or the source is ambiguous (both backends present); the port routes both through the seam, so a re-run into a non-empty tree keeps native's first-writer-wins behaviour. `BrainFunctionLog` renames its `incomplete_` file, links `Recent/<epoch>` and (for `number <= InitAgents`) `Recent/0`, and records the finished path in `brainAnalysisParms.functionPath` |
| `l12/best-recent-stats` | `brainLogs.ts` | `BrainComplexityLog::writeBestRecent`'s two degenerate cases are load-bearing: an empty fittest list gives `0/0 = NaN`, the `!(mean >= 0)` test zeroes mean **and** stddev, and `sqrt(0 / (0-1))` is `-0`, which `%f` prints as `-0.000000`. Both reproduced |
| `l12/separation-table-name` | `genomeLogs.ts` | `separations.txt` is `randomAccess=false, singleSchema=false` (multi-table) and each table is named by `sprintf( buf, "%ld", agent->Number() )` — so the tables read `#<23>`, `#<13>`, … in **death** order; the rows are the cache entries of the *dying* agent |
| `l12/complexity-row-order` | `brainLogs.ts` | `ComplexityMap` is `std::map< long, float >` (`Logs.h:178`) and `writeComplexityFile` iterates it (`Logs.cc:678-681`), so `complexity_<type>.plt`'s rows are in **ascending agent number** whatever order the analyses arrived in — they run on several threads in native, so arrival order is not deterministic there either. The port's `Map` is insertion-ordered and sorts at the write site, the same fix as `l12/separation-table-name` |
| `l12/genome-barrel-import` | `genomeLogs.ts` | the recorders call `GenomeUtil::schema`'s printers, `Genome::dump`, `get_raw_uint` and `SeparationCache` through lane L5's barrel — a structural copy of the gene-schema printers here would be a second implementation of a file format L5 owns |
| `l12/genestats-float-format` | `genomeLogs.ts` | `genestats.txt` is `"%d\n"` + per step `" %.1f,%.1f"` per mutable gene, from native `float *` arrays: the port `Math.fround`s before formatting and uses W1c's exact-decimal `%f` rather than `toFixed` (ties go the other way) |
| `l12/adami-max-open-files` | `simLogs.ts` | `AdamiComplexityLog::getMaxOpenFiles()` returns a constant 4 (four files per record), not the base class' scope-derived count |
| `l12/fittest-size-spelling` | `seams.ts` | native's accessor is `FittestList::size()`; L11's class keeps a private `size` field and exposes `getSize()`, so the fan-in lane takes the sim lane's spelling rather than forcing a rename in a file it does not own |
| `l12-replay/values-are-inputs` | `tests/logsReplay.ts` | the replay harness takes every *value* from the golden that records it. Those values were computed by the native simulation; recomputing them is L11/L8/L10's contract. What the harness establishes is that given the same values the recorders emit the same bytes |
| `l12-replay/event-order-from-goldens` | `tests/logsReplay.ts` | the reconstruction follows what the goldens prove: energy files hold one row per step from birth to death, the non-`SIMEND` death step's row being the death handler's (the agent is gone before that `StepEnd`), `SIMEND` deaths leave the last `StepEnd` row and write nothing; position files hold one row per step from birth+1 to death; and when a step both births and kills, the two lines' relative order is taken from `BirthsDeaths.log` itself (the sim's agent-processing order) |

### Verification (L12)

The lane's stated oracle is *every logged artifact in `run/**` for `minitest_voff`*, which needs
L11 to raise the events. Until then the recorder layer is verified by **replaying the recorded
run**: `tests/logsCorpus.ts` reconstructs the event stream from the goldens (see the two
`l12-replay` notes) and drives `new Logs(...)`/`logs.postEvent(...)`/`logs.dispose()` with it, and
every artifact whose content this lane decides is compared byte-for-byte, with the same
step-localized reporting the parity checker uses (first differing byte + line + `#@L` column).

```
$ POLYWORLD_LOGS_CANDIDATE_ROOT=<dir> npx vitest run tests/logs-replay.test.ts
Test Files  1 passed (1)   Tests  13 passed (13)

# with the variable unset the tree lands at oracle/_t_logs_candidates/pid-<pid>[-t<thread>]/<scenario>/run
# (one directory per worker process: two concurrent runs never share a candidate root), and that
# printed path is what `./oracle/run_parity.sh <scenario> --candidate <that path>` reads

$ ./oracle/run_parity.sh minitest_voff --candidate <dir>/minitest_voff \
    --ignore run/brain/ --ignore run/genome/agents/ --ignore run/genome/meta/ --ignore run/stats/ \
    --ignore run/movie.pmv --ignore run/normalized.wf --ignore run/converted.wf --ignore run/original.wf \
    --ignore run/original.wfs --ignore run/endReason.txt --ignore run/endStep.txt
  match 186/1369  differing=0  missing=0  extra=0  ignored=1183
parity: PASS  (1369/1369 files)                                             exit 0

$ ./oracle/run_parity.sh microtest_voff --candidate <dir>/microtest_voff  (same ignores)
  match 62/225  differing=0  missing=0  extra=0  ignored=163
parity: PASS  (225/225 files)                                               exit 0
```

The 186 `minitest_voff` artifacts, by kind:

| Kind | Files | Recorder |
|---|---|---|
| `population.txt`, `lifespans.txt`, `BirthsDeaths.log` | 3 | `PopulationLog`, `LifeSpanLog`, `BirthsDeathsLog` |
| `events/{carry,collisions,contacts,energy}.log` | 4 | `CarryLog`, `CollisionLog`, `ContactLog`, `EnergyLog` |
| `energy/{consumption,food}.txt`, `energy/agents/*` | 90 | `FoodConsumptionLog`, `FoodEnergyLog`, `AgentEnergyLog`, `AgentMaxEnergyLog` |
| `motion/position/agents/*` | 87 | `AgentPositionLog` (the recorded `RecordPosition Approximate`) |
| `genome/genestats.txt`, `genome/separations.txt` | 2 | `GeneStatsLog`, `SeparationLog` (86 tables) |

The replay also exercises the header variants the recorders choose: `single|table` ×
`none|fixed` (`energy/agents/*` are `table` + `fixed` — 88 files), the dynamically sized
`Energy0..N` column set (`globals::numEnergyTypes = 1`), `FoodEnergy`'s per-`FoodType` columns,
the `%d`/`%.2f` position formats, the `step 0` rows the `SimInited` handlers write
(`energy/food.txt`), and `separations.txt`'s 86 tables in death order.

`run/brain/**` is verified **structurally** instead (`tests/logs.test.ts`): the whole path set —
87 `function` files (64 finalised + 23 `incomplete_`), 238 `anatomy`, 238 `synapses`,
89 `Recent/<epoch>`, 120 `bestRecent` and 308 `bestSoFar` links — is reproduced against the
golden's own listings, and every link's bytes are checked against its source. Their *contents*
are L6's (`Brain::dumpAnatomical/dumpSynapses/startFunctional/...`), which is why the corpus
prunes them from the candidate tree rather than claiming them. Same for `genome/agents/**`
(L5's `Genome::dump`) and `genome/meta/**` (L5's renderers — `GenomeMetaLog` writes the five
files at the right paths on `SimInited`, in native's order, with the `sort -n` pass in-process).

Test totals: `tests/logs-replay.test.ts` **13/13**, `tests/logs.test.ts` **16/16** (29 new
tests; full suite 408 passed + 1 skipped at the time of writing). `npx tsc --noEmit` is clean for
`src/model/logs/**` and the three test files (`src/model/sim/**` is lane L11's in-flight work).

The one artifact this lane writes whose row order a *container* decides, not the recorder, is
`run/brain/Recent/<epoch>/complexity_<type>.plt`: `RecordComplexity False` in both recorded
scenarios, so no golden pins it. `tests/logs.test.ts` drives `BrainComplexityLog` with
`BrainAnalysisEnd` events in a deliberately non-ascending agent order and pins all three writes
(the `_seeds` flush to `Recent/0`, the `EpochEnd` write, and `close()`'s flush) against the
ascending order native's `std::map` gives (`PORT-NOTE(l12/complexity-row-order)`); reverting the
sort at the write site fails the test.

#### What the replay cannot prove

1. **The values.** They are the simulation's (L11): a divergence in step order, population count,
   energies, positions, separations or event contents is *not* detected here — the harness feeds
   the recorded values back in.
2. **`run/brain/**` and `run/genome/{agents,meta}/**` contents** — L6's and L5's dumps.
3. **The x-sorted walk order.** Each per-agent log is its own file, so the order
   `gXSortedObjects` hands agents to `AgentEnergyLog`/`FoodEnergyLog` is invisible in the bytes;
   `bestRecent`/`bestSoFar` *ranks* do pin the fittest-list order. The port passes the list
   through unchanged (`l12/sorted-list-order`).
4. **`run/brain/bestRecent/complexity.txt` and the `complexity_*.plt` files** — `RecordComplexity
   False` in both recorded scenarios; the formatting is pinned by code review only
   (`l12/best-recent-stats`).

## The float-contraction rule — for every lane that transcribes native float arithmetic

**Measured on the shipped build (L8 / t_4392393c).** The native tree is compiled with clang
`-O2`, whose default is `-ffp-contract=on`. Every `a*b + c` in native *source* is therefore
**one** rounding — a hardware `fmadd`/`fmsub`/`fnmadd`/`fnmsub` — and not the
multiply-then-add the source text spells. A transcription that rounds the product and then the
sum reproduces *the source's* semantics, not the binary's, and differs from the recorded
goldens in the last bits wherever the two round differently. The difference is not rare: over
the model's own input ranges (uniform coordinates in ±100, 200 000 samples per shape) the fused
and unfused forms of this lane's three non-collision shapes disagree on **8.5 %** of cases
(`sqrt(a*a + b*b)`, `fSpeed`), **16.7 %** (`a*a + b*b`, `dosquared`/`dssquared`) and **25.8 %**
(`lastZ + s*(xs - lastX)`). The collision vector file reads as 2.2 % (65/3016) only because
most of those cases never let the last bits reach the *returned* coordinate.

What to do, per site:

* **Find the sites by disassembling the shipped function, never by guessing.** Clang contracts
  some expressions and not others, and a variant sweep over "which sub-expression did it fuse"
  does not converge — round 1 of this lane tried that and found no single variant.
  `xcrun llvm-objdump --disassemble-symbols=<mangled> <native>/lib/libpolyworld.dylib`
  (`nm -gU` for the name) prints exactly what the binary does; annotate each transcription
  site with the instruction it mirrors, as `agent.ts` does. Search for the **vector** forms
  too: `fmla`/`fmls` (`.2s`/`.4s`) are the same contraction and are what clang emits whenever
  it can vectorize the two neighbours — four lanes had a fused site documented only as a
  `fmla` (see *the contraction sweep* below).
* **Express a fused site as `f32Fma(a, b, c)`** (`src/model/agent/numeric.ts`), a correctly
  rounded binary32 `a*b + c` — the hardware `FMADD`. `Math.fround(a*b + c)` is **not** enough:
  it rounds twice (binary64, then binary32) and disagrees whenever the exact sum sits within a
  few binary64 ulp of a binary32 rounding boundary. Measured: it agrees with the exact fma on all
  800 000 random model-range triples and even on all 3022 recorded collision cases, but fails 56
  of 800 000 triples built to land on such a boundary (~1 in 1.4·10^4) — usually right, never
  *provably* right, which is not good enough for a bit-exactness claim. `f32Fma` recovers the
  binary64 rounding error exactly
  (Knuth two-sum) and resolves the one boundary the exact sum can straddle by an exact
  comparison with the midpoint; it is verified bit-for-bit against hardware `FMADD` on 300 000
  triples and against an exact BigInt reference on 1.6 M more (800 000 of them built to sit on
  a boundary).
* **`double` static types make contraction harmless — with one caveat.** The product of two
  binary32 values is exact in binary64, so a *fused* and an *unfused* double mul-add agree
  **when both factors are binary32**; contraction only changes a result where the product
  **and** the destination are `float` **or where a factor is not binary32 at all** (`double`
  arithmetic contracts too, and a 48-bit `drand48()` times a float is not exact in binary64 —
  measured at ~2⁻²⁹ per call in `Patch::setPoint`, see *the contraction sweep*). That is also
  why a site can mix: in `GetCollisionFixedCoordinates`'s discriminant `b*b` is narrowed to
  `float` by the source *before* the `double` subtraction, so that one is deliberately **not**
  fused.
* **Never "fix" this by rounding differently somewhere else.** The residuals are not a port
  defect; they are the port faithfully reproducing a compiler's arithmetic. Anything else
  (all-double intermediates, a loose tolerance, or a single `f32` over a compound expression)
  moves other cases and hides the difference.

**Worked example, with numbers.** `agent::GetCollisionFixedCoordinates` (`agent.cc:1653-1738`,
disassembled at `0x27504`): with rounds-per-operation, 65 of the 3016 recorded cases were
last-bit inexact (worst |delta| 5.455017e-4, ~2 ulp of the quadratic's `c`/`discriminant`); with
the disassembled transcription the lane is **3022/3022 bit-exact** (`tests/agent.test.ts`, the
tolerance branch deleted). Replaying both forms offline over the committed vectors reproduces
exactly those 65. The same mechanism was then found, confirmed by disassembly and fixed, at
three more sites in this lane — `fSpeed` (`agent.cc:1435`, `fmul` + `fmadd` + `fsqrt`),
`dosquared`/`dssquared` (`1595`/`1608`, the predicate that repositions the agent and posts the
collision event) and the `xs`/`zs` step (`1601-1613`) — and it is worth assuming it exists in
every lane until that lane has looked.

**Not a human decision any more, and what would be one.** Pinning the native model build to
`-ffp-contract=off` (`etc/bld/Makefile.conf`, one line) would make the source text and the
binary agree by construction and make every future float port checkable against its source —
but it re-records *every* golden, which is an orchestrator/human call, so this lane did not do
it and did not touch the native tree or `oracle/**`. Until such a decision, the shipped dylib
and the recorded goldens are the contract, and the port transcribes the disassembly.

**DECIDED (orchestrator, 2026-09-29): the shipped dylib and the recorded goldens stay the
contract, and the `-ffp-contract=off` re-record is not taken.** The port already reproduces the
shipped binary byte-for-byte on all six scenarios, so a re-record would change the acceptance
basis of a green port without changing a single ported byte — it is a new project (new goldens,
every transcribed libm function and every contraction site re-verified against them), not
outstanding work here. Same call as *Open questions* 8. Reopen only if the native build itself is
ever rebuilt with different flags and the goldens must follow it.

## The contraction sweep (t_981fcace) — every lane, disassembled

The rule above was written from one lane (L8). This pass took the **whole shipped dylib** and
searched it for contraction: `xcrun llvm-objdump --disassemble --no-show-raw-insn
`<native>/lib/libpolyworld.dylib` then `fmadd|fmsub|fnmadd|fnmsub|fnmul|fmla|fmls` — **228 fused
multiply-add instructions in 95 of the exported functions** (this pass first reported 219; the map
itself, `dis/fused_map2.txt`, sums to 228 and a re-scan of the dylib gives 228 on the same 95
function names, so the count is 228, not 219). That list, per lane, is the
sweep's evidence base; what follows is what it changed, what it cleared, and what it left.

### Three corrections to the rule above

1. **The vector forms are the same contraction, and a scalar-mnemonic search misses them.**
   `fmla`/`fmls` (`.2s`/`.4s`) fuse exactly like `fmadd`, per lane, and clang reaches for them
   whenever it can vectorize the two neighbours — `Patch::initBase`'s `centerX`/`centerZ`
   (`0x5dcdc fmla.2s v5, v6, v0`), `TSimulation::Step` (`0x931b4`), `sheets::Sheet::
   addReceptiveField` (`0x60ea8`), `GeneStats::compute` (`0x9e0d0 fmls.4s`). `fmla.2d` also
   appears on **double** lanes (`Patch::pointIsInside` `0x5e160`, `checkIfAgentIsInside`
   `0x5e1fc`, `checkIfAgentIsInsideNeighborhood` `0x5e2a0`/`0x5e2c0`, `Patch::initBase`'s
   `startX = centerX - sizeX*0.5` `0x5dcf4`). L10 had inferred `initBase`'s fusion from a pin
   count ("with the unfused form 8 pins miss"); the instruction that does it is the `fmla.2s`.
2. **"Contraction only changes a result where the product *and* the destination are `float`"
   is wrong as stated.** Contraction also happens in `double` (`0x261d0`/`0x26260`/`0x262f0`/
   `0x26338` in the agent, `0x5ddd8`-`0x5dec4` in `Patch::setPoint`, and the whole `TSimulation`
   surface), and there the product is **not** always exact: `Patch::setPoint`'s uniform arms
   fuse `(double)sizeX * drand48() + (double)startX` (`0x5ddd8 fmadd d0, d9, d0, d8`) where
   `drand48()` has 48 significant bits, so a rounds-per-operation transcription differs from
   the binary at ~2⁻²⁹ per call. What *is* true, and is what makes the lanes' `f32(a*b + c)`
   forms safe, is the converse: **where both factors are binary32 the product is exact in
   binary64, so fusing changes nothing** (`0x5dcf4`, `0x5e160`, the `SetAspect` products).

3. **The `sqrt`-discipline probe's "fma sum" variant was not the binary's `fma`, and its single miss
   became a wrong PARITY claim in another lane's section.**
   `src/model/geometry/native/sqrt_discipline.py` scores `fma(lx, lx, lz*lz)` where `fma` evaluates
   `a*b + c` in a **Python double** and rounds once — i.e. *both* products stay exact — at 111/112
   against the recorded agents, and the L15 section read that one miss as "`agent::setradius`'s
   square sum is **not** contracted". The shipped `21f44 fmul s1, s1, s1` rounds `fLength[2]^2`
   *before* `21f48 fmadd s0, s0, s0, s1` adds it to an exact `fLength[0]^2`, so the binary is
   `f32(lx*lx + f32(lz*lz))`; that form scores **112/112**, and so does the pre-sweep two-step form —
   the recorded agents cannot separate them (16 distinct `(lx, lz)` pairs; independent check:
   `dis/check_radius_112.py`). The false claim is corrected in place in the L15 section; the site is
   fixed and pinned below (*Fixed*).

### Fixed (each with its measured rate and the instruction it mirrors)

| site | the instruction it mirrors | before | after | measured |
|---|---|---|---|---|
| L10 `environment/distributions.ts` `linearPDF` else-arm | `0xfbdc fmadd s1, s1, s0, s2` | `f32(f32(slope*x) + yI)` | `f32Fma(slope, x, yI)` | **115 001 of 200 000** `x` on a 1/400 000 grid in (0.5,1] (57 %) differ in the last bit — and that bit is the argument of `getLinear`'s rejection test, so it is a **draw-count** (whole-run) risk, not a cosmetic one. **The operands are a second, separate 20 %**: the fusion is fed `slope`/`yIntercept`, and the call site handed it JS doubles until `t_bb4630da` — see the row below |
| L10 `environment/patch.ts` `setPoint`'s four distribution literals (**`t_bb4630da`**, filed from `t_8db5f338`'s review) | `__Z9normalPDFfff`'s `0xfb78 fcvt d1, s1` (the parameter is `float`, so `(double)sigma` widens `0.3f`) and `__Z9linearPDFfff`'s `0xfbdc fmadd` operands | `const sigma = 0.3; const mu = 0.5; const slope = -0.4; const yIntercept = 0.4;` — JS doubles, so `sigma*sigma` and the fused product are the wrong operands | `f32(0.3)`/`f32(0.5)`/`f32(-0.4)`/`f32(0.4)` (`PATCH_GAUSS_SIGMA` … in `patch.ts`), plus an entry `f32` on `normalPDF`/`linearPDF`/`getNormal`/`getLinear` (native's signatures are `float`) | `left` **10 000/10 000** (`0x3faa3723` vs the oracle's `0x3faa3722`) and `normalPDF`'s return value **9 456/10 000 (94.6 %)** over `native/raw/normalpdf_insitu.tsv`; `linearPDF` **7 991/40 001 (20.0 %)** of `x` over `native/raw/linearpdf_insitu.tsv` — 0 for all after. In situ, both samplers draw the same samples (0 of 20 000), because a rejection only flips inside the ulp window |
| L10 `environment/distributions.ts` `normalPDF`'s `left`/`rightBottom` (`t_8db5f338`, filed from the sweep's own review) | `0xfb7c fmul d1, d1, d1` + `0xfb90 fmul d3, d1, d3` + `0xfb94 fsqrt d3, d3` + `0xfb98 fdiv d3, 1.0, d3`, then **one** `0xfba0 fcvt s8, d3`; `0xfbac fadd d1, d1, d1` + `0xfbb0 fcvt s1, d1` | `f32(1.0 / f32(sqrt(f32(f32(2*pi) * f32(pow(sigma,2))))))` — three extra binary32 roundings (the square, the product *and* the root) | `f32(1.0 / Math.sqrt(f32(2*pi) * (sigma*sigma)))`, and `f32(2 * (sigma*sigma))` for `rightBottom` | **576 of 1 296** corpus rows (`native/raw/normalpdf_sweep.tsv`) had a different `left`, 0 after; `rightBottom`'s extra `f32` measured **0/1 296** *both* ways — `* 2` is exact in binary32, so this one is operand types, not a bit |
| L10 `environment/food.ts` `deriveRadius` | `0x5aa80 fmul s1,s1,s1` + `0x5aa84 fmadd s0,s0,s0,s1` | rounded **both** squares | `f32Fma(l0, l0, f32(l2*l2))` | 6 741 of 200 000 (3.4 %) — the binary rounds the **second** square; this is the "read which operand is the `fmul`" trap |
| L8/geometry `agent.ts` `fieldOfView`, `updateVision` pitch/yaw + `geometry/camera.ts` `horizontalFovForFocus`, `configureAgentPov` pitch/yaw | `0x261d0`, `0x26260`, `0x262f0`, `0x26338` (`fmadd d0, …`, product exact in binary64, one rounding, `fcvt` store) | the round-1 fix wrapped the **product** in `f32(...)` | `f32(x * f32(hi - lo) + lo)` | 106 891 of 200 000 `focus` (53 %) for `FieldOfView`; 97 983 of 200 000 (49 %) for the pitch — the round-1 "fix" was itself a transcription of the unfused source |
| L8 `agent.ts` barrier pass (`UpdateBody`) | `0x26a04`-`0x26a94` (8 × `fmadd` with `±1.01f` baked into the multiplier), `p`: `0x26b08`/`0x26b30` `fmadd`, `0x26b34` `fnmadd` | `f32(x() ± f32(FF * CarryRadius()))` — a materialised rounded product per comparison | `f32Fma(±FF, cr, x())` per comparison, `f32Fma(FF, cr, ±|dist|)` for `p` | 18 798 of 200 000 (9.4 %) of the bounds differ; ~half of those can flip an `xmin`/`xmax`/`zmin`/`zmax` test. **Kept**: `ffCarry` for the containment test — that is the one place the compiler *does* materialise the rounded product (`0x26ae4 fmul s7, s1, s6`) |
| L8 `agent.ts` `setRadius` (**review round 1**) | `0x21f44 fmul s1, s1, s1` (rounds `fLength[2]^2`) + `0x21f48 fmadd s0, s0, s0, s1` (`fLength[0]^2` exact) | rounded **both** squares — `f32(f32(lx*lx) + f32(lz*lz))` | `f32Fma(lx, lx, f32(lz*lz))` | 33 081 of 200 000 `(lx, lz)` pairs in the recorded size range `[0.05, 2]` (16.5 %) differ in the sum and 16 597 (8.3 %) in the derived `fRadius`; over `[0.01, 100]` it is 16.7 % / 8.5 % — the `food::setradius` defect one lane over, **latent on the recorded 112 agents** (all 16 distinct `(lx, lz)` pairs reproduce the golden `fRadius` both ways: `dis/check_radius_112.py`), which is exactly why nothing had caught it |
| L15 geometry `primitives.ts` `Poly.deriveRadius`, `PolyObj.deriveRadius` + `body.ts` `AgentBodyGeometry.deriveRadius` (**review round 1**) | `gpoly` `0x8497c`/`0x84980`/`0x84988`, `gpolyobj` `0x84ca0`/`0x84ca4`/`0x84cac` — and `gbox::setradius` `0x87624`/`0x87628`/`0x87630` is the same shape | rounded **all three** products | `f32Fma(z, z, f32Fma(x, x, f32(y*y)))` | 45 244 of 200 000 `(x, y, z)` in `[0.01, 100]` (22.6 %) differ in the sum, 23 626 (11.8 %) in the radius (`[0.05, 2]`: 22.4 % / 10.9 %). **Live**: `PolyObj` through `body.ts`'s `agentBodyTemplate()`/`cloneGeometry`, and `AgentBodyGeometry` *is* the agent-body path (`agent::SetGeometry` → `setlen` → here). `tests/geometry.test.ts` had asserted the port's own form against itself, so nothing caught it |

Pins: `tests/fma-contraction-sweep.test.ts` — **12 tests**, every expected value derived from an
**exact-rational** reference (Python `Fraction` + an explicit correctly-rounded binary32/binary64
round — `dis/gen_ts_cases.py`, `dis/gen_radius_cases.py`, `dis/gen_pins2.py` and
`dis/gen_barrier_drives.py` in the card's workspace), never from the port's own helpers.

**Round 3 — the "pin that cannot fail" fix.** Round 2's review found that most of those cases were
*local re-derivations*: they composed `f32Fma(a, b, c)` from the pinned constants and compared the
result with a constant — they never called the ported site, so a revert left the suite green. That is
the same defect this sweep had diagnosed in `tests/geometry.test.ts` ("asserted the port's own form
against itself, so nothing caught it"), applied inconsistently to its own fixes. Round 3 replaced the
composition with **drives that run the ported code**, for every site this card fixed, and re-derived
every constant from scratch with `dis/gen_pins2.py`:

| driven site | the drive |
|---|---|
| `food::setradius` (`0x5aa80`/`0x5aa84`) | the sweep file builds a real `Food` and calls `setlen()` — the live path (`initlen()` → `setlen()` → the virtual `deriveRadius()`); the pinned case separates the two forms in the **derived radius**, not just in the sum |
| `gpoly::setradius` (`0x8497c`-`0x84988`) | builds a real `Poly`, sets `fLength` (a bare `gpoly` has no `setlen`) and calls `setScale(1)` → `setradius` |
| `Camera.configureAgentPov` pitch/yaw (`0x262f0`/`0x26338`) | calls the public method and reads `camera.angles.y`/`.x` |
| `agent::FieldOfView` (`0x261d0`) | `tests/agent.test.ts` grows an `Agent`, sets the `Focus` nerve through the lane's nerve seam and calls `fieldOfView()` |
| `agent::UpdateVision` pitch/yaw (`0x262f0`/`0x26338`) | grows an `Agent` with `EnableVisionPitch`/`EnableVisionYaw`, sets the `VisionPitch`/`VisionYaw` nerves and calls `updateVision()`, reading what the POV camera is handed |
| `UpdateBody`'s 8 barrier `fmadd`s (`0x26a04`-`0x26a94`) | **eight** drives, one per instruction pair (`x()`/`lastX()` × `xmax`/`xmin`, `z()`/`lastZ()` × `zmin`/`zmax`). Each puts the barrier's own bound on the *unfused* value — one ulp from the shipped `fmadd`'s — so the shipped form takes one branch and the pre-sweep form the other. Each drive's *other* term of the targeted `||` is built non-discriminating, and for the two `xmin` drives (an `&&`, the `break` out of the barrier walk) it is true in **both** forms — so neither the short-circuit nor the `&&` can hide a revert |
| `UpdateBody`'s three `p` values (`0x26b08`/`0x26b30` `fmadd`, `0x26b34` `fnmadd`) | three drives, one per value (`-|dist|`, the sign-change `+|dist|` and the pass-through `+|dist|`), with `sina = 0`, `cosa = ±1` and `x() = 0` so the movement lands on `x` exactly and the `p` value's own last bit survives the store |

`dis/gen_barrier_drives.py` resolves each drive's branch with exact rational arithmetic and
**refuses** a drive whose shipped and pre-sweep outcomes agree, so a table cannot silently lose its
discriminating power. The round-2 note that these sites were "pinned" was wrong for ten of them; what
was true then is what is true now: the round-2 constants themselves all re-derive correctly.
**Mutation-verified, one site at a time, in an isolated copy of the tree** (`mutB/battery.py` in the
card's workspace: a clean copy with `node_modules`/`oracle` symlinked, the four lane suites
`agent` + `fma-contraction-sweep` + `geometry` + `environment` re-run for each mutation, **102
passed | 1 skipped (103 total)** clean — the skip is an unrelated native-runner test, not a site).
Twenty-one reverts, **all twenty-one killed** (each `1 failed | 101 passed | 1 skipped`):
`agent::FieldOfView`; `UpdateVision` pitch; `UpdateVision` yaw; `configureAgentPov`
pitch; `configureAgentPov` yaw; the barrier bounds `xmax` × (`x()`, `lastX()`), `xmin` × (`x()`,
`lastX()`), `zmin` × (`z()`, `lastZ()`), `zmax` × (`z()`, `lastZ()`) — eight separate mutations; the
three `p` values; `food::setradius`; `gpoly::setradius`; `gpolyobj::setradius`;
`AgentBodyGeometry::deriveRadius`; `agent::setradius`; `linearPDF`. Round 2's claim that reverting
`body.ts`'s sum also fails `tests/geometry.test.ts` is **wrong** and is corrected here: that revert
fails `tests/fma-contraction-sweep.test.ts` alone (`1 failed | 552 passed`), because
`tests/geometry.test.ts`'s radius assertion was rewritten to the contracted form and defers the value
to the sweep pin. Lane suites after round 3: `fma-contraction-sweep` — **12 passed**; `agent` —
**31 passed**; `npx tsc --noEmit` exit 0 for both files (the only `tsc`/suite failures at that moment
were `tests/rng.test.ts`'s in-flight `pow`, another lane's edit).

**Round 4 — the sweep's own map still held three unadjudicated L8 sites.** Round 3's contract-lens
review demangled every function in `dis/fused_map2.txt` and cross-referenced it against this section
by name *and* by instruction address. Three single-precision `fmadd`s in L8's **own** lane were in no
outcome list and named nowhere in PARITY (`grep -n "lastrewards\|ProjectedHeuristicFitness" PARITY.md`
→ 0 hits before this pass):

| site | the instruction it mirrors | before | after | measured |
|---|---|---|---|---|
| L8 `agent.ts` `lastRewards` | `0x25e34 fmul` + `0x25e38 fdiv` (the age term — already right) then `0x25e3c fmadd s0, s9, s0, s1` | `f32(f32(ef*ne) + ageTerm)` — the energy product rounded first | `f32Fma(energyFitness, normalizedEnergy(), ageTerm)` | 4 737 of 200 000 (2.4 %) differ in the last bit. **Reachable**: `sim/agents.ts:184` calls it on every death, and `fHeuristicFitness` drives least-fit/smite selection (`sim/interact.ts:358/426/438/678/1090`), the status text (`sim/statusText.ts:217`) and the anatomy dumps (`logs/brainLogs.ts:122/227`) |
| L8 `agent.ts` `projectedHeuristicFitness` | `0x25e98`/`0x25ea4 fmul` + `0x25eb0 fdiv` for `base`, then `0x25ed4 fmadd s0, s10, s0, s9` and `0x25f00 fmadd s0, s1, s2, s0` | rounded **both** products | `f32Fma(afp, lfr, f32Fma(efp, ne, base))` | 24 068 / 21 656 of 200 000 (12.0 % / 10.8 %; 17.6 % together). `base` itself is three separate float ops and was already right | 

Neither function is `setradius`-shaped — the age term and `base` keep their own rounded operations —
so only the products that are *added* are contracted. Drives: `tests/agent.test.ts` (*the contraction
sweep — the lastrewards/ProjectedHeuristicFitness sites*) grows an `Agent`, sets `fAge`/the four
`Simulation` seams and calls `lastRewards(...)` / `projectedHeuristicFitness()`; the constants come
from `dis/gen_heur_pins.py` and the runtime scalars the derivation depends on (`MaxAge()` = 750,
`fMaxEnergy.sum()` = 750, `fAge` = 6) are asserted in the drive so the pin cannot go stale.
Mutation-verified the round-3 way (`mutB/battery4.py`, four lane suites re-run in an isolated copy,
clean control `104 passed | 1 skipped`): `LASTREWARDS` and `PHF` both **killed** (`1 failed | 103
passed | 1 skipped`). Gates: `npx tsc --noEmit` exit 0, `tests/agent.test.ts` 33 passed,
`tests/fma-contraction-sweep.test.ts` 12 passed, whole suite `566 passed | 1 failed | 1 skipped` —
the failure is `tests/complexity-adami.test.ts` (*reproduces `minitest_adami` byte for byte*),
another lane's in-flight work, and it reproduces with both of these sites reverted
(`mutB/why_adami.py`). Round 3
also asked for two record corrections, both landed below (`grect`'s `setradius` sentence; the
`TSimulation` ctor, the `food` constructors and `setGenomeReady` in the residual / Open items).

### Cleared (disassembled, no contracted multiply-add that the port rounds per operation)

* **L14 monitor — clean, and it needed the check.** No symbol of `CameraController` (`step`,
  `initRotation`, `initAgentTracking`, `initStatic`, `setRotationAngle`,
  `setAgentTrackingTarget`) contains a fused multiply-add. `(0.5 + radius*sinf(camrad)) *
  worldsize` cannot contract: `0.5` is a `double` literal, so the add is a double add and clang
  will not fuse a `float` product into it. The camera's single-precision trig therefore needs no
  contraction transcription (its accuracy problem is `sinf` vs `Math.sin`, which is already
  PORT-NOTE'd). `MonitorManager::MonitorManager`'s one `fnmul s0, s14, s0` is a single-rounding
  negated product, which `f32(-a*b)` reproduces.
* **L2/L3 datalib `printf`** — no fused multiply-add in the formatting path.
* **L10 `Patch::initBase`/`pointIsInside`/`checkIfAgentIsInside*`** — `initBase`'s `fmla.2s` is
  fused and `f32(a*b + c)` already agrees with it (see below); the `fmla.2d` sites are the
  *exact* `sizeX*0.5 + outerRange` and change nothing; `setPoint`'s containment test is
  deliberately unfused (`fsub.2s`/`fmul.2s`/`fdiv.2s`/`faddp.2s`), so the port's per-operation
  `f32` chain is correct; `barrier::updateVertices`' `c`/`f`/`sna`/`csa` were already
  transcribed from this disassembly.
* `normalPDF`/`getNormal` (`fnmul s0, s0, s0`), `generalLogistic`/`biasedLogistic`/`gaussian`
  (`fnmul d0, d0, d1`, `fnmul d0, d0, d2`) — single-rounding negated products; `f32(-a*b)` is
  that. `gobject::RotateAxis` (`fAngle[i] += delta*axis`) fuses one add per axis and the port
  mirrors it.

* **`gsquare::setradius()`** (`0x87b24`: `0x87b30 fmul s1, s1, s1` + `0x87b34 fmadd s0, s0, s0, s1` +
  `0x87b38 fsqrt`) and **`grect::setradius()`** (`0x82b4c`: `0x82b58 fmul s1, s1, s1` +
  `0x82b5c fmadd s0, s0, s0, s1` + `0x82b60 fsqrt`) are the **2-D** versions of the same rule —
  `fLengthX`/`fLengthY`, the *second* square rounded, the first kept exact across the `fmadd`, then
  `× fRadiusScale`, `× fScale`, `× 0.5` as three separate float multiplies (the `fmul` tail is where
  a per-operation port would also have to round, and the pointer-free `gpoly`/`agent` sites already
  do). `grect` **does** declare `setradius()` — `src/library/graphics/grect.h:45-51` defines it
  inline, the shipped dylib defines `__ZN5grect9setradiusEv` at `0x82b4c`, and four `grect`
  constructors inline it (`0x82c6c`/`0x82ce0`/`0x82d44`/`0x82da8`, each `fmul s0, s9, s9` +
  `fmadd s0, s8, s8, s0`); the earlier sentence "`grect` declares no `setradius` of its own" was
  wrong and is corrected here. There is still **no TS port** of either class (`src/library/**` is
  native-only), so there is nothing to pin — recorded for completeness.

### The `f32(a*b + c)` form the other lanes used — measured, not assumed

`Math.fround(a*b + c)` is not *provably* the hardware fma, so this pass measured the gap with
all-binary32 operands (C, `__builtin_fmaf` reference): **0 disagreements in 6·10⁸ triples over
the model's own ranges** (3·10⁸ uniform ±100; 3·10⁸ `nerve×span+lo`). It does fail in general —
**63 of 2·10⁸** triples with a ±30-dex exponent spread, always by one mechanism: the exact
product lands exactly on a binary32 midpoint and a tiny `c` tips it, hidden by the binary64
rounding (worked counterexample pinned in the test file: `a=0x4b7d4800`, `b=0xcb601000`,
`c=0xb3d87820` → fma `0xd75daed5`, `Math.fround(a*b+c)` `0xd75daed4`). So the sites that use it
(`patch.ts` `initBase`/`setPoint` LINEAR+GAUSSIAN arms, `geometry/primitives.ts`'s `recordedSquareSum`
— the `gbox` rule the environment's `object.ts` used to spell as `focusRadius` and now imports,
`barrier.ts`
`c`/`f`/`dist`, `vision/encoder.ts`'s `avg += t*value`) are **correct over the model's ranges and
were deliberately not churned**. (Round 2 re-measured the `focusRadius` shape specifically —
`gbox::setradius` `0x87624`/`0x87628`/`0x87630` is the same `fmul`+`fmadd`+`fmadd` sequence as
`gpoly`, and `f32(a*a + t)` vs `f32Fma(a, a, t)` differ on **0 of 200 000** samples in both the 2-D
and the 3-D rule over the ranges above, so that site stays as recorded — `t_4e856769` moved it into
`geometry/primitives.ts` unchanged, it did not change it; the radius sites that
*were* wrong are `gpoly`/`gpolyobj`/`agent`, see *Fixed*.)
Rule of thumb from this pass: `f32(a*b + c)` is acceptable
where *every* operand is binary32 and the lane's pins cover the site; `f32(f32(a*b) + c)` (a
rounded product) is never acceptable; an operand that is a full `double` needs `f32Fma`'s
double-precision counterpart, which does not exist yet (next section).

### Residual — found, not fixed, with the reason (the double-precision contraction class)

Every function below fuses a multiply-add whose operands are **not** all binary32, so no
`f32Fma`-style helper can express it in JS; the per-operation difference is ≤ 1 binary64 ulp
(≈2⁻⁵³), or ≈2⁻²⁹ where the addend is much smaller than the product (the `sizeX * drand48()`
shape). `Patch::setPoint`'s uniform arms (`0x5ddd8`, `0x5ddf8`, `0x5de38`, `0x5de58`, `0x5dea4`,
`0x5dec4`) are the ones that run in *both recorded scenarios* (`Distribution U`), at ≲10⁵ calls
per run. The rest: `TSimulation::MaintainEnergyCosts` (`0x93584`/`0x93660`/`0x936bc`/`0x93738`),
`EnergyScaleFactor` (`0x96ff8`/`0x97064`), `MateLockstep` (`0x97fa0`/`0x97fcc`), `InitAgents`
(`0x91c24`/`0x91c4c`), `CreateAgents` (`0x94da0`/`0x94dcc`), `Mate` (`0x984d8`), `Eat` (`0x98d48`),
`Pickup` (`0x9a048`), `getStatusText` (`0x9cc08`/`0x9ccc8`/`0x9ce14`), `sim::StatRecent::add`,
`GeneStats::compute`, `genome::__InterpolatedGene::interpolate` (5), `gene::Gene::randomize`,
`Genome::randomize`/`randomizeBytes`, `NeurGroupAttrGene::randomize`,
`RandomNumberGenerator::range`/`nrandv`/`nranddd`, and the complexity/analysis functions — **the L13
clause of that list is now partly closed** (`t_bbf63409`): `computeAdamiComplexity`'s one- and
two-bit entropy sums *are* contracted, but all of their operands are binary32, so `f32Fma` does
express them and they are transcribed (PORT-NOTE `l13/adami-entropy-is-contracted`; the 16-outcome
loop beside them is vectorised and therefore unfused, which the same PORT-NOTE pins). The rest of
the list is unchanged. Three ways out for it, all of them a human/orchestrator call: accept the
class as below every recorded artifact's resolution (the measurement above supports this), take the
`-ffp-contract=off` route this rule already describes, or fund a correctly-rounded `f64Fma`
helper (Dekker two-product + round-to-odd, testable against Python's `math.fma`). **That helper
now exists**: `src/model/brain/core/nativeMath.ts`'s `fma64`, added by `t_da2ab201` when the
brain models turned out to be the first lane whose *activation* path was measurably wrong because
of this class (it is pinned against the hardware's own `fmadd` on 57,539 probe rows —
`brainprobe fma` — and against exact rational arithmetic on 4,000 constructed ties; see the L6
row and the libm finding). The sites in the rest of this list are still transcribed
rounds-per-operation: the helper makes them *fixable*, it does not make them fixed, and each one
still needs the same disassembly-plus-pin treatment the L6 sites got.

**This list is illustrative, not exhaustive** — round 3's contract-lens review found three more
double-class fusions whose port rounds per operation. They are enumerated here rather than fixed
because each needs an `f64Fma` (now `fma64`, see above); the second of them *also* drops a
plain `f32` narrowing, which is a separate defect and is flagged as its own card.

* **`TSimulation` constructor `0x892a8 fmadd s0, s1, s1, s0`** — `agent::config.maxRadius`'s
  float half: `maxagentlenx = maxAgentSize / sqrtf(minmaxspeed)` (`0x89298 fdiv`),
  `maxagentlenz = maxAgentSize * sqrtf(maxmaxspeed)` (`0x892a0 fmul`), then
  `0x892a4 fmul s0, s0, s0` + `0x892a8 fmadd` + `0x892ac fsqrt` + `× 0.5f`, i.e.
  `maxagentradius = 0.5·sqrt( malx² + f32(malz²) )` in **float**, one rounding for the sum.
  `src/model/sim/simulation.ts:602-604` has neither the `f32` stores nor the fusion (it is
  `0.5 * Math.sqrt(maxagentlenx*maxagentlenx + maxagentlenz*maxagentlenz)` in binary64). This one
  is **fixed in round 5** (`t_2a625bd5`) — the *L11 Open items* entry it was listed under is
  closed there; the port now has both the `f32` stores and the fusion, pinned by
  `tests/fma-contraction-sweep.test.ts`.
* **`food::food` `0x5aba0` and `food::initfood` `0x5ac7c`** — `fmadd d0, d0, d1, d2` with the two
  `fcvt d1, s1` / `fcvt d2, s2` that **widen** the operands: native is
  `f32( randpw() * (double)f32(MaxFoodEnergy - MinFoodEnergy) + (double)MinFoodEnergy )`, the
  difference narrowed to `float` by `0x5ab94 fsub s1, s1, s2` **before** being widened.
  The **operand** half of this site — the dropped `f32(Max - Min)` narrowing the round-3 review
  found here, an ≈2⁻²⁴ error and not this section's class at all — is **fixed by the follow-up
  `t_97ec04fa`**: `food.ts` now writes
  `f32( drand48() * f32( gMaxFoodEnergy - gMinFoodEnergy ) + gMinFoodEnergy )`, pinned in
  `tests/environment.test.ts` -> *the food energy draw* (five live-construction cases whose
  expected bits come from an exact-rational reference, each failing on a revert — measured) and
  measured whole-run-clean (both recorded Tier-A candidates are byte-identical with and without
  it; `microtest_voff` still reports PASS 225/225 — see the L10 section). What stays here is the
  `fmadd` itself: `double` × `double` with a 48-bit factor, so the port keeps a two-rounding
  multiply-then-add, the ≤2⁻⁵³ class this section covers.
* **`agent::setGenomeReady` `0x244b8 fmadd d0, d9, d8, d0`** — the `Metabolism::Random` draw:
  `d9 = (double)(numDefs-1)` (exact), `d8 = drand()` (48 significant bits), `d0 = ±0.49997…`
  (the `fcsel` on the sign), so `(numDefs-1)·drand() + ±0.5` is one rounding in **double**.
  `src/model/agent/agent.ts:278` writes `nint((getNumberOfDefinitions() - 1) * rng.drand())` —
  a binary64 multiply then a binary64 add.

### Open items, deliberately not guessed

* **L6 brain float sites** and **L11 sim float sites** — **CLOSED by `t_2a625bd5`
  (2026-09-28).** Every single-precision site left here was disassembled and transcribed; the
  full table, the two corrections to this section that came out of it, and the one input-nerve
  defect it found are in *Round 5 — the sweep follow-up* at the end of this section. The three
  sites that are **not** fixed here, with the reason: `GroupsBrain::growSynapses`'s
  `0x66b70`/`0x66dc0` (**CLOSED by `t_7d391d0f`** — *Round 6* below: the first is provably
  bit-identical, the second contracted and pinned; the double class → the residual above),
  `AgentFitness`'s `0x9b260`
  (inside the weighted-complexity branch the port threw on until **`t_20d5ff13`** landed the
  L13→L11 seam — **CLOSED**: the contraction is transcribed as `f32Fma` and pinned by
  `tests/sim-complexity-seam.test.ts`'s exact-rational cases, below), and
  `Mate`'s `0x98570`/`0x98574` (only reachable with `RandomBirthLocation True`, which no
  recorded scenario sets — transcribed, but no golden and no drive harness can separate the
  forms; the *other* half of that block, which function the trig actually is, **is** settled and
  pinned — `0x9856c bl ___sincosf_stret`, `t_c99150dc`, see the `interact.ts` `Mate` entry under
  *Not transcribed, not pinned*).
* **L1 libm**: the card's `log` / `exp` question is **not** answerable from this dylib —
  `log`/`exp` are libSystem calls through stubs and `src/model/rng/libm.ts` transcribes Apple's
  libm. A contraction check inside those routines needs the shared cache's `libsystem_m.dylib`,
  not the model. Not done, and recorded so it is not mistaken for a clean result.
* **L5 genome** `__InterpolatedGene::interpolate`'s five `fmadd d` sites were not compared
  site-by-site (double class → the residual above).

### Round 5 — the sweep follow-up (t_2a625bd5): the L6 brain, the L11 sim, and an input-nerve find

Every site the *Open items* list above named was disassembled per site and transcribed:

| site | the instruction it mirrors | before | after |
|---|---|---|---|
| L6 `firingRateModel.ts` / `spikingModel.ts` learning chain | `0x5e8bc`-`0x5e8cc` / `0x67cb0`-`0x67cc4`: `fmadd`, `fmul`, `fdiv`, `fsub`, `fmul` — **all float** | `scaled` computed in binary64, one rounding at the end | `f32Fma(maxWeight, -0.5, abs(e))` → `f32(1 - f32(f32(t * oneMinusDecay) / halfMaxWeight))` → `f32(e * scaled)` |
| L6 `sheetsModel.ts` `Vector3f::distance` | `0x61000 fmul` (on `dy²`) + `0x61004`/`0x61014 fmadd` + `0x61018 fsqrt` | rounded **all three** squares | `f32(sqrt(f32Fma(dz,dz, f32Fma(dx,dx, f32(dy*dy)))))`, `f32` differences |
| L6 `sheetsModel.ts` `createNeurons` | `0x60904`/`0x6090c fmadd` | rounded the product | `f32(f32Fma(i, spacing, inset))` per axis |
| L6 `sheetsModel.ts` `offsetCenter` | `0x60ea8 fmla.2s` | rounded the product | `f32(f32Fma(factor, offset, center))` |
| L11 `simulation.ts` ctor `maxagentradius` | `0x89294`-`0x892b4` (`fsqrt` is the **float** overload) | binary64 throughout | `f32` stores + `f32(sqrt(f32Fma(malx, malx, f32(malz*malz))))` |
| L11 `simulation.ts` `Step` food-energy pair | `0x931b4 fmla.2s` (+ `0x9317c fadd.2s`, `0x931bc` narrowing store) | binary64 accumulator, product rounded | `f32(f32Fma(f32(step-1), avg, foodIn) / f32(step))`, `f32` totals |
| L11 `interact.ts` contact test | `0x94800 fmul` + `0x94804 fmadd` + `0x94808 fsqrt` | `Math.sqrt` in binary64 on the sum | `f32(sqrt(f32Fma(dx, dx, f32(dz*dz))))` against `f32(rc + rd)`, `f32` differences |
| L11 `agent.ts` `lastEatDistance` (inlined at `GetMatePotential` `0x99488`) | `0x99484 fmul` + `0x99488 fmadd` + `0x9948c fsqrt` | `Math.hypot` (binary64) | `f32(sqrt(f32Fma(dx, dx, f32(dz*dz))))`, `f32` differences |
| L11 `interact.ts` `Mate` birth location | `0x98570 fmadd` + `0x98574 fmsub` (and `0x9856c bl ___sincosf_stret` for the trig itself) | `x += f32(d*cos)`, `z -= f32(d*sin)`, with `cos`/`sin` the **double** functions narrowed to `f32` | `f32Fma(distance, f32(cos), x)`, `f32Fma(-distance, f32(sin), z)`, and `(sin, cos) = sincosf(angle)` — the fused two-output float entry, `t_c99150dc` |

Three notes that cost real time to establish:

1. **`0x5e8bc` and `0x67cb0` are not themselves divergences.** The fused product is
   `maxWeight * -0.5f`, an exact power-of-two scaling, so the `fmadd` and the unfused
   `|efficacy| - halfMaxWeight` are bit-identical. What was wrong in the port was the
   **binary64 chain around them**. At the time this pass had no drive that reached the site: a
   hand-built `FiringRateModel::update` drive was attempted and then **removed**, because the
   driven model's post-update efficacy came back *unclamped* — i.e. exactly as it had been set —
   and shipping it would have pinned a fixture that passes for the wrong reason. **`t_b20ef448`
   (2026-09-28) found why, and it was the drive, not the port:** the learning block is gated on
   `Brain::config.enableLearning && !cns->getBrain()->isFrozen()`, and a hand-built brain has to
   set `enableLearning` itself — `Brain::processWorldfile` derives it from `learningMode`, the
   model never does — so the drive's loop never ran and `set_synapse -> update -> get_synapse`
   handed the constructed efficacy straight back. With the gate on, the same construction clamps
   its values (the round trip is exact, the chain then moves what it is given). The probe drives
   that input now — *Round 7*, below — and the revert is caught.
2. **`Math.fround(Math.sqrt(x))` is not the hardware's `fsqrt`.** The double sqrt is correctly
   rounded to 53 bits and narrowing to 24 can differ from direct correctly-rounded binary32.
   It is this tree's established discipline for `fsqrt` sites and this pass kept it, but it is
   a residual of the same class as `Math.fround(a*b + c)`: on this pass's boundary-seeking
   candidate sets it showed up in **2 of 7** (`dis/gen2.py`), i.e. not rare among *near-tie*
   inputs, and vanishingly rare otherwise.
3. **`f32Fma` is only exact when both factors are binary32** — the operand comment in
   `numeric.ts` says so — so every difference feeding a fused site had to be narrowed first
   (`fsub` on `float` registers in the binary). Three of this pass's sites were initially
   transcribed without that narrowing; the pins caught it on the first run.

**The find that closed the recorded residual: `Nerve::set` takes a `double`.** The other half
of this card came from the supervisor's end-to-end measurement: 17 of the 25
`run/brain/Recent/0/brainFunction_*` files differed from their goldens, every first divergence
on **neuron 0 — the `Random` nerve** (`agent/RandomSensor.cc:26 nerve->set( rng->drand() )`),
by ~1e-6 relative, while 262 of the differing `minitest_voff` files were `run/brain/**`. The
cause is not in the brain: `Nerve::set( double )` (`Nerve.h:35`) writes into the model's
`double[]` activation array, so the draw is stored **un-narrowed**, while
`src/model/agent/sensors.ts` applied `f32()` to it — and to all five sensor
`sensor_prebirth_signal` draws. `%g` of a double and of its binary32 rounding differ on
**1.1 %** of draws (`dis/rate.py`: 2 211 of 200 000 on the 2⁻⁴⁸ grid), which is exactly the
sporadic one-value-per-agent pattern the supervisors measured. Removing those six `f32()`
calls: `minitest_voff` **1024/1369 → 1095/1369 matched** (348 → 277 differing), `run/brain/**`
differing **262 → 191**, `Recent/0/brainFunction_*` **17 → 7** — and the 7 that remain differ
only on neuron 1, the `Energy` nerve, in consecutive-step runs, i.e. the energy drift this
board already routes to lane L11 (`t_d5ca0870`), not the Random origin.

Pins and mutation check. `tests/fma-contraction-sweep.test.ts` grows a *the contraction sweep
follow-up — L6/L11 single-precision sites* block (distance, `createNeurons`, `offsetCenter`,
the sensor draws, and the ctor through a scenario boot) and `tests/agent.test.ts` an
*agent::LastEatDistance* block. Constants come from `dis/gen_followup_pins.py`,
`dis/searchA.py`, `dis/gen_offc.py`, `dis/gen_offc2.py` and `dis/gen2.py` in the card's
workspace (exact
`Fraction` + explicit binary32 rounding), each with a non-vacuity assertion against the
pre-change form. Mutation check (`mutcheck.py`, this card's workspace — one revert at a time
on the live tree, the owning suite re-run, the tree restored):

| revert | verdict |
|---|---|
| the Random/prebirth sensor `f32()` narrowing | **killed** (`tests/fma-contraction-sweep.test.ts`) |
| `Vector3f::distance` back to three rounded squares | **killed** (same file) |
| `offsetCenter` product rounded | **killed** (same file) |
| `createNeurons` product rounded | **killed** (same file) |
| `lastEatDistance` back to `Math.hypot` | **killed** (`tests/agent.test.ts`) |
| the `FiringRateModel` / `SpikingModel` **clamp chain** back to binary64 (`scaled` computed in binary64 with one rounding at the end, `f32Fma` → `|efficacy| - halfMaxWeight`) | **killed** (`t_b20ef448`, 2026-09-28) — `native/brainprobe.cc`'s new `learnclamp` mode drives both models one step over a constructed 1,024-synapse family whose `|efficacy|` sits inside `(0.5*maxWeight, maxWeight]`, and writes the value the *shipped* `libpolyworld.dylib` stored (the arbiter), the pre-change form's value, and a per-row `differs` verdict; the pin is `tests/brain-core.test.ts`'s `native parity: clampfiringrate{,2} (the learning rule's clamp chain)`. Measured with that revert applied to **both** models: the whole suite goes **14 failed \| 679 passed, 5 files red** (`tests/brain-core.test.ts` 4 — the three new families plus the pre-existing `native parity: spiking` efficacy census, `26/26 → 25/26`, max 1 ulp — and 11 in `cppprops-{recorded-tree,sim-engine*}`: the `dyn`/`small` growers worlds get their old knife-edge drift back, `growers_dyn` failing at `expect(extra).toBe(step === 239 ? 1 : 0)` → `expected -1 to be +0`). First new-family failure, `clampfiringrate`: `matches the shipped model bit-for-bit on every driven synapse` → `expect([...]).toEqual([])`, `synapse 31: native 0x407fb8b4, port 0x407fb8b3` (212 rows move in that family, 465 in `clampfiringrate2`, 204 in `clampspiking`). **This row's old verdict (`survives in every suite`) was already stale when it was re-measured: the clamp half of the revert is caught today by the pre-existing `native parity: spiking` census, whose learned efficacies cross `0.5*maxWeight` since the delta line's own narrowing landed.** See *Round 7* |
| the `FiringRateModel` delta line's own `fmadd` (`0x5e8a8`, `f32(fma64(delta, a_from-0.5, efficacy))`) → round-product-then-sum | **killed** (`t_efc4dc64`, 2026-09-28) — *Round 7*'s proposal, built: `native/brainprobe.cc`'s new `learndelta` mode saturates every row's destination neuron (`bias 64` makes `logistic(.)` exactly `1.0`, so the delta is the exact double `0.5*lrate`), drives each row's own input neuron at full double precision (the spec's `input` line, `%.17g`) so `db = a_from - 0.5` is a free double, and walks `db` onto the f32 midpoint above the stored efficacy — 16 rows, **16/16 separating**, probe `current_mismatches 0`. The pin is `tests/brain-core.test.ts`'s `native parity: learndelta (the learning rule's fused delta)` (3 tests). Measured with the delta line alone reverted on the live tree, tree restored and re-hashed: `tests/brain-core.test.ts` **1 failed \| 61 passed**, whole suite **1 failed \| 695 passed \| 1 skipped, 46 files** — the only red test is the new pin, first failure `matches the shipped model bit-for-bit on every driven synapse` → `expect([...]).toEqual([])`, `synapse 0: native 0x3f000001, port 0x3f000000`. Its verdict before this pass was **survives** (`t_b20ef448`: `59/59`, whole suite green, 0 of the clamp family's 3,072 driven rows separating it) — the reason was arithmetic, not a missing drive. See *Round 8* |
| the `SpikingModel` increment's own narrowing (`0x67c7c-0x67ca0`, `f32(delta*lrate)`) → the binary64 product | **killed** — by the pre-existing pin: `native parity: spiking > matches every learned efficacy bit-for-bit` goes `26/26 → 24/26` (max 1 ulp) with that revert alone |

Not transcribed, not pinned, with the per-site reason:

* ~~**`GroupsBrain::growSynapses`** `0x66b70`/`0x66dc0`~~ — **CLOSED by `t_7d391d0f` (2026-09-28)**,
  adjudicated per site: `0x66b70` is *provably* bit-identical to the port's two-step form (its
  fused product is `synapseCount_new * -0.5`, exact in binary64 for every integer, over an addend
  that is a binary32 widened exactly), and `0x66dc0` — the `nint` macro's `+ ±0.499999999`
  contracted into the last multiply of its argument — is transcribed (`nativeMath.ts`'s
  `nintFused`) and pinned by a constructed *boundary* family. See *Round 6* at the end of this
  section.
* **`AgentFitness`** `0x9b260` — **CLOSED by `t_20d5ff13` (2026-09-28).** The site is
  `f32Fma(cw, Complexity, f32(f32(hw*HF)/total))` inside the weighted-complexity branch
  `src/model/sim/agents.ts` used to throw on (it needed lane L13 and a
  `run/brain/function/…` read). `t_20d5ff13` wired both call sites to lane L13's
  `CalcComplexity_brainfunction` — `analyzeBrain` over `brainAnalysisParms.functionPath`, and
  `AgentFitness`'s lazy `run/brain/function/brainFunction_<n>.txt` re-read — and transcribed the
  branch's five float operations (`0x9b250`-`0x9b268`) with the `fmadd` at `0x9b260`, pinned by
  `tests/sim-complexity-seam.test.ts` against exact-rational cases whose fused and
  round-product-then-sum forms differ **in the returned fitness**.
* **`interact.ts` `Mate`** — the block runs only with `RandomBirthLocation True`; the schema
  default is `False`, neither recorded worldfile sets it, and there is no `mate()` drive
  harness, so no pin can separate the fused from the unfused form, and no recorded artifact can
  move either way. **The site's other open half, the trig overload, is settled and pinned by
  `t_c99150dc` (2026-09-28) — it is no longer a stand-in.** The shipped `TSimulation::Mate`
  contains `9856c: bl 0xa3994 <symbol stub for: ___sincosf_stret>` — a *single* call, and the
  fused two-output float entry in the `sinf`/`cosf` unit, i.e. exactly the overload the camera
  reaches (*Open questions* 9), not the scalar `sinf`/`cosf` pair and not `f32(double)`; `98570
  fmadd s1, s8, s1, s13` reads its cosine lane into x and `98574 fmsub s0, s8, s0, s14` its sine
  lane into z (the corpus agrees independently: `sincosf(0)` is `(0, 1)`). `src/model/sim/
  interact.ts` therefore calls the transcribed `sincosf`: **the last site in the tree that
  stood in for a *shipped-disassembly* float trig call with a narrowed `Math.cos`/`Math.sin` is
  gone** (the one other narrowed-double trig site left, `src/model/geometry/matrix.ts`'s
  `rotationMatrix`, mirrors GL's own `glRotatef` rather than a libm call in the shipped model
  code and belongs to lane W1e's PORT-NOTE `W1e/rotatef-trig`).
  `tests/sim-interact-mate-birth-trig.test.ts` pins the call site *and* carries the
  **measured** disagreement, so the pin depends on no fixture: **56
  (`sin`) / 48 (`cos`) of 200,000 `f32` angles** in the site's own domain `[0, 2*M_PI)`, and
  **428 (`x`) / 485 (`z`) of 3,200,000** `(angle, distance, midpoint)` samples through the fused
  update — the difference is not swallowed by the `fma` the way the `UpdateBody` narrowing was.
  **No recorded artifact can move, and this is not claimed as an artifact fix:** the whole block
  is dead in every recorded run, `RandomBirthLocation` being `False` in the schema default
  (`etc/worldfile.wfs:1465-1468`) *and* in both recorded worldfiles (all six scenarios'
  `run/normalized.wf` print `RandomBirthLocation False`). A revert is therefore invisible to
  every golden, farm line and per-agent trace; the call-site assertion is the only thing that
  catches it, and reverting the site to `f32(Math.cos(angle))`/`f32(Math.sin(angle))` is killed
  by that test alone (mutation check, this card).
* **`Step` `0x931b4`** — transcribed, and exercised on every recorded boot, but the
  `Simulation` instance is not reachable from the runner's return value, so there is no
  unit-level drive: reverting the two accumulator hunks leaves *both* recorded candidate trees
  byte-identical (`stat.1`'s `totFoodEnergy` prints the same either way). Recorded as a
  faithfulness fix with no measured artifact movement rather than claimed as a fix.
* **`sheets::Sheet::findReceptiveFieldNeurons`'s `offsetCenter`** — its only caller-visible
  projection is `findNeurons`' `ceil`/`floor` of the center, and a ≤1 ulp binary32 move changes
  that projection with probability ≈ 1e-7 (`dis/searchC.py`: 4·10⁵ trials, no discriminating
  input), so the helper is exported and pinned directly.
* **`FiringRateModel`'s and `SpikingModel`'s clamp chain** (`0x5e8bc`-`0x5e8cc`,
  `0x67cb0`-`0x67cc4`) — **pinned by `t_b20ef448` (2026-09-28)**, by a new native-differential
  drive rather than by a port-internal expectation: `native/brainprobe.cc`'s `learnclamp` mode
  (all three families, 1,024 rows each) and `tests/brain-core.test.ts`'s
  `native parity: clampfiringrate{,2}` blocks. See *Round 7* below for the family, the
  round-trip investigation that the removed hand drive's failure mode left open, and *Round 8* for
  the one clause that family does not separate — the delta line's own fusion (`0x5e8a8`), pinned
  since `t_efc4dc64` by `native/brainprobe.cc`'s `learndelta` mode.

### Round 6 — `GroupsBrain::growSynapses`' double class, adjudicated per site (t_7d391d0f)

The two `fmadd d` sites the *Not transcribed, not pinned* list carried out of Round 5 were the last
of the sweep's double class. Read out of the shipped dylib instruction by instruction:

```
0x66b70  fmadd d0, d1, d2, d0     ; d1 = (double)synapseCount_new (66b68 scvtf), d2 = -0.5,
                                  ; d0 = (double)(f32(localTo/countTo) * f32(countFrom))
                                  ;      — 66b58 fmul s0 + 66b5c fcvt d0, an exact widening
0x66dc0  fmadd d0, d9, d11, d0    ; d9  = 66d7c fmul( draw1, (double)td_fromto_abs ) — rounded
                                  ; d11 = (double)neuronCount_from (66ce4 scvtf d11, w8)
                                  ; d0  = 66dbc fcsel( ±0.499999999 ) by the sign of the OTHER
                                  ;       evaluation, 66d90/66d94 fmul, tested at 66d98 fcmp
```

**The Round-5 note's register reading of `0x66dc0` was wrong, and the correction is what makes the
site transcribable:** `d11` is the *count*, not the constant — the constant is `fcsel`'d into `d0`,
the addend — so the binary computes `trunc( RN( RN(draw1*td_fromto_abs) * count + ±0.499999999 ) )`
with **one** rounding, while a rounds-per-operation transcription rounds the product first. (`scvtf
d11, w8` at `66ce4`, with `w8 = [x29-0x44] = neuronCount_from`, settles it.)

| site | outcome | why |
|---|---|---|
| `0x66b70` (`neuronLocalIndex_fromBase`, `GroupsBrain.cc:713`) | **bit-identical — not transcribed, and *provably* unable to move** | the fused product is `synapseCount_new * -0.5`: a power-of-two scaling of an integer, exact in binary64 for every `\|synapseCount_new\| < 2⁵³`, and the addend is a binary32 widened exactly, so `fma(d1, d2, d0)` and `d0 + RN(d1*d2)` are the *same double* on every input. The site's 7,272 `baseidx` rows are exact for that reason, not by luck — and no boundary family can exist that separates the two forms |
| `0x66dc0` (the `nint` macro, `GroupsBrain.cc:778`) | **contracted**: `nativeMath.ts`'s `nintFused`; `growArithmetic.ts`'s `distortionIndex` now keeps *both* evaluations (the fused sum of the first, the unfused second only for the sign) | the two forms differ only where the product lands within ~1 ulp of the truncation boundary `n - K` — so the grid had to be *built* to see it (below) |

**The boundary family.** `native/brainprobe.cc`'s `growexpr` mode now constructs those rows the way
the `synnew` tie family is constructed: for each `(td_abs, count)` shape and each integer `n`,
solve `R* = (n - K)/(td_abs*count)`, snap it to the nearest draw of `range(-0.5,0.5)`'s own grid
(`-0.5 + k·2⁻⁴⁸` — drand48: the `NERVOUS_SYSTEM` generator `growSynapses` reaches through
`_cns->getRNG()` whenever its type is GLOBAL, and always the `TOPOLOGICAL_DISTORTION` role that the
seed-gene flag switches to; the gsl MT19937 `2⁻³²` grid is the other stream the site can draw from,
selected as LOCAL by `StaticTimestepGeometry`) and walk ±6 grid steps, because the window is far
narrower than the grid and the family has to carry its neighbours. A row is emitted **only when the
compiled macro and the pre-change transcription disagree**, so the family cannot be vacuous and the
probe *fails loudly* if a future build stops contracting. It emits **522 rows over 70 `(td_abs,
count)` shapes** (tag `distortb`), and the differential block reports
`distortb: 522/522 exact (pre-change form wrong on 522)`.

The oracle was checked independently of the port: the same rows read back through an
exact-`Fraction` model of the instruction sequence above reproduce **all 30,330
`distort`/`distortb` rows with 0 mismatches**, and disagree with the pre-change form on exactly
those 522. Reachability, measured rather than argued: **the recorded scenarios do not draw from the
2⁻⁴⁸ stream at all.** Their own `run/normalized.wf` says `EnableTopologicalDistortionRngSeed False`
(so `td_rng` is `_cns->getRNG()`, `GroupsBrain.cc:649`) and `StaticTimestepGeometry True` (so that
generator is LOCAL, `Simulation.cc:3866`) — a gsl MT19937 stream on the `2⁻³²` lattice — while a
brute-force boundary search over the same shapes found **40 discriminating draws on drand48's `2⁻⁴⁸`
grid (934,286 candidates) and none on the gsl `2⁻³²` grid (933,050 candidates)**. The window is
≈2²¹ times narrower than a gsl step, so a hit there needs the knife edge to align with that lattice,
and none of the ≈2·10⁵ `(shape, integer, sign)` targets in the search does. That is why no recorded
artifact has ever moved on this site: a *reachability* statement, and the reason this fix is pinned
rather than credited with a run-level difference.

**Acceptance, measured.** (a) `tests/brain-core.test.ts` **44/44**, activation census **96/96 ·
96/96 · 102/102** and efficacy census **23/23 · 23/23 · 26/26** (max 0 ulp), `fma` census
57,539/57,539, and the grown grid — `synnew` 21,721, `remupd` 560, `baseidx` 7,272, `tdabs` 5,358,
`distort` 29,808, `distortb` 522, `stdev` 176, `energy` 10,368 — every row exact. (b) the walk is
byte-identical: `microtest_voff` **PASS 225/225** (150/150 `.gz` payloads byte-identical) and
`minitest_voff` **PASS 1369/1369** (1167/1167 `.gz`; 238 of the 1,080 `run/brain/**` paths are
`run/brain/synapses/**`), the two candidate trees — contraction vs pre-change form — are
**byte-identical to each other** (`diff -r`, no output), and the `dyn` growers worlds agree:
`cppprops-sim-engine` + `-growers-{dyn,small}` **13/13 in both forms**. (c) mutation: reverting only
`distortionIndex` to the round-then-add body gives `distortb: **0/522** exact` and fails that one
test (`1 failed | 43 passed`) while the walk tests stay green — the pin is the guard here, the walk
is not.

### Round 7 — the learning rule's clamp chain, pinned by a driven differential (t_b20ef448)

The mutation table had exactly one survivor and it was this site. `FiringRateModel::update`'s and
`SpikingModel::update`'s learning rule decays an efficacy back toward `0.5*maxWeight` once it is above
it (`0x5e8bc`-`0x5e8cc` / `0x67cb0`-`0x67cc4`), in `float`, one rounding per operation, with the first
product fused; Round 5 transcribed it and nothing drove it.

**The investigation the card opened with — the hand drive, adjudicated.** The removed drive's
signature was that a constructed efficacy came back exactly as it had been set, and the card asked
whether that was a defect in the port's `set_synapse`/`update` round trip. It is not. The learning
block is gated on `Brain::config.enableLearning && !cns->getBrain()->isFrozen()`, and `enableLearning`
is *derived* from `learningMode` by `Brain::processWorldfile` — the models never derive it. A
hand-built brain (`ProbeBrain`/`ProbeCns`, no worldfile) therefore has to set that flag itself, and
the drive did not, so its loop never ran. Measured both ways on the same 1,024-synapse brain
(`tests/brain-core.test.ts` → *runs the learning block only with `enableLearning` set — the unclamped
hand drive, reproduced*): with the gate off **1,024/1,024** constructed efficacies come back
bit-identical, with it on the chain moves them. **No round-trip defect**: `set_synapse` stores what it
is given, `get_synapse` returns it, and the clamp *is* reachable from `update()` alone — the input that
reaches it is a synapse whose constructed `|efficacy|` already sits inside
`(0.5f*maxWeight, maxWeight]`.

**The family.** `native/brainprobe.cc`'s new `learnclamp` mode builds exactly that: 1,024 output
neurons with one incoming synapse each, magnitudes swept across the whole clamped band
(`0.5*maxWeight*(1 + band/perPick)`, both signs), four `(a_from, bias)` picks — `a_from = 0.5` makes
the delta *exactly* zero, so those rows isolate the clamp chain, the others exercise the delta as well
— and one step through the model's own `set_synapse -> update -> get_synapse` round trip with
`Brain::config.enableLearning` true. Per synapse it writes the **pre-clamp** value the rule formed, the
value the **shipped** `libpolyworld.dylib` stored (the arbiter), the value the **pre-change binary64**
form would store, and a `differs` verdict. The mode **exits non-zero** if a family stops
discriminating, and it also evaluates the port's *current* transcription in C++ and reports
`current_mismatches` — **0 on all three families**, i.e. the transcription the port ships is the
arithmetic the shipped dylib computes, which is what makes this a differential rather than a
self-check.

| family (tag) | clamped | rows the pre-change form moves |
|---|---|---|
| firing-rate, `decayRate 0.99` — the recorded scenarios' model (`clampfiringrate`) | 1,021/1,024 | **212** |
| firing-rate, `decayRate 0.1` (`clampfiringrate2`) | 1,021/1,024 | **465** |
| spiking (`clampspiking`) | 1,024/1,024 | **204** |

**The pin.** `tests/brain-core.test.ts`'s three `native parity: clamp*` blocks (5 tests each, 15 new):
the port must reproduce the shipped model's stored efficacy **bit-for-bit on all 1,024 rows of all
three families**; the pre-clamp value the probe drove must equal the one the port's own learning loop
read; and a TypeScript transcription of the *mutation*, evaluated from the port's own state, must (a)
reproduce the probe's `pre` column exactly and (b) disagree with the arbiter on exactly the rows the
probe calls `differs`. `tests/brain-core.test.ts` **59/59** (was 44/44).

**Mutation check, measured** (one revert at a time on the live tree, the owning suite *and* the whole
suite re-run, the tree restored and re-hashed): the revert the table names — `scaled` in binary64 with
one rounding at the end, `f32Fma(maxWeight, -0.5, |e|)` back to `|e| - halfMaxWeight` — in **both**
models gives **14 failed | 679 passed, 5 files red**: the three new
`matches the shipped model bit-for-bit on every driven synapse` tests, the pre-existing
`native parity: spiking` efficacy census (`26/26 → 25/26`), and 11 in `cppprops-{recorded-tree,sim-engine*}`,
where the `dyn`/`small` growers worlds get their old knife edge back
(`growers_dyn`: `expect(extra).toBe(step === 239 ? 1 : 0)` → `expected -1 to be +0`). The first
new-family failure quotes one ulp: `synapse 31: native 0x407fb8b4, port 0x407fb8b3`.

**It also re-measures the old verdict.** `survives in every suite` no longer holds on the re-run even
without the new pin: the delta line's own narrowing (`f32(syn.delta * learningrate)`, landed after
Round 5) moved the spiking spec's learned efficacies across `0.5*maxWeight`, so the clamp half of the
revert is now caught by the pre-existing `native parity: spiking` census. What was missing is a
family that drives the site *on purpose*; that is what this pass adds.

**The residual, named and measured.** The learning step's other contraction — the `FiringRateModel`
delta line, `f32(fma64(delta, a_from - 0.5, syn.efficacy))` (`0x5e8a8`) — is **not** separated by this
family, and reverting it alone leaves the whole suite green (`59/59`, measured; its own row is in the
mutation table). The reason is arithmetic rather than a missing drive: the fused and
rounds-per-operation deltas differ by at most ½ ulp of a product whose magnitude is bounded by
`maxlrate · 0.5 · 0.5 = 0.025`, and the store that consumes it narrows to binary32 at `|e| ≈ 4-8`,
where one ulp is `4.8e-7` — so the pair has to land within one double ulp (`~9e-16`) of an f32
midpoint for the store to see it. **0 of the 3,072 driven rows does.** Pinning it needs a
*constructed* boundary family, not a wider sweep: saturate the destination neuron (a large `bias`
makes `a_to = 1.0` exactly, so the delta reduces to `e + fma(t, db, e)` with `t = lrate/2` exact),
then solve `db = a_from - 0.5` — a value the spec carries at full double precision through `%.17g` —
so the double sum lands on the f32 midpoint above `e`, where the two forms round differently. Left
here as a proposal with its reasoning, and as its own mutation-table row, rather than folded into the
killed row. **Built and measured by `t_efc4dc64` — *Round 8* below — which flips that row to
`killed`.**

### Round 8 — the learning rule's fused delta, pinned by a saturated-destination family (t_efc4dc64)

Round 7 left one clause of the same statements unpinned, and it was the *other* contraction in them:
the `FiringRateModel` delta line, `f32(fma64(delta, a_from - 0.5, syn.efficacy))` (`0x5e8a8` is the
`fmadd d17, d18, d19, d17` that contracts its last product with the add). The clamp family cannot see
it, and the reason is arithmetic: over live activations the two forms differ by at most ½ ulp of a
product bounded by `maxlrate · 0.5 · 0.5 = 0.025`, while the store that consumes the sum narrows to
binary32 at `|e| ≈ 4-8`, where one ulp is `4.8e-7` — the pair has to land within about one *double*
ulp of an f32 midpoint. **0 of that family's 3,072 driven rows does.**

**What it takes, and the two things that make it awkward.** The construction saturates the destination
(`bias 64` puts `logistic(.)` at exactly `1.0`, so `a_to - 0.5` is exactly `0.5` and the delta is the
exact double `t = lrate/2`) and gives every row its own input neuron, whose `a_from` the spec's
`input` line carries at full double precision. Then the step is `e + t·db` with `db = a_from - 0.5`
free, and the row is a hit where the *exact* sum and the sum of the rounded product straddle the f32
midpoint `m = (e + nextfloat(e))/2`:

* the target is the sum's tie adjacent to `m`, **not** `m` itself — and it cannot be computed as a
  sum, because `m + uS/2` *is* the tie and binary64 rounds it straight back to `m`. It has to be
  formed in the product's own binade, `P* = (m - e) ± uS/2`, where the summand is small enough for
  the half-ulp to survive. A search aimed at `m` is silently a no-op (its trial runs found `0` rows
  with `delta == 0` at every step).
* the input's grid is what limits the resolution: `a_from = 0.5 + db` is a multiple of `2^-53`, so one
  grid step moves the product by `t·2^-53` while the fused/unfused pair can only differ when the
  product sits within ½ ulp of itself of the tie — a window `t·db·2^-53` wide. The grid therefore only
  resolves it for `db ≈ 0.5`, i.e. for `lrate ≈ e·2^-23` (~1e-7 here), and even then the product's own
  rounding error has to have the right sign, so the search walks a family of `lrate` alignments and
  keeps the rows that separate.

**The family.** 16 rows, one per `e` in `0.5 … 2.75` (all with even mantissas, so the f32 midpoint
above `e` tie-breaks *down* to `e` and the fused form — one double ulp above it — is the mover), each
with its own input neuron and a `bias 64` destination:

| rows | separating (`differs`) | destination saturated at `1.0` | probe `current_mismatches` |
|---|---|---|---|
| 16 (`e` = 0.5 … 2.75, `lrate` ≈ 1.2e-7 … 4.8e-7) | **16/16** | 16/16 | **0** |

The mode emits **only** separating rows and exits non-zero when it finds none, exactly the
`learnclamp`/`growexpr` pattern; `current_mismatches` is its C++ transcription of the port's current
line compiled by the same clang that built the oracle, checked against the shipped model's own stored
value on every row.

**The pin.** `tests/brain-core.test.ts`'s `native parity: learndelta (the learning rule's fused delta)`
(3 tests): every row's `differs` verdict is consistent, the destination activation is exactly `1.0`,
and the port must reproduce the shipped model's stored efficacy **bit-for-bit on all 16 rows**. The
non-vacuity is measured both ways, from the port's own state rather than from the probe's word: the
test re-derives (a) the fused pre-clamp value — which must equal the probe's `fused` column — and
(b) a TypeScript transcription of the *mutation* (`f32(syn.efficacy + learningrate * (a_to-0.5) *
(a_from-0.5))`), which must equal the probe's `pre` column **and** disagree with the arbiter on
**every** row. `tests/brain-core.test.ts` **62/62** (was 59/59).

**Mutation check, measured** (the revert applied to the delta line alone on the live tree, the owning
suite *and* the whole suite re-run, the tree restored and re-hashed — `sha256 987f9c32…`):
`tests/brain-core.test.ts` **1 failed | 61 passed** and the whole suite **1 failed | 695 passed |
1 skipped, 46 files**. The only red test is the new pin:
`matches the shipped model bit-for-bit on every driven synapse` → `expect([...]).toEqual([])`,
`synapse 0: native 0x3f000001, port 0x3f000000` (all 16 rows move one f32 ulp down). The unmutated
tree is green at the same run (46 files / 696 passed / 1 skipped; the whole-suite counts move as
other lanes land their own tests) and the site's own mutation-table row flips from `survives` to
`killed`.

**The six-scenario milestone re-run is unchanged** — `microtest_voff` `PASS 225/225`,
`minitest_voff` `PASS 1369/1369`, `microtest_von` `PASS 225/225`, `minitest_von` `PASS 1308/1308`,
`hello` `PASS 19/19`, `minitest_adami` `PASS 1373/1373`, `differing=0 missing=0 extra=0` in all six
(the runner's trees under a scratch directory; the recorded goldens untouched).

**Residual, stated plainly.** The family is a knife edge *by construction* — each row is the single
grid point whose product's last bit falls on the f32 midpoint — and in this family all 16 rows happen
to share one `a_from` (the tie's own geometry fixes it; `e` and `lrate` are what vary). That is what
the site costs: it is a contraction whose whole effect is the last bit of the product, and no sweep of
live activations reaches it. It pins exactly one site: the `FiringRateModel` delta line. The
`SpikingModel` learning step has no counterpart to pin — its increment is the single product
`f32(syn.delta * learningrate)` with no add to contract — and that narrowing is what the
pre-existing `native parity: spiking` efficacy census already catches (`26/26 → 24/26`).

## Open questions for humans


1. ~~Browser demo scope: canned worlds with a speed bar, or a full parameter UI?~~
   **CLOSED (orchestrator, 2026-09-28) — answered by the shipped demo, and re-confirmed on
   `09df61d`.** The demo is the first option and only the first option:
   `src/browser/sim/bundledWorlds.ts` boots one of three canned worldfiles (`hello`, `microtest`,
   `minitest`), and `src/browser/ui/controlBar.ts`'s `PORT-NOTE (W1g/ui)` fixes the smallest usable
   set — run state, single step, sim speed, restart — and states that worldfile selection and
   parameter editors are *deliberately absent*. A full parameter UI is therefore a **new** product
   request, not outstanding work: reopen this entry if you want one.
2. ~~Does the browser build need the offline analysis tools (L17) at all, or is that native-only
   work?~~ **CLOSED (orchestrator, 2026-09-28) — `PORT_PLAN.md` Risks 3 already decided it.** "L17
   (tools) and L18 (UI) are not needed for a browser demo; they can be deferred without weakening
   Tier A." What L17 landed as, and what every PASS above ran through, is the *parity harness*
   (`tools/record_oracle.py`, `tools/check_parity.py`, `tools/parity_common.py`,
   `tools/add_scenario.py`, `oracle/run_parity.sh`). The three native `tools/**` programs the plan
   names (`nullevo`, `passive`, `clustering`) are not ported, and nothing on the demo's path wants
   them.
3. ~~**(W1e)** Apple GLU's division path for `gluPerspective`: … Is a ≤1 ulp projection
   acceptable to the vision lanes, or should L16 own a calibration pass against its own retina
   goldens?~~ **CLOSED (orchestrator, 2026-09-29) — a ≤1 ulp projection is acceptable and no
   calibration pass is owed.** The measured state is in this file's own vision exceptions table:
   the *only* recorded projection entries the port does not reproduce are `m[2][2]` on the two
   unattached-camera fixtures (≤1 ulp, `0xbf810101` vs native `0xbf810102`, `0xbf884211` vs
   `0xbf884210`), no formulation reproduces them, and the pinned reciprocal form is the measured
   best (951/1152 grid points, 52/52 recorded entry values, against 808-835/1152 for the division;
   `W1e/glu-perspective-reciprocal`). Two facts decide it: those two entries belong to fixtures no
   scenario's frozen artifacts depend on, and the contract is the retina neurons, not the matrix —
   both vision-on scenarios are byte-exact end to end (**re-run on `1a41ff4`: `microtest_von`
   `PASS (225/225 files)` with 150/150 `.gz` containers byte-identical, `minitest_von`
   `PASS (1308/1308 files)` with 1114/1114**, `differing=0 missing=0 extra=0`). Calibrating against
   the retina goldens would be fitting two entries nothing measures; reopen this entry if a scenario
   ever pins one of them.
4. **(W1e)** arm64 `atan2f` — **CLOSED by `t_4bb10112` (2026-09-29).** *Answered, and restated
   with its counterexample, by `t_d3f63606`.* The census (`PARITY.md` → lane W1e, *The `atan2f`
   census*) measured the residue: the port's `f32(Math.atan2)` stand-in was exact on the **whole**
   ±π family (0 of 4,130 rows — what `W1e/atan2f-pi` pinned) but differed from the shipped
   `atan2f` by 1 ulp on **460 of 20,050** census rows (2.3 %), the model's own argument class
   included (`reachable-lattice`, differences of WorldSize-25 world coordinates: 204/4,532; any
   float `|v| < 256`: 27/2,000; a 606,583-pair wide sweep: 18,279, 3.0 %). So "transcribed form
   is exact off the ±π case" is **false**. The shipped function is the inaccurate side (the true
   value is nearer `f32(atan2)` on 177/179 decided rows; arm64's `atan2f` is a double-interior
   polynomial with >0.5 ulp error), and the difference is *observable*, not merely theoretical:
   187 of 244 differing reachable pairs have a wedge configuration inside the model's own domain
   (`fov ∈ [20,140]`, `yaw ∈ [0,360)`) whose `angmin`/`angmax` lands exactly on the differing
   float and flips the `Inside` verdict (`tools/witness_atan2f_wedge.ts`). It moves no recorded
   byte — `Inside` has no call site in `src/model/**` and native's `infrustum`/`outfrustum`
   counters are never logged. The transcription landed as `t_4bb10112` (`fullstack-dev-2`): the
   stand-in is **deleted**, `src/model/rng/libm.ts` exports a bit-exact `atan2f` (constants
   extracted from the shipped bytes and checked by `native/gen_atan2f_table.py`, the C
   transcription diffed against the census first, bit-exact on all 20,050 + 606,583 rows),
   `nativeAtan2f` delegates to it, and the corpus is replayed in `tests/rng.test.ts`. The
   pre-transcription stand-in's numbers stay in the census table as measured history, and all six
   scenario verdicts are unchanged.
5. ~~**(L6 → L1/W1d) libm `exp`**~~ **CLOSED by `t_12c76fc3` (2026-09-28).** The oracle's
   `exp` is **not** correctly rounded (8,255/8,261 corpus values against a correctly rounded
   reference; `Math.exp` is 7,876/8,261), so the answer to "is it correctly rounded?" was no —
   but the transcription exists anyway: `src/model/rng/libm.ts`'s `exp` is bit-exact, and L6's
   `logistic`/`gaussian`/bias coin now call it (its own probe: `exp` 512/512, `logistic`
   2,048/2,048, 0 ulp, was 464/512 and 1,976/2,048). The *remaining* activation residual on
   L6's own path — the one this question used to leave open — was **closed by `t_da2ab201`**
   (clang's `-ffp-contract=on`: the census is now 96/96 · 96/96 · 102/102 activations and
   23/23 · 23/23 · 26/26 efficacies, max 0 ulp; see the libm finding).
6. ~~**(W1e → L16/W1j collision)** two implementations of the GL matrix/camera maths now
   exist (`src/model/geometry/**` here, `src/model/vision/{camera,matrix}.ts` in the vision
   lane, whose tests consume these goldens). The orchestrator should name one as the owner and
   have the other re-export it, before more lanes import either.~~
   **CLOSED by `t_1feec49a` (2026-09-28). One owner: `src/model/geometry/**` (lane L15/W1e, the
   native `gcamera`/GL owner). `src/model/vision/matrix.ts` is now a storage adapter with no
   arithmetic of its own and `vision/camera.ts` *builds* L15's `Camera`; the vision lane owns the
   vision configuration only.**

   **The measurement that chose it.** Two questions had to be answered separately: *are the two
   implementations bit-identical on the states the vision path renders?* and *which rule is the
   native one?* The answers were no and **neither, per primitive**:

   - *They are not close.* Random states through both implementations: the composition rounding
     disagrees on 19,830 of 20,000 products; the degrees→radians conversion disagrees on 390 of
     4,323 angles; the projection disagrees on 2,133 of 5,040 `(fov, aspect, near, far)`
     combinations; modelview (the oracle's own `EnableVisionPitch/Yaw False` configuration)
     disagrees on 9,996 of 20,000 random agent poses. On the six **recorded** scene cameras they
     differ only in one translation entry (2-3 ulp) — which is exactly how a silent-parity hazard
     survives a green test suite.
   - *The rule was measured, per primitive, against the running implementation* (Apple GL 2.1 /
     GLU 1.3 through an offscreen legacy CGL context — the same implementation the native build
     links — plus the recorded `glGetFloatv` goldens):
     * **composition**: one f32 rounding **per term** (the FMA chain), not one rounding of the
       four-term dot. The recorded `gl.obj->minitest_a10_focus_min.modelview[14] = 0x3fbbff8a` is
       reproduced by the chain and missed by f64 accumulation (`0x3fbbff87`); over 20,000 random
       GL compositions the chain reproduces GL 15,485 times and f64 accumulation 6,964. **The
       vision copy had this right and `geometry/matrix.ts` had it wrong**, so the single
       definition takes the chain (`W1e/compose-rounding`).
     * **degrees→radians**: `f32(f32(deg)·f32(π/180))` — the **f32** constant. 4,323/4,323 angles
       over `[-180°, 180°]` × {x,y,z} against GL, versus 3,939/4,323 for the double-product form
       the vision copy used (`W1e/rotatef-radians-measured`). The six recorded angles cannot
       separate the two — the 4,323-point sweep is what decided it.
     * **`gluPerspective`**: f32 half-extents, and the near-plane entries as `f32(2·zNear)` times
       a **rounded f32 reciprocal** of the frustum width — not a division. 52/52 recorded entry
       values and 951/1152 grid points, against 49-50/52 and 808-835 for the division; it is also
       the only form insensitive to the last bit of `zNear`, which matters because native hands GL
       the **promoted float** `fNear`. The depth entries narrow the numerator to f32 and divide by
       the *double* plane delta (`W1e/glu-perspective-reciprocal`, `W1e/glFrustum-float-delta`).
       The vision copy's division form missed the recorded
       `gl.obj->vision_pitch_yaw.projection[0]` as soon as it was fed the camera's float near
       rather than a double `0.01` literal.
   - *The six-scenario milestone does not discriminate*: driven with **either** implementation's
     matrices, all six candidate trees are **byte-identical to each other** (measured), and
     byte-identical again after the collapse — the runs are only pixel-sensitive at the margins
     `vision/raster-subpixel-grid` and `vision/pov-scan-not-a-rays` already localise. Neither
     is the 7,315-row retina dump a matrix discriminator: `tests/vision-native-rows.test.ts` holds
     the **encoder** against those recorded pixels, not the renderer. The native `glGetFloatv`
     fixtures and the live GL/GLU measurements above are therefore the arbiters, not the run trees.
   - *Outcome*: every recorded projection is now bit-exact (including `m[0][0]` for aspect 5 and
     the `far = 150` world camera, which the pre-collapse L15 code missed by 1 ulp), every scene
     modelview is bit-exact, and the both-pitch-and-yaw camera improved from three wrong entries
     to one sign-flipped ~1.3e-8 residual (its `[9]`/`[10]`, previously exact zero, now match
     native). The two remaining 1-ulp `m[2][2]` residuals are the two *unattached-camera*
     fixtures and are tabulated in lane W1e's *Known residuals*.
   - *Evidence*: `npx tsc --noEmit` clean; `npx vitest run` **45 files / 667 tests green** (that
     pass's own count; superseded — **48 files / 729 passed | 1 skipped** on `b2bbcaf`,
     2026-09-29);
     `./oracle/run_parity.sh {microtest_voff,minitest_voff,microtest_von,minitest_von,hello,minitest_adami}`
     **PASS** (225/225, 1369/1369, 225/225, 1308/1308, 19/19, 1373/1373) with the run trees
     byte-identical to the pre-change baseline; and the new pins in `tests/vision-camera.test.ts`
     (*the vision camera IS L15's `gcamera`*, 1,000 random configurations; *the adapter is the
     identity on L15's primitives*, 500 random states; a non-axis `glRotatef` is refused).
     No pin was relaxed: `tests/geometry.test.ts`'s projection tolerances were **tightened** to
     bit-exact where the measurement says so, and the modelview translation bound went from ≤4
     to ≤1 ulp.
7. ~~**(W1d → W1a) `src/model/types/rng.ts` documents the wrong `rand()` algorithm.**~~
   **CLOSED by `ce504e1` (2026-09-28, lane W1a's doc batch) — verified on `1a41ff4`.** The header
   used to read "glibc rand()/srand() — RAND_MAX = 2^31-1, TYPE_3 additive feedback"; the oracle
   (macOS/Apple Libc) has `rand()` = Park–Miller and `random()` = TYPE_3 as two *separate* streams
   (`bin/rancheck` prints both). It now names both streams, says which one the frozen
   `srand(seed)`/`rand(): number` entry points are (Park–Miller, `LibcRand` in
   `src/model/rng/rand.ts`, alongside `BsdRandom` for `random()`, PORT-NOTE
   `W1d/rand-is-not-random`), and attributes the old TYPE_3 note to glibc's aliasing of `random()`.
   The frozen shape was never affected and the behavioural half was never in question — nothing in
   the recorded scenarios uses `rand()` in a way that changes a logged byte (`graphics/gobject.cc`
   colours, `complexity`'s `srand`, `sim`'s `srand(1)` with no `rand()` draw) — so no lane needs to
   re-check vectors.
8. **(W1d → every lane that needs libm) the oracle's `log` is platform-specific and was
   transcribed from the running libSystem** (`W1d/log-is-platform-specific`). The same is true
   of `exp` (transcribed in `t_12c76fc3`), `sin`/`cos` (`t_5221d534`) and `pow`
   (`t_9ed428d7`) — all four are transcriptions of this machine's libSystem, each diffed
   against its captured corpus first: the method that worked is measurement first
   (`native fn` vs an exact reference), then transcription from the disassembly, never "use
   `Math.*`, it's close enough" — `Math.log` is 4.6 % off, `Math.exp` 4.6 %, `Math.pow` 8.7 %.
   If the project ever re-records goldens on another OS/CPU, every transcribed libm function
   must be re-done. ~~Is macOS/arm64 fixed as the oracle platform for the life of the port?~~
   **CLOSED (orchestrator, 2026-09-29) — yes: the oracle *is* the recorded golden, and the
   recorded golden is this machine's shipped build.** `PORT_SPEC.md`'s definition of done is
   `tools/check_parity.py --golden oracle/<scenario> --candidate <tree>` exiting 0, and every
   golden under `oracle/**` was recorded from the native build on macOS/arm64 (the same anchor is
   already in `PORT_SPEC.md`: Apple's libz 1.2.12 defines the `.gz` containers). There is no
   second oracle to be exact against, so "the oracle platform" is not a policy knob — it is the
   artifact set the acceptance criteria name. The transcription rule above stands as the record of
   *how* each function was matched (measure, then transcribe the disassembly), and the six
   scenario PASSes are the standing evidence. **Re-recording the goldens on another OS/CPU — or
   pinning the native build to `-ffp-contract=off` and re-recording (the tail of item 11, declined
   there on 2026-09-29) — is a
   new project, not outstanding work on this port: reopen if cross-platform goldens are ever
   wanted.**
9. **(L14 → L1/libm) RESOLVED by `t_05611902` — the native camera math is single-precision
   trigonometrical *and* it is not the scalar `float` overloads; both are now transcribed, and
   the recorded frames are what settled it.** Measured, twice: a translation unit compiled with
   `CameraController.cc`'s include chain and flags reports `sizeof( sin( camrad ) ) == 4` and
   `sizeof( cos( camrad ) ) == 4` while `sizeof( sin( (double) camrad ) ) == 8` — i.e. the C++
   `float` overloads are selected — and the *shipped* `libpolyworld.dylib`'s
   `CameraController::setRotationAngle(float)` contains `bl ___sincosf_stret` (read off the
   symbol stub), because LLVM's sincos combine merges the two adjacent calls into the
   two-output entry at `sinf + 0x1ac` — a different algorithm from the scalar pair. Bumping the
   camera onto the transcribed `sinf`/`cosf` **moved a recorded frame**: `camera.json`
   `rotate[3]` frame 3 is `1123315328`, which is `__sincosf_stret`'s cosine (`0x3ee29cc3`),
   while `cosf` gives one ulp less (`0x3ee29cc2`) and lands on `1123315326`. So the frames were
   the evidence after all — they just answered a different question than the one asked. Both
   things are transcribed now (`libm.ts`: `sinf`/`cosf` over their 5,016-argument corpora and
   `sincosf` over `raw/libm_native_sincosf.txt`, each C transcription diffed against the shipped
   function first, plus a 105,119-argument sweep per function), L14 calls `sincosf`, and all
   117 frames are bit-exact again with no double-rounding stand-in. The general rule the
   question wanted is unchanged and now demonstrated: the native code's argument *type* decides
   which overload it gets — and, at `-O2`, the compiler may decide to fuse two of them. **The
   fused entry is not the camera's alone:** `TSimulation::Mate`'s birth-position trig makes the
   same `bl` (`0x9856c`, `t_c99150dc`), so `src/model/sim/interact.ts` calls `sincosf` too.
10. **(L14 → oracle coverage) three monitor paths cannot be pinned by a probe.** (a) the
    agent-tracking camera branches *with a live target* (`Overhead` = the agent's `x`/`z`,
    `POV` = the agent's own `gcamera`) need a real `agent`, and `AgentTracker::setTarget` is
    private to `Listener`/`MonitorManager`; (b) `FarmMonitor`'s command string needs
    `CppProperties::getMetadata()`, i.e. the run-time compiled props dylib (W1h); (c) the movie
    *bytes* beyond the schedule are Tier C by decision. All three are ported (field copies and
    string building) and unit-tested against mocks, and none of them touches a frozen artifact.
    ~~**Question:** is that enough, or do you want a "run a real simulation inside the probe"
    harness (displace-able `run/` in a temp cwd) to close (a)?~~
    **CLOSED (orchestrator, 2026-09-29) — that is enough; no real-simulation-in-probe harness is
    owed.** The lane's contract is the frozen artifact, and the monitor's frozen artifact is
    `run/stats/stat.<timestep>` — produced, not inferred, on both paths this fire: the node runner
    and the **live page in a real headless Chrome** (`src/browser/verify/demoEvidence.mjs` →
    `./oracle/run_parity.sh <scenario> --candidate <page tree>`) each write it byte-exact
    (`hello` 19/19, `microtest_voff` 225/225, `minitest_voff` 1369/1369, `differing=0 missing=0
    extra=0`). (b) is W1h's own verified binding and (c) is Tier C by decision. Building a
    displace-able `run/` in a temp cwd to reach a *private* `AgentTracker` field would add harness
    surface inside the oracle probe for a path no frozen artifact reads. **Reopen if a scenario
    ever pins a live-target `Overhead`/`POV` camera: then the probe is the only way to reach it.**
11. **(L8) RESOLVED — the 65 last-bit inexact cases were clang FP contraction, and the port now
    transcribes the contraction instead of the source text.** Round 1 reproduced it against the
    committed vectors (3016 cases, floats compared as bit patterns): the native function copied
    verbatim (`agent.cc:1653-1738`) and compiled with the native build's own flags
    (`/usr/bin/clang++ -std=c++17 -O2`) gives

        #pragma clang fp contract(off)   exact 2951/3016, 65 inexact, worst |delta| 0.000545502
        #pragma clang fp contract(on)    exact 3016/3016 (clang -O2's default)

    and the port's bits were byte-identical to the contract-off transcription on all 3016 cases.
    t_4392393c then took the route that needs no native rebuild and no golden re-record:
    **disassemble the shipped `agent::GetCollisionFixedCoordinates` (0x27504) and transcribe the
    contraction it actually performs** (`fmadd`/`fmsub`/`fnmsub`/`fnmul`, expressed as the
    exactly-rounded `f32Fma` in `src/model/agent/numeric.ts`). The lane is now **3022/3022
    bit-exact**, the tolerance branch in `tests/agent.test.ts` is deleted, and the probe carries
    6 crafted contraction cases alongside the 16 branch/early-out ones (regenerating
    `native/vectors/collision.json` from the shipped dylib keeps the original 3016 rows
    byte-identical). The general form of this rule, for every lane — find the sites by
    disassembling, never by guessing, and `f32Fma` rather than `Math.fround(a*b + c)` — is
    **the float-contraction rule** section above.

    ~~No human decision is outstanding for the port. The one decision that *would* be a human call,
    and which this card deliberately did **not** take: pinning the native model build to
    `-ffp-contract=off` (`etc/bld/Makefile.conf`) and re-recording every golden, so the source
    text and the binary agree by construction. That would re-record every golden (an
    orchestrator/human call), and until it happens the shipped build and the goldens *are* the
    contract.~~ **CLOSED (orchestrator, 2026-09-29) — declined: the shipped build and the recorded
    goldens remain the contract. No `-ffp-contract=off` re-pin, no golden re-record; item 8's
    classification of it as "a new project, not outstanding work on this port" stands.** Four
    reasons, none of them taste:

    - **It buys no measured fidelity.** The port is byte-exact against the shipped build on all
      six recorded scenarios (one fire, re-measured: `hello` 19/19, `microtest_voff` 225/225,
      `microtest_von` 225/225, `minitest_voff` 1369/1369, `minitest_von` 1308/1308,
      `minitest_adami` 1373/1373 — every one `differing=0 missing=0 extra=0`, `ignored=1` =
      `run/movie.pmv`), and the contraction is *transcribed*, not tolerated: lane L8's function is
      3022/3022 bit-exact through `f32Fma` at the disassembled `fmadd`/`fmsub` sites. A re-record
      would rebuild a solved problem instead of using it.
    - **It contradicts the standing oracle rule.** The native tree is read-only — only the
      `run.previous.*` isolation the harness already does — and re-pinning `etc/bld/Makefile.conf`
      and rebuilding it would modify it.
    - **It would void the transcription corpus.** The float-contraction rule, the libm census
      (`exp`/`log`/`sin`/`cos`/`pow`), `sinf`/`cosf`/`sincosf`, `atan2f` and the `.gz` deflate
      transcription all exist *because* the shipped build is the oracle: the goldens they were
      diffed against are what makes each of them correct.
    - **No consumer exists for the property.** Source-text-vs-binary agreement is a build-pipeline
      property; the contract `PORT_SPEC.md` names is `python3 tools/check_parity.py --golden
      oracle/<scenario> --candidate <tree>` exiting 0, and it does.

    Reopen only in the form item 8 leaves open — if cross-platform goldens are ever wanted. The
    reproduction still needs no native rebuild: `native/vectors/collision.json` carries the cases
    and lane L8's `native/agentprobe.*` regenerates them.

12. ~~**(L12 → L5) `SeparationCache` iteration order.** Native stores each agent's separation
   entries in a `std::map<long,float>` (ascending other-agent number) and `Logs::SeparationLog`
   writes rows in that order; lane L5's `separationCache` uses a `Map` (insertion order). The log
   lane sorts at its call site (`l12/separation-table-name`), which is why the 86 recorded tables
   reproduce byte-for-byte, but any *other* consumer of `SeparationCache::getEntries` that prints
   must do the same. Is the sort the right place, or should L5's cache return a sorted view?~~
   **CLOSED (orchestrator, 2026-09-29) — the sort stays at the call site.** The class' native
   iteration order is `std::map<long,float>` (ascending other-agent number) and L5's `Map` is
   insertion-ordered, but the *contract* is the recorded artifact, and every printing consumer is
   L12's `SeparationLog`, which sorts (`l12/separation-table-name`) — and it works: the
   `run/genome/separations.txt` that carries those tables is byte-exact in every scenario this
   fire re-ran, measured by the parity tool itself (`grep -c '^#'` on the goldens: 609 tables in
   `minitest_voff`, 581 in `minitest_von`, 175 in `microtest_voff`, all inside `PASS` trees —
   `minitest_von` 1308/1308 above). Changing L5's return to a sorted view would touch a lane that
   is green to satisfy no measured consumer. **Reopen if a second consumer of `getEntries` ever
   prints** — then the sort belongs in the cache, not at the call site.
13. ~~**(L12 → L11) `FittestList::size()` naming.** The sim lane's `FittestList` keeps a private
   `size` field and exposes `getSize()`; the log seam takes that spelling
   (`l12/fittest-size-spelling`) rather than forcing a rename. If the sim lane renames the field,
   the seam should go back to native's `size()`.~~
   **CLOSED (orchestrator, 2026-09-29) — keep the seam's spelling.** L11's private field is `size`
   with `getSize()`, native's accessor is `size()`; the rename is byte-neutral (the value is what
   the log seam reads, and it is right — `run/genome/**` is byte-exact in every scenario this fire
   re-ran, `minitest_adami` (1373/1373) included), so renaming the field and the seam is churn
   with no measurement behind it. The existing `l12/fittest-size-spelling` PORT-NOTE stays as the
   record; the "open question" framing is dropped.

## Dependency proposals

| Package | Version | Lane | Justification | Decision |
|---|---|---|---|---|
| *(none)* | — | W1f | the harness uses bash + python3 stdlib only (`argparse json hashlib shutil subprocess pathlib fcntl`); no npm package, no pip install | accepted as-is, nothing to add |
| `@types/three` | ^0.169.0 (dev) | W1g | `three@0.169` ships **no** type declarations (its package.json has no `types` field), so `npm run typecheck` (`tsc --noEmit`, a lane gate) cannot resolve `import … from 'three'` / `'three/addons/…'`. Type-only: emits nothing, adds no runtime code, and is the DefinitelyTyped package for a dependency the project already has. | accepted — no runtime surface changed |
| `vite` + `vitest` | `^8.3.1` + `^5.0.2` (dev) | scaffold (t_56497ea4) | the pinned `vite ^5.4.0` / `vitest ^2.1.0` carried 5 advisory-listed vulnerabilities (1 critical); only the current majors clear all of them — `vite 7 + vitest 3` was measured and still leaves 2. Dev-only: `vite`/`vitest` are never bundled into `dist/` and add no runtime code. | accepted — `npm audit` now 0, gates re-verified (see *Toolchain*) |
| *(none — built-ins only)* | `node:zlib`, `node:fs`, `node:path` | W1c | the compression backend native gets from `-lz`/`gzopen` comes from `node:zlib` (built into Node, not an install) and the plain/gzip file sinks from `node:fs`; the format modules (`writer`/`reader`/`printf`/`sink`) import neither, so the browser bundle is unaffected | accepted as-is, nothing to install |
| *(none)* | — | W1e | the port adds no package: the geometry modules are pure TypeScript over the frozen types, and the golden probe is a *generator* (clang++ + python3 stdlib) that links the already-built `libpolyworld.dylib` and the system OpenGL/GLU framework. Nothing in `native/` ships in the bundle; `npm ls --prod` is unchanged | accepted as-is, nothing to install |
| *(none)* | — | W1d | no package added: the PRNGs, the transcribed libm `log` and the fixture generators are pure TypeScript plus python3 stdlib + clang (for the oracle probes). The MT19937 tables and the libm `log` table are committed data extracted from the oracle, not a dependency; nothing in `src/model/rng/native/` ships in the bundle | accepted as-is, nothing to install |
| *(none)* | — | W1h | no package added: the extractor/verifier are python3 stdlib only (`argparse json hashlib re difflib subprocess tempfile shutil`), the browser side is plain ESM on `node:fs`/`node:url`/`node:path` built-ins, and the `cppprops.json` spec plus the fixture traces are committed data. Nothing under `tools/cppprops/**` ships in the bundle: the browser imports only `lib/cppprops.mjs` | accepted as-is, nothing to install |

## Cutover

- [x] Tier A scenarios green in the browser (byte-exact) — **measured (orchestrator, 2026-09-29)
  from the running page's own tree** — not from a fixture and not from the node runner. Headless
  Chrome (`--headless=new`, CDP 9444) against the dev server (5173):
  `node src/browser/verify/demoEvidence.mjs 'http://localhost:5173/?scenario=minitest_voff' --export .candidate/page-1790664176-minitest_voff/tree`,
  then `./oracle/run_parity.sh minitest_voff --candidate .candidate/page-1790664176-minitest_voff/tree`
  → `match 1368/1369  differing=0  missing=0  extra=0  ignored=1`, `content-compared 1167
  file(s) [run/**/*.gz]: payload identical 1167 (container byte-identical 1167, container
  differs 0)`, **`parity: PASS (1369/1369 files)`** (`ignored=1` = `run/movie.pmv`). The page's
  own report (`report.json`, same dir): `flavour: "model"`, `scenario: minitest_voff`, seed 42,
  `maxSteps 301`, **`ended: true` at `stepIndex 301`**, `WebGL 2.0 (OpenGL ES 3.0 Chromium)` with
  `drawCalls 7 / triangles 302`, **0 console errors, 0 warnings**, 283 first-load requests all
  same-origin (`Document 2, Script 278, Stylesheet 2, Other 1` — the dev server's module graph;
  nothing compiles in the page), export `1368 files / 10,111,418 bytes`. Controls: pause froze
  (55→55), step +1, speed 8× honoured, play advanced (56→152). **All three Tier-A scenarios are
  byte-exact from the page's own exported tree** (orchestrator, 2026-09-29 04:2x,
  `.candidate/pagesup/<scenario>/tree` with `report.json` beside each), each measured with the
  same pair — `CDP_PORT=9444 node src/browser/verify/demoEvidence.mjs
  'http://localhost:5173/?scenario=<scenario>' --export .candidate/pagesup/<scenario>/tree --json
  .candidate/pagesup/<scenario>/report.json`, then `./oracle/run_parity.sh <scenario> --candidate
  .candidate/pagesup/<scenario>/tree`; the trees are still on disk, so the second command alone
  reproduces each verdict with no browser: `hello` — `./oracle/run_parity.sh hello --candidate
  .candidate/pagesup/hello/tree` → **`parity: PASS (19/19 files)`**, `differing=0  missing=0
  extra=0  ignored=1` (`run/movie.pmv`), no `.gz` container in this tree (0 content-compared),
  export `18 files` (`runFiles 17` at end); page report `flavour "model"`, **`ended: true` at `stepIndex
  500`** (`maxSteps 500`), 105 agents, `WebGL 2.0 (OpenGL ES 3.0 Chromium)`, `drawCalls 7 /
  triangles 1478`, **0 errors / 0 warnings / 0 off-origin requests**. `microtest_voff` —
  `./oracle/run_parity.sh microtest_voff --candidate .candidate/pagesup/microtest_voff/tree` →
  **`parity: PASS (225/225 files)`**, `differing=0  missing=0  extra=0  ignored=1`
  (`run/movie.pmv`), `.gz` containers `payload identical 150 (container byte-identical 150,
  container differs 0)`, export `224 files` (`runFiles 223` at end); page report `flavour "model"`,
  **`ended: true` at `stepIndex 1`** (`maxSteps 1`), 25 agents, `WebGL 2.0 (OpenGL ES 3.0
  Chromium)`, `drawCalls 7 / triangles 358`, **0 errors / 0 warnings / 0 off-origin requests**.
  `minitest_voff` — `./oracle/run_parity.sh minitest_voff --candidate
  .candidate/pagesup/minitest_voff/tree` → **`parity: PASS (1369/1369 files)`**, `differing=0
  missing=0  extra=0  ignored=1` (`run/movie.pmv`), `.gz` containers `payload identical 1167
  (container byte-identical 1167, container differs 0)`, export `1368 files` (`runFiles 1367` at
  end); page report `flavour "model"`, **`ended: true` at `stepIndex 301`** (`maxSteps 301`), 23 agents
  living of 32 capacity, `WebGL 2.0 (OpenGL ES 3.0 Chromium)`, `drawCalls 7 / triangles 330`,
  **0 errors / 0 warnings / 0 off-origin requests**. Goldens re-verified after all three page
  runs: **4519/4519 OK, 0 FAILED** across all six `oracle/<scenario>/run/manifest.sha256` — the
  page wrote no golden byte.
- [x] Tier B scenarios within the statistical envelope — **measured (orchestrator, 2026-09-29),
  and satisfied by a strictly stronger result: both Tier B scenarios are byte-exact.**
  `./oracle/run_parity.sh list` calls `minitest_von` and `microtest_von` `tier=B`; this fire's
  fresh end-to-end node runs (`npx tsx src/model/sim/runner.ts <scenario>
  .candidate/sup1790664057-<scenario>`) gave, all six scenarios, `runner exit=0` and
  `parity: PASS (225/225)` `microtest_voff` · `PASS (1369/1369)` `minitest_voff` · `PASS
  (225/225)` `microtest_von` · `PASS (1308/1308)` `minitest_von` · `PASS (19/19)` `hello` ·
  `PASS (1373/1373)` `minitest_adami`, every one with `differing=0 missing=0 extra=0` and every
  `.gz` container byte-identical (150 · 1167 · 150 · 1114 · 0 · 1167). Goldens re-verified
  immediately after: **4519/4519 OK, 0 FAILED** across all six `run/manifest.sha256` files — the
  e2e pass wrote no golden byte.
- [x] Native tree kept: it remains the definition of correct — **the recorded decision, not a
  measurement (orchestrator, 2026-09-29).** Every number in this file is a native-vs-port
  comparison: `oracle/<scenario>/run/**` is recorded from the native tree (reached through
  `POLYWORLD_NATIVE`, never deleted — its `run/` is moved aside, see *Lane harness*) and the port
  is measured *against* those bytes. Ticked as the decision it is.

## PORT-NOTEs (W1j/L16 vision raster) and lane evidence

Lane scope: `src/model/vision/**` — replaces the native fixed-function GL retina path
(`QtAgentPovRenderer` + one synchronous `glReadPixels` per agent) with a batched WebGL2 atlas.
The lane's spec is `docs/specs/vision-spec.md` (lane W1j); the acceptance is PARITY.md's vision
finding: with vision on the native model is reproducible, so the **model logs** must stay
byte-exact while the retina *pixels* are a debugging aid.

PORT_SPEC rule 6 audit: **35** `PORT-NOTE(vision/…)` ids exist in `src/model/vision/**` +
`tests/vision*.ts`, and the rows below index all of them (the review's *27 ids / 22 rows*
predates the real-context probe's five rows, `t_83dc2e2c`'s six and `t_717e215e`'s six; the
L15/L16 ownership collapse `t_1feec49a` removed the six matrix ids that moved to
`src/model/geometry/matrix.ts` and added `vision/gl-matrix-adapter` +
`vision/rotatef-axis-only`). Re-check the code side with
`grep -rho 'PORT-NOTE(vision/[a-zA-Z0-9-]*' src/model/vision tests/vision*.ts | sed 's/PORT-NOTE(//' | sort -u`
and compare it with the table's first column.

| PORT-NOTE | File | Decision |
|---|---|---|
| `vision/encoder-float-discipline` | `vision/encoder.ts` | every native `float` store is `Math.fround`, the final division stays f64, and `Retina.cc:225` is a *single* rounding (PN-V6/V7) |
| `vision/encoder-carry-double` | `vision/encoder.ts` | `Retina.cc:234`'s `1.0` is a C++ **double** literal, so the carry is `f32((1.0 - t) * b)` — not the two-store form the spec's §11.5 listing shows |
| `vision/encoder-geometry` | `vision/encoder.ts` | `xwidth` = f32 quotient, `xintwidth` = exact-division flag (`Retina.cc:170-176`); both branches are exercised by the oracle (measured: counts 1/2/3/9/10/11/12/14/22 on real rows) |
| `vision/encoder-pnv8` | `vision/encoder.ts` | more neurons than pixels (native reads adjacent heap) throws `VisionError` instead of emulating garbage |
| `vision/retina-owns-the-buffer` | `vision/retina.ts` | the retina is fed a *row slice* of the atlas readback instead of owning the `glReadPixels` target; the bytes are identical |
| `vision/atlas-packing` | `vision/atlas.ts` | the native packing expression reproduced literally (`(int)(sqrt((float)(M*a)) + n - 1) / n`, double `sqrt`, truncate, then integer division) |
| `vision/atlas-slot-freedom` | `vision/atlas.ts` | batching may assign slots in any order (cells are disjoint; verified against the native slot set) |
| `vision/atlas-batched-readback` | `vision/atlas.ts`, `vision/raster.ts` | one `readPixels(0,0,W,H)` per step, rows sliced arithmetically, replacing N per-agent synchronous readbacks |
| `vision/gl-matrix-f32` | `vision/matrix.ts` | the lane's entry points are typed `Float32Array` (what a WebGL2 uniform upload wants); that is a *storage* choice — the **values** are L15's, see the next row |
| `vision/gl-matrix-adapter` | `vision/matrix.ts` | this file computes **no** matrix arithmetic: every function converts to/from `src/model/geometry/matrix.ts`'s `number[]`, which is the single definition. The copy of the fixed-function maths it used to carry is gone (PARITY.md *Open questions* 6); the conversion only copies, and every value geometry hands over is already an f32 |
| `vision/rotatef-axis-only` | `vision/matrix.ts` | `glRotatef` is only defined for the three axis rotations the model uses (`gcamera::Use`, `gobject::rotate`, the object poses); any other axis vector is **refused loudly** rather than silently forking the maths |
| `vision/pitch-yaw-residual` | `tests/vision-camera.test.ts` | a camera with **both** vision pitch and yaw enabled leaves ≤1 ulp in two modelview translation entries and a sign-flipped ~1.3e-8 residual entry; the oracle disables both, and every such configuration is bit-exact |
| `vision/camera-scope` | `vision/camera.ts` | **closed by `t_1feec49a`**: `gcamera` is lane L15's and this module now *builds* it (`visionCamera()` configures `geometry/camera.ts`'s `Camera` and converts the matrices to f32). This lane owns the vision *configuration*, not the camera maths |
| `vision/camera-at-nose` | `vision/camera.ts` | the eye sits exactly at the nose plane (PN-V11), so an agent never sees its own body |
| `vision/raster-triangulate` | `vision/raster.ts` | GL_POLYGON has no WebGL2 equivalent; the model's convex polygon soup is drawn as triangles |
| `vision/raster-single-attachment` | `vision/raster.ts` | RGBA8 colour + `DEPTH_COMPONENT24`, no stencil (nothing in `graphics/**` writes stencil), single-sample (native requests no MSAA) |
| `vision/native-dump-internal-calls` | `native/retinadump.cpp` | only calls that leave libpolyworld can be interposed: `Retina::updateBuffer` + `AgentAttachedData::get` work, `agent::UpdateVision`/`TSimulation::Step` do not (measured: 0 hits vs 25 per step) |
| `vision/native-dump-self-interposition` | `native/retinadump.cpp` | `dlsym` cannot be used to call an interposed original (dyld rewrites dlsym results too — it returned the shim's own replacement); the original address is read out of `LC_SYMTAB` |
| `vision/encoder-no-clamp` | `tests/vision-encoder.test.ts` | a 255-byte row can land one f32 ulp above 1 in the native accumulator; the port keeps the native behaviour (no clamp) |
| `vision/probe-identity-matrices` | `native/atlas-probe.ts` | the real-context fixture draws with **identity** projection/view/model, so a quad in `[-1,1]²` covers its viewport exactly and the only arithmetic between a slot's colour and its readback byte is the atlas addressing under test; the per-agent camera path is pinned separately (`tests/vision-camera.test.ts` vs native `glGetFloatv`), and mixing the two would make a mismatch ambiguous |
| `vision/probe-row-ladder` | `native/atlas-probe.ts` | each slot is filled with a ladder of `retinaHeight` one-pixel stripes, not one flat quad, because the sampled row is the one thing this probe exists to check: a flat colour cannot reveal *which* row was read, and an upper-left readback origin would sample stripe `H-1-11 = 10` instead of 11 — measured, stripe 11 |
| `vision/probe-quantization-offset` | `native/atlas-probe.ts` | every stripe's blue channel is fed as `(b8 + 0.6)/255` (`b8` an integer), so the expected byte is `b8 + 1`: the assertion discriminates `round(255·c)` from `trunc(255·c)`, which is what "the framebuffer quantizes on write" means. The 0.6 offset is far outside any `mediump`/f16 error in the varying (≈0.1 in these units) |
| `vision/probe-swiftshader` | `native/atlas-browser-check.mjs` | the probe accepts a software renderer (ANGLE/SwiftShader) as a witness and always records the unmasked renderer string, because the claims it asserts are spec-defined — RGBA8 quantization on write, `readPixels`' lower-left origin in WebGL2, `GL_LESS` on an exact depth tie — not vendor behaviour. `--require-gpu` turns a software renderer into a failure for a run that wants a hardware witness (this machine: ANGLE/Metal, Apple M3 Ultra) |
| `vision/raster-gl-state-armed-once` | `vision/raster.ts` `beginStep()`, `native/atlas-probe.ts`, `native/atlas-browser-check.mjs` | the id names **native's** arming, not the port's: `QtAgentPovRenderer::beginStep:111-123` armed `DEPTH_TEST`/`GL_LESS`/no-blend/no-cull **once** (`stepBegun`) because the renderer owned a private `QOpenGLContext` (`PwOffscreenGLSurface.cc:19-28`) and nothing else could change that state. The port's context is the shell's (Three.js draws in it), so a one-shot arming would make the raster's output a function of whatever the shell last left behind — different atlas pixels, therefore different nerve values, and no gate in the lane would see it. **Decision of record (`t_3dcd248c`, supervisor 2026-09-29): the port re-arms all four in *every* `beginStep()`** — four calls per step — instead of requiring a dedicated context per raster, which a browser cannot afford (a WebGL2 context is a scarce resource). The caller contract is therefore "bind the atlas; the raster owns those four state calls from there". Measured on a real context (check `gl-state-re-armed-every-step`): with the caller leaving `DEPTH_TEST` off, `BLEND` on, `depthFunc GREATER` and front-face culling on between steps, the next step is **byte-identical** to step 1 (0 of 69 120 bytes differ; slot 7 keeps the ladder's 8,11,84) and the context is left armed (`DEPTH_TEST` on, `BLEND` off, `CULL_FACE` off, `LESS`). The check keeps its teeth: on the *same* fixture with the re-arm swallowed, the equal-depth quad wins slot 7 (200,100,50, 1452 bytes differ) and, with the cull half swallowed, the atlas is culled away (0 of 17 280 pixels non-black) |
| `vision/atlas-zero-cols` | `vision/atlas.ts:83` | a packing result of `ncols == 0` is **refused** (`VisionError`) instead of reproducing native's division by `ncols`, which is UB there; no `maxAgents` the oracle uses reaches it |
| `vision/camera-order` | `vision/camera.ts:141` | `UpdateVision` re-derives the aspect every step *after* focus and *before* pitch/yaw (`agent.cc:1070-1087`); the order is kept because the same float expression re-associated is not the same f32 |
| `vision/encoder-integer-branch` | `vision/encoder.ts:133` | in the integer branch (`xintwidth != 0`) `avgcolor` is reset **for every neuron** and accumulated as a plain f32 sum — unlike the fractional branch's carry (PN-V5) |
| `vision/encoder-f32-accumulation` | `tests/vision-encoder.test.ts:174` | the accumulator is a C `float` (`Retina.cc:187`, `:206`), so a uniform row of `b` bytes is `f32(b) / f32(xwidth*255)`, not `b/255`: visible in the sixth printed digit for some bytes (`b = 2` prints `0.00784313` where `b/255` prints `0.00784314`) |
| `vision/matrix-scope` | — | **retired by `t_1feec49a`** (the L15/L16 ownership collapse): the modelview/projection maths is L15's single definition (`W1e/compose-rounding`, `W1e/glu-perspective-reciprocal`), `vision/matrix.ts` is a storage adapter, and `vision/camera.ts` builds L15's `gcamera`. The id no longer exists in the tree |
| `vision/raster-no-fog-no-lighting` | `vision/raster.ts:47` | the fragment shader is flat colour: **no fog** (native enables `GL_FOG` only when `FogFunction != 'O'` — `agent.cc:1030-1031` → `gcamera.cc:331-363`) and no light model. A fogged world would diverge silently in the fed neurons; all four recorded worldfiles say `FogFunction O` (`normalized.wf:219`), so nothing frozen is affected. Lighting cannot diverge: no light model exists anywhere in the tree (`gstage::SetLightModel`/`SetLightList`, `gscene::SetDrawLights` have **no** call site, and no `glEnable(GL_LIGHTING)` is on this path), so native's `GL_NORMALIZE` (`QtAgentPovRenderer.cc:117`) is inert and the port rightly omits it. Gaps row below |
| `vision/camera-precomputed-inputs` | `vision/camera.ts` | the node POV scanner reaches the agent through its public surface and is handed the **already-derived** camera numbers (`fovx`/`aspect`/`pitch`/`yaw`/`localPosition`), because `agent::UpdateVision` computes `fovx` **once** (`agent.cc:1070`) and hands *that* float to `SetAspect`; re-deriving it from the focus nerve would be a second rounding of the same expression. The camera side of that contract is now L15's (`W1e/agent-pov-precomputed-inputs`) |
| `vision/pov-scan-not-a-rasterizer` | `vision/povScan.ts` | `PovScanRenderer` is **not** a substitute for the batched WebGL2 atlas: the parity path is a headless node process with no GL, and the frozen artifact is the fed neuron value, so the scanner answers the *same question* the driver did (which polygon covers each pixel centre of the one read row) rather than approximating the pipeline. The browser keeps the real atlas |
| `vision/pov-scan-scene-order` | `vision/povScan.ts` | the snapshot is taken in `beginStep()` — native's `fStage.Compile()` point (`Simulation.cc:1407`, before the vision loop; `gstage::Compile` bakes a display list via `Draw()`) — and drawn in `gstage::Draw()`'s list order, the set list first and then the cast list (`gstage.cc:168-176`). Each agent's mesh comes from its **own** `fPolygon` (`bodyGeometry()`), not from the run-wide `deps.geometry` |
| `vision/pov-scan-not-a-rays` | `vision/povScan.ts` | the earlier f64 **ray cast** (a ray through each pixel centre vs the world polygons) was replaced by `povRaster.ts`: it reproduces native's *rasterization*, and a ray cast is only the same arithmetic in the limit. Measured at `minitest_von` step 12 (agent 23, pixel 13), where a silhouette lands 0.00145 px from the pixel centre: the ray cast answered `000000ff`, native's framebuffer says `594026ff`, and the whole chaotic run followed that one pixel. `tests/vision-pov-scan.test.ts` pins both halves of the mechanism |
| `vision/raster-subpixel-grid` | `vision/povRaster.ts` | the driver's sub-pixel grid is a **parameter**, because it is a property of the driver: window coordinates are snapped `round(x·2^n)/2^n` after the viewport transform (only the viewport's *size* enters — an integer origin is invariant under the snap). Measured against the 7315-row `minitest_von` dump, first differing row with everything else fixed: `null` → step 12, 4 bits → step 1, 8 bits → step 71, 12 → step 12, 16 → step 12; so `SUB_PIXEL_BITS = 8` (1/256 px). Fill rule: edge functions at the pixel centres, ties kept only on a *top* or *left* edge (`topLeftFill`), which is what puts native and the scanner on the same side of the step-12 margin. Depth: screen-space-interpolated `z/w` → 24-bit fixed point, `GL_LESS`, so a tie loses to the earlier draw |
| `vision/raster-precision` | `vision/povRaster.ts` | the vertex transform is binary64 from the f32 matrices and the f32 world vertices, with the clip result rounded to f32 once, and the near/far clip is Sutherland–Hodgman in clip space (`-w ≤ z ≤ w`). That is within ~1e-6 pixel of any f32 accumulation order a driver could have used — three orders of magnitude below the 0.00145-px margin this module exists to resolve, so the *grid*, not the arithmetic, is what decides such a margin. (The side planes need no clip: a pixel centre inside the viewport maps to a ray inside the frustum.) |

### Evidence (this lane's acceptance numbers)

The unusual thing about this lane is that its acceptance surface is not a picture but
`3 × numneurons` doubles per agent per step, and the goldens only keep them after `%g`
(6 significant digits). So the lane does not stop at "the spec says so": it dumps the **native
retina bytes** and holds the port's encoder to the recorded values.

| Check | Command | Result |
|---|---|---|
| Native retina bytes for the whole run | `src/model/vision/native/retinadump.sh --scenario minitest_von --out <dump>` | 7315 rows (25 agents × up to 301 steps, 83 agents born during the run), 0 rows unattributed |
| Encoder vs the recorded model, on those bytes | `npx vitest run tests/vision-native-rows.test.ts` | **6/6** — 83 agents, 7315 rows, **191 660 nerve values** reproduced exactly (`mismatch === null`) |
| Atlas slots the native renderer handed out | same test | the observed set is exactly `atlasLayout(25, 22, 22)`'s 25 viewports (240×72, `y + 11` row) |
| Encoder vs the spec's fingerprint + regression vectors | `npx vitest run tests/vision-encoder.test.ts` | **11/11** — corpus fingerprint recomputed from `brainFunction_10` (185 steps, 4995 samples, 112 distinct, 3717 zeros, 27 uniform-barrier steps, `0.349019` absent), and the 27 uniform-barrier steps reproduced as printed strings |
| Vision camera + GL matrices vs native `glGetFloatv` | `npx vitest run tests/vision-camera.test.ts` | **18/18** bit-exact (18 rotatematrices, 7 gluPerspective matrices, 4 object poses, 6 agent fixtures × projection+modelview), one documented pitch+yaw residual |
| Batched atlas: no per-agent readback | `npx vitest run tests/vision-raster.test.ts` | **8/8** — 4 steps × 25 agents ⇒ **4** `readPixels` calls (native: 100), each `(0,0,240,72)`, rows sliced at the native offsets; the re-arming contract on the double (the 4 state calls, in order, on each of 3 `beginStep`s — the first-step-only arming this replaced emitted them once); plus the real-context probe below |
| Real WebGL2 context: the atlas, rasterized | `node src/model/vision/native/atlas-browser-check.mjs` (headless Chrome over CDP, driven from node; `tests/vision-raster.test.ts` runs it with `--json` and skips when Chrome is absent) | **16/16 checks, 0 failures**, ANGLE/Metal (Apple M3 Ultra) via Chrome 154 (re-measured 2026-09-29, `--iterations=20`): 240×72 / 25 viewports, sampling rows `59/35/11 = y + 11`; **1** `readPixels` for 25 rendered agents, rect exactly `(0,0,240,72)`, 25 `viewport` calls in slot order; the batched readback equals a per-viewport `readPixels` of the same rect for **12 100/12 100** pixels (484 per slot); **528/528** sampled blue bytes are `round(255·c)` and **0** are `trunc(255·c)`; a draw-free step is entirely `(0,0,0,255)` while the drawn step left 12 100 non-black pixels; depth tie: the equal-depth quad drawn *after* the ladder loses (slot 7 keeps `8,11,84`), the nearer quad wins (slot 8 → `10,220,130`); **GL state re-armed on every step**: with the caller leaving `DEPTH_TEST` off / `BLEND` on / `depthFunc GREATER` / front-face culling on between steps, the next step is byte-identical to step 1 (**0/69 120** bytes differ) and the context is left armed — while the *same* fixture with the re-arm swallowed flips the tie (slot 7 → `200,100,50`, 1452 bytes differ) and with the cull half swallowed is culled away (0/17 280 non-black pixels); a later step from that left-flipped context reproduces all 69 120 bytes of step 1 |
| Real-context cost of the two paths, same 25 draws | same probe, `--iterations=40` | batched **0.5 ms/step** (median; mean 0.52, p95 0.70, **1** readback of 69 120 bytes) vs native's per-agent shape **11.3 ms/step** (median; mean 11.25, p95 11.8, **25** readbacks of 48 400 bytes): **~22×** the per-step wall time at 25 agents, all of it pipeline stall (`clear`+one readback alone is 0.5 ms). Repeat runs put the per-agent path at 8.3–11.3 ms (two probes at once), i.e. **16–22×**, so read the ratio and not the absolute milliseconds. Native reference (PORT_PLAN.md fact 6): ~15 ms/step at 25 agents, 64 % of wall in readback at 192 |
| Rasterization rules + the two invariants that decided a run | `npx vitest run tests/vision-pov-scan.test.ts` | **7/7** — the 0.00145-px knife edge (`minitest_von` step 12) reproduced from a synthetic scene: unsnapped it is *outside* the wall, on the 8-bit grid it lands on the wall's left edge and the fill rule keeps it; the mirrored case shows the rule (not the snap) is what decides; depth ties lose to the earlier draw and to the nearer one; near/far clipping and degenerate triangles; plus `SUB_PIXEL_BITS = 8` and "each agent is drawn from its own mesh" |
| The scanner's rows, end to end | `./oracle/run_parity.sh minitest_von --candidate <tree the runner wrote>` | **PASS 1308/1308, `differing=0 missing=0 extra=0`** (`run/movie.pmv` ignored), **1114/1114** `.gz` containers byte-identical. The 7315-row native dump (`src/model/vision/golden/minitest_von.retina.jsonl.gz`) is what localised the two defects: the first differing pixel was step 12 / agent 23 / px 13 (the grid), and once that was fixed the first differing row was step 71 — the step the recorded `BirthsDeaths.log` logs `70 BIRTH 31` (the shared body mesh). Both are now closed; with the grid alone the run is 230/1308 |
| Lane totals | `npx vitest run tests/vision-{camera,encoder,raster,native-rows,pov-scan}.test.ts` | **50/50**, and `npx tsc --noEmit` reports 0 errors in `src/model/vision/**` |

Reproduce the dump: `src/model/vision/native/retinadump.sh --scenario minitest_von --out /tmp/minitest.jsonl`
then `python3 src/model/vision/native/dump_retina.py --out /tmp/minitest.jsonl --to-golden src/model/vision/golden --scenario minitest_von`.
The shim only *reads* the native tree (headers + `libpolyworld.dylib`) and inserts at run time;
the native binary's own `run/` output is displaced first, exactly as `tools/record_oracle.py`
does. `oracle/**` is never written.

### Gaps (L16 — this lane's own; the shared *Gaps* table is the orchestrator's)

| What | Why it matters | Owner / how it closes |
|---|---|---|
| **The raster has no fog.** `vision/raster.ts`'s fragment shader is flat colour (PORT-NOTE `vision/raster-no-fog-no-lighting`). | Native enables `GL_FOG` whenever the worldfile asks for it (`FogFunction != 'O'` → `agent.cc:1030-1031` → `gcamera::SetFog`, `gcamera.cc:331-363`; fog colour = the clear colour, `GL_FOG_START = fNear`). A fogged world therefore diverges **silently**: the atlas pixels differ, so the nerve values the encoder feeds the brain differ, and nothing in this lane's gates would notice — all four recorded worldfiles say `FogFunction O` (`normalized.wf:219`), which is exactly why the gap is invisible today. Not a lighting gap: native has no light model anywhere in the tree, so the port's "no lighting" is exact (row above). | This lane, when a scenario uses fog: add the fog term to the shader and a fog field to `VisionRasterOptions`. The parameters are already ported and reach the caller (`src/model/geometry/camera.ts` `setFog`, PORT-NOTE `W1e/fog-data-only`; `src/model/sim/simulation.ts` `glFogFunction`) — no other lane has to move first. |

### Findings worth the orchestrator's attention

1. **The L16 row in *Deviations* is stale** (the same correction `docs/specs/vision-spec.md` §12
   proposes): it reads *"native vision is not reproducible run-to-run; matching it bit-for-bit is
   impossible"*. Measured, twice: two native runs with vision on differ in **no model artifact at
   all** except `run/energy/agents/max.txt`, whose `AgentGrown` row *order* is native's
   thread-completion order under `ParallelInitAgents True`; `run/movie.pmv` is ignored at every
   tier, so it can never be the file named after `DIFFERS`. (This row was rewritten with that
   measurement by `t_934a16d3` — *Deviations*, `L16 vision raster`.) Proposed wording: *"per-agent
   synchronous `glReadPixels` (64 % of wall at 192 agents) | batched single readback + CPU
   encoder with f32/f64 discipline | identical fed values, ~N× fewer pipeline stalls; retina
   pixels are a debugging aid, the neurons are the contract."*
2. **`%g` *is* ported and shipping — the first half of this item was stale.** `run/brain/function/**`
   is written with `%d %g` (`BaseNeuronModel.h:242-248`), and the port's `writeFunctional`
   (`src/model/brain/core/baseNeuronModel.ts` — `file.printf( '%d %g\n', i, … )`) emits it through
   native's format-plus-values shape, which lane L12's sink applies with lane L6's pinned
   `sprintfC` (`src/model/brain/core/cformat.ts`, `case 'g'`; `src/model/logs/formatSink.ts`,
   PORT-NOTE `l12/text-sink-format`). The text really is reproduced byte-for-byte: measured by
   re-running this tree's own runner (`npx tsx src/model/sim/runner.ts <scenario> <dir>`, then
   `./oracle/run_parity.sh <scenario> --candidate <dir>`, HEAD `71babe1`), every
   `run/brain/function/**` container is byte-identical to its golden — 25/25 `microtest_voff`,
   87/87 `minitest_voff`, 25/25 `microtest_von`, 83/83 `minitest_von`, 87/87 `minitest_adami`
   (`hello` records no functional log) — inside whole-tree **PASSes**: 225/225 · 1369/1369 ·
   225/225 · 1308/1308 · 1373/1373, every one `differing=0 missing=0 extra=0`, and every `.gz`
   container byte-identical (150 · 1167 · 150 · 1114 · 1167; `hello` 19/19 with 0 `.gz`). What is
   still true from the original item: `src/model/datalib/printf.ts` refuses `%g` as a *column*
   format (no native datalib column uses it; PORT-NOTE `w1c/printf-float`), and this lane carries
   its own test-side formatter (`tests/visionGolden.ts`) pinned against the golden's own values.
   The shipping `%g` is L12's sink over L6's `cformat` — not L7's, and not open work.
3. ~~**`gcamera` is implemented twice right now** (L15 owns it, this lane needed it to render).~~
   **RESOLVED by `t_1feec49a`** (the L15/L16 ownership collapse; the full measurement is in
   *Open questions* 6). `gcamera` is one object — L15's `Camera` — and this lane's `visionCamera()`
   configures it; `vision/matrix.ts` computes nothing and `vision/camera.ts` owns only the vision
   *configuration* (focus → FOV, the retinal aspect, which nerves drive pitch/yaw). All six
   recorded scenes are bit-exact on both matrices, the six recorded scenarios are byte-identical
   to the pre-collapse runs, and `tests/vision-camera.test.ts` pins the camera to L15's on 1,000
   random configurations so the fork cannot come back quietly.
4. ~~**The browser WebGL2 end-to-end check is not written yet**~~ — **written and measured**:
   `src/model/vision/native/atlas-browser-check.mjs` (+ `native/atlas-probe.ts`) rasterizes the
   240×72 atlas on a real WebGL2 context (headless Chrome 153, ANGLE/Metal on this machine) and
   asserts 16 checks; `tests/vision-raster.test.ts` runs it and skips when Chrome is absent, so
   the lane's raster claims no longer rest on the double alone. What the real context added over
   the recording double, in one line each: the sampled row really is the row at
   `viewport.y + 11` counted from GL's lower-left origin (12 100/12 100 pixels of all 25 slots
   agree with a per-viewport `readPixels`); the flat colour really lands as `round(255·c)`
   (528/528; `trunc` would give 0/528); depth ties really resolve by draw order (`GL_LESS`,
   8,11,84 kept against a later 200,100,50 quad at the same depth); and the batched path really
   is the cheap half (0.5 ms/step vs 11.3 ms/step for the same 25 draws with one readback per
   agent). Two defects in the *probe's own first draft* are worth recording because they are the
   classic ways this measurement lies: the checks initially read the raster's *live* `readback`
   (which the next step's clear had already wiped, so every row assertion compared black with
   black and the "step 4 == step 1" check passed vacuously), and the per-viewport readbacks hit
   the **default** framebuffer because `endStep()` unbinds the atlas FBO. Both are fixed, and the
   probe now carries negative controls (`nonBlack(...) > 0`) so an all-black atlas fails instead
   of passing.
5. ~~**The raster's one-time GL arming is a caller contract, not a local detail**~~ — **CLOSED by
   `t_3dcd248c`: the port re-arms the four state calls in *every* `beginStep()`** (PORT-NOTE
   `vision/raster-gl-state-armed-once`, check `gl-state-re-armed-every-step`). The question above
   was "dedicated context per raster, or re-arm every step?" — **the supervisor's decision of
   record (2026-09-29) is: re-arm.** Native could arm once because the arming lived inside a
   private `QOpenGLContext` (`PwOffscreenGLSurface`), so nobody else could change that state; in
   the browser the context is the shell's (Three.js draws in it), and a dedicated context per
   raster is a scarce resource, while the failure mode it would remove — the atlas drawn from
   whatever state the shell last left behind, therefore different nerve values, therefore a
   different model, with no lane gate able to see it — costs four calls per step to make
   impossible. Measured on a real context (Chrome 154, ANGLE/Metal): the caller leaves
   `DEPTH_TEST` off, `BLEND` on, `depthFunc GREATER` and front-face culling on, and the next step
   is **byte-identical to step 1 (0 of 69 120 bytes differ)**, with the context left armed
   (`DEPTH_TEST` on, `BLEND` off, `CULL_FACE` off, `LESS`). The assertion keeps its teeth: the
   old measurement *is* now the negative control inside it — on the same fixture (the equal-depth
   tie quad and the nearer quad are unchanged) with the re-arm's four calls swallowed, slot 7
   flips to `200,100,50` (1452 bytes differ), and with the cull half swallowed the atlas is culled
   away (0 of 17 280 pixels non-black). The node-side double pins the same contract without a
   browser (four calls, in order, on each of three steps). All six recorded scenarios stay
   byte-identical: `hello` 19/19, `microtest_voff`/`microtest_von` 225/225, `minitest_voff`
   1369/1369, `minitest_von` 1308/1308, `minitest_adami` 1373/1373 (`differing=0 missing=0
   extra=0` on each).
6. **`0.349019` vs `0.34902` is now a regression test on real pixels**, not just on a
   reconstructed row: `tests/vision-native-rows.test.ts` would catch a two-rounding encoder on
   191 660 native values.
7. **`minitest_von` closes (PASS 1308/1308), and it took a second mechanism outside this lane**
   (`t_717e215e`). With the window-space scanner in place the retina dump still diverged — first at
   **step 71**, the step the recorded `BirthsDeaths.log` logs `70 BIRTH 31` — because
   `TSimulation::deps()` caches **one** `createAgentDeps(...)` bundle for the whole run, so every
   agent shares one `deps.geometry`, and `agent::SetGeometry()` clones the template into it and
   scales it **in place**: the last agent to grow rescales every other agent's body mesh. Native
   keeps `agent::fPolygon` **per agent** (`agent.cc:1005-1011`). Measured: worker 31's
   `fLengthZ 1.389957` against the seeds' `1.254169` left the shared mesh 0.694979 deep, so an
   agent whose eye is at `-0.5*fLengthZ = -0.627084` had its own nose plane 0.0679 in front of it
   (native puts that plane *on* the eye, PN-V11) and its whole row became its own nose. The
   control experiment — the same run with each agent fed its **own** mesh, everything else
   unchanged — is **7315/7315 rows, first divergence none, all 301 steps**, which is what proved
   the rasterizer exact and the mesh the only other defect.
   The fix landed in `src/model/agent/agent.ts` (`Agent.fBodyMesh` + `bodyGeometry()`, cloned from
   `deps.bodyTemplate`, falling back to an injected `deps.geometry` stand-in so
   `tests/agent.test.ts`'s `setRadius` seam keeps pinning) plus the one line in `vision/povScan.ts`
   that prefers `bodyGeometry()`. **Flagged because it is outside L16's declared file set** and
   `sim/{bindings,agents}.ts` are held by another lane (`t_05b45824`): the alternative shape is one
   `createAgentDeps` bundle per agent in `sim/simulation.ts`'s `deps()`, which needs no L8 edit but
   re-creates the bundle's other members per agent. Whoever reviews the L8/L11 surface should
   confirm the agent-side form (or move it) — the *invariant* is what matters:
   `agent::draw`'s mesh is the agent's own.

## PORT-NOTEs (L10 environment)

`src/library/environment/**` ported to `src/model/environment/**` (plus the one `utils/` file the
environment cannot live without, `objectxsortedlist`), with the environment's slice of
`graphics/gobject`+`gbox` that L15 has not landed yet. Every semantic decision carries an
in-code `PORT-NOTE`; the tag and what it decides:

| PORT-NOTE | File | Decision |
|---|---|---|
| `L10/energy-temporary-home` | `energy.ts` | `Energy`/`EnergyPolarity`/`EnergyMultiplier` are **defined here** (native `environment/Energy.{h,cc}` belongs to this lane's directory). The body used to sit in `src/model/agent/energy.ts` because lane L8 carried it while this directory did not exist; `t_4e856769` moved it here whole — the file is no longer a re-export, and `agent/energy.ts` no longer exists. `MAX_ENERGY_TYPES`/`ENERGY_EPSILON` moved out of `agent/numeric.ts` with it. The Gaps row is closed |
| `L10/fma-contraction` | `barrier.ts`, `patch.ts`, `object.ts` | **the single most important finding of this lane.** The oracle binary's compiler contracts `a*b + c` into a fused multiply-add (`-ffp-contract=on`, arm64), so a native float chain that reads like two rounded operations is one rounded operation. Every `a*b + c` in the environment is written as `f32(a*b + c)` (the product is exact in f64 for `float` inputs), and `a*b - c*d` is written with the *second* product rounded and the first exact. **Measured** (re-measured in review round 1 by reverting each site alone and unioning the failures — the numbers in the round-1 handoff were an estimate): with the unfused forms **29** distinct pins miss — 21 from `barrier::updateVertices`' `c` (the 2 pins the derived `dist` also moves are a subset of those) and 8 from `Patch::initBase` (`centerX` 7, `centerZ` 1); with the fused forms, 0 of 1,909 pins miss. **This affects every lane** — L8's `agent::UpdateBody` barrier push, L11's step arithmetic and L12's float accumulators go through the same compiler |
| `L10/linsegment-narrows-on-store` | `barrier.ts` | native `LineSegment`'s members are `float`, so the worldfile assignment (`getPosition().xa = propBarrier.get("X1")`, a `double`) narrows. The port's accessors `f32` on every store; without it `0.3333` keeps its double and `xmin` moves one ulp |
| `L10/barrier-ratio-scaling` | `barrier.ts` | `gRatioPositions` scales the **absolute** copy inside `updateVertices`, per call; `currPosition` keeps the ratios. Both recorded worldfiles set it True, so the two barriers sit at `0.3333*WorldSize` / `0.6667*WorldSize` |
| `L10/barrier-degenerate-segment` | `barrier.ts` | the zero-length sentinel (`c = 1.0; f = 1.0e10`) is reproduced; the test is on `a`/`b` being exactly zero |
| `L10/barrier-construction-draws` | `barrier.ts` | `barrier()` runs `gpoly`/`gobject` first and `gobject::init()` spends **three `rand()`** on the default colour; `processWorldFile` constructs barriers before agents and food, so that is stream order |
| `L10/barrier-xsort-is-dead` | `barrier.ts` | `bxsortedlist::xsort()` can only run when `needXSort` is set, and `barrier::needXSort()` is a hard-coded `false` — `actuallyXSort` is unreachable. The port keeps the flag/guard and implements `xsort` as the equivalent stable order rather than porting `gdlist` link surgery for a dead branch; `add`'s insertion order (observable) is exact |
| `L10/barrier-gbarriers-is-append-only` | `barrier.ts` | `gBarriers` (creation order) is exposed alongside `gXSortedBarriers`; nothing reads it after `processWorldFile` |
| `L10/gobject-colour-draws` | `object.ts` | every `gobject` construction draws three `rand()` for `fColor` (`f32(rand()/32767.0)`) *before* the subclass sets its own colour. Dropping them (or merging them into `drand48`) changes the whole downstream draw order |
| `L10/gobject-base-is-a-lane-cut` | `object.ts` | this module is the environment's *slice* of `gobject`/`gbox`/`gboxf` (position, colour, type/number, carry state). L15 owns the real classes and the **radius rule**; `t_4e856769` resolved the duplication the way the Gaps row prescribes — one re-exports the other: the rule lives in `src/model/geometry/primitives.ts` (`scaledRadius`/`boxRadius`), `object.ts` imports `boxRadius` and re-exports it as `focusRadius`, and it carries no radius arithmetic of its own. Gaps row closed |
| `L10/gobject-rng-injection` | `object.ts` | native reaches the process-wide `rand()`; the port defaults to `globalRngSurface()` and lets a test inject a surface (same stream, same order) |
| `L10/patch-setpoint-draw-count` | `patch.ts` | the re-draw/rejection loops are the draw-count contract (2 `randpw()` per attempt, plus 2 per `getLinear`/`getNormal` attempt), so the structure is native's: draw, test, repeat. The four distribution parameters it passes are native `float` literals — see `L10/patch-setpoint-literal-widths` for their widths and the measurement |
| `L10/patch-float-order` | `patch.ts` | `randpw()` is a **double**, so `startX + sizeX * randpw()` is double math narrowed once at the store; the elliptical containment test is float throughout; `PI` is `M_PI` so `getArea()`'s elliptical branch is double narrowed once on return (rounding the intermediate product first moves it one ulp) |
| `L10/patch-fields-start-at-zero` | `patch.ts` | native's `Patch()` is empty, so members are indeterminate until `initBase`; the port starts them at 0 and `initBase` is the only writer before any read |
| `L10/domain-lane-cut`, `L10/stage-lane-cut` | `patch.ts` | `Patch::initBase` reads four fields of native's `Domain` (L11's) and `AddObject`/`RemoveObject` of `gstage` (L15's); the port states both as the minimal interfaces it uses |
| `L10/patch-illegal-shape-throws` | `patch.ts` | native prints and `exit(1)` on an unknown shape; the port throws (the value already passed schema validation, so reaching it means a caller invented a shape) |
| `L10/foodtype-find-order` | `foodType.ts` | `find( polarity )` walks native's `std::map<string,...>`, i.e. **strcmp order on the name** — the alphabetically-first match wins, not the first declared. The port sorts the keys by UTF-8 bytes. Measured on the probe's six types: `find` returns `10`, not `Standard` |
| `L10/foodtype-lookup-inserts` | `foodType.ts` | native's `lookup()` is `map::operator[]`, which **inserts a null entry** for an unknown name; `getNumberDefinitions()` then counts it. Reproduced deliberately (it is observable through `run/energy/food.txt`'s column count) and `find` lets the null dereference fail loudly, as native crashes |
| `L10/foodtype-log-columns` | `foodType.ts` | `run/energy/food.txt`'s columns are `FoodType::get(i)->name` for `i` in `[0, getNumberDefinitions())`; `consumption.txt`'s `FoodType` token is the same string. Pinned against the recorded golden |
| `L10/food-radius-xz-only` | `food.ts` | `food::setradius()` overrides the `gbox` deriver to use `fLength[0]` and `fLength[2]` **only** — `initlen()`'s `setlen()` reaches the override, so a food's radius ignores its height |
| `L10/food-draw-order` | `food.ts` | the 2-arg constructor draws **energy, then x, then z**; the 3-arg form leaves the energy and draws x, z |
| `L10/food-energy-operand-f32` | `food.ts` | native narrows the **difference** before widening it: `0x5ac70 fsub s1, s1, s2` (`initfood(ft,step)`; the constructor inlines the same five at `0x5ab94`) makes the multiply's factor `(double)f32(Max - Min)`, **not** the binary64 difference. Fixed in the sweep follow-up (`t_97ec04fa`) and pinned in `tests/environment.test.ts`; the `fmadd` itself stays in the residual double class |
| `L10/eat-reinitlen-only` | `food.ts` | `food::eat` re-runs `initlen()` (length and radius follow the remaining energy) but never re-derives `fPosition[1]`, which was fixed at creation |
| `L10/gallfood-order` | `food.ts` | `gAllFood` is ordered by creation step: append for `step >= 0`; for a negative step (`RandomInitFoodAge`) insert before the first food with a *greater* step, FIFO among equals |
| `L10/gallfood-node-list` | `food.ts` | native erases through a stored `std::list` iterator, so one erase leaves every other iterator valid; the port keeps a node list for the same reason (an array index would go stale when the sim destroys several foods per step) |
| `L10/foodpatch-energy-sentinel` | `foodPatch.ts` | `energy == -1.0` is an **exact** comparison against a double literal and means \"random energy in [MinFoodEnergy, MaxFoodEnergy)\"; `-0.9999999` does not trigger it |
| `L10/addfood-draws-two-positions` | `foodPatch.ts` | `addFood` constructs the food (which draws its own energy *and* position) and then overwrites x/z from `setPoint`; both sets of draws happen and both are kept |
| `L10/brick-argument-evaluation-order` | `brick.ts` | `initBrick( color, randpw() * WorldSize, randpw() * WorldSize )` leaves the argument order *unspecified* in C++; the port fixes the order the oracle binary used, pinned by the probe's `brick.drawn.*` fixtures |
| `L10/brick-pickup-is-dead` | `brick.ts` | `brick::pickup( float )` is declared and defined **nowhere** in the tree and called nowhere (grep-verified); nothing is ported for it |
| `L10/brickpatch-removal-leaks` | `brickPatch.ts` | native removes a brick from the list and the stage and never deletes it (its own teardown says so); the port reproduces that |
| `L10/brickpatch-on-is-constant-in-the-recorded-runs` | `brickPatch.ts` | `On` is a `Dynamic` schema property, but neither recorded worldfile uses a `dyn(...)` form (`docs/specs/cppprops.md`: 4 runtime properties, no dynamic patch property), so `updateOn()` never sees an edge there; `setOn` is exposed for the cppprops binding |
| `L10/xsortedlist-insert-key` | `objectXSortedList.ts` | `add` inserts before the first object whose `x - radius()` is **strictly greater** (equal keys keep insertion order) and appends otherwise; the order is by left edge, not centre. The key reads the **accessor** — see the row below |
| `L10/radius-is-an-accessor` | `objectXSortedList.ts`, `object.ts` | the list's key is `x()` minus `radius()`, the native **method**, and `GoObject`'s storage is native's `fRadius` with `radius()` over it. Native spells it that way because `gobject::radius()` is a method and the list's elements are `gobject*`: lane L8's `agent` (a `gpolyobj`) has no radius *field* at all, only the method. A field read therefore computes `NaN` for every agent — `NaN < NaN` is false, `add()` degenerates to an append and `sort()` never relocates a node, so the list silently reverts to insertion order and `Interact`'s x-early-out walk stops reaching agent pairs. Found by fullstack-dev-7 while measuring the L11 gate (`contacts.log` empty in a run whose contact geometry was right); fixed here and pinned by the probe's `objectlist.accessor.*` section (accessor-supplied radii, key order ≠ `x` order, `add()` and `sort()` both), whose port mirror has **no radius field to read**: restoring the field read fails 18 of those pins and nothing else |
| `L10/xsortedlist-home` | `objectXSortedList.ts` | native puts the file in `utils/`, but it includes `agent/agent.h`, `environment/food.h` and `environment/brick.h`; L12's seam note reaches the same conclusion (\"the list stays the sim/environment lane's\"). This is that implementation |
| `L10/xsortedlist-structure` | `objectXSortedList.ts` | the port keeps the observable cursor semantics (`reset`/`next`/`removeCurrentObject` leaves the cursor as `gdlist::remove` does, `getcurr`/`setcurr` handles) but implements the container as nodes here rather than porting the `gdlist<T>` template |
| `L10/xsortedlist-out-params` | `objectXSortedList.ts` | native writes through `gobject**` and returns 0/1; every caller tests the return first, so returning the object or null is equivalent. The one exception (`lastObj` on an empty list dereferences the null it just wrote) throws |
| `L10/xsortedlist-sort-is-live` | `objectXSortedList.ts` | `sort()` is **not** dead code: `TSimulation::Interact()` calls `objectxsortedlist::gXSortedObjects.sort()` unconditionally on every step (`sim/Simulation.cc:1465`), agents move every step so the keys arrive stale, and `Interact` then walks the list to decide RNG draw order while `run/energy/food.txt` sums food energy in x-sorted order. An earlier revision of this note asserted the opposite (\"nothing in the recorded path calls it\") — false, and it survived review round 1 only because `sort()` was not in the probe's pinned set. Now pinned (7 fixtures, 2 passes each) and re-checked by mutation |
| `L10/xsortedlist-sort-o-p-rebind` | `objectXSortedList.ts` | the load-bearing line of native's `sort()` is `o = p;` at the *end* of the relocation branch, just before the shared `p = o;`: after a relocation `p` must stay on the **pre-move** object, so the next iteration compares against it rather than against the node that just moved. Dropping the rebind produces a different order that never converges to native's (measured: 10 pins across fixtures A and C, order `0.5, 1, 5, 2, 3, 7, 4` instead of `0.5, 1, 2, 3, 4, 5, 7`). Found in review round 1, fixed and pinned |
| `L10/food-getter-aliases` | `food.ts` | native spells `getEnergyPolarity()`/`getEatMultiplier()`; L8's `FoodLike` seam spells them `energyPolarity()`/`eatMultiplier()`. Both are kept (the aliases delegate), so the seam binds without an adapter and the native names stay greppable. This is what let L11's `src/model/sim/bindings.ts` typecheck against `Food` |
| `L10/distributions-float-order` | `distributions.ts` | the *store* boundaries are float (native narrows `left` once, `fcvt s8, d3`), but the arithmetic between them is **not** uniformly float — the oracle keeps `sigma^2` (`0xfb7c fmul d1, d1, d1`, the folded `pow(sigma,2)`), the `fl(2*pi) * sigma^2` product (`0xfb90`), the `sqrt` (`0xfb94`) and the reciprocal (`0xfb98`) in double and narrows once (`0xfba0 fcvt s8, d3`), narrows `2 * (double)sigma^2` once (`0xfbb0 fcvt s1, d1`) and folds `pow(x-mu,2)` to a single-precision `fnmul` (`t_c10975cb`'s byte-identical replica of the C source). **`t_8db5f338` (L10) closed it**: `left` and `rightBottom` now carry one `f32` each and match the oracle on all 1 296 corpus rows, where the pre-fix `left` was a *different float* on 576 (44.4 %) of them. That card also corrected this row's original reading of line 36: its extra `f32` was **not** a value bug (0 of 1 296 either way, since `* 2` is exact in binary32) |
| `L10/distributions-pow-drift` | `distributions.ts` | there is **no `pow` site here**: `normalPDF`/`getNormal` each contain exactly one transcendental call, `_powf`, which was transcribed as `powf` in `t_29e0a2fc` (the site calls it now), and the other three `pow` calls in the C source are clang-folded multiplies. The transcribed double `pow` was measured bit-identical to V8's `Math.pow` on all 797,034 pairs of this file's argument domains, each differing from the shipped `powf` on 0.13–0.90 % of them, so the swap would have been a no-op — see the Gaps row. Both recorded worldfiles use `Distribution U`, so nothing frozen reaches `getLinear`/`getNormal`; the probe's `rectGauss`/`ellipseGauss`/`rectLinear`/`ellipseLinear` fixtures pin the set-point paths. **Closed in `t_29e0a2fc`**: with `powf` transcribed, `right` and `pdf` match the oracle on **all 1 296** rows of `native/raw/normalpdf_sweep.tsv` (the 11 rows the double `pow` got 1 ulp wrong are the `powf` rows this row identified, and `tests/distributions-normalpdf.test.ts` pins both the 0 residual and the 11-row double-`pow` shortcut) |
| `L10/distributions-float-parameters` | `distributions.ts` | native's four signatures are `float` (`utils/distributions.h`), so a call **narrows its arguments before any arithmetic** — `__Z9normalPDFfff`'s first operation is `0xfb78 fcvt d1, s1` on an already-`float` `sigma`, and `__Z9linearPDFfff`'s else arm fuses binary32 operands (`0xfbdc fmadd s1, s1, s0, s2`). The port narrows at *entry* for the same reason (card `t_bb4630da`): the call site's literals are `f32(...)` too, but entry narrowing is what makes the parameter declaration true of *any* caller. Measured over `native/raw/normalpdf_insitu.tsv` (the call site's own `sigma = 0.3f`, `mu = 0.5f`, 10 000 `x`): with the double `0.3` the port's `left` was the wrong float on **10 000/10 000** rows (`0x3faa3723` vs the oracle's `0x3faa3722`) and its return value wrong on **9 456/10 000 (94.6 %)**; with the entry `f32`, both **0**. `linearPDF`: **7 991/40 001 (20.0 %)** of `x` wrong with the doubles, 0 with the `f32` (`native/raw/linearpdf_insitu.tsv`). In situ the two spellings are sample-neutral (0 differing samples in 20 000 draws of either sampler on one deterministic stream), so this is the draw-count class the pow-drift row describes, not a moved artifact — the verifiable half is the PDF value, which is why the corpora pin it |
| `L10/patch-setpoint-literal-widths` | `patch.ts` | `Patch.cc:78-81` declares `float sigma = .3; float mu = 0.5; float slope = -0.4; float yIntercept = 0.4;` — the oracle hands `getNormal`/`getLinear` `0.3f`/`0.5f`/`-0.4f`/`0.4f`, never the JS doubles. The port's four are `f32(...)` (`PATCH_GAUSS_SIGMA`, `PATCH_GAUSS_MU`, `PATCH_LINEAR_SLOPE`, `PATCH_LINEAR_Y_INTERCEPT`, exported so their bit patterns are pinnable — with the functions narrowing on entry the call site's width is no longer observable in sampled output, and the probe's `rectGauss`/`ellipseGauss`/`*Linear` fixtures pass either way). **Swept for the class** (`t_bb4630da`): `grep -rn "= -?0\.[0-9]" src/model/environment/` returns only `0.0` sentinels (exact in both widths) and the literals in this row; every other decimal literal in the lane that feeds a `f32`-typed computation (`patch.ts`'s `0.5`s, `food.ts`'s `0.75`, `object.ts`/`food.ts`'s `* 0.5`, `brick.ts`'s `0.5 * sqrt(2.0)`) is either exact in binary32 or a **double** literal in the native source as well, so narrowing it would be the unfaithful direction. Repo-wide, the same shape appears once more — `brain/core/spikingModel.ts`'s `f32(syn.delta * 0.9)`, i.e. native's `synapse[k].delta *= .9;` (`SpikingModel.cc:351`) — and is already right |
| `L10/energy-multiplier-and-polarity-reachability` | `native/envprobe.cc` (documented) | `Energy`'s and `EnergyPolarity`'s `values[]` are private with only `proplib::Property` constructors as public writers, and a `Property` cannot be built without the document machinery — so the probe builds adversarial vectors as `Energy(float) * EnergyMultiplier(float*)` and uses only the default (all-POSITIVE) polarity. Residuals below |

### Verification (L10)

```
$ bash src/model/environment/native/run_envprobe.sh        # links the oracle's libpolyworld.dylib
wrote ... f32=1327 int=234 bool=213 str=185                # 1,959 golden values (1,909 + the 50
                                                           # of the objectlist accessor section)
$ npx vitest run tests/environment.test.ts
Test Files  1 passed (1)
     Tests  13 passed (13)
$ npx vitest run tests/environment.test.ts   # (the golden-consumption test is one of the 13)
consumed every value the native probe emitted -> []
$ npx vitest run                             # whole suite (other lanes land tests concurrently,
Test Files  31 passed (31)                  #  so this count moves between runs)
     Tests  553 passed | 2 skipped (555)
$ npx tsc --noEmit                           # exit 0
```

What is pinned, and how it was obtained:

* **1,909 golden values** (1,315 `f32` as raw bit patterns, 224 `int`, 211 `bool`, 159 `str`),
  each one produced by calling the *native* `environment/**` code and consumed by calling the
  port with the same fixture in the same order. The consumption check makes the replay
  self-verifying: a fixture that stops running fails the suite instead of silently reducing
  coverage. The module regenerates byte-identically (`sha256 c8cffd3e…` on two consecutive
  runs).
* `Energy` for `numEnergyTypes` 1..3 over six adversarial vectors (zero, ±, `1e-5`, `1e10`,
  per-component mixes): `sum`/`mean`/`isZero`/`isDepleted` (both thresholds), `+`/`-`/`*scalar`
  (both operand orders)/`+=`/`-=`, `constrain` and `constrain(…, overflow)`, the multiplier
  pass-through rule (zero multiplier and sign mismatch), the polarity multiply, the depletion
  threshold, and the `Energy(positive, negative, polarity)` constructor.
* `FoodType`: definition order vs map order (`get`/`find`/`lookup`/`getNumberDefinitions`),
  including the null-insert of an unknown lookup.
* `food`: all three constructors, positions/length/radius/type-number/domain from a seeded
  `drand48`, `eat` with requests below/at/above/negative, `isDepleted` after draining, `getAge`,
  and the `gAllFood` insertion order with mixed positive and negative steps.
* `Patch`/`FoodPatch`/`BrickPatch`: `initBase`'s absolute geometry, `getArea`, `pointIsInside`
  (centre, corners, just outside, neighbourhood), the agent counters, `setPoint` for all six
  shape × distribution combinations from a fixed stream, `setInitCounts`, `onChanged`/`endStep`,
  `addFood` (including the energy sentinel and the `maxFoodCount` gate, with the food's own
  draws), and `updateOn`'s rising edge, no-op, falling edge (the removal walk) and second rising
  edge.
* `barrier`: ten segments × ratio/absolute modes — `xmin`/`xmax`/`zmin`/`zmax`, `sina`/`cosa`,
  `dist` at ten points including 1e6 extremes, the `update()` recompute, and the degenerate
  segments' sentinel; plus `bxsortedlist.add`'s order and `xsort`.
* `brick`: `gBrickRadius` derivation, three drawn bricks (position, radius, type number, count),
  a placed brick, and the radius at a second height.
* `objectxsortedlist`: the x-sorted order after seven inserts, `getCount` by mask,
  `removeObjectWithLink`, a walk-and-remove pass, and **`sort()`** — seven fixtures (one node
  moving back past three, fully reversed keys including the new-head branch, non-uniform radii
  so the key order and the `x` order differ, a two-neighbour swap, an already-sorted list, the
  empty list and a one-element list), each run **twice** to pin both the resulting order and
  native's "almost entirely sorted" stability, plus the cursor the pass leaves for the next
  walker and the counters. This is the pass `TSimulation::Interact()` runs every step
  (`sim/Simulation.cc:1465`; the port's call site is `src/model/sim/interact.ts:115`), so it is
  on the recorded path: `run/energy/food.txt` is a float sum in x-sorted order and `Interact`
  walks the list to decide RNG draw order.
* **the list's key is the accessor, not a field** (`objectlist.accessor.*`, new in this pass):
  native's own `objectxsortedlist` code is driven with objects whose radius arrives through
  `radius()`/`setradius()` (a bare `gobject` subclass, no `gbox`, no radius field to read),
  non-uniform so the key order and the `x` order differ, through both `add()` and a
  stale-key `sort()`. The port's mirror of those fixtures is a stub in the shape of lane L8's
  `agent` — `radius()` over private state and **no** radius field — so the pin fails the moment
  the list reads a field: measured, restoring `a.fRadius` in `objectXSortedList.ts` fails
  **18** of these pins (`objectlist.accessor.adds.*`, `.key.*` and `sort.after*.*`) and nothing
  else in the suite. `sort()`'s own fixtures above could not catch it (their objects do carry a
  numeric radius), which is why this section exists.

The recorded run (`oracle/minitest_voff/run/**`, read-only):

* all **1,490** `barrier` rows of `events/collisions.log` have their agent's logged position
  (from `motion/position/agents/position_*.txt`) inside `agent::UpdateBody`'s x-window for one of
  the two barriers this lane builds from `normalized.wf` — with a negative control showing 100+
  `edge` rows outside it. This is the part of the frozen surface the environment owns outright;
  `run/energy/food.txt`'s step-0 total, by contrast, is a sum over food the *simulation* created,
  so it belongs to L11.
* `run/energy/food.txt`'s header and `run/energy/consumption.txt`'s `FoodType` tokens are this
  lane's `FoodType` registry in definition order (`Timestep`, one column per food type).

### `normalPDF`'s rounding discipline (`t_8db5f338`, closing the Gaps row *`normalPDF`'s `f32` roundings*)

`__Z9normalPDFfff` (`0xfb6c`) is a **double** chain with two float stores, and two of the port's
four expressions put an `f32` at every arithmetic step instead (`distributions.ts:32` and `:36`).
The corpus that decides it is `native/raw/normalpdf_sweep.tsv`: 1 296 `(x, sigma, mu)` rows
dumped by `native/raw/dump_normalpdf.cc`, which calls the shipped `normalPDF` out of
`libpolyworld.dylib` and emits, next to each return value, the four expressions as the *binary*
evaluates them (one `volatile` per step, at the register width the disassembly uses). The
replica reproduces the library's own return value on **every** row, which is the corpus's
self-check — a misreading of the disassembly cannot survive it. `x` spans `Patch.cc`'s own
domain (`randpw()` in [0,1), margin either side) and `sigma`/`mu` cross the model's `.3f`/`.5f`
with a worldfile-reachable spread.

Measured (`npx tsx tools/measure_normalpdf_f32.ts`, re-derived in
`tests/distributions-normalpdf.test.ts`):

| expression | pre-fix vs oracle | after |
|---|---|---|
| `left` | **576 / 1 296 (44.4 %)** | 0 |
| `rightTop` | 0 | 0 |
| `rightBottom` | 0 | 0 |
| `right` (`powf` vs the port's double `pow`) | 11 / 1 296 (0.85 %), all 1 ulp | 0 — `powf` transcribed in `t_29e0a2fc` |
| `normalPDF`'s return value | **537 / 1 296 (41.4 %)** | **0** — the 11 `powf` rows (`right` above) and the 10 that rode on them are all matched once `powf` lands (`t_29e0a2fc`) |

Two findings worth keeping. (1) The pre-fix `left` is a *different float* on 44.4 % of rows, not
a different spelling of one: the three extra binary32 roundings do not cancel. (2) The Gaps
row's reading of line 36 was wrong — its extra `f32` is **value-neutral** (0 of 1 296 either
way, and provably so: `* 2` is exact in binary32, so the roundings commute), so it was rewritten
for the binary's operand types rather than to move a bit. `rightTop`'s `Math.pow` was already
the oracle's single `fnmul` rounding (the double square of a `float` needs <= 48 significand
bits, so it is exact).

`tests/distributions-normalpdf.test.ts` is the pin: 4 tests, no golden module involved
(the corpus is the fixture, so the probe's 1,959-pin consumption check is untouched). Its revert
check: restoring both `f32` chains fails the end-to-end test on **531** rows (the remaining 6 of
the 537 coincide with `powf` rows), and the test also asserts `rightTop`/`rightBottom` equality
on all 1 296 with the fix in, so a re-widened expression reads as a regression rather than as a
cleanup.

Nothing frozen moves. The recorded scenarios use `Distribution U`, and — measured, not assumed —
the probe's own `rectGauss`/`ellipseGauss` set-point fixtures, which **do** reach `normalPDF`
through `getNormal` (this card's premise that nothing reaches it was too strong), are identical
under both forms: `npx vitest run tests/environment.test.ts` is 15/15 with either. The reason is
the sampler rather than unreachability — `getNormal` compares an *independent* `randpw()` draw
against the PDF, so a last-bit PDF change only alters the sample when that draw lands inside the
1-ulp window, which the fixtures' own fixed stream does not. A worldfile that sets
`EllipseGauss`/`RectGauss` is where it would, and there it is a **draw-count** risk: the sampler
recurses on a rejection, so the same amplification the pow-drift row notes.

#### `Patch::setPoint`'s distribution literals are `float` (`t_bb4630da`)

`Patch.cc:78-81` declares the four distribution parameters `float` (`float sigma = .3; float mu =
0.5; float slope = -0.4; float yIntercept = 0.4;`), so the oracle hands `getNormal`/`getLinear`
`0.3f`/`0.5f`/`-0.4f`/`0.4f`. The port declared them as JS doubles, and no frozen artifact could
see it (`Distribution U` in both recorded worldfiles, so `setPoint`'s UNIFORM arm never calls
either function). The two callees' own bodies make the width observable: `__Z9normalPDFfff`'s
first instruction is `0xfb78 fcvt d1, s1`, widening an *already `float`* `sigma`, and
`__Z9linearPDFfff`'s else arm fuses **binary32** operands (`0xfbdc fmadd s1, s1, s0, s2`).

Two corpora were dumped from the shipped library for the operands the call site really passes —
`native/raw/normalpdf_insitu.tsv` (`sigma = 0.3f`, `mu = 0.5f`, `x = i/10000`, 10 000 rows, by
`dump_normalpdf_insitu.cc`) and `native/raw/linearpdf_insitu.tsv` (`slope = -0.4f`,
`yIntercept = 0.4f`, `x = i/40000`, 40 001 rows, by `dump_linearpdf_insitu.cc`) — each with the
disassembly replica beside the library's own return value, so each checks its own decomposition
(the linear one including the arm boundary: `x = 0.5` takes the `fnmul`).

| expression | the doubles (what the port passed) vs the oracle | `f32` (what it passes now) |
|---|---|---|
| `normalPDF`'s `left` | **10 000 / 10 000** — `0x3faa3723` against the oracle's `0x3faa3722` | 0 |
| `normalPDF`'s return value | **9 456 / 10 000 (94.6 %)** | 0 |
| `linearPDF`, else arm | **3 999 / 20 000 (20.0 %)** | 0 |
| `linearPDF`, whole function | **7 991 / 40 001 (20.0 %)** | 0 |
| the sweep's own `(x, sigma, mu)` grid, every `sigma`/`mu` fed as the **double** of its source literal | **720 / 1 296** rows in `left`/`rightBottom` (the five of the nine sigmas whose double is not their float: `0.05`, `0.1`, `0.3`, `0.7`, `3.3`) and **386 / 1 296** in the return value | 0 |

The source literals there are recovered from the stored floats as the shortest decimal that narrows
back to them — which reproduces the dumper's own lists (`0.05`, `0.1`, `0.3`, `0.5`, `0.7`, `1`,
`2`, `3.3`, `10` and `-0.5`, `0`, `0.25`, `0.5`, `0.75`, `1`), so the reconstruction is the source
and not a re-spelling of the float. `left`/`rightBottom` depend on `sigma` alone, so their count is
the row count or 0 — the x-dependent measurements are the two return values. Both spellings are **sample-neutral in situ**,
measured rather than assumed: on one deterministic 20 000-draw stream `getNormal` and `getLinear`
each produced **0** differing samples and 0 differing draw counts (the rejection test only flips
when the independent draw lands inside the ulp window), and the probe's
`patch.*.rectGauss`/`ellipseGauss`/`*Linear` set-point fixtures are unchanged either way. So the
residue is a **draw-count** risk on a worldfile that sets `Distribution Linear`/`Gauss` — the same
class the pow-drift row describes — and the value that *is* verifiable is the PDF, which is what
the corpora pin.

The fix is in two places, deliberately. (1) The literals are `f32(...)` in `patch.ts`, at native's
own width, exported as `PATCH_GAUSS_SIGMA`/`PATCH_GAUSS_MU`/`PATCH_LINEAR_SLOPE`/
`PATCH_LINEAR_Y_INTERCEPT` so their bit patterns are pinnable at all — with the second half of the
fix in place the call site's width is no longer observable in sampled output. (2) All four
functions (`normalPDF`, `linearPDF`, `getNormal`, `getLinear`) narrow their parameters at **entry**,
because native's signatures are `float`: that is what makes the declaration true of any caller, and
it is why the in-situ calls above match even when they are handed the double. Both are stated in
`PORT-NOTE(L10/distributions-float-parameters)` / `PORT-NOTE(L10/patch-setpoint-literal-widths)`,
the Gaps row and the sweep's *Fixed* ledger.

Pins: `tests/distributions-normalpdf.test.ts` carries four in-situ tests (the pre-fix counts as
revert guards, plus the sampler-neutrality measurement) and the four literals' bit patterns — the
last of those because, once the entries narrow, the call site's width is observable nowhere else.
`npx tsx tools/measure_distributions_insitu.ts` prints both tables.

**Swept for the class before closing.** `grep -rn "= -?0\.[0-9]" src/model/environment/` returns
only `0.0` sentinels (exact in both widths) and these four literals; every other decimal literal in
the lane that feeds a `f32`-typed computation is either exact in binary32 (`patch.ts`'s `0.5`s,
`food.ts`'s `0.75`, `object.ts`/`food.ts`'s `* 0.5`, `brick.ts`'s `0.5 * sqrt(2.0)`) or a **double**
literal in the native source too, where narrowing would be the unfaithful direction. Repo-wide the
same shape appears once more — `brain/core/spikingModel.ts`'s `f32(syn.delta * 0.9)` against
native's `synapse[k].delta *= .9;` (`SpikingModel.cc:351`) — and it is already right.

### The accessor-radius fix and its whole-run effect (measured, 2026-09-28)

`objectXSortedList.ts` read the radius as a field until this pass. `tests/environment.test.ts`'s
`objectlist.accessor.*` section is the pin; the run effect was measured with

```
$ npx tsx src/model/sim/runner.ts microtest_voff <out>
$ ./oracle/run_parity.sh microtest_voff --candidate <out>
```

| | before (field read) | after (accessor) | golden |
|---|---|---|---|
| `match` | 215/225, differing 9 | **217/225, differing 7** | — |
| `run/events/contacts.log` rows | none | `1 15 2 MFCMF`, `1 2 5 MFCMF` | `1 15 2 MdxFCMdxF`, `1 2 5 MdxFCMdxF` |
| `run/energy/agents/agent_{2,15}.txt`, `run/energy/food.txt` | differ | **match** | — |
| `run/events/collisions.log` | byte-identical | differs (step 1, rows 2 and 3 swapped: `1 6 edge` before `1 3 edge`) | `1 3 edge`, `1 6 edge`, `1 18 barrier` |

Two residuals, both handed to the lane that owns them (L11, `t_d5ca0870`) rather than patched
from here:

1. **`contacts.log`'s `Events` column**: the two contacts now happen at the right step between
   the right agents, but the recorded behaviour string is `MdxFCMdxF` and the port emits
   `MFCMF`. That column is the behaviours `Interact` ran for the pair, i.e. sim behaviour
   composition, not list order.
2. **`collisions.log`'s step-1 row order**: the two `edge` rows swapped. Measured attribution —
   re-running with the field read restored reproduces the golden's order byte-for-byte, so this
   is this fix's doing, and it is an *exposure*, not a new defect: `agent::UpdateBody` runs in
   the phase **before** `Interact`'s `sort()`, so its walk order is the order the adds left
   behind. With the field read every agent key was `NaN`, `add()` appended and that order was
   creation order; with the accessor the port's order is the key order of the initial positions
   (`#6 x=0.3345` before `#3 x=0.6418`, uniform radius `0.885964…` in both cases). Native's
   golden has 3 before 6 at that phase while its *post-`sort()`* contact walk is demonstrably
   key-ordered (it reaches `#15` before `#2`, whose keys differ by 5e-6 and whose creation order
   is the reverse), so native's pre-`sort()` list is **not** in key order at step 1 while the
   port's now is. The port's add-time state (`x` set, radius `0.886`, in that order) and native's
   (`Simulation.cc:881-906`: `settranslation` then `add`, while `grow()` → `SetGeometry()` and
   therefore `fRadius` is only *posted* to the scheduler at `:875`) were read but do not by
   themselves explain it; pinning it down needs the shipped binary's `InitAgents`/`add` sequence
   disassembled, which is L11's file and L11's artifact.

### The food energy draw's dropped `f32(Max - Min)` (fixed, t_97ec04fa)

The contraction sweep (`t_981fcace`, round 3) found this site and recorded only half of it: the
`fmadd` at `0x5aba0`/`0x5ac7c` is the residual double-contraction class, but the same five
instructions also narrow the **difference** to `float` before widening it, and the port did not.

```
__ZN4food8initfoodEPK8FoodTypel (0x5ac38) — __ZN4foodC2EPK8FoodTypel (0x5ab08) inlines the
same five at 0x5ab94/0x5ab98/0x5ab9c/0x5aba0/0x5aba4

  5ac70:  fsub   s1, s1, s2       ; s1 = f32( gMaxFoodEnergy - gMinFoodEnergy )
  5ac74:  fcvt   d1, s1           ; widen *that float* to double
  5ac78:  fcvt   d2, s2           ; widen gMinFoodEnergy to double (exact)
  5ac7c:  fmadd  d0, d0, d1, d2   ; randpw() * d1 + d2 — ONE double rounding
  5ac80:  fcvt   s0, d0           ; narrow the result to float
```

so native is `f32( randpw() * (double)f32(Max - Min) + (double)Min )` (`d0` is `randpw()`, i.e.
the port's `drand48()`, per `food.cc:140`). The port computed `gMaxFoodEnergy - gMinFoodEnergy` in
binary64, i.e. with the multiply's factor ≈2⁻²⁴ off — a wrong operand, three orders of magnitude
above any last-bit question, and a different defect from the double-contraction class then
recorded as needing an `f64Fma` (that helper — `fma64` — now exists; see the sweep section).

| | |
|---|---|
| the fix | `f32( surface.drand48() * f32( Food.gMaxFoodEnergy - Food.gMinFoodEnergy ) + Food.gMinFoodEnergy )` — one `f32(...)`, `src/model/environment/food.ts` (the only site that transcribes this draw; `foodPatch.addFood` and the carcass path both go through the constructor) |
| the pin | `tests/environment.test.ts` -> *the food energy draw*: 5 cases (Min/Max 0.1/1000, 0.01/1000, 0.2/1024, 0.7/9.3, 0.3/3.3), each a **live `Food` construction** with an injected `RngSurface` whose `drand48()` is a pinned double; the expected bits come from `gen_food_pin.py` (this card's workspace) — exact `Fraction` arithmetic plus an explicit binary32/binary64 round — never from the port's helpers, and each case carries a non-vacuity assertion that the pre-fix operand lands on different bits |
| mutation | the isolated-tree revert (`mut1/`, `food.ts` back to the binary64 operand) fails the pin: `live draw: expected 0x442d30f9 to be 0x442d30f8`, and the received value **is** the reference's pre-fix value — the reference predicts the port's bits in both directions |
| whole-run effect | **none, measured**: `microtest_voff` and `minitest_voff` candidates built with and without the change are **byte-identical** (`diff -r`, 0 lines), and `microtest_voff` still reports `parity: PASS (225/225 files)` |

Why no recorded run can move, and the shape of the defect: the exact difference of two `float`s is
*often* representable in binary32 — nearby exponents cancel into trailing zeros — so `f32(Max-Min)`
only differs from the binary64 difference when the two are far apart in magnitude. Every recorded
scenario sets `MinFoodEnergy 200.0 / MaxFoodEnergy 1000.0` (`oracle/*/run/normalized.wf`): both
exact, difference 800 exact, so `0x5ac70`'s `fsub` is lossless there and the operand is the same
value either way. A worldfile with a wide ratio (0.1/1000) would not be so lucky: over 20 000
plausible decimal (Min, Max) pairs (log-uniform 0.01–2000, ratio 1–50,
`rate_food_operand.py`) **74.2 %** have a different operand, and **23.2 %** of the draws on those
pairs land on a different `float` — a whole-run (draw-count) risk for any future scenario, not a
last-bit one.

**Not touched, deliberately**: the `fmadd` itself (the card's Part 2) — the residual
double-contraction class with the standing human decision (`-ffp-contract=off` vs an `f64Fma`
helper) recorded in the sweep section. Lane recommendation: **not** now. The site is one of ~40 in
that class, and taking it alone buys a Dekker/round-to-odd helper for a ≤2⁻⁵³ difference on a value
only this draw produces. **The helper half of that trade has since been paid** (`nativeMath.ts`'s
`fma64`, `t_da2ab201`), so this site's cost is now one `fma64(...)` with a pin; the class-level
decision below is still the orchestrator's.

### Known residuals (L10)

| What | Residual | Why it is accepted |
|---|---|---|
| `EnergyPolarity` with a NEGATIVE or UNDEFINED component, and `createDepletionThreshold`'s UNDEFINED → `NaN` branch | not probe-pinned (one branch each) | native's `values[]` is private and the only public writer is `EnergyPolarity( proplib::Property & )`, which needs the document machinery. The port's `EnergyPolarity.fromNumbers` (L8) covers the branch in unit tests; the *native* NaN bits (`0x7fc00000`) are read, not measured. Nothing in the recorded scenarios reaches it (`EnergyPolarity [ 1 ]` for both food types) |
| `getLinear`/`getNormal` under a differing `powf` | pinned against the shipped `powf` itself (`powf` transcribed in `t_29e0a2fc`; `rectLinear`/`rectGauss`/`ellipseLinear`/`ellipseGauss` set-point fixtures unchanged) | both recorded worldfiles use `Distribution U`, so nothing frozen reaches it |
| the `bZero`/rejection draw counts inside `getNormal` | same as above | same reason |
| `EnergyMultiplier`'s `values[]` beyond `numEnergyTypes` | never read (native leaves them uninitialized) | the port never reads them either; the probe exercises 1..3 types |

### Findings worth the orchestrator's attention (L10)

1. **FMA contraction is a port-wide hazard, not an environment detail.** With `clang -O1` on
   arm64 (the oracle build), `a*b + c` is contracted into one fused multiply-add, so a chain that
   reads as two roundings behaves as one. The environment lane lost *29* one-ulp pins to it
   before modelling it (measured site by site in review round 1: 21 to `barrier::updateVertices`'
   `c`, 8 to `Patch::initBase`). Any lane porting a float chain that mixes a product with an add —
   L8's barrier push, L11's step arithmetic, L12's float accumulators, L13's complexity sums —
   should assume the same and pin it against the oracle.
2. ~~**`Energy` still lives in L8's file.**~~ **CLOSED by `t_4e856769` (2026-09-28): it does not.**
   The module body moved to `src/model/environment/energy.ts` (with `MAX_ENERGY_TYPES`/
   `ENERGY_EPSILON` out of `agent/numeric.ts`), `src/model/agent/energy.ts` is deleted rather than
   left as a re-export, and L8's importers — `agent.ts`, `metabolism.ts`, `contracts.ts` and the
   agent barrel — point here. `grep -rn '^export class Energy\b' src` → 1. The Gaps row above is
   closed and the six-scenario milestone (`run/energy/**` included) still PASSes.
3. **`objectxsortedlist` needed a home and now has one** (`src/model/environment/objectXSortedList.ts`).
   L8's `SortedObjectListLike` and L12's `LogSortedObjectList` seams must bind to it rather than
   each growing their own walk, or the recorders and the sim will disagree about object order —
   which is exactly what `run/energy/food.txt`'s float sum depends on.
4. **A cross-lane binding was fixed while landing this lane**: L11's `src/model/sim/bindings.ts`
   could not typecheck `Food` against L8's `FoodLike` because the seam drops the `get` from
   `getEnergyPolarity`/`getEatMultiplier`, and `GoObject` exposed `CarriedBy` as
   `carriedByObject()` and `Dropped()` with an injected `worldSize`. All three are now the names
   the seams expect (`energyPolarity`/`eatMultiplier`, `carriedBy()`, `dropped()` with no
   argument, reading `globals.worldsize` as native does). `npx tsc --noEmit` reports **no**
   errors outside `src/model/sim/**` (lane L11's own in-flight file, 27 errors there at the time
   of writing).
5. **`git status` / suite state at handoff**: `npx vitest run` → **23 files, 434 passed | 1
   skipped (435)** including this lane's 12 (other lanes were landing tests during this run, so
   the total moves — that handoff's own count, superseded by **48 files / 729 passed | 1 skipped**
   on `b2bbcaf`, 2026-09-29); `npx tsc --noEmit` exits 0; the golden regenerates
   byte-identically (`sha256 c8cffd3e…` on two consecutive runs). The lone skip is not this
   lane's (L11's runner).
6. **Review round 1 found a real defect, so read the round-2 pins as the contract.**
   `objectXSortedList.sort()` dropped native's `o = p;` rebind and its PORT-NOTE claimed the
   call was unreachable, so the bug sat outside the pinned set — on the path
   `TSimulation::Interact()` runs every step. It is now fixed, pinned by 7 fixtures × 2 passes
   (plus the cursor the pass leaves), and re-checked by mutation: deleting the rebind fails the
   suite on 10 `objectlist.sort.*` keys. **Lesson for every lane**: a PORT-NOTE that says
   "nothing on the recorded path calls this" is a claim about *call sites* — grep the native
   callers before writing it, and pin anything the sim touches each step, or the claim becomes
   self-fulfilling. The environment lane's residual gap is unchanged: whole-run
   `./oracle/run_parity.sh` still needs L11's `run/` tree.

---

# Lane L11 — the simulation loop (`src/model/sim/**`)

Owner: L11 (`t_d5ca0870`). Native: `library/sim/**` (`Simulation.cc` 5374 + `Simulation.h` 588,
`Scheduler`, `Domain`, `FittestList`, `GeneStats`, `EatStatistics`, `simconst`, `globals`,
`utils/Events.h`). Spec: `docs/specs/sim-spec.md` (W1i).

## Status

**All six recorded scenarios are byte-exact whole runs, re-measured on this tree (`b2bbcaf`,
2026-09-29):** `microtest_voff` `parity: PASS (225/225 files)` (`match 224/225`, 150/150 `.gz`),
`minitest_voff` **`parity: PASS (1369/1369 files)`** (`match 1368/1369 differing=0 missing=0 extra=0
ignored=1` = `run/movie.pmv`, 1167/1167 `.gz` payloads identical), `microtest_von` `PASS (225/225
files)` (150/150 `.gz`), `minitest_von` `PASS (1308/1308 files)` (1114/1114 `.gz`), `hello`
`PASS (19/19 files)` and `minitest_adami` `PASS (1373/1373 files)` (1167/1167 `.gz`) — `differing=0
missing=0 extra=0` throughout. `npx tsc --noEmit` exits 0 for the whole project and the serially-run
suite is **green: 48 files / 729 passed | 1 skipped** (same measurement). The
`tests/complexity-adami.test.ts` whole-run comparison the sim now *reaches* asserts **every** Adami
row: its gate (`t_bbf63409`, PORT-NOTE `l13/adami-is-a-function-of-the-run`) reads the replayed run's
own population history and **no longer trips**, now that the history is byte-exact — the
`197 DEATH 47` row it used to stop at is part of the *former* `minitest_voff` divergence, recorded as
closed below (*the former `minitest_voff` divergence*). Run 7 closed the last residual with four
1-ulp-wide defects — all of them
a `float` subexpression the port had left in double, all localized with a new native step probe
(`src/model/sim/native/simprobe_steps.cc` + `run_simprobe_steps.sh`, which steps the oracle's own
`libpolyworld.dylib` outside the Qt app — it creates a `QGuiApplication` so the POV renderer's
offscreen GL surface can be built with `QT_QPA_PLATFORM=cocoa` — and prints order plus exact `%a`
bit patterns, which the 4-significant-digit artifacts cannot):

1. `AverageAngles` (`agents.ts`): native's inlined body (Mate 0x984a0-0x98500) is all single
   precision (`fabd` vs `180.0f`, `fadd` for `a+b`, `fmul` by `0.5f`); the port summed in double, so
   agent 32's birth yaw was 1 ulp low (`0xc2fb0203` vs `0xc2fb0204`) — and that ulp flipped the
   x-sorted order of agents 4/32 at step 64, the run's first divergence.
2. The birth location (`interact.ts`): native 0x98490-0x98510 does `fadd` then `fmul` by `0.5f` for
   x, z and y; the port averaged in double.
3. The x-sorted key (`environment/objectXSortedList.ts`, lane L10 — cross-lane, PORT-NOTE
   `L10/xsortkey-is-a-float`): `x() - radius()` is `float - float` in native, so an exact-double
   compare breaks ties the native build keeps (step 232: exact keys differ, both `float` keys are
   `0x4185695a`, native keeps `48, 64`). `Interact`'s contact early-out and the eat/carry edge tests
   are narrowed the same way (PORT-NOTE `L11/float-edge-comparisons`).
4. `GeneStats::compute` (`geneStats.ts`): native 0x9e10c-0x9e134 is `fdiv` + `fmsub` (the
   `- mean*mean` is fused) + `fsqrt` (float); the port's double chain printed `8.5,27.0` where the
   golden has `8.5,27.1` (`genestats.txt` line 115, step 114) — the tree's last differing file.

```
npx tsx src/model/sim/runner.ts microtest_voff <freshdir>     -> ok=true steps=1
./oracle/run_parity.sh microtest_voff --candidate <freshdir>  -> parity: PASS  (225/225 files)
      match 224/225  differing=0  missing=0  extra=0  ignored=1 (run/movie.pmv, not in the contract)
      content-compared 150 file(s) [run/**/*.gz]: payload identical 150, container differs 0
```

Baseline at the start of this run: `microtest_voff` 224/225 and `minitest_voff` **FAIL 198/1369**
(688 differing, 483 missing, 531 extra) with the run *aborting*. The 226-file swing is four defects,
all measured (see the closed record below).

### The former `minitest_voff` divergence — first divergence, localized (closed by run 7)

**This is a closed record, kept as the evidence for run 7's four fixes, not as a standing gap.**
`minitest_voff` is `parity: PASS (1369/1369 files)`; what follows is where the last residual *was* and
how it was localized — the four 1-ulp defects run 7 landed (above) are the resolution of every bullet
below.

* **The model's first divergence *was* a 1–2 ulp difference in a *fight damage amount*:**
  `run/events/energy.log:440`, `39 28 F 2 … 6.036985` (golden) vs `6.036986`. The per-agent energy
  traces then diverged from step 47 (`energy/agents/agent_22.txt`: `62.708149` vs `62.708141`, energy
  only, food energy identical) and the first death moved one step (`197` → `198` — the
  `run/BirthsDeaths.log` line 77 row the `complexity-adami` gate used to stop at).
* **It is not the sim's step loop.** Every sim-side artifact that is step-indexed and independent of
  that drift matches: `run/genome/agents/*` (all 25), `run/brain/anatomy/*` weights, the x-sorted boot
  list, `stats/stat.1`, `endStep`/`endReason`, and the whole 225-file `microtest_voff` tree.
* **It is not `damage()`, `GetFightStatus()` or `EnergyScaleFactor()`** — all three were re-read from
  the shipped disassembly this run and now agree instruction for instruction.
  The remaining inputs of the differing amount are the attacker's `Fight()` **brain output nerve**
  and the two population scale factors; `run/brain/*/brainFunction_*.gz` shows the divergence moving
  through the activation stream afterwards (`brainFunction_22`: neuron 1 from step 51 — the energy
  nerve — nothing else), i.e. the brain sees it as an *effect*, and the dumps' only other differing
  cells are neuron 0 (the random nerve) at isolated steps (agent 1: 14, 52, 207 of 218).
* **Consequence for the other lanes:** `tests/complexity-adami.test.ts`'s "reproduces
  `minitest_adami` byte for byte" used to `ctx.skip` whenever the run could not complete; once the
  run completed it ran, and failed on exactly this residual — *not* a regression in this lane's
  files (the pow swap of `t_c10975cb` was proved unrelated three ways, and the food-energy operand
  change reproduces it), just the comparison reporting what `minitest_voff`'s parity already
  reported. `t_bbf63409` closed the hand-off: the record comparison now gates on the run's own
  population history, so the rows this residual moved were reported as a **skip with the measurement**
  while every row below the first move (`197 DEATH 47`) was asserted — and the gate clears itself when
  this residual does, no code to remember. **It cleared on run 7**: re-measured 2026-09-29, the gate's
  `firstHistoryDivergence()` returns `null` (`run/BirthsDeaths.log` and `run/population.txt` are
  byte-exact against the golden), so all 301 rows of each of the four Adami records are asserted and
  `tests/complexity-adami.test.ts` is **3 passed (3), 0 skipped**. The same gate's first executing run
  also exposed a real defect in **L13's** own transcription (the contracted entropy sums, PORT-NOTE
  `l13/adami-entropy-is-contracted`), which is fixed and pinned by the forced prefix.

| Module | Native | State |
|---|---|---|
| `scheduler.ts` | `sim/Scheduler.{h,cc}` | complete — the recorded (deferred) semantics, PORT-NOTE(sched-deferral/sched-flags/sched-asserts) |
| `simulation.ts` | `sim/Simulation.{h,cc}` | complete for the ctor/init phases, `Step`, both agent update passes, energy accounting, `MaintainEnergyCosts`/`EnergyScaleFactor`, the end phase, every accessor, `SetNextLockstepEvent` |
| `interact.ts` | `Simulation.cc:1452-2909` | `Interact`, `DeathAndStats`, contact loop, Mate/Fight/Give/Eat/Carry/Pickup/Drop/Fitness, `Smite` (`L`/`R`), `MateLockstep` (throws: no scenario uses lockstep) |
| `agents.ts` | `Simulation.cc:2914-3817` | `CreateAgents` (domain + global), `Birth`, `Kill` (carcass food, fittest, deferred passes), `analyzeBrain`, `updateFittest`, `AgentFitness`, the parent walkers |
| `maintain.ts` | `Simulation.cc:3153-3745, 5261-5301` | `MaintainFood`/`MaintainBricks`, `AddFood`/`RemoveFood`, `FoodEnergyIn/Out`, `getRandomPatch` |
| `worldfile.ts` | `Simulation.cc:3822-4725` | `processWorldFile` in native order (every parameter, `Edges`, food types, metabolisms, domains/patches, barriers), plus `initLockstepMode` and `initFitnessMode` (both transcribed whole) and `initAdaptivityMode` (partial — the invalid-combination refusal only, see Gaps) |
| `domain.ts`, `fittestList.ts`, `geneStats.ts`, `eatStatistics.ts`, `stats.ts`, `events.ts` | `sim/{Domain.h,FittestList.*,GeneStats.cc,EatStatistics.cc,simtypes.h,utils/Events.h}` | complete |
| `bindings.ts` | — | the concrete side of lane L8's seams (genome factory over L5, `NervousSystem` over L6 with a real `GroupsGenomeView` adapter, **L15's real agent mesh** — `geometry`/`bodyTemplate` —, L10's list/statics/barriers, L12's registry) + `SimStage`/`NullAgentPovRenderer` stand-ins |
| `runner.ts` | — | the node-side candidate-tree writer (`npx vitest run sim-runner` drives it) |

## Evidence (what was actually executed)

* `npx tsc --noEmit` → **exit 0**, zero diagnostics in `src/model/sim/**`.
* `npx vitest run sim-runner` → **8/8** over the two files the filter now matches
  (`tests/sim-runner.test.ts` 4/4 + `tests/sim-runner-registry.test.ts` 4/4, re-measured
  2026-09-29). In particular the scheduler test pins the measured
  semantics: `master:start, master:end, parallel:1, serial:1, serial:2` (never inline, FIFO
  `postSerial` after the parallel batch) — the property `--ParallelInteract False` violates and which
  diverges from the golden at step 37 (sim-spec §3.3).
* The runner's boot half is exercised end-to-end: the port reads the oracle's recorded
  `run/original.wf` + `run/original.wfs`, applies the scenario's `--Vision False` argument and
  **writes `run/converted.wf` byte-identically to the golden** (asserted in the test).
* The runner's boot half now runs *and completes* everywhere: re-measured 2026-09-29, `runScenario`
  finishes **every** recorded scenario — `hello` (500 steps), `microtest_voff` / `microtest_von`
  (1 step each) and `minitest_voff` / `minitest_von` / `minitest_adami` (301 steps each), `ok=true`
  in all six — and `./oracle/run_parity.sh <scenario> --candidate <tree>` returns `PASS` on the tree
  each one wrote (`19/19`, `225/225`, `225/225`, `1369/1369`, `1308/1308`, `1373/1373`). The
  `worldfile.ts` `colorOf` "stub" this bullet used to stop at is not a stub: `colorOf`
  (`worldfile.ts:666`) opens the `Color` block and reads its `R`/`G`/`B` leaves, and every
  `FoodColor`, `BarrierColor`, `GroundColor` and patch/brick colour in those worldfiles goes through
  it — a byte-exact whole run of a worldfile that carries them is the proof (see the closed *blocker
  chain*, below).

## Blocker chain (the run-up to the parity number — every item closed)

**Closed as a whole.** This list is kept as the record of *how* the boot and the run were unblocked,
not as a list of open items: every entry below is struck or closed, and the parity number exists on
all six scenarios (`19/19`, `225/225`, `225/225`, `1369/1369`, `1308/1308`, `1373/1373` — re-measured
2026-09-29 on `b2bbcaf`; the lane's status is at the top of this section). Diagnosed, in order, at the
time, by running the port against `oracle/microtest_voff`:

1. ~~**Lane L4 (proplib expressions) — blocks the boot.**~~ **Landed 2026-09-28.** The native
   ctor's `schema->apply()` evaluates the worldfile's Python expressions; the port now does too
   (`interpreterEvaluator`, the ported `interpreter.py`), so the recorded `original.wf`/`original.wfs`
   boot, `converted.wf`/`normalized.wf` are byte-exact, and every scalar the model reads evaluates.
   The runner's measured next failure at the time was *not* an expression any more: it was item 2
   (also closed, below).
2. ~~**L11's own `worldfile.ts` `colorOf` is a stub** (`{ r: config.getFloat(id), g: 0, b: 0 }` for
   a `Color` block)~~ — **CLOSED.** The stub is gone: `colorOf` (`worldfile.ts:666`) opens the `Color`
   block and returns `{ r: block.getFloat('R'), g: block.getFloat('G'), b: block.getFloat('B') }`,
   which is the block read native does (`worldfile.cc`; the schema's
   `FoodColor { type Color; default { R G B } }`). The resolution is measured, not asserted:
   `microtest_voff` is a byte-exact whole run (`parity: PASS (225/225 files)`, re-measured
   2026-09-29), and that run boots through `converted.wf` / `normalized.wf`, so every `Color` the
   worldfile carries — `FoodColor` first among them — was read on the way in. The
   `worldfiles/tests/low-spec-pc/microtest.wf/FoodColor: ERROR! Expecting Float` message was that
   stub's symptom; it no longer occurs.
3. ~~**Lane L15 (agent mesh / `gpolyobj`) — blocks agent growth.**~~ **Closed by L15 (2026-09-28,
   `t_08aceedd`).** The real mesh is bound: `src/model/geometry/body.ts` + `AgentBodyGeometry`,
   with `etc/objects/agent.obj` bundled verbatim and the recorded agents' `fLength`/`fRadius`
   reproduced bit-for-bit (112/112); `createAgentDeps` binds it (the `NullBodyGeometry` throw is
   gone). **Measured next blocker (at the time):** with the mesh bound the runner completed the
   recorded run (`npx tsx src/model/sim/runner.ts microtest_voff <out>` → `steps=1 ok=true`) and the
   harness returned a real verdict instead of "no tree":
   `./oracle/run_parity.sh microtest_voff --candidate <out>` → **matched 18, differing 54,
   missing 153, extra 150, exit 1**. First divergence: `run/energy/agents/agent_1.txt` at **step 1**,
   column `Energy` — golden `739.669067`, candidate `739.874573`. The divergence is energy
   *accounting*, not geometry: `run/events/collisions.log` (the artifact the collision/carry
   radius feeds) is byte-identical, while `run/events/{contacts,energy}.log`, `run/energy/**`,
   `run/motion/position/**` and `run/lifespans.txt` move with it — i.e. the next lane is the one
   that owns the step's energy terms (L8/L6: the brain's energy use and the sensor/nerve set),
   and `missing` is L12's recorders (125 `run/brain/**`, 25 `run/genome/agents/**`, `stats/**`,
   `endReason.txt`, `movie.pmv`).
4. ~~**Lane L5** — `GroupsGenome::createBrain` still throws (its Gaps row names L11 as the caller;
   the adapter itself now exists: `bindings.ts`'s `GroupsGenomeViewAdapter`, so the remaining piece
   is L5's `createBrain` calling it).~~ **RESOLVED — nothing calls it.** The sim grows the brain
   through `NervousSystem.grow( factory )` with `bindings.ts`'s `GroupsGenomeViewAdapter`, which is
   what every Tier-A scenario runs (a real `GroupsBrain` over L5's genome, byte-exact end to end).
   The throw remains a *callerless* stub with its PORT-NOTE (`genome/create-brain-stub`); the same
   verdict is in the Gaps row *L5's `GroupsGenome` does not implement L6's `GroupsGenomeView`
   adapter* (verified 2026-09-29). No work is owed here.
5. ~~**Lane L13 (complexity)** — only reachable when `ComplexityFitnessWeight != 0`; `analyzeBrain`
   throws instead of scoring zero (no recorded scenario sets it).~~ **closed by `t_20d5ff13`
   (2026-09-28)**: both call sites are wired to L13 and neither throws; a worldfile with
   `RecordComplexity`/`ComplexityFitnessWeight` set boots and steps, and the `RecordComplexity`
   fixtures reproduce the native tree byte-for-byte (see `Gaps`).
6. ~~**Lanes L7/L12 (recorders)** — every per-step artifact (`BirthsDeaths.log`, `lifespans.txt`,
   `energy/**`, `motion/**`, `genome/**`, `brain/**`) is the recorder lanes'; `Logs` is constructed
   by this lane through L12's seam, so the wiring exists but the bytes are L12's.~~ **CLOSED** —
   those bytes are the recorder lanes' and they are byte-identical in all six whole-run PASSes
   (`run/brain/**` alone is 1,080 paths on `minitest_voff`; `run/energy/**`, `run/motion/**`,
   `run/genome/**`, `run/lifespans.txt`, `run/BirthsDeaths.log`, `run/events/**`, `run/stats/**` are
   all manifested with `differing=0 missing=0 extra=0`; re-measured 2026-09-29). `Logs` being
   constructed by this lane through L12's seam was the wiring, never a blocker.

## PORT-NOTEs (L11)

| Name | Where | Decision |
|---|---|---|
| `sim/native-field-names` | `simulation.ts` | the class keeps native's field names verbatim (`fStep`, `fDomains`, …) so lane L8's `SimulationLike`, the spec's `file:line` quotes and a reviewer's diff all line up |
| `sim/one-definition` | `src/model/sim/*` | `worldfile`/`interact`/`agents`/`maintain` own their native member functions as free functions over the `Simulation` object; the class stays the state and the loop |
| `sim/ctor-seams` | `simulation.ts` | the proplib boot (documents + the four artifacts) is the caller's; the port performs the same *writes* in the same order through lane L12's `RecordFileSystem`, so the browser needs no `node:fs` |
| `sim/l4-stand-in` | `runner.ts` | **resolved by L4 (2026-09-28)**: the runner's default evaluator (`monitorDocumentEvaluator`) is now lane L4's `interpreterEvaluator`, so the worldfile boot no longer borrows a stand-in. The boot's next measured failure is L11's own `worldfile.ts` `colorOf` stub (see the blocker chain) |
| `sim/log-sim-adapter` | `simulation.ts` | lane L12's `LogSimulation` names the step *reader* `step()`, native's `Step()` advances; the recorders get a small adapter (same object) |
| `sim/direction-constants` | `bindings.ts` | native `objectxsortedlist.h` has `NEXT 1`/`PREV 2`; lane L8's `GObject.PREV` is `0` (native's "unknown direction"), so the adapter maps L8's `PREV` to L10's `PREV` (**defect reported to L8**) |
| `sim/genome-seam-cast` | `fittestList.ts`, `agents.ts` | one cast from L8's narrow `GenomeLike` to L5's concrete `Genome` (the same object at runtime; the factory is what made it) |
| `sim/genome-view-adapter` | `bindings.ts` | L5's `GroupsGenome` as L6's `GroupsGenomeView` — renames, no arithmetic (the adapter the Gaps table assigns to L11) |
| `sim/agentinit-lazy` | `simulation.ts` | native's `agent::agentinit()` (step 11) is the agent class's lazy first-construction initializer in the port |
| `sim/graphics-stubs` | `bindings.ts` | `SimStage`, `NullAgentPovRenderer` — the remaining graphics lanes' objects. The **geometry** one is no longer a stub: `createAgentDeps` binds L15's real `AgentBodyGeometry` over the bundled mesh (PORT-NOTE(sim/geometry-binding), see the L15 section) |
| `sim/fps-skipped` | `simulation.ts` | native step 6's FPS bookkeeping is UI-only (`sim-spec §11.3`); the port does not read the clock inside the model |
| `sim/steps-per-second` | `simulation.ts` | pacing only; the port keeps the field and never lets it influence state |
| `sim/rng-shortcircuit` | `interact.ts` | every draw-bearing condition keeps C++ short-circuit semantics (`IS_PREVENTED_BY_CARRY` with a zero coefficient consumes nothing) |
| `sim/sqrt-cmp` | `interact.ts` | the contact test is native's `sqrt(dx²+dz²) <= r_d + r_c` promoted to f64 |
| `sim/mark-cursor` | `interact.ts` | the cursor/mark discipline of `gXSortedObjects` (Eat/Pickup scan from the mark; `Kill` leaves it one item back) |
| `sim/lifecycle-deferral` | `agents.ts` | `Kill` posts `analyzeBrain` (parallel) and `updateFittest` (serial) exactly like native; inlining them is a measurably different model |
| `sim/simend-kills` | `simulation.ts` | the destructor's `DR_SIMEND` kills are logged model events (the golden's `lifespans.txt` has 23 of them) and are emitted by `dispose()` |
| `sim/kill-delete` | `agents.ts` | native's `delete c` becomes "unreachable" (no `delete` in JS); the list/stage/queue removals that the model observes are done |
| `sim/leastfit-overflow` | `interact.ts` | native can increment `fNumLeastFit` past `fMaxNumLeastFit` (a one-past-the-end write); JS arrays grow, the counter and order are identical |
| `sim/float32-foodmath` | `maintain.ts` | `probAdd`/`fraction`/`growthRate`/`ranFractions` accumulate in `float` in native; `Math.fround` at the same places |
| `sim/food-energy-index` | `maintain.ts` | `FoodEnergyIn/Out` add `e[0]` only (native's single-slot form, with its one-time warning) |
| `sim/worldfile-order` | `worldfile.ts` | the reads are in native order; `NumEnergyTypes` reaches `globals` before any `Energy` exists, and `StaticTimestepGeometry` sets the `NERVOUS_SYSTEM` role to `LOCAL` |
| `sim/parallel-flags` | `worldfile.ts` | `ParallelInitAgents=false`/`ParallelInteract=false` are **refused** with a clear error (unsupported in v1; measured to change the trajectory) |
| `sim/constrain-added-energy` | `agents.ts` | native's three-argument `Energy::constrain(min,max,added)` is emulated as `constrained - before` (lane L8's `Energy` exposes the two-argument form) |
| `sim/carrier-accessor-seam` | `maintain.ts` | `RemoveFood`'s carrier detach calls lane L10's accessor defensively (the environment lane renamed it mid-flight) |
| `sim/destructor-list-clear` | `simulation.ts` | `gXSortedObjects.clear()` has no L10 equivalent; nothing reads the list afterwards |
| `sim/ground-stub` | `simulation.ts` | the ground mesh is the graphics lane's |
| `sim/cppprops-seam` | `simulation.ts` (the `DynamicPropertySet` interface) | native compiles + `dlopen`s `run/.cppprops` and calls `CppProperties_Init( context )` at the ctor and `CppProperties::update()` at `Simulation.cc:648`; the port replaces the compiler with W1h's build-time spec + interpreter and injects the *engine* half — the sim hands itself over where native hands over `context->sim` (`init( sim )` at the ctor's `InitCppProperties` step, `update( sim )` at the update step). Optional: every recorded oracle scenario resolves to no `dyn` property, so without a set both calls are no-ops |
| `sim/cppprops-engine-context` | `cppProperties.ts` | `UpdateContext` is `{ TSimulation * sim; }` (`cppprops.h:32`), so the sim owns it: the runtime values, the two engine callbacks and the storage write-back are served here and the interpreter is consumed as-is (`tools/cppprops/lib/cppprops.mjs`, never reimplemented). A missing binding or an unsourceable runtime property is a `CppPropertiesRefusalError` at the native point — W1h's exit-3 contract, never a silent 0 |
| `sim/cppprops-live-patch-counts` | `cppProperties.ts` | the interpreter's `ctx.patchAgentInsideCount( domain, patch )` reads `engine.patchAgentInsideCount[ "<domain>.<patch>" ]` (the CLI's table shape, which a *recording* justifies); the sim serves the same shape as a live `Proxy` over `FoodPatch::agentInsideCount`, so the ring reads the field itself — and therefore needs no `stepShift`: the field at the step's start *is* the previous step's accumulation (`Simulation.cc:1701`/`:1842-1850`) |
| `sim/cppprops-live-runtime-values` | `cppProperties.ts` (`update`) | the interpreter's phase rule applies the values it is *fed* after the update, because a caller holding a recording can only supply the printed (end-of-step) values. A live caller has the numbers native's pointers hold, so the sim seeds the interpreter's storage with them (at the variable's own width — `float`/`int`/`bool`) before the single `step()` call: the bodies then read exactly what `*((int*)metadata[i].value)` would, and the tail re-application is a no-op. Measured: without the seeding the same run diverges from step 187 (`B0Z2`), one step late |
| `sim/cppprops-storage-writeback` | `cppProperties.ts` | a dynamic property's cpp symbol is a *pointer into the model* (`context->sim->fDomains[0].fFoodPatches[i].on`, `barrier::gBarriers[i]->getPosition().zb`), so a changed value must change the model: the port resolves those two shapes and writes the live member (`FoodPatch::setOn`, the barrier's `LineSegment`, whose setters narrow to native's `float`). A symbol the port has no object for stays in the property table — still published, unable to reach the simulation — and is listed on `unresolvedStorage` so the limit is auditable. Measured: none for the recorded `dyn` worlds; the `FoodCount` 90 → 0 → 90 column is only reproducible with the `on` write-back in place |
| `sim/brain-local-rng-provider` | `bindings.ts` (`nervousSystemFactory`) | native `GroupsBrain::init()` sets the two wiring roles to `LOCAL` and `growSynapses` calls `RandomNumberGenerator::create( role )` once per call — a fresh `gsl_rng_alloc( gsl_rng_mt19937 )` (GSL's default seed 4357), then `seedIfLocal()`-ed from the genome's per-connection seed gene. Lane L6 exposes exactly that as `GroupsBrainOptions.rngProvider`; without a provider the brain throws where native would have drawn, so the sim (which owns the ctor's `initBrain()` step) supplies it from lane W1d's `createMt19937Stream()`. The recorded Tier-A scenarios keep both flags `False`, so no frozen artifact is affected |
| `sim/position-seed-unused`, `sim/static-sort-stable`, `sim/event-null-pointers` | throughout | carried over from sim-spec §13, all implemented as specified |
| `sim/ijfitinc-short` | `agents.ts` | native's `ijfitinc` takes `short`s; the port narrows the results to Int16 |
| `sim/retina-sensor`, `sim/retina-sensor-name` | `retinaSensor.ts` | native `agent::grow` constructs the retina **unconditionally** (`agent.cc:570`) and registers it as the *first* sensor, and it is a model object, not a graphics one: `Retina::sensor_prebirth_signal` (`Retina.cc:45-53`) draws `retinaWidth * 4` values off the nervous system's own RNG **before every other sensor's draw** (`NervousSystem::prebirthSignal` walks `SensorList` in insertion order), and `sensor_update` writes the buffer into the `Red`/`Green`/`Blue` input nerves. With `Vision False` that buffer is never refreshed, so those nerves carry the prebirth noise forever — the draw count is a stream contract, so a vision-off run is **not** byte-exact without the retina. Native `Sensor` has **no** name field (`brain/Sensor.h`); the only name on this path is `Nerve::name`, which `Channel::dump_anatomical` rewrites to `<lowercased-first-letter>input`. Lane L8's `SensorLike` asks for a `sensorName` that nothing in the runtime reads, so the retina is labelled `Retina`. The `Sensor` shell lives in the sim lane because the sim is the lane that can bind it without editing L9's file; lane W1j/L16's `VisionRetina` (`src/model/vision/retina.ts`) is the one implementation it wraps |
| `sim/nerve-set-binding` | `bindings.ts` | native `Nerve` has **two** `set`s — `set( double activation, buf )` (the sensors' form: `numneurons == 0` returns, else `assert( numneurons == 1 )` then `set( 0, activation, buf )`) and `set( int ineuron, double activation, buf )`. Lane L8's `NerveLike` declares only `get()`/`set( value )`, which is what its six proprioceptive sensors call, while lane L6's `Nerve` ports the *indexed* form; handing L8 the raw L6 nerve made `nerve.set( energy )` mean "set neuron number `energy`" (measured: `Nerve 'Energy': index 1 out of range` as soon as an agent's normalized energy reached 1.0). The sim hands L8 a facade whose `set` dispatches on arity and which carries `name`/`getIndex()`/`getNeuronCount()` because the one sensor that is not L8's — the retina — caches its channel nerves and then reads each one's neuron count and bone index (`Retina::Channel::init`, `Retina.cc:160-178`). Without those accessors the retina's `sensor_grow` was the boot's wall (`channel.nerve.getNeuronCount is not a function` at `vision/retina.ts`) |
| `sim/sensor-dump-defaults` | `bindings.ts` | native `Sensor::sensor_start_functional` and `sensor_dump_anatomical` are *non-pure* virtuals with **empty** bodies (`brain/Sensor.h:19-20`) and only the retina overrides them. Lane L8's sensors are faithful to that (their `AgentSensorLike` has neither), while lane L6's `Sensor` declares both as required, so the sim gives a sensor that does not define them native's empty body |
| `sim/cns-rng-adapter` | `bindings.ts` | native has **one** `RandomNumberGenerator` behind `NervousSystem::getRNG()`. Lane L6 asks for the frozen `RngSurface` and lane L8 for `NervousSystemRngLike` (`drand()`, `seedIfLocal()`, plus `range(lo, hi)`, which is what `Retina::sensor_prebirth_signal` draws with); both seams are served by one object over lane L1's `RandomNumberGenerator`, exactly as native serves them from one class |

## Gaps (lanes that close them)

| Gap | Closes with | Note |
|---|---|---|
| The run tree cannot be produced (no parity verdict) | ~~L4 (proplib expressions)~~ **landed** → L11's `worldfile.ts` `colorOf` stub → L15 (agent mesh) → L5 (`createBrain`) → **L12** (recorders) | the blocker chain above; each is a different lane's file. L4 closed the worldfile boot on 2026-09-28 (`t_877ad984`) |
| ~~`NullBodyGeometry` (agent mesh / collision radius)~~ **closed by L15 (2026-09-28)**: the class is deleted and `createAgentDeps` binds L15's real `AgentBodyGeometry` (the bundled `etc/objects/agent.obj`, bit-exact for all 112 recorded agents). `AgentDeps.geometry` is still injectable for a lane test | `src/model/geometry/body.ts` | closed — see the L15 section |
| ~~`simulation.ts`'s ctor `sqrt` discipline (the ctor's `maxagentlenx`/`maxagentlenz`/`maxagentradius`, and `maxfoodradius`'s `maxfoodlen * maxfoodlen * 2.0`)~~ **closed (2026-09-28)**: `Simulation.cc:321-325` computes all five in **float**, and both halves are now native's. The agent half landed in `t_2a625bd5` (`f32(...)` stores + `f32Fma` for `0x892a8 fmadd`); the food half in `t_1d2cd75d`, which is three width decisions wide — `float maxfoodlen = 0.75 * gMaxFoodEnergy / gSize2Energy` narrows once (`0.75` is a *double* literal), `maxfoodlen * maxfoodlen` is a `float * float` that rounds to binary32 **before** the `* 2.0`, and the `float maxfoodradius` store narrows the double root again. Measured, not read off a log: `src/model/sim/native/foodradiusprobe.cc` (via `run_foodradiusprobe.sh`) boots the real `TSimulation` and prints every field as a bit pattern — on the recorded worldfiles (`MaxFoodEnergy` 1000, `FoodEnergySizeScale` 400, both exact) native's `0.5*sqrt(…)` is the double `0x1.536948017481p+0` (`0x3ff5369480174810`) while the stored `food::gMaxFoodRadius` is the float `0x1.536948p+0` (`0x3fa9b4a4`), so the port was storing the **un-narrowed double**; and on a probe worldfile that forces inexact inputs (`1000.5` / `300.3`) the missing roundings cost a **1-ulp binary32** (`0x3fe22941` against the oracle's `0x3fe22942`). Not cosmetic: `gMaxFoodRadius` **is** model-visible (`agent.cc:1971` divides by it in the carried-food energy term, and `Simulation.cc:2613`/`:2623` prune the x-sorted contact walk on `2.0*gMaxFoodRadius`). No golden moved — the `%g` at `Simulation.cc:1469` carries six significant digits and neither recorded worldfile separates the spellings: `microtest_voff` **PASS 225/225**, `minitest_voff` **PASS 1369/1369**, `hello` **PASS 19/19**, `minitest_adami` **PASS 1373/1373**, `microtest_von` **PASS 225/225**, every one `differing=0 missing=0 extra=0`. Pinned by `tests/sim-ctor-food-radius.test.ts` (three bit patterns per row + a live ctor read) | L11 | closed — measured on L15's side for the agent half (`src/model/geometry/native/sqrt_discipline.py`) and on L11's own probe for the food half |
| `SimStage`, `NullAgentPovRenderer`, `run/movie.pmv` | L15/L16/L9 | not frozen / vision-off |
| ~~`analyzeBrain`'s complexity call, `AgentFitness`'s weighted branch~~ **closed by `t_20d5ff13` (2026-09-28)** | `src/model/sim/agents.ts` | both call sites are wired to lane L13's `calcComplexityBrainfunction` and neither throws. `analyzeBrain` reads `brainAnalysisParms.functionPath` (which lane L12's begin-event handler fills synchronously) with `parts = fComplexityType` (`D` = two `events == NULL` reads and a float difference; `Z` = nothing at all), narrowing at `agent::SetComplexity( float )`; `AgentFitness` folds in its lazily re-read `run/brain/function/brainFunction_<n>.txt` when `Complexity() < 0`, through the contracted `f32Fma` at `0x9b260`. The read-back is an injected seam (`SimulationOptions.brainFunctionBytes` — `readAbstractFileBytes` in the runner — because `RecordFileSystem` is write-only), and a shell that injects none **refuses** the analysis rather than scoring a zero. Pinned by `tests/sim-complexity-seam.test.ts` (analyzeBrain over the committed native differential for A/P/I/B/D, the `Z` skip, the empty-path refusal, the contraction's exact-rational cases, and an end-to-end `minitest_voff` + complexity-keys boot to step 301). Measured against the native build on a **synthesized** fixture — no recorded scenario sets these keys: `--ComplexityType "P"|"D"|"Pe"|"Z" --RecordComplexity True --RecordNeuralComplexityFiles True` on `worldfiles/tests/low-spec-pc/minitest.wf` reproduces the native run tree **byte-for-byte** (1373/1373, 1371/1371, 1373/1373, 1369/1369 files identical; the only extra native files are `.cppprops/**`), including every `run/brain/Recent/<epoch>/complexity_<type>.plt` — the first whole-run evidence for the `Pe` event-filter path, which the recorded scenarios never build (`fEvents` is only constructed for a lowercase `ComplexityType` letter). Residual closed by `t_077f3e96` (2026-09-28): with `ComplexityFitnessWeight != 0` the weighted branch now has its whole-run differential — the same fixture's run tree matches native with **differing=0** once `initFitnessMode` is transcribed (see the next-but-one row) |
| ~~`initFitnessMode`'s forced-GA parameter list~~ **closed by `t_077f3e96` (2026-09-28)** | `src/model/sim/worldfile.ts` | `initFitnessMode` is now native's function (`Simulation.cc:4638-4653`) line for line: `fMinNumAgents = fMaxNumAgents = fInitNumAgents` (the instance min and the **static** max, through the same writer `processWorldFile` uses for `MaxAgents`), each domain's `minNumAgents = maxNumAgents = initNumAgents`, `fNumDepletionSteps = 0`, `fMaxPopulationPenaltyFraction = 0.0`, `fApplyLowPopulationAdvantage = false`, `fEnergyBasedPopulationControl = false`, `fEndOnPopulationCrash = false`; native's `cout` block (`4655-4671`) prints those same fields and is **stdout only** (stdout is not part of the frozen contract), so it is not ported. The old body's five assignments (`fNumberToSeed`/`fNumberBorn`/`fNumberCreated = 0`, `fEpoch = fEpochFrequency`, `fFitness2Frequency == 0xFF` → `0`) are in **no** native function — `fEpoch = fEpochFrequency` is `processWorldFile` (`Simulation.cc:3913`, already ported at `worldfile.ts:144`) and nothing in native zeroes `fFitness2Frequency` (it is a plain `long` frequency, `Simulation.h:295`, read as `PairFrequency`) — and they are deleted. **Measured whole-run, on the `t_20d5ff13` fixture** (`minitest_voff` + `--Vision False --ComplexityType "P" --RecordComplexity True --RecordNeuralComplexityFiles True --ComplexityFitnessWeight 0.5 --HeuristicFitnessWeight 0.5`) against the shipped native build run in an isolated symlink farm: before, the two `BirthsDeaths.log`s agree through step 12 and then the port kills agent 23 at step 18 `FIGHT` where native keeps it to step 227 `NATURAL` (5 deaths against 23), **141 identical / 78 differing** run-tree files; after the transcription the same pair of runs is **755 identical / differing=0**, the only native-only path being `run/movie.pmv`, which `PORT_SPEC.md` declares free. No recorded scenario can be affected, and that is **asserted, not assumed**: a runtime probe boots each of the six through the port's own ctor and reads the gate and the forced fields — all six carry `ComplexityFitnessWeight 0.0` / `HeuristicFitnessWeight 0.0`, so the ctor's condition (`Simulation.cc:292`) is false, `fEnergyBasedPopulationControl` keeps its worldfile value `true`, `fMinNumAgents` keeps the worldfile's 20 (`hello`: 90) and the domain keeps `20/25` (`hello`: `90/300`); the same probe on the fixture reads `0.5`/`0.5` and comes out `fMinNumAgents` 20 → 25, `fEnergyBasedPopulationControl` `true` → `false`, domain `20/25` → `25/25`. Pinned by `tests/sim-fitness-mode.test.ts` (the eight forced writes, over a stub whose initial values all differ from the forced ones — `fMinNumAgents` 20, `fNumDepletionSteps` 7, `fMaxPopulationPenaltyFraction` 0.5, both switches `true`, two domains — plus the five non-native fields asserted *unchanged*, and the six recorded worldfiles' two weights read through the port's own document builder). Six-scenario milestone re-PASSed unchanged: 225/225, 1369/1369, 225/225, 1308/1308, 19/19, 1373/1373, `differing=0 missing=0 extra=0` throughout |
| `SeedGenomeFromRun` (`genomeSeeds.txt`), `SeedPositionFromRun` (`seedPositions.txt`) | L17/L2 | no recorded scenario sets them; the sim throws with the reason |
| `MateLockstep`'s birth half (genome draw + `Birth`) | L11 (follow-up) | only reachable with `PassiveLockstep`, which no scenario uses; the death half is ported |
| `run/genome/genestats.txt`'s body, `run/genome/separations.txt` | L12 | the sim provides `getGeneStats()` and the separation cache events |
| `Events`' per-step map order (`std::map<long,AgentEvent>`, `utils/Events.h:23`, held by `Simulation.h:141` — a *different* map from `BrainComplexityLog`'s `ComplexityMap`, which is pinned by PORT-NOTE `l12/complexity-row-order`) | L11/L12 | unreachable without complexity event filtering (both scenarios: `ComplexityType` uppercase) |
| The status text (`getStatusText`, 388 lines) and `Dump()`/`pw.dump` | not scheduled | read-only formatting / a checkpoint format `fLoadState` never enables |
| The static recorders, movies, farm monitor properties | L14/L17/L18 | monitors consume no RNG (sim-spec §5.8) |

## PORT-NOTEs (W1h cppprops at build time) and lane evidence

Native runs compile a C++ property library at **run** start: `CppProperties::init()`
(`Simulation.cc`) writes `run/.cppprops/generated.cc`, shells out to `make` + `clang++`
(~6 s of every run) and `dlopen`s the result. That step cannot exist in a browser, so
W1h replaces it with **data emitted at build time plus an interpreter**.

### The mapping

```
worldfile + schema ──extract_cppprops.py──▶ cppprops.json ──lib/cppprops.mjs──▶ property values
      (build time, python)                       (data)            (run time, no compiler, no dlopen)
```

* `tools/cppprops/lib/proplib.py` — the proplib subset `cppprops.cc` walks, ported:
  `parser.cc` (tokens carry decorations: `run/.cppprops/generated.cc` preserves the
  worldfile's whitespace *and comments* byte for byte, and `//` is **not** a comment in
  this grammar — only `#` is), `dom.cc` (`findSymbol`, `getFullName`), `builder.cc`,
  `schema.cc` (`injectClasses`, `default`/`defaults`/`@defaults`, runtime injection) and
  `interpreter.py`'s `eval()` of a substituted expression. `convert.cc`'s V2 fixups are
  ported; V1 worldfile syntax and `overlay` are refused by name (lane L3's).
* `tools/cppprops/lib/cppprops_model.py` — `cppprops.cc`'s four emitters plus
  `getCppSymbol`'s `$[sim]`/`$[index]`/`$[ancestor]`/`$[gene,…]` macro expansion, the
  metadata walk (pre-order DFS, `strcmp` child order, array indices in order) and
  `sortDynamicProperties`' antecedent sort.
* `tools/cppprops/extract_cppprops.py` — the CLI. `--crosscheck <generated.cc>`
  byte-compares against a `generated.cc` captured from a real native run; a mismatch
  prints the first differing hunk and exits 1. **Measured: byte-identical on all four
  scenarios** (minitest_voff 2,593 B, microtest_voff 2,593 B, growers_small 7,927 B,
  growers_dyn 7,924 B — three bytes fewer because the gate `10000` became `10`).
* `tools/cppprops/lib/cppprops.mjs` — the run-time side. `Runtime` properties take the
  model's values; `Dynamic` properties are evaluated in the native update order, with
  the native exact-`!=` write-if-changed store, `Math.fround` at the `float` boundary,
  and `PropertyMetadata::toString()`'s rendering (`%d`, `%g`, `True`/`False`; `STRING`
  throws exactly where native asserts).
* `tools/cppprops/bindings/**` — for bodies the extractor cannot reduce to the
  interpreter's C++ subset. The extractor names the first offending symbol
  (`FoodPatchTokenRing::update`, `context->sim->fDomains[ 0 ].fFoodPatches[ 0 ]`, …),
  and `run_cppprops.mjs` **exits 3** for an unbound one instead of guessing.

PORT-NOTE(cppprops): run-time code generation + `dlopen` becomes a build-time JSON spec
plus an interpreter; no compiler is invoked at run time.
PORT-NOTE(cppprops): property order is lexicographic by name with arrays in index order
(native `std::map`) and it *is* the metadata index assignment dynamic bodies read.
PORT-NOTE(cppprops): dynamic bodies are the native C++ text, interpreted; the body text
is not rewritten into another language, and only
`*((T*)metadata[/*name*/ i].value)` is mechanically resolved.
PORT-NOTE(cppprops): `bool` renderings are `True`/`False`; C++ `true`/`false` literals
in a body come from a resolved Python `True`/`False` constant (native does the same
substitution).

### Acceptance evidence (executed)

`python3 tools/cppprops/verify_cppprops.py` → **7/7 scenarios pass** (301x4 + 1x4 + 300x9 + 300x10 + 300x9 + 300x9 + 301x5 values) and 5/5 hand-maintained worldfile pins:

| scenario | steps | properties | native oracle | verdict |
|---|---|---|---|---|
| minitest_voff | 301 | 4 (all `Runtime`) | `fixtures/native/minitest_voff.farm.log` | values identical |
| microtest_voff | 1 | 4 | `fixtures/native/microtest_voff.farm.log` | values identical |
| growers_small | 300 | 9 (4 `Runtime`, 5 `Dynamic`) | `fixtures/native/growers_small.farm.log` | values identical |
| growers_dyn | 300 | 9 | `fixtures/native/growers_dyn.farm.log` | values identical |
| gene_dyn | 300 | 10 (6 `Dynamic`, incl. the gene-bound property) | `fixtures/native/gene_dyn.farm.log` | values identical (gene table read out of the run's own `generange.txt`) |
| growers_ring | 300 | 9 (per-step engine input) | `fixtures/native/growers_ring.farm.log` | values identical |
| two_metabolisms | 301 | 4 sampled (5 `Runtime` in the spec) | `fixtures/native/two_metabolisms.farm.log` | values identical |

Each scenario is (1) extracted from its **worldfile**, (2) byte-compared against the
`generated.cc` a real run produced, then (3) replayed through `run_cppprops.mjs` with
`PATH=/nonexistent` — the child cannot reach `clang`, `make`, `python` or the native
tree, which is what "no compiler invoked at run time" means here. The recorded traces
are: the farm log (`PropertyMetadata::toString()`, the cppprops path — the oracle) and
the per-step state parsed from `Simulation::getStatusText()` (a different code path — the
evaluator's input), so the comparison is not circular.

`growers_dyn` exists because the frozen `growingBarriers.wf` gate (`if( Step < 10000 )`)
keeps the dynamic branch out of reach in a 300-step run: with the gate moved to
`Step < 10`, `Barriers[0].Z2` walks -1 → -0.970895 (292 distinct values, i.e. `%g` at 6
significant digits over 300 steps), `Barriers[1].Z2` follows it through the antecedent
ordering, and the food-patch token ring holds `True/False/False` for all 300 steps. It is
recorded by `tools/cppprops/fixtures/harness/record_scenario.py`, which runs the native
binary from a mirror tree (symlinks into the native tree + this lane's `term.mf` +
`PWFARM_STATUS`), so the native tree is never modified and the goldens stay reproducible.

`two_metabolisms` exists because the metabolism-count replay input used to be an inference.
`Simulation::getStatusText` prints ` -<Name> = <n>` per metabolism from
`fNumberAliveWithMetabolism[i]`, but **only when `Metabolism::getNumberOfDefinitions() > 1`**
(`Simulation.cc:4894-4904`), and every worldfile recorded before it defines a single
metabolism — so `runtimeMap` fed `AgentMetabolisms[0].MetabolismAgentCount` from the `agents`
count. This fixture (minitest.wf + `AgentMetabolisms [ { Name "Alpha" } { Name "Beta" } ]` +
`AgentMetabolismSelectionMode Random`; the first 17 lines are byte-identical to minitest.wf)
makes the native print them and `record_scenario.py` record them as per-step `metabolism<j>`
keys, so the scenario's `runtimeMap` points the property at the recording instead. Numbers:
step 1 is `agents = 25`, ` -Alpha = 12`, ` -Beta = 13`, farm `Alive0 = 12`; `metabolism0`
differs from `agents` at all 301 steps (min 11, max 15, median 13); the recorded mapping
matches at all 301 steps, the old `agents` mapping fails at step 1 (interpreter 25, native 12).

`growers_ring` exists because a passing comparison is not the same as an exercised input. The
`FoodPatchTokenRing` binding reads `FoodPatch::agentInsideCount` from the engine context, and
until now nothing recorded it, so the binding ran on the default 0 — and `growers_dyn` holds
`P0On=True, P1On=P2On=False` for all 300 steps, so the default could not be told apart from a
real reading. `Simulation::getStatusText` already prints the counts (`  FP<i> <foodCount>
<agentInsideCount> <inside+neighborhood> <pct…>`, `Simulation.cc:5183-5214`, gated on
`fCalcFoodPatchAgentCounts` which the ctor hard-codes true at `Simulation.cc:203`), so no native
change was needed — `record_scenario.py` now keeps those lines as a per-step `foodPatches` block,
`verify_cppprops.py` turns it into a per-step engine table (`engineFromState` → `run_cppprops.mjs
--engine`, shape `{"steps": {"<step>": {"<table>": {…}}}, "defaults"?: {…}}`; the old static table
still works and is honoured — perturbing it on `growers_dyn` turns all three patches off at step 2),
and this fixture is `growers_dyn` with the first ring lowered to `add( FoodPatches[0], 2, 20, 5 )`
so it switches 35 times inside the window through all three branches (12 maxPopulation +
delay-window, 12 delayEnd `findActive()`/`onActivatePatch` deaths — alive 181 → 139 at step 7, the
run's ` -patch` counter non-zero — and 11 timeout/immediate). Both directions: recorded inputs →
all 300 farm lines exact; input 0 → first divergence at **step 2** (`FoodPatches[0].On`:
interpreter `True`, native `False`; 222/300 steps diverge). The alignment is the arbiter's, not a
fit: counts accumulate at the end of a step (`DeathAndStats`, after the agents move, reset at
`Simulation.cc:1701`, accumulated at `1842-1850`) while `CppProperties::update()` runs at the start
of one (`Simulation.cc:648`), and `stepShift = -1` is the only shift that reproduces the log
(shift 0 diverges at step 26, +1 at step 25). The fixture also caught two defects — the binding
never parsed its `add()` parameters, because the worldfile's inline `//` comments *are* the
argument text, so they became `NaN` and `NaN > 0` silently disabled every switching branch (the
earlier "consistent" result was vacuous, not merely unproven); and a `dyn` body must be evaluated
against the previous step's runtime values (`Step` excepted), pinned by this fixture's own
`Barriers[0].Z2` (grows at step 187; the printed `AgentCount` crosses 175 at 186) — see
`docs/specs/cppprops.md` §3 and §8.2.

### What is verified vs assumed

* **Verified:** the emitted C++ is the native text (byte-exact, 7/7 — the seven recorded
  traces, `gene_dyn`'s schema location included); the metadata order,
  indices, `cppSymbol` bindings and dynamic bodies in `cppprops.json` are the ones the
  native build used; the interpreter reproduces every recorded native value, including
  the `float` walk of `Barriers[0].Z2`.
* **Verified (was assumed, closed here):** `AgentMetabolisms[0].MetabolismAgentCount` is fed
  from a **recording** of `fNumberAliveWithMetabolism[ Metabolism::get( 0 )->index ]` — the
  status text's ` -<Name> = <n>` line, whose print order *is* the definition order (the names
  printed are Alpha then Beta, and the independent farm column `Alive0 = 12` agrees with
  Alpha, not with Beta's 13). The four single-metabolism scenarios keep the `agents` mapping,
  now on measured ground rather than on agreement that could not distinguish the two:
  `metabolism0 + metabolism1 == agents` at 301/301 steps of `two_metabolisms` (births and
  deaths included), i.e. the counts *partition* the alive agents, so with a single definition
  the one term of that partition is the total.
* **Verified (was assumed, closed here):** the `FoodPatchTokenRing` binding's `agentInsideCount`
  input is *recorded*, not assumed. `getStatusText` prints the per-patch counts
  (`Simulation.cc:5183-5214`, `fCalcFoodPatchAgentCounts` hard-coded true in the ctor) and
  `record_scenario.py` now keeps them per step (`foodPatches`, keyed `<domain>.<patch>`);
  `growers_ring` (`growers_dyn.wf` with the first ring's `add( FoodPatches[0], 150, 2000, 400 )`
  lowered to `( 2, 20, 5 )`) makes the ring switch patch 35 times — 12 maxPopulation triggers
  with their delay window, 12 delayEnd activations, 11 timeout/immediate switches — so the
  input is exercised instead of constant. Measured three ways: the recorded per-step table
  reproduces all 300 farm lines; reading step N's counts instead of step N-1's diverges at
  step 26 (`FoodPatches[1].On`); every count 0 diverges at step 2 (222/300 steps). Two
  *further* defects fell out of writing it, both fixed in `tools/cppprops/**`: the binding
  never parsed `add()`'s parameters (the worldfile's inline `//` comments were captured as the
  argument text, so `maxPopulation`/`timeout`/`delay` were `NaN` and every switching branch was
  silently off — the earlier fixtures agreed for the wrong reason), and a `dyn` body must be
  evaluated against the *previous* step's runtime values (`Step` excepted; the farm log's own
  `B0Z2` column pins that at step 186/187: it reads the count printed one step earlier).
* **Assumed, and flagged:** the `onActivatePatch` kill (agents inside the newly active patch
  die) is still *delegated*, never replayed — the interpreter reports the chosen patch and
  does not kill. `growers_ring` records the native consequence (`-patch` deaths reach 67; the
  alive count drops 181 → 139 at step 7) but nothing in the port produces it.


# Lane L15 — the agent body mesh (`src/model/geometry/body.ts`, native `graphics/gpolygon.cc`)

Owner: L15 (`t_08aceedd`). Scope of this pass: the **model-visible** half of the graphics lane —
the mesh `agent::SetGeometry()` derives the collision radius from. The renderer half (`gstage`,
the draw calls, L16's rasterization) is unchanged and still open.

## Why this is not graphics

`agent::agentinit()` (`agent.cc:314-324`) loads `etc/objects/agent.obj` into `agent::agentobj`
through `Resources::loadPolygons`; `agent::grow()` → `agent::SetGeometry()` (`agent.cc:993-1013`)
then clones it, scales every vertex in place by `fLengthX = Size()/sqrt(maxSpeed)`,
`agentConfig.agentHeight`, `fLengthZ = Size()*sqrt(maxSpeed)`, and calls the **virtual**
`setradius()` — which resolves to `agent::setradius()` (`agent.cc:786-792`, the `x`/`z` diagonal,
*not* `gpolyobj`'s 3-D one at `gpolygon.cc:249-254`) → `fRadius`, copied to `fCarryRadius`.
Those two floats are read by the contact test, `Prey`/`Predator`/`Avoid`, the barrier pass
(`FF * CarryRadius()`) and every collision event, so they decide `run/motion/**` and
`run/events/*.log` bytes.

## What landed

| File | Contents |
|---|---|
| `src/model/geometry/body.ts` | `parsePolyObjFile` (native `operator>>( const char*, gpolyobj& )` / `operator>>( istream&, opoly& )`: the `pw1` header, the polygon/point counts, `count*3` float tokens, native's `error(1,…)` branches as throws) and `AgentBodyGeometry implements BodyGeometryLike` (`cloneGeometry`, `scaleVertices`, `lengths` = `gpolyobj::setlen`'s box, `radiusScale`/`scale`/`radiusFixed`, plus the `gpolyobj` radius state and the vertex readers L16 needs) |
| `src/model/geometry/golden/nativeBodyMesh.ts` | **generated**: `etc/objects/agent.obj` **verbatim** (+ its sha256), the template's vertices/bounds/radius, and `NATIVE_AGENT_BODIES` — 112 recorded agents' `size`/`maxSpeed`/`lengthX`/`lengthZ`/`lx`/`ly`/`lz`/`radius`/`carryRadius` |
| `src/model/geometry/native/bodyprobe.{cpp,sh}` | the probe: real `Resources::loadPolygons`, and for each recorded agent a **real `agent` object** (`#define protected public`, `new agent( NULL, NULL )`) whose `geneCache` is filled from the **recorded `genome/agents/genome_<n>.txt.gz`** read by the real `Genome::load()`, then the real `agent::SetGeometry()` |
| `src/model/geometry/native/make_body_mesh_module.py` | probe output + the verbatim `.obj` → the golden module |
| `src/model/geometry/native/sqrt_discipline.py` | the measurement that settled the `sqrt` discipline below (re-runnable, no build needed) |
| `tests/geometry.test.ts` (9 new tests) | the replay: the parser, the bundled bytes, native's refusal branches, the radius fix/unfix rule, the bounding box for all 112 agents, and the **radius through lane L8's ported agent** |

`src/model/sim/bodyGeometry.ts` is now a thin binding onto this module (it was written by the L11
worker while this lane was blocked; its own comment predicted this swap). `createAgentDeps` binds
`geometry`/`bodyTemplate` from it and `NullBodyGeometry` — the throwing stand-in — is deleted.

## Evidence (this run, this machine)

```
$ npx vitest run tests/geometry.test.ts        # 47 passed (47): 38 camera/frustum + 9 body
$ npx tsc --noEmit                             # exit 0 (whole tree)
$ npx vitest run                               # 498 passed | 1 skipped (whole project, this run;
                                               #  the count moves as other lanes land)
$ bash src/model/geometry/native/bodyprobe.sh all --ts   # regenerated; byte-identical
  bodyprobe: mesh 10 polys / 40 points, microtest_voff=25, minitest_voff=87 bodies
$ npx tsx src/model/sim/runner.ts microtest_voff <out>   # steps=1, ok=true  (was: blocked)
$ ./oracle/run_parity.sh microtest_voff --candidate <out>   # measured 16:34, tree as it stood then
  matched 18, differing 54, missing 153, extra 150, exit 1
  # first divergence: run/energy/agents/agent_1.txt line 11 (step 1), column Energy
  #   golden 739.669067   candidate 739.874573
$ cmp <golden>/run/events/collisions.log <out>/run/events/collisions.log   # identical
```

The 112-agent replay is the lane's bit-exact claim: `fLengthX`/`fLengthZ`/`fLength[0..2]`,
`fRadius` and `fCarryRadius` all equal the native values **as float32 bit patterns**. The
`collisions.log` identity is the parity-visible consequence: that file's `barrier` rows come from
the barrier pass, which tests `FF * CarryRadius()`.

## The defect this pass found (and fixed in lane L8's file)

`agent::SetGeometry`'s two roots are `float` arguments, so the oracle's build inlines the
**single-precision** `fsqrt` (Apple's libc++ declares the `float` overload of `sqrt`; measured, not
assumed). Lane L8's port used `Math.sqrt` (double) and narrowed once at the store, which makes the
following `/` and `*` *double* operations — 1 ulp off on **7** of the 112 recorded agents'
`fLengthX` and **13**'s `fLengthZ`, and therefore off in every scaled vertex, the bounding box and
the collision radius of those agents.

```
$ python3 src/model/geometry/native/sqrt_discipline.py
fLengthX: double-sqrt matches 105/112, float-sqrt matches 112/112 (differ on 7)
fLengthZ: double-sqrt matches  99/112, float-sqrt matches 112/112 (differ on 13)
carryRadius == radius: 112/112
radius variant two-step, double sqrt, halve after   112/112
radius variant two-step, float  sqrt, halve after   112/112
radius variant fma sum,  double sqrt, halve after   111/112
radius variant fma sum,  float  sqrt, halve after   111/112
```

So (a) the roots are single-precision. **(b) was wrong, and is corrected here** (contraction sweep,
t_981fcace): the previous text read *“`agent::setradius`'s `fLength[0]*fLength[0] +
fLength[2]*fLength[2]` is **not** contracted (the `fma` reading is 1 ulp off)”* — the shipped
`__ZN5agent9setradiusEv` **does** contract it: `21f44 fmul s1, s1, s1` rounds `fLength[2]^2` and
`21f48 fmadd s0, s0, s0, s1` keeps `fLength[0]^2` exact, i.e. `f32(lx*lx + f32(lz*lz))`. What the
111/112 above measured is a *different* candidate: this script's `fma(a, b, c)` evaluates `a*b + c`
in a Python **double** and rounds once, which keeps **both** products exact, while the binary rounds
`fLength[2]^2` in a separate `fmul` **before** the `fmadd` — the “read which operand the `fmul`
takes” trap (*the contraction sweep* below). An independent check of the same 112 rows
(`dis/check_radius_112.py`, exact rational arithmetic) gives: two-step sum 112/112, the binary's
contracted sum 112/112, that `fma`-both-exact candidate 111/112 — so the recorded goldens cannot
separate the two forms and the single miss was read as evidence for the wrong one. PORT-NOTE
`L8/sqrt-of-a-float-is-single-precision` in `src/model/agent/agent.ts` records the
single-precision-roots half (the part of this paragraph that was right), and the fix there is
two lines (`f32(Math.sqrt(…))` before the division/multiplication); the square sum belongs to
`setRadius`, and is fixed by the sweep with its addresses, rates and pins.

Sibling sites audited for the same flaw, since a `sqrt` of a `float` argument is the pattern:

* `agent::UpdateBody` (`agent.cc:1435`) and `GetCollisionFixedCoordinates` (`agent.cc:1353/1374`)
  are already narrowed by their outer `f32(...)` — the double rounding is innocuous for `sqrt`
  (intermediate precision 53 ≥ 2·24+2), so those are correct as written.
* `Simulation.cc:321-325` (**lane L11's** ctor step 13) was *not* narrowed: `maxagentlenx =
  maxAgentSize / sqrt( minmaxspeed )` is a float division by a float root in native, and the port
  divided by the double root; `maxfoodradius` (`:325`) additionally rounds `maxfoodlen *
  maxfoodlen` to a `float` before `* 2.0`, and stores a `float`. Both feed `agent::config.maxRadius`
  (the vision frustum radius) and `food::gMaxFoodRadius`, which **is** model-visible
  (`agent.cc:1971` divides by it in the carry food energy). Reported here, not fixed — it was L11's
  file and needed its own measurement. **Both halves are now closed**: the agent half by
  `t_2a625bd5` (round 5 above) and the food half by `t_1d2cd75d`, whose probe
  (`src/model/sim/native/foodradiusprobe.cc`) measured native's stored `gMaxFoodRadius` at
  `0x3fa9b4a4` against the `0x3ff5369480174810` double the port had stored, and a 1-ulp binary32
  error (`0x3fe22941` vs `0x3fe22942`) on inexact inputs — see the L11 Gaps row.

## PORT-NOTEs (W1e body mesh)

| PORT-NOTE | File | Decision |
|---|---|---|
| `W1e/body-mesh-is-model-visible` | `body.ts` | the mesh, the scaling, the box and the radius state are ported here because the model reads them; the agent's own radius rule stays in `agent.ts` where native has it |
| `W1e/polyobj-throws-not-exits` | `body.ts` | native's loader `error(1,…)` → `PolyObjFormatError` with native's wording (`unknown type`, `invalid number of polys`, `premature end-of-file`, `_fail reading polyobj file`) |
| `W1e/pw1-text-reader` | `body.ts` | whitespace-separated decimal tokens parsed with `Number` + one `f32` round (what `istream >> float` does to this file); hex-float/`inf`/locale forms are refused loudly, and the recorded file contains none (the golden test re-parses it verbatim) |
| `W1e/body-clone-always-allocates` | `body.ts` | native `clonegeom` allocates only when `fPolygon == NULL` (and prints `cloning with allocated mem` otherwise); an object cannot be half-constructed in JS, so the port always replaces the polygon array — identical vertices, and the `printf` is not model state |
| `W1e/body-scale-in-place` | `body.ts` | the vertices are rewritten with an `f32` per store and `lengths()` measures *those* values; scaling the box instead of the vertices would be a different computation for a mesh whose extremes are not exactly representable |
| `W1e/body-probe-is-oracle-tooling` | `native/bodyprobe.cpp` | the probe links the native tree, is imported by nothing under `src/model/**`, writes nothing into the native tree or `oracle/**`, and builds into a scratch dir |
| `W1e/body-mesh-verbatim-and-hashed` | `golden/nativeBodyMesh.ts` | the browser has no filesystem, so the `pw1` text (not a re-serialised vertex list) is bundled with its sha256; `tests/geometry.test.ts` byte-compares it against `<native>/etc/objects/agent.obj` whenever that tree is present |
| `L8/sqrt-of-a-float-is-single-precision` | `agent.ts` | the `sqrt` discipline above |
| `W1e/radius-fma-contraction` | `primitives.ts` (`Poly`, `PolyObj`) | `gpoly`/`gpolyobj::setradius`'s square sum is **contracted** in the shipped build (`0x8497c`/`0x84980`/`0x84988`, `0x84ca0`/`0x84ca4`/`0x84cac`): `fmul` on the second square, `fmadd` for the first and third, so only one square rounds — see *the contraction sweep* |
| `W1e/radius-rule-is-one-function` | `primitives.ts` (`scaledRadius`, `contractedSquareSum`, `contractedSquareSumXZ`, `recordedSquareSum`, `boxRadius`) | every radius derivation (`gpoly` `0x8498c`, `gpolyobj` `0x84cb0`, `gbox` `0x87624`, `agent` `0x21f4c`, `food` `0x5aa84`) ends in the same tail, so the tail is **one** function and the square-sum spellings are one helper each — the callers differ only in which sum they pass and in their own `fRadiusFixed` latch. `t_4e856769` made the environment lane's `gbox` slice (`environment/object.ts`, which used to carry its own copy) import this one and re-export it as `focusRadius`; `grep -rn 'f32(f32(f32(root' src` went 6 → 1 |

## Hotspots

* `PARITY.md` was edited concurrently by several lanes during this pass; two of this lane's row
  edits were clobbered by a stale read-modify-write and had to be re-applied. The file is a
  multi-writer hotspot (flagged on the board).
* **The vision half of *Open questions* 6 was in flight while this lane's two ownership hops
  landed** (`t_4e856769`, 2026-09-28 ~22:44-22:53): the vision lane's `src/model/vision/{matrix,camera}.ts`
  copy of the GL maths was being folded into this lane's `src/model/geometry/{matrix,camera}.ts` in
  the same working tree (`geometry/matrix.ts` rewritten 22:51:08, `geometry/camera.ts` 22:51:47,
  `vision/matrix.ts` 22:52:00 — none of them this card's files). Measured effect on `npm test` at
  22:53: **3 failures**, all 1-ulp camera values — `tests/vision-camera.test.ts` 2
  (`vision_pitch_yaw`, `world100_origin`: `proj[0]` `0x40124dfe` vs `0x40124dff`) and
  `tests/geometry.test.ts` 1 (`world100_origin.proj[14]` `0xbca3d9d5` vs the golden `0xbca3d9d6`),
  the count moving 13 → 8 → 2 as that lane iterated. **This is not `t_4e856769`'s**: reverting that
  hop (this card's files at HEAD, every other file exactly as the working tree has it, in a
  `git worktree` with symlinked `node_modules`) reproduces the identical three failures. Whoever
  owns the matrix hop owns these pins — they must not be closed by touching
  `golden/nativeCameraVectors.ts`.

## Gaps this lane closes / leaves

* **Closed:** `NullBodyGeometry` (agent mesh / collision radius) — deleted; `createAgentDeps` binds
  `AgentBodyGeometry` over the bundled mesh.
* **Still open (not L15's):** `run/brain/**` (125 files) + `run/genome/agents/**` (25) +
  `run/stats/**` + `endReason.txt` + `movie.pmv` are the recorder lanes' (L12/L6/L5/L14); the
  first *differing* artifact is the step-1 `Energy` column of `run/energy/agents/agent_*.txt`
  (energy accounting, not geometry — see the L11 blocker chain).
* **Out of scope for this pass:** the scene renderer (`gstage`, `gobj` draw calls, the
  `SceneRenderer` seam L14/L18 program against) — L15's remaining half, with L16.
