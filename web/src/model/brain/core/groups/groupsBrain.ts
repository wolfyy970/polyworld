/**
 * Lane L6 (brain core) — `brain/groups/GroupsBrain.{h,cc}`: the "Groups" brain architecture —
 * neuron-group layout, synapse-count arithmetic, the connection walk, initial efficacy and
 * learning-rate assignment.
 *
 * This is the architecture the recorded scenarios use (`BrainArchitecture Groups` in
 * `minitest.wf`), so every index and every weight it lays down is compared byte-for-byte by
 * the oracle (`run/brain/synapses/**`, `run/brain/anatomy/**`, `run/brain/function/**`).
 *
 * PORT-NOTE(l6/groups-neuron-index-layout): the neuron array is laid out
 * `[input groups …][output groups …][internal groups …]`, where the first two come from the
 * *nerve* order (`NervousSystem` sums its INPUT/OUTPUT nerves) and the internal groups follow
 * in `orderedGroups` order with all excitatory neurons of a group before its inhibitory
 * ones. `firsteneur[i]`/`firstineur[i]` are indexed by the *ordered* index `i`, not by the
 * schema group number, and the internal-group loop starts at `_cns.getNerveCount()` — i.e.
 * it assumes `orderedGroups` lists the input then output groups first, in schema order.
 * `getOrderedGroups()` guarantees that (non-internal groups sort with `order = -1.0`, a
 * `stable_sort`), and the port keeps the assumption *and* the indexing rather than
 * re-deriving "the first I/O groups" — the two coincide only because of that ordering.
 *
 * PORT-NOTE(l6/groups-synapse-remainder): `growSynapses` spreads `synapseCount_fromto`
 * connections over the postsynaptic neurons with a *persistent per-group float remainder*, in
 * call order (`EE`, `IE` for e-neurons; `EI`, `II` for i-neurons) and inside that, in
 * `orderedGroups` order. `synapseCount_new = short( nsynjiperneur + remainder + 1.e-5 )` is a
 * **C++ functional cast — truncation toward zero, not `nint`** — and its operand types are the
 * subtle part: `nsynjiperneur` and `remainder` are both `float`, so that first `+` *rounds to
 * `float`*, and only then does the `double` literal `1.e-5` promote the sum, which `short(...)`
 * truncates. (An earlier revision of this note said the sum was computed entirely in `double`;
 * that reading was wrong and hid a real divergence — see `growArithmetic.ts`, which isolates
 * the expression, and PARITY.md's `l6/groups-grow-arithmetic` row.) Reproducing either half
 * wrongly shifts one connection per group and changes every downstream byte.
 *
 * PORT-NOTE(l6/groups-nint-double-evaluation): the distortion draw is the one place in the walk
 * where a *macro* decides how many draws the model consumes. `short distortion = short(
 * nint( td_rng->range(-0.5,0.5) * td_fromto_abs * neuronCount_from ) )` passes an argument with
 * a side effect to `nint`, and `nint` mentions its argument twice (`utils/misc.h`), so the
 * `range()` call is made **twice** — four draws per connection whose `drand()` test passes, two
 * per connection that fails it. The compiled macro's evaluation order (the port's
 * `distortionIndex( termA, termB, … )`: the first draw in the sum, the second only in the sign
 * test) and its contraction (`0x66dc0 fmadd d0, d9, d11, d0`: the sum carries **one** rounding,
 * fused with the last multiply of the first evaluation — `nativeMath.ts`'s `nintFused`) are both
 * pinned by `native/brainprobe.cc`'s `distort` grid. Nothing about this is cosmetic:
 * `GroupsBrain::grow` and `NervousSystem::prebirthSignal` draw from the *same* per-agent
 * `NERVOUS_SYSTEM` generator (LOCAL MT19937, seeded with the agent's 1-based `agentsEver` when
 * `StaticTimestepGeometry` is true), so a walk that consumes one draw fewer per passing
 * connection leaves every later draw of that agent shifted — measured 2026-09-28
 * (`t_e970f22a`): `run/brain/anatomy|synapses|function/**` byte-exact for output neurons 29-31
 * and wrong for 32/33 (the first targets whose connections all take the distortion branch),
 * with every prebirth activation wrong behind them.
 *
 * PORT-NOTE(l6/groups-short-narrowing): several native locals are `short`, so intermediate
 * results are narrowed (`short( nint( … ) )`, `max<short>( 0, min<short>( … ) )`, the
 * `distortion` cast). The port applies the same narrowing (`toShort`) — for the recorded
 * architectures the values fit, but the port must agree on the *definition*, and a silently
 * un-narrowed intermediate is exactly the class of difference PARITY.md exists to catch.
 *
 * PORT-NOTE(l6/groups-32bit-synapse-estimate): `GroupsBrain::init`'s `maxsynapses` estimate is
 * computed in C `int` (every factor is a `short`, and only the *result* is a `long`), so a
 * large configuration overflows before it is stored. The port wraps each product and the sum
 * to 32 bits (`int32`), because that estimate is the denominator of the energy-use formula
 * and the bound in the `numsynapses > maxsynapses` check.
 *
 * PORT-NOTE(l6/groups-energy-use-float): the energy formula is float arithmetic end to end
 * (`float( numNeurons ) / float( config.maxneurons )` is a float division, each product is a
 * float product, the sum is a float sum) — the port rounds at each of those steps. The
 * differential harness prints `getEnergyUse()` so any deviation (for instance from a
 * fused-multiply-add by the native compiler) shows up as a number.
 *
 * PORT-NOTE(l6/groups-agent-config): `GroupsBrain::init()` derives the input/output group
 * counts from `agent::config` (`EnableMateWaitFeedback`, `EnableSpeedFeedback`, `EnableCarry`,
 * `YawEncoding`, `HasLightBehavior`, `EnableVisionPitch`, `EnableVisionYaw`, `EnableGive`).
 * Those flags are lane L8's; the port takes them as an explicit `BrainFlags` argument instead
 * of importing the agent lane, and `initBrain()` wires them up.
 */

