/**
 * Lane L5 (genome) × lane W1h (cppprops) — the `genome::` gene-read binding.
 *
 * A `dyn` body whose schema cppsym is a `$[gene, NAME, min|max]` macro is bound to the
 * gene's own `Scalar` by `CppProperties_Init()`
 * (`metadata[i].value = &(…->smin|smax.__val)`), so the property's *value* is the gene's
 * range member. `tools/cppprops/bindings/gene.mjs` serves that from the port's genome
 * layer; this test pins it against the native binary three ways:
 *
 *  1. **The native's own gene ranges.** `run/genome/meta/generange.txt` is written by
 *     `Gene::printRanges` in the real build — kept here for the `gene_dyn` recording
 *     (`fixtures/native/gene_dyn.generange.txt`) and read from the frozen oracle scenario
 *     (`oracle/minitest_voff/run/genome/meta/generange.txt`). The port's genome layer
 *     (`GenomeUtil` → `Gene::getMin/getMax`) must reproduce those values, which is what the
 *     binding is asked to serve.
 *  2. **A native probe of the union read** (`src/model/genome/native/genevalueprobe.cc`,
 *     `native/vectors/geneValues.txt`): `&(Scalar::__val)` is the address of `Scalar`'s
 *     union, so which member the native reads is decided by the *property's* type
 *     (`*(float *)value` …). The probe measures the FLOAT/INT rows bit-exactly and marks the
 *     BOOL rows undefined — the read the binding refuses.
 *  3. **The native farm log of `gene_dyn`.** The worldfile only *adds* a `dyn` form to
 *     `MinEnergyFractionToOffspring` (whose cppsym is the gene read) on top of `growers_dyn`;
 *     the recorded run's `generated.cc` carries the expression and its farm log carries the
 *     value at every step. The port's replay — with the gene table built from the port's own
 *     genome layer — must reproduce all 300 lines.
 *
 * Nothing here is a hand-written expectation: every number is read out of an artifact the
 * native build produced.
 * Load, not slowness of the code: the guarded test(s) are 727 ms solo and 2.2 s under four
 * concurrent full suites — the band that false-reds when the fleet's three concurrent pairs
 * (6 processes) run. They carry LOAD_TIMEOUT_MS below; no assertion changed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { Config } from '../src/model/types';
import { GenomeSchema, GenomeUtil, readGenomeSchemaInputs, toInterpolated } from '../src/model/genome';
import { emitNormalizedWorldfile } from '../src/model/proplib';
import { CppPropsEvaluator, compilePortableBody } from '../tools/cppprops/lib/cppprops.mjs';
import { parseGeneReads } from '../tools/cppprops/lib/genesymbol.mjs';
import defaultBindings from '../tools/cppprops/bindings/index.mjs';
import {
  geneNamesInSpec,
  geneTableFromGenomeUtil,
  nativeUnionRead,
} from '../tools/cppprops/bindings/gene.mjs';

// ==================================================================================== //
// Environment
// ==================================================================================== //

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TOOLS = join(REPO, 'tools', 'cppprops');
const FIXTURES = join(TOOLS, 'fixtures');
const NATIVE_ROOT = resolve(process.env['POLYWORLD_NATIVE'] ?? join(REPO, '..', 'polyworld'));
const ORACLE_ROOT = resolve(process.env['POLYWORLD_ORACLE_ROOT'] ?? join(REPO, 'oracle'));
const SCHEMA_PATH = './etc/worldfile.wfs';
const NATIVE_SCHEMA = join(NATIVE_ROOT, 'etc', 'worldfile.wfs');
const PYTHON = process.env['PYTHON'] ?? 'python3';

const haveNativeTree = existsSync(NATIVE_SCHEMA);
const haveNativeBuild = existsSync(join(NATIVE_ROOT, 'lib', 'libpolyworld.dylib'));
const GENE_DYN_WORLD = join(FIXTURES, 'worldfiles', 'gene_dyn.wf');
const GENE_DYN_FARM_LOG = join(FIXTURES, 'native', 'gene_dyn.farm.log');
const GENE_DYN_STATE = join(FIXTURES, 'state', 'gene_dyn.state.json');

/** The emitted form of `$[gene, NAME, min|max]` (`cppprops.cc: getCppSymbol`). */
const MATE_MIN =
  'genome::GeneType::to___Interpolated(genome::GenomeUtil::getGene("MateEnergyFraction", ' +
  '"etc/worldfile.wfs:1619: Cannot find gene \'MateEnergyFraction\'"))->smin.__val';
