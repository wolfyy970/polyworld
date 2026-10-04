/**
 * Lane L5 (genome) — `genome/groups/GroupsGene.{h,cc}`: the neuron-group gene family.
 *
 *   NeurGroupGene        — a whole group: its neuron count (input/vis groups) or its
 *                          internal-group count and membership;
 *   MutableNeurGroupGene — a group whose count is interpolated from one mutable byte;
 *   ImmutableNeurGroupGene — a fixed group (one neuron, or a constant count);
 *   NeurGroupAttrGene    — one byte *per group* of a `group_type` (Bias, E/I neuron counts);
 *   SynapseAttrGene      — one byte per (synapse type, from, to) cell.
 *
 * The two printers here are the ones that write `run/genome/meta/{geneindex,genelayout,
 * genetitle}.txt` for a Groups architecture, so their text is byte-contract:
 *
 *   NeurGroupAttrGene   `${index}\t${prefix}${name}_${i}` and, for titles,
 *                       `${prefix}${name}[${groupTitle}] :: ${prefix}${name}_${i}`
 *   SynapseAttrGene     `${index}\t${prefix}${typeName}${name}_${from}->${to}`, no titles
 *
 * PORT-NOTE(genome/inhibitory-negation): `SynapseAttrGene::get` negates the value for
 * inhibitory sources when the gene says so (`LearningRate`), and native's
 * `min( -1.e-10, -(double)result )` resolves to `std::min<double>` (both arguments are
 * doubles through `operator double()`), so the result is a FLOAT scalar. The other branch,
 * `-(float)result`, is also FLOAT. Both are reproduced; the produced `Scalar` feeds float
 * arithmetic in lane L6, so its kind is part of the interface.
 *
 * PORT-NOTE(genome/group-titles): `getTitle` returns a group *label*, not a name:
 * `InternalNeurGroup ${group - firstGroup}` for an internal group, the gene name for an
 * input group, and the gene name for a fixed group. `genetitle.txt` is built from it, and
 * the `assert( group == first_group )` in the immutable case is a real invariant (an
 * immutable group has exactly one member).
 */

import { Gene, NonVectorGene, Rounding, type Output } from '../gene';
import { GroupsGeneType, NeurGroupType, NeuronType, assertNever } from '../vocabulary';
import { Scalar } from '../values';
import type { GroupsGenomeSchema } from './groupsGenomeSchema';
import type { GroupsSynapseType } from './groupsSynapseType';

/** The `Genome` surface these genes use (`get_raw`/`set_raw`/`set_raw_random`). */
export interface RawGenome {
  getRaw(offset: number): number;
  setRaw(offset: number, n: number, value: number): void;
  setRawRandom(offset: number, n: number, min: number, max: number): void;
}

/** Native `NeurGroupGene`. */
export abstract class NeurGroupGene extends NonVectorGene {
  /** Native `NeurGroupGene::schema` — set by `GroupsGenomeSchema::add`. */
  schema: GroupsGenomeSchema | null = null;

  /** Native `NeurGroupGene::first_group` — assigned by the schema's caching pass. */
  firstGroup = -1;

  private readonly groupType: NeurGroupType;

  constructor(groupType: NeurGroupType) {
    super();
    if (
      groupType !== NeurGroupType.INPUT &&
      groupType !== NeurGroupType.OUTPUT &&
      groupType !== NeurGroupType.INTERNAL
    ) {
      throw new Error(`NeurGroupGene: invalid group type ${groupType}`);
    }
    this.groupType = groupType;
  }

  /** Native `NeurGroupGene::isMember`. */
  isMember(groupType: NeurGroupType): boolean {
    if (groupType === NeurGroupType.ANY || groupType === this.groupType) return true;

    switch (this.groupType) {
      case NeurGroupType.INPUT:
        return false;
      case NeurGroupType.OUTPUT:
      case NeurGroupType.INTERNAL:
        // Native returns `(group_type_ == NGT_ANY) || (group_type_ == NGT_NONINPUT)` here;
        // the ANY case is already handled above, so only NONINPUT remains (narrowed type).
        return groupType === NeurGroupType.NONINPUT;
      default:
        return assertNever('NeurGroupGene::isMember', this.groupType);
    }
  }

