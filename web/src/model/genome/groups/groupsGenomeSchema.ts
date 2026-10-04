/**
 * Lane L5 (genome) — `genome/groups/GroupsGenomeSchema.{h,cc}`: the Groups-architecture
 * gene definitions, the group/neuron/synapse caches and the seed policy.
 *
 * This schema decides every byte of `run/genome/meta/*.txt` for the recorded scenarios, so
 * the *order of the `add()` calls in `define()`* is contract — the printers walk the
 * insertion order.
 *
 * PORT-NOTE(genome/groups-first-group-overloads): native overloads
 * `getFirstGroup( Gene * )` (the group index of a group gene) and
 * `getFirstGroup( NeurGroupType )` (the first group index of that *type*). TypeScript has
 * one method per name, so the port spells them `getFirstGroup(gene)` and
 * `getFirstGroupOfType(type)`; call sites follow the native names in comments.
 *
 * PORT-NOTE(genome/cache-state): every cache getter in native dispatches on the schema
 * state (`STATE_COMPLETE` -> cached value, `STATE_CACHING` -> compute and store, otherwise
 * `assert(false)`). The port keeps the same two phases; the "otherwise" arm throws, because
 * a cache read outside `complete()` would silently return a wrong count.
 *
 * PORT-NOTE(genome/seed-cast): `GroupsGenomeSchema::seed` `dynamic_cast`s the genome to
 * `GroupsGenome` (native would then dereference NULL on a mismatch); the port checks the
 * type and throws.
 */

import { GeneSchema } from '../geneSchema';
import { ImmutableScalarGene, type Gene } from '../gene';
import { MutableNeurGroupGene, ImmutableNeurGroupGene, NeurGroupAttrGene, SynapseAttrGene, toNeurGroup, toNeurGroupAttr, toSynapseAttr, type NeurGroupGene } from './groupsGene';
import { GroupsSynapseType } from './groupsSynapseType';
import { GroupsGeneType, NGT_COUNT, NeurGroupType, assertNever, at } from '../vocabulary';
import { Scalar } from '../values';
import { GroupsGenome } from './groupsGenome';
import {
  GenomeSchema,
  GenomeSchemaConfig,
  SeedType,
  Resolution,
  type GenomeSchemaInputs,
} from '../genomeSchema';
import type { Genome } from '../genome';
import type { RngSurface } from '../../types';

/** Native `GroupsGenomeSchema`. */
export class GroupsGenomeSchema extends GenomeSchema {
  private readonly synapseTypes: GroupsSynapseType[] = [];
  private readonly synapseTypeMap = new Map<string, GroupsSynapseType>();
  private readonly neurgroups: Gene[] = [];

  private readonly cache = {
    physicalCount: 0,
    groupCount: new Int32Array(NGT_COUNT),
    groupStart: new Int32Array(NGT_COUNT),
    neuronCount: new Int32Array(NGT_COUNT),
    synapseCount: 0,
  };

  constructor(inputs: GenomeSchemaInputs) {
    super(inputs);

    // Native SYNAPSE_TYPE( NAME ): index is the current list size, name decides the types.
    for (const name of ['EE', 'EI', 'II', 'IE']) {
      const synapseType = new GroupsSynapseType(name, this.synapseTypes.length);
      this.synapseTypes.push(synapseType);
      this.synapseTypeMap.set(name, synapseType);
    }
  }

  // ==================================================================================== #
  // define()
  // ==================================================================================== #

