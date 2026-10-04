/**
 * Lane L6 (brain core) — `brain/BaseNeuronModel.h`: the shared half of the neuron models —
 * activation buffers, the neurons/synapses arrays, the anatomical/functional/synapse dumps,
 * loading, copying and scaling.
 *
 * PORT-NOTE(l6/base-neuron-model-generics): native is a template over
 * `< T_neuron, T_neuronattrs, T_synapse >`; the port is an abstract generic class over the
 * same three type parameters. `set_neuron( index, void *attributes, … )` — the native idiom
 * that erases the attribute struct through `void *` and reinterprets it per model — is kept
 * as an abstract method per model, because a `void *` in TypeScript buys nothing and hides
 * which struct is being read.
 *
 * PORT-NOTE(l6/neuron-calloc): native allocates `neuron`, `synapse`, `neuronactivation` and
 * `newneuronactivation` with `calloc`, so a freshly initialised brain has *zeroed* neuron and
 * synapse structs (including `startsynapses`/`endsynapses` = 0, i.e. "no synapses", which is
 * what `FiringRateModel::update` sees for a neuron that was never wired). The port creates
 * zero-valued records for the same reason.
 *
 * PORT-NOTE(l6/activation-swap): the two activation arrays live in one
 * `ActivationBuffers` record whose *fields* the models swap; every nerve holds that record
 * (see `nerve.ts`). Native swaps two `double *` members and every holder follows.
 */

import { f32 } from './nativeMath';
import { sprintfC } from './cformat';
import type { ActivationBuffers } from './nerve';
import { Dimensions, type NeuronAttrs, type NeuronModel, type SynapseRecord } from './neuronModel';
import type { NervousSystem } from './nervousSystem';
import type { BrainTextFile } from './textFile';
import { brainConfig } from './brain';

/** The fields every neuron struct has (native `X__Neuron` first members). */
export interface NeuronState {
  bias: number;
  startsynapses: number;
  endsynapses: number;
}

/** The fields every synapse struct has (native `X__Synapse`). */
export interface SynapseState {
  fromneuron: number;
  toneuron: number;
  efficacy: number;
  lrate: number;
}

export abstract class BaseNeuronModel<TNeuron extends NeuronState, TSynapse extends SynapseState> implements NeuronModel {
  protected readonly cns: NervousSystem;
  protected dims = new Dimensions();
  protected neuron: TNeuron[] = [];
  protected synapse: TSynapse[] = [];
  protected buffers: ActivationBuffers = { current: new Float64Array(0), swap: new Float64Array(0) };

  constructor(cns: NervousSystem) {
    this.cns = cns;
  }

  /** Native `init_derived` — the per-model part of `init`. */
  protected abstract initDerived(initialActivation: number): void;

  /** A zero-valued neuron struct (native `calloc`). */
  protected abstract createNeuron(): TNeuron;

  /** A zero-valued synapse struct (native `calloc`). */
  protected abstract createSynapse(): TSynapse;

  /** Native `set_neuron` — the model adds its own attribute fields to the shared base. */
  abstract setNeuron(index: number, attrs: NeuronAttrs, startsynapses?: number, endsynapses?: number): void;

  abstract update(bprint: boolean): void;

  /** Native `init`. */
  init(dims: Dimensions, initialActivation: number): void {
    this.dims = dims;
    this.neuron = new Array<TNeuron>(dims.numNeurons);
    for (let i = 0; i < dims.numNeurons; i++) this.neuron[i] = this.createNeuron();
    this.synapse = new Array<TSynapse>(dims.numSynapses);
    for (let i = 0; i < dims.numSynapses; i++) this.synapse[i] = this.createSynapse();

    this.buffers = {
      current: new Float64Array(dims.numNeurons),
      swap: new Float64Array(dims.numNeurons),
    };

    // Native hands each nerve the address of the activation pointers so it follows the swap.
    for (const nerve of this.cns.getNerves()) nerve.configBuffers(this.buffers);

    this.initDerived(initialActivation);
  }

