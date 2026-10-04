/**
 * Lane L6 (brain core) — `brain/Brain.h/.cc`: the brain base class, its worldfile-derived
 * configuration, the prebirth cycle, and the anatomical / functional / synapse dumps whose
 * bytes are the lane's oracle (`run/brain/anatomy/**`, `run/brain/function/**`,
 * `run/brain/synapses/**`).
 *
 * PORT-NOTE(l6/brain-config-singleton): native `Brain::config` is a process-wide `struct`
 * filled from the worldfile by the static `processWorldfile` and then *mutated* by
 * `Brain::init`/`GroupsBrain::init` (the derived `retinaWidth`, the group counts). The port
 * keeps one exported mutable object (`brainConfig`) for the same reason W1a's `globals` is a
 * singleton: the values are read from models, loggers and the agent lane, and a per-instance
 * copy would let two of them disagree. `Brain.config` is the same object.
 *
 * PORT-NOTE(l6/prebirth-order): `prebirth()` is `numPrebirthCycles` × (`prebirthSignal()`
 * then `update(false)`). Both halves consume the GLOBAL RNG (`prebirthSignal` through the
 * sensors' `sensor_prebirth_signal`, `update` through the spiking model's per-brain-step
 * draws) and the synapse/weight learning in `update` is applied unless the brain is frozen.
 * The count is a worldfile value (`PreBirthCycles`, 25 in the recorded scenarios), so this
 * loop decides every recorded brain's initial efficacies — it is not an optimisation.
 *
 * PORT-NOTE(l6/dump-formats): the three dumps reproduce their native `printf` format strings
 * verbatim, because the oracle compares those bytes. `dumpAnatomical` builds the
 * (numNeurons+1)² connection matrix with `+=` into a C `float` array (excitatory and
 * inhibitory connections between the same pair sum, and the bias column is *assigned*, not
 * accumulated) and scales by `1 / max(maxWeight, maxbias)`; `synapses` rows are
 * `"%hd %hd %g %g"`. See `cformat.ts` for the `%g`/`%hd` semantics.
 */

import { Dimensions, type NeuronModel } from './neuronModel';
import type { NervousSystem } from './nervousSystem';
import type { NeuralNetRenderer } from './neuralNetRenderer';
import { sprintfC } from './cformat';
import { f32 } from './nativeMath';
import type { BrainTextFile } from './textFile';
import type { Mt19937Stream, RngRole } from '../../types';
import type { BrainRngProvider } from './brainRng';

/** Native `Brain::Configuration::architecture`. */
export const BrainArchitecture = { Groups: 0, Sheets: 1 } as const;
export type BrainArchitecture = (typeof BrainArchitecture)[keyof typeof BrainArchitecture];

/** Native `Brain::Configuration::neuronModel`. */
export const NeuronModelKind = { FIRING_RATE: 0, TAU_GAIN: 1, SPIKING: 2 } as const;
export type NeuronModelKind = (typeof NeuronModelKind)[keyof typeof NeuronModelKind];

/** Native `Brain::Configuration::learningMode`. */
export const LearningMode = { LEARN_NONE: 0, LEARN_PREBIRTH: 1, LEARN_ALL: 2 } as const;
export type LearningMode = (typeof LearningMode)[keyof typeof LearningMode];

interface Range {
  minVal: number;
  maxVal: number;
  seedVal: number;
}

export interface BrainConfig {
  architecture: BrainArchitecture;
  neuronModel: NeuronModelKind;
  learningMode: LearningMode;
  Tau: Range;
  Gain: Range;
  Spiking: {
    enableGenes: boolean;
    aMinVal: number;
    aMaxVal: number;
    bMinVal: number;
    bMaxVal: number;
    cMinVal: number;
    cMaxVal: number;
    dMinVal: number;
    dMaxVal: number;
  };
  maxbias: number;
  outputSynapseLearning: boolean;
  synapseFromOutputNeurons: boolean;
  synapseFromInputToOutputNeurons: boolean;
  numPrebirthCycles: number;
  logisticSlope: number;
  fixedInitWeight: boolean;
  gaussianInitWeight: boolean;
  gaussianInitMaxStdev: number;
  maxWeight: number;
  initMaxWeight: number;
  enableLearning: boolean;
  minlrate: number;
  maxlrate: number;
  decayRate: number;
  /** Native `minWin` — the worldfile's `RetinaWidth`, before `init()` widens it. */
  minWin: number;
  retinaWidth: number;
  retinaHeight: number;
  maxsynapse2energy: number;
  maxneuron2energy: number;
}

