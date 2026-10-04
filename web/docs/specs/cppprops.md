# cppprops — native run-time code generation → build-time data (lane W1h)

Status: **implemented and verified.** `tools/cppprops/verify_cppprops.py` → 7/7
scenarios (`minitest_voff`, `microtest_voff`, `growers_small`, `growers_dyn`,
`gene_dyn`, `growers_ring`, `two_metabolisms`), every native property value
reproduced with **no compiler invoked at run time**. Everything marked *measured*
was produced by running the native binary and the port; nothing here is inferred
from reading code alone.

## 1. What the native build does (measured)

`library/proplib/cppprops.cc` runs **at simulation start** (`Simulation.cc`,
`CppProperties::init(docWorldFile, context)`):

1. `getCppProperties(document)` walks the *instantiated worldfile document*
   depth-first; children are `std::map<Identifier,…>` so **iteration is
   lexicographic by name** (`strcmp`), arrays in index order. Scalars that are
   `Runtime` or `Dynamic` are collected, in that walk order; that order *is* the
   metadata index assignment.
2. Scalar classification: `Runtime` — declared `runtime True` in the schema
   (the worldfile may not set them: `schema.cc` errors "Cannot assign value to
   runtime property"); the builder injects a `RuntimeScalarProperty` for each.
   `Dynamic` — the worldfile value is a `dyn(...)` form (`Token::Dyn`).
   Everything else is a plain constant and never appears here.
3. It emits `run/.cppprops/generated.cc` (metadata table +
   `CppProperties_Init()` + `CppProperties_Update()`), copies
   `etc/bld/cppprops.mak` to `run/.cppprops/Makefile`, **shells out to `make` +
   clang++** (~6 s) and `dlopen`s `run/.cppprops/libcppprops.dylib`.
4. `PropertyMetadata::toString()` renders a value for display/recording:
   `INT` → `%d`, `FLOAT` → `%g`, `BOOL` → `"True"/"False"`, and
   `default: assert(false)` ⇒ **`STRING` values have no `toString()` and would
   abort** (`cppprops.cc:31-50`).

Two details that are easy to get wrong and are load-bearing for byte-exactness:

* **Decorations are the contract.** Every token carries the whitespace *and
  comments* preceding it (`parser.cc` → `Tokenizer::next`), and the generator
  emits `token->getDecorationString() + token->text` when it copies worldfile
  expression text into the generated C++. So `generated.cc` reproduces the
  worldfile's spacing exactly. Note that `//` is **not** a comment in the
  proplib grammar (only `#`, and `#* … *#`, are): a `// C++ syntax` line inside
  a `dyn` body is lexed as `/`, `/`, `C`, `+`, `+`, `syntax` and survives into
  the generated C++ as unresolved symbols emitted verbatim — which is why the
  generated body reads exactly like the worldfile it came from.
* **`getCppSymbol()` macro expansion is pure textual substitution.** `$[sim]` →
  `context->sim`, `$[index]` → the property's own name, `$[ancestor]` → the
  nearest ancestor that has a `cppsym`, `$[gene,NAME,min|max]` →
  `genome::GeneType::to___Interpolated(genome::GenomeUtil::getGene("NAME", "PATH:LINE: Cannot find gene 'NAME'"))->smin|smax.__val`.
  Schema spacing is preserved, so `"barrier::gBarriers[ $[index] ]"` becomes
  `barrier::gBarriers[ 0 ]`.

Measured on minitest.wf (vision off): only 4 runtime properties exist —
`AgentCount`, `AgentMetabolisms[0].MetabolismAgentCount`, `FoodCount`, `Step`.

## 2. The replacement (build time, no compiler, no dlopen)

```
worldfile + schema ──extract_cppprops.py──▶ cppprops.json ──lib/cppprops.mjs──▶ property values
   (build time, python)                        (data)         (run time: no compiler, no dlopen)
```

`run/.cppprops` disappears: the *code* becomes *data* + a small interpreter.

| native | port |
|---|---|
| `generated.cc` compiled and `dlopen`ed per run | `cppprops.json` emitted once per worldfile at build time |
| `metadata[i].value = &(cppsym)` read live | `Runtime` property values are supplied per step by the model, keyed by the property's native full name |
| `update` body is raw C++ emitted from the worldfile | the same text, interpreted (`tools/cppprops/lib/cppprops.mjs`); `*((T*)metadata[/*name*/ i].value)` is rewritten to a storage read, the rest of the C++ subset is evaluated as-is |
| `init` bodies run once and may call engine functions | same, when portable; otherwise the property is `portable: false` and a **binding** serves it |
| `if( newval != *value ) *value = newval;` | identical exact-`!=` write-if-changed, `Math.fround` at the `float` store |
| `PropertyMetadata::toString()` | `%d` / `%g` / `True|False`; `STRING` throws where native asserts |

### Spec format (`cppprops.json`)

```
{ formatVersion, worldfile, schema, worldfileSha256, schemaSha256, generatedCcSha256,
  stage, metadataOrder, updateOrder: [name…],
  properties: [ { index, name, kind: Runtime|Dynamic, datalibType: INT|FLOAT|BOOL|STRING,
                  cppType, cppSymbol,
                  dynamic?: { initial, initBody, updateBody, updateSource: update|initExpr,
                              metadataRefs: {name: index}, updatePortable, updateUnportableSymbols,
                              initPortable, initUnportableSymbols, portable, stateStruct, stage } } ] }
```

`generatedCcSha256` ties the spec to the exact native source text it came from.

### Portability

`dynamic.portable` is a claim, not a guess: after rewriting the metadata reads it
means "the only identifiers left are the C++ subset the interpreter implements"
(`if/else/return`, `min`/`max`, arithmetic and comparisons, `true`/`false`, the
few math functions in `PORTABLE_SYMBOLS`). Anything else — a qualified call
(`FoodPatchTokenRing::update`), the update context
(`context->sim->fDomains[ 0 ].fFoodPatches[ 0 ]`), a `state { … }` struct — is
listed in `updateUnportableSymbols` / `initUnportableSymbols` and needs a
binding in `tools/cppprops/bindings/**`. `run_cppprops.mjs` **exits 3** when an
unportable property has no binding: it refuses rather than emitting a value it
cannot justify.

Bindings shipped: `foodpatch_tokenring.mjs`, a line-for-line port of
`library/proplib/state.cc`'s `FoodPatchTokenRing` (`add`/`update`/`updateActive`/
`findActive`), which is proplib's own support for dyn bodies. Its two engine
inputs — `FoodPatch::agentInsideCount` and the "kill agents in the newly active
patch" side effect — are not part of proplib, so the interpreter reads them
through the engine context (`ctx.patchAgentInsideCount`, `ctx.engine.onActivatePatch`)
and *whoever drives it* serves them: the sim serves both **live**, and a replay of
a recording is handed the count per step. On that recording path the count is
supplied **per step** from the recorded state trace: a scenario's
`engineFromState` block (`table`, `field`, `stepShift`) makes `verify_cppprops.py`
build