  override define(): void {
    // --- Base class (physiology scalars) — must run first: the printers walk this order.
    super.define();

    const { agent, groupsBrain, brainEnableLearning, brainMinLearningRate, brainMaxLearningRate } =
      this.inputs;

    this.input1('Random');
    this.input1('Energy');
    if (agent.enableMateWaitFeedback) this.input1('MateWaitFeedback');
    if (agent.enableSpeedFeedback) this.input1('SpeedFeedback');
    if (agent.enableCarry) {
      this.input1('Carrying');
      this.input1('BeingCarried');
    }
    this.inputVar('Red', groupsBrain.minVisionNeuronsPerGroup, groupsBrain.maxVisionNeuronsPerGroup);
    this.inputVar('Green', groupsBrain.minVisionNeuronsPerGroup, groupsBrain.maxVisionNeuronsPerGroup);
    this.inputVar('Blue', groupsBrain.minVisionNeuronsPerGroup, groupsBrain.maxVisionNeuronsPerGroup);

    this.output('Eat');
    this.output('Mate');
    this.output('Fight');
    this.output('Speed');
    this.output('Yaw');
    if (agent.yawEncoding === 'Oppose') this.output('YawOppose');
    if (agent.hasLightBehavior) this.output('Light');
    this.output('Focus');

    if (agent.enableVisionPitch) this.output('VisionPitch');
    if (agent.enableVisionYaw) this.output('VisionYaw');
    if (agent.enableGive) this.output('Give');
    if (agent.enableCarry) {
      this.output('Pickup');
      this.output('Drop');
    }

    this.internal(
      'InternalNeuronGroupCount',
      groupsBrain.minInternalNeuralGroups,
      groupsBrain.maxInternalNeuralGroups,
    );

    if (groupsBrain.orderedInternalNeuralGroups) {
      this.groupAttr('Order', NeurGroupType.INTERNAL, Scalar.float(0.0), Scalar.float(1.0));
    }

    this.groupAttr(
      'ExcitatoryNeuronCount',
      NeurGroupType.INTERNAL,
      Scalar.int(groupsBrain.minExcitatoryNeuronsPerGroup),
      Scalar.int(groupsBrain.maxExcitatoryNeuronsPerGroup),
    );

    this.groupAttr(
      'InhibitoryNeuronCount',
      NeurGroupType.INTERNAL,
      Scalar.int(groupsBrain.minInhibitoryNeuronsPerGroup),
      Scalar.int(groupsBrain.maxInhibitoryNeuronsPerGroup),
    );

    this.groupAttr(
      'Bias',
      NeurGroupType.NONINPUT,
      Scalar.float(-this.inputs.brainMaxBias),
      Scalar.float(this.inputs.brainMaxBias),
    );

    if (this.inputs.neuronModel === 'T') {
      this.groupAttr(
        'Tau',
        NeurGroupType.NONINPUT,
        Scalar.float(this.inputs.brainTau.minVal),
        Scalar.float(this.inputs.brainTau.maxVal),
      );
      this.groupAttr(
        'Gain',
        NeurGroupType.NONINPUT,
        Scalar.float(this.inputs.brainGain.minVal),
        Scalar.float(this.inputs.brainGain.maxVal),
      );
    }

    if (this.inputs.neuronModel === 'S' && this.inputs.brainSpiking.enableGenes === true) {
      const s = this.inputs.brainSpiking;
      this.groupAttr('SpikingParameterA', NeurGroupType.NONINPUT, Scalar.float(s.aMinVal), Scalar.float(s.aMaxVal));
      this.groupAttr('SpikingParameterB', NeurGroupType.NONINPUT, Scalar.float(s.bMinVal), Scalar.float(s.bMaxVal));
      this.groupAttr('SpikingParameterC', NeurGroupType.NONINPUT, Scalar.float(s.cMinVal), Scalar.float(s.cMaxVal));
      this.groupAttr('SpikingParameterD', NeurGroupType.NONINPUT, Scalar.float(s.dMinVal), Scalar.float(s.dMaxVal));
    }

    if (this.inputs.brainGaussianInitWeight) {
      this.synapseAttr('WeightStdev', false, false, Scalar.float(0.0), Scalar.float(1.0));
    }

    this.synapseAttr(
      'ConnectionDensity',
      false,
      false,
      Scalar.float(groupsBrain.minConnectionDensity),
      Scalar.float(groupsBrain.maxConnectionDensity),
    );

    if (brainEnableLearning) {
      if (brainMinLearningRate === brainMaxLearningRate) {
        this.add(new ImmutableScalarGene('LearningRate', Scalar.float(brainMinLearningRate)));
      } else {
        this.synapseAttr(
          'LearningRate',
          true,
          true,
          Scalar.float(brainMinLearningRate),
          Scalar.float(brainMaxLearningRate),
        );
      }
    }

    this.synapseAttr(
      'TopologicalDistortion',
      false,
      false,
      Scalar.float(groupsBrain.minTopologicalDistortion),
      Scalar.float(groupsBrain.maxTopologicalDistortion),
    );

    // PORT-NOTE(genome/rng-seed-gene-int): these two ranges are the *only* `SYNAPSE_ATTR`
    // arguments in the Groups schema that are `long` in native
    // (`GroupsBrain::Configuration::min/max{Topological,InitWeight}RngSeed`,
    // `GroupsBrain.h:46-47,50-51`); every neighbour passes a `float`. `Scalar(long)` is an
    // `INT` scalar (`utils/Scalar.cc`), and `SynapseAttrGene` fixes its rounding at
    // `ROUND_INT_NEAREST` (`GroupsGene.cc:327`), so native's two genes interpolate as
    // `nint( interp( ratio, min, max ) )` and print `IntNearest INT 0 INT 255` in
    // `generange.txt` — not `None FLOAT 0.000000 FLOAT 255.000000`. `Scalar.float` here (as
    // the port had it) also made the *seeded* value an f32 that `RandomNumberGenerator::seed(
    // long )` had to narrow, where native's `long td_seed = _genome->get( … )` is the `INT`
    // scalar itself; the two spellings agree on the `0..255` range — measured over all 256
    // raws, 0 differ, because `nint` and the f32→`(int)` narrowing both land on the raw byte —
    // and they diverge as soon as the band does not reproduce the raw byte (measured on
    // `0..100`: 125 of 256). See PORT-NOTE(sim/rng-seed-gene-long-read).
    if (groupsBrain.enableTopologicalDistortionRngSeed) {
      this.synapseAttr(
        'TopologicalDistortionRngSeed',
        false,
        false,
        Scalar.int(groupsBrain.minTopologicalDistortionRngSeed),
        Scalar.int(groupsBrain.maxTopologicalDistortionRngSeed),
      );
    }

    if (groupsBrain.enableInitWeightRngSeed) {
      this.synapseAttr(
        'InitWeightRngSeed',
        false,
        false,
        Scalar.int(groupsBrain.minInitWeightRngSeed),
        Scalar.int(groupsBrain.maxInitWeightRngSeed),
      );
    }
  }