const MATE_MAX = MATE_MIN.replace('->smin.', '->smax.');

/** `fixtures/manifest.json`'s runtimeMap for a single-metabolism growers recording. */
const GROWERS_RUNTIME_MAP: Record<string, string> = {
  Step: 'step',
  AgentCount: 'agents',
  FoodCount: 'food',
  'AgentMetabolisms[0].MetabolismAgentCount': 'agents',
};

// ==================================================================================== //
// Helpers
// ==================================================================================== //

/**
 * The port's genome layer for one worldfile text — the object a `ctx.engine.geneValue`
 * caller wires up (`GenomeUtil` is native's `GenomeUtil`, `Gene::getMin/getMax` its
 * `smin`/`smax`).
 */
function genomeUtilFor(worldfilePath: string, text: string): GenomeUtil {
  const built = emitNormalizedWorldfile(
    (path) => (path === SCHEMA_PATH ? readFileSync(NATIVE_SCHEMA, 'utf8') : text),
    { worldfilePath, schemaPath: SCHEMA_PATH },
  );
  const cfg = new Config(built.worldfileDocument);
  GenomeSchema.processWorldfile(cfg);
  const util = new GenomeUtil();
  util.createSchema(readGenomeSchemaInputs(cfg));
  return util;
}

/** `run/genome/meta/generange.txt`'s line for `gene`: `<rounding> <min> <max> <name>`. */
function nativeRangeLine(listing: string, gene: string): readonly [string, string] {
  const line = listing
    .split('\n')
    .map((text) => text.trim().split(/\s+/))
    .find((parts) => parts[parts.length - 1] === gene);
  if (!line) throw new Error(`no generange line for '${gene}'`);
  // `None FLOAT 0.500000 FLOAT 0.800000 MateEnergyFraction` -> [smin, smax]
  return [line[2] as string, line[4] as string];
}

/** The port's `Scalar::str()` text for a gene's range member (`FLOAT 0.500000`). */
function portRangeText(util: GenomeUtil, gene: string): readonly [string, string] {
  const found = util.getGene(gene, `Cannot find gene '${gene}'`);
  if (!found) throw new Error(`port genome layer has no gene '${gene}'`);
  const interpolated = toInterpolated(found);
  return [interpolated.getMin().str(), interpolated.getMax().str()];
}

/** The engine JSON a CLI caller passes: `{ genes: { NAME: { kind, min, max } } }`. */
function geneEngine(util: GenomeUtil, spec: unknown): string {
  const table = geneTableFromGenomeUtil(util, geneNamesInSpec(spec));
  return JSON.stringify({ genes: table });
}

interface ProbeRow {
  readonly label: string;
  readonly kind: string;
  readonly scalarText: string;
  readonly low32?: string;
  readonly float?: string;
  readonly int?: string;
  readonly bool: boolean;
}

/** The rows `genevalueprobe` printed (its own output, verbatim). */
function probeRows(): ProbeRow[] {
  const text = readFileSync(join(REPO, 'src', 'model', 'genome', 'native', 'vectors', 'geneValues.txt'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.startsWith('scalar '))
    .map((line) => {
      const field = (name: string): string | undefined =>
        new RegExp(`${name}=([^ ]+)`).exec(line)?.[1];
      return {
        label: field('label') as string,
        kind: field('kind') as string,
        scalarText: `${field('kind')} ${field('str')?.split(' ')[1]}`,
        low32: field('low32'),
        float: field('float'),
        int: field('int'),
        bool: field('bool') === 'True',
      };
    });
}

/** The `Scalar` value a probe row was built from (`float_0.2` -> f32(0.2), `int_7` -> 7). */
function probeInput(row: ProbeRow): number {
  const payload = row.label.slice(row.label.indexOf('_') + 1);
  if (row.kind === 'INT') return parseInt(payload, 10);
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, parseInt(row.low32 as string, 16));
  return view.getFloat32(0);
}