  /** Native `NeurGroupGene::getGroupType`. */
  getGroupType(): NeurGroupType {
    return this.groupType;
  }

  /** Native `NeurGroupGene::getMaxGroupCount` (pure virtual). */
  abstract getMaxGroupCount(): number;

  /** Native `NeurGroupGene::getMaxNeuronCount` (pure virtual). */
  abstract getMaxNeuronCount(): number;

  /** Native `NeurGroupGene::getTitle` (pure virtual). */
  abstract getTitle(group: number): string;
}

/** Native `MutableNeurGroupGene`. */
export class MutableNeurGroupGene extends NeurGroupGene {
  constructor(name: string, groupType: NeurGroupType, min: Scalar, max: Scalar) {
    super(groupType);
    this.initInterpolated(GroupsGeneType.NEURGROUP, true, name, min, max, Rounding.INT_NEAREST);
  }

  override get(genome: RawGenome): Scalar {
    return this.interpolate(genome.getRaw(this.offset));
  }

  override getMaxGroupCount(): number {
    switch (this.getGroupType()) {
      case NeurGroupType.INPUT:
        return 1;
      case NeurGroupType.INTERNAL:
        return this.getMax().asInt();
      default:
        return assertNever('MutableNeurGroupGene::getMaxGroupCount', this.getGroupType());
    }
  }

  override getMaxNeuronCount(): number {
    switch (this.getGroupType()) {
      case NeurGroupType.INPUT:
        return this.getMax().asInt();
      case NeurGroupType.INTERNAL: {
        const ngroups = this.getMaxGroupCount();
        const schema = this.requireSchema();
        const numineur = toNeurGroupAttr(schema.get('InhibitoryNeuronCount')).getMax().asInt();
        const numeneur = toNeurGroupAttr(schema.get('ExcitatoryNeuronCount')).getMax().asInt();
        return ngroups * (numineur + numeneur);
      }
      default:
        return assertNever('MutableNeurGroupGene::getMaxNeuronCount', this.getGroupType());
    }
  }

  override getTitle(group: number): string {
    const local = group - this.firstGroup;
    if (local < 0) throw new Error(`${this.name}: getTitle group ${group} < first group`);

    switch (this.getGroupType()) {
      case NeurGroupType.INPUT:
        // "we're assuming only 1 group when titling input"
        if (local !== 0) throw new Error(`${this.name}: input group title for index ${local}`);
        return this.name;
      case NeurGroupType.INTERNAL:
        return `InternalNeurGroup ${local}`;
      default:
        return assertNever('MutableNeurGroupGene::getTitle', this.getGroupType());
    }
  }

  private requireSchema(): GroupsGenomeSchema {
    if (!this.schema) throw new Error(`${this.name}: gene is not in a schema`);
    return this.schema;
  }
}

/** Native `ImmutableNeurGroupGene`. */
export class ImmutableNeurGroupGene extends NeurGroupGene {
  constructor(name: string, groupType: NeurGroupType, count = 1) {
    super(groupType);
    this.initConstant(GroupsGeneType.NEURGROUP, name, Scalar.int(count));
  }

  override get(_genome: RawGenome): Scalar {
    return this.getConstant();
  }

  override getMaxGroupCount(): number {
    return 1;
  }

  override getMaxNeuronCount(): number {
    return this.getConstant().asInt();
  }

  override getTitle(group: number): string {
    if (group !== this.firstGroup) {
      throw new Error(`${this.name}: immutable group title for group ${group}`);
    }
    return this.name;
  }
}

/** Native `NeurGroupAttrGene` — one byte per group of `group_type`. */
export class NeurGroupAttrGene extends Gene {
  /** Native `NeurGroupAttrGene::schema` — set by `GroupsGenomeSchema::add`. */
  schema: GroupsGenomeSchema | null = null;

  /** Native `const NeurGroupType NeurGroupAttrGene::group_type`. */
  readonly groupType: NeurGroupType;

