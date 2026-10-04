/**
 * Lane L5 (genome) — `genome/SeparationCache.{h,cc}`: the per-agent separation memo.
 *
 * Native attaches a `map<long,float>` to each agent through `AgentAttachedData` (a slot on
 * the agent), keyed by the *other* agent's `Number()`, and always orders the pair by number
 * so the two directions share one entry:
 *
 *   x = ( a->Number() < b->Number() ) ? a : b;  y = the other
 *   result = x->Genes()->separation( y->Genes() )   // on a miss
 *
 * PORT-NOTE(genome/separation-cache-key): the port keys the cache by `Number()` in a Map
 * instead of an agent-attached slot. Agent numbers are unique and stable for the life of a
 * run (they are written to every log), so the observable behaviour is identical; the port
 * additionally removes an agent's entries on death, which native leaks (it deletes the map
 * but keeps the slot). `createEntry` is the only place `Genome::separation` is memoized —
 * it must stay that way, because `separation()` is one of the hottest calls in a run.
 *
 * The *writer* of `run/genome/separations.txt` is lane L12 (`Logs::SeparationLog`, a datalib
 * table); this module owns only the cache.
 */

/** The part of an agent this cache needs (`Genome::separation` over its `Genes()`). */
export interface SeparationAgent {
  /** Native `agent::Number()` — the log identity of the agent. */
  number(): number;
  /** Native `agent::Genes()`. */
  genes(): SeparationGenomeLike;
}

/** Native `genome::Genome` as `separation` sees it. */
export interface SeparationGenomeLike {
  separation(other: SeparationGenomeLike): number;
}

/** Native `SeparationCache`. */
export class SeparationCache {
  /** Native `static AgentAttachedData::SlotHandle _slotHandle` — one per process. */
  private readonly entries = new Map<number, Map<number, number>>();

  /** Native `SeparationCache::init` (native: allocate the agent-attached slot). */
  init(): void {
    this.entries.clear();
  }

  /** Native `SeparationCache::birth` — start an empty entry set for a new agent. */
  birth(agent: { number(): number }): void {
    this.entries.set(agent.number(), new Map());
  }

  /** Native `SeparationCache::death`. */
  death(agent: { number(): number }): void {
    this.entries.delete(agent.number());
  }

  /** Native `SeparationCache::getEntries`. */
  getEntries(agent: { number(): number }): Map<number, number> {
    const out = this.entries.get(agent.number());
    if (!out) throw new Error(`SeparationCache::getEntries: agent ${agent.number()} has no slot`);
    return out;
  }

  /** Native `SeparationCache::createEntry( agent *a, agent *b )`. */
  createEntry(a: SeparationAgent, b: SeparationAgent): number {
    // Native orders the pair by number: `x` is the smaller one.
    const aNotSmaller = a.number() >= b.number();
    const x = aNotSmaller ? b : a;
    const y = aNotSmaller ? a : b;

    const entries = this.getEntries(x);
    const cached = entries.get(y.number());
    if (cached !== undefined) return cached;

    const result = x.genes().separation(y.genes());
    entries.set(y.number(), result);
    return result;
  }
}

/** Native's static cache: one per process. */
export const separationCache = new SeparationCache();
