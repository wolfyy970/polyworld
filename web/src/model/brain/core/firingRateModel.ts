/**
 * Lane L6 (brain core) — `brain/FiringRateModel.{h,cc}`: the `NeuronModel F` / `NeuronModel
 * T` per-step cell update, and the synapse learning rule that goes with it. This is the model
 * the recorded scenarios use (`NeuronModel F` in `minitest.wf`), so its arithmetic is the
 * lane's oracle.
 *
 * PORT-NOTE(l6/firingrate-float-stores): the C++ mixes precision inside the update loop and
 * every mixed store is reproduced at the same statement:
 *
 *   - `newneuronactivation[i] = neuron[i].bias;`                 double = float
 *   - `newneuronactivation[i] += synapse[k].efficacy *
 *        neuronactivation[synapse[k].fromneuron];`               double += (float * double)
 *   - `newneuronactivation[i] = (1.0 - tau) * neuronactivation[i]
 *        + tau * logistic( newneuronactivation[i], gain );`      double, with `tau`/`gain`
 *                                                                C floats
 *   - `float efficacy = syn.efficacy + learningrate * … `        the learning update is
 *                                                                computed in double and
 *                                                                *truncated to float*
 *   - `efficacy *= 1.0f - (1.0f - decayRate) * …`                float *= double (the outer
 *                                                                `1.0f - …` is float, the
 *                                                                product is double)
 *
 * The learning rule intentionally acts on *all* synapses, in synapse order, and reads the
 * post-update activation of the destination neuron — `newneuronactivation[toneuron]` — while
 * the activation of the source neuron is the pre-update one. Both halves are load-bearing.
 *
 * PORT-NOTE(l6/firingrate-enablelearning): the learning block is gated on
 * `Brain::config.enableLearning && !cns->getBrain()->isFrozen()`. `enableLearning` is *derived*
 * from `LearningMode != None` in `Brain::processWorldfile`, and the frozen flag is set by the
 * agent lane for `LEARN_PREBIRTH` brains (and by `FreezeSeededSynapses`). The port reads the
 * brain through the nervous system exactly as native does, so a frozen brain skips the loop
 * and its synapses stay exactly as grown.
 */

import { BaseNeuronModel, type NeuronState, type SynapseState } from './baseNeuronModel';
import { brainConfig, NeuronModelKind } from './brain';
import { f32, fma64, logistic } from './nativeMath';
import { f32Fma } from '../../agent/numeric';
import type { FiringRateNeuronAttrs, NeuronAttrs } from './neuronModel';
import type { NervousSystem } from './nervousSystem';

/** Native `FiringRateModel__Neuron` (activation lives in the model's arrays, not here). */
export interface FiringRateNeuron extends NeuronState {
  tau: number;
  gain: number;
}

/** Native `FiringRateModel__Synapse` — the shared synapse shape. */
export type FiringRateSynapse = SynapseState;

export class FiringRateModel extends BaseNeuronModel<FiringRateNeuron, FiringRateSynapse> {
  constructor(cns: NervousSystem) {
    super(cns);
  }

  protected createNeuron(): FiringRateNeuron {
    return { bias: 0, tau: 0, gain: 0, startsynapses: 0, endsynapses: 0 };
  }

  protected createSynapse(): FiringRateSynapse {
    return { fromneuron: 0, toneuron: 0, efficacy: 0, lrate: 0 };
  }

  /** Native `init_derived` — every neuron starts at `initial_activation` (0.1 for Groups). */
  protected initDerived(initialActivation: number): void {
    for (let i = 0; i < this.dims.numNeurons; i++) this.buffers.current[i] = initialActivation;
  }

  /** Native `FiringRateModel::set_neuron`. */
  setNeuron(index: number, attrs: NeuronAttrs, startsynapses = -1, endsynapses = -1): void {
    const firingRate = attrs as FiringRateNeuronAttrs;
    const neuron = this.neuron[index]!;
    this.assignNeuronBase(neuron, firingRate.bias, startsynapses, endsynapses);
    if (Number.isNaN(firingRate.tau)) throw new Error('FiringRateModel::set_neuron: tau is NaN');
    if (Number.isNaN(firingRate.gain)) throw new Error('FiringRateModel::set_neuron: gain is NaN');
    neuron.tau = f32(firingRate.tau);
    neuron.gain = f32(firingRate.gain);
  }

