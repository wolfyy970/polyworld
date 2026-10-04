/**
 * Lane L5 (genome) — `genome/groups/GroupsGenome.{h,cc}`: the concrete genome for a Groups
 * brain. It adds the group/synapse accessors and the physiology-respecting crossover point
 * selection; everything else is `Genome`.
 *
 * PORT-NOTE(genome/groups-overloaded-get): native overloads `get( Gene *, int )` and
 * `get( Gene *, GroupsSynapseType *, int, int )`; TypeScript has one method per name, so
 * the port spells them `getGroupAttr` / `getSynapseAttr` (likewise `seedGroupAttr` /
 * `seedSynapseAttr` for the two `seed` overloads).
 *
 * PORT-NOTE(genome/synapse-count-arithmetic): `getSynapseCount` reproduces the native
 * *float* arithmetic: `cd * nfrom` and then `* nto` each round to f32 in C before `nint()`
 * sees the value, so the port frounds between the multiplies. Doing it in double would
 * change the count for some densities.
 *
 * PORT-NOTE(genome/create-brain-stub): `createBrain()` returns the Groups brain, which is
 * lane L6's (`brain/groups/GroupsBrain`). This lane does not define the brain type, so the
 * method exists, is typed, and throws a lane-L6 error; PARITY.md -> Gaps records it as a
 * stub with its closing lane (PORT_SPEC rule 7).
 */

import { Genome } from '../genome';
import type { GenomeLayout } from '../genomeLayout';
import type { Gene } from '../gene';
import { GenomeSchemaConfig, Resolution } from '../genomeSchema';
import { GroupsSynapseType } from './groupsSynapseType';
import { toNeurGroup, toNeurGroupAttr, toSynapseAttr, type RawGenome } from './groupsGene';
import { NeurGroupType, NeuronType, assertNever, at } from '../vocabulary';
import { Scalar, nint } from '../values';
import type { GroupsGenomeSchema } from './groupsGenomeSchema';
import type { RngSurface } from '../../types';

/** Native `GroupsGenome`. */
export class GroupsGenome extends Genome {
  readonly EE: GroupsSynapseType;
  readonly EI: GroupsSynapseType;
  readonly IE: GroupsSynapseType;
  readonly II: GroupsSynapseType;

  readonly ORDER: Gene | null;
  readonly WEIGHT_STDEV: Gene | null;
  readonly CONNECTION_DENSITY: Gene;
  readonly TOPOLOGICAL_DISTORTION: Gene;
  readonly LEARNING_RATE: Gene | null;
  readonly INHIBITORY_COUNT: Gene;
  readonly EXCITATORY_COUNT: Gene;
  readonly BIAS: Gene;
  readonly INTERNAL: Gene;

  readonly TAU: Gene | null;
  readonly GAIN: Gene | null;

  readonly SPIKING_A: Gene | null;
  readonly SPIKING_B: Gene | null;
  readonly SPIKING_C: Gene | null;
  readonly SPIKING_D: Gene | null;

  private readonly groupSchema: GroupsGenomeSchema;

  constructor(schema: GroupsGenomeSchema, layout: GenomeLayout, rng: RngSurface) {
    super(schema, layout, rng);
    this.groupSchema = schema;

    const inputs = schema.inputs;
    const gene = (name: string): Gene => this.requireGene(name);

    this.ORDER = inputs.groupsBrain.orderedInternalNeuralGroups ? gene('Order') : null;
    this.WEIGHT_STDEV = inputs.brainGaussianInitWeight ? gene('WeightStdev') : null;
    this.CONNECTION_DENSITY = gene('ConnectionDensity');
    this.TOPOLOGICAL_DISTORTION = gene('TopologicalDistortion');
    this.LEARNING_RATE = inputs.brainEnableLearning ? gene('LearningRate') : null;
    this.INHIBITORY_COUNT = gene('InhibitoryNeuronCount');
    this.EXCITATORY_COUNT = gene('ExcitatoryNeuronCount');
    this.BIAS = gene('Bias');
    this.INTERNAL = schema.getGroupGene(schema.getFirstGroupOfType(NeurGroupType.INTERNAL));

    if (inputs.neuronModel === 'T') {
      this.TAU = gene('Tau');
      this.GAIN = gene('Gain');
    } else {
      this.TAU = null;
      this.GAIN = null;
    }

    if (inputs.neuronModel === 'S' && inputs.brainSpiking.enableGenes) {
      this.SPIKING_A = gene('SpikingParameterA');
      this.SPIKING_B = gene('SpikingParameterB');
      this.SPIKING_C = gene('SpikingParameterC');
      this.SPIKING_D = gene('SpikingParameterD');
    } else {
      this.SPIKING_A = null;
      this.SPIKING_B = null;
      this.SPIKING_C = null;
      this.SPIKING_D = null;
    }

    this.EE = schema.getSynapseType('EE');
    this.EI = schema.getSynapseType('EI');
    this.IE = schema.getSynapseType('IE');
    this.II = schema.getSynapseType('II');
  }

