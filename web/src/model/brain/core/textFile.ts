/**
 * Lane L6 (brain core) — the text-file surface the brain dumps through.
 *
 * Native `Brain::dumpAnatomical/dumpSynapses/startFunctional/writeFunctional/level-load`
 * take an `AbstractFile *` and only ever use its text API (`printf`, `scanf`). The concrete
 * `AbstractFile` (plain file vs gzip, `getAbstractPath`, `seek`/`tell`) is lane W1c/L2's
 * object; the brain must not reach into it, and it must be able to write into a browser
 * buffer, so this module freezes just the text half as `BrainTextFile`.
 *
 * PORT-NOTE(l6/textfile-boundary): the brain lane depends on this two-method interface, not
 * on W1c's `ByteSink`/`AbstractFile`. `StringTextFile` below is the in-memory implementation
 * the lane's tests (and the differential harness) use; L2/L7 supply the file-backed one by
 * wrapping whatever sink they own. This keeps the brain free of `node:*` imports, so it can
 * be bundled for the browser.
 *
 * PORT-NOTE(l6/scanf-subset): native `loadSynapses` is the only reader in the brain and it
 * uses exactly two `fscanf` shapes — the `synapses …` header and one `"%hd %hd %g %g"` row.
 * The port implements those two (with C's whitespace skipping and field-count result) and
 * throws on anything else rather than silently mis-parsing.
 */

import { sprintfC, type CValue } from './cformat';

/** Native `AbstractFile`'s text API, as the brain uses it. */
export interface BrainTextFile {
  /** Native `AbstractFile::printf( format, ... )`. */
  printf(format: string, ...args: CValue[]): void;
  /**
   * Native `AbstractFile::scanf( format, ... )` — returns the number of successfully
   * assigned fields, like C `fscanf` (and returns -1/`EOF` at end of input).
   */
  scanf(format: string): { count: number; items: number[] };
}

/** An in-memory `BrainTextFile`, so tests and the browser recorder need no file system. */
export class StringTextFile implements BrainTextFile {
  private text = '';
  private readAt = 0;

  printf(format: string, ...args: CValue[]): void {
    this.text += sprintfC(format, ...args);
  }

  /** Everything written so far (native: the bytes in the file). */
  contents(): string {
    return this.text;
  }

  /** Native bytes: latin-1, one byte per code unit (`AbstractFile` writes `char *`). */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.text.length);
    for (let i = 0; i < this.text.length; i++) out[i] = this.text.charCodeAt(i) & 0xff;
    return out;
  }

  /** Load pre-existing content, as if the file had been read back from disk. */
  resetForRead(text: string): void {
    this.text = text;
    this.readAt = 0;
  }

  scanf(format: string): { count: number; items: number[] } {
    if (this.readAt >= this.text.length) return { count: -1, items: [] };
    const items: number[] = [];
    let cursor = this.readAt;
    let f = 0;

    const skipSpace = (): void => {
      while (cursor < this.text.length && /\s/.test(this.text[cursor]!)) cursor += 1;
    };
    const literal = (lit: string): boolean => {
      for (const want of lit) {
        if (this.text[cursor] !== want) return false;
        cursor += 1;
      }
      return true;
    };
    const number = (): number | null => {
      const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.text.slice(cursor));
      if (!m) return null;
      cursor += m[0].length;
      return Number(m[0]);
    };

    while (f < format.length) {
      const ch = format[f]!;
      if (/\s/.test(ch)) {
        skipSpace();
        f += 1;
        continue;
      }
      if (ch !== '%') {
        if (!literal(ch)) return { count: items.length, items };
        f += 1;
        continue;
      }
      if (format[f + 1] === '%') {
        if (!literal('%')) return { count: items.length, items };
        f += 2;
        continue;
      }
      const m = /^%(\d+)?(?:\.(\d+))?(hh|h|ll|l|j|z|t|L)?([diouxXeEfFgGaAcsp])/.exec(format.slice(f));
      if (!m) throw new Error(`l6 brain: unsupported scanf format near ${JSON.stringify(format.slice(f))}`);
      const conversion = m[4]!;
      if (!'dieEfgGiuoxX'.includes(conversion)) {
        throw new Error(`l6 brain: scanf '%${conversion}' is not ported (parse it with a real reader)`);
      }
      f += m[0]!.length;
      if (conversion === 'd' || conversion === 'i' || conversion === 'u') skipSpace();
      const value = number();
      if (value === null) return { count: items.length, items };
      items.push(value);
    }

    this.readAt = cursor;
    return { count: items.length, items };
  }
}