  /** Native `set_neuron`, shared part. */
  protected assignNeuronBase(neuron: TNeuron, bias: number, startsynapses: number, endsynapses: number): void {
    if (Number.isNaN(bias)) throw new Error('BaseNeuronModel::set_neuron: bias is NaN');
    neuron.bias = f32(bias);
    neuron.startsynapses = startsynapses;
    neuron.endsynapses = endsynapses;
  }

  /** Native `set_neuron_endsynapses`. */
  setNeuronEndSynapses(index: number, endsynapses: number): void {
    this.neuron[index]!.endsynapses = endsynapses;
  }

  /** Native `get_synapse`. */
  getSynapse(index: number): SynapseRecord {
    const s = this.synapse[index]!;
    return { fromneuron: s.fromneuron, toneuron: s.toneuron, efficacy: s.efficacy, lrate: s.lrate };
  }

  /** Native `set_synapse`. */
  setSynapse(index: number, from: number, to: number, efficacy: number, lrate: number): void {
    const s = this.synapse[index]!;
    if (Number.isNaN(efficacy)) throw new Error('BaseNeuronModel::set_synapse: efficacy is NaN');
    if (Number.isNaN(lrate)) throw new Error('BaseNeuronModel::set_synapse: lrate is NaN');
    s.fromneuron = from;
    s.toneuron = to;
    s.efficacy = f32(efficacy);
    s.lrate = f32(lrate);
  }

  /** Native `getActivations`. */
  getActivations(start: number, count: number): Float64Array {
    return this.buffers.current.slice(start, start + count);
  }

  /** Native `setActivations`. */
  setActivations(activations: ArrayLike<number>, start: number, count: number): void {
    for (let i = 0; i < count; i++) this.buffers.current[start + i] = activations[i]!;
  }

  /** Native `randomizeActivations` — `randpw()` per neuron, i.e. the GLOBAL drand48 stream. */
  randomizeActivations(): void {
    const rng = this.cns.getRNG();
    for (let i = 0; i < this.dims.numNeurons; i++) this.buffers.current[i] = rng.drand48();
  }

  /**
   * Native `dumpAnatomical` — the (numNeurons+1)² connection matrix, presynaptic neurons in
   * the columns (bias is the last column), written as `%+06.4f` scaled by
   * `1 / max( maxWeight, maxbias )`.
   */
  dumpAnatomical(file: BrainTextFile): void {
    const numNeurons = this.dims.numNeurons;
    // native `float maxWeight = max( Brain::config.maxWeight, Brain::config.maxbias )`
    const maxWeight = Math.max(brainConfig.maxWeight, brainConfig.maxbias);
    const inverseMaxWeight = 1.0 / maxWeight;

    const dimCM = (numNeurons + 1) * (numNeurons + 1);
    const connectionMatrix = new Float32Array(dimCM);

    // columns correspond to presynaptic "from-neurons", rows to postsynaptic "to-neurons"
    for (let s = 0; s < this.dims.numSynapses; s++) {
      const syn = this.synapse[s]!;
      const cmIndex = Math.abs(syn.fromneuron) + Math.abs(syn.toneuron) * (numNeurons + 1);
      // the += is so parallel excitatory and inhibitory connections from input and output
      // neurons just sum together
      connectionMatrix[cmIndex] = connectionMatrix[cmIndex]! + syn.efficacy;
    }

    // fill in the biases
    for (let i = 0; i < numNeurons; i++) {
      const cmIndex = numNeurons + i * (numNeurons + 1);
      connectionMatrix[cmIndex] = this.neuron[i]!.bias;
    }

    // print the network architecture
    for (let i = 0; i <= numNeurons; i++) {
      for (let j = 0; j <= numNeurons; j++) {
        file.printf('%+06.4f ', connectionMatrix[j + i * (numNeurons + 1)]! * inverseMaxWeight);
      }
      file.printf(';\n');
    }
  }