  constructor(name: string, groupType: NeurGroupType, min: Scalar, max: Scalar) {
    super();
    this.groupType = groupType;
    this.initInterpolated(
      GroupsGeneType.NEURGROUP_ATTR,
      true,
      name,
      min,
      max,
      Rounding.INT_NEAREST,
    );
  }

  /** Native `NeurGroupAttrGene::get( Genome *, int group )`. */
  get(genome: RawGenome, group?: number): Scalar {
    if (group !== undefined) return this.interpolate(genome.getRaw(this.getGroupOffset(group)));
    return this.interpolate(genome.getRaw(this.offset));
  }

  /** Native `NeurGroupAttrGene::seed`. */
  seedGroup(genome: RawGenome, group: NeurGroupGene, rawval: number): void {
    const schema = this.requireSchema();
    const igroup = schema.getFirstGroup(group);
    const offset = this.getGroupOffset(igroup);
    const ngroups = group.getMaxGroupCount();
    genome.setRaw(offset, ngroups, rawval);
  }

  /** Native `NeurGroupAttrGene::randomize`. */
  randomizeGroup(
    genome: RawGenome,
    group: NeurGroupGene,
    rawvalMin: number,
    rawvalMax: number,
  ): void {
    const schema = this.requireSchema();
    const igroup = schema.getFirstGroup(group);
    const offset = this.getGroupOffset(igroup);
    const ngroups = group.getMaxGroupCount();
    genome.setRawRandom(offset, ngroups, rawvalMin, rawvalMax);
  }

  override printIndexes(out: Output, prefix: string, layout: { getMutableDataOffset(i: number): number } | null): void {
    const n = this.requireSchema().getMaxGroupCount(this.groupType);
    for (let i = 0; i < n; i++) {
      let index = this.offset + i;
      if (layout) index = layout.getMutableDataOffset(index);
      out.write(`${index}\t${prefix}${this.name}_${i}\n`);
    }
  }

  override printTitles(out: Output, prefix: string): void {
    const schema = this.requireSchema();
    const firstGroup = schema.getFirstGroupOfType(this.groupType);
    const ngroups = schema.getMaxGroupCount(this.groupType);

    for (let i = 0; i < ngroups; i++) {
      const group = firstGroup + i;
      const groupGene = schema.getGroupGene(group);
      const groupTitle = groupGene.getTitle(group);
      out.write(`${prefix}${this.name}[${groupTitle}] :: ${prefix}${this.name}_${i}\n`);
    }
  }

  protected override getMutableSizeImpl(): number {
    return this.requireSchema().getMaxGroupCount(this.groupType);
  }

  /**
   * Native `NeurGroupAttrGene::getOffset( int group )`. Renamed here because `Gene` already
   * has `getOffset()` (native overloads it; TypeScript cannot).
   */
  getGroupOffset(group: number): number {
    return this.offset + (group - this.requireSchema().getFirstGroupOfType(this.groupType));
  }

  private requireSchema(): GroupsGenomeSchema {
    if (!this.schema) throw new Error(`${this.name}: gene is not in a schema`);
    return this.schema;
  }
}

/** Native `SynapseAttrGene` — one byte per (synapse type, from group, to group). */
export class SynapseAttrGene extends Gene {
  /** Native `SynapseAttrGene::schema` — set by `GroupsGenomeSchema::add`. */
  schema: GroupsGenomeSchema | null = null;

  private readonly negateInhibitory: boolean;
  private readonly lessThanZero: boolean;

  constructor(
    name: string,
    negateInhibitory: boolean,
    lessThanZero: boolean,
    min: Scalar,
    max: Scalar,
  ) {
    super();
    this.negateInhibitory = negateInhibitory;
    this.lessThanZero = lessThanZero;
    this.initInterpolated(
      GroupsGeneType.SYNAPSE_ATTR,
      true,
      name,
      min,
      max,
      Rounding.INT_NEAREST,
    );
  }