/** A minimal dynamic-property spec, the shape `extract_cppprops.py` writes. */
function onePropertySpec(options: {
  readonly cppSymbol: string;
  readonly updateBody: string;
  readonly initial: string;
  readonly portable: boolean;
}) {
  return {
    formatVersion: 1,
    worldfile: 'synthetic.wf',
    schema: SCHEMA_PATH,
    updateOrder: ['MinEnergyFractionToOffspring'],
    properties: [
      {
        index: 0,
        name: 'MinEnergyFractionToOffspring',
        kind: 'Dynamic',
        datalibType: 'FLOAT',
        cppType: 'float',
        cppSymbol: options.cppSymbol,
        dynamic: {
          initial: options.initial,
          initBody: '',
          updateBody: options.updateBody,
          updateSource: 'update',
          metadataRefs: {},
          updatePortable: options.portable,
          updateUnportableSymbols: options.portable
            ? []
            : ['genome::GeneType::to___Interpolated', 'genome::GenomeUtil::getGene'],
          initPortable: true,
          initUnportableSymbols: [],
          portable: options.portable,
          stateStruct: null,
          stage: -1,
        },
      },
    ],
  };
}

// ==================================================================================== //
// 1 — the native gene ranges, and the port's genome layer that must reproduce them
// ==================================================================================== //

/**
 * Vitest's default is 5 s. The guarded test(s) are 727 ms solo and 2.2 s under four concurrent
 * full suites; the fleet also runs three concurrent pairs (6 processes), and at that load the
 * orchestrator measured a 946 ms-solo test false-red 6/6 on 2026-09-29 — this is the same band.
 * 60 s is the budget the vision-on gate already carries (t_1f4a7a8a): that measurement with room,
 * and still a guard, so a genuine hang fails.
 */
const LOAD_TIMEOUT_MS = 60_000;

describe.skipIf(!haveNativeTree)('L5 × W1h — the gene a `$[gene,…]` symbol names (native ranges)', () => {
  it('reproduces gene_dyn’s own native gene range (MateEnergyFraction 0.5 / 0.8)', () => {
    const native = nativeRangeLine(
      readFileSync(join(FIXTURES, 'native', 'gene_dyn.generange.txt'), 'utf8'),
      'MateEnergyFraction',
    );
    const util = genomeUtilFor(GENE_DYN_WORLD, readFileSync(GENE_DYN_WORLD, 'utf8'));

    // `MinEnergyFractionToOffspring dyn( 0.5 ) …` is the worldfile's value of the key
    // that configures `MateEnergyFraction.min`, so the native's own range file says
    // 0.5 — the worldfile moved the gene's minimum, it did not merely name it.
    expect(portRangeText(util, 'MateEnergyFraction')).toEqual([
      `FLOAT ${Number(native[0]).toFixed(6)}`,
      `FLOAT ${Number(native[1]).toFixed(6)}`,
    ]);
    expect(native).toEqual(['0.500000', '0.800000']);
  });

  it('reproduces the oracle scenario’s native gene range (0.2 / 0.8)', () => {
    const oracle = readFileSync(
      join(ORACLE_ROOT, 'minitest_voff', 'run', 'genome', 'meta', 'generange.txt'),
      'utf8',
    );
    const worldfile = join(ORACLE_ROOT, 'minitest_voff', 'run', 'normalized.wf');
    const util = genomeUtilFor(worldfile, readFileSync(worldfile, 'utf8'));

    const native = nativeRangeLine(oracle, 'MateEnergyFraction');
    expect(native).toEqual(['0.200000', '0.800000']);
    expect(portRangeText(util, 'MateEnergyFraction')).toEqual([
      `FLOAT ${Number(native[0]).toFixed(6)}`,
      `FLOAT ${Number(native[1]).toFixed(6)}`,
    ]);
  });
});

// ==================================================================================== //
// 2 — the union read, pinned against the native probe
// ==================================================================================== //

