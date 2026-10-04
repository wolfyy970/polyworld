/**
 * Lane L5 (genome) — the gene-type tokens and the small vocabularies the genome schema
 * dispatches on.
 *
 * Native uses the *address* of a `static const GeneType` object as a runtime type tag
 * (`gene->type == GeneType::SCALAR`, `_type2genes[type]`), with `dynamic_cast` for the
 * downcasts. The identity of the token is all that matters, so the port uses interned
 * string constants; the cast helpers (`toNonVector`, `toContainer`, ...) reproduce native's
 * `assert` on a failed downcast.
 *
 * PORT-NOTE(genome/gene-type-tokens): `GeneType`/`GroupsGeneType` identity is a plain
 * string token, not a class instance, because lanes would otherwise need the *same*
 * `static` object across module instances. The cast helpers keep native's contract
 * (`to_NonVector(NULL)` is NULL; a failed downcast is an error, never a silent null).
 */

/** Native `GeneType` (`genome/Gene.h`): one token per gene family. */
export const GeneType = {
  SCALAR: 'SCALAR',
  CONTAINER: 'CONTAINER',
} as const;

export type GeneTypeToken = (typeof GeneType)[keyof typeof GeneType];

/** Native `GroupsGeneType` (`genome/groups/GroupsGene.h`). */
export const GroupsGeneType = {
  NEURGROUP: 'NEURGROUP',
  NEURGROUP_ATTR: 'NEURGROUP_ATTR',
  SYNAPSE_ATTR: 'SYNAPSE_ATTR',
} as const;

/** Any token a gene may carry. */
export type AnyGeneType =
  | (typeof GeneType)[keyof typeof GeneType]
  | (typeof GroupsGeneType)[keyof typeof GroupsGeneType];

/** Native `NeurGroupType` (`genome/NeurGroupType.h`). */
export const NeurGroupType = {
  ANY: 0,
  INPUT: 1,
  OUTPUT: 2,
  INTERNAL: 3,
  NONINPUT: 4,
} as const;

export type NeurGroupType = (typeof NeurGroupType)[keyof typeof NeurGroupType];

/** Native `__NGT_COUNT`. */
export const NGT_COUNT = 5;

/** Native `NeuronType` (`genome/NeuronType.h`). */
export const NeuronType = {
  INHIBITORY: 0,
  EXCITATORY: 1,
} as const;

export type NeuronType = (typeof NeuronType)[keyof typeof NeuronType];

/** Native `assert( false )` on an unhandled case: the port throws. */
export function assertNever(what: string, value: unknown): never {
  throw new Error(`${what}: unhandled case ${String(value)}`);
}

/** A `noUncheckedIndexedAccess`-friendly index that is known to be in range. */
export function at<T>(items: readonly T[], index: number, what: string): T {
  const value = items[index];
  if (value === undefined) throw new Error(`${what}: index ${index} out of range`);
  return value;
}