  /** Native `GroupsGenome::createBrain` — lane L6 (see PORT-NOTE(genome/create-brain-stub)). */
  override createBrain(_cns: object): object {
    throw new Error(
      'GroupsGenome::createBrain: the Groups brain is lane L6 (brain/groups/GroupsBrain)',
    );
  }

  /** Native `GroupsGenome::getSchema`. */
  getSchema(): GroupsGenomeSchema {
    return this.groupSchema;
  }

  /** Native `GroupsGenome::getGroupCount`. */
  getGroupCount(type: NeurGroupType): number {
    if (type === NeurGroupType.INPUT || type === NeurGroupType.OUTPUT) {
      return this.groupSchema.getMaxGroupCount(type);
    }

    let noninternal: number;
    switch (type) {
      case NeurGroupType.ANY:
        noninternal =
          this.groupSchema.getMaxGroupCount(NeurGroupType.INPUT) +
          this.groupSchema.getMaxGroupCount(NeurGroupType.OUTPUT);
        break;
      case NeurGroupType.INTERNAL:
        noninternal = 0;
        break;
      case NeurGroupType.NONINPUT:
        noninternal = this.groupSchema.getMaxGroupCount(NeurGroupType.OUTPUT);
        break;
      default:
        return assertNever('GroupsGenome::getGroupCount', type);
    }

    return noninternal + this.getByGene(this.INTERNAL).asInt();
  }

  /** Native `GroupsGenome::getOrderedGroups`. */
  getOrderedGroups(): number[] {
    const inputs = this.groupSchema.inputs;

    if (inputs.groupsBrain.orderedInternalNeuralGroups) {
      const maxCount = this.groupSchema.getMaxGroupCount(NeurGroupType.ANY);
      const orders: Array<[number, number]> = [];
      for (let group = 0; group < maxCount; group++) {
        let order = Math.fround(-1.0);
        if (this.groupSchema.getNeurGroupType(group) === NeurGroupType.INTERNAL) {
          order = this.getGroupAttr(this.requireGene('Order'), group).asFloat();
        }
        orders.push([group, order]);
      }
      // Native `std::stable_sort` on the float key; Array.prototype.sort is stable (ES2019).
      orders.sort((a, b) => a[1] - b[1]);

      const count = this.getGroupCount(NeurGroupType.ANY);
      const groups: number[] = [];
      for (let index = 0; index < count; index++) groups.push(at(orders, index, 'getOrderedGroups')[0]);
      return groups;
    }

    const count = this.getGroupCount(NeurGroupType.ANY);
    const groups: number[] = [];
    for (let index = 0; index < count; index++) groups.push(index);
    return groups;
  }

  /** Native `GroupsGenome::getNeuronCount( NeuronType, int )`. */
  getNeuronCount(type: NeuronType, group: number): number {
    const groupGene = this.groupSchema.getGroupGene(group);

    switch (groupGene.getGroupType()) {
      case NeurGroupType.INPUT:
      case NeurGroupType.OUTPUT:
        return this.getByGene(groupGene).asInt();
      case NeurGroupType.INTERNAL:
        switch (type) {
          case NeuronType.INHIBITORY:
            return this.getGroupAttr(this.INHIBITORY_COUNT, group).asInt();
          case NeuronType.EXCITATORY:
            return this.getGroupAttr(this.EXCITATORY_COUNT, group).asInt();
          default:
            return assertNever('GroupsGenome::getNeuronCount', type);
        }
      default:
        return assertNever('GroupsGenome::getNeuronCount', groupGene.getGroupType());
    }
  }

