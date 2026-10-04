/**
 * Lane L5 (genome) — `src/library/genome/**` ported to TypeScript.
 *
 *   values.ts            native `Scalar` + the printf subset (`%f` ties-to-even)
 *   vocabulary.ts        gene-type tokens, `NeurGroupType`, `NeuronType`
 *   graybin.ts           the two 256-entry gray tables (transcribed verbatim)
 *   gene.ts              `Gene` + the scalar gene types, interpolation, the casts
 *   geneSchema.ts        `GeneSchema` (ordered registry + offset allocator), `ContainerGene`
 *   genomeSchema.ts      `GenomeSchema`: physiology genes, seed policy, `processWorldfile`
 *   genomeLayout.ts      `GenomeLayout`: gene offset -> mutable data offset
 *   genome.ts            `Genome`: bitstring, seeding, mutation, crossover, separation
 *   genomeUtil.ts        `GenomeUtil`: schema/layout singleton + genome factory
 *   separationCache.ts   `SeparationCache`: the per-agent separation memo
 *   worldConfig.ts       the worldfile keys -> `GenomeSchemaInputs`
 *   worldfileSpellings.ts  the worldfile words the schema branches on
 *   metaFiles.ts         the `run/genome/meta/*.txt` renderers (+ the `sort -n` pass)
 *   groups/              `genome/groups/**`: gene schema, genes, layout, genome
 *
 * Not ported, each with its reason in PARITY.md -> Gaps: `genome/sheets/**` is a **measured
 * deviation** — the shipped oracle grows no Sheets brain to be faithful *to* (PARITY.md,
 * *The `Sheets` architecture in the shipped oracle*, and
 * `native/probe_sheets_architecture.sh`) — and `GroupsGenome::createBrain` is a callerless
 * stub (the sim grows through the `GroupsGenomeViewAdapter` in `sim/bindings.ts`).
 */

export * from './values';
export * from './vocabulary';
export { binofgray, grayofbin } from './graybin';
export * from './gene';
export * from './geneSchema';
export * from './genomeSchema';
export * from './genomeLayout';
export * from './genome';
export * from './genomeUtil';
export * from './separationCache';
export * from './worldConfig';
export * from './worldfileSpellings';
export * from './metaFiles';

export * from './groups/groupsSynapseType';
export * from './groups/groupsGene';
export * from './groups/groupsLayout';
export * from './groups/groupsGenome';
export * from './groups/groupsGenomeSchema';