describe('L5 × W1h — the native union read of a gene’s Scalar (probe vectors)', () => {
  const rows = probeRows();

  it('has the probe rows this test was written against', () => {
    expect(rows.map((row) => row.label)).toEqual([
      'float_0.2',
      'float_0.5',
      'float_-0.970895',
      'int_7',
      'int_-1',
      'int_1065353216',
      'bool_true',
      'bool_false',
    ]);
  });

  it.skipIf(!haveNativeBuild)('is what the probe prints now (native re-run)', () => {
    // The vectors are the probe's own output, not a transcription: recompile and compare.
    const fresh = execFileSync(
      join(REPO, 'src', 'model', 'genome', 'native', 'run_genevalueprobe.sh'),
      { encoding: 'utf8' },
    );
    expect(fresh).toEqual(
      readFileSync(join(REPO, 'src', 'model', 'genome', 'native', 'vectors', 'geneValues.txt'), 'utf8'),
    );
  }, LOAD_TIMEOUT_MS);

  it('reads a FLOAT Scalar through a float / int / bool property as native does', () => {
    for (const row of rows.filter((candidate) => candidate.kind === 'FLOAT')) {
      const value = probeInput(row);
      expect([row.label, nativeUnionRead('FLOAT', value, 'float')]).toEqual([row.label, Number(row.float)]);
      expect([row.label, nativeUnionRead('FLOAT', value, 'int')]).toEqual([row.label, Number(row.int)]);
      expect([row.label, nativeUnionRead('FLOAT', value, 'bool')]).toEqual([row.label, row.bool]);
    }
  });

  it('reads an INT Scalar through a float / int / bool property as native does', () => {
    for (const row of rows.filter((candidate) => candidate.kind === 'INT')) {
      const value = probeInput(row);
      expect([row.label, nativeUnionRead('INT', value, 'int')]).toEqual([row.label, Number(row.int)]);
      const expected = Number(row.float);
      const actual = nativeUnionRead('INT', value, 'float') as number;
      // int_-1 is 0xffffffff, i.e. an f32 that is not a number: same bits, same NaN.
      expect([row.label, Number.isNaN(actual)]).toEqual([row.label, Number.isNaN(expected)]);
      if (!Number.isNaN(expected)) expect([row.label, actual]).toEqual([row.label, expected]);
      expect([row.label, nativeUnionRead('INT', value, 'bool')]).toEqual([row.label, row.bool]);
    }
  });

  it('refuses the float/int read of a BOOL Scalar, which the native leaves undefined', () => {
    for (const row of rows.filter((candidate) => candidate.kind === 'BOOL')) {
      // The probe marks the read undefined because `Scalar::Scalar(bool)` writes one byte
      // of the union; the native `*(float *)value` therefore reads uninitialized memory.
      expect([row.label, row.float, row.int]).toEqual([row.label, 'undefined', 'undefined']);
      expect([row.label, nativeUnionRead('BOOL', row.bool, 'bool')]).toEqual([row.label, row.bool]);
      expect(() => nativeUnionRead('BOOL', row.bool, 'float')).toThrow(/uninitialized|undefined/i);
      expect(() => nativeUnionRead('BOOL', row.bool, 'int')).toThrow(/uninitialized|undefined/i);
    }
  });

  it('refuses a property type the native has no read for', () => {
    expect(() => nativeUnionRead('FLOAT', 0.5, 'string')).toThrow(/no native union read/);
    expect(() => nativeUnionRead('FLOAT', 0.5, 'double')).toThrow(/no native union read/);
  });
});

// ==================================================================================== //
// 3 — the symbol shape, and the refusals
// ==================================================================================== //

describe('L5 × W1h — the `genome::` symbol shape', () => {
  it('parses the expanded form the extractor emits', () => {
    expect(parseGeneReads(MATE_MIN)).toEqual([
      { name: 'MateEnergyFraction', err: expect.stringContaining("Cannot find gene 'MateEnergyFraction'"), member: 'min', accessor: 'smin', text: MATE_MIN },
    ]);
    expect(parseGeneReads(MATE_MAX)[0]?.member).toBe('max');
  });

  it('parses the unexpanded macro too (a hand-built spec)', () => {
    expect(parseGeneReads('$[gene, SizeX, max]')).toEqual([
      { name: 'SizeX', err: '', member: 'max', accessor: 'smax', text: '$[gene, SizeX, max]' },
    ]);
  });

  it('refuses a genome:: symbol it does not recognise', () => {
    expect(() => parseGeneReads('genome::GenomeUtil::somethingElse( "SizeX" )')).toThrow(
      /unrecognised gene read/,
    );
    expect(() => parseGeneReads('genome::GeneType::to___Interpolated( unknown() )->smin')).toThrow(
      /unrecognised gene read/,
    );
  });

  it('refuses a body the interpreter cannot evaluate even after substitution', () => {
    expect(() => compilePortableBody('return FoodPatchTokenRing::update( parent );')).toThrow(
      /engine state/,
    );
    expect(() => compilePortableBody('return context->sim->fStep;')).toThrow(/engine state/);
    expect(() => compilePortableBody('return somethingUnknown( 1 );')).toThrow(/names somethingUnknown/);
  });
});

