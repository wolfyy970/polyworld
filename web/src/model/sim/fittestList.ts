/**
 * Lane L11 (sim) — `FittestList` (native `sim/FittestList.{h,cc}`): the "best N agents" list.
 *
 * Two of these exist per run: `fFittest` (overall, stores genomes) and `fRecentFittest`
 * (per-epoch, no genomes). They are the regeneration pool `CreateAgents` draws from and the
 * source of `run/genome/fittest.txt`'s rows (lane L12).
 *
 * PORT-NOTE(sim/fittest-tie-order): `update` inserts a candidate **before** the first element
 * with a strictly smaller fitness, so equal-fitness newcomers land *after* existing equals and
 * the list keeps insertion order among ties. `_elements` is a fixed `capacity` array whose
 * `genes` slots are allocated lazily on first growth and reused after `clear()` — the port keeps
 * exactly that (a cleared list keeps its element objects, so `isFull()`/`get(rank)` semantics
 * after a `clear()` are the native ones).
 *
 * PORT-NOTE(sim/genome-seam-cast): native `FitStruct::genes` is a `genome::Genome *` and
 * `candidate->Genes()` returns one. Lane L8's agent seam types the genome as its narrow
 * `GenomeLike`, which the sim's agent factory (`bindings.ts`) wraps around the concrete L5
 * `Genome` in `AgentGenomeAdapter`. `asGenome` therefore **unwraps** through that adapter rather
 * than blind-casting: the concrete object is what every sim consumer of `genes()` needs
 * (`updateSum` for `GeneStats`, `dump` for the fittest log, the brain's genome view), and a blind
 * cast left them calling methods on the adapter — measured: `asGenome(...).updateSum is not a
 * function` at `geneStats.ts:92` on the first `StepEnd`.
 */

import { genomeUtil, type Genome } from '../genome';
import { globalRngSurface } from '../rng';
import type { GenomeLike } from '../agent';
import { asConcreteGenome } from './bindings';

/** Native `FitStruct` (`FittestList.h:12-19`). */
export interface FitStruct {
  agentID: number;
  fitness: number;
  complexity: number;
  /** Null until the list first grows with `storeGenome`. */
  genes: Genome | null;
}

/** The agent-side surface `FittestList::update` reads (native `agent`). */
export interface FittestCandidate {
  /** Native `agent::Number()`. */
  number(): number;
  /** Native `agent::Complexity()`. */
  complexity(): number;
  /** Native `agent::Genes()`. */
  genes(): GenomeLike;
}

/** The concrete genome behind an L5/L8 seam value (see PORT-NOTE(sim/genome-seam-cast)). */
export function asGenome(genome: GenomeLike): Genome {
  return asConcreteGenome(genome);
}

/** Native `FittestList::FittestList( capacity, storeGenome )`. */
export class FittestList {
  private readonly elements: FitStruct[];
  private size = 0;

  constructor(
    private readonly capacity: number,
    private readonly storeGenome: boolean,
  ) {
    this.elements = [];
    for (let i = 0; i < capacity; i++) {
      // Native allocates the FitStruct objects up front and leaves `genes` null.
      this.elements.push({ agentID: 0, fitness: 0, complexity: 0, genes: null });
    }

    this.clear();
  }

  isFull(): boolean {
    return this.size === this.capacity;
  }

  clear(): void {
    this.size = 0;

    // Native keeps the (backwards-compatible) zeroing pass over every element.
    for (let i = 0; i < this.capacity; i++) {
      const element = this.elements[i]!;
      element.fitness = 0.0;
      element.agentID = 0;
      element.complexity = 0.0;
    }
  }

  /** Native `FittestList::size()`. */
  getSize(): number {
    return this.size;
  }

  /** Native `FittestList::get( int rank )` — 0-based, unchecked (native asserts rank < size). */
  get(rank: number): FitStruct {
    if (!(rank < this.size)) {
      throw new Error(`FittestList::get( ${rank} ): out of range (size ${this.size})`);
    }
    return this.elements[rank]!;
  }

  /**
   * Native `FittestList::update( agent *candidate, float fitness )`. The `fitness` argument is a
   * `float` in native; the caller (lane L11's `updateFittest`) performs the fround.
   */
  update(candidate: FittestCandidate, fitness: number): void {
    if (!this.isFull() || fitness > this.elements[this.size - 1]!.fitness) {
      let rank = -1;
      for (let i = 0; i < this.size; i++) {
        if (fitness > this.elements[i]!.fitness) {
          rank = i;
          break;
        }
      }
      if (rank === -1) {
        if (this.isFull()) throw new Error('FittestList::update: full and no rank (native asserts !isFull)');
        rank = this.size;
      }

      if (!this.isFull()) {
        // Growing the list. The genome slot may already exist if the list was larger before a
        // clear(); native only allocates when it is still null.
        if (this.storeGenome && this.elements[this.size]!.genes === null) {
          this.elements[this.size]!.genes = genomeUtil.createGenome(false, globalRngSurface());
        }
        this.size++;
      }

      const newElement = this.elements[this.size - 1]!;
      for (let i = this.size - 1; i > rank; i--) {
        this.elements[i] = this.elements[i - 1]!;
      }
      this.elements[rank] = newElement;

      newElement.fitness = fitness;
      if (this.storeGenome) newElement.genes!.copyFrom(asGenome(candidate.genes()));
      newElement.agentID = candidate.number();
      newElement.complexity = candidate.complexity();
    }
  }
}
