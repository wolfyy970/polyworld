/**
 * Lane L6 (brain core) — `brain/Nerve.h/.cc`: a named bundle of neurons inside the
 * activation arrays, i.e. the handle the sensors (L9), the agent (L8) and the brain wiring
 * use to read and write one neuron group's activations.
 *
 * PORT-NOTE(l6/activation-buffer-handle): native `Nerve::config( double **activations,
 * double **activations_swap )` stores the *addresses of the model's two activation
 * pointers*, and `get`/`set` dereference them (`(*(activations[buf]))[index+ineuron]`).
 * `BaseNeuronModel::update` swaps those two pointers at the end of every step
 * (`FiringRateModel`) or on every brain step (`SpikingModel`), and because the nerve holds
 * the address of the pointer it follows the swap for free — including the nerve of a *culled*
 * neuron in the sheets architecture, whose index is stale.
 *
 * The port keeps the same shape with an `ActivationBuffers` record: the model owns one such
 * object for its whole life and only swaps its two fields, so everything holding a reference
 * (nerves, tests) observes the same swap. Wrapping the arrays by value, or re-reading them
 * through the model, would silently desynchronise the read the sensors see from the write
 * the model performs.
 *
 * PORT-NOTE(l6/asserts-are-throws): this tree is compiled without `NDEBUG`
 * (`etc/bld/Makefile.conf` adds no `-DNDEBUG`), so every `assert` in the native brain is
 * live in the oracle. The port reproduces them as thrown `Error`s with the assert text — a
 * silently-skipped assert is a silently-different model.
 */

import { sprintfC } from './cformat';

/** The two activation arrays, swapped in place by the model between steps. */
export interface ActivationBuffers {
  /** Native `neuronactivation` — the activations the *last* update produced. */
  current: Float64Array;
  /** Native `newneuronactivation` — the scratch buffer being filled right now. */
  swap: Float64Array;
}

/** Native `Nerve::ActivationBuffer`. */
export const ActivationBuffer = {
  CURRENT: 0,
  SWAP: 1,
} as const;

export type ActivationBuffer = (typeof ActivationBuffer)[keyof typeof ActivationBuffer];

/** Native `Nerve::Type`. */
export const NerveType = {
  INPUT: 0,
  OUTPUT: 1,
} as const;

export type NerveType = (typeof NerveType)[keyof typeof NerveType];

export class Nerve {
  readonly type: NerveType;
  readonly name: string;

  private numneurons = 0;
  private index = -1;
  private buffers: ActivationBuffers | null = null;

  constructor(type: NerveType, name: string) {
    this.type = type;
    this.name = name;
  }

  /** Native `Nerve::get( ineuron, buf )`. */
  get(ineuron = 0, buf: ActivationBuffer = ActivationBuffer.CURRENT): number {
    if (this.numneurons === 0) return 0.0;
    if (!(ineuron >= 0 && ineuron < this.numneurons && this.index > -1)) {
      throw new Error(`Nerve '${this.name}': index ${ineuron} out of range (${this.numneurons} neurons, index ${this.index})`);
    }
    return this.buffer(buf)[this.index + ineuron]!;
  }

  /** Native `Nerve::set( activation, buf )` — single-neuron nerves only. */
  setScalar(activation: number, buf: ActivationBuffer = ActivationBuffer.CURRENT): void {
    if (this.numneurons === 0) return;
    if (this.numneurons !== 1) {
      throw new Error(`Nerve '${this.name}': set( scalar ) on a ${this.numneurons}-neuron nerve`);
    }
    this.set(0, activation, buf);
  }

  /** Native `Nerve::set( ineuron, activation, buf )`. */
  set(ineuron: number, activation: number, buf: ActivationBuffer = ActivationBuffer.CURRENT): void {
    if (!(ineuron >= 0 && ineuron < this.numneurons && this.index > -1)) {
      throw new Error(`Nerve '${this.name}': index ${ineuron} out of range (${this.numneurons} neurons, index ${this.index})`);
    }
    this.buffer(buf)[this.index + ineuron] = activation;
  }

  getIndex(): number {
    return this.index;
  }

  getNeuronCount(): number {
    return this.numneurons;
  }

  /** Native `Nerve::config( numneurons, index )`. */
  configCount(numneurons: number, index: number): void {
    this.numneurons = numneurons;
    this.index = index;
  }

  /**
   * Native `Nerve::config( activations, activations_swap )`. Returns the model's shared
   * buffer record, so the model can assert it reconfigured the same nerves it wired.
   */
  configBuffers(buffers: ActivationBuffers): ActivationBuffers | null {
    const previous = this.buffers;
    this.buffers = buffers;
    return previous;
  }

  /** For tests/telemetry: the index range this nerve currently maps to. */
  describe(): string {
    return sprintfC('%s %s index=%d neurons=%d', this.type === NerveType.INPUT ? 'INPUT' : 'OUTPUT', this.name, this.index, this.numneurons);
  }

  private buffer(buf: ActivationBuffer): Float64Array {
    if (!this.buffers) throw new Error(`Nerve '${this.name}': used before config()`);
    return buf === ActivationBuffer.SWAP ? this.buffers.swap : this.buffers.current;
  }
}
