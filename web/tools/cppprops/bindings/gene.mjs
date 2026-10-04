/**
 * `genome::` gene-read binding (W1h residual 1a — lane L5 genome).
 *
 * PORT-NOTE(cppprops/gene-binding): `etc/worldfile.wfs` gives seven scalar
 * properties a `$[gene, NAME, min|max]` cpp symbol — `Min`/`MaxEnergyFractionToOffspring`
 * (`MateEnergyFraction` min/max) and `Sheets.{Min,Max}BrainSize.{X,Y,Z}`
 * (`SizeX/Y/Z` min/max).  `CppProperties::getCppSymbol()` expands that to
 *
 *     genome::GeneType::to___Interpolated(genome::GenomeUtil::getGene("NAME",
 *         "<loc>: Cannot find gene 'NAME'"))->smin|smax.__val
 *
 * and `CppProperties_Init()` uses it as the property's **storage location**:
 *
 *     metadata[i].value = &(…->smin.__val);
 *
 * `smin`/`smax` are `Scalar`s (`utils/Scalar.h`), `__val` is the first member
 * of `Scalar`'s `union { void *__val; int ival; float fval; bool bval; }`, and
 * `&(s.__val)` is the address of that union — so the property *is* the gene's
 * range field:
 *
 *   * `PropertyMetadata::toString()` renders it with
 *     `*((float *)value)` / `*((int *)value)` / `*((bool *)value)`
 *     (`cppprops.cc:31-50`), i.e. the property's own datalib type decides which
 *     union member is read — see `nativeUnionRead()` below, which is that read;
 *   * the update body reads and writes the same location, so invoking a
 *     gene-bound property *mutates the gene's Scalar* in the native.
 *
 * The port's genome layer owns the gene (lane L5): `GenomeUtil::getGene` is
 * `genomeUtil.getGene(name, err)` (`src/model/genome/genomeUtil.ts`) and the
 * interpolated range members are `Gene::getMin()`/`getMax()` (`gene.ts`,
 * native `__InterpolatedGene::smin/smax`).  This binding therefore **serves the
 * value from the port's genome layer**, not from the spec: the caller supplies
 * that layer through the engine context, exactly as the token-ring binding
 * supplies `agentInsideCount` —
 *
 *     ctx.engine.geneValue(name) -> { kind: 'FLOAT'|'INT'|'BOOL', min, max }
 *         the port's genome layer (a function over `genomeUtil`); or
 *     ctx.engine.genes = { NAME: { kind, min, max } }
 *         the same data as a table, for callers without the TS genome layer in
 *         process (`run_cppprops.mjs --engine`; the CLI channel is documented
 *         for exactly this in `docs/specs/cppprops.md` §2).
 *
 * Nothing is guessed: an unrecognised `genome::` symbol, a body that names no
 * gene read, a missing gene, a missing kind, or a kind whose native read is
 * undefined all **throw** (W1h's contract: refuse loudly, never a silent value).
 *
 * Bound to any property that names a gene read (`lib/genesymbol.mjs`;
 * `lib/cppprops.mjs` `bindingKey()`/`mentionsGene`).
 */

import { GENE_BINDING_KEY, mentionsGene, parseGeneReads, substituteGeneReads } from '../lib/genesymbol.mjs';

/** Engine-context keys the binding reads (see the module note). */
export const GENE_READER_KEY = 'geneValue';
export const GENE_TABLE_KEY = 'genes';

/** `smin`/`smax` -> which end of the range the read asks for. */
const MEMBER = { smin: 'min', smax: 'max' };

const WHOLE_BODY = /^\s*(?:return\s+)?\u0000\s*;?\s*$/;

