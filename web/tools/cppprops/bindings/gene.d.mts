/**
 * `bindings/gene.mjs` — serves a `genome::` gene read from the port's genome layer
 * (W1h residual 1a, lane L5).  Read the module for the native semantics; these are the
 * declarations a TypeScript caller (the browser model, or a test) needs.
 */

import type { CppPropsBindingEntry } from '../lib/cppprops.mjs';
import type { GeneRead } from '../lib/genesymbol.mjs';

/** Engine-context keys the binding reads. */
export declare const GENE_READER_KEY: 'geneValue';
export declare const GENE_TABLE_KEY: 'genes';

/** A gene's interpolated range, as the caller's gene source reports it. */
export interface GeneRange {
  readonly kind: 'FLOAT' | 'INT' | 'BOOL';
  readonly min: number;
  readonly max: number;
}

/**
 * The native read of a gene's `Scalar` through a property of type `cppType`
 * (`*(float *)&(s.__val)`); throws for the reads the native leaves undefined.
 */
export declare function nativeUnionRead(
  kind: 'FLOAT' | 'INT' | 'BOOL' | string,
  value: number | boolean,
  cppType: string,
): number | boolean;

/** The value one gene read asks for. */
export declare function geneReadValue(
  ctx: { engine?: unknown; cppType?: string },
  read: GeneRead,
): number | boolean;

/** Every gene name a spec's properties read. */
export declare function geneNamesInSpec(spec: unknown): string[];

/** `{ NAME: { kind, min, max } }` out of lane L5's `GenomeUtil`. */
export declare function geneTableFromGenomeUtil(
  util: { getGene(name: string, err: string): unknown },
  names: readonly string[],
): Record<string, GeneRange>;

/** The `genome` registry entry (`init` binds the storage, `update` serves the body). */
export declare function createGeneBinding(
  bindings?: Record<string, CppPropsBindingEntry>,
): Record<string, CppPropsBindingEntry>;

export declare const bindings: Record<string, CppPropsBindingEntry>;

declare const _default: {
  bindings: typeof bindings;
  createGeneBinding: typeof createGeneBinding;
  nativeUnionRead: typeof nativeUnionRead;
  geneReadValue: typeof geneReadValue;
  geneNamesInSpec: typeof geneNamesInSpec;
  geneTableFromGenomeUtil: typeof geneTableFromGenomeUtil;
};
export default _default;
