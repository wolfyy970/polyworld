/**
 * Lane W1c — node adapters for the two concrete file backends native has
 * (`utils/AbstractFile.{h,cc}`): plain `FILE *` and zlib's `gzFile`.
 *
 * Native `AbstractFile` is one object that switches on `ConcreteFileType`; the port splits
 * it into a `ByteSink` (this file) plus an injected sink, because the model has to write
 * the same bytes in a browser (where `node:fs`/`node:zlib` do not exist). Import this module
 * only where a real file system is available; `writer.ts`/`reader.ts`/`sink.ts` stay
 * portable, and the browser lane can supply its own `ByteSink` (e.g. a `Blob`-backed one)
 * whose gzip path also calls `gzipContainer` from `src/model/compress/zlibDeflate.ts`.
 *
 * PORT-NOTE(w1c/gzip-deferred): native writes gzip through `gzopen`/`gzwrite` and its
 * `flush( full )` maps to `gzflush( Z_SYNC_FLUSH )` — flushing degrades the compression and
 * changes the container bytes. The port accumulates the uncompressed bytes and compresses
 * once on `close()` (`flush` becomes a no-op for the gzip sink). Decompressed content is
 * byte-identical either way; the container bytes match native as long as nothing flushes
 * mid-file, which is verified against a clang/zlib `gzopen` reference in
 * `tests/datalib.test.ts`.
 *
 * PORT-NOTE(w1c/gzip-upstream-writer): the container is written by the transcribed upstream
 * zlib in `src/model/compress/zlibDeflate.ts`, **not** by `node:zlib`'s `gzipSync`. Which
 * stream `node:zlib` writes depends on the zlib the node binary is **linked against** (a
 * build-time choice, not a property of node): the builds measured here link Google's patched
 * "motley" fork, which writes a different deflate stream for the same payload, so it cannot
 * reproduce the recorded `.gz` goldens (25/150 containers) — while a node linked against
 * upstream zlib 1.2.12 reproduces all 150 with the very same `gzipSync` call (t_16ac7810). See
 * `docs/specs/gzip-containers.md`, task t_431ed2f0. Reading still uses `gunzipSync`:
 * inflate is version-stable and is not a frozen surface.
 *
 * PORT-NOTE(w1c/stdio-buffer): native's plain backend is `fopen( path, "wb" )` → a **buffered**
 * `FILE *`: `fwrite`/`fprintf` copy into stdio's buffer (`BUFSIZ`/`st_blksize`, 4 KiB here) and
 * `write(2)` only when it fills, on `fflush` or on `fclose`. The port's first shape called
 * `writeSync` once per `write`, so every datalib row and every log line was its own syscall —
 * measured 2026-09-28 (task t_cfd271a8) as `writeBuffer` under `writeSync` holding **34 %** of
 * the 25-agent step loop's wall time over a 12 MB run tree. `BufferedFdWriter` below is that
 * buffer: identical bytes in identical order, ~1 syscall per 64 KiB. Nothing observable moves
 * — a file's content is only read after `close()`, `tell()` keeps native `ftell`'s *logical*
 * position (flushed + buffered), and a recorder that never closes its file still gets its bytes
 * written, because `exit()` flushes `FILE *`s in native and the `exit` hook here does the same.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { ConcreteFileType } from '../types/datalib';
import { gzipContainer } from '../compress/zlibDeflate';
import {
  abstractFilePath,
  parentDirOf,
  resolveAutoFileType,
  type ByteSink,
} from './sink';

/** Native `makeParentDir()` — create the file's containing directory (recursively). */
export function makeParentDir(path: string): void {
  mkdirSync(parentDirOf(path), { recursive: true });
}

/** The stdio buffer `BufferedFdWriter` writes through (native `BUFSIZ`/`st_blksize` scale). */
const WRITE_BUFFER_BYTES = 64 * 1024;

/**
 * A descriptor with native's stdio buffering (`FILE *`), for one open file.
 *
 * `writeText`/`writeBytes` append to the buffer and `write(2)` when it is full, so the byte
 * stream is exactly what an unbuffered sink produced — only the syscall count changes.
 */
export class BufferedFdWriter {
  private fd: number | null;
  private readonly buffer = new Uint8Array(WRITE_BUFFER_BYTES);
  private used = 0;
  /** Native `ftell`: every byte handed to `write`, buffered or already on disk. */
  private written = 0;

  constructor(fd: number) {
    this.fd = fd;
    trackWriter(this);
  }

  /** Native `fwrite( data, 1, length, f )`. */
  writeBytes(data: Uint8Array, offset = 0, length = data.length - offset): void {
    if (this.fd === null) throw new Error('datalib: write to a closed file');
    this.written += length;
    let at = offset;
    const end = offset + length;
    while (at < end) {
      if (this.used === this.buffer.length) this.drain();
      const take = Math.min(this.buffer.length - this.used, end - at);
      this.buffer.set(data.subarray(at, at + take), this.used);
      this.used += take;
      at += take;
    }
  }

  /**
   * Native `fprintf( f, "%s", text )` over a `char *` buffer: one byte per UTF-16 code unit
   * truncated to 8 bits (`encodeLatin1`'s rule, inlined so a line is never a fresh array).
   */
  writeText(text: string): void {
    if (this.fd === null) throw new Error('datalib: write to a closed file');
    const n = text.length;
    this.written += n;
    let i = 0;
    while (i < n) {
      if (this.used === this.buffer.length) this.drain();
      const take = Math.min(this.buffer.length - this.used, n - i);
      const base = this.used;
      for (let k = 0; k < take; k++) this.buffer[base + k] = text.charCodeAt(i + k) & 0xff;
      this.used += take;
      i += take;
    }
  }

