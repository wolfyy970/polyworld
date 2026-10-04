# Polyworld → TypeScript port — agent spec

(Referenced from `PORT_PLAN.md`. Named PORT_SPEC.md rather than CLAUDE.md because
agent-instruction filenames are write-protected in this environment; rename it or symlink
it to `CLAUDE.md` if you want agent harnesses to auto-load it.)

Read this before touching code. Violating it produces a port that "works" and silently
disagrees with the original.

## What this is

A **rewrite** of Polyworld (Artificial Life, ~60k lines of C++, 1991–2019) into
TypeScript that runs in a browser. Behavior is frozen; structure is free. The C++ tree at
`../polyworld` is the **oracle**: it keeps building and running, and its recorded outputs
are the contract.

## Frozen surface

**Byte-exact (the contract).** For the recorded scenarios, the candidate `run/` tree must
match the golden master file-for-file and byte-for-byte:
`normalized.wf`, `converted.wf`, `endReason.txt`, `lifespans.txt`, `BirthsDeaths.log`,
`genome/**`, `brain/**`, `energy/**`, `motion/**`, `events/**`.

This holds **with vision on as well as off** — measured: two native runs differ in exactly
one file, `movie.pmv` — which is not part of this frozen set (see *Not frozen* below).

**Gzipped artifacts are frozen byte-for-byte, container included** (task `t_431ed2f0`). A
`.gz` under `run/` is compared by its container bytes, exactly like every other manifested
file, and the shipped port produces them: the node gzip sinks write through
`src/model/compress/zlibDeflate.ts`, a dependency-free TS transcription of upstream zlib's
deflate (level 6 / memLevel 8 / windowBits −15 / `Z_DEFAULT_STRATEGY` / single `Z_FINISH`), and
it rebuilds **2581/2581** recorded `.gz` containers byte-for-byte across all five scenarios
(`tests/gzip-deflate.test.ts`) — all six registered scenarios compare strict. Why the container
is worth freezing, and why an exception existed for a day: the recorded goldens are
upstream-zlib level-6 deflate (apple libz 1.2.12, vanilla zlib 1.2.12 and vanilla zlib 1.3.1
each reproduce **all 1317** recorded `.gz` containers byte-for-byte — measured, in
`docs/specs/gzip-containers.md`), while the gzip implementations available to the port at the
time wrote a different stream for the same content, because what differs is the **zlib the binary
is linked against**, not node: node 22.22.2 links Google's patched "motley" zlib fork — 25/150
containers — and Chrome 153's `CompressionStream` neither, 26/190 — while a node linked against
upstream zlib 1.2.12 (`/opt/homebrew/opt/node@24` v24.16.0) reproduces **150/150** (t_16ac7810:
the same `node:zlib` call, a different linked zlib). The *payload*
is what the model produces; the *container* is the compression library's fingerprint. From
2026-09-28 the contract was therefore amended (task `t_091ec5b8`) to compare selected `.gz`
files by their gunzipped payload, and that amendment is **reverted** (task `t_9c9fa3de`) now
that the durable byte-exact fix it named has landed: `tools/scenarios.d/content-compare.json`
ships with an **empty** `content_compare` rule list, so no path is content-compared by default
and `--no-content-compare` has nothing left to turn off. The mechanism stays for a future case
— a scenario may opt in with its own `content_compare` globs, and `--content-compare <glob>`
re-selects a path for a single check — and the harness still counts and prints every file it
compares by content, a payload difference, a missing file and an unreadable container all
remaining hard failures.

**Not frozen (free):** `run/movie.pmv` (delta-compressed, incrementally written),
windowing, widgets, tool UIs. The browser version should
make movie recording deterministic *by construction* (sample on step boundaries) rather
than reproduce the native sampling jitter. The harness therefore never *fails* a scenario
on `run/movie.pmv`, at any tier (task `t_588c28e1`): every tier's compare defaults ignore
it, it is still hashed into the manifest at record time (the evidence is kept) and the
checker reports a difference as `IGNORED`, never as a failure. Measured 2026-09-28: three
fresh native runs of `minitest_voff` produced **two distinct** movies — one byte-identical
to the golden, two differing only in `movie.pmv` — so a tier-A number means "the model's
artifacts", not "the movie too". A scenario can still opt in with `no_default_ignore` if a
future encoder check wants the strict comparison.

