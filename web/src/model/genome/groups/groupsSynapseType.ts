/**
 * Lane L5 (genome) — `genome/groups/GroupsSynapseType.{h,cc}`: one of the four synapse
 * classes (EE, EI, II, IE) and the offset arithmetic of its attribute matrix.
 *
 * The matrix is dense and indexed `[from][to - groupCount[INPUT]]`, one byte per cell:
 *
 *   getOffset( from, to ) = index * mutableSize + from + (to - groupCount[INPUT]) * groupCount[ANY]
 *
 * with `mutableSize = groupCount[ANY] * (groupCount[ANY] - groupCount[INPUT])`. The four
 * types have equal size (they share `groupCount`), so the type blocks are `index`-spaced.
 * `to` is an *output or internal* group, so its index is offset by the input group count —
 * that is what `assert( to >= groupCount[NGT_INPUT] )` guards.
 *
 * PORT-NOTE(genome/synapse-attribute-matrix): the arithmetic is transcribed as written,
 * including `index * mutableSize` (not an accumulated prefix sum) and the assertion on
 * `to`. Off-by-one here would not crash: it would silently shift every synapse gene.
 */

import { NeuronType } from '../vocabulary';

/** Native `GroupsSynapseType`. */
export class GroupsSynapseType {
  readonly name: string;
  readonly ntFrom: NeuronType;
  readonly ntTo: NeuronType;

  private readonly index: number;
  private groupCount: Int32Array | null = null;
  private mutableSize = 0;

  constructor(name: string, index: number) {
    this.name = name;
    this.index = index;
    // Native: `nt_from = _name[0] == 'I' ? INHIBITORY : EXCITATORY` — the *name* decides.
    this.ntFrom = name[0] === 'I' ? NeuronType.INHIBITORY : NeuronType.EXCITATORY;
    this.ntTo = name[1] === 'I' ? NeuronType.INHIBITORY : NeuronType.EXCITATORY;
  }

  /** Native `GroupsSynapseType::getOffset`. */
  getOffset(from: number, to: number): number {
    const counts = this.groupCount;
    if (!counts) throw new Error(`GroupsSynapseType ${this.name}: not completed`);
    const nInput = counts[0 + 1] ?? 0; // NGT_INPUT == 1
    const nAny = counts[0] ?? 0; // NGT_ANY == 0
    if (!(to >= nInput)) {
      throw new Error(`GroupsSynapseType ${this.name}::getOffset: to ${to} < ${nInput}`);
    }
    return this.index * this.mutableSize + from + (to - nInput) * nAny;
  }

  /** Native `GroupsSynapseType::complete` — records the shared group counts. */
  complete(groupCount: Int32Array): void {
    this.groupCount = groupCount;
    const nAny = groupCount[0] ?? 0;
    const nInput = groupCount[1] ?? 0;
    this.mutableSize = nAny * (nAny - nInput); // sizeof(char) == 1
  }

  /** Native `GroupsSynapseType::getMutableSize`. */
  getMutableSize(): number {
    if (!this.groupCount) throw new Error(`GroupsSynapseType ${this.name}: not completed`);
    return this.mutableSize;
  }

  /** Native `GroupsSynapseType::index` — needed by the layout/printer walk order. */
  getIndex(): number {
    return this.index;
  }
}
