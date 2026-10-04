/**
 * Lane W1b — proplib core tests.
 *
 * Three bands:
 *
 *  1. **Unit** — lexer/parser/DOM semantics the rest of the model leans on: token
 *     decoration, native `std::map` (strcmp) child order, `Identifier(index)` naming, the
 *     frozen `PropertyNode` failure behaviors (identical to `memoryDocument.ts`), runtime
 *     properties, and the writer's byte-for-byte round trip.
 *  2. **Schema** — defaults (`default`, `defaults` + `@defaults`), runtime injection,
 *     assertions, range/type/enum validation, and the documented evaluator seam (driven by
 *     a *scripted* evaluator, since the expression language itself is lane L4).
 *  3. **Golden parity** — the lane's acceptance: rebuild `converted.wf` and `normalized.wf`
 *     for every recorded variant (`minitest`/`microtest` × `--Vision False` / no override)
 *     and compare with the oracle bytes. These run when the native tree (schema + worldfile)
 *     and the goldens are present, and skip — visibly — otherwise: `oracle/<scenario>/run/**`
 *     is gitignored, and a fresh worktree may not have the native tree next to it.
 *     `src/model/proplib/cli.ts` drives the same code path from the shell.
 *  4. **Lane L4 — the expression language**: the recorded `python3` vectors
 *     (`src/model/proplib/native/vectors/pythonExpressions.json`, recorded by
 *     `native/record_python_vectors.py` from the real interpreter) evaluated by
 *     `pythonExpression.ts`, the Python *code generation* of `generatePythonExpression`,
 *     and golden parity again with the real evaluator **and** the validation pass on —
 *     which is what native's ctor did, and the only pass that reads a value.
 *
 * The native tree's *live* `run/` is deliberately not treated as a fixture: it is rotated by
 * every native record on this board, and it can hold another scenario, or the other vision
 * variant of this one. A single test compares against it, but only after identifying the run
 * from its own bytes; see `liveNativeRun()` below.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ArrayProperty,
  ConstScalarProperty,
  Document,
  DocumentBuilder,
  DocumentWriter,
  Identifier,
  ObjectProperty,
  Parser,
  Property,
  ProplibEnum,
  PythonError,
  RuntimeScalarProperty,
  SchemaDocument,
  Tokenizer,
  compareLocation,
  createInterpreterEvaluator,
  emitNormalizedWorldfile,
  evaluatePythonExpressionText,
  generatePythonExpression,
  interpreterEvaluator,
  isV1Source,
  schemaLiteralEvaluator,
  type ExpressionEvaluator,
} from '../src/model/proplib';
import { ConfigError } from '../src/model/types/errors';

// --------------------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------------------

const NATIVE_ROOT = resolve(process.env.POLYWORLD_NATIVE ?? join(__dirname, '..', '..', 'polyworld'));
const ORACLE_ROOT = resolve(process.env.POLYWORLD_ORACLE_ROOT ?? join(__dirname, '..', 'oracle'));
const SCHEMA_PATH = './etc/worldfile.wfs';

const MINITEST = 'worldfiles/tests/low-spec-pc/minitest.wf';
const MICROTEST = 'worldfiles/tests/low-spec-pc/microtest.wf';

function readLatin1(path: string): string {
  return readFileSync(path, 'latin1');
}

/** The schema + worldfile text of a scenario from the native tree, when it is checked out. */
function scenarioSources(worldfile: string): { schema: string; worldfile: string } | undefined {
  const schemaFile = join(NATIVE_ROOT, 'etc', 'worldfile.wfs');
  const worldfileFile = join(NATIVE_ROOT, worldfile);
  if (!existsSync(schemaFile) || !existsSync(worldfileFile)) return undefined;
  return { schema: readLatin1(schemaFile), worldfile: readLatin1(worldfileFile) };
}

function golden(scenario: string, file: string): string | undefined {
  const path = join(ORACLE_ROOT, scenario, 'run', file);
  return existsSync(path) ? readLatin1(path) : undefined;
}

interface EmitTestOptions {
  evaluator?: ExpressionEvaluator;
  validate?: boolean;
  parameters?: [string, string][];
}

/** Emit both documents for a synthetic schema/worldfile pair, with the given options. */
function emitWith(
  schema: string,
  worldfile: string,
  options: EmitTestOptions = {},
) {
  return emitNormalizedWorldfile((path) => (path === SCHEMA_PATH ? schema : worldfile), {
    worldfilePath: 'test.wf',
    schemaPath: SCHEMA_PATH,
    parameters: new Map(options.parameters ?? []),
    evaluator: options.evaluator,
    validate: options.validate,
  });
}

/** Scripted evaluator: answers the expressions the test knows, delegates literals to W1b's. */
function scriptedEvaluator(values: Record<string, string>): ExpressionEvaluator {
  return {
    name: 'test-script',
    evaluate(expression, owner) {
      const text = expression.write(false).trim();
      const value = values[text];
      if (value !== undefined) return value;
      return schemaLiteralEvaluator.evaluate(expression, owner);
    },
  };
}

