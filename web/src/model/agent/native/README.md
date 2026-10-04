# Lane L8 — native differential probe

`agentprobe.cpp` links the **real** native build (`<native>/lib/libpolyworld.dylib`) and
emits the vectors `tests/agent.test.ts` replays. Floats are emitted as IEEE-754 bit patterns,
so the port's comparison cannot hide a 1-ulp drift.

```
./agentprobe.sh all          # rebuild + regenerate every vector (default)
./agentprobe.sh collision    # one mode: build|collision|energy|lifespan|config
```

Environment: `POLYWORLD_NATIVE` (default `<repo>/../polyworld`), `POLYWORLD_WEB`,
`COLLISION_CASES` (default 3000), `ENERGY_CASES` (default 600), `CONFIG_SCENARIO`
(default `minitest_voff`), `CXX`, `BUILD_DIR`.

Modes and what each one pins down:

| mode | native calls | vectors |
|---|---|---|
| `collision` | `agent::GetCollisionFixedCoordinates` | `vectors/collision.json` |
| `energy` | `Energy` / `EnergyPolarity` / `EnergyMultiplier` arithmetic | `vectors/energy.json` |
| `lifespan` | `LifeSpan::BR_NAMES` / `DR_NAMES` | `vectors/lifespan.json` |
| `config` | `agent::processWorldfile` on the registered scenario's worldfile | `vectors/config.<scenario>.json` |

Notes that cost time to learn, all encoded in the source:

* The `collision` mode's case set is 16 crafted branch/early-out cases + **6 crafted
  contraction cases** (`t_4392393c`) + `COLLISION_CASES` random ones (default 3000). The native
  build contracts `a*b + c` (`clang -O2`'s `-ffp-contract=on`), and the six added inputs are
  minimal examples where the fused result differs in the last bit from the source's
  multiply-then-add; a rounds-per-operation transcription fails all six (and 65 of the random
  cases). See PARITY.md -> *the float-contraction rule*.
* `proplib::Interpreter::init()` **must** be called before any `getEvaledString()`; the
  interpreter's python process is null until then and the first dynamic property read
  segfaults. `Interpreter::dispose()` must be called before exit, or the python child keeps
  the inherited stdout pipe open and a caller reading the probe's output waits forever.
* `proplib::Document::get()` returns a **reference**, and `schema->apply()` takes a pointer.
* The `config` mode runs the same pipeline `Simulation.cc` does (schema → worldfile document
  with the scenario's `--Key value` parameters → `schema->apply` → `agent::processWorldfile`)
  and runs with cwd = the native tree, so `./etc/worldfile.wfs` resolves. It writes no files
  into the native tree: both temp documents are created and removed in the working directory,
  and `run/` is neither read nor written.
* The probe is **not** part of the model: nothing under `src/model/**` imports it, and no
  model code runs a simulation to produce a vector.

A diff in `vectors/` is a change to the oracle (the native build changed), not to the port —
re-run only when the inputs change, and treat the diff as a finding.