  /** Native `ftell( FILE * )`. */
  tell(): number {
    return this.written;
  }

  /** Native `fflush( FILE * )` — hand the buffer to the descriptor now. */
  flush(): void {
    if (this.used > 0) this.drain();
  }

  /** Native `fclose( FILE * )` — flush, then close. Idempotent. */
  close(): void {
    if (this.fd === null) return;
    this.flush();
    closeSync(this.fd);
    this.fd = null;
    untrackWriter(this);
  }

  /** One `write(2)` of everything buffered. */
  private drain(): void {
    const fd = this.fd;
    if (fd === null || this.used === 0) return;
    const length = this.used;
    this.used = 0;
    let at = 0;
    while (at < length) {
      const n = writeSync(fd, this.buffer, at, length - at);
      if (n <= 0) throw new Error('datalib: write(2) made no progress');
      at += n;
    }
  }
}

/**
 * Writers that are still open. Native's `exit()` flushes every open `FILE *`, and a recorder
 * that reaches the end of a run without `fclose` still gets its bytes that way; the port's
 * buffered writers need the same backstop, so the first one installs an `exit` hook.
 */
const openWriters = new Set<BufferedFdWriter>();

let exitHookInstalled = false;

function trackWriter(writer: BufferedFdWriter): void {
  if (!exitHookInstalled) {
    process.on('exit', flushOpenWriters);
    exitHookInstalled = true;
  }
  openWriters.add(writer);
}

function untrackWriter(writer: BufferedFdWriter): void {
  openWriters.delete(writer);
}

/** Native's stdio flush at `exit()`. Never throws on the way out. */
function flushOpenWriters(): void {
  for (const writer of [...openWriters]) {
    try {
      writer.flush();
    } catch {
      /* exiting: a failing flush must not hide the exit status */
    }
  }
}

/** Native `TYPE_FILE` backend: a buffered `fopen( path, "wb" )`. */
export class FileByteSink implements ByteSink {
  private readonly file: BufferedFdWriter;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.file = new BufferedFdWriter(openSync(path, 'w'));
  }

  write(data: Uint8Array): void {
    this.file.writeBytes(data);
  }

  /** Native `ftell( FILE * )`. */
  tell(): number {
    return this.file.tell();
  }

  /** Native `fflush( FILE * )`. */
  flush(): void {
    this.file.flush();
  }

  close(): void {
    this.file.close();
  }
}

/**
 * Native `TYPE_GZIP_FILE`: zlib's `gzopen`, resolved through `AbstractFile::createPath`
 * (so the path gains a `.gz` unless it already ends in one). See the PORT-NOTE at the top:
 * the deflate stream is produced at `close()`.
 */
export class GzipByteSink implements ByteSink {
  private bytes: Uint8Array[] = [];
  private length = 0;
  private closed = false;
  readonly path: string;

  constructor(abstractPath: string) {
    this.path = abstractFilePath(ConcreteFileType.TYPE_GZIP_FILE, abstractPath);
  }

  write(data: Uint8Array): void {
    if (this.closed) throw new Error(`datalib: write to a closed gzip file ${this.path}`);
    this.bytes.push(data.slice());
    this.length += data.length;
  }

  /** Native `gztell( gzFile )` — the *uncompressed* offset. */
  tell(): number {
    return this.length;
  }

  /** Native `flush( full )` -> `gzflush( Z_SYNC_FLUSH )`; deferred to `close()`. */
  flush(_full?: boolean): void {
    /* see PORT-NOTE(w1c/gzip-deferred) */
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const payload = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.bytes) {
      payload.set(chunk, at);
      at += chunk.length;
    }
    this.bytes = [];
    writeFileSync(this.path, gzipContainer(payload));
  }
}

/** Native `AbstractFile::open( type, abstractPath, mode )`. */
export function openAbstractFileWriter(type: ConcreteFileType, abstractPath: string): ByteSink {
  if (type === ConcreteFileType.TYPE_GZIP_FILE) {
    const sink = new GzipByteSink(abstractPath);
    makeParentDir(sink.path);
    return sink;
  }
  if (type === ConcreteFileType.TYPE_FILE) {
    const path = abstractFilePath(ConcreteFileType.TYPE_FILE, abstractPath);
    makeParentDir(path);
    return new FileByteSink(path);
  }
  throw new Error(`datalib: cannot open an AbstractFile of type ${type}`);
}

/** Native `AbstractFile::open( abstractPath, mode )` — probing `.gz` then the plain path. */
export function openAutoFileWriter(abstractPath: string): ByteSink {
  const type = resolveAutoFileType(abstractPath, abstractFileExists);
  if (type === undefined) throw new Error(`datalib: cannot open '${abstractPath}' (not found, native exits)`);
  return openAbstractFileWriter(type, abstractPath);
}

/** Native `AbstractFile::exists( type, abstractPath )`. */
export function abstractFileExists(type: ConcreteFileType, abstractPath: string): boolean {
  return existsSync(abstractFilePath(type, abstractPath));
}

/**
 * Read a recorded artifact's bytes: the plain path, or its `.gz` sibling
 * (`AbstractFile::open`'s auto-detect order, gzip first).
 */
export function readAbstractFileBytes(abstractPath: string): Uint8Array {
  const gzPath = abstractFilePath(ConcreteFileType.TYPE_GZIP_FILE, abstractPath);
  const plainPath = abstractFilePath(ConcreteFileType.TYPE_FILE, abstractPath);
  if (existsSync(gzPath)) return gunzipSync(readFileSync(gzPath));
  if (existsSync(plainPath)) return readFileSync(plainPath);
  throw new Error(`datalib: no such file '${abstractPath}'`);
}