/**
 * The native read of a gene's `Scalar` through a property of type `cppType`.
 *
 * `&(s.__val)` is the union's address, so `*((float *)value)` is the union's
 * first 4 bytes *as an f32* — the gene's own value when the Scalar is a FLOAT,
 * and a **reinterpretation** when it is not (`Scalar::Scalar(int)` only writes
 * `ival`).  Both directions are deterministic and are pinned against a probe
 * compiled on the native tree (`src/model/genome/native/genevalueprobe.cc`):
 *
 *   | property | Scalar | native read                          |
 *   |----------|--------|--------------------------------------|
 *   | float    | FLOAT  | the value (f32)                      |
 *   | float    | INT    | the int's 32 bits, read as f32       |
 *   | int      | INT    | the value                            |
 *   | int      | FLOAT  | the float's 32 bits, read as int32   |
 *   | bool     | any    | the first byte of the union (`bval`) |
 *
 * `float`/`int` over a **BOOL** Scalar is *refused*: `Scalar::Scalar(bool)`
 * writes one byte and the union's remaining bytes are never initialized, so the
 * native read is undefined (measured: the probe prints the raw bytes and marks
 * them indeterminate).  A `bool` property over a BOOL Scalar is the one defined
 * bool case; over INT/FLOAT it is the value's low byte.
 */
export function nativeUnionRead(kind, value, cppType) {
  switch (cppType) {
    case 'float':
      if (kind === 'FLOAT') return Math.fround(value);
      if (kind === 'INT') return intAsFloat(value);
      throw new Error(
        `gene binding: a float property cannot read a ${kind} Scalar ` +
          '(the native read is undefined — the union member is uninitialized)',
      );
    case 'int':
      if (kind === 'INT') return value | 0;
      if (kind === 'FLOAT') return floatAsInt(value);
      throw new Error(
        `gene binding: an int property cannot read a ${kind} Scalar ` +
          '(the native read is undefined — the union member is uninitialized)',
      );
    case 'bool':
      if (kind === 'BOOL') return value ? true : false;
      if (kind === 'INT') return (value & 0xff) !== 0; // the union's first byte
      if (kind === 'FLOAT') return (floatBits(value) & 0xff) !== 0;
      throw new Error(`gene binding: unknown scalar kind ${kind}`);
    default:
      // `PropertyMetadata::toString()` has no branch for anything else
      // (native `assert(false)`), and a wider property type would read past the
      // union.
      throw new Error(`gene binding: no native union read for property type '${cppType}'`);
  }
}

/** The 32 bits of an f32 value. */
function floatBits(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return view.getUint32(0);
}

/** `*(float *)&ival` — the int's 32 bits read back as an f32 (native type punning). */
function intAsFloat(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setInt32(0, value | 0);
  return view.getFloat32(0);
}

/** `*(int *)&fval` — the float's 32 bits read back as an int32. */
function floatAsInt(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return view.getInt32(0);
}

/** `{ kind, min, max }` for `name`, out of whichever gene source the caller supplied. */
function geneRange(ctx, read) {
  const engine = ctx.engine || {};
  const reader = engine[GENE_READER_KEY];
  const table = engine[GENE_TABLE_KEY];
  let range;
  if (typeof reader === 'function') {
    range = reader(read.name);
  } else if (table && typeof table === 'object') {
    range = table[read.name];
  } else {
    throw new Error(
      'gene binding: no gene source — pass ctx.engine.geneValue (the port genome layer, ' +
        `\`genomeUtil.getGene\`) or ctx.engine.genes (a { kind, min, max } table) (gene '${read.name}')`,
    );
  }
  if (!range) {
    // Native `GenomeUtil::getGene( name, err )` with the emitted error text.
    throw new Error(read.err || `gene binding: no range for gene '${read.name}'`);
  }
  const member = MEMBER[read.accessor];
  if (!(member in range)) {
    throw new Error(`gene binding: gene '${read.name}' has no '${member}' range`);
  }
  if (!range.kind) {
    throw new Error(`gene binding: gene '${read.name}' has no Scalar kind (FLOAT/INT/BOOL)`);
  }
  return { kind: range.kind, value: range[member] };
}

/** The value a gene read asks for, through the native union read. */
export function geneReadValue(ctx, read) {
  const { kind, value } = geneRange(ctx, read);
  return nativeUnionRead(kind, value, ctx.cppType);
}

/** A JS number literal for `value`, in the property's own C type. */
function literal(cppType, value) {
  return cppType === 'float' ? String(Math.fround(value)) : String(value | 0);
}

/**
 * Every gene name a spec's properties read — the input `geneTableFromGenomeUtil` needs,
 * so a caller does not have to know which genes a worldfile's symbols name.
 */
