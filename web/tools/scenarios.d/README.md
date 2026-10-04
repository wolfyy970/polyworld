# tools/scenarios.d — lane-registered parity scenarios

One JSON file per scenario, named `<scenario>.json`. The harness
(`tools/parity_common.py`) merges these **over** the read-only base registry
`oracle/scenarios/scenarios.json`: a name registered here shadows a base entry of
the same name (which needs `--force` and is recorded in the file as
`shadowed_base`).

Why a directory instead of editing the base file: `oracle/**` is read-only for
lane agents (PORT_SPEC.md ground rule 8), and one shared JSON grows a merge
conflict for every new scenario. Separate files mean two lanes registering a
scenario at the same second cannot corrupt each other's registration.

## Registering one

```sh
# a fast vision-on smoke scenario for the vision/retina lanes: names the
# worldfile, pins native args, records the golden from the native build
./oracle/run_parity.sh add microtest_von \
    --worldfile worldfiles/tests/low-spec-pc/microtest.wf \
    --tier B --record
```

`--worldfile` is relative to the **native** tree (the oracle records by running
`<native>/Polyworld` with cwd = the native root, so the worldfile must live
there). Any number of native overrides can be pinned with `--arg`:

```sh
# the same world with parameter overrides. Note the `--arg=<Key>` (equals) form:
# plain `--arg --Vision` makes argparse read the *key* as the option's value
# ("argument --arg: expected one argument", exit 2)
./oracle/run_parity.sh add minitest_seeded \
    --worldfile worldfiles/tests/low-spec-pc/minitest.wf \
    --arg=--Vision --arg=False --arg=--MaxSteps --arg=200 \
    --tier A --record
```

## Fields

| Field | Meaning |
|---|---|
| `name` | scenario id; also the golden directory `oracle/<name>/` |
| `worldfile` | worldfile path relative to the native tree |
| `args` | native args, verbatim, inserted before the worldfile (`--ui term` is fixed) |
| `tier` | `A` = byte-exact model tier, `B` = vision on (movie excluded in both) |
| `ignore` | rel-path prefixes (`run/...`) allowed to differ at compare time |
| `content_compare` | run/-relative **globs** whose files are compared by gunzipped content, not container bytes (`**` crosses `/`, `*` and `?` do not). Adds to the global rule — which ships empty (t_9c9fa3de), so this is how a scenario opts in |
| `no_content_compare` | opt out of the global content-compare rule for this scenario |
| `record_exclude` | rel-path prefixes left out of the manifest at record time |
| `no_default_ignore` | opt out of the default `run/movie.pmv` ignore (all tiers) |
| `notes` | free text, shown by `./oracle/run_parity.sh list --json` |

Two different lists, on purpose (`PORT-NOTE(parity-runner/excludes)`):

* `record_exclude` — never enter the manifest. `run/.cppprops/` lives here: the
  run-time compiled props library embeds a build UUID.
* `ignore` — may differ without failing the candidate. Applied at compare time,
  because a file omitted from the manifest would otherwise be reported `EXTRA`
  in every candidate that does write it. **Every** tier adds `run/movie.pmv`:
  PORT_SPEC.md declares it free, not frozen, and it is measurably not
  reproducible even between two native runs on one machine, so it is never part
  of a byte-exact number (measured 2026-09-28, t_588c28e1; see PARITY.md →
  Deviations → *The movie is not a frozen artifact*).

Ignored differences are still reported by the checker under `IGNORED`, so
nothing is silently dropped.

## Global rules: `content-compare.json`

A file in this directory with **no** `scenarios` key can carry registry-level
keys instead. `content-compare.json` is the one that ships, and its rule list is
**empty**:

```json
{"content_compare": []}
```

Nothing is content-compared, so every `.gz` is byte-compared by its container,
like every other manifested file — the default a lane should expect, and what the
shipped port produces.

Until 2026-09-29 the file declared `{"content_compare": ["run/**/*.gz"]}`, which
selected files that were compared by their **decompressed payload** (the gzip
container free, the payload byte-equal to the golden's) because the recorded `.gz`
goldens are upstream-zlib level-6 deflate and no gzip then available to the port
wrote that stream (measured 2026-09-28, task t_091ec5b8: node 22.22.2's **linked**
zlib is Google's patched "motley" fork — 25/150 and 25/1167 containers matching —
and Chrome 153's `CompressionStream` neither, 26/190; the count is a property of
the zlib the engine links against, not of node: a node linked against upstream
zlib 1.2.12 reproduces 150/150, t_16ac7810). The payload is the model's
output, the container is the compression library's. The durable fix that
amendment named (lane card `t_431ed2f0`: `src/model/compress/zlibDeflate.ts`, a
dependency-free transcription of upstream zlib's deflate) landed, the port now
writes byte-identical containers, so the amendment was reverted with the one
registry file it promised (task `t_9c9fa3de`) and this file stays as an empty
overlay — the history and the reverted-at HEAD sit in its own `_comment`. See
`docs/specs/gzip-containers.md`, `PORT_SPEC.md` → *Frozen surface* and PARITY.md →
Deviations.

The mechanism is unchanged for a future case, and nothing about it is hidden: a
rule makes the payload the contract, the checker prints
`content-compared N file(s) [...] : payload identical … (container byte-identical
…, container differs …)` on every run that has one, and a payload difference, a
missing file or an unreadable container still fails the check.
`--content-compare <glob>` (repeatable) selects a path for a one-off,
`--no-content-compare` forces strict bytes.

Per-scenario overrides: `"content_compare": [...]` on a scenario adds globs,
`"no_content_compare": true` opts that scenario out of the global rule.

## Verifying a registration

```sh
./oracle/run_parity.sh list                       # is it registered, is there a golden?
./oracle/run_parity.sh <scenario> --selfcheck     # re-run native, compare to its own golden
```

`--selfcheck` is the step that proves the golden is stable on this machine
before anyone blames their own code for a diff.

## Worktrees

`oracle/<scenario>/run/**` is gitignored (~35 MB of generated goldens), so a lane
working in its own git worktree has the registration but not the goldens. Point the
harness at the canonical ones instead of re-recording:

```sh
export POLYWORLD_ORACLE_ROOT=polyworld-web/oracle
```

The same can be pinned in `tools/parity.config.json` as `{"oracle_dir": "..."}`
(and `native_dir` for the native tree). `./oracle/run_parity.sh paths` prints what
the harness resolved.