  // --- native's define macros --------------------------------------------------------- #

  /** Native `INPUT1( NAME )` — one fixed group of one neuron. */
  private input1(name: string): void {
    this.add(new ImmutableNeurGroupGene(name, NeurGroupType.INPUT));
  }

  /** Native `INPUT( NAME, MINNEUR, MAXNEUR )`. */
  private inputVar(name: string, minNeur: number, maxNeur: number): void {
    if (minNeur === maxNeur) this.add(new ImmutableNeurGroupGene(name, NeurGroupType.INPUT, minNeur));
    else this.add(new MutableNeurGroupGene(name, NeurGroupType.INPUT, Scalar.int(minNeur), Scalar.int(maxNeur)));
  }

  /** Native `OUTPUT( NAME )` — one fixed output group of one neuron. */
  private output(name: string): void {
    this.add(new ImmutableNeurGroupGene(name, NeurGroupType.OUTPUT));
  }

  /** Native `INTERNAL( NAME, MINNEUR, MAXNEUR )`. */
  private internal(name: string, minNeur: number, maxNeur: number): void {
    this.add(new MutableNeurGroupGene(name, NeurGroupType.INTERNAL, Scalar.int(minNeur), Scalar.int(maxNeur)));
  }

  /** Native `GROUP_ATTR( NAME, GROUP, MINVAL, MAXVAL )`. */
  private groupAttr(name: string, groupType: NeurGroupType, min: Scalar, max: Scalar): void {
    this.add(new NeurGroupAttrGene(name, groupType, min, max));
  }