export function geneNamesInSpec(spec) {
  const names = new Set();
  const properties = (spec && spec.properties) || [];
  for (const prop of properties) {
    const dynamic = prop.dynamic || {};
    for (const text of [prop.cppSymbol, dynamic.updateBody, dynamic.initBody]) {
      if (!mentionsGene(text)) continue;
      for (const read of parseGeneReads(text)) names.add(read.name);
    }
  }
  return [...names].sort();
}

/**
 * `{ NAME: { kind, min, max } }` out of the **port's genome layer** — the adapter a
 * caller wires into `ctx.engine.geneValue`/`genes` (native `GenomeUtil::getGene` +
 * `GeneType::to___Interpolated` + `__InterpolatedGene::smin/smax`).
 *
 * `util` is lane L5's `GenomeUtil` (`src/model/genome/genomeUtil.ts`).  A gene this
 * schema does not define is refused: the native's `getGene( name, err )` leaves a NULL
 * for the caller to dereference (the generated code has no NULL check) and the emitted
 * error text says exactly that.
 */
export function geneTableFromGenomeUtil(util, names) {
  const table = {};
  for (const name of names) {
    const gene = util.getGene(name, '');
    if (!gene) {
      throw new Error(
        `gene binding: the port's genome layer has no gene '${name}' ` +
          '(native `GenomeUtil::getGene` would return NULL and the generated code dereference it)',
      );
    }
    if (typeof gene.isInterpolated !== 'function' || !gene.isInterpolated()) {
      throw new Error(
        `gene binding: gene '${name}' is not interpolated (native GeneType::to___Interpolated fails)`,
      );
    }
    const min = gene.getMin();
    const max = gene.getMax();
    if (min.kind !== max.kind) {
      throw new Error(`gene binding: gene '${name}' has a mixed range kind`);
    }
    const number = (scalar) => (scalar.kind === 'INT' ? scalar.asInt() : scalar.asFloat());
    table[name] = { kind: min.kind, min: number(min), max: number(max) };
  }
  return table;
}

/**
 * The binding itself.
 *
 * `init(ctx)` — native `CppProperties_Init()`: bind the property's storage to
 * the gene's range member named by its own cpp symbol.  (`ctx.set` is the
 * port's equivalent of `metadata[i].value = &(…)`.)
 *
 * `update(ctx)` — the body is served only when it is the gene read itself,
 * optionally with arithmetic around it, which is evaluated by the interpreter's
 * own portable-body compiler (`ctx.evalBody`) with each read replaced by a
 * literal of the served value.  Anything else throws.
 */
export function createGeneBinding(bindings = {}) {
  const binding = {
    /** Native `Property::getCppSymbol()` of this property, served as its storage. */
    init(ctx) {
      const reads = parseGeneReads(ctx.cppSymbol || '');
      if (!reads.length) return; // the *body* names the gene, not the storage location
      if (reads.length > 1) {
        throw new Error(
          `gene binding: a property's cpp symbol names ${reads.length} gene reads: ${JSON.stringify(ctx.cppSymbol)}`,
        );
      }
      ctx.set(ctx.name, geneReadValue(ctx, reads[0]));
    },

    update(ctx) {
      const body = String(ctx.updateBody ?? '');
      const reads = parseGeneReads(body);
      if (!reads.length) {
        throw new Error(`gene binding: this body names no gene read: ${JSON.stringify(body)}`);
      }
      const placeholder = substituteGeneReads(body, () => '\u0000');
      if (WHOLE_BODY.test(placeholder)) {
        if (reads.length !== 1) {
          throw new Error(`gene binding: unrecognised body with ${reads.length} gene reads: ${JSON.stringify(body)}`);
        }
        return geneReadValue(ctx, reads[0]);
      }
      let index = 0;
      const rewritten = substituteGeneReads(body, () =>
        literal(ctx.cppType, geneReadValue(ctx, reads[index++])));
      // The interpreter's portable-body compiler refuses whatever is left that
      // it cannot evaluate (a qualified call, the update context, …).
      return ctx.evalBody(rewritten);
    },
  };
  bindings[GENE_BINDING_KEY] = binding;
  return bindings;
}

export const bindings = createGeneBinding();

export default { bindings, createGeneBinding, nativeUnionRead, geneReadValue, geneNamesInSpec, geneTableFromGenomeUtil };
