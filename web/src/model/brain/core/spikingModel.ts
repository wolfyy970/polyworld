/**
 * Lane L6 (brain core) — `brain/SpikingModel.{h,cc}`: Izhikevich spiking cells driven at
 * `BrainStepsPerWorldStep` = 50 brain steps per world step, plus the STDP learning rule.
 *
 * The model is not exercised by the recorded scenarios (`NeuronModel F`), which is exactly
 * why it is worth porting carefully: nothing in the oracle would catch a mistake. The
 * differential harness runs it against the oracle's own `SpikingModel` instead (see
 * `native/brainprobe.cc`), including the `drand48` draws that decide input spikes, so the
 * port is verified even though no scenario uses it.
 *
 * PORT-NOTE(l6/spiking-buffer-swap): the brain-step loop swaps the activation pointers *every*
 * brain step (native lines 323-325). `BrainStepsPerWorldStep` (50) is even, so when the loop
 * exits the members point where they started and the results of the last brain step are in
 * `neuronactivation` — which is where the smoothed output firing rates are then written. The
 * port swaps the fields of the shared buffer record on the same statement, so the sensors and
 * nerves see the same array native does at every point (and an odd `BrainStepsPerWorldStep`
 * would reproduce native's losing-the-last-step quirk rather than silently fixing it).
 *
 * PORT-NOTE(l6/spiking-dead-debug): native allocates an `unsigned char
 * spikeMatrix[numNeurons][BrainStepsPerWorldStep]` purely for a `FILE *fHandle` debug dump
 * that is unconditionally NULL (`fHandle` is never assigned), and a `static long
 * loop_counter` that is only incremented. Both are omitted; they cannot affect any output.
 *
 * PORT-NOTE(l6/spiking-uninitialised-stack): the native locals are stack arrays
 * (`inputFiringProbability`, `NeuronFiringCounter`, `outputNeuronFiringCounter`,
 * `synapsesToDepress`, `currentActivationLevel`). Every one of them is fully written before
 * it is read on every path, so the port initialises them to zero and gains nothing but
 * defined behaviour where native is merely lucky.
 *
 * PORT-NOTE(l6/spiking-rng): each brain step draws one `drand()` per input neuron (a spike
 * coin) and one per non-input neuron when `USE_BIAS` is on (it is: `#define USE_BIAS true`),
 * in neuron-index order — so 50 × (numInputNeurons + numNonInputNeurons) draws per world
 * step from the GLOBAL drand48 stream. The bias coin uses the *pre-call* value of
 * `neuron[i].bias` through `1/(1+exp(-bias*.5))`. Getting the draw count or the order wrong
 * shifts every subsequent draw in the simulation.
 */

import { BaseNeuronModel, type NeuronState, type SynapseState } from './baseNeuronModel';
import { brainConfig, NeuronModelKind } from './brain';
import { f32, fma64 } from './nativeMath';
import { f32Fma } from '../../agent/numeric';
import { exp } from '../../rng/libm';
import type { NeuronAttrs, SpikingNeuronAttrs } from './neuronModel';
import type { NervousSystem } from './nervousSystem';

/** Native `SpikingModel.h` constants. */
export const SpikingActivation = 25.0;
export const BIAS_INJECTED_VOLTAGE = 208.0;
export const STDP_RESET = 0.1;
export const STDP_DEGRADATION_SCALER = 0.95;
export const BrainStepsPerWorldStep = 50;
export const USE_BIAS = true;

/** Native `SpikingModel__Neuron`. */
export interface SpikingNeuron extends NeuronState {
  /** Native `bias` is a C `float`. */
  group: number;
  v: number;
  u: number;
  /** C `float`. */
  stdp: number;
  maxfiringcount: number;
  spikingParameterA: number;
  spikingParameterB: number;
  spikingParameterC: number;
  spikingParameterD: number;
}

/** Native `SpikingModel__Synapse` — adds the Izhikevich `delta` accumulator. */
export interface SpikingSynapse extends SynapseState {
  /** C `float`. */
  delta: number;
}

export class SpikingModel extends BaseNeuronModel<SpikingNeuron, SpikingSynapse> {
  private readonly scaleLatestSpikes: number;
  private outputActivation: Float64Array = new Float64Array(0);