  /** Native `SYNAPSE_ATTR( NAME, NEGATE_I, LESS_THAN_ZERO, MINVAL, MAXVAL )`. */
  private synapseAttr(
    name: string,
    negateInhibitory: boolean,
    lessThanZero: boolean,
    min: Scalar,
    max: Scalar,
  ): void {
    this.add(new SynapseAttrGene(name, negateInhibitory, lessThanZero, min, max));
  }

  // ==================================================================================== #
  // add / caches
  // ==================================================================================== #

  /** Native `GroupsGenomeSchema::add`. */
  override add(gene: Gene): Gene {
    const added = super.add(gene);

    if (added.type === GroupsGeneType.NEURGROUP) {
      this.neurgroups.push(added);
      toNeurGroup(added).schema = this;
    } else if (added.type === GroupsGeneType.NEURGROUP_ATTR) {
      toNeurGroupAttr(added).schema = this;
    } else if (added.type === GroupsGeneType.SYNAPSE_ATTR) {
      toSynapseAttr(added).schema = this;
    }

    return added;
  }

  /** Native `GroupsGenomeSchema::getPhysicalCount`. */
  getPhysicalCount(): number {
    if (this.isComplete()) return this.cache.physicalCount;
    if (!this.isCaching()) throw new Error('GroupsGenomeSchema::getPhysicalCount: bad state');

    let n = 0;
    for (const gene of this.getAll()) {
      if (!gene.ismutable) continue;
      if (gene.type === 'SCALAR') n++;
      else return (this.cache.physicalCount = n);
    }
    throw new Error('GroupsGenomeSchema::getPhysicalCount: fell through');
  }

  /** Native `GroupsGenomeSchema::getMaxGroupCount`. */
  getMaxGroupCount(group: NeurGroupType): number {
    if (this.isComplete()) return this.cache.groupCount[group] ?? 0;
    if (!this.isCaching()) throw new Error('GroupsGenomeSchema::getMaxGroupCount: bad state');

    let n = 0;
    for (const gene of this.neurgroups) {
      const groupGene = toNeurGroup(gene);
      if (groupGene.isMember(group)) n += groupGene.getMaxGroupCount();
    }

    this.cache.groupCount[group] = n;
    return n;
  }

  /** Native `GroupsGenomeSchema::getFirstGroup( Gene * )`. */
  getFirstGroup(gene: NeurGroupGene): number {
    if (this.isComplete()) return gene.firstGroup;
    if (!this.isCaching()) throw new Error('GroupsGenomeSchema::getFirstGroup: bad state');

    let group = 0;
    for (const other of this.neurgroups) {
      const otherGene = toNeurGroup(other);
      if (otherGene === gene) break;
      group += otherGene.getMaxGroupCount();
    }

    gene.firstGroup = group;
    return group;
  }

  /** Native `GroupsGenomeSchema::getFirstGroup( NeurGroupType )` (see the PORT-NOTE). */
  getFirstGroupOfType(group: NeurGroupType): number {
    if (this.isComplete()) return this.cache.groupStart[group] ?? 0;
    if (!this.isCaching()) throw new Error('GroupsGenomeSchema::getFirstGroupOfType: bad state');

    let n: number;
    switch (group) {
      case NeurGroupType.ANY:
      case NeurGroupType.INPUT:
        n = 0;
        break;
      case NeurGroupType.OUTPUT:
      case NeurGroupType.NONINPUT:
        n = this.getMaxGroupCount(NeurGroupType.INPUT);
        break;
      case NeurGroupType.INTERNAL:
        n = this.getMaxGroupCount(NeurGroupType.INPUT) + this.getMaxGroupCount(NeurGroupType.OUTPUT);
        break;
      default:
        return assertNever('getFirstGroupOfType', group);
    }

    this.cache.groupStart[group] = n;
    return n;
  }