/**
 * A small hand-written schema exercising the schema language: defaults and `defaults`
 * variants, a runtime property, an assertion, an enum, and a nested object array.
 */
const TEST_SCHEMA = `
Blocked {
  type    Bool
  default False
}

Count {
  type    Int
  min     1
  max     10
  assert  not Blocked or Count < 5
  default 3
}

Seed {
  type     Int
  defaults { default 5; legacy 0 }
}

Mode {
  type    Enum
  enum    Values {
    A,
    B
  }
  default A
}

Shadow {
  type    Int
  runtime True
  cptype  int
  cppsym  "sim->shadow"
}

Points {
  type    Array
  default [ ]
  element {
    type    Object
    properties {
      X {
        type    Float
        min     0.0
        max     1.0
        default 0.5
      }
      Y {
        type    Float
        min     0.0
        max     1.0
        default 0.25
      }
    }
  }
}
`;

/** The one expression in TEST_SCHEMA that needs a real evaluator (lane L4). */
const COUNT_ASSERT = 'not Blocked or Count < 5';
const assertTrue = (extra: Record<string, string> = {}) =>
  scriptedEvaluator({ [COUNT_ASSERT]: 'True', ...extra });

// --------------------------------------------------------------------------------------
// 1. unit — lexer, parser, DOM, writer
// --------------------------------------------------------------------------------------

describe('lexer: tokens and decoration', () => {
  it('keeps whitespace and comments as decoration of the following token', () => {
    const tokenizer = new Tokenizer('t', '  # hi\nA 1\n');
    const bof = tokenizer.next();
    expect(bof.type).toBe('Bof');
    expect(bof.number).toBe(-1);

    const a = tokenizer.next();
    expect(a.type).toBe('Id');
    expect(a.text).toBe('A');
    expect(a.lineno).toBe(2);
    // Decoration tokens are numbered too (native numbers every token it produces), so the
    // first ordinary token carries the index of the whitespace/comment run before it.
    expect(a.number).toBe(4);
    expect(a.getDecorationString()).toBe('  # hi\n');
    expect(a.hasNewline()).toBe(true);

    const one = tokenizer.next();
    expect(one.type).toBe('Number');
    expect(one.text).toBe('1');
    expect(one.getDecorationString()).toBe(' ');

    const eof = tokenizer.next();
    expect(eof.type).toBe('Eof');
    expect(eof.getDecorationString()).toBe('\n');
  });

  it('recognises the four keywords, strings, escapes and numbers', () => {
    const tokenizer = new Tokenizer('t', 'enum class dyn attrs "a\\"b" \\. 1.5f 12');
    const types: string[] = [];
    for (;;) {
      const tok = tokenizer.next();
      if (tok.type === 'Eof') break;
      types.push(`${tok.type}:${tok.text}`);
    }
    expect(types).toEqual([
      'Bof:',
      'Enum:enum',
      'Class:class',
      'Dyn:dyn',
      'Attrs:attrs',
      'String:"a\\"b"',
      'Misc:\\.',
      'Number:1.5f',
      'Number:12',
    ]);
  });

  it('reports an unterminated string with file and line, as native does', () => {
    const tokenizer = new Tokenizer('world.wf', 'A 1\nB "oops\n');
    expect(() => {
      for (;;) {
        if (tokenizer.next().type === 'Eof') break;
      }
    }).toThrowError(/world\.wf:2: Unterminated string literal\./);
  });

  it('reports an unterminated multi-line comment', () => {
    const tokenizer = new Tokenizer('world.wf', '#* open\nA 1\n');
    expect(() => {
      tokenizer.next();
      tokenizer.next();
    }).toThrowError(/world\.wf:1: Unterminated multi-line comment\./);
  });
});

describe('parser: syntax tree', () => {
  it('builds Document/MetaProperty/Object/Property/Expression nodes', () => {
    const node = new Parser().parseDocument('p.wf', '@version 2\nA B\nC {\n  D "x"\n}\n');
    const dump = node.dump();
    for (const type of [
      'Document',
      'MetaProperty',
      'MetaPropertyValue',
      'Object',
      'Property',
      'PropertyValue',
      'Expression',
      'SymbolPath',
      'SymbolPathElement',
    ]) {
      expect(dump).toContain(type);
    }
  });

  it('rejects a malformed document with the native error shape', () => {
    expect(() => new Parser().parseDocument('p.wf', 'A { \n')).toThrowError(/p\.wf:/);
  });
});