**The render is a fidelity surface (task `t_67dbaa3f`, L18d).** "Presentation layer keeps its own
look" is no longer an acceptable reading of any doc in this repo. The browser scene must *look* the
way the native build renders it — same environment, same objects, same colours, same lighting — and
the native source (`qtrenderer/renderer/qt/QtSceneRenderer.cc`, `library/graphics/**`,
`library/monitor/**`) is the contract for it, exactly as it is for the model. Concretely: the clear
colour is native's black, the ground is `etc/objects/ground.obj` scaled by `WorldSize`, the agents
are `etc/objects/agent.obj` scaled by `(fLengthX, agentHeight, fLengthZ)` and painted in their two
native polygon-range colours, the boxes are the model's own `gboxf`s, the barriers are the
worldfile's walls, lighting is native's (none — nothing ever enables `GL_LIGHTING`), and the default
camera is native's `MainScene` (`FieldOfView 90`, the `Rotate` controller's pose). The values that
remain a *choice* are named in a `PORT-NOTE (L18d/...)` at their call site, with the reason. What
this does **not** change: `run/movie.pmv` and the windowing/widget/tool-UI surfaces stay free, and
no golden is touched.

## Ground rules

1. **Never "improve" model behavior.** If the C++ looks wrong, port it wrong the same way
   and file it in `PARITY.md` → Open questions. Silent fixes are how ports die.
2. **RNG is part of the contract.** `rand()`, `drand48()`, `gsl_rng_mt19937` are used
   directly by the model. Reproduce the exact sequences (glibc `rand`/`drand48`
   algorithms, MT19937 plus GSL's uniform mapping). Never substitute `Math.random()`,
   never re-seed differently, never merge streams the original kept separate.
3. **Floats.** Model math is `float`/`double` as written. Use TS `number` (f64) and apply
   `Math.fround` exactly where the C++ stores into a `float`. Where a divergence traces to
   a libm transcendental (`exp`, `pow`, `sqrt`, `sin`, `cos`, `log`), implement a
   bit-exact version and PORT-NOTE it.
4. **Iteration order is part of the model.** Where the C++ walks an ordered container
   (sorted object list, agent order, patch order), keep that order exactly. Do not
   "clean up" iteration into a hash map.
5. **No new dependencies** without a row in `PARITY.md` → Dependency proposals.
6. **Every semantic decision** gets a `PORT-NOTE:` comment and a `PARITY.md` row.
7. **No stubs.** A stub is allowed only with a Gaps row naming the lane that closes it.
8. **`oracle/**` is read-only.** Read goldens; changing them fails review.

## Definition of done, per lane

`tools/check_parity.py --golden oracle/<scenario> --candidate <your run tree>` exits 0 for
every scenario in the lane's scope; the lane has no new stubs, no oracle file changed, and
its PORT-NOTEs are listed in `PARITY.md`. Lanes land behind the frozen interfaces in
`src/model/types/`.

## Layout

```
src/model/types/     shared types, configs, enums, events  (frozen early, plan-owned)
src/model/<lane>/    one directory per lane (see PORT_PLAN.md)
src/browser/         Three.js front end (lane L18)
oracle/              scenarios, goldens, manifests
tools/               record_oracle.py, check_parity.py
```

## Where the model lives (native → lane map)

| Native | Lane |
|---|---|
| `library/utils/**` (RNG, datalib, AbstractFile, misc) | L1, L2 |
| `library/proplib/**` (+ `interpreter.py`) | L3, L4 |
| `library/genome/**` | L5 |
| `library/brain/**` | L6, L7 |
| `library/agent/**` | L8, L9 |
| `library/environment/**` | L10 |
| `library/sim/**` | L11 |
| `library/logs/**` | L12 |
| `library/complexity/**` | L13 |
| `library/monitor/**` | L14 |
| `library/graphics/**` | L15, L16 |
| `tools/**` | L17 |
| `app/**`, `src/qtrenderer/**` | L18 |
