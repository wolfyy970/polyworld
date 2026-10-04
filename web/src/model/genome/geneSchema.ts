/**
 * Lane L5 (genome) — `genome/GeneSchema.{h,cc}` and `genome/Gene.cc`'s `ContainerGene`.
 *
 * `GeneSchema` is the ordered gene registry and the offset allocator. Three details are
 * load-bearing and reproduced literally:
 *
 *   1. `_genes` (insertion order) drives *every* printer; `_type2genes` drives the lookups.
 *      The insertion order is the worldfile-visible layout order, so nothing here may be
 *      "tidied" into a map iteration.
 *   2. `getMutableSize()` is a **state machine**: in `STATE_CACHING` it assigns every
 *      mutable gene's `offset` (`offset = _offset + running_size`, containers recursively)
 *      and returns the total; `offset` is `-1` for immutable genes.
 *   3. `get(name)` on a missing name returns NULL and, natively, *inserts* a null entry into
 *      the `std::map` (operator[]). The port returns null from a `Map.get` — the insertion
 *      is unobservable (printers walk `_genes`, not the name map).
 *
 * PORT-NOTE(genome/container-in-gene-schema): native's `ContainerGene` owns a `GeneSchema`
 * and the cast helper `GeneType::to_Container`; both live in this module instead of
 * `gene.ts` because `GeneSchema` is what `ContainerGene` needs — the port keeps the
 * dependency one-way (`geneSchema.ts` -> `gene.ts`) instead of a module cycle.
 */

import { Gene, toImmutableScalar, type LayoutLike, type Output } from './gene';
import { GeneType, at, type AnyGeneType } from './vocabulary';

/** Native `GeneSchema::State`. */
const State = {
  CONSTRUCTING: 0,
  CACHING: 1,
  COMPLETE: 2,
} as const;

/** Native `GeneSchema`. */
export class GeneSchema {
  protected state: number = State.CONSTRUCTING;
  protected offsetBase = -1;

  protected readonly name2gene = new Map<string, Gene>();
  protected readonly type2genes = new Map<AnyGeneType, Gene[]>();
  protected readonly genes: Gene[] = [];

  private cachedMutableSize = 0;

  /** Native `GeneSchema::add`. */
  add(gene: Gene): Gene {
    if (this.state !== State.CONSTRUCTING) {
      throw new Error(`${gene.name}: genes may only be added while constructing`);
    }
    if (this.name2gene.has(gene.name)) {
      throw new Error(`${gene.name}: duplicate gene name`);
    }
    this.name2gene.set(gene.name, gene);
    const bucket = this.type2genes.get(gene.type);
    if (bucket) bucket.push(gene);
    else this.type2genes.set(gene.type, [gene]);
    this.genes.push(gene);
    return gene;
  }

  /** Native `GeneSchema::get( const string & )` — NULL for an unknown name. */
  get(name: string): Gene | null {
    return this.name2gene.get(name) ?? null;
  }

  /** Native `GeneSchema::get( const GeneType * )` — asserts exactly one gene of that type. */
  getByType(type: AnyGeneType): Gene {
    const bucket = this.type2genes.get(type) ?? [];
    if (bucket.length !== 1) {
      throw new Error(`${type}: get() expects exactly one gene, found ${bucket.length}`);
    }
    return at(bucket, 0, type);
  }

  /** Native `GeneSchema::getAll( const GeneType * )`. */
  getAll(type?: AnyGeneType): readonly Gene[] {
    if (type === undefined) return this.genes;
    return this.type2genes.get(type) ?? [];
  }

  /** Native `GeneSchema::getGeneCount`. */
  getGeneCount(type: AnyGeneType): number {
    return (this.type2genes.get(type) ?? []).length;
  }

  /** Native `GeneSchema::getMutableSize()`. */
  getMutableSize(): number {
    if (this.state === State.COMPLETE) return this.cachedMutableSize;
    if (this.state !== State.CACHING) {
      throw new Error('GeneSchema::getMutableSize: not complete and not caching');
    }
    if (this.offsetBase < 0) {
      throw new Error('GeneSchema::getMutableSize: negative offset base');
    }

    this.cachedMutableSize = 0;
    for (const gene of this.genes) {
      if (gene.ismutable) {
        gene.offset = this.offsetBase + this.cachedMutableSize;
        if (gene.type === GeneType.CONTAINER) {
          (gene as ContainerGene).complete(gene.offset);
        }
        this.cachedMutableSize += gene.getMutableSize();
      } else {
        gene.offset = -1;
      }
    }
    return this.cachedMutableSize;
  }