import { Brain, brainConfig, NeuronModelKind } from '../brain';
import { FiringRateModel } from '../firingRateModel';
import { SpikingModel } from '../spikingModel';
import type { GroupsGenomeView, GroupsSynapseType } from '../brainGenome';
import { NeurGroupType, NeuronType } from '../brainGenome';
import { NerveType } from '../nerve';
import type { NervousSystem } from '../nervousSystem';
import { brainError } from '../errors';
import { f32, int32 } from '../nativeMath';
import {
  distortionIndex,
  energyUseOf,
  neuronLocalIndexFromBase as growNeuronLocalIndexFromBase,
  nsynjiPerNeuron,
  remainderUpdate,
  stdevOf,
  synapseCountNew as growSynapseCountNew,
  TdAbsBranch,
  tdFromToAbs,
} from './growArithmetic';
import { globalGrowRng, GrowRngRole, localGrowRng, type GrowRng } from '../growRng';
import { InjectedBrainRng, type BrainRngProvider } from '../brainRng';
import type { FiringRateNeuronAttrs, NeuronAttrs, SpikingNeuronAttrs } from '../neuronModel';
import type { RendererFactory } from '../neuralNetRenderer';

/** Native `static float initminweight = 0.0;` — "could read this in". */
const INIT_MIN_WEIGHT = 0.0;

/** Native `GroupsBrain::Configuration`. */
export interface GroupsBrainConfig {
  maxneurons: number;
  maxsynapses: number;

  numinputneurgroups: number;
  numoutneurgroups: number;
  minvisneurpergroup: number;
  maxvisneurpergroup: number;
  seedvisneur: number;
  mininternalneurgroups: number;
  maxinternalneurgroups: number;
  orderedinternalneurgroups: boolean;
  mineneurpergroup: number;
  maxeneurpergroup: number;
  minineurpergroup: number;
  maxineurpergroup: number;
  maxneurpergroup: number;
  maxneurgroups: number;
  maxnoninputneurgroups: number;
  maxinternalneurons: number;
  maxinputneurons: number;
  maxnoninputneurons: number;
  minconnectiondensity: number;
  maxconnectiondensity: number;
  simpleseedconnectiondensity: number;
  simpleseedioconnectiondensity: number;
  mirroredtopologicaldistortion: boolean;
  mintopologicaldistortion: number;
  maxtopologicaldistortion: number;

  enableTopologicalDistortionRngSeed: boolean;
  minTopologicalDistortionRngSeed: number;
  maxTopologicalDistortionRngSeed: number;

  enableInitWeightRngSeed: boolean;
  minInitWeightRngSeed: number;
  maxInitWeightRngSeed: number;
}

export const groupsConfig: GroupsBrainConfig = {
  maxneurons: 0,
  maxsynapses: 0,
  numinputneurgroups: 0,
  numoutneurgroups: 0,
  minvisneurpergroup: 0,
  maxvisneurpergroup: 0,
  seedvisneur: 0,
  mininternalneurgroups: 0,
  maxinternalneurgroups: 0,
  orderedinternalneurgroups: false,
  mineneurpergroup: 0,
  maxeneurpergroup: 0,
  minineurpergroup: 0,
  maxineurpergroup: 0,
  maxneurpergroup: 0,
  maxneurgroups: 0,
  maxnoninputneurgroups: 0,
  maxinternalneurons: 0,
  maxinputneurons: 0,
  maxnoninputneurons: 0,
  minconnectiondensity: 0,
  maxconnectiondensity: 0,
  simpleseedconnectiondensity: 0,
  simpleseedioconnectiondensity: 0,
  mirroredtopologicaldistortion: false,
  mintopologicaldistortion: 0,
  maxtopologicaldistortion: 0,
  enableTopologicalDistortionRngSeed: false,
  minTopologicalDistortionRngSeed: 0,
  maxTopologicalDistortionRngSeed: 0,
  enableInitWeightRngSeed: false,
  minInitWeightRngSeed: 0,
  maxInitWeightRngSeed: 0,
};

/** The worldfile reader for `GroupsBrain::processWorldfile` (W1a's `Config`). */
export interface GroupsWorldfileReader {
  getInt(id: string): number;
  getFloat(id: string): number;
  getBool(id: string): number | boolean;
}

