/**
 * Lane W1c — the byte sink the datalib writer writes into, plus native `AbstractFile`'s
 * path rules (`utils/AbstractFile.cc`).
 *
 * Native `DataLibWriter` writes through `FILE *` (`fopen`), i.e. raw bytes, and asks
 * `ftell()` for the file offsets that end up in the footer digest. The port keeps that
 * shape: a `ByteSink` exposes `write`/`tell`, and the writer never knows whether the bytes
 * land in memory, a plain file, or the gzip path. The concrete sinks live in
 * `nodeFile.ts` (node) so this module stays free of `node:*` imports for the browser
 * bundle.
 *
 * PORT-NOTE(w1c/latin1-bytes): native writes C `char *` buffers verbatim, so the port
 * encodes formatted text as latin-1 (one byte per UTF-16 code unit, truncated to 8 bits).
 * For the ASCII column values the model produces this is byte-identical to any other
 * encoding; latin-1 is chosen because it cannot silently expand a character into several
 * bytes and shift the footer offsets.
 */

import { ConcreteFileType } from '../types/datalib';

/** Native `AbstractFile`'s gzip extension (`#define GZIP_EXT ".gz"`). */
export const GZIP_EXT = '.gz';

/** A byte-accepting sink with a native-`ftell`-equivalent position (`AbstractFile`). */
export interface ByteSink {
  write(data: Uint8Array): void;
  /** Native `ftell( f )` — bytes written so far. */
  tell(): number;
  /** Native `fflush( f )`; `full` is the gzip "Z_SYNC_FLUSH" variant. */
  flush(full?: boolean): void;
  /** Native `fclose` / `gzclose`. Idempotent. */
  close(): void;
}

/** Encode text the way native writes its `char *` buffers (one byte per code unit). */
export function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Decode bytes written by `encodeLatin1`. */
export function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return out;
}

/** An in-memory `ByteSink` (tests, browser recording buffers). */
export class BufferSink implements ByteSink {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;
  private closed = false;

  write(data: Uint8Array): void {
    if (this.closed) throw new Error('datalib: write to a closed sink');
    this.chunks.push(data.slice());
    this.length += data.length;
  }

  tell(): number {
    return this.length;
  }

  flush(): void {
    /* memory: nothing to do */
  }

  close(): void {
    this.closed = true;
  }

  /** All bytes written so far, as one buffer. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  /** The written bytes decoded latin-1 (native `char *` semantics). */
  text(): string {
    return decodeLatin1(this.bytes());
  }
}

/**
 * Native `AbstractFile::createPath` (`AbstractFile.cc:528`).
 *
 * `TYPE_FILE` strips a trailing `.gz`; `TYPE_GZIP_FILE` appends `.gz` unless the path
 * already ends in it. PORT-NOTE(w1c/gzip-path-endscheck): native tests the suffix with
 * `strstr( &path[strlen(path)-strlen(GZIP_EXT)], GZIP_EXT )`, which is a pointer-into-the-
 * string read one byte past the end for paths shorter than 3 characters (and reads out of
 * bounds for those). The port checks the suffix properly; the observable behaviour for
 * every path the model uses is identical.
 */
export function abstractFilePath(type: ConcreteFileType, abstractPath: string): string {
  if (type === ConcreteFileType.TYPE_FILE) {
    return abstractPath.endsWith(GZIP_EXT) ? abstractPath.slice(0, -GZIP_EXT.length) : abstractPath;
  }
  if (type === ConcreteFileType.TYPE_GZIP_FILE) {
    return abstractPath.endsWith(GZIP_EXT) ? abstractPath : abstractPath + GZIP_EXT;
  }
  throw new Error(`datalib: AbstractFile type ${type} has no path`);
}

/** Native `makeParentDir` (`utils/misc.cc`) — create the containing directory. */
export function parentDirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  if (cut < 0) return '.';
  if (cut === 0) return '/';
  return path.slice(0, cut);
}

/**
 * PORT-NOTE(w1c/abstract-file-autodetect): native `AbstractFile::open( abstractPath, mode )`
 * probes `exists(.gz)` then `exists(file)` and, when *both* exist, resolves the ambiguity
 * with `if( &abstractPath[strlen(abstractPath)-strlen(GZIP_EXT)] )` — a non-null address,
 * so the condition is always true and gzip wins regardless of the comment ("specified path
 * ends in .gz"). The port keeps gzip-wins and documents the constant condition rather than
 * "fixing" it (PORT_SPEC rule 1).
 */
export function resolveAutoFileType(
  abstractPath: string,
  exists: (type: ConcreteFileType, path: string) => boolean,
): ConcreteFileType | undefined {
  const hasGzip = exists(ConcreteFileType.TYPE_GZIP_FILE, abstractPath);
  const hasPlain = exists(ConcreteFileType.TYPE_FILE, abstractPath);
  if (hasGzip && hasPlain) return ConcreteFileType.TYPE_GZIP_FILE;
  if (hasGzip) return ConcreteFileType.TYPE_GZIP_FILE;
  if (hasPlain) return ConcreteFileType.TYPE_FILE;
  return undefined;
}