  /** Native `GroupsGenomeSchema::getGroupGene`. */
  getGroupGene(group: number): NeurGroupGene {
    const genes = this.getAll(GroupsGeneType.NEURGROUP);
    switch (this.getNeurGroupType(group)) {
      case NeurGroupType.INPUT:
      case NeurGroupType.OUTPUT:
        return toNeurGroup(at(genes, group, 'getGroupGene'));
      case NeurGroupType.INTERNAL:
        return toNeurGroup(at(genes, genes.length - 1, 'getGroupGene'));
      default:
        return assertNever('getGroupGene', this.getNeurGroupType(group));
    }
  }

  /** Native `GroupsGenomeSchema::getMaxNeuronCount`. */
  getMaxNeuronCount(group: NeurGroupType): number {
    if (this.isComplete()) return this.cache.neuronCount[group] ?? 0;
    if (!this.isCaching()) throw new Error('GroupsGenomeSchema::getMaxNeuronCount: bad state');

    let n = 0;
    for (const gene of this.neurgroups) {
      const groupGene = toNeurGroup(gene);
      if (groupGene.isMember(group)) n += groupGene.getMaxNeuronCount();
    }

    this.cache.neuronCount[group] = n;
    return n;
  }

  /** Native `GroupsGenomeSchema::getNeurGroupType`. */
  getNeurGroupType(group: number): NeurGroupType {
    if (group < this.getFirstGroupOfType(NeurGroupType.OUTPUT)) return NeurGroupType.INPUT;
    if (group < this.getFirstGroupOfType(NeurGroupType.INTERNAL)) return NeurGroupType.OUTPUT;
    return NeurGroupType.INTERNAL;
  }

  /** Native `GroupsGenomeSchema::getSynapseTypeCount`. */
  getSynapseTypeCount(): number {
    return this.synapseTypes.length;
  }

  /** Native `GroupsGenomeSchema::getSynapseTypes`. */
  getSynapseTypes(): readonly GroupsSynapseType[] {
    return this.synapseTypes;
  }

  /** Native `GroupsGenomeSchema::getSynapseType`. */
  getSynapseType(name: string): GroupsSynapseType {
    const synapseType = this.synapseTypeMap.get(name);
    if (!synapseType) throw new Error(`GroupsGenomeSchema::getSynapseType: no '${name}'`);
    return synapseType;
  }

  /** Native `GroupsGenomeSchema::getMaxSynapseCount`. */
  getMaxSynapseCount(): number {
    if (this.isComplete()) return this.cache.synapseCount;
    if (!this.isCaching()) throw new Error('GroupsGenomeSchema::getMaxSynapseCount: bad state');

    const input = this.getMaxNeuronCount(NeurGroupType.INPUT);
    const output = this.getMaxNeuronCount(NeurGroupType.OUTPUT);
    const internal = this.getMaxNeuronCount(NeurGroupType.INTERNAL);

    return (this.cache.synapseCount =
      internal * internal +
      2 * output * output +
      3 * internal * output +
      2 * internal * input +
      2 * input * output -
      2 * output -
      internal);
  }

  /** Native `GroupsGenomeSchema::complete`. */
  override complete(offset = 0): void {
    this.beginComplete(offset);

    this.getPhysicalCount();

    for (const type of [
      NeurGroupType.ANY,
      NeurGroupType.INPUT,
      NeurGroupType.OUTPUT,
      NeurGroupType.INTERNAL,
      NeurGroupType.NONINPUT,
    ]) {
      this.getMaxGroupCount(type);
      this.getFirstGroupOfType(type);
      this.getMaxNeuronCount(type);
    }

    this.getMaxSynapseCount();

    for (const gene of this.neurgroups) this.getFirstGroup(toNeurGroup(gene));

    for (const synapseType of this.synapseTypes) synapseType.complete(this.cache.groupCount);

    this.endComplete();
  }