/** Native `GroupsBrain::processWorldfile`. */
export function processGroupsWorldfile(doc: GroupsWorldfileReader): void {
  groupsConfig.minvisneurpergroup = doc.getInt('MinVisionNeuronsPerGroup');
  groupsConfig.maxvisneurpergroup = doc.getInt('MaxVisionNeuronsPerGroup');
  groupsConfig.seedvisneur = doc.getFloat('SeedVisionNeurons');
  groupsConfig.mininternalneurgroups = doc.getInt('MinInternalNeuralGroups');
  groupsConfig.maxinternalneurgroups = doc.getInt('MaxInternalNeuralGroups');
  groupsConfig.orderedinternalneurgroups = Boolean(doc.getBool('OrderedInternalNeuralGroups'));
  groupsConfig.mineneurpergroup = doc.getInt('MinExcitatoryNeuronsPerGroup');
  groupsConfig.maxeneurpergroup = doc.getInt('MaxExcitatoryNeuronsPerGroup');
  groupsConfig.minineurpergroup = doc.getInt('MinInhibitoryNeuronsPerGroup');
  groupsConfig.maxineurpergroup = doc.getInt('MaxInhibitoryNeuronsPerGroup');
  groupsConfig.minconnectiondensity = doc.getFloat('MinConnectionDensity');
  groupsConfig.maxconnectiondensity = doc.getFloat('MaxConnectionDensity');
  groupsConfig.simpleseedconnectiondensity = doc.getFloat('SimpleSeedConnectionDensity');
  groupsConfig.simpleseedioconnectiondensity = doc.getFloat('SimpleSeedIOConnectionDensity');
  groupsConfig.mirroredtopologicaldistortion = Boolean(doc.getBool('MirroredTopologicalDistortion'));
  groupsConfig.mintopologicaldistortion = doc.getFloat('MinTopologicalDistortion');
  groupsConfig.maxtopologicaldistortion = doc.getFloat('MaxTopologicalDistortion');
  groupsConfig.enableTopologicalDistortionRngSeed = Boolean(doc.getBool('EnableTopologicalDistortionRngSeed'));
  groupsConfig.minTopologicalDistortionRngSeed = doc.getInt('MinTopologicalDistortionRngSeed');
  groupsConfig.maxTopologicalDistortionRngSeed = doc.getInt('MaxTopologicalDistortionRngSeed');
  groupsConfig.enableInitWeightRngSeed = Boolean(doc.getBool('EnableInitWeightRngSeed'));
  groupsConfig.minInitWeightRngSeed = doc.getInt('MinInitWeightRngSeed');
  groupsConfig.maxInitWeightRngSeed = doc.getInt('MaxInitWeightRngSeed');
}

/** The `agent::config` flags `GroupsBrain::init` reads (lane L8's config, injected here). */
export interface BrainFlags {
  enableMateWaitFeedback: boolean;
  enableSpeedFeedback: boolean;
  enableCarry: boolean;
  yawEncodingIsOppose: boolean;
  hasLightBehavior: boolean;
  enableVisionPitch: boolean;
  enableVisionYaw: boolean;
  enableGive: boolean;
}

/** Native `GroupsBrain::init`. */
export function initGroupsBrain(flags: BrainFlags): void {
  // native: RandomNumberGenerator::set( TOPOLOGICAL_DISTORTION, LOCAL );
  //         RandomNumberGenerator::set( INIT_WEIGHT, LOCAL );
  // — recorded on the lane boundary in `brainRng.ts`; the roles are only *used* when the
  // worldfile turns the per-connection seeds on.

  let numinputneurgroups = 5;
  if (flags.enableMateWaitFeedback) numinputneurgroups++;
  if (flags.enableSpeedFeedback) numinputneurgroups++;
  if (flags.enableCarry) numinputneurgroups += 2;
  groupsConfig.numinputneurgroups = numinputneurgroups;

  let numoutneurgroups = 6;
  if (flags.yawEncodingIsOppose) numoutneurgroups++;
  if (flags.hasLightBehavior) numoutneurgroups++;
  if (flags.enableVisionPitch) numoutneurgroups++;
  if (flags.enableVisionYaw) numoutneurgroups++;
  if (flags.enableGive) numoutneurgroups++;
  if (flags.enableCarry) numoutneurgroups += 2;
  groupsConfig.numoutneurgroups = numoutneurgroups;

  const cfg = groupsConfig;
  cfg.maxnoninputneurgroups = cfg.maxinternalneurgroups + cfg.numoutneurgroups;
  cfg.maxneurgroups = cfg.maxnoninputneurgroups + cfg.numinputneurgroups;
  cfg.maxneurpergroup = cfg.maxeneurpergroup + cfg.maxineurpergroup;
  cfg.maxinternalneurons = cfg.maxneurpergroup * cfg.maxinternalneurgroups;
  cfg.maxinputneurons = cfg.maxvisneurpergroup * 3 + (numinputneurgroups - 3);
  cfg.maxnoninputneurons = cfg.maxinternalneurons + cfg.numoutneurgroups;
  cfg.maxneurons = cfg.maxinternalneurons + cfg.maxinputneurons + cfg.numoutneurgroups;

  // the 2's are due to the input & output neurons doubling as e & i presynaptically
  // the 3's are due to the output neurons also acting as e-neurons postsynaptically
  // the -'s are due to the output & internal neurons not self-stimulating
  cfg.maxsynapses = int32(
    int32(cfg.maxinternalneurons * cfg.maxinternalneurons) + // internal
      int32(int32(2 * cfg.numoutneurgroups) * cfg.numoutneurgroups) + // output
      int32(int32(3 * cfg.maxinternalneurons) * cfg.numoutneurgroups) + // internal/output
      int32(int32(2 * cfg.maxinternalneurons) * cfg.maxinputneurons) + // internal/input
      int32(int32(2 * cfg.maxinputneurons) * cfg.numoutneurgroups) - // input/output
      int32(2 * cfg.numoutneurgroups) - // output/output
      cfg.maxinternalneurons, // internal/internal
  );
}