describe('dom: property semantics', () => {
  const build = (): Document =>
    new DocumentBuilder().buildDocumentText(
      'p.wf',
      '@version 2\nZed 1\nAlpha {\n  b 2\n  A 3\n  Z 4\n}\nArr [ 1, 2, 3 ]\n',
    );

  it('orders children by identifier strcmp, not by source order', () => {
    const doc = build();
    const alpha = doc.requireProp('Alpha');
    // Source order is b, A, Z — native `std::map<Identifier,…>` (strcmp) order is A, Z, b.
    expect(alpha.props().map((prop) => prop.getName())).toEqual(['A', 'Z', 'b']);
    // `elements()` is the frozen alias for the same walk.
    expect(alpha.elements().map((node) => node.name)).toEqual(['A', 'Z', 'b']);
  });

  it('names array elements by index, and strcmp-orders their names past 9', () => {
    const doc = new DocumentBuilder().buildDocumentText(
      'p.wf',
      'Arr [ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 ]\n',
    );
    const arr = doc.requireProp('Arr');
    expect(arr).toBeInstanceOf(ArrayProperty);
    if (!(arr instanceof ArrayProperty)) throw new Error('not an array');

    expect(arr.size()).toBe(11);
    // `props()` walks in identifier (strcmp) order — "10" sorts between "1" and "2" — while
    // lookups are by index name, which is why array *output* order stays numeric.
    expect(arr.props().map((prop) => prop.getName())).toEqual([
      '0',
      '1',
      '10',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
    expect(arr.requireProp(10).scalarText()).toBe('10');
    expect(arr.requireProp(2).scalarText()).toBe('2');
  });

  it('exposes the frozen PropertyNode surface with the W1a failure text', () => {
    const doc = build();
    const alpha = doc.get('Alpha');
    const scalar = doc.get('Zed');

    // getp: absent children are `undefined` on both node kinds (the frozen contract).
    expect(scalar.getp('nope')).toBeUndefined();
    expect(alpha.getp('nope')).toBeUndefined();

    // get: a missing required child fails, mentioning the property name.
    expect(() => alpha.get('nope')).toThrowError(/Alpha: ERROR! No such property: 'nope'/);
    // Scalar confusion fails the same way (native `__ScalarProperty::get`).
    expect(() => scalar.get('nope')).toThrowError(
      /Zed: ERROR! Invalid request for property: 'nope'/,
    );

    // elements / scalarText on the wrong kind of node.
    expect(() => scalar.elements()).toThrowError(/Zed: ERROR! Invalid request for properties\./);
    expect(() => alpha.scalarText()).toThrowError(/Alpha: ERROR! Expecting String/);

    expect(scalar.size()).toBe(0);
    expect(scalar.kind).toBe('scalar');
    expect(alpha.kind).toBe('object');
    expect(doc.get('Arr').kind).toBe('array');
    expect(scalar.scalarText()).toBe('1');
    expect(scalar instanceof Property).toBe(true);
  });

  it('rejects duplicate children, and refuses an index name in an object', () => {
    expect(() => new DocumentBuilder().buildDocumentText('p.wf', 'A 1\nA 2\n')).toThrowError(
      /Duplicate property name 'A'/,
    );
    // A numeric property name cannot even be parsed (the lexer calls it a Number, and
    // `parseObject` only accepts identifiers), so the DOM check is exercised directly.
    const doc = new DocumentBuilder().buildDocumentText('p.wf', 'A 1\n');
    const scalar = doc.requireProp('A');
    if (!(scalar instanceof ConstScalarProperty)) throw new Error('expected a const scalar');
    const numbered = scalar.clone(new Identifier(0));

    expect(() => doc.add(numbered)).toThrowError(/Illegal index name '0' in an object property\./);
  });

  it('carries @-meta properties without touching the property tree', () => {
    const doc = build();
    expect(doc.hasMeta('@version')).toBe(true);
    expect(doc.getMeta('@version')?.getValue()).toBe('2');
    expect(doc.props().map((prop) => prop.getName())).toEqual(['Alpha', 'Arr', 'Zed']);
  });

  it('orders locations by path, then line, then token index', () => {
    const doc = build();
    const zed = doc.requireProp('Zed');
    const arr = doc.requireProp('Arr');
    expect(compareLocation(zed.getLocation(), arr.getLocation())).toBeLessThan(0);
  });

  it('stringifies indices the way native `Identifier` does', () => {
    expect(new Identifier(3).getName()).toBe('3');
    expect(new Identifier(3).isIndex()).toBe(true);
    expect(new Identifier('A').isIndex()).toBe(false);
    expect(new Identifier('').isIndex()).toBe(true);
  });
});

describe('writer: re-emits the document it was built from', () => {
  it('round-trips a document byte for byte (modulo the final newline)', () => {
    // The writer emits no trailing newline: the file's last newline is decoration of Eof,
    // which is never written. Confirmed by the goldens (normalized.wf has no final `\n`).
    const source = '@version 2\n\nA 1\nB {\n  C "x"\n  D [ 1, 2 ]\n}\n';
    const doc = new DocumentBuilder().buildDocumentText('p.wf', source);
    expect(new DocumentWriter().write(doc)).toBe(source.replace(/\n$/, ''));
  });

  it('writes an array of objects with the source comma placement', () => {
    const source = 'B [\n  {\n    X 1\n  }\n  ,\n  {\n    X 2\n  }\n ]\n';
    const doc = new DocumentBuilder().buildDocumentText('p.wf', source);
    expect(new DocumentWriter().write(doc)).toBe(source.replace(/\n$/, ''));
  });

  it('skips runtime properties, as native does', () => {
    const doc = new DocumentBuilder().buildDocumentText('p.wf', 'A 1\n');
    doc.add(new RuntimeScalarProperty(doc.getLocation(), new Identifier('Hidden')));
    expect(new DocumentWriter().write(doc)).toBe('A 1');
  });
});

// --------------------------------------------------------------------------------------
// 2. the schema: defaults, runtime, assertions, validation, evaluator seam
// --------------------------------------------------------------------------------------

describe('schema: defaults and runtime injection', () => {
  it('injects a schema default for every property the worldfile omits', () => {
    const { normalized } = emitWith(TEST_SCHEMA, '@version 2\nCount 7\n');
    expect(normalized).toContain('Count 7'); // the worldfile value wins
    expect(normalized).toContain('Blocked False'); // schema default injected
    expect(normalized).toContain('Points [ ]');
  });

  it('prefers the `defaults` variant named by `@defaults`', () => {
    expect(emitWith(TEST_SCHEMA, '@version 2\n').normalized).toContain('Seed 5');

    const legacy = emitWith(TEST_SCHEMA, '@version 2\n@defaults legacy\n').normalized;
    expect(legacy).toContain('Seed 0');
    expect(legacy).not.toContain('Seed 5');
  });

  it('injects runtime properties, refuses an assigned value, and never writes them', () => {
    const { worldfileDocument, normalized } = emitWith(TEST_SCHEMA, '@version 2\n');
    const shadow = worldfileDocument.requireProp('Shadow');

    expect(shadow).toBeInstanceOf(RuntimeScalarProperty);
    expect(shadow.getSubtype()).toBe('Runtime');
    expect(shadow.kind).toBe('runtime');
    expect(() => shadow.scalarText()).toThrowError(
      /Illegal request for value of runtime property\./,
    );
    expect(normalized).not.toContain('Shadow');

    expect(() => emitWith(TEST_SCHEMA, '@version 2\nShadow 1\n')).toThrowError(
      /Cannot assign value to runtime property\./,
    );
  });

  it('emits converted.wf before the schema is applied, and normalized.wf after', () => {
    const { converted, normalized } = emitWith(TEST_SCHEMA, '@version 2\nCount 7\n');
    expect(converted).toContain('Count 7');
    expect(converted).not.toContain('Blocked');
    expect(normalized).toContain('Blocked False');
    expect(normalized.length).toBeGreaterThan(converted.length);
  });
});

describe('schema: assertions and validation', () => {
  it('accepts a satisfied assertion and reports a failed one with its location', () => {
    expect(() =>
      emitWith(TEST_SCHEMA, '@version 2\n', { evaluator: assertTrue(), validate: true }),
    ).not.toThrow();

    expect(() =>
      emitWith(TEST_SCHEMA, '@version 2\n', {
        evaluator: scriptedEvaluator({ [COUNT_ASSERT]: 'False' }),
        validate: true,
      }),
    ).toThrowError(/Failed assertion at .*worldfile\.wfs:11/);
  });

  it('checks min/max with the native message', () => {
    expect(() =>
      emitWith(TEST_SCHEMA, '@version 2\nCount 99\n', { evaluator: assertTrue(), validate: true }),
    ).toThrowError(/99 > max 10/);

    expect(() =>
      emitWith(TEST_SCHEMA, '@version 2\nCount 0\n', { evaluator: assertTrue(), validate: true }),
    ).toThrowError(/0 < min 1/);

    expect(() =>
      emitWith(TEST_SCHEMA, '@version 2\nCount 4\n', { evaluator: assertTrue(), validate: true }),
    ).not.toThrow();
  });

  it('rejects a wrongly typed value and an unknown enum value', () => {
    const run = (worldfile: string): unknown =>
      emitWith(TEST_SCHEMA, worldfile, { evaluator: assertTrue(), validate: true });

    expect(() => run('@version 2\nCount 1.5\n')).toThrowError(/Expecting integer\./);
    expect(() => run('@version 2\nMode B\n')).not.toThrow();

    // An enum value is compared against the evaluated text, so the invalid-value error is
    // reached by a *quoted* value; an unquoted unknown symbol dies earlier, in evaluation
    // (native: a Python `NameError`, `[Python] name 'C' is not defined`).
    expect(() => run('@version 2\nMode "C"\n')).toThrowError(/Invalid enum value\./);
    expect(() => run('@version 2\nMode C\n')).toThrowError(/expression evaluation is lane L4/);
  });

  it('refuses a value with no schema definition, and allows it when lenient', () => {
    const worldfile = '@version 2\nNotInSchema 1\n';
    expect(() =>
      emitWith(TEST_SCHEMA, worldfile, { evaluator: assertTrue(), validate: true }),
    ).toThrowError(/No definition in schema\./);

    const { schema } = emitWith(TEST_SCHEMA, '@version 2\n');
    (schema as SchemaDocument).lenient = true;
    expect(() =>
      emitWith(TEST_SCHEMA, worldfile, { evaluator: assertTrue(), validate: true }),
    ).toThrowError(/No definition in schema\./);
  });

  it('consults the evaluator seam for every value it cannot take literally', () => {
    const seen: string[] = [];
    const counting: ExpressionEvaluator = {
      name: 'counting',
      evaluate(expression, owner) {
        seen.push(expression.write(false).trim());
        return schemaLiteralEvaluator.evaluate(expression, owner);
      },
    };

    emitWith(TEST_SCHEMA, '@version 2\n', { evaluator: counting });
    expect(seen).toContain('True'); // `runtime True` on Shadow
    expect(seen).toContain('Bool'); // `type Bool`, read as an enum value
  });

  it('fails loudly, never silently, when no evaluator can answer', () => {
    const strict: ExpressionEvaluator = {
      name: 'strict',
      evaluate(expression, owner) {
        return owner.err(`no evaluator (${expression.write(false)})`);
      },
    };

    expect(() => emitWith(TEST_SCHEMA, '@version 2\n', { evaluator: strict })).toThrowError(
      /no evaluator/,
    );
  });
});

describe('convert: parameters, and the v1 conversion', () => {
  it('applies a parameter at the replaced property location, keeping its decoration', () => {
    const { normalized } = emitWith(TEST_SCHEMA, '@version 2\n', {
      parameters: [['Blocked', 'True']],
    });
    expect(normalized).toContain('Blocked True');
    expect(normalized).not.toContain('Blocked False');
  });

  it('reports an unknown parameter path the way native does', () => {
    // `editor.set` calls `makePathDefaults` first, which walks the *schema* and fails on
    // the missing definition — before `findSymbol` is ever reached. Native's injected
    // top-level schema nodes carry `DocumentLocation( doc )` (lineno -1, unsigned), which
    // is why the description ends in `:4294967295`.
    expect(() =>
      emitWith(TEST_SCHEMA, '@version 2\n', { parameters: [['Nope', '1']] }),
    ).toThrowError(/worldfile\.wfs:4294967295: ERROR! No such property: 'Nope'/);
  });

  it('treats a document that does not start with @ as v1', () => {
    expect(isV1Source('A 1\n')).toBe(true);
    expect(isV1Source('')).toBe(true);
    expect(isV1Source('@version 2\n')).toBe(false);
  });

  it('converts v1 syntax and gives the document a .v2 identity', () => {
    const { schema } = emitWith(TEST_SCHEMA, '@version 2\n');
    const doc = new DocumentBuilder().buildWorldfileDocumentText(
      schema,
      'test.wf',
      'A [\n  1, 2\n]\n',
    );

    expect(doc.getPath()).toBe('test.wf.v2');

    const a = doc.requireProp('A');
    expect(a).toBeInstanceOf(ArrayProperty);
    expect(a.size()).toBe(2);
    expect(a.requireProp(0).scalarText()).toBe('1');
    expect(a.requireProp(1).scalarText()).toBe('2');
  });
});

// --------------------------------------------------------------------------------------
// 3. golden parity — the lane's acceptance
// --------------------------------------------------------------------------------------

/**
 * One recorded scenario plus the native override it was recorded with (`args` in the
 * registry): `*_voff` is `--Vision False`; `*_von` passes nothing at all, which leaves the
 * schema default in place. The two are kept apart on purpose — "pass the default
 * explicitly" and "pass nothing" are different parameter maps and both must be exercised.
 */
interface RecordedVariant {
  scenario: string;
  worldfile: string;
  vision: 'False' | null;
}

const VARIANTS: readonly RecordedVariant[] = [
  { scenario: 'minitest_voff', worldfile: MINITEST, vision: 'False' },
  { scenario: 'minitest_von', worldfile: MINITEST, vision: null },
  { scenario: 'microtest_voff', worldfile: MICROTEST, vision: 'False' },
  { scenario: 'microtest_von', worldfile: MICROTEST, vision: null },
];

type ScenarioSource = { schema: string; worldfile: string };

function variantSource(variant: RecordedVariant): ScenarioSource | undefined {
  return scenarioSources(variant.worldfile);
}

/** The native parameters of a variant, in `emitNormalizedWorldfile`'s shape. */
function variantParameters(variant: RecordedVariant): Map<string, string> {
  const parameters = new Map<string, string>();
  if (variant.vision !== null) parameters.set('Vision', variant.vision);
  return parameters;
}

/** Both goldens are recorded and the native tree is checked out, so the test can run. */
function variantReady(variant: RecordedVariant): boolean {
  return (
    variantSource(variant) !== undefined &&
    golden(variant.scenario, 'converted.wf') !== undefined &&
    golden(variant.scenario, 'normalized.wf') !== undefined
  );
}

/** Emit both documents of a recorded variant, exactly as its native run did. */
function emitVariant(variant: RecordedVariant): { converted: string; normalized: string } {
  const source = variantSource(variant) as ScenarioSource;
  return emitNormalizedWorldfile((path) => (path === SCHEMA_PATH ? source.schema : source.worldfile), {
    worldfilePath: variant.worldfile,
    schemaPath: SCHEMA_PATH,
    parameters: variantParameters(variant),
  });
}

/**
 * The native tree's *live* `run/`, when it is a record this lane can identify — else
 * `undefined`.
 *
 * `<native>/run/` is **not** a fixture here: `tools/record_oracle.py` moves it aside to
 * `run.previous.<epoch>` before every native run, and lanes record their own scenarios
 * continuously, so its contents belong to whichever scenario ran *last*.
 * `run/original.wf` — a verbatim copy of the worldfile a run was started from — names the
 * *worldfile* but not the *variant*: `minitest_von` and `minitest_voff` run the same
 * worldfile and differ only in the `--Vision` override, so their `original.wf` are
 * byte-identical. The variant is therefore read out of the run's own bytes, and the run is
 * claimed only when `normalized.wf` equals that variant's recorded golden — so another
 * lane's scenario, an unrecorded variant, and a half-written file (a record in flight) all
 * come back as "not identifiable" and the caller skips instead of reporting a diff.
 *
 * PORT-NOTE(w1b-tests/live-run-is-not-a-fixture): this lane's first cut asserted the
 * minitest emission against `<native>/run/normalized.wf` whenever that file existed. Every
 * native record rewrites that file, so the shared `npm test` gate went red with a diff
 * that read as a W1b parity break whenever the last record was some other run — it held
 * `microtest_von`'s bytes (11,886 B, `--Vision` unset) when this was written, against the
 * minitest golden's 11,889 B.
 */
function liveNativeRun(): { variant: RecordedVariant; converted: string; normalized: string } | undefined {
  const runDir = join(NATIVE_ROOT, 'run');
  let original: string;
  let normalized: string;
  let converted: string;
  try {
    original = readLatin1(join(runDir, 'original.wf'));
    normalized = readLatin1(join(runDir, 'normalized.wf'));
    converted = readLatin1(join(runDir, 'converted.wf'));
  } catch {
    return undefined; // no run tree, or one being rotated while we look at it
  }

  for (const variant of VARIANTS) {
    const source = variantSource(variant);
    if (source === undefined) continue;
    if (original !== source.worldfile) continue; // the worldfile this run started from
    if (normalized !== golden(variant.scenario, 'normalized.wf')) continue; // the variant
    return { variant, converted, normalized };
  }
  return undefined;
}

describe('golden parity: run/{converted,normalized}.wf', () => {
  for (const variant of VARIANTS) {
    const label = variant.vision === null ? 'no vision override' : `--Vision ${variant.vision}`;
    it(`reproduces oracle/${variant.scenario} byte for byte (${label})`, (ctx) => {
      if (!variantReady(variant)) {
        // A fresh worktree has the registration but not the goldens (`oracle/*/run/**` is
        // gitignored), and a machine without the native tree has neither. Skipping is the
        // house rule for that; the *note* keeps the reason visible in the report.
        ctx.skip(`${variant.scenario}: native tree or goldens absent`);
        return;
      }

      const result = emitVariant(variant);

      expect(result.normalized).toBe(golden(variant.scenario, 'normalized.wf'));
      expect(result.converted).toBe(golden(variant.scenario, 'converted.wf'));
    });
  }

  it("agrees with the native tree's live run/, when that run is an identifiable record", (ctx) => {
    const live = liveNativeRun();
    if (live === undefined) {
      ctx.skip(
        'native run/ is not an identifiable record: another scenario, an unrecorded variant, ' +
          'or a record in flight',
      );
      return;
    }

    const emitted = emitVariant(live.variant);
    expect(emitted.normalized).toBe(live.normalized);
    expect(emitted.converted).toBe(live.converted);
  });
});

// --------------------------------------------------------------------------------------
// 4. lane L4 — the expression language (native `interpreter.py`) and its code generation
// --------------------------------------------------------------------------------------

/** One recorded vector: the Python text, and what the native `python3` answered for it. */
interface RecordedVector {
  readonly source: string;
  readonly value?: string;
  readonly error?: string;
  readonly errorType?: string;
  readonly syntax?: boolean;
}

interface ExpressionVectors {
  readonly python: string;
  readonly corpusCount: number;
  readonly vectors: readonly RecordedVector[];
  readonly unsupportedByPort: readonly string[];
}

/**
 * The native half of the language contract, recorded from the real interpreter (never
 * transcribed by hand): `vectors` is `str( eval( text ) )` for every Python text lane L4's
 * code generation produced while building the four recorded scenarios *with the validation
 * pass on*, plus the language's own cases; `unsupportedByPort` is the grammar the port
 * refuses on purpose. Re-record with
 * `python3 src/model/proplib/native/record_python_vectors.py`.
 */
const EXPRESSION_VECTORS_PATH = join(
  __dirname,
  '..',
  'src',
  'model',
  'proplib',
  'native',
  'vectors',
  'pythonExpressions.json',
);

function expressionVectors(): ExpressionVectors {
  return JSON.parse(readFileSync(EXPRESSION_VECTORS_PATH, 'utf8')) as ExpressionVectors;
}

/** The message a `PythonError` carries, or `''` when the expression evaluated. */
function pythonFailure(source: string): string {
  try {
    evaluatePythonExpressionText(source);
    return '';
  } catch (error) {
    return error instanceof PythonError ? error.message : `not a PythonError: ${String(error)}`;
  }
}

describe('L4: the expression language, against the recorded python3', () => {
  const fixture = expressionVectors();

  it('is a recording of the real interpreter, over the worldfile corpus and the language', () => {
    expect(fixture.python).toMatch(/^\d+\.\d+/);
    expect(fixture.corpusCount).toBeGreaterThan(100);
    expect(fixture.vectors.length).toBeGreaterThan(fixture.corpusCount);
    expect(fixture.unsupportedByPort.length).toBeGreaterThan(5);
  });

  it('reproduces str(eval(text)) for every recorded vector', () => {
    const wrong: string[] = [];

    for (const vector of fixture.vectors) {
      if (vector.value !== undefined) {
        let actual: string;
        try {
          actual = evaluatePythonExpressionText(vector.source);
        } catch (error) {
          actual = `<threw ${(error as Error).message}>`;
        }
        if (actual !== vector.value) {
          wrong.push(
            `${JSON.stringify(vector.source)}: port ${JSON.stringify(actual)}, ` +
              `native ${JSON.stringify(vector.value)}`,
          );
        }
        continue;
      }

      // A *runtime* failure must carry the interpreter's own message (native reported it as
      // `[Python] <message>`). A *syntax* error only has to fail: CPython's text names the
      // file and line, which the port does not reproduce — see
      // PORT-NOTE(proplib/python-syntax-errors).
      const message = pythonFailure(vector.source);
      if (vector.syntax === true) {
        if (message === '') {
          wrong.push(`${JSON.stringify(vector.source)}: expected a syntax failure`);
        }
      } else if (message !== vector.error) {
        wrong.push(
          `${JSON.stringify(vector.source)}: port ${JSON.stringify(message)}, ` +
            `native ${JSON.stringify(vector.error)}`,
        );
      }
    }

    expect(wrong.join('\n')).toBe('');
  });

  // The recorded corpus reaches both `**` branches (`2.5 ** 2` and `2 ** -1`) but only at
  // values where libm `pow` and V8's `Math.pow` agree, so it cannot tell the two functions
  // apart. These two do, and they are the reason the branch calls the transcription
  // (`t_6c85ff6f`): Python's float `**` is libm `pow` on two doubles (`float_pow` →
  // `pow(iv, iw)`), V8's `Math.pow` is a different function — on these inputs CPython prints
  // `11.313708498984761` / `0.08838834764831845` and V8 gives `11.31370849898476` /
  // `0.08838834764831843`, one ulp low both times.
  it("calls libm `pow` for float `**` — V8's `Math.pow` is a different function", () => {
    expect(evaluatePythonExpressionText('2.0 ** 3.5')).toBe('11.313708498984761');
    expect(evaluatePythonExpressionText('pow(2.0, 3.5)')).toBe('11.313708498984761');
    expect(evaluatePythonExpressionText('2.0 ** -3.5')).toBe('0.08838834764831845');
  });

  it('refuses, loudly, the grammar it does not implement', () => {
    for (const source of fixture.unsupportedByPort) {
      expect(`${JSON.stringify(source)} ${pythonFailure(source)}`).toMatch(/port: /);
    }
  });
});

describe('L4: python code generation (native interpreter.cc)', () => {
  /** A schema whose defaults exercise every element kind the generator has a rule for. */
  const CODEGEN_SCHEMA = `
A {
  type    Int
  default 5
}

Copied {
  type    Int
  default A
}

Label {
  type    String
  default "hi"
}

Relabeled {
  type    String
  default Label
}

Switch {
  type    Bool
  default False
}

Chosen {
  type    Int
  default 1 if Switch else 2
}

Holder {
  type    Object
  default {}
  properties {
    Inner {
      type    Int
      default 1
    }
  }
}

Kind {
  type    Enum
  enum    Values { Alpha, Beta }
  default Alpha
}

Loop {
  type    Int
  default Loop
}
`;

  const built = () => emitWith(CODEGEN_SCHEMA, '@version 2\n', { validate: false });
  const expressionOf = (doc: Document, name: string) => {
    const prop = doc.requireProp(name);
    if (!(prop instanceof ConstScalarProperty)) throw new Error(`${name} is not a const scalar`);
    return prop.getExpression();
  };

  it('drops a trailing semicolon and keeps the source spacing, as native does', () => {
    const { worldfileDocument } = emitWith(TEST_SCHEMA, '@version 2\n');
    // `Seed`'s schema default is `default 5;` inside a `defaults` block.
    const seed = worldfileDocument.requireProp('Seed');
    const python = generatePythonExpression(
      (seed as ConstScalarProperty).getExpression(),
      seed as ConstScalarProperty,
    );
    expect(python).toBe('5');
    expect(seed.scalarText()).toBe('5');
  });

  it('substitutes a property reference with its evaluated value', () => {
    const { worldfileDocument } = built();
    expect(worldfileDocument.requireProp('Copied').scalarText()).toBe('5');
    expect(worldfileDocument.requireProp('Relabeled').scalarText()).toBe('hi');
    // A Bool property is *not* an enum value here (the port's `isEnumValue`), so its text goes
    // through bare -- and Python reads `False` as the bool, which is what native relied on.
    expect(worldfileDocument.requireProp('Switch').scalarText()).toBe('False');
    expect(worldfileDocument.requireProp('Chosen').scalarText()).toBe('2');
  });

  it('quotes an enum value or a class name, and reads the name back', () => {
    const { worldfileDocument } = built();
    const kind = worldfileDocument.requireProp('Kind');
    const python = generatePythonExpression(
      expressionOf(worldfileDocument, 'Kind'),
      kind as ConstScalarProperty,
    );
    expect(python).toBe('"Alpha"');
    expect(kind.scalarText()).toBe('Alpha');
  });

  it('reports a dependency cycle the way native did', () => {
    const { worldfileDocument } = built();
    expect(() => worldfileDocument.requireProp('Loop').scalarText()).toThrowError(
      /Dependency cycle/,
    );
    // ... and the validation pass, which reads values, hits it first when it is asked for.
    expect(() =>
      emitWith(CODEGEN_SCHEMA, '@version 2\n', { validate: true }),
    ).toThrowError(/Dependency cycle/);
  });

  it('reports the interpreter message native wrapped in `[Python] `', () => {
    // An unknown symbol is left verbatim by the code generation and becomes a Python
    // `NameError`, which is exactly what native reported (and why a typo is loud).
    const doc = new DocumentBuilder().buildDocumentText('p.wf', '@version 2\nWeird Misspelled\n');
    expect(() => doc.requireProp('Weird').scalarText()).toThrowError(
      /\[Python\] name 'Misspelled' is not defined/,
    );
  });

  it('is the default evaluator for a document build', () => {
    expect(interpreterEvaluator.name).toContain('python3');
    // The pre-L4 stand-in stays exported for the tests that drive the seam with it.
    expect(schemaLiteralEvaluator.name).toContain('stand-in');
    // ... and a private instance is available for isolation, with the same behavior.
    const isolated = createInterpreterEvaluator();
    expect(isolated.evaluate).toBeTypeOf('function');
    const { worldfileDocument } = emitWith(CODEGEN_SCHEMA, '@version 2\n', { evaluator: isolated });
    expect(worldfileDocument.requireProp('Copied').scalarText()).toBe('5');
  });
});

describe('L4: golden parity with the real evaluator and the validation pass on', () => {
  for (const variant of VARIANTS) {
    it(`emits oracle/${variant.scenario} byte for byte, and reads every scalar`, (ctx) => {
      if (!variantReady(variant)) {
        ctx.skip(`${variant.scenario}: native tree or goldens absent`);
        return;
      }

      const source = variantSource(variant) as ScenarioSource;
      const builtWith = (validate: boolean) =>
        emitNormalizedWorldfile((path) => (path === SCHEMA_PATH ? source.schema : source.worldfile), {
          worldfilePath: variant.worldfile,
          schemaPath: SCHEMA_PATH,
          parameters: variantParameters(variant),
          evaluator: interpreterEvaluator,
          validate,
        });

      // Native's ctor runs `apply()` **with** validation; it is the only pass that reads a
      // value, so it is the only one the stand-in ever blocked.
      const built = builtWith(true);
      expect(built.normalized).toBe(golden(variant.scenario, 'normalized.wf'));
      expect(built.converted).toBe(golden(variant.scenario, 'converted.wf'));
      // The pass is read-only: the off variant is the same document.
      expect(builtWith(false).normalized).toBe(built.normalized);

      // Every scalar must evaluate, because that is what `Config` does at sim boot
      // (`new Config( doc )` reads `getInt`/`getFloat`/`getBool`/`getString` per key).
      const unreadable: string[] = [];
      const walk = (prop: Property): void => {
        let children: readonly Property[] = [];
        try {
          children = prop.props();
        } catch {
          children = [];
        }
        for (const child of children) walk(child);
        if (prop.kind !== 'scalar') return;
        try {
          prop.scalarText();
        } catch (error) {
          unreadable.push(`${prop.getFullName(0, '.')}: ${(error as Error).message}`);
        }
      };
      walk(built.worldfileDocument as unknown as Property);
      expect(unreadable.join('\n')).toBe('');
    });
  }
});

// --------------------------------------------------------------------------------------
// misc: public surface sanity
// --------------------------------------------------------------------------------------

describe('public surface', () => {
  it('exports the pieces lanes were promised', () => {
    for (const exported of [
      emitNormalizedWorldfile,
      DocumentWriter,
      DocumentBuilder,
      SchemaDocument,
      ProplibEnum,
      ObjectProperty,
      Document,
      Property,
      ConfigError,
      Tokenizer,
    ]) {
      expect(typeof exported).toBe('function');
    }
  });
});
