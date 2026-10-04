# src/model/proplib — the property language front end (lane W1b) + expression language (lane L4)

Native: `library/proplib/{parser,dom,builder,editor,schema,convert,writer,expression,overlay}.*`
plus the tokenizer that lives inside `parser.cc`. The expression *evaluator*
(`interpreter.cc` + `interpreter.py`, an out-of-process `python3`) is **lane L4, landed**: it lives
in `evaluator.ts` (the seam + the Python *code generation*, native `interpreter.cc`) and
`pythonExpression.ts` (the language, native `interpreter.py`); `interpreterEvaluator` is the default
for every document build. This lane carries expressions as tokens and calls whatever evaluator it is
given.

## What it does

```
worldfile.wfs ─┐
               ├─► DocumentBuilder ─► Document ──► DocumentWriter ─► converted.wf
worldfile.wf ──┘         │                                        │
                         └─► SchemaDocument.apply ───────────────►│
                             (defaults, runtime, validate)      ─► normalized.wf
```

`run/normalized.wf` is the artifact, and it is *not* a pretty-printed config: it is the
schema's and the worldfile's own text, re-emitted token by token, with the children of every
container ordered by `DocumentLocation` (document path, line, token index). Reading the code
in this order is the shortest path to understanding it:

1. `lexer.ts` — tokens carry their decoration (whitespace + comments). The decoration *is*
   the output formatting.
2. `dom.ts` — `DocumentLocation` is the ordering key; a schema-injected default keeps the
   location of the schema's `default` node, which is why the output is in schema order and
   why an injected value is indented like the schema source.
3. `writer.ts` — three rules: order by location, emit `decoration + text`, and insert a `\n`
   only when the id token's decoration has no newline (see the file header).
4. `schema.ts` — the defaults/`@defaults`/runtime injection and the read-only validation pass.

## Using it

```ts
import { emitNormalizedWorldfile } from '../model/proplib';

const { converted, normalized } = emitNormalizedWorldfile(readLatin1, {
  worldfilePath: 'worldfiles/tests/low-spec-pc/minitest.wf', // as the native spells it
  schemaPath: './etc/worldfile.wfs',
  parameters: new Map([['Vision', 'False']]),                // native `--Vision False`
});
```

`worldfilePath`/`schemaPath` are *document identities*, not just file names: they are the
first key of the output ordering, so a caller reproducing a golden must use the native's
relative spelling. `src/model/proplib/cli.ts` is the shell form of the above and the lane's
acceptance harness:

```
npx vite-node src/model/proplib/cli.ts -- --root ../polyworld \
  --worldfile worldfiles/tests/low-spec-pc/minitest.wf --set Vision=False \
  --converted-out /tmp/c.wf --normalized-out /tmp/n.wf
cmp /tmp/n.wf ../polyworld-web/oracle/minitest_voff/run/normalized.wf
```

Four variants are recorded and all four are reproduced byte for byte (`--set Vision=False`
for `*_voff`; **no** `--set` at all for `*_von`, which is a different parameter map from
passing the default): `minitest_voff` 11,889 B / 187 B, `minitest_von` 11,888 B / 172 B,
`microtest_voff` 11,887 B / 185 B, `microtest_von` 11,886 B / 170 B
(`normalized.wf` / `converted.wf`, against `oracle/<scenario>/run/**`).

## What is the reference, and what is not

`oracle/<scenario>/run/**` is the reference. **`<native>/run/**` is not a fixture**: every
native record rotates it (`run` → `run.previous.<epoch>`), so its contents belong to
whichever scenario ran last — and `minitest_von`/`minitest_voff` share a worldfile and
differ only in the `--Vision` override, so `run/original.wf` alone does not name the
variant. `tests/proplib.test.ts` therefore identifies the live run before comparing with it
(`run/original.wf` for the worldfile, the run's own `normalized.wf` for the variant) and
skips visibly when it cannot, instead of turning another lane's recording into a parity
failure. Don't add an assertion against the live tree without that guard; see the
`W1b-tests/live-run-is-not-a-fixture` PORT-NOTE in `PARITY.md`.

## Rules for anyone editing here

* `src/model/proplib/**` is lane W1b's; `tests/proplib.test.ts` is its suite. Everything
  imports the frozen `src/model/types/**` surface and nothing from another lane's internals.
* Never "fix" the writer's formatting or the location of an injected default. Both are the
  contract; `PARITY.md` → *PORT-NOTEs (W1b proplib core)* lists every such decision.
* Expression evaluation goes through the `ExpressionEvaluator` seam. There is exactly **one**
  language: lane L4's, in `pythonExpression.ts`, reached through `interpreterEvaluator`
  (`generatePythonExpression()` is native `interpreter.cc`'s code generation). `schemaLiteralEvaluator`
  is the pre-L4 stand-in kept as the seam's *test harness* — it throws rather than guessing, and no
  production path defaults to it. Adding a third evaluator is how a port grows two languages.
* `cli.ts` is the only file here that touches `node:fs` (a `PORT-NOTE` says so); keep it that
  way so the rest can load in the browser.