```
{"steps": {"<step>": {"patchAgentInsideCount": {"<domain>.<patch>": <n>}}}}
```

and hand it to `run_cppprops.mjs --engine` (`lib/cppprops.mjs` `splitEngine`;
the older static table still works, and a step with no entry reads 0). The
`onActivatePatch` kill is what the interpreter *delegates*: it reports which
patch became active, it does not kill agents — and on the recording path there
is no model to kill. **The sim path serves both of those engine inputs live**
(closed by L11, `t_23d13a7b`): `ctx.patchAgentInsideCount` is a live view over
`FoodPatch::agentInsideCount` (`src/model/sim/cppProperties.ts`), so the ring
reads the field itself and **no `stepShift` is needed there** — the field at the
step's start *is* the previous step's accumulation
(`Simulation.cc:1701`/`:1842-1850`), exactly the phase §3 measures the `-1` shift
against; the `--engine` table with its `stepShift -1` belongs to the recording
path only (unchanged). And `ctx.engine.onActivatePatch` is served there by
`killAgentsInside` — native `state.cc:205-213`'s `SetDeathByPatch` walk, at the
binding's radius 5 — whose deaths are then taken in the sim's own death gate
(`sim/interact.ts`'s `fNumberDiedPatch`). Measured: the recorded `growers_ring`
worldfile replayed through the sim's own step loop reproduces **300/300**
farm-log lines on all nine columns (`Alive0` 181 → 139 at step 7), with
`fNumberDiedPatch` = the recorded **67**.

`bindings/gene.mjs` serves the `$[gene, NAME, min|max]` symbol — the one class
whose called symbol is **not** proplib's but the genome's
(`genome::GenomeUtil::getGene` / `genome::GeneType::to___Interpolated`), so lane L5
owns its value and its test (§3, *The `$[gene, …]` class*). Unlike a body-driven
binding it is keyed off the *property*: `lib/genesymbol.mjs` recognises the
symbol (`genome::GeneType::to___Interpolated(genome::GenomeUtil::getGene("NAME",
"ERR"))->smin|smax.__val`, plus the unexpanded `$[gene, NAME, min|max]` macro a
hand-built spec may carry), `lib/cppprops.mjs` (`geneReadSymbol`) requires the
binding for **any** property that names a gene read — in its cpp symbol or in
either body — and `init` binds the property's storage to the gene's range member
(native `CppProperties_Init`: `metadata[i].value = &(…)`). The value comes from
the port's genome layer through the engine context, either

```
ctx.engine.geneValue(name) -> { kind: "FLOAT"|"INT"|"BOOL", min, max }   // genomeUtil, in process
ctx.engine.genes = { "NAME": { kind, min, max } }                        // table, for the CLI
```

(`bindings/gene.mjs` `geneTableFromGenomeUtil` builds the table out of L5's
`GenomeUtil` + `Gene::getMin/getMax`; `geneNamesInSpec(spec)` lists the genes a
spec reads). One property can carry one gene read, and the shape the binding
does not recognise — an unknown `genome::` symbol, a body that names no read, a
gene the schema does not define, a missing range member or `kind` — is a
**throw**, never a value: `run_cppprops.mjs` exits 3 for a gene-bound property
with no binding and 1 for a binding with no gene source, and neither path emits
a number it cannot justify.

`verify_cppprops.py` supplies that table for a recorded scenario through its
`genesFromGenerange` block: the values are parsed out of the run's own
`run/genome/meta/generange.txt` (kept verbatim as
`fixtures/native/<scn>.generange.txt`; `Gene.cc:226-238` writes
`<rounding> <smin Scalar::str()> <smax Scalar::str()> <name>`, and
`Scalar::str()` is `<KIND> <value>`), so nothing is hand-typed. Measured:
`gene_dyn` replays **300/300** farm lines, and the control that matters — the
same spec with the *oracle* range (`MateEnergyFraction.min = 0.2`, i.e. what a
port that ignored the worldfile's `dyn( 0.5 )` would serve) — diverges on all
300 (`step 1 MinEnergyFractionToOffspring: port 0.2, native 0.5`), so the
registration is not vacuous.

## 3. Recorded native ground truth (`fixtures/`)

`CppProperties::init()` shells out to `make` + clang++ into `run/.cppprops` and
`dlopen`s the result; the **only** place property *values* surface is the Farm
monitor (`Monitor.cc` → `PWFARM_STATUS`), which is active only when that env var
is set. `fixtures/harness/record_scenario.py` reproduces the recording:

* It runs the native binary from a **mirror tree** (symlinks to the native
  `Polyworld`, `etc/`, `lib/`, `src/`, plus this lane's `term.mf` and the
  worldfile), so the native tree is untouched and `run/` goes to scratch.
  `FarmMonitor::step()` invokes the logger by name through `bash -c`, so the
  mirror is prepended to `PATH`.
* `term.mf` sets `StatusText.FrequencyDisplay 1` and `Farm.Frequency 1` → one
  sample per step instead of 4 — and lists the properties to sample (native
  names) with the short titles the farm log uses.
* `PWFARM_STATUS` is a logger script; it appends its argument
  (`[Step=1 AgentCount=25 …]`) to `$PWFARM_STATUS_LOG`.

Two independent per-step traces come out of one run, on different code paths:

| trace | produced by | use |
|---|---|---|
| `fixtures/native/<scn>.farm.log` | `PropertyMetadata::toString()` — the cppprops path | **the acceptance oracle** |
| `fixtures/state/<scn>.state.json` | `Simulation::getStatusText()` `sprintf`s of `fStep` / `gXSortedObjects` counts / `fNumberAliveWithMetabolism` — *not* the cppprops path | the evaluator's input |

So a comparison between them is not circular: native state recording → our
evaluator → native property values.

Recorded (all `--ui term`, `--Vision False`):

| scenario | worldfile | steps | native farm lines | properties |
|---|---|---|---|---|
| `minitest_voff` | `worldfiles/tests/low-spec-pc/minitest.wf` | 1…301 | 301 | 4, all Runtime |
| `microtest_voff` | `worldfiles/tests/low-spec-pc/microtest.wf` | 1 | 1 | 4, all Runtime |
| `growers_small` | our trimmed copy of the native `worldfiles/m-neurons/growingBarriers.wf` (`MaxSteps 300`) | 1…300 | 300 | 9 (5 Dynamic) |
| `growers_dyn` | `growers_small.wf` with the dyn gate moved `Step < 10000` → `Step < 10` | 1…300 | 300 | 9 (5 Dynamic) |
| `growers_ring` | `growers_dyn.wf` with the first token ring lowered `add( FoodPatches[0], 150, 2000, 400 )` → `( 2, 20, 5 )` | 1…300 | 300 | 9 (5 Dynamic) |
| `two_metabolisms` | `minitest.wf` + two `AgentMetabolisms` + `AgentMetabolismSelectionMode Random` (our copy) | 1…301 | 301 | 4 sampled, 5 Runtime in the spec |

Cross-check: the mirror run's status text at steps 1/100/200/300 equals the
frozen oracle's (`oracle/minitest_voff/stdout.txt`: agents 25/24/23/23).

`growers_dyn` is the one that actually exercises the dynamic path: in
`growers_small` the gate `if( Step < 10000 )` is never crossed, so every dynamic
body just returns its own value (`B0Z2`/`B1Z2` = -1 for all 300 steps). With the
gate at 10, `Barriers[0].Z2` walks `-1 → -0.970895` (292 distinct values — this
is `%g` at 6 significant digits, `float` accumulation, `min()` and
write-if-changed all at once) and `Barriers[1].Z2`, which reads
`Barriers[0].Z2`, follows it exactly — the antecedent ordering
(`sortDynamicProperties`) is what makes that true within a step.

### The token ring's inputs, and their phase (`growers_ring`)

`growers_dyn`'s farm log has `P0On=True, P1On=P2On=False` at all 300 steps, so the
`FoodPatchTokenRing` binding's two engine inputs were never exercised by it — and
`Simulation::getStatusText` *does* print `FoodPatch::agentInsideCount` (the
`  FP<i> <foodCount> <inside> <inside+neighborhood>` lines,
`Simulation.cc:5183-5214`, gated on `fCalcFoodPatchAgentCounts` — hard-coded true
in the ctor at `:203`); the harness simply dropped them. `record_scenario.py` now
keeps them as a per-step `foodPatches` map keyed `<domain>.<patch>`, and
`growers_ring` is `growers_dyn.wf` with the first ring's
`add( FoodPatches[0], 150, 2000, 400 )` lowered to `( 2, 20, 5 )`.

Measured on its 300-step farm log: **35 `P*On` transitions** — 12 maxPopulation
triggers into the delay window (`100 → 000`, e.g. steps 2 and 28), 12 delayEnd
activations through `findActive()` (`000 → 010` at step 7, where the alive count
drops 181 → 139 and the run's `-patch` death counter ends at 67 — the branch that
delegates the kill), and 11 timeout `findImmediate` switches (`010 → 100` at step
27, no delay window). `2` rather than a value inside the step-1 counts (23/24/40):
a threshold the counts already sit in fires at step 2 under *any* alignment, while
2 is only reached again by counting agents into a patch an earlier cycle emptied —
and those crossings are what make the farm log discriminate the phase:

| engine table for step N read from | result |
|---|---|
| step N-1 (`stepShift` -1, what the manifest records) | all 300 steps × 9 properties match |
| step N (`stepShift` 0) | diverges at step 26 (`FoodPatches[1].On`: interpreter `False`, native `True`) |
| step N+1 (`stepShift` +1) | diverges at step 25 |
| no engine (every `agentInsideCount` reads 0) | 222/300 steps diverge, first at step 2 (`FoodPatches[0].On`) |

The shift is not a fit: the counts are accumulated at the *end* of a step
(`DeathAndStats`, reached from `Interact()`, after the agents have moved) while
the ring runs at the *start* of it (`CppProperties::update()`,
`Simulation.cc:648`). The farm log pins the same phase independently through
`B0Z2`: with `Step >= 10` the barrier body reads `AgentCount` one step earlier
than the column printed beside it, and `growers_ring` crosses 175 at exactly such
a step (recorded 174 at step 185, 184 at step 186 — the barrier grows at step
187, not 186), which is why `lib/cppprops.mjs` runs the bodies against the
previous step's runtime values. The four earlier fixtures could not see any of
this: `minitest`/`microtest` define no dynamic property at all,
`growers_small`'s gate `Step < 10000` is never crossed, and in `growers_dyn`
`agents[N-1] > 175` holds at every printed step `N >= 10`, so both alignments
fire its barrier branch at the same steps.

### The metabolism count is recorded, not inferred (`two_metabolisms`)

`AgentMetabolisms[j].MetabolismAgentCount` compiles to
`fNumberAliveWithMetabolism[ Metabolism::get( j )->index ]` (the worldfile's
`AgentMetabolisms` array is walked in order and `Metabolism::define` sets
`index = position`, `Simulation.cc:4069-4125`), and `Simulation::getStatusText`
prints that same array for every definition — ` -<Name> = <n>`, immediately after
the `agents` line — **but only when `Metabolism::getNumberOfDefinitions() > 1`**
(`Simulation.cc:4894-4904`). Every worldfile recorded before this one defines a
single metabolism, so those lines never appeared and `runtimeMap` fed the property
from `agents`. Agreement at all 602 recorded steps is not the same thing as a
comparison that can *tell the two apart*, which is why it was flagged as an
inference (`PARITY.md`, W1h → *What is verified vs assumed*).

`fixtures/worldfiles/two_metabolisms.wf` — minitest.wf plus `AgentMetabolisms
[ { Name "Alpha" } { Name "Beta" } ]` and `AgentMetabolismSelectionMode Random`
(the first 17 lines are byte-identical to minitest.wf) — makes the native print
them. `record_scenario.py` records them as per-step `metabolism<j>` keys (state
files for such runs also carry `metabolismNames`), and the scenario's `runtimeMap`
feeds `AgentMetabolisms[0].MetabolismAgentCount` from `metabolism0`: a recording of
the array the cppsym reads, not of a proxy for it.

Measured over the 301 steps of `fixtures/state/two_metabolisms.state.json` against
`fixtures/native/two_metabolisms.farm.log`:

* step 1: `agents = 25`, ` -Alpha = 12`, ` -Beta = 13`, farm `Alive0 = 12`;
* the recorded `metabolism0` differs from `agents` at **all 301 steps**
  (`agents - metabolism0`: min 11, max 15, median 13), so `Alive0 = 12` at step 1
  is *not* the `agents` count — and replaying the old mapping fails at step 1
  (interpreter 25, native 12) where the recorded one matches all 301;
* `metabolism0 + metabolism1 == agents` at **301/301** steps, births and deaths
  included: the counts partition the alive agents. Together with the 602 steps of
  `Alive0 == AgentCount` in the single-metabolism traces, that is what the
  surviving `agents` mapping for those scenarios rests on — with one definition the
  partition has exactly one term, so the term *is* the total.

The recorded order **is** the definition order (`getStatusText` prints
`Metabolism::get( 0 ), get( 1 ), …`), and that is how `metabolism0` is pinned to
`AgentMetabolisms[0]`: the names it printed are Alpha then Beta, and the independent
farm column `Alive0 = 12` agrees with Alpha, not with Beta (13).

Beware the lookalikes: ` -random`, ` -two`, ` -one` (`fNumberCreatedRandom/2Fit/1Fit`,
`:4942-4949`) and the death-cause counters (` -age`, ` -energy`, ` -fight`, ` -eat`,
` -edge`, ` -smite`, ` -patch`) have the same line shape as a metabolism line. They
are printed *outside* the `agents` … `food` window, which is the gate the parser
uses — the line shape alone is not enough.

### The `$[gene, …]` class: a property bound to a gene's range (`gene_dyn`)

`etc/worldfile.wfs` gives seven scalar properties a gene cpp symbol —
`Min`/`MaxEnergyFractionToOffspring` (the `MateEnergyFraction` min/max) and
`Sheets.{Min,Max}BrainSize.{X,Y,Z}` (`SizeX/Y/Z`). Expanded, the symbol is

```c
metadata[8].value = &(genome::GeneType::to___Interpolated(
    genome::GenomeUtil::getGene("MateEnergyFraction",
      "./etc/worldfile.wfs:1619: Cannot find gene 'MateEnergyFraction'"))->smin.__val);
```

**How it is reached.** *Not by a body.* All seven sit on scalar constants, and a
resolved constant is inlined as its evaluated text, so a body that names one
never sees the symbol. The only route into generated code is a property that is
itself `Runtime`/`Dynamic` (the `metadata[i].value = &(…)` line above) or a body
referencing a *non-scalar* target that carries a cppsym — and no non-scalar
property has a gene symbol (measured: the only non-scalar cppsyms are the
`barrier::`, `FoodPatch`/`Domains`, `Metabolism::` handles and `context->sim->…`
chains). A worldfile therefore **can** reach the class (the command below) while
the property's body stays `portable: true`: the gene read is the property's
*storage*, not its update rule. The card's unportable-body arm is exercised by
the synthetic spec in the test (an allowed harness), and the interpreter refuses
a gene-bound property that has *no* binding (exit 3) — the same contract.

Reproduction (shipped schema; one worldfile-only change against `growers_dyn.wf`):

```diff
+MinEnergyFractionToOffspring  dyn( 0.5 )
+{
+  if( Step < 10 ) return value;
+  return min( 0.5, value + 0.001 );
+}
```

```
python3 tools/cppprops/extract_cppprops.py \
    --worldfile tools/cppprops/fixtures/worldfiles/gene_dyn.wf \
    --schema <native>/etc/worldfile.wfs --schema-name ./etc/worldfile.wfs \
    --out spec.json --emit-cc generated.cc \
    --crosscheck tools/cppprops/fixtures/native/gene_dyn.generated.cc
python3 tools/cppprops/fixtures/harness/record_scenario.py --native <native> \
    --worldfile tools/cppprops/fixtures/worldfiles/gene_dyn.wf \
    --name gene_dyn --args '--Vision False'
```

`--schema-name` is the schema *document's own name* — what
`DocumentLocation::getDescription()` spells before `:line`. Native
`Simulation.cc:270` builds the schema with the literal `"./etc/worldfile.wfs"`,
so a `$[gene, …]` expansion carries that spelling regardless of where the file
lives on disk; with it, the emitted C++ is **byte-identical to the recording**
(8949 B, exit 0), line 153's
`"./etc/worldfile.wfs:1619: Cannot find gene 'MateEnergyFraction'"` included.
`1619` is the line of the *schema's* `cppsym` property:
`propSym.getLocation()` is `prop->getSchema()->get( "cppsym" )`
(`cppprops.cc:817`), not the worldfile line that referred to the property
(`gene_dyn.wf:58`), and `verify_cppprops.py` derives the name from the
manifest's `native_root` + `schema` — a derivation that does not describe the
recording fails the crosscheck instead of passing with a plausible path.

**What the native does with it.** `metadata[8].value` *is* the gene's `smin`
field (`Scalar`'s `union { void *__val; int ival; float fval; bool bval; }`), so
the property's value is the gene's minimum, and `PropertyMetadata::toString()`
reads it as `*(float *)value` — the *property's* type picks the union member
(pinned by `src/model/genome/native/genevalueprobe.cc`, vector file
`src/model/genome/native/vectors/geneValues.txt`). Two measurements worth keeping:

* the property **feeds** the very range member it reads (`MateEnergyFraction.min`
  is `MinEnergyFractionToOffspring`), so the recorded run's own `generange.txt`
  says `FLOAT 0.500000` where the same worldfile without the `dyn( 0.5 )` says
  `0.200000`: the value the gene holds and the value the worldfile spells
  coincide in every reachable case. That is why `gene_dyn`'s farm log is
  `MinEFOff=0.5` for all 300 steps (the body's own cap) and why the binding's
  *storage seeding* is only observable through the synthetic spec (with
  `initial: 0.9`), which serves the oracle's `0.200000` instead;
* every step *writes the body's value back into the gene field* (the same
  `if( newval != … ) *value = newval`), so a gene-bound property mutates the
  gene natively. The port models the read, not that aliasing — it is reachable
  only through later-born agents' genomes (whole-sim parity), not through any
  artifact this lane records. See §8 item 1.

**What the port serves.** `bindings/gene.mjs` reads the gene through L5's genome
layer (`genomeUtil.getGene` + `Gene::getMin/getMax`, native
`__InterpolatedGene::smin/smax`) and applies the native union read
(`nativeUnionRead`): FLOAT → the value; an INT `Scalar` read by a float property
→ the int's bits as an f32 (and the reverse); a BOOL `Scalar` read by a
float/int property → **refused**, because `Scalar::Scalar(bool)` writes one byte
and the native read is undefined. Every one of those rows is pinned against the
probe. The fixture replays **300/300** native farm lines with the gene table
built from the port's own genome layer for that worldfile, and the test
cross-checks that table against the native run's `generange.txt`
(0.500000 / 0.800000) and against the oracle scenarios' (0.200000 / 0.800000).

**In `verify_cppprops.py`.** The fixture is registered in
`fixtures/manifest.json` (`gene_dyn`, the 7th scenario) with the gene table its
`$[gene, …]`-bound property needs in a `genesFromGenerange` block next to
`engineFromState` — read out of `fixtures/native/gene_dyn.generange.txt`, never
typed (§2). Result: **7/7 scenarios** and 5/5 hand-maintained worldfile pins,
with `gene_dyn` replayed **line-by-line against its own farm log**
(300 steps × 10 properties) under the same scrubbed `PATH=/nonexistent`. The
other six scenarios are byte-unchanged (verifier run before/after), and only
`gene_dyn`'s emitted C++ carries a schema location at all: no other recorded
worldfile reaches a `$[gene, …]` symbol. A gene the schema does not define is
*not* reachable at all: native `GenomeUtil::getGene` returns NULL and the
generated code dereferences it (the `Sheets` symbols under
`BrainArchitecture Groups`), so the binding throws the emitted error text
instead — with the ported location, the refusal reads exactly like the native's
(`./etc/worldfile.wfs:1619: Cannot find gene 'MateEnergyFraction'`).

## 4. Files

| path | role |
|---|---|
| `extract_cppprops.py` | CLI: worldfile + schema → `cppprops.json`; `--emit-cc` writes the native C++; `--crosscheck` byte-compares the two; `--schema-name` sets the schema document's own name for location descriptions |
| `lib/tokens.py` | native-equivalent proplib tokenizer (decorations, multi-line comments, `l`/`f`/`d` number suffixes) |
| `lib/proplib.py` | the proplib subset `cppprops.cc` walks (parser, DOM, schema, defaults, runtime injection, symbol resolution, expression `eval`) |
| `lib/cppprops_model.py` | `cppprops.cc`'s emitters, macro expansion, dependency sort, spec builder, portability classifier |
| `lib/cppprops.mjs` | the run-time interpreter: storage, update order, write-if-changed, `%g`, bindings |
| `run_cppprops.mjs` | CLI: spec + state trace → native-formatted values |
| `bindings/index.mjs`, `bindings/foodpatch_tokenring.mjs`, `bindings/gene.mjs` | bindings for unportable dyn bodies, and for the gene read (`$[gene,…]`; `lib/genesymbol.mjs` parses the symbol shape) |
| `verify_cppprops.py` | acceptance: extract → cross-check → replay with `PATH=/nonexistent` → compare to the farm logs; builds the binding engine inputs from the recording (`engineFromState`, `genesFromGenerange`) |
| `fixtures/harness/record_scenario.py`, `PWFARM_STATUS`, `term.mf` | how the native ground truth is recorded |
| `fixtures/native/*.generated.cc` | the native-generated cppprops code, verbatim from a run tree |
| `fixtures/native/*.farm.log` | native property values, one line per step |
| `fixtures/native/gene_dyn.generange.txt` | the `gene_dyn` run's own `run/genome/meta/generange.txt` — the native gene range the `$[gene,…]` binding must serve (`FLOAT 0.500000 / 0.800000`) |
| `fixtures/state/*.state.json` | per-step `{step, agents, food}` (plus `metabolism<j>` / `metabolismNames` when the run defines >1 metabolism) from the run's status text |
| `fixtures/worldfiles/*.wf` | the dynamic-property test worldfiles, plus `two_metabolisms.wf` (the metabolism-count recording) and `gene_dyn.wf` (the gene-bound property) |
| `fixtures/manifest.json` | sha256 of every fixture + of the schema and worldfiles, the `runtimeMap`, and the drift notes |

## 5. The dynamic case, concretely

`Barriers[0].Z2` (`Z2 dyn( Z1 ) { if( Step < 10000 ) return value; … }`) becomes

```c
metadata[2].value = &(barrier::gBarriers[ 0 ]->getPosition().zb);   // init section
...
if( *((int*)metadata[/*Step*/ 8].value) < 10000 )
    return *((float*)metadata[/*Barriers[0].Z2*/ 2].value);
if( *((int*)metadata[/*AgentCount*/ 0].value) > 175 )
    return min( -0.1, *((float*)metadata[/*Barriers[0].Z2*/ 2].value) + 0.0001 );
…
float newval = local::update( context );
if( newval != *((float*)metadata[/*Barriers[0].Z2*/ 2].value))   // write-if-changed
    *((float *)metadata[2].value) = newval;
```

Points the port preserves (each measured against the farm logs):

* the `dyn(...)` argument expression is the *fallback update body* when the
  worldfile declares no `update` attribute (`Barriers[1].Z2` →
  `return ( *((float*)metadata[……].value) );` — the body is the init expression,
  and because the init expression has no `return` token the generator adds one);
* `value` inside a body means "my own lvalue" (resolved to this property's own
  metadata read), `begin` is the property's document value, `end` is evaluated by
  the Python interpreter at build time;
* a resolved symbol that is a plain constant is inlined as its evaluated text
  (`Z1` → `-1.0`, Python `True`/`False` → `true`/`false`), a Runtime/Dynamic
  symbol becomes a metadata lvalue read, an `EnumValue` becomes a quoted string,
  and anything unresolved is emitted verbatim as C++ (this is how `min`/`max` and
  the worldfile's `//` comments survive);
* **write-if-changed**: the assignment is skipped when `newval == *value` — an
  exact `!=` for float, so it is observable;
* `init { … }` bodies run once at init, before any step, and may call engine
  functions (`FoodPatchTokenRing::add(patch, 150, 2000, 400)`) — the unportable
  class from §2, bound in `bindings/`.

## 6. PORT-NOTEs

* `PORT-NOTE(cppprops):` run-time code generation + `dlopen` is replaced by a
  build-time JSON spec and an interpreter; no compiler is invoked at run time.
  Same property names, order, kinds, and `toString()` formatting.
* `PORT-NOTE(cppprops):` property iteration order is lexicographic by name with
  arrays in index order (native `std::map`), and it is part of the emitted
  metadata order and of the metadata indices used by dynamic bodies.
* `PORT-NOTE(cppprops):` `BOOL` renders `True`/`False`, `FLOAT` renders `%g`,
  `INT` renders `%d`; there is no `STRING` rendering (native asserts).
* `PORT-NOTE(cppprops):` dynamic bodies are C++-subset text extracted from the
  worldfile; they are interpreted, not compiled, and bodies that call engine
  functions are classified unportable and require a TS binding.
* `PORT-NOTE(cppprops):` `//` is not a comment in the proplib grammar; the
  classifier strips `//`/`/* */` comments before deciding portability, but the
  body text it emits keeps them (as the native compiler sees them). A binding
  that *parses* that text must strip them too — `bindings/`
  `foodpatch_tokenring.mjs` (`stripComments`) does, because otherwise
  `FoodPatchTokenRing::add( FoodPatches[0], // patch\n 2, // maxPopulation … )`
  captures the comments as its arguments and `parseInt` yields `NaN`.
* `PORT-NOTE(cppprops):` a `dyn` body reads the **live** runtime variables
  (`metadata[i].value` is a pointer) at the start of its step, while the farm
  monitor samples and prints them at the step-ending signal; `Step` is the one
  exception (the native increments `fStep` before `CppProperties::update()`).
  The interpreter therefore evaluates the bodies against the *previous* step's
  runtime values and applies this step's values afterwards — what a recorded
  state trace holds is the printed, end-of-step value (`lib/cppprops.mjs`,
  `STEP_PROPERTY`). The same phase applies to any per-step engine table.
* `PORT-NOTE(proplib/location):` the port carries a `DocumentLocation` per node
  (`loc_path`/`loc_line` on `lib/proplib.py`'s `Node`), created by the builder
  from the node's **begin token** exactly as `builder.cc:155` `createLocation`
  does, and printed by `cppprops_model._location_description` like
  `DocumentLocation::getDescription()` (`dom.cc:105`) — including its `%u`
  quirk: a node with no line reads back as `:4294967295`, not as a bare name
  (the TS proplib port keeps the same wrap — PARITY
  `proplib/location-lineno-unsigned`). `loc_path` is the *document's own name*
  (`Document::getName()`), which is not necessarily the path it was read from:
  native `Simulation.cc:270` builds the schema with the literal
  `"./etc/worldfile.wfs"`, so the emitted `Cannot find gene` text spells the
  schema that way — the port's `--schema-name` / `build_model(schema_name=…)` is
  that input, defaulting to the `--schema` path as given.
* `PORT-NOTE(proplib-subset):` `lib/proplib.py` is deliberately a *subset* of
  `library/proplib/**`: schema *validation* is skipped (it only emits errors),
  V1 worldfile syntax and `overlay` are refused by name (lane L3), and expression
  evaluation is `eval()` of the fully substituted expression (lane L4 owns the
  real evaluator).

## 7. Usage

```
# build time: worldfile -> spec (and prove the emitted C++ is the native text)
python3 tools/cppprops/extract_cppprops.py \
    --worldfile <wf> --schema <native>/etc/worldfile.wfs \
    [--schema-name NAME] [--param NAME=VALUE …] \
    --out cppprops.json --crosscheck <run>/.cppprops/generated.cc

# one command, worldfile -> property values (extract, then replay the trace)
python3 tools/cppprops/extract_cppprops.py \
    --worldfile <wf> --schema <native>/etc/worldfile.wfs \
    --replay <trace.json> [--runtime-map map.json] [--replay-format native|json|values]

# run time: spec + state trace -> native-formatted values (no compiler)
node tools/cppprops/run_cppprops.mjs --spec cppprops.json --state trace.json \
    [--format native|json|values] [--runtime-map map.json] [--engine engine.json]

# acceptance (all recorded scenarios)
python3 tools/cppprops/verify_cppprops.py --verbose

# re-record a fixture from the native binary
python3 tools/cppprops/fixtures/harness/record_scenario.py \
    --native <polyworld tree> --worldfile <wf> --name <scenario> --args "--Vision False"
```

Exit codes: `extract_cppprops.py` 1 on a cross-check mismatch or a parse error;
`run_cppprops.mjs` 3 when an unportable dyn body has no binding.

## 8. Remaining gaps (also in `PARITY.md`)

1. **Engine-calling dyn bodies need per-worldfile bindings.** Bound today:
   `FoodPatchTokenRing::{add,update}` and the `$[gene, NAME, min|max]` gene read
   (lane L5; §3, *The `$[gene, …]` class*). *(closed — the `UpdateContext` half,
   L11's sim engine context, landed in `t_23d13a7b`; §2, "The sim path serves
   both of those engine inputs live". A dyn body that mutates the model through
   the `UpdateContext` is served by `src/model/sim/cppProperties.ts`: the two
   `FoodPatchTokenRing` engine inputs live, the runtime values seeded at the
   variable's own width, the storage write-back into the named live member, and a
   `CppPropertiesRefusalError` — never a silent 0 — where one cannot be
   resolved.)* The extractor names the
   offending symbol and the property; the missing binding is the owning lane's
   file, and a property that names a gene read without the `genome` binding is
   refused by name (`run_cppprops.mjs` exit 3) like any other unportable body.
   The two residuals the gene class left on **W1h's own files** are **closed**
   (this lane's follow-up card): the fixture is registered (7/7) with its gene
   table read out of the run's own `generange.txt` (`genesFromGenerange`), and
   `Property::getLocation().getDescription()` is reproduced — the emitted
   `Cannot find gene 'NAME'` text is byte-identical to the recording, so
   `gene_dyn`'s crosscheck needs no exemption. Still not modelled: the native
   write-back into the gene's `Scalar` (a gene-bound property *is* the gene
   field; only whole-sim parity on later-born agents' genomes could see it).
2. *(closed — see §3, "The token ring's inputs, and their phase")* **The
   token-ring binding's engine inputs were not recorded**
   (`FoodPatch::agentInsideCount`). They are now: `record_scenario.py` keeps the
   `getStatusText` `FP<i> <foodCount> <inside> <inside+neighborhood>` lines as a
   per-step `foodPatches` block, `verify_cppprops.py` turns that into a per-step
   engine table for the binding (`engineFromState` → `--engine`), and
   `growers_ring` is a run in which the ring switches patch 35 times. Both
   directions are measured: the recorded inputs reproduce all 300 farm lines,
   and the input defaulted to 0 diverges at step 2 (222/300 steps). Two further
   defects fell out of writing the fixture: the binding never parsed its `add()`
   parameters (the worldfile's inline `//` comments were captured *as* the
   argument text, `parseInt` returned `NaN`, and `NaN > 0` silently disabled
   every switching branch — so the old "consistent" result was vacuous, not just
   unproven), and a `dyn` body must be evaluated against the *previous* step's
   runtime values (`Step` excepted), which no earlier fixture could see because
   their agent counts never crossed a threshold from the wrong side.
3. **The interpreter evaluates a C++ subset, not C++.** Integer division,
   casts, and `float`-value arithmetic beyond the `Math.fround` at the store
   boundary are not modelled. No recorded body reaches any of them.
4. **`state { … }` dyn attributes are not interpreted** (they need the generated
   state struct). No recorded scenario uses one; such a property is classified
   unportable.

Not on this list, and no longer in `PARITY.md`'s *assumed* bullet either: the
`AgentMetabolisms[0].MetabolismAgentCount` replay input. In `two_metabolisms` it is
fed from a **recorded** count (`metabolism0`) instead of being inferred from
`agents`, and the four single-metabolism scenarios keep the `agents` mapping on the
strength of a measured partition (`metabolism0 + metabolism1 == agents` at 301/301
steps) rather than on agreement that could not tell the two quantities apart — see
§3, *The metabolism count is recorded, not inferred*.
