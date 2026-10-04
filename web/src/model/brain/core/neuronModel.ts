/**
 * Lane L6 (brain core) — `brain/NeuronModel.h`: the neuron-model interface and the
 * `Dimensions` descriptor every model, the brain and the loggers share.
 *
 * PORT-NOTE(l6/dimensions-shared-object): native hands out a `Dimensions *` owned by the
 * brain and read (never copied) by the model and by every logger. The port passes the same
 * mutable object, for the same reason: `GroupsBrain::grow` fixes up `numSynapses` *after*
 * the model has been initialised (`_dims.numSynapses = numsyn`, line 609), and the loggers
 * must see the corrected value.
 *
 * PORT-NOTE(l6/neuron-model-interface): the native virtuals are kept one-for-one (renamed
 * to camelCase, pointer out-params replaced by a returned record) so a reviewer can diff
 * this file against `NeuronModel.h` line by line. `set_neuron( index, void *attributes … )`
 * — the native erases the attribute type through `void *`, with the union chosen by
 * `Brain::config.neuronModel` — becomes a typed parameter per model subclass.
 */

import type { BrainTextFile } from './textFile';

/** Native `NeuronModel::Dimensions`. */
export class Dimensions {
  numNeurons = 0;
  numInputNeurons = 0;
  numOutputNeurons = 0;
  numSynapses = 0;

  /** Native `getFirstInputNeuron()` — always 0. */
  getFirstInputNeuron(): number {
    return 0;
  }

  /** Native `getFirstOutputNeuron()` == `numInputNeurons`. */
  getFirstOutputNeuron(): number {
    return this.numInputNeurons;
  }

  /** Native `getFirstInternalNeuron()` == `numInputNeurons + numOutputNeurons`. */
  getFirstInternalNeuron(): number {
    return this.numInputNeurons + this.numOutputNeurons;
  }

  /** Native `getNumNonInputNeurons()`. */
  getNumNonInputNeurons(): number {
    return this.numNeurons - this.numInputNeurons;
  }
}

/** One synapse as the format-agnostic accessors see it (native out-params of `get_synapse`). */
export interface SynapseRecord {
  fromneuron: number;
  toneuron: number;
  efficacy: number;
  lrate: number;
}

/**
 * Native `FiringRateModel__NeuronAttrs` / `SpikingModel__NeuronAttrs`.
 *
 * PORT-NOTE(l6/neuron-attrs-union): native passes the attribute struct through `void *`
 * read from an anonymous `union` whose member is chosen by `Brain::config.neuronModel`
 * (mis-picking it reads garbage). The port types it as this union and lets each model read
 * its own variant, so the compiler enforces the pairing the native code only assumes.
 */
export interface FiringRateNeuronAttrs {
  bias: number;
  tau: number;
  gain: number;
}

export interface SpikingNeuronAttrs {
  bias: number;
  spikingParameterA: number;
  spikingParameterB: number;
  spikingParameterC: number;
  spikingParameterD: number;
}

export type NeuronAttrs = FiringRateNeuronAttrs | SpikingNeuronAttrs;

/**
 * Native `NeuronModel`.
 *
 * PORT-NOTE(l6/float-arrays): `neuronactivation` / `newneuronactivation` are `double[]` in
 * native (`calloc`'d `double *`), so the port uses `Float64Array`; efficacy/bias/tau/gain are
 * C `float`, so per-neuron and per-synapse state uses `Math.fround` at exactly the
 * assignments native makes (PORT_SPEC rule 3). `Float32Array` is used where native keeps an
 * array of floats (`BaseNeuronModel::dumpAnatomical`'s connection matrix), because a
 * Float32Array store rounds identically to a C `float` store.
 */
export interface NeuronModel {
  init(dims: Dimensions, initialActivation: number): void;

  update(bprint: boolean): void;

  /**
   * Native `set_neuron( index, attributes, startsynapses, endsynapses )`. `startsynapses`
   * and `endsynapses` are optional because the growth paths call it twice: once with only
   * the start (before the synapses are laid down) and once through
   * `set_neuron_endsynapses` afterwards.
   */
  setNeuron(index: number, attrs: NeuronAttrs, startsynapses?: number, endsynapses?: number): void;
  /** Native `set_neuron_endsynapses`. */
  setNeuronEndSynapses(index: number, endsynapses: number): void;

  /** Native `get_synapse`. */
  getSynapse(index: number): SynapseRecord;
  /** Native `set_synapse`. */
  setSynapse(index: number, from: number, to: number, efficacy: number, lrate: number): void;

  getActivations(start: number, count: number): Float64Array;
  setActivations(activations: ArrayLike<number>, start: number, count: number): void;
  randomizeActivations(): void;

  dumpAnatomical(file: BrainTextFile): void;

  startFunctional(file: BrainTextFile): void;
  writeFunctional(file: BrainTextFile): void;

  dumpSynapses(file: BrainTextFile): void;
  loadSynapses(file: BrainTextFile): void;
  copySynapses(other: NeuronModel): void;
  scaleSynapses(factor: number): void;
}