export interface GroupsBrainOptions {
  /** Lane L15's renderer factory (see `neuralNetRenderer.ts`); omitted for headless runs. */
  rendererFactory?: RendererFactory;
  /**
   * Native `RandomNumberGenerator::create( role )` for the LOCAL roles
   * (`TOPOLOGICAL_DISTORTION`, `INIT_WEIGHT`). Only needed when the worldfile turns the
   * per-connection seeds on; `brainRng.ts` is the boundary.
   */
  rngProvider?: BrainRngProvider;
}

export class GroupsBrain extends Brain {
  private readonly _genome: GroupsGenomeView;
  private readonly _rendererFactory: RendererFactory | undefined;
  private readonly _rngProvider: BrainRngProvider | undefined;
  private _numgroups = 0;
  private _numgroupsWithNeurons = 0;
  private orderedGroups: number[] = [];

  constructor(cns: NervousSystem, genome: GroupsGenomeView, options: GroupsBrainOptions = {}) {
    super(cns);
    this._genome = genome;
    this._rendererFactory = options.rendererFactory;
    this._rngProvider = options.rngProvider ?? new InjectedBrainRng(cns.getRNG(), () => {
      throw new Error('GroupsBrain: this run needs a LOCAL RNG role (EnableTopologicalDistortionRngSeed/EnableInitWeightRngSeed) but no rngProvider was injected');
    });
    this.grow();
  }

  /** Native `NumNeuronGroups( ignoreEmpty )`. */
  numNeuronGroups(ignoreEmpty = true): number {
    return ignoreEmpty ? this._numgroupsWithNeurons : this._numgroups;
  }

  /** Native `GroupsBrain::initNeuralNet`. */
  private initNeuralNet(initialActivation: number): void {
    switch (brainConfig.neuronModel) {
      case NeuronModelKind.SPIKING: {
        const spiking = new SpikingModel(this._cns, this._genome.namedValue('ScaleLatestSpikes'));
        this._neuralnet = spiking;
        this._renderer = this._rendererFactory?.(spiking, this.orderedGroups) ?? null;
        break;
      }
      case NeuronModelKind.FIRING_RATE:
      case NeuronModelKind.TAU_GAIN: {
        const firingRate = new FiringRateModel(this._cns);
        this._neuralnet = firingRate;
        this._renderer = this._rendererFactory?.(firingRate, this.orderedGroups) ?? null;
        break;
      }
      default:
        throw new Error('GroupsBrain::initNeuralNet: unknown neuron model');
    }

    this._neuralnet!.init(this._dims, initialActivation);
  }

  /** Native `GroupsBrain::nearestFreeNeuron` — alternating search outward from `iin`. */
  private nearestFreeNeuron(iin: number, used: boolean[], num: number, exclude: number): number {
    let iout: number;
    let tideishigh: boolean;
    let hitide = iin;
    let lotide = iin;

    if (iin < num - 1) {
      iout = iin + 1;
      tideishigh = true;
    } else {
      iout = iin - 1;
      tideishigh = false;
    }

    while (used[iout] || iout === exclude) {
      if (tideishigh) {
        hitide = iout;
        if (lotide > 0) {
          iout = lotide - 1;
          tideishigh = false;
        } else if (hitide < num - 1) {
          iout++;
        }
      } else {
        lotide = iout;
        if (hitide < num - 1) {
          iout = hitide + 1;
          tideishigh = true;
        } else if (lotide > 0) {
          iout--;
        }
      }

      if (lotide === 0 && hitide === num - 1) {
        brainError(2, 'brain::nearestfreeneuron search failed');
      }
    }

    return iout;
  }