  constructor(cns: NervousSystem, scaleLatestSpikes: number) {
    super(cns);
    // native: `float scale_latest_spikes` — already a float at the genome's `get()`
    this.scaleLatestSpikes = f32(scaleLatestSpikes);
  }

  protected createNeuron(): SpikingNeuron {
    return {
      bias: 0,
      group: 0,
      startsynapses: 0,
      endsynapses: 0,
      v: 0,
      u: 0,
      stdp: 0,
      maxfiringcount: 0,
      spikingParameterA: 0,
      spikingParameterB: 0,
      spikingParameterC: 0,
      spikingParameterD: 0,
    };
  }

  protected createSynapse(): SpikingSynapse {
    return { fromneuron: 0, toneuron: 0, efficacy: 0, lrate: 0, delta: 0 };
  }

  /** Native `init_derived` — `initial_activation` is ignored for backwards compatibility. */
  protected initDerived(_initialActivation: number): void {
    this.outputActivation = new Float64Array(this.dims.numOutputNeurons);

    for (let i = 0; i < this.dims.numNeurons; i++) this.buffers.current[i] = SpikingActivation;
    for (let i = 0; i < this.dims.numOutputNeurons; i++) this.outputActivation[i] = 0.0;
  }

  /** Native `SpikingModel::set_neuron`. */
  setNeuron(index: number, attrs: NeuronAttrs, startsynapses = -1, endsynapses = -1): void {
    const spiking = attrs as SpikingNeuronAttrs;
    const neuron = this.neuron[index]!;
    this.assignNeuronBase(neuron, spiking.bias, startsynapses, endsynapses);
    neuron.spikingParameterA = spiking.spikingParameterA;
    neuron.spikingParameterB = spiking.spikingParameterB;
    neuron.spikingParameterC = spiking.spikingParameterC;
    neuron.spikingParameterD = spiking.spikingParameterD;
    neuron.v = -70;
    neuron.u = -14;
    neuron.maxfiringcount = 1;
  }