/** One mutable process-wide brain configuration, like native's `Brain::config`. */
export const brainConfig: BrainConfig = {
  architecture: BrainArchitecture.Groups,
  neuronModel: NeuronModelKind.FIRING_RATE,
  learningMode: LearningMode.LEARN_NONE,
  Tau: { minVal: 0, maxVal: 0, seedVal: 0 },
  Gain: { minVal: 0, maxVal: 0, seedVal: 0 },
  Spiking: {
    enableGenes: false,
    aMinVal: 0,
    aMaxVal: 0,
    bMinVal: 0,
    bMaxVal: 0,
    cMinVal: 0,
    cMaxVal: 0,
    dMinVal: 0,
    dMaxVal: 0,
  },
  maxbias: 0,
  outputSynapseLearning: false,
  synapseFromOutputNeurons: false,
  synapseFromInputToOutputNeurons: false,
  numPrebirthCycles: 0,
  logisticSlope: 0,
  fixedInitWeight: false,
  gaussianInitWeight: false,
  gaussianInitMaxStdev: 0,
  maxWeight: 0,
  initMaxWeight: 0,
  enableLearning: false,
  minlrate: 0,
  maxlrate: 0,
  decayRate: 0,
  minWin: 0,
  retinaWidth: 0,
  retinaHeight: 0,
  maxsynapse2energy: 0,
  maxneuron2energy: 0,
};

/** The worldfile reader the static `processWorldfile`s take (W1a's `Config`). */
export interface WorldfileReader {
  getString(id: string): string;
  getInt(id: string): number;
  getFloat(id: string): number;
  getBool(id: string): boolean;
  at(...path: readonly string[]): WorldfileReader;
}

export class Brain {
  static readonly config: BrainConfig = brainConfig;

  protected readonly _cns: NervousSystem;
  protected readonly _dims: Dimensions = new Dimensions();
  protected _neuralnet: NeuronModel | null = null;
  protected _renderer: NeuralNetRenderer | null = null;
  protected _energyUse = 0;
  protected _frozen = false;

  constructor(cns: NervousSystem) {
    this._cns = cns;
  }

  // -------------------------------------------------------------------------
  // configuration
  // -------------------------------------------------------------------------

  /** Native `Brain::processWorldfile`. */
  static processWorldfile(doc: WorldfileReader): void {
    {
      const val = doc.getString('BrainArchitecture');
      if (val === 'Groups') brainConfig.architecture = BrainArchitecture.Groups;
      else if (val === 'Sheets') brainConfig.architecture = BrainArchitecture.Sheets;
      else throw new Error(`Brain: unknown BrainArchitecture '${val}'`);
    }
    {
      const val = doc.getString('NeuronModel');
      if (val === 'F') brainConfig.neuronModel = NeuronModelKind.FIRING_RATE;
      else if (val === 'T') brainConfig.neuronModel = NeuronModelKind.TAU_GAIN;
      else if (val === 'S') brainConfig.neuronModel = NeuronModelKind.SPIKING;
      else throw new Error(`Brain: unknown NeuronModel '${val}'`);
    }
    {
      const val = doc.getString('LearningMode');
      if (val === 'None') brainConfig.learningMode = LearningMode.LEARN_NONE;
      else if (val === 'Prebirth') brainConfig.learningMode = LearningMode.LEARN_PREBIRTH;
      else if (val === 'All') brainConfig.learningMode = LearningMode.LEARN_ALL;
      else throw new Error(`Brain: unknown LearningMode '${val}'`);
    }

    brainConfig.Spiking.enableGenes = doc.getBool('EnableSpikingGenes');
    brainConfig.Spiking.aMinVal = doc.getFloat('SpikingAMin');
    brainConfig.Spiking.aMaxVal = doc.getFloat('SpikingAMax');
    brainConfig.Spiking.bMinVal = doc.getFloat('SpikingBMin');
    brainConfig.Spiking.bMaxVal = doc.getFloat('SpikingBMax');
    brainConfig.Spiking.cMinVal = doc.getFloat('SpikingCMin');
    brainConfig.Spiking.cMaxVal = doc.getFloat('SpikingCMax');
    brainConfig.Spiking.dMinVal = doc.getFloat('SpikingDMin');
    brainConfig.Spiking.dMaxVal = doc.getFloat('SpikingDMax');

    brainConfig.Tau.minVal = doc.getFloat('TauMin');
    brainConfig.Tau.maxVal = doc.getFloat('TauMax');
    brainConfig.Tau.seedVal = doc.getFloat('TauSeed');

    brainConfig.Gain.minVal = doc.getFloat('GainMin');
    brainConfig.Gain.maxVal = doc.getFloat('GainMax');
    brainConfig.Gain.seedVal = doc.getFloat('GainSeed');

    brainConfig.maxbias = doc.getFloat('MaxBiasWeight');
    brainConfig.maxneuron2energy = doc.getFloat('EnergyUseNeurons');
    brainConfig.outputSynapseLearning = doc.getBool('OutputSynapseLearning');
    brainConfig.synapseFromOutputNeurons = doc.getBool('SynapseFromOutputNeurons');
    brainConfig.synapseFromInputToOutputNeurons = doc.getBool('SynapseFromInputToOutputNeurons');
    brainConfig.numPrebirthCycles = doc.getInt('PreBirthCycles');

    brainConfig.logisticSlope = doc.getFloat('LogisticSlope');
    brainConfig.fixedInitWeight = doc.getBool('FixedInitSynapseWeight');
    brainConfig.gaussianInitWeight = doc.getBool('GaussianInitSynapseWeight');
    brainConfig.gaussianInitMaxStdev = doc.getFloat('GaussianInitSynapseWeightMaxStdev');
    brainConfig.maxWeight = doc.getFloat('MaxSynapseWeight');
    brainConfig.initMaxWeight = doc.getFloat('MaxSynapseWeightInitial');

    brainConfig.enableLearning = brainConfig.learningMode !== LearningMode.LEARN_NONE;
    brainConfig.minlrate = doc.getFloat('MinLearningRate');
    brainConfig.maxlrate = doc.getFloat('MaxLearningRate');

    brainConfig.maxsynapse2energy = doc.getFloat('EnergyUseSynapses');
    brainConfig.decayRate = doc.getFloat('SynapseWeightDecayRate');

    brainConfig.minWin = doc.getInt('RetinaWidth');

    // The architecture-specific halves of the worldfile read (GroupsBrain::processWorldfile,
    // SheetsBrain::processWorldfile) are called by their own modules; see brain/index.ts.
  }