// ==================================================================================== //
// 4 — what the binding serves, and what it refuses
// ==================================================================================== //

/** The emitted spelling of a property's own lvalue (`value` inside a body). */
function selfLvalue(index = 0): string {
  return `*((float*)metadata[/*MinEnergyFractionToOffspring*/ ${index}].value)`;
}

describe('L5 × W1h — the gene binding', () => {
  const geneEntry = defaultBindings['genome'] as {
    init(ctx: unknown): void;
    update(ctx: unknown): unknown;
  };
  const engine = { genes: { MateEnergyFraction: { kind: 'FLOAT', min: 0.2, max: 0.8 } } };

  /** The binding context the interpreter hands a binding, with the hooks a test sees. */
  function context(overrides: Record<string, unknown> = {}) {
    const writes: Record<string, unknown> = {};
    return {
      writes,
      ctx: {
        name: 'MinEnergyFractionToOffspring',
        cppType: 'float',
        cppSymbol: MATE_MIN,
        updateBody: '',
        engine,
        set: (name: string, value: unknown) => void (writes[name] = value),
        // The interpreter's own portable-body compiler, for anything around the read.
        evalBody: (text: string) =>
          (compilePortableBody(text) as (...args: unknown[]) => unknown)(
            () => 0,
            Math.min,
            Math.max,
            Math,
          ),
        ...overrides,
      },
    };
  }

  it('serves the gene read as the property’s storage (native CppProperties_Init)', () => {
    const { ctx, writes } = context();
    geneEntry.init(ctx);
    expect(writes).toEqual({ MinEnergyFractionToOffspring: Math.fround(0.2) });
  });

  it('serves a body that is the gene read, both members', () => {
    expect(geneEntry.update(context({ updateBody: `return ${MATE_MIN};` }).ctx)).toBe(Math.fround(0.2));
    expect(geneEntry.update(context({ updateBody: `return ${MATE_MAX};` }).ctx)).toBe(Math.fround(0.8));
  });

  it('serves a body with the read inside an expression', () => {
    const { ctx } = context({ updateBody: `return min( 0.5, ${MATE_MAX} + 0.001 );` });
    expect(geneEntry.update(ctx)).toBe(Math.min(0.5, Math.fround(0.8) + 0.001));
  });

  it('refuses with no gene source at all', () => {
    expect(() => geneEntry.init(context({ engine: {} }).ctx)).toThrow(/no gene source/);
  });

  it('refuses an unknown gene, quoting the emitted native error text', () => {
    expect(() => geneEntry.init(context({ engine: { genes: {} } }).ctx)).toThrow(
      /worldfile\.wfs:1619: Cannot find gene 'MateEnergyFraction'/,
    );
  });

  it('refuses a gene source entry that is missing its kind or range member', () => {
    const noKind = { genes: { MateEnergyFraction: { min: 0.2, max: 0.8 } } };
    expect(() => geneEntry.init(context({ engine: noKind }).ctx)).toThrow(/no Scalar kind/);
    const noRange = { genes: { MateEnergyFraction: { kind: 'FLOAT' } } };
    expect(() => geneEntry.init(context({ engine: noRange }).ctx)).toThrow(/no 'min' range/);
  });

  it('refuses a body that names no gene read', () => {
    expect(() => geneEntry.update(context({ updateBody: `return ${selfLvalue()};` }).ctx)).toThrow(
      /names no gene read/,
    );
  });

  it('refuses a body with engine state left after substituting the read', () => {
    const { ctx } = context({ updateBody: `return FoodPatchTokenRing::update( parent ) && ${MATE_MIN};` });
    expect(() => geneEntry.update(ctx)).toThrow(/engine state/);
  });
});

// ==================================================================================== //
// 5 — end to end: the fixture's native farm log
// ==================================================================================== //