  /** Native `startFunctional` — the model's part of the functional header. */
  startFunctional(file: BrainTextFile): void {
    file.printf(
      ' %d %d %d %ld',
      this.dims.numNeurons,
      this.dims.numInputNeurons,
      this.dims.numOutputNeurons,
      this.dims.numSynapses,
    );
  }

  /** Native `writeFunctional` — one `"%d %g"` row per neuron, in index order. */
  writeFunctional(file: BrainTextFile): void {
    for (let i = 0; i < this.dims.numNeurons; i++) {
      file.printf('%d %g\n', i, this.buffers.current[i]!);
    }
  }

  /** Native `dumpSynapses`. */
  dumpSynapses(file: BrainTextFile): void {
    for (let i = 0; i < this.dims.numSynapses; i++) {
      const s = this.synapse[i]!;
      file.printf('%hd %hd %g %g\n', s.fromneuron, s.toneuron, s.efficacy, s.lrate);
    }
  }

  /** Native `setSynapses` — re-derives every neuron's synapse range from the from-neuron order. */
  protected setSynapses(newsynapse: TSynapse[]): void {
    let prevtoneuron = -1;
    for (let i = 0; i < this.dims.numSynapses; i++) {
      const s = newsynapse[i]!;
      this.setSynapse(i, s.fromneuron, s.toneuron, s.efficacy, s.lrate);
      if (s.toneuron !== prevtoneuron) {
        this.neuron[s.toneuron]!.startsynapses = i;
      }
      this.neuron[s.toneuron]!.endsynapses = i + 1;
      prevtoneuron = s.toneuron;
    }
  }

  /** Native `loadSynapses`. */
  loadSynapses(file: BrainTextFile): void {
    const newsynapse: TSynapse[] = [];
    for (let i = 0; i < this.dims.numSynapses; i++) {
      const s = this.createSynapse();
      const read = file.scanf('%hd %hd %g %g');
      if (read.count !== 4) throw new Error(`BaseNeuronModel::loadSynapses: row ${i} assigned ${read.count} fields`);
      s.fromneuron = read.items[0]!;
      s.toneuron = read.items[1]!;
      s.efficacy = f32(read.items[2]!);
      s.lrate = f32(read.items[3]!);
      newsynapse.push(s);
    }
    this.setSynapses(newsynapse);
  }

  /** Native `copySynapses`. */
  copySynapses(other: NeuronModel): void {
    const newsynapse: TSynapse[] = [];
    for (let i = 0; i < this.dims.numSynapses; i++) {
      const s = this.createSynapse();
      const record = other.getSynapse(i);
      s.fromneuron = record.fromneuron;
      s.toneuron = record.toneuron;
      s.efficacy = record.efficacy;
      s.lrate = record.lrate;
      newsynapse.push(s);
    }
    this.setSynapses(newsynapse);
  }

  /** Native `scaleSynapses` — `s.efficacy *= factor`, both C `float`. */
  scaleSynapses(factor: number): void {
    // the C parameter is a `float`, so a binary64 argument is narrowed at this boundary the way
    // the ABI narrows it; the product of two floats is exact in binary64, so the one `f32` on
    // the store is exactly one rounding (native's `fmul`)
    const f = f32(factor);
    for (let i = 0; i < this.dims.numSynapses; i++) {
      const s = this.synapse[i]!;
      s.efficacy = f32(s.efficacy * f);
    }
  }

  /** Convenience for the renderer lane and the harness: the raw arrays native exposes. */
  rawState(): { neuron: readonly TNeuron[]; synapse: readonly TSynapse[]; buffers: ActivationBuffers } {
    return { neuron: this.neuron, synapse: this.synapse, buffers: this.buffers };
  }

  describe(): string {
    return sprintfC('%d neurons, %ld synapses', this.dims.numNeurons, this.dims.numSynapses);
  }
}