  /**
   * Native `Brain::init`. `max` is computed in C on two `short`s and the result stored back
   * into a `short`, so the port keeps the odd-row widening rule exactly (both dimensions end
   * up even).
   */
  static init(maxvisneurpergroup: number): void {
    brainConfig.retinaWidth = Math.max(brainConfig.minWin, maxvisneurpergroup);
    if (brainConfig.retinaWidth & 1) brainConfig.retinaWidth++;

    brainConfig.retinaHeight = brainConfig.minWin;
    if (brainConfig.retinaHeight & 1) brainConfig.retinaHeight++;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /** Native `Brain::prebirth`. */
  prebirth(): void {
    for (let i = 0; i < brainConfig.numPrebirthCycles; i++) {
      this._cns.prebirthSignal();
      this.update(false);
    }
  }

  /** Native `Brain::update`. */
  update(bprint: boolean): void {
    this.requireNet().update(bprint);
  }

  getRenderer(): NeuralNetRenderer | null {
    return this._renderer;
  }

  /** Native `Brain::getNeuronModel`. */
  getNeuronModel(): NeuronModel {
    return this.requireNet();
  }

  /**
   * Native `getDimensions()` returns a `Dimensions` *by value*; the port hands back the
   * shared object (PORT-NOTE(l6/dimensions-shared-object)).
   */
  getDimensions(): Dimensions {
    return this._dims;
  }

  getNumNeurons(): number {
    return this._dims.numNeurons;
  }

  getNumSynapses(): number {
    return this._dims.numSynapses;
  }

  getEnergyUse(): number {
    return this._energyUse;
  }

  isFrozen(): boolean {
    return this._frozen;
  }

  freeze(): void {
    this._frozen = true;
  }

  unfreeze(): void {
    this._frozen = false;
  }

  getActivations(start: number, count: number): Float64Array {
    return this.requireNet().getActivations(start, count);
  }

  setActivations(activations: ArrayLike<number>, start: number, count: number): void {
    this.requireNet().setActivations(activations, start, count);
  }

  randomizeActivations(): void {
    this.requireNet().randomizeActivations();
  }

  /** The nervous system this brain is wired into (native `_cns`, protected, used by L7/L12). */
  getCns(): NervousSystem {
    return this._cns;
  }

  protected requireNet(): NeuronModel {
    if (!this._neuralnet) throw new Error('Brain: no neural net (grow() was never called)');
    return this._neuralnet;
  }

  // -------------------------------------------------------------------------
  // recording / loading
  // -------------------------------------------------------------------------

  /** Native `Brain::dumpAnatomical`. */
  dumpAnatomical(file: BrainTextFile, index: number, fitness: number): void {
    file.printf(
      'brain %ld fitness=%g numneurons+1=%d maxWeight=%g maxBias=%g',
      index,
      fitness,
      this._dims.numNeurons + 1,
      brainConfig.maxWeight,
      brainConfig.maxbias,
    );

    this._cns.dumpAnatomical(file);
    file.printf('\n');

    this.requireNet().dumpAnatomical(file);
  }

  /** Native `Brain::startFunctional`. */
  startFunctional(file: BrainTextFile, index: number, step: number): void {
    file.printf('version 1\n');

    file.printf('brainFunction %ld', index);

    this.requireNet().startFunctional(file);

    file.printf(' %ld', step);

    this._cns.startFunctional(file);

    file.printf('\n');
  }

  /** Native `Brain::endFunctional`. */
  endFunctional(file: BrainTextFile, fitness: number): void {
    file.printf('end fitness = %g\n', fitness);
  }

  /** Native `Brain::writeFunctional`. */
  writeFunctional(file: BrainTextFile): void {
    this.requireNet().writeFunctional(file);
  }

  /** Native `Brain::dumpSynapses`. */
  dumpSynapses(file: BrainTextFile, index: number): void {
    const dims = this._dims;
    file.printf(
      'synapses %ld maxweight=%g numsynapses=%ld numneurons=%d numinputneurons=%d numoutputneurons=%d\n',
      index,
      brainConfig.maxWeight,
      dims.numSynapses,
      dims.numNeurons,
      dims.numInputNeurons,
      dims.numOutputNeurons,
    );
    this.requireNet().dumpSynapses(file);
  }

  /**
   * Native `Brain::loadSynapses`. Returns the header fields native asserts against the
   * model's own dimensions (so callers/tests can see them); the asserts themselves are
   * reproduced.
   *
   * PORT-NOTE(l6/loadsynapses-float-header): native reads the header's `maxweight=%g` into a
   * `float fileMaxWeight` and rescales with `maxWeight / fileMaxWeight` — a `float` argument
   * over that `float`, one rounding. The port keeps `%g`'s own value (`read.items[1]` is the
   * binary64 `strtod` result) nowhere: both the field and the argument are narrowed, and the
   * quotient is stored as a single, or the rescale lands ~1 ulp away from the shipped model's
   * (`brainprobe synapses` measures it — see `tests/brain-core.test.ts`, which separates the
   * binary64 form on 78/336 and 94/336 rows).
   */
  loadSynapses(
    file: BrainTextFile,
    maxWeight = -1.0,
  ): { index: number; fileMaxWeight: number; header: number[] } {
    const dims = this._dims;
    const read = file.scanf(
      'synapses %ld maxweight=%g numsynapses=%ld numneurons=%d numinputneurons=%d numoutputneurons=%d\n',
    );
    const [index, rawFileMaxWeight, numSynapses, numNeurons, numInputNeurons, numOutputNeurons] = read.items;
    if (read.count !== 6) {
      throw new Error(`Brain::loadSynapses: scanf assigned ${read.count} fields, expected 6`);
    }
    const fileMaxWeight = f32(rawFileMaxWeight!);
    const floatMaxWeight = f32(maxWeight);
    if (numSynapses !== dims.numSynapses) throw new Error(`Brain::loadSynapses: numSynapses ${numSynapses} != ${dims.numSynapses}`);
    if (numNeurons !== dims.numNeurons) throw new Error(`Brain::loadSynapses: numNeurons ${numNeurons} != ${dims.numNeurons}`);
    if (numInputNeurons !== dims.numInputNeurons) {
      throw new Error(`Brain::loadSynapses: numInputNeurons ${numInputNeurons} != ${dims.numInputNeurons}`);
    }
    if (numOutputNeurons !== dims.numOutputNeurons) {
      throw new Error(`Brain::loadSynapses: numOutputNeurons ${numOutputNeurons} != ${dims.numOutputNeurons}`);
    }

    this.requireNet().loadSynapses(file);
    if (floatMaxWeight >= 0.0) {
      this.requireNet().scaleSynapses(f32(floatMaxWeight / fileMaxWeight));
    }

    return {
      index: index!,
      fileMaxWeight,
      header: [numSynapses!, numNeurons!, numInputNeurons!, numOutputNeurons!],
    };
  }

  /** Native `Brain::copySynapses`. */
  copySynapses(other: Brain): void {
    const a = this._dims;
    const b = other._dims;
    if (b.numSynapses !== a.numSynapses) throw new Error('Brain::copySynapses: numSynapses differs');
    if (b.numNeurons !== a.numNeurons) throw new Error('Brain::copySynapses: numNeurons differs');
    if (b.numInputNeurons !== a.numInputNeurons) throw new Error('Brain::copySynapses: numInputNeurons differs');
    if (b.numOutputNeurons !== a.numOutputNeurons) throw new Error('Brain::copySynapses: numOutputNeurons differs');
    this.requireNet().copySynapses(other.requireNet());
  }

  /** Debug helper the differential harness uses to name a brain in its output. */
  describe(): string {
    return sprintfC('%d neurons, %ld synapses', this._dims.numNeurons, this._dims.numSynapses);
  }
}

/** Re-exported so the RNG-shaped call sites of this file read like the native ones. */
export type { BrainRngProvider, Mt19937Stream, RngRole };
