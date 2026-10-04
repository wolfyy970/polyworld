/**
 * Lane L5 (genome) — `genome/GenomeLayout.{h,cc}`: the gene-offset -> mutable-data-offset
 * map.
 *
 * Native builds the map with `GenomeLayout::create( schema, type )`, which switches on
 * `GenomeSchema::config.layoutType`:
 *
 *   None      — identity (`geneOffset2mutableDataOffset[i] = i`);
 *   NeurGroup — a *reordering*: physiology scalars first, then the mutable neuron-group
 *               genes, then, per group, that group's attributes and then the synapse
 *               attribute matrix. The mutable data is therefore laid out in
 *               neuron-group order, not gene order, and `run/genome/meta/genelayout.txt`
 *               records the result.
 *
 * PORT-NOTE(genome/layout-dispatch): native's `create()` lives inside `GenomeLayout` and
 * `dynamic_cast`s the schema to `GroupsGenomeSchema`. The port keeps `GenomeLayout` free of
 * any group dependency (so `genome.ts` can use it without a module cycle) and moves the
 * dispatch to `GenomeUtil.createSchema`, which is the only caller in native too. The
 * NeurGroup mapping itself is a literal transcription
 * (`groups/groupsLayout.ts:buildNeurGroupMapping`).
 *
 * PORT-NOTE(genome/layout-validate): `validate()` prints each bad slot and `exit(1)`s; the
 * port throws with the same numbers in the message. It must never be skipped — a layout
 * with a hole silently mis-addresses every gene after it.
 */

import type { LayoutLike } from './gene';

/** Native `GenomeLayout::LayoutType`. */
export const LayoutType = {
  None: 0,
  NeurGroup: 1,
} as const;

export type LayoutType = (typeof LayoutType)[keyof typeof LayoutType];

/** Native `GenomeLayout`. */
export class GenomeLayout implements LayoutLike {
  private readonly mapping: Int32Array;

  /** Native `GenomeLayout::GenomeLayout( GenomeSchema * )` — every slot starts at `-1`. */
  constructor(readonly numOffsets: number) {
    this.mapping = new Int32Array(numOffsets).fill(-1);
  }

  /** Native `GenomeLayout::createNone`. */
  static createNone(numOffsets: number): GenomeLayout {
    const layout = new GenomeLayout(numOffsets);
    for (let i = 0; i < numOffsets; i++) layout.mapping[i] = i;
    return layout;
  }

  /** Native `geneOffset2mutableDataOffset[ geneOffset ] = dataOffset` (the `ADD` macro). */
  set(geneOffset: number, dataOffset: number): void {
    if (geneOffset < 0 || geneOffset >= this.numOffsets) {
      throw new Error(`GenomeLayout: gene offset ${geneOffset} outside 0..${this.numOffsets - 1}`);
    }
    this.mapping[geneOffset] = dataOffset;
  }

  /** Native `GenomeLayout::getMutableDataOffset_nocheck`. */
  getMutableDataOffset_nocheck(geneOffset: number): number {
    return this.mapping[geneOffset] ?? -1;
  }

  /** Native `GenomeLayout::getMutableDataOffset` — `assert( geneOffset in range )`. */
  getMutableDataOffset(geneOffset: number): number {
    if (!(geneOffset < this.numOffsets && geneOffset >= 0)) {
      throw new Error(`GenomeLayout: gene offset ${geneOffset} out of range (${this.numOffsets})`);
    }
    return this.getMutableDataOffset_nocheck(geneOffset);
  }

  /** Native `GenomeLayout::validate` — every mutable slot must be claimed exactly once. */
  validate(): void {
    const present = new Int32Array(this.numOffsets);
    for (let i = 0; i < this.numOffsets; i++) {
      const target = this.getMutableDataOffset(i);
      if (target < 0 || target >= this.numOffsets) {
        throw new Error(
          `GenomeLayout::validate(): [${i}] maps to ${target}, outside 0..${this.numOffsets - 1}`,
        );
      }
      present[target] = (present[target] ?? 0) + 1;
    }

    for (let i = 0; i < this.numOffsets; i++) {
      const count = present[i] ?? 0;
      if (count !== 1) {
        throw new Error(`GenomeLayout::validate(): [${i}]=${count}`);
      }
    }
  }
}