  /** Native `GeneSchema::complete( int offset = 0 )`. */
  complete(offset = 0): void {
    this.beginComplete(offset);
    this.endComplete();
  }

  /** Native `GeneSchema::beginComplete`. */
  protected beginComplete(offset: number): void {
    if (this.state !== State.CONSTRUCTING) {
      throw new Error('GeneSchema::beginComplete: already completing');
    }
    this.state = State.CACHING;
    this.offsetBase = offset;
  }

  /** Native `GeneSchema::endComplete`. */
  protected endComplete(): void {
    if (this.state !== State.CACHING) {
      throw new Error('GeneSchema::endComplete: not caching');
    }
    this.getMutableSize();
    this.state = State.COMPLETE;
  }

  /** True once `complete()` has run (native: `_state == STATE_COMPLETE`). */
  isComplete(): boolean {
    return this.state === State.COMPLETE;
  }

  /** True inside `complete()` (native: `_state == STATE_CACHING`) — subclass caches key on it. */
  protected isCaching(): boolean {
    return this.state === State.CACHING;
  }

  /** Native `GeneSchema::getIndexes`. */
  getIndexes(geneNames: readonly string[]): number[] {
    return geneNames.map((name) => this.get(name)?.offset ?? -1);
  }

  /** Native `GeneSchema::printIndexes`. */
  printIndexes(out: Output, layout: LayoutLike | null = null, prefix = ''): void {
    for (const gene of this.genes) gene.printIndexes(out, prefix, layout);
  }

  /** Native `GeneSchema::printTitles`. */
  printTitles(out: Output, prefix = ''): void {
    for (const gene of this.genes) gene.printTitles(out, prefix);
  }

  /** Native `GeneSchema::printRanges`. */
  printRanges(out: Output, prefix = ''): void {
    for (const gene of this.genes) gene.printRanges(out, prefix);
  }
}

/**
 * Native `ContainerGene` (`genome/Gene.cc`) — a mutable gene whose children are a nested
 * `GeneSchema`, so a whole sub-tree of genes shares one container prefix (`Name.child`).
 */
export class ContainerGene extends Gene {
  private readonly containerSchema = new GeneSchema();

  constructor(name: string) {
    super();
    this.init(GeneType.CONTAINER, true, name);
  }

  /** Native `ContainerGene::add`. */
  add(gene: Gene): void {
    this.containerSchema.add(gene);
  }

  /** Native `ContainerGene::gene`. */
  gene(name: string): Gene | null {
    return this.containerSchema.get(name);
  }

  /** Native `ContainerGene::getConst` — `to_ImmutableScalar(get(name))->get(NULL)`. */
  getConst(name: string): ReturnType<Gene['getConstant']> {
    return toImmutableScalar(this.containerSchema.get(name)).getConstant();
  }

  /** Native `ContainerGene::getAll`. */
  getAll(): readonly Gene[] {
    return this.containerSchema.getAll();
  }

  /** Native `ContainerGene::complete( offset )`. */
  complete(offset: number): void {
    this.containerSchema.complete(offset);
  }

  /** Native `ContainerGene::printIndexes`. */
  override printIndexes(out: Output, prefix: string, layout: LayoutLike | null): void {
    if (!this.ismutable) return;
    this.containerSchema.printIndexes(out, layout, `${prefix}${this.name}.`);
  }

  /** Native `ContainerGene::printTitles`. */
  override printTitles(out: Output, prefix: string): void {
    if (!this.ismutable) return;
    this.containerSchema.printTitles(out, `${prefix}${this.name}.`);
  }

  /** Native `ContainerGene::printRanges`. */
  override printRanges(out: Output, prefix: string): void {
    if (!this.ismutable) return;
    this.containerSchema.printRanges(out, `${prefix}${this.name}.`);
  }

  protected override getMutableSizeImpl(): number {
    return this.containerSchema.getMutableSize();
  }
}

/** Native `GeneType::to_Container`. */
export function toContainer(gene: Gene | null | undefined): ContainerGene {
  if (!(gene instanceof ContainerGene)) {
    throw new Error(`GeneType::to_Container: ${gene?.name ?? 'null'} is not a ContainerGene`);
  }
  return gene;
}