  /** Native `GroupsGenome::getNeuronCount( int group )`. */
  getNeuronCountOfGroup(group: number): number {
    switch (this.groupSchema.getNeurGroupType(group)) {
      case NeurGroupType.INPUT:
      case NeurGroupType.OUTPUT:
        return this.getNeuronCount(NeuronType.INHIBITORY, group);
      case NeurGroupType.INTERNAL:
        return (
          this.getNeuronCount(NeuronType.INHIBITORY, group) +
          this.getNeuronCount(NeuronType.EXCITATORY, group)
        );
      default:
        return assertNever('GroupsGenome::getNeuronCount( group )', this.groupSchema.getNeurGroupType(group));
    }
  }

  /** Native `GroupsGenome::getSynapseTypes`. */
  getSynapseTypes(): readonly GroupsSynapseType[] {
    return this.groupSchema.getSynapseTypes();
  }

  /** Native `GroupsGenome::getSynapseCount( GroupsSynapseType *, int, int )`. */
  getSynapseCount(synapseType: GroupsSynapseType, from: number, to: number): number {
    const ntFrom = synapseType.ntFrom;
    const ntTo = synapseType.ntTo;
    const toOutput = this.groupSchema.getNeurGroupType(to) === NeurGroupType.OUTPUT;

    if (ntTo === NeuronType.INHIBITORY && toOutput) {
      // "As targets, the output neurons are treated exclusively as excitatory"
      return 0;
    }

    const cd = this.getSynapseAttr(this.CONNECTION_DENSITY, synapseType, from, to).asFloat();

    const nfrom = this.getNeuronCount(ntFrom, from);
    let nto = this.getNeuronCount(ntTo, to);

    if (from === to) {
      if (synapseType === this.IE && toOutput) {
        // "If the source and target groups are the same, and both are an output group,
        //  then this will evaluate to zero."
        nto--;
      } else if (ntFrom === ntTo) {
        nto--;
      }
    }

    // Native: `nint( cd * nfrom * nto )` with each multiply rounded to f32.
    return nint(Math.fround(Math.fround(cd * nfrom) * nto));
  }

  /** Native `GroupsGenome::getSynapseCount( int from, int to )`. */
  getSynapseCountOfGroups(from: number, to: number): number {
    let n = 0;
    for (const synapseType of this.groupSchema.getSynapseTypes()) {
      n += this.getSynapseCount(synapseType, from, to);
    }
    return n;
  }

  /** Native `GroupsGenome::get( Gene *, int group )`. */
  getGroupAttr(gene: Gene | null, group: number): Scalar {
    return toNeurGroupAttr(gene).get(this as unknown as RawGenome, group);
  }

  /** Native `GroupsGenome::get( Gene *, GroupsSynapseType *, int, int )`. */
  getSynapseAttr(
    gene: Gene | null,
    synapseType: GroupsSynapseType,
    from: number,
    to: number,
  ): Scalar {
    return toSynapseAttr(gene).get(this as unknown as RawGenome, synapseType, from, to);
  }

  /** Native `GroupsGenome::seed( Gene * attr, Gene * group, float rawval_ratio )`. */
  seedGroupAttr(attr: Gene | null, group: Gene | null, ratio: number): void {
    if (!(ratio >= 0 && ratio <= 1)) {
      throw new Error(`GroupsGenome::seed(${attr?.name}): ratio ${ratio} outside [0, 1]`);
    }
    toNeurGroupAttr(attr).seedGroup(
      this as unknown as RawGenome,
      toNeurGroup(group),
      seedVal(ratio),
    );
  }

