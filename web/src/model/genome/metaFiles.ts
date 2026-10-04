/**
 * Lane L5 (genome) — `Logs::GenomeMetaLog` / `Logs::GeneStatsLog`'s genome half: the four
 * `run/genome/meta/*.txt` renderers and the `genelayout-sorted.txt` `sort -n` pass.
 *
 * Native (`logs/Logs.cc`) does, on `sim::Event_SimInited`:
 *
 *   geneindex.txt           schema->printIndexes( f )                  (gene offsets)
 *   genelayout.txt          schema->printIndexes( f, layout )          (mutable data offsets)
 *   genelayout-sorted.txt   `cat genelayout.txt | sort -n`
 *   genetitle.txt           schema->printTitles( f )
 *   generange.txt           schema->printRanges( f )
 *
 * and, in `GeneStatsLog::init`, writes `getMutableSize()` as the first line of
 * `genestats.txt`. Those bytes are part of PORT_SPEC's frozen surface, so this module owns
 * the *rendering*; the file writing belongs to lane L12 (`logs/**`), which is why
 * `writeGenomeMetaFiles` exists side by side with the pure renderers — the parity harness
 * needs a run tree, and this is the only part of `run/genome/**` the genome lane can produce
 * without the simulation.
 *
 * PORT-NOTE(genome/meta-sort): `sort -n` on `genelayout.txt`. The indices are unique, so
 * keying on the integer prefix is sufficient and locale-independent; the port sorts
 * numerically and keeps the line bytes verbatim. A tie (impossible for a valid layout —
 * `GenomeLayout::validate` rejects duplicates) would fall back to byte order, as `sort`
 * does.
 */

import type { GeneSchema } from './geneSchema';
import type { GenomeLayout } from './genomeLayout';
import { GenomeSchema } from './genomeSchema';

/** Anything the printers write to (native `FILE *`). */
class StringSink {
  private text = '';

  write(chunk: string): void {
    this.text += chunk;
  }

  toString(): string {
    return this.text;
  }
}

/** Native `GenomeMetaLog`: `geneindex.txt`. */
export function renderGeneIndex(schema: GeneSchema): string {
  const out = new StringSink();
  schema.printIndexes(out, null);
  return out.toString();
}

/** Native `GenomeMetaLog`: `genelayout.txt` (the layout-ordered mutable offsets). */
export function renderGeneLayout(schema: GeneSchema, layout: GenomeLayout): string {
  const out = new StringSink();
  schema.printIndexes(out, layout);
  return out.toString();
}

/** Native `SYSTEM( "cat genelayout.txt | sort -n > genelayout-sorted.txt" )`. */
export function renderGeneLayoutSorted(geneLayout: string): string {
  const lines = geneLayout.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const keyed = lines.map((line, index) => {
    const tab = line.indexOf('\t');
    const head = tab === -1 ? line : line.slice(0, tab);
    const key = /^-?\d+$/.test(head) ? Number(head) : Number.NaN;
    return { line, key, index };
  });

  keyed.sort((a, b) => {
    if (Number.isNaN(a.key) || Number.isNaN(b.key)) return a.index - b.index; // `sort` keeps unparsable lines ordered
    if (a.key !== b.key) return a.key - b.key;
    return a.line < b.line ? -1 : a.line > b.line ? 1 : 0;
  });

  return `${keyed.map((entry) => entry.line).join('\n')}\n`;
}

/** Native `GenomeMetaLog`: `genetitle.txt`. */
export function renderGeneTitles(schema: GeneSchema): string {
  const out = new StringSink();
  schema.printTitles(out);
  return out.toString();
}

/** Native `GenomeMetaLog`: `generange.txt`. */
export function renderGeneRanges(schema: GeneSchema): string {
  const out = new StringSink();
  schema.printRanges(out);
  return out.toString();
}

/** Native `GeneStatsLog::init`: the `genestats.txt` header (first line only). */
export function renderGeneStatsHeader(schema: GeneSchema): string {
  return `${schema.getMutableSize()}\n`;
}

/** The five files `GenomeMetaLog` writes, keyed by their path under `run/`. */
export interface GenomeMetaFiles {
  readonly 'run/genome/meta/geneindex.txt': string;
  readonly 'run/genome/meta/genelayout.txt': string;
  readonly 'run/genome/meta/genelayout-sorted.txt': string;
  readonly 'run/genome/meta/genetitle.txt': string;
  readonly 'run/genome/meta/generange.txt': string;
}

/** Render every `run/genome/meta/*` file for a completed schema + layout. */
export function renderGenomeMeta(
  schema: GeneSchema,
  layout: GenomeLayout,
): GenomeMetaFiles {
  const layoutText = renderGeneLayout(schema, layout);
  return {
    'run/genome/meta/geneindex.txt': renderGeneIndex(schema),
    'run/genome/meta/genelayout.txt': layoutText,
    'run/genome/meta/genelayout-sorted.txt': renderGeneLayoutSorted(layoutText),
    'run/genome/meta/genetitle.txt': renderGeneTitles(schema),
    'run/genome/meta/generange.txt': renderGeneRanges(schema),
  };
}

/** True when the schema in hand is a *complete*, printable genome schema. */
export function assertPrintableSchema(schema: GeneSchema): void {
  if (!(schema instanceof GenomeSchema)) {
    throw new Error('renderGenomeMeta: not a genome schema');
  }
  if (!schema.isComplete()) {
    throw new Error('renderGenomeMeta: schema is not complete (offsets would all be -1)');
  }
}