  /** Native `SpikingModel::update`. */
  update(_bprint: boolean): void {
    if (this.neuron.length === 0) return;

    const dims = this.dims;
    const buf = this.buffers;
    const rng = this.cns.getRNG();
    const brain = this.cns.getBrain();
    if (brain === null) {
      throw new Error('SpikingModel::update: the nervous system has no brain (native would dereference a null `Brain *`)');
    }

    const numNeurons = dims.numNeurons;
    const numInputNeurons = dims.numInputNeurons;
    const numOutputNeurons = dims.numOutputNeurons;
    const firstOutput = dims.getFirstOutputNeuron();
    const firstInternal = dims.getFirstInternalNeuron();

    const inputFiringProbability = new Float32Array(numInputNeurons); // native: float[]
    const outputNeuronFiringCounter = new Int32Array(numOutputNeurons); // native: int[]
    const neuronFiringCounter = new Int32Array(numNeurons); // native: short[]
    const synapsesToDepress = new Float64Array(dims.numSynapses); // native: long[]

    for (let i = 0; i < numNeurons; i++) neuronFiringCounter[i] = 0;

    // Output neurons have connections to other neurons, so their activation has to adhere to
    // SpikingActivation during the brain steps; their firing *rates* are reconstructed below.
    for (let i = 0; i < numOutputNeurons; i++) {
      outputNeuronFiringCounter[i] = 0;
      const neuron = this.neuron[i + firstOutput]!;
      buf.current[i + firstOutput] = neuron.v >= 30 ? SpikingActivation : 0;
    }

    for (let i = 0; i < numInputNeurons; i++) {
      inputFiringProbability[i] = buf.current[i]!;
      buf.current[i] = 0;
    }

    let numSynapsesToDepress = 0;
    let startSynapsesToDepress = 0;

    for (let nSteps = 0; nSteps < BrainStepsPerWorldStep; nSteps++) {
      numSynapsesToDepress = 0;
      startSynapsesToDepress = 0;

      // --- input neurons: stochastic firing from the sensor-supplied probability ---
      for (let i = 0; i < firstOutput; i++) {
        if (rng.drand48() < inputFiringProbability[i]!) {
          buf.swap[i] = SpikingActivation;
          neuronFiringCounter[i] = neuronFiringCounter[i]! + 1;
          this.neuron[i]!.v = 31; // hack for stdp
        } else {
          buf.swap[i] = 0.0;
          this.neuron[i]!.v = -30; // or any value less than 30 for that matter
        }
      }

      // --- non-input neurons: Izhikevich voltage, then spike-timing dependent plasticity ---
      for (let i = firstOutput; i < numNeurons; i++) {
        const neuron = this.neuron[i]!;
        // The bias seemed to be negatively affecting timing in our learning rule …
        let newactivation = 0.0;

        startSynapsesToDepress = numSynapsesToDepress;
        for (let k = neuron.startsynapses; k < neuron.endsynapses; k++) {
          const syn = this.synapse[k]!;
          const fromNeuron = Math.abs(syn.fromneuron); // native: (short)abs( … )
          const activation = buf.current[fromNeuron]!;
          if (activation) {
            // native 0x678cc: `fmadd d0, d2, d1, d0` — contracted like the firing-rate models
            newactivation = fma64(syn.efficacy, activation, newactivation);
            synapsesToDepress[numSynapsesToDepress] = k;
            numSynapsesToDepress += 1;
          }
        }

        let v = neuron.v;
        if (v >= 30.0) {
          neuron.v = neuron.spikingParameterC; // reset the membrane potential
          neuron.u += neuron.spikingParameterD; // reset the recovery variable
          v = neuron.v;
        }

        if (USE_BIAS) {
          // PORT-NOTE(l6/spiking-exp): native calls libm `exp` here too (`SpikingModel.cc:214`);
          // lane L1's transcribed `exp` is bit-identical to it, `Math.exp` is not
          if (rng.drand48() < 1.0 / (1.0 + exp(-1 * neuron.bias * 0.5))) {
            newactivation += BIAS_INJECTED_VOLTAGE;
          }
        }

        // native 0x67948-0x67988: `(0.04*v)*v + 5*v` is one `fmadd`, `+140`, `-u`,
        // `+newactivation` are plain adds, and the outer `0.5 * … + v` is a second `fmadd`
        const izhikevich = fma64(0.04 * v, v, 5 * v);
        neuron.v = fma64(izhikevich + 140 - neuron.u + newactivation, 0.5, v);
        // native 0x67990-0x67994: `u += A * (B*v - u)` contracts to
        // `fnmsub d3, b, v, u` (= `B*v - u`, one rounding) then `fmadd A, d3, u`
        neuron.u = fma64(
          neuron.spikingParameterA,
          fma64(neuron.spikingParameterB, v, -neuron.u),
          neuron.u,
        );

        if (neuron.v >= 30.0) {
          numSynapsesToDepress = startSynapsesToDepress; // since we fired there is no need to depress
          neuronFiringCounter[i] = neuronFiringCounter[i]! + 1;
          if (i < firstInternal && i >= firstOutput) {
            outputNeuronFiringCounter[i - firstOutput] = outputNeuronFiringCounter[i - firstOutput]! + 1;
          }
          buf.swap[i] = SpikingActivation; // v > 30 means a firing!

          // reward every incoming connection by the source neuron's STDP timer
          for (let k = neuron.startsynapses; k < neuron.endsynapses; k++) {
            const syn = this.synapse[k]!;
            const from = this.neuron[Math.abs(syn.fromneuron)]!;
            syn.delta = f32(syn.delta + from.stdp);
          }
        } else {
          buf.swap[i] = 0.0; // there is no spike, so the default activation is 0
        }
      }

      // punish the synapses that were active but did not contribute to a spike
      for (let i = 0; i < numSynapsesToDepress; i++) {
        const syn = this.synapse[synapsesToDepress[i]!]!;
        const toneuron = Math.abs(syn.toneuron);
        const stdp = this.neuron[toneuron]!.stdp;
        if (this.neuron[toneuron]!.v < 30.0) syn.delta = f32(syn.delta - stdp);
      }

      // native: swap the two activation pointers
      const saveneuronactivation = buf.current;
      buf.current = buf.swap;
      buf.swap = saveneuronactivation;

      // STDP timers decay every brain step, and reset on a spike
      for (let i = 0; i < numNeurons; i++) {
        const neuron = this.neuron[i]!;
        if (neuron.v > 30) neuron.stdp = f32(STDP_RESET);
        else neuron.stdp = f32(neuron.stdp * STDP_DEGRADATION_SCALER);
      }
    }

    if (brainConfig.enableLearning && !brain.isFrozen()) {
      const numsynapses = dims.numSynapses;
      const halfMaxWeight = f32(0.5 * brainConfig.maxWeight);
      const oneMinusDecay = f32(1.0 - brainConfig.decayRate);
      const maxWeight = brainConfig.maxWeight;

      for (let k = 0; k < numsynapses; k++) {
        const syn = this.synapse[k]!;
        const learningrate = syn.lrate;
        syn.delta = f32(syn.delta * 0.9); // cheating a little
        // native 0x67c7c-0x67ca0: `delta * learningrate` is a C `float` product (one rounding),
        // the `0.01` promotes that to `double`, and the store back into `efficacy` narrows
        const increment = 0.01 + f32(syn.delta * learningrate);
        if (syn.efficacy >= 0) syn.efficacy = f32(syn.efficacy + increment);
        else syn.efficacy = f32(syn.efficacy - increment);

        if (Math.abs(syn.efficacy) > halfMaxWeight) {
          // Native `SpikingModel::update`'s learning block, 0x67cb0-0x67cc4 — the same
          // single-precision chain as `FiringRateModel::update`'s 0x5e8bc-0x5e8cc:
          //   67cb0: fmadd s18, s0, s7, s19   ; maxWeight * -0.5f + |efficacy|  (ONE rounding)
          //   67cb4: fmul  s18, s18, s3       ; * (1.0f - decayRate)
          //   67cb8: fdiv  s18, s18, s1       ; / (0.5f * maxWeight)
          //   67cbc: fsub  s18, s2, s18       ; 1.0f - that
          //   67cc0: fmul  s18, s18, s17      ; * efficacy
          const overHalfMax = f32Fma(maxWeight, -0.5, Math.abs(syn.efficacy)); // 0x67cb0
          const scaled = f32(1.0 - f32(f32(overHalfMax * oneMinusDecay) / halfMaxWeight)); // 0x67cb4-cbc
          syn.efficacy = f32(syn.efficacy * scaled); // 0x67cc0
          if (syn.efficacy > maxWeight) syn.efficacy = maxWeight;
          else if (syn.efficacy < -maxWeight) syn.efficacy = -maxWeight;
        } else {
          if (learningrate >= 0.0) syn.efficacy = Math.max(0.0, syn.efficacy);
          if (learningrate < 0.0) syn.efficacy = Math.min(f32(-1.e-10), syn.efficacy);
        }
      }
    }

    // --- smoothed output firing rates (native `#if USE_BIAS` path) ---
    // native: `float scale_total_spikes = 1.0-scale_latest_spikes;`
    const scaleTotalSpikes = f32(1.0 - this.scaleLatestSpikes);
    for (let i = 0; i < numOutputNeurons; i++) {
      const neuron = this.neuron[i + firstOutput]!;
      neuron.maxfiringcount = Math.max(outputNeuronFiringCounter[i]!, Math.trunc(neuron.maxfiringcount));
      const currentActivationLevel = Math.min(1.0, outputNeuronFiringCounter[i]! / BrainStepsPerWorldStep);
      // native 0x67d7c-0x67d80: `scale_latest_spikes * current` rounds once, then
      // `fmadd d4, d0, d5, d4` fuses `(1.0-scale) * outputActivation[i]` into the add
      this.outputActivation[i] = fma64(
        scaleTotalSpikes,
        this.outputActivation[i]!,
        this.scaleLatestSpikes * currentActivationLevel,
      );
      // after an even number of brain steps `current` is the buffer the last step wrote into
      buf.current[i + firstOutput] = this.outputActivation[i]!;
    }
  }

  /** Native `SpikingModel`'s smoothed output activations, for the harness and the monitor lane. */
  getOutputActivations(): Float64Array {
    return this.outputActivation;
  }
}