  /** Native `GroupsBrain::grow`. */
  private grow(): void {
    const genome = this._genome;
    const cns = this._cns;
    const dims = this._dims;

    this._numgroups = genome.groupCount();
    this._numgroupsWithNeurons = 0;
    for (let i = 0; i < this._numgroups; i++) {
      if (genome.neuronCountTotal(i) > 0) this._numgroupsWithNeurons++;
    }
    this.orderedGroups = [...genome.orderedGroups()];

    const isInputGroup = (group: number): boolean => genome.groupType(group) === NeurGroupType.INPUT;
    const isOutputGroup = (group: number): boolean => genome.groupType(group) === NeurGroupType.OUTPUT;

    // stack buffers (native `ALLOC_GROW_STACK_BUFFERS`)
    const firsteneur = new Int32Array(this._numgroups);
    const firstineur = new Int32Array(this._numgroups);
    const eeremainder = new Float32Array(this._numgroups);
    const eiremainder = new Float32Array(this._numgroups);
    const iiremainder = new Float32Array(this._numgroups);
    const ieremainder = new Float32Array(this._numgroups);

    // --- Configure Input/Output Neurons/Nerves ---
    {
      let neuronIndex = 0;
      const numInOutGroups = genome.maxGroupCount(NeurGroupType.INPUT) + genome.maxGroupCount(NeurGroupType.OUTPUT);

      for (let group = 0; group < numInOutGroups; group++) {
        const nerve = cns.getNerve(genome.groupName(group));
        const numneurons = genome.neuronCount(NeuronType.EXCITATORY, group);

        nerve.configCount(numneurons, neuronIndex);
        firsteneur[group] = neuronIndex;
        firstineur[group] = neuronIndex; // input/output neurons double as e & i

        neuronIndex += numneurons;
      }
    }

    dims.numInputNeurons = cns.getNeuronCount(NerveType.INPUT);
    dims.numOutputNeurons = cns.getNeuronCount(NerveType.OUTPUT);

    let numNonInputNeurons = dims.numOutputNeurons;

    // --- Configure Internal Groups ---
    for (let i = cns.getNerveCount(); i < this._numgroups; i++) {
      const gi = this.orderedGroups[i]!;
      firsteneur[i] = dims.numInputNeurons + numNonInputNeurons;
      numNonInputNeurons += genome.neuronCount(NeuronType.EXCITATORY, gi);
      firstineur[i] = dims.numInputNeurons + numNonInputNeurons;
      numNonInputNeurons += genome.neuronCount(NeuronType.INHIBITORY, gi);
    }

    // --- Count Synapses ---
    dims.numSynapses = 0;
    for (let i = cns.getNerveCount(NerveType.INPUT); i < this._numgroups; i++) {
      const gi = this.orderedGroups[i]!;
      for (let j = 0; j < this._numgroups; j++) {
        const gj = this.orderedGroups[j]!;
        dims.numSynapses += genome.synapseCountTotal(gj, gi);
      }
    }

    dims.numNeurons = numNonInputNeurons + dims.numInputNeurons;
    if (dims.numNeurons > groupsConfig.maxneurons) {
      brainError(2, `numneurons ( ${dims.numNeurons} ) > maxneurons ( ${groupsConfig.maxneurons} ) in brain::grow`);
    }
    if (dims.numSynapses > groupsConfig.maxsynapses) {
      brainError(2, `numsynapses ( ${dims.numSynapses} ) > maxsynapses ( ${groupsConfig.maxsynapses} ) in brain::grow`);
    }

    // --- Allocate Neural Net ---
    this.initNeuralNet(0.1); // lsy? - why is this initializing activations to 0.1?

    let numsyn = 0;
    let numneur = dims.numInputNeurons;

    // --- Create NeuronModel-specific neuron attributes struct (native: one reused union) ---
    const firingRateAttrs: FiringRateNeuronAttrs = { bias: 0, tau: 0, gain: 0 };
    const spikingAttrs: SpikingNeuronAttrs = {
      bias: 0,
      spikingParameterA: 0,
      spikingParameterB: 0,
      spikingParameterC: 0,
      spikingParameterD: 0,
    };

    const spikingModel = brainConfig.neuronModel === NeuronModelKind.SPIKING;
    const attrs: NeuronAttrs = spikingModel ? spikingAttrs : firingRateAttrs;

    // --- Initialize Input Neuron Activations ---
    if (spikingModel) {
      spikingAttrs.spikingParameterA = 0;
      spikingAttrs.spikingParameterB = 0;
      spikingAttrs.spikingParameterC = 0;
      spikingAttrs.spikingParameterD = 0;
      spikingAttrs.bias = 0.0;
    } else {
      firingRateAttrs.tau = 0.0;
      firingRateAttrs.bias = 0.0;
      firingRateAttrs.gain = 0.0;
    }

    for (let i = 0, ineur = 0; i < groupsConfig.numinputneurgroups; i++) {
      const gi = this.orderedGroups[i]!;
      const count = genome.neuronCount(NeuronType.EXCITATORY, gi);
      for (let j = 0; j < count; j++, ineur++) {
        this._neuralnet!.setNeuron(ineur, attrs);
      }
    }

    // --- Grow Synapses ---
    for (let groupIndexTo = groupsConfig.numinputneurgroups; groupIndexTo < this._numgroups; groupIndexTo++) {
      const gGroupIndexTo = this.orderedGroups[groupIndexTo]!;

      if (spikingModel) {
        spikingAttrs.bias = genome.groupGeneValue('Bias', gGroupIndexTo);
        if (brainConfig.Spiking.enableGenes) {
          spikingAttrs.spikingParameterA = genome.groupGeneValue('SpikingParameterA', gGroupIndexTo);
          spikingAttrs.spikingParameterB = genome.groupGeneValue('SpikingParameterB', gGroupIndexTo);
          spikingAttrs.spikingParameterC = genome.groupGeneValue('SpikingParameterC', gGroupIndexTo);
          spikingAttrs.spikingParameterD = genome.groupGeneValue('SpikingParameterD', gGroupIndexTo);
        } else {
          spikingAttrs.spikingParameterA = 0.02;
          spikingAttrs.spikingParameterB = 0.2;
          spikingAttrs.spikingParameterC = -65;
          spikingAttrs.spikingParameterD = 6;
        }
      } else if (brainConfig.neuronModel === NeuronModelKind.TAU_GAIN) {
        firingRateAttrs.tau = genome.groupGeneValue('Tau', gGroupIndexTo);
        firingRateAttrs.gain = genome.groupGeneValue('Gain', gGroupIndexTo);
        firingRateAttrs.bias = genome.groupGeneValue('Bias', gGroupIndexTo);
      } else {
        firingRateAttrs.bias = genome.groupGeneValue('Bias', gGroupIndexTo);
      }

      for (let groupIndexFrom = 0; groupIndexFrom < this._numgroups; groupIndexFrom++) {
        eeremainder[groupIndexFrom] = 0.0;
        eiremainder[groupIndexFrom] = 0.0;
        iiremainder[groupIndexFrom] = 0.0;
        ieremainder[groupIndexFrom] = 0.0;
      }

      // setup all e-neurons for this group
      let neuronCountTo = genome.neuronCount(NeuronType.EXCITATORY, gGroupIndexTo);

      for (let neuronLocalIndexTo = 0; neuronLocalIndexTo < neuronCountTo; neuronLocalIndexTo++) {
        const neuronIndexTo = neuronLocalIndexTo + firsteneur[groupIndexTo]!;

        this._neuralnet!.setNeuron(neuronIndexTo, attrs, numsyn);

        numsyn = this.growSynapses(
          groupIndexTo,
          neuronCountTo,
          eeremainder,
          neuronLocalIndexTo,
          neuronIndexTo,
          firsteneur,
          numsyn,
          genome.synapseTypeEE,
        );

        numsyn = this.growSynapses(
          groupIndexTo,
          neuronCountTo,
          ieremainder,
          neuronLocalIndexTo,
          neuronIndexTo,
          firstineur,
          numsyn,
          genome.synapseTypeIE,
        );

        this._neuralnet!.setNeuronEndSynapses(neuronIndexTo, numsyn);
        numneur++;
      }

      // setup all i-neurons for this group
      if (isOutputGroup(gGroupIndexTo)) neuronCountTo = 0; // output/behavior neurons are e-only postsynaptically
      else neuronCountTo = genome.neuronCount(NeuronType.INHIBITORY, gGroupIndexTo);

      for (let neuronLocalIndexTo = 0; neuronLocalIndexTo < neuronCountTo; neuronLocalIndexTo++) {
        const neuronIndexTo = neuronLocalIndexTo + firstineur[groupIndexTo]!;

        this._neuralnet!.setNeuron(neuronIndexTo, attrs, numsyn);

        numsyn = this.growSynapses(
          groupIndexTo,
          neuronCountTo,
          eiremainder,
          neuronLocalIndexTo,
          neuronIndexTo,
          firsteneur,
          numsyn,
          genome.synapseTypeEI,
        );

        numsyn = this.growSynapses(
          groupIndexTo,
          neuronCountTo,
          iiremainder,
          neuronLocalIndexTo,
          neuronIndexTo,
          firstineur,
          numsyn,
          genome.synapseTypeII,
        );

        this._neuralnet!.setNeuronEndSynapses(neuronIndexTo, numsyn);
        numneur++;
      }
    }

    // --- Sanity Checks ---
    if (numneur !== dims.numNeurons) {
      brainError(2, `Bad neural architecture, numneur ( ${numneur} ) not equal to numneurons ( ${dims.numNeurons} )`);
    }

    if (numsyn !== dims.numSynapses) {
      if (brainConfig.synapseFromOutputNeurons && brainConfig.synapseFromInputToOutputNeurons) {
        if (numsyn > dims.numSynapses || (dims.numSynapses - numsyn) / dims.numSynapses > 1.e-3) {
          brainError(2, `Bad neural architecture, numsyn ( ${numsyn} ) not equal to numsynapses ( ${dims.numSynapses} )`);
        }
      }
      dims.numSynapses = numsyn;
    }

    // --- Calculate Energy Use (all float arithmetic, product before division — see PORT-NOTE) ---
    // PORT-NOTE(l6/groups-energy-use-float)
    this._energyUse = energyUseOf(
      brainConfig.maxneuron2energy,
      dims.numNeurons,
      groupsConfig.maxneurons,
      brainConfig.maxsynapse2energy,
      dims.numSynapses,
      groupsConfig.maxsynapses,
    );
  }