  /** Native `GroupsGenome::seed( Gene *, GroupsSynapseType *, Gene *, Gene *, float )`. */
  seedSynapseAttr(
    gene: Gene | null,
    synapseType: GroupsSynapseType,
    from: Gene | null,
    to: Gene | null,
    ratio: number,
  ): void {
    if (!(ratio >= 0 && ratio <= 1)) {
      throw new Error(`GroupsGenome::seed(${gene?.name}): ratio ${ratio} outside [0, 1]`);
    }
    toSynapseAttr(gene).seedSynapse(
      this as unknown as RawGenome,
      synapseType,
      toNeurGroup(from),
      toNeurGroup(to),
      seedVal(ratio),
    );
  }

  /** Native `GroupsGenome::seedRandom( Gene * attr, Gene * group, float, float )`. */
  seedRandomGroupAttr(attr: Gene | null, group: Gene | null, min: number, max: number): void {
    if (!(min >= 0 && min <= 1)) throw new Error(`GroupsGenome::seedRandom: min ${min}`);
    if (!(max >= 0 && max <= 1)) throw new Error(`GroupsGenome::seedRandom: max ${max}`);
    toNeurGroupAttr(attr).randomizeGroup(
      this as unknown as RawGenome,
      toNeurGroup(group),
      seedVal(min),
      seedVal(max),
    );
  }

  /** Native `GroupsGenome::getCrossoverPoints`. */
  protected override getCrossoverPoints(crossoverPoints: number[], numCrossPoints: number): void {
    const numphysbytes = this.groupSchema.getPhysicalCount();
    let i = 0;

    // guarantee crossover in "physiology" genes
    if (numCrossPoints > 2 && numphysbytes > 1) {
      if (GenomeSchemaConfig.resolution === Resolution.BIT) {
        crossoverPoints[0] = Math.trunc(this.draw() * numphysbytes * 8);
        crossoverPoints[1] = numphysbytes * 8;
      } else if (GenomeSchemaConfig.resolution === Resolution.BYTE) {
        crossoverPoints[0] = Math.trunc(this.draw() * numphysbytes);
        crossoverPoints[1] = numphysbytes;
      } else {
        throw new Error('getCrossoverPoints: unknown genetic operator resolution');
      }
      i = 2;
    }

    // Generate & order the crossover points
    for (; i < numCrossPoints; i++) {
      let newCrossPoint = this.newCrossPoint(numphysbytes);

      let equal: boolean;
      do {
        equal = false;
        for (let j = 0; j < i; j++) {
          if (newCrossPoint === crossoverPoints[j]) equal = true;
        }
        if (equal) newCrossPoint = this.newCrossPoint(numphysbytes);
      } while (equal);

      if (i === 0 || newCrossPoint > (crossoverPoints[i - 1] ?? 0)) {
        crossoverPoints[i] = newCrossPoint; // happened to come out ordered
      } else {
        for (let j = 0; j < i; j++) {
          if (newCrossPoint < (crossoverPoints[j] ?? 0)) {
            for (let k = i; k > j; k--) crossoverPoints[k] = crossoverPoints[k - 1] ?? 0;
            crossoverPoints[j] = newCrossPoint;
            break;
          }
        }
      }
    }
  }

  /** Native's `long( randpw() * ( nbytes - numphysbytes ) * 8 ) + numphysbytes * 8` pair. */
  private newCrossPoint(numphysbytes: number): number {
    if (GenomeSchemaConfig.resolution === Resolution.BIT) {
      return Math.trunc(this.draw() * (this.nbytes - numphysbytes) * 8) + numphysbytes * 8;
    }
    if (GenomeSchemaConfig.resolution === Resolution.BYTE) {
      return Math.trunc(this.draw() * (this.nbytes - numphysbytes)) + numphysbytes;
    }
    throw new Error('getCrossoverPoints: unknown genetic operator resolution');
  }

  /** Native `randpw()` — the shared drand48 draw (see the RNG PORT-NOTE in `genome.ts`). */
  private draw(): number {
    return this.randpw();
  }

  private requireGene(name: string): Gene {
    const gene = this.gene(name);
    if (!gene) throw new Error(`GroupsGenome: no gene named '${name}' in this schema`);
    return gene;
  }
}

/** Native `SEEDVAL( VAL )` (`GroupsGenome.cc` repeats the macro). */
function seedVal(ratio: number): number {
  return (ratio === 1 ? 255 : ratio * 256) & 0xff;
}
