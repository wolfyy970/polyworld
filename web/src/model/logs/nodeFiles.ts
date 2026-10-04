/**
 * Lane L12 (logs) — the node implementation of the log file seam (`node:fs` / `node:zlib`).
 *
 * Native's loggers write through three concrete file kinds and four `AbstractFile` statics:
 *
 *   FILE *            fopen/fprintf/fflush/fclose          -> `PlainTextSink`
 *   AbstractFile *    fopen or gzopen, by `recordFileType`  -> `PlainTextSink` | `GzipTextSink`
 *   DataLibWriter *   fopen( path, "wb" ) + `ByteSink`      -> `NodeRecordFileSystem.openDataLib`
 *   ::link/::rename/::unlink/stat                            -> `NodeRecordFileSystem.link/…`
 *   makeDirs/makeParentDir (`mkdir -p`)                      -> `NodeRecordFileSystem.*`
 *   SYSTEM( cmd )                                            -> `child_process`
 *
 * PORT-NOTE(l12/node-adapter): this module is the lane's only `node:*` user, exactly like
 * W1c's `datalib/nodeFile.ts`, and it is deliberately **not** re-exported from the lane barrel
 * (`index.ts`), so the browser bundle can import the recorders without pulling in `node:fs`.
 * A browser run supplies its own `RecordFileSystem` (a `Blob`/download-backed sink and an
 * OPFS or download-based `link`) whose gzip path calls `gzipContainer` from
 * `src/model/compress/zlibDeflate.ts` — not `CompressionStream`, which is a different deflate.
 *
 * PORT-NOTE(l12/gzip-append): native's `gzopen( path, "a" )` appends to the deflate stream.
 * The deferred-gzip sink here (chosen for the same reason W1c chose it: no `node:zlib` in the
 * browser, and a mid-file `gzflush` only changes container bytes) cannot append, so an append
 * to a gzip-backed file decompresses the existing bytes, appends, and re-compresses. The
 * *content* is identical to native's; the container bytes need not be. Nothing in the recorded
 * scenarios appends to a gzip file — the only appending recorder, `AdamiComplexityLog`, is
 * disabled (`RecordAdamiComplexity False`) and would write through `fopen` anyway.
 *
 * PORT-NOTE(l12/gzip-upstream-writer): the container is written by the transcribed upstream
 * zlib in `src/model/compress/zlibDeflate.ts`, not by `node:zlib`'s `gzipSync` (the node builds
 * measured here link Google's "motley" zlib fork, 25/150 golden containers — a node linked
 * against upstream zlib 1.2.12 reproduces all 150 with the same call, so the count belongs to
 * the linked zlib, not to node: t_16ac7810; `docs/specs/gzip-containers.md`, task t_431ed2f0).
 * Reading keeps `gunzipSync` — inflate is version-stable.
 */

import { existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

import { ConcreteFileType } from '../types/datalib';
import { DataLibWriter } from '../datalib';
import { abstractFilePath, encodeLatin1, parentDirOf } from '../datalib/sink';
import { BufferedFdWriter, FileByteSink } from '../datalib/nodeFile';
import { gzipContainer } from '../compress/zlibDeflate';
import type { RecordFileSystem, SystemCommand, TextSink } from './seams';

/**
 * Native `fopen( path, mode )` — one `TextSink` per open file.
 *
 * PORT-NOTE(l12/stdio-buffer): native's `fprintf( FILE * )` lands in stdio's buffer and reaches
 * the descriptor when that fills, on `fflush` or on `fclose`; the port's first shape wrote each
 * line with its own `writeSync` (34 % of the 25-agent step loop's wall time; see
 * PORT-NOTE(w1c/stdio-buffer) in `../datalib/nodeFile.ts`, whose `BufferedFdWriter` this reuses,
 * include its `exit`-time flush). The bytes are the same and in the same order — only the
 * syscall count changes — and `flush()` still puts everything on disk mid-run, which is what
 * the recorders that flush before a reader (`AdamiComplexityLog`, `AgentEnergyLog`'s epoch
 * flush) rely on.
 */
class PlainTextSink implements TextSink {
  private file: BufferedFdWriter | null;
  readonly path: string;

  constructor(path: string, mode: 'w' | 'a') {
    this.path = path;
    this.file = new BufferedFdWriter(openSync(path, mode));
  }

  printf(text: string): void {
    if (this.file === null) throw new Error(`logs: write to a closed file ${this.path}`);
    this.file.writeText(text);
  }

  /** Native `fflush( FILE * )`. */
  flush(): void {
    this.file?.flush();
  }

  close(): void {
    if (this.file === null) return;
    this.file.close();
    this.file = null;
  }
}

/**
 * Native `gzopen( path, "w" )`: the path gains a `.gz` (`AbstractFile::createPath`) and the
 * bytes are deflated once, at `close()`.
 */
class GzipTextSink implements TextSink {
  private chunks: Uint8Array[] = [];
  private length = 0;
  private closed = false;
  readonly path: string;

  constructor(abstractPath: string, mode: 'w' | 'a') {
    this.path = abstractFilePath(ConcreteFileType.TYPE_GZIP_FILE, abstractPath);
    if (mode === 'a' && existsSync(this.path)) this.chunks.push(gunzipSync(readFileSync(this.path)));
    this.length = this.chunks.reduce((total, chunk) => total + chunk.length, 0);
  }

  printf(text: string): void {
    if (this.closed) throw new Error(`logs: write to a closed file ${this.path}`);
    const bytes = encodeLatin1(text);
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  /** Native `AbstractFile::flush( full )` -> `gzflush`; deferred to `close()`. */
  flush(): void {
    /* see PORT-NOTE(l12/gzip-append) and (w1c/gzip-deferred) */
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    const payload = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      payload.set(chunk, at);
      at += chunk.length;
    }
    this.chunks = [];

    writeFileSync(this.path, gzipContainer(payload));
  }
}

/**
 * Native's `AbstractFile` static helpers and the two path rules, over `node:fs`.
 * `AbstractFile::exists( abstractPath )` is "either backend", and `link`/`rename` refuse an
 * existing destination *and* an ambiguous source (both backends present) — ported as written.
 */
export class NodeRecordFileSystem implements RecordFileSystem {
  constructor(private readonly recordFileType: ConcreteFileType) {}

  /** Native `makeDirs( path )` (`mkdir -p`). */
  makeDirs(path: string): void {
    if (path.length === 0) return;
    mkdirSync(path, { recursive: true });
  }

  /** Native `makeParentDir( path )` — `makeDirs( dirname( path ) )`. */
  makeParentDir(path: string): void {
    const parent = parentDirOf(path);
    if (parent === '.' || parent.length === 0) return;
    mkdirSync(parent, { recursive: true });
  }

  openPlain(path: string, mode: 'w' | 'a'): TextSink {
    return new PlainTextSink(path, mode);
  }

  openAbstract(path: string, mode: 'w' | 'a'): TextSink {
    if (this.recordFileType === ConcreteFileType.TYPE_GZIP_FILE) return new GzipTextSink(path, mode);
    if (this.recordFileType === ConcreteFileType.TYPE_FILE) return new PlainTextSink(path, mode);
    throw new Error(`logs: AbstractFile of type ${this.recordFileType} (globals::recordFileType unset)`);
  }

  /** Native `new DataLibWriter( path, randomAccess, singleSchema )` — `fopen( path, "wb" )`. */
  openDataLib(path: string, randomAccess: boolean, singleSchema: boolean): DataLibWriter {
    return new DataLibWriter(new FileByteSink(path), randomAccess, singleSchema);
  }

  /** Native `AbstractFile::exists( path )` — true when *either* backend has the file. */
  exists(abstractPath: string): boolean {
    return this.existingType(abstractPath) !== undefined;
  }

  /** Native `AbstractFile::link( old, new )` — `::link`, no-op on a refused pair. */
  link(oldAbstractPath: string, newAbstractPath: string): number {
    return this.relocate(oldAbstractPath, newAbstractPath, linkSync);
  }

  /** Native `AbstractFile::rename( old, new )` — `::rename`, no-op on a refused pair. */
  rename(oldAbstractPath: string, newAbstractPath: string): number {
    return this.relocate(oldAbstractPath, newAbstractPath, renameSync);
  }

  /** Native `AbstractFile::unlink( path )`. */
  unlink(abstractPath: string): number {
    const type = this.existingType(abstractPath);
    if (type === undefined) return -1;
    if (this.isAmbiguous(abstractPath)) return -1;
    unlinkSync(abstractFilePath(type, abstractPath));
    return 0;
  }

  /** Native `SYSTEM( cmd )` — a non-zero status is fatal, as native's macro is. */
  system: SystemCommand = (command: string): void => {
    execSync(command, { stdio: 'inherit' });
  };

  // -------------------------------------------------------------------------

  private relocate(
    oldAbstractPath: string,
    newAbstractPath: string,
    move: (from: string, to: string) => void,
  ): number {
    if (this.exists(newAbstractPath)) return -1;

    const type = this.existingType(oldAbstractPath);
    if (type === undefined) return -1;
    if (this.isAmbiguous(oldAbstractPath)) return -1;

    move(abstractFilePath(type, oldAbstractPath), abstractFilePath(type, newAbstractPath));
    return 0;
  }

  private isAmbiguous(abstractPath: string): boolean {
    return (
      existsSync(abstractFilePath(ConcreteFileType.TYPE_FILE, abstractPath)) &&
      existsSync(abstractFilePath(ConcreteFileType.TYPE_GZIP_FILE, abstractPath))
    );
  }

  private existingType(abstractPath: string): ConcreteFileType | undefined {
    if (existsSync(abstractFilePath(ConcreteFileType.TYPE_GZIP_FILE, abstractPath))) {
      return ConcreteFileType.TYPE_GZIP_FILE;
    }
    if (existsSync(abstractFilePath(ConcreteFileType.TYPE_FILE, abstractPath))) {
      return ConcreteFileType.TYPE_FILE;
    }
    return undefined;
  }
}

/** A `RecordFileSystem` for a run whose `CompressFiles` value `globals::recordFileType` holds. */
export function nodeRecordFileSystem(
  recordFileType: ConcreteFileType = ConcreteFileType.TYPE_FILE,
): RecordFileSystem {
  return new NodeRecordFileSystem(recordFileType);
}

/** Re-exported for callers that need the raw AbstractFile path rules (tests, tools). */
export { abstractFilePath };

/** Native `AbstractFile::open( abstractPath, mode )`'s auto-detect: read the bytes back. */
export function readRecordedBytes(abstractPath: string): Uint8Array {
  const gzPath = abstractFilePath(ConcreteFileType.TYPE_GZIP_FILE, abstractPath);
  if (existsSync(gzPath)) return gunzipSync(readFileSync(gzPath));
  const plainPath = abstractFilePath(ConcreteFileType.TYPE_FILE, abstractPath);
  if (existsSync(plainPath)) return readFileSync(plainPath);
  throw new Error(`logs: no such file '${abstractPath}'`);
}