  /** Native `GroupsBrain::growSynapses` — returns the updated brain-wide synapse count. */
  private growSynapses(
    groupIndexTo: number,
    neuronCountTo: number,
    remainder: Float32Array,
    neuronLocalIndexTo: number,
    neuronIndexTo: number,
    firstneur: Int32Array,
    synapseCountBrain: number,
    synapseType: GroupsSynapseType,
  ): number {
    const genome = this._genome;
    // native: one `create( role )` per call, per generator — GLOBAL roles are the shared
    // glibc streams, LOCAL roles a fresh MT19937 (see growRng.ts)
    const tdRng: GrowRng = groupsConfig.enableTopologicalDistortionRngSeed
      ? localGrowRng(this.localRole(GrowRngRole.TOPOLOGICAL_DISTORTION))
      : globalGrowRng(this._cns.getRNG());
    const weightRng: GrowRng = groupsConfig.enableInitWeightRngSeed
      ? localGrowRng(this.localRole(GrowRngRole.INIT_WEIGHT))
      : globalGrowRng(this._cns.getRNG());

    let synapseCount_brain = synapseCountBrain;
    const gGroupIndexTo = this.orderedGroups[groupIndexTo]!;

    for (let groupIndexFrom = 0; groupIndexFrom < this._numgroups; groupIndexFrom++) {
      const gGroupIndexFrom = this.orderedGroups[groupIndexFrom]!;
      if (!brainConfig.synapseFromOutputNeurons && genome.groupType(gGroupIndexFrom) === NeurGroupType.OUTPUT) continue;
      if (
        !brainConfig.synapseFromInputToOutputNeurons &&
        genome.groupType(gGroupIndexFrom) === NeurGroupType.INPUT &&
        genome.groupType(gGroupIndexTo) === NeurGroupType.OUTPUT
      ) {
        continue;
      }

      const neuronCountFrom = genome.neuronCount(synapseType.ntFrom, gGroupIndexFrom);
      const synapseCountFromTo = genome.synapseCount(synapseType, gGroupIndexFrom, gGroupIndexTo);

      // native: float nsynjiperneur = float( synapseCount_fromto ) / float( neuronCount_to );
      const nsynjiperneur = nsynjiPerNeuron(synapseCountFromTo, neuronCountTo);
      // native: int synapseCount_new = short( nsynjiperneur + remainder[from] + 1.e-5 );
      // — a FLOAT addition (both operands are float) before the double `1.e-5` promotes it
      // PORT-NOTE(l6/groups-synapse-remainder)
      const synapseCountNew = growSynapseCountNew(nsynjiperneur, remainder[groupIndexFrom]!);
      remainder[groupIndexFrom] = remainderUpdate(remainder[groupIndexFrom]!, nsynjiperneur, synapseCountNew);

      const tdFromTo = genome.synapseGeneValue('TopologicalDistortion', synapseType, gGroupIndexFrom, gGroupIndexTo);

      if (groupsConfig.enableTopologicalDistortionRngSeed) {
        const tdSeed = genome.namedGeneValue('TopologicalDistortionRngSeed', synapseType, gGroupIndexFrom, gGroupIndexTo);
        tdRng.set(tdSeed);
      }
      if (groupsConfig.enableInitWeightRngSeed) {
        const weightSeed = genome.namedGeneValue('InitWeightRngSeed', synapseType, gGroupIndexFrom, gGroupIndexTo);
        weightRng.set(weightSeed);
      }

      // native: int neuronLocalIndex_fromBase = short( (float(local_to)/float(count_to)) *
      //             float(count_from) - float(synapseCount_new) * 0.5 );
      // — the `* 0.5` makes the difference a DOUBLE, which `short(...)` truncates
      let neuronLocalIndexFromBase = growNeuronLocalIndexFromBase(
        neuronLocalIndexTo,
        neuronCountTo,
        neuronCountFrom,
        synapseCountNew,
      );
      if (groupsConfig.mirroredtopologicaldistortion && tdFromTo >= 0.5) {
        neuronLocalIndexFromBase = neuronCountFrom - 1 - neuronLocalIndexFromBase;
      }

      {
        let legal: boolean;
        if (!groupsConfig.mirroredtopologicaldistortion || tdFromTo < 0.5) {
          legal = neuronLocalIndexFromBase + synapseCountNew <= neuronCountFrom;
        } else {
          legal = neuronLocalIndexFromBase - synapseCountNew >= -1;
        }
        if (!legal) {
          brainError(
            2,
            `Illegal architecture generated: more ${synapseType.name} synapses from group ${groupIndexFrom} to group ${groupIndexTo} than there are i-neurons in group ${groupIndexFrom}`,
          );
        }
      }

      const neurused = new Array<boolean>(neuronCountFrom).fill(false);

      for (let isyn = 0; isyn < synapseCountNew; isyn++) {
        let neuronLocalIndexFrom: number;

        if (groupsConfig.mirroredtopologicaldistortion || tdRng.drand() < tdFromTo) {
          let tdFromToAbsValue: number;
          if (groupsConfig.mirroredtopologicaldistortion) {
            if (tdFromTo < 0.5) {
              neuronLocalIndexFrom = neuronLocalIndexFromBase + isyn;
              // native: td_fromto_abs = td_fromto * 2;  (float)
              tdFromToAbsValue = tdFromToAbs(tdFromTo, TdAbsBranch.MIRRORED_LOW);
            } else {
              neuronLocalIndexFrom = neuronLocalIndexFromBase - isyn;
              // native: td_fromto_abs = (1 - td_fromto) * 2;  (float: the `1 -` is a float
              // subtraction, the `* 2` a float product — NOT the double expression)
              tdFromToAbsValue = tdFromToAbs(tdFromTo, TdAbsBranch.MIRRORED_HIGH);
            }
          } else {
            neuronLocalIndexFrom = neuronLocalIndexFromBase + isyn;
            tdFromToAbsValue = tdFromToAbs(tdFromTo, TdAbsBranch.UNMIRRORED);
          }

          // native: short distortion = short( nint( td_rng->range(-0.5,0.5) * td_fromto_abs * neuronCount_from ) );
          // — and `nint(a)` is the macro `(long)((a) + ((a) < 0.0 ? -0.499999999 : 0.499999999))`,
          //   which evaluates `a` TWICE; with an RNG call inside `a` that is two draws on the
          //   stream (`range` first for the sum, then again for the sign test).
          const distortion = distortionIndex(
            tdRng.range(-0.5, 0.5),
            tdRng.range(-0.5, 0.5),
            tdFromToAbsValue,
            neuronCountFrom,
          );
          neuronLocalIndexFrom += distortion;

          if (neuronLocalIndexFrom < 0) neuronLocalIndexFrom += neuronCountFrom;
          else if (neuronLocalIndexFrom >= neuronCountFrom) neuronLocalIndexFrom -= neuronCountFrom;
        } else {
          neuronLocalIndexFrom = isyn + neuronLocalIndexFromBase;
        }

        if (
          neuronLocalIndexFrom + firstneur[groupIndexFrom]! === neuronIndexTo || // same neuron, or
          neurused[neuronLocalIndexFrom]! // already connected to this one
        ) {
          if (
            groupIndexTo === groupIndexFrom && // same group
            (synapseType.ntFrom === synapseType.ntTo || genome.groupType(gGroupIndexTo) === NeurGroupType.OUTPUT)
          ) {
            neuronLocalIndexFrom = this.nearestFreeNeuron(
              neuronLocalIndexFrom,
              neurused,
              neuronCountFrom,
              neuronIndexTo - firstneur[groupIndexFrom]!,
            );
          } else {
            neuronLocalIndexFrom = this.nearestFreeNeuron(neuronLocalIndexFrom, neurused, neuronCountFrom, neuronLocalIndexFrom);
          }
        }

        neurused[neuronLocalIndexFrom] = true;

        const neuronIndexFrom = neuronLocalIndexFrom + firstneur[groupIndexFrom]!;

        // We should never have a self-synapsing neuron.
        if (neuronIndexFrom === neuronIndexTo) throw new Error('GroupsBrain::growSynapses: self-synapsing neuron');

        let efficacy: number;
        if (brainConfig.fixedInitWeight) {
          efficacy = brainConfig.initMaxWeight;
        } else if (brainConfig.gaussianInitWeight) {
          // native: float stdev = _genome->get( WEIGHT_STDEV, … ) * Brain::config.gaussianInitMaxStdev;
          // — a float store (the gene arrives as a float, the config field is a float)
          const stdev = stdevOf(
            genome.synapseGeneValue('WeightStdev', synapseType, gGroupIndexFrom, gGroupIndexTo),
            brainConfig.gaussianInitMaxStdev,
          );
          // native: `efficacy = nrand( 0.0, stdev )` — a double, stored into a float
          efficacy = f32(weightRng.nrandScaled(0.0, stdev));
          if (efficacy < 0.0) efficacy = -efficacy;
          if (efficacy > brainConfig.maxWeight) efficacy = brainConfig.maxWeight;
        } else {
          // native: float efficacy = weight_rng->range( initminweight, Brain::config.initMaxWeight );
          efficacy = f32(weightRng.range(INIT_MIN_WEIGHT, brainConfig.initMaxWeight));
        }
        if (synapseType.ntFrom === NeuronType.INHIBITORY) {
          efficacy = Math.min(f32(-1.e-10), -efficacy);
        }

        let lrate: number;
        if (!brainConfig.enableLearning) {
          lrate = 0;
        } else if (
          !brainConfig.outputSynapseLearning &&
          (genome.groupType(gGroupIndexFrom) === NeurGroupType.OUTPUT ||
            genome.groupType(gGroupIndexTo) === NeurGroupType.OUTPUT)
        ) {
          lrate = 0;
        } else if (brainConfig.minlrate === brainConfig.maxlrate) {
          lrate = brainConfig.minlrate;
          if (synapseType.ntFrom === NeuronType.INHIBITORY) {
            lrate = Math.min(f32(-1.e-10), -lrate);
          }
        } else {
          lrate = genome.synapseGeneValue('LearningRate', synapseType, gGroupIndexFrom, gGroupIndexTo);
        }

        this._neuralnet!.setSynapse(synapseCount_brain, neuronIndexFrom, neuronIndexTo, efficacy, lrate);

        synapseCount_brain++;
      }
    }

    return synapseCount_brain;
  }

  /** Native `create( role )` on a LOCAL role (see `brainRng.ts`). */
  private localRole(role: number) {
    if (!this._rngProvider) {
      throw new Error('GroupsBrain: this run needs a LOCAL RNG role but no rngProvider was injected');
    }
    return this._rngProvider.createLocal(role as 1 | 2);
  }
}