  /** Native `SynapseAttrGene::get`. */
  get(genome: RawGenome, synapseType: GroupsSynapseType, from: number, to: number): Scalar {
    const offset = this.getSynapseOffset(synapseType, from, to);
    const result = this.interpolate(genome.getRaw(offset));

    if (this.negateInhibitory && synapseType.ntFrom === NeuronType.INHIBITORY) {
      if (this.lessThanZero) {
        // Native `min( -1.e-10, -(double)result )` == `std::min<double>` (see PORT-NOTE).
        return Scalar.float(Math.min(-1.0e-10, -result.asDouble()));
      }
      return Scalar.float(-result.asFloat());
    }
    return result;
  }

  /** Native `SynapseAttrGene::seed`. */
  seedSynapse(
    genome: RawGenome,
    synapseType: GroupsSynapseType,
    from: NeurGroupGene,
    to: NeurGroupGene,
    rawval: number,
  ): void {
    if (!(from.getGroupType() === NeurGroupType.INPUT || from.getGroupType() === NeurGroupType.OUTPUT)) {
      throw new Error(`${this.name}::seed: 'from' group must be input or output`);
    }
    if (to.getGroupType() !== NeurGroupType.OUTPUT) {
      throw new Error(`${this.name}::seed: 'to' group must be output`);
    }

    const schema = this.requireSchema();
    const offset = this.getSynapseOffset(
      synapseType,
      schema.getFirstGroup(from),
      schema.getFirstGroup(to),
    );
    genome.setRaw(offset, 1, rawval);
  }

  override printIndexes(out: Output, prefix: string, layout: { getMutableDataOffset(i: number): number } | null): void {
    const schema = this.requireSchema();
    const nin = schema.getMaxGroupCount(NeurGroupType.INPUT);
    const nany = schema.getMaxGroupCount(NeurGroupType.ANY);

    for (const synapseType of schema.getSynapseTypes()) {
      for (let to = nin; to < nany; to++) {
        for (let from = 0; from < nany; from++) {
          let index = this.getSynapseOffset(synapseType, from, to);
          if (layout) index = layout.getMutableDataOffset(index);
          out.write(`${index}\t${prefix}${synapseType.name}${this.name}_${from}->${to}\n`);
        }
      }
    }
  }

  /** Native `SynapseAttrGene::printTitles` — deliberately empty (see the native comment). */
  override printTitles(_out: Output, _prefix: string): void {
    // "we don't currently investigate this data, not implemented yet."
  }

  protected override getMutableSizeImpl(): number {
    const schema = this.requireSchema();
    let size = 0;
    for (const synapseType of schema.getSynapseTypes()) size += synapseType.getMutableSize();
    return size;
  }

  /**
   * Native `SynapseAttrGene::getOffset( type, from, to )`. Renamed here because `Gene`
   * already has `getOffset()` (native overloads it; TypeScript cannot).
   */
  getSynapseOffset(synapseType: GroupsSynapseType, from: number, to: number): number {
    return this.offset + synapseType.getOffset(from, to);
  }

  private requireSchema(): GroupsGenomeSchema {
    if (!this.schema) throw new Error(`${this.name}: gene is not in a schema`);
    return this.schema;
  }
}

/** Native `GroupsGeneType::to_NeurGroup`. */
export function toNeurGroup(gene: Gene | null | undefined): NeurGroupGene {
  if (!(gene instanceof NeurGroupGene)) {
    throw new Error(`GroupsGeneType::to_NeurGroup: ${gene?.name ?? 'null'} is not one`);
  }
  return gene;
}

/** Native `GroupsGeneType::to_NeurGroupAttr`. */
export function toNeurGroupAttr(gene: Gene | null | undefined): NeurGroupAttrGene {
  if (!(gene instanceof NeurGroupAttrGene)) {
    throw new Error(`GroupsGeneType::to_NeurGroupAttr: ${gene?.name ?? 'null'} is not one`);
  }
  return gene;
}

/** Native `GroupsGeneType::to_SynapseAttr`. */
export function toSynapseAttr(gene: Gene | null | undefined): SynapseAttrGene {
  if (!(gene instanceof SynapseAttrGene)) {
    throw new Error(`GroupsGeneType::to_SynapseAttr: ${gene?.name ?? 'null'} is not one`);
  }
  return gene;
}
