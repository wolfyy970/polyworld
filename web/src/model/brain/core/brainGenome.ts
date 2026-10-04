/**
 * Lane L6 (brain core) — the genome view the brain grows against.
 *
 * The brain's growth path reads the genome a great deal but *owns none of it*: group counts,
 * per-group neuron counts, the connection-density → synapse-count conversion
 * (`nint(cd * nfrom * nto)`), the ordered-group permutation and the per-connection gene
 * values (bias, learning rate, topological distortion, weight stdev, tau/gain, spiking
 * parameters) all live in `library/genome/**` — lane L5, which owns `GroupsGenome`,
 * `GroupsGenomeSchema`, `Gene`, `Scalar` and the raw-bits layout.
 *
 * PORT-NOTE(l6/genome-boundary): this file freezes that cut. It is deliberately the *resolved*
 * operations `GroupsBrain` calls (`getNeuronCount(type,group)`, `getSynapseCount(type,from,to)`,
 * `get(gene,group)`, `getOrderedGroups()`), not the raw gene array, so that:
 *
 *   - L6 contains exactly the behaviour it owns — the architecture, the index layout, the
 *     remainder bookkeeping and the connection walk — and no second copy of the genome
 *     arithmetic (PORT_SPEC rule 6's "one definition");
 *   - the lane's differential harness can drive the port from the oracle's *own* genome by
 *     having the native probe resolve and dump these operations, instead of the port
 *     re-deriving them from raw bits;
 *   - gene values arrive as the `float` native's `Scalar` holds (they are `float` in
 *     `Scalar`'s union), so a call site that needs the C conversion (`(int)`, `float`)
 *     applies it locally, exactly as the native source does.
 *
 * PORT-NOTE(l6/genome-enums): `NeuronType` is `{INHIBITORY, EXCITATORY}` and `NeurGroupType`
 * is `{ANY, INPUT, OUTPUT, INTERNAL, NONINPUT, __COUNT}` in `genome/{NeuronType,NeurGroupType}.h`
 * — both orders are depended on (`genome::getNeuronCount(EXCITATORY, …)` vs the schema's
 * group-type walk), so the numeric values are frozen here rather than re-derived.
 */

/** Native `genome::NeuronType`. */
export const NeuronType = { INHIBITORY: 0, EXCITATORY: 1 } as const;
export type NeuronType = (typeof NeuronType)[keyof typeof NeuronType];

/** Native `genome::NeurGroupType`. */
export const NeurGroupType = {
  ANY: 0,
  INPUT: 1,
  OUTPUT: 2,
  INTERNAL: 3,
  NONINPUT: 4,
} as const;
export type NeurGroupType = (typeof NeurGroupType)[keyof typeof NeurGroupType];

/** The gene names `GroupsGenome` resolves, and the brain reads per group. */
export type GroupGeneName =
  | 'ExcitatoryNeuronCount'
  | 'InhibitoryNeuronCount'
  | 'Bias'
  | 'Tau'
  | 'Gain'
  | 'Order'
  | 'SpikingParameterA'
  | 'SpikingParameterB'
  | 'SpikingParameterC'
  | 'SpikingParameterD';

/** The gene names the brain reads per (synapse type, from group, to group). */
export type SynapseGeneName = 'ConnectionDensity' | 'TopologicalDistortion' | 'WeightStdev' | 'LearningRate';

/** Native `genome::GroupsSynapseType` — one of the four directed neuron-type pairings. */
export interface GroupsSynapseType {
  /** Native `name` — `"EE"`, `"EI"`, `"IE"`, `"II"` (used in error messages only). */
  readonly name: string;
  readonly ntFrom: NeuronType;
  readonly ntTo: NeuronType;
}

/** Native `genome::GroupsGenome` as the brain sees it. */
export interface GroupsGenomeView {
  /** Native `getGroupCount( NGT_ANY )`. */
  groupCount(): number;
  /** Native `getSchema()->getMaxGroupCount( type )`. */
  maxGroupCount(type: NeurGroupType): number;
  /** Native `getSchema()->getNeurGroupType( group )`. */
  groupType(group: number): NeurGroupType;
  /** Native `getSchema()->getGroupGene( group )->name` — the nerve this group maps onto. */
  groupName(group: number): string;

  /** Native `getNeuronCount( type, group )`. */
  neuronCount(type: NeuronType, group: number): number;
  /** Native `getNeuronCount( group )` — the group's total (I + E for internal groups). */
  neuronCountTotal(group: number): number;

  /** Native `getOrderedGroups()`. */
  orderedGroups(): readonly number[];

  /** Native `GroupsGenome::EE`. */
  readonly synapseTypeEE: GroupsSynapseType;
  /** Native `GroupsGenome::EI`. */
  readonly synapseTypeEI: GroupsSynapseType;
  /** Native `GroupsGenome::IE`. */
  readonly synapseTypeIE: GroupsSynapseType;
  /** Native `GroupsGenome::II`. */
  readonly synapseTypeII: GroupsSynapseType;

  /** Native `getSynapseCount( synapseType, from, to )`. */
  synapseCount(type: GroupsSynapseType, from: number, to: number): number;
  /** Native `getSynapseCount( from, to )` — the four types summed. */
  synapseCountTotal(from: number, to: number): number;

  /** Native `get( gene, group )`. */
  groupGeneValue(gene: GroupGeneName, group: number): number;
  /** Native `get( gene, synapseType, from, to )`. */
  synapseGeneValue(gene: SynapseGeneName, type: GroupsSynapseType, from: number, to: number): number;
  /** Native `get( "Name" )` for a genome-wide gene (e.g. `ScaleLatestSpikes`). */
  namedValue(name: string): number;
  /**
   * Native `get( seedGene, synapseType, from, to )` for a gene named by string — used only
   * when `EnableTopologicalDistortionRngSeed` / `EnableInitWeightRngSeed` are on. Native reads
   * the result as a `long` (`Scalar::operator long()`, i.e. an `INT` scalar), not a `float`.
   */
  namedGeneValue(name: string, type: GroupsSynapseType, from: number, to: number): number;
}

/**
 * The per-group / per-connection genome data the sheets architecture reads. Sheets stores its
 * whole genome differently (`SheetsGenome`), so it gets its own view rather than a shared one.
 */
export interface SheetsGenomeView {
  /** Native `SheetsGenome::get( "ScaleLatestSpikes" )` when the model is spiking. */
  scaleLatestSpikes(): number;
  /** A named genome value, e.g. `genome->get("…")` in `SheetsGenome::createBrain`. */
  namedValue(name: string): number;
}