describe.skipIf(!haveNativeTree)('L5 × W1h — the gene_dyn fixture', () => {
  /** Extract the spec for the fixture, plus the emitted C++ the native run cross-checks. */
  function extract(workdir: string) {
    const specPath = join(workdir, 'gene_dyn.spec.json');
    const ccPath = join(workdir, 'gene_dyn.generated.cc');
    execFileSync(
      PYTHON,
      [
        join(TOOLS, 'extract_cppprops.py'),
        '--worldfile',
        GENE_DYN_WORLD,
        '--schema',
        NATIVE_SCHEMA,
        // The schema document's own name, which is what the native spells in a
        // location description (Simulation.cc:270 passes this literal).
        '--schema-name',
        SCHEMA_PATH,
        '--out',
        specPath,
        '--emit-cc',
        ccPath,
      ],
      { stdio: 'pipe' },
    );
    return { specPath, ccPath, spec: JSON.parse(readFileSync(specPath, 'utf8')) as Record<string, unknown> };
  }

  function tracePath(workdir: string): string {
    const state = JSON.parse(readFileSync(GENE_DYN_STATE, 'utf8')) as {
      steps: Record<string, number>[];
    };
    const steps = state.steps.map((record) => ({
      step: record['step'],
      values: Object.fromEntries(
        Object.entries(GROWERS_RUNTIME_MAP).map(([name, key]) => [name, record[key]]),
      ),
    }));
    const path = join(workdir, 'gene_dyn.trace.json');
    writeFileSync(path, JSON.stringify({ formatVersion: 1, scenario: 'gene_dyn', steps }));
    return path;
  }

  it('emits the native gene expression, error location included', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'cppprops-gene-'));
    try {
      const { ccPath } = extract(workdir);
      const emitted = readFileSync(ccPath, 'utf8');
      const native = readFileSync(join(FIXTURES, 'native', 'gene_dyn.generated.cc'), 'utf8');
      const geneLine = (text: string): string =>
        text.split('\n').find((line) => line.includes('metadata[8].value = &(genome::')) as string;

      expect(geneLine(native)).toContain('genome::GenomeUtil::getGene("MateEnergyFraction"');
      expect(geneLine(native)).toContain('->smin.__val');
      // The whole emitted file is the recording, `Property::getLocation().getDescription()`
      // included: `./etc/worldfile.wfs:1619` is the schema *document's own name*
      // (the literal `Simulation.cc:270` hands `buildSchemaDocument`) plus the line of
      // the schema's `cppsym` property - so the gene symbol's location is the schema's,
      // never the worldfile's (`extract --schema-name`; verified whole-file by
      // `tools/cppprops/verify_cppprops.py`, which derives that name from the manifest).
      expect(geneLine(emitted)).toEqual(geneLine(native));
      expect(emitted).toEqual(native);
      // ... and the spec carries the same symbol as the property's storage binding.
      const { spec } = extract(workdir);
      const properties = spec['properties'] as Record<string, unknown>[];
      const bound = properties.find((prop) => prop['name'] === 'MinEnergyFractionToOffspring');
      expect(bound?.['kind']).toBe('Dynamic');
      expect(bound?.['cppSymbol']).toMatch(/^genome::GeneType::to___Interpolated\(/);
      expect((bound?.['dynamic'] as Record<string, unknown>)['portable']).toBe(true);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }, LOAD_TIMEOUT_MS);

  it('re-anchors a synthetic gene-bound spec and exits 3 without the binding', () => {
    // The card's literal case: a `portable: false` body that *is* the gene read. (With the
    // shipped schema the emission puts the symbol in the metadata binding instead — see
    // the fixture above — so this is the harness the contract allows for that arm.)
    const spec = onePropertySpec({ cppSymbol: MATE_MAX, updateBody: `return ${MATE_MAX};`, initial: '0.9', portable: false });
    const unbound = new CppPropsEvaluator(spec, { bindings: {} });
    expect(unbound.missingBindings).toEqual([
      { name: 'MinEnergyFractionToOffspring', symbols: ['genome::GeneType::to___Interpolated', 'genome::GenomeUtil::getGene', MATE_MAX] },
    ]);

    const worldfile = join(ORACLE_ROOT, 'minitest_voff', 'run', 'normalized.wf');
    const util = genomeUtilFor(worldfile, readFileSync(worldfile, 'utf8'));
    const evaluator = new CppPropsEvaluator(spec, {
      bindings: defaultBindings,
      engine: { genes: geneTableFromGenomeUtil(util, ['MateEnergyFraction']) },
    });
    expect(evaluator.missingBindings).toEqual([]);
    evaluator.init();
    evaluator.step({});
    // The native value: `MateEnergyFraction`'s max, straight out of the oracle's own
    // `generange.txt` (0.800000), not the spec's 0.9.
    expect(evaluator.snapshot()['MinEnergyFractionToOffspring']).toBe(Math.fround(0.8));
  });

  it('seeds a portable body’s storage from the gene, not from the spec’s initial value', () => {
    const spec = onePropertySpec({
      cppSymbol: MATE_MIN,
      updateBody: `return ${selfLvalue()};`,
      initial: '0.9',
      portable: true,
    });
    const worldfile = join(ORACLE_ROOT, 'minitest_voff', 'run', 'normalized.wf');
    const util = genomeUtilFor(worldfile, readFileSync(worldfile, 'utf8'));
    const engine = { genes: geneTableFromGenomeUtil(util, ['MateEnergyFraction']) };

    const withGene = new CppPropsEvaluator(spec, { bindings: defaultBindings, engine });
    withGene.init();
    withGene.step({});
    // 0.2 is the oracle's own `FLOAT 0.200000 MateEnergyFraction` minimum; the spec's
    // `dynamic.initial` (0.9) is what a port that ignored the cpp symbol would serve.
    expect(withGene.snapshot()['MinEnergyFractionToOffspring']).toBe(Math.fround(0.2));

    // Without the gene source the port refuses rather than serving the spec's 0.9.
    const bare = new CppPropsEvaluator(spec, { bindings: defaultBindings });
    expect(() => bare.init()).toThrow(/no gene source/);
  });

  it('replays the recorded run against the port’s genome layer, 300/300 native lines', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'cppprops-gene-'));
    try {
      const { specPath, spec } = extract(workdir);
      const util = genomeUtilFor(GENE_DYN_WORLD, readFileSync(GENE_DYN_WORLD, 'utf8'));
      const enginePath = join(workdir, 'genes.json');
      writeFileSync(enginePath, geneEngine(util, spec));

      // The gene table the run used *is* the native run's own range file.
      const native = nativeRangeLine(
        readFileSync(join(FIXTURES, 'native', 'gene_dyn.generange.txt'), 'utf8'),
        'MateEnergyFraction',
      );
      expect(geneTableFromGenomeUtil(util, ['MateEnergyFraction'])).toEqual({
        MateEnergyFraction: {
          kind: 'FLOAT',
          min: Math.fround(Number(native[0])),
          max: Math.fround(Number(native[1])),
        },
      });

      const stdout = execFileSync(
        process.execPath,
        [
          join(TOOLS, 'run_cppprops.mjs'),
          '--spec', specPath,
          '--state', tracePath(workdir),
          '--engine', enginePath,
          '--format', 'native',
          '--quiet',
        ],
        { encoding: 'utf8' },
      );

      const lines = (text: string) =>
        text.split('\n').filter((line) => line.startsWith('[')).map((line) => line.trim());
      const titleToName = new Map(
        [...readFileSync(join(FIXTURES, 'harness', 'term.mf'), 'utf8').matchAll(
          /\{\s*Name\s*"([^"]*)"\s*;\s*Title\s*"([^"]*)"/g,
        )].map((match) => [match[2] as string, match[1] as string]),
      );
      const nativeLines = lines(readFileSync(GENE_DYN_FARM_LOG, 'utf8'));
      const portLines = lines(stdout);
      expect(portLines.length).toBe(300);
      expect(nativeLines.length).toBe(300);

      const pairs = (line: string): [string, string][] =>
        [...line.slice(1, -1).matchAll(/([^=\s]+)=([^\s]*)/g)].map((match) => [
          match[1] as string,
          match[2] as string,
        ]);

      const mismatches: string[] = [];
      portLines.forEach((line, index) => {
        const port = new Map(pairs(line));
        for (const [key, value] of pairs(nativeLines[index] as string)) {
          const name = titleToName.get(key) ?? key;
          if (port.get(name) !== value) {
            mismatches.push(`step ${index + 1} ${name}: port ${port.get(name)}, native ${value}`);
          }
        }
      });
      expect(mismatches).toEqual([]);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }, LOAD_TIMEOUT_MS);
});