  /** Native `GroupsGenomeSchema::createGenome`. */
  createGenome(layout: import('../genomeLayout').GenomeLayout, rng: RngSurface): GroupsGenome {
    return new GroupsGenome(this, layout, rng);
  }

  // ==================================================================================== #
  // seed()
  // ==================================================================================== #

  /** Native `GroupsGenomeSchema::seed`. */
  override seed(genome: Genome, rng: RngSurface): void {
    if (!(genome instanceof GroupsGenome)) {
      throw new Error('GroupsGenomeSchema::seed: genome is not a GroupsGenome');
    }
    const g = genome;

    if (GenomeSchemaConfig.seedType === SeedType.RANDOM) {
      g.randomize();
      return;
    }
    if (GenomeSchemaConfig.seedType === SeedType.SIMPLE) {
      g.seedAll(0);
    }

    // --- Base class
    super.seed(g, rng);

    const { groupsBrain: gb, agent } = this.inputs;

    if (this.inputs.neuronModel === 'T') {
      g.seedByGene(this.get('Tau'), this.inputs.brainTau.seedVal);
      g.seedByGene(this.get('Gain'), this.inputs.brainGain.seedVal);
    }

    if (gb.minVisionNeuronsPerGroup !== gb.maxVisionNeuronsPerGroup) {
      g.seedByGene(this.get('Red'), gb.seedVisionNeurons);
      g.seedByGene(this.get('Green'), gb.seedVisionNeurons);
      g.seedByGene(this.get('Blue'), gb.seedVisionNeurons);
    }

    if (gb.orderedInternalNeuralGroups) {
      g.seedByGene(this.get('Order'), 0.5);
    }

    if (GenomeSchemaConfig.seedType === SeedType.SIMPLE) {
      g.seedByGene(this.get('Bias'), 0.5);
      g.seedGroupAttr(
        this.get('Bias'),
        this.get('Yaw'),
        0.5 + GenomeSchemaConfig.simpleSeedYawBiasDelta * (rng.drand48() < 0.5 ? -1 : 1),
      );
      g.seedByGene(this.get('ConnectionDensity'), gb.simpleSeedConnectionDensity);
      for (const itIn of this.neurgroups) {
        const geneIn = toNeurGroup(itIn);
        if (geneIn.getGroupType() !== NeurGroupType.INPUT) continue;
        for (const itOut of this.neurgroups) {
          const geneOut = toNeurGroup(itOut);
          if (geneOut.getGroupType() !== NeurGroupType.OUTPUT) continue;
          g.seedSynapseAttr(this.get('ConnectionDensity'), this.getSynapseType('EE'), geneIn, geneOut, gb.simpleSeedIOConnectionDensity);
          g.seedSynapseAttr(this.get('ConnectionDensity'), this.getSynapseType('IE'), geneIn, geneOut, gb.simpleSeedIOConnectionDensity);
        }
      }
      if (gb.mirroredTopologicalDistortion) g.seedByGene(this.get('TopologicalDistortion'), 0.5);
      else g.seedByGene(this.get('TopologicalDistortion'), 1.0);
      return;
    }

    g.seedByGene(this.get('InternalNeuronGroupCount'), 0);
    g.seedByGene(this.get('ExcitatoryNeuronCount'), 0);
    g.seedByGene(this.get('InhibitoryNeuronCount'), 0);
    g.seedByGene(this.get('Bias'), 0.5);

    g.seedGroupAttr(this.get('Bias'), this.get('Mate'), 1.0);
    g.seedGroupAttr(this.get('Bias'), this.get('Fight'), GenomeSchemaConfig.seedFightBias);
    if (agent.enableGive) {
      g.seedGroupAttr(this.get('Bias'), this.get('Give'), GenomeSchemaConfig.seedGiveBias);
    }
    if (agent.enableCarry) {
      g.seedGroupAttr(this.get('Bias'), this.get('Pickup'), GenomeSchemaConfig.seedPickupBias);
      g.seedGroupAttr(this.get('Bias'), this.get('Drop'), GenomeSchemaConfig.seedDropBias);
    }

    g.seedByGene(this.get('ConnectionDensity'), 0);
    if (this.inputs.brainEnableLearning && this.inputs.brainMinLearningRate !== this.inputs.brainMaxLearningRate) {
      g.seedByGene(this.get('LearningRate'), 0);
    }
    g.seedByGene(this.get('TopologicalDistortion'), 0);
    if (gb.enableTopologicalDistortionRngSeed) g.seedByGene(this.get('TopologicalDistortionRngSeed'), 0);
    if (gb.enableInitWeightRngSeed) g.seedByGene(this.get('InitWeightRngSeed'), 0);

    const S = (attr: string, type: string, from: string, to: string, value: number): void =>
      g.seedSynapseAttr(
        this.get(attr),
        this.getSynapseType(type),
        toNeurGroup(this.get(from)),
        toNeurGroup(this.get(to)),
        value,
      );

    S('ConnectionDensity', 'EE', 'Red', 'Fight', GenomeSchemaConfig.seedFightExcitation);
    S('ConnectionDensity', 'EE', 'Green', 'Eat', 1.0);
    S('ConnectionDensity', 'EE', 'Blue', 'Mate', 1.0);
    S('ConnectionDensity', 'IE', 'Red', 'Speed', 0.5);
    S('TopologicalDistortion', 'IE', 'Red', 'Speed', 1.0);
    S('ConnectionDensity', 'EE', 'Green', 'Speed', 0.5);
    S('TopologicalDistortion', 'EE', 'Green', 'Speed', 1.0);
    S('ConnectionDensity', 'EE', 'Blue', 'Speed', 0.5);
    S('TopologicalDistortion', 'EE', 'Blue', 'Speed', 1.0);
    S('ConnectionDensity', 'EE', 'Red', 'Yaw', 0.5);
    S('ConnectionDensity', 'IE', 'Red', 'Yaw', 0.5);
    S('TopologicalDistortion', 'IE', 'Red', 'Yaw', 1.0);
    S('ConnectionDensity', 'EE', 'Green', 'Yaw', 0.5);
    S('ConnectionDensity', 'IE', 'Green', 'Yaw', 0.5);
    S('TopologicalDistortion', 'IE', 'Green', 'Yaw', 1.0);
    S('ConnectionDensity', 'EE', 'Blue', 'Yaw', 0.5);
    S('ConnectionDensity', 'IE', 'Blue', 'Yaw', 0.5);
    S('TopologicalDistortion', 'IE', 'Blue', 'Yaw', 1.0);
    S('ConnectionDensity', 'IE', 'Eat', 'Fight', GenomeSchemaConfig.seedFightExcitation);
    S('ConnectionDensity', 'IE', 'Mate', 'Fight', GenomeSchemaConfig.seedFightExcitation);

    if (agent.enableCarry) {
      const pickup = GenomeSchemaConfig.seedPickupExcitation;
      const drop = GenomeSchemaConfig.seedDropExcitation;
      S('ConnectionDensity', 'EE', 'Red', 'Pickup', pickup);
      S('ConnectionDensity', 'EE', 'Green', 'Pickup', pickup);
      S('ConnectionDensity', 'EE', 'Blue', 'Pickup', pickup);
      S('ConnectionDensity', 'EE', 'Red', 'Drop', drop);
      S('ConnectionDensity', 'EE', 'Green', 'Drop', drop);
      S('ConnectionDensity', 'EE', 'Blue', 'Drop', drop);
      // "if wiring in pickup, have it suppress drop"
      S('ConnectionDensity', 'IE', 'Pickup', 'Drop', pickup);
    }
  }
}