  /** Native `FiringRateModel::update`. */
  update(_bprint: boolean): void {
    if (this.neuron.length === 0) return;

    const dims = this.dims;
    const buf = this.buffers;
    const firstOutput = dims.getFirstOutputNeuron();
    const firstInternal = dims.getFirstInternalNeuron();
    const numNeurons = dims.numNeurons;

    // inputs pass straight through (the sensors have already written them)
    for (let i = 0; i < firstOutput; i++) buf.swap[i] = buf.current[i]!;

    // output neurons: bias + weighted inputs, then the activation function
    for (let i = firstOutput; i < firstInternal; i++) {
      const neuron = this.neuron[i]!;
      let activation = neuron.bias;
      for (let k = neuron.startsynapses; k < neuron.endsynapses; k++) {
        const syn = this.synapse[k]!;
        // native 0x5e704 (0x5e7c8 for the internals): the product and the accumulator are
        // contracted into one `fmadd d0, d1, d2, d0`
        activation = fma64(syn.efficacy, buf.current[syn.fromneuron]!, activation);
      }

      if (brainConfig.neuronModel === NeuronModelKind.TAU_GAIN) {
        const tau = neuron.tau;
        const gain = neuron.gain;
        // native 0x5e740-0x5e744: `tau * logistic(...)` rounds once, then
        // `fmadd d0, d10, d11, d0` fuses `(1.0 - tau) * activation` into the add
        buf.swap[i] = fma64(1.0 - tau, buf.current[i]!, tau * logistic(activation, gain));
      } else {
        buf.swap[i] = logistic(activation, brainConfig.logisticSlope);
      }
    }

    // internal neurons: same, but the accumulation is a `double` local rather than the cell
    const logisticSlope = brainConfig.logisticSlope;
    for (let i = firstInternal; i < numNeurons; i++) {
      const neuron = this.neuron[i]!;
      let newactivation = neuron.bias;
      for (let k = neuron.startsynapses; k < neuron.endsynapses; k++) {
        const syn = this.synapse[k]!;
        newactivation = fma64(syn.efficacy, buf.current[syn.fromneuron]!, newactivation);
      }

      if (brainConfig.neuronModel === NeuronModelKind.TAU_GAIN) {
        const tau = neuron.tau;
        const gain = neuron.gain;
        // native 0x5e800-0x5e804, the internal branch of the same mix
        newactivation = fma64(1.0 - tau, buf.current[i]!, tau * logistic(newactivation, gain));
      } else {
        newactivation = logistic(newactivation, logisticSlope);
      }

      buf.swap[i] = newactivation;
    }

    const brain = this.cns.getBrain();
    if (brain === null) {
      throw new Error('FiringRateModel::update: the nervous system has no brain (native would dereference a null `Brain *`)');
    }
    if (brainConfig.enableLearning && !brain.isFrozen()) {
      const numsynapses = dims.numSynapses;
      const halfMaxWeight = f32(0.5 * brainConfig.maxWeight);
      const oneMinusDecay = f32(1.0 - brainConfig.decayRate);
      const maxWeight = brainConfig.maxWeight;

      for (let k = 0; k < numsynapses; k++) {
        const syn = this.synapse[k]!;
        const learningrate = syn.lrate;

        // native: `float efficacy = syn.efficacy + learningrate * (…) * (…)` — the last
        // product and the add are contracted (`fmadd d17, d18, d19, d17` at 0x5e8a8), and the
        // double result is then truncated to float by the store
        const delta = (buf.swap[syn.toneuron]! - 0.5) * learningrate; // 0x5e890-0x5e894
        let efficacy = f32(fma64(delta, buf.current[syn.fromneuron]! - 0.5, syn.efficacy)); // 0x5e8a8-0x5e8ac

        if (Math.abs(efficacy) > halfMaxWeight) {
          // native: `efficacy *= 1.0f - (1.0f - decayRate) * (fabs(efficacy) - 0.5f*maxWeight) / (0.5f*maxWeight)`
          // Every operand *and every intermediate* of that expression is C `float`, so the
          // shipped code is a chain of single-precision operations, one rounding each
          // (`__ZN15FiringRateModel6updateEb`, the learning block at 0x5e838-0x5e910):
          //   5e8bc: fmadd s16, s0, s6, s18   ; maxWeight * -0.5f + |efficacy|   (ONE rounding)
          //   5e8c0: fmul  s16, s16, s3       ; * (1.0f - decayRate)
          //   5e8c4: fdiv  s16, s16, s1       ; / (0.5f * maxWeight)
          //   5e8c8: fsub  s16, s2, s16       ; 1.0f - that
          //   5e8cc: fmul  s17, s16, s17      ; * efficacy
          // `0x5e8bc`'s fused product is `maxWeight * -0.5f` — an exact power-of-two scaling, so
          // that one instruction is bit-identical to the unfused `|efficacy| - halfMaxWeight`;
          // it is transcribed as the `fmadd` it is, because the *chain* around it is float and
          // running it in binary64 (as the pre-sweep port did) moves the last bits.
          const overHalfMax = f32Fma(maxWeight, -0.5, Math.abs(efficacy)); // 0x5e8bc
          const scaled = f32(1.0 - f32(f32(overHalfMax * oneMinusDecay) / halfMaxWeight)); // 0x5e8c0-c8
          efficacy = f32(efficacy * scaled); // 0x5e8cc
          if (efficacy > maxWeight) efficacy = maxWeight;
          else if (efficacy < -maxWeight) efficacy = -maxWeight;
        } else {
          // not strictly correct for this to be in an else clause, but if lrate is reasonable,
          // efficacy should never change sign with a new magnitude greater than 0.5 * maxWeight
          if (learningrate >= 0.0) efficacy = Math.max(0.0, efficacy);
          if (learningrate < 0.0) efficacy = Math.min(f32(-1.e-10), efficacy);
        }

        syn.efficacy = efficacy;
      }
    }

    // native: swap the two activation pointers
    const saveneuronactivation = buf.current;
    buf.current = buf.swap;
    buf.swap = saveneuronactivation;
  }
}
