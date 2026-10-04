/**
 * Lane L18 (browser wiring) — the browser's `RecordFileSystem`.
 *
 * Lane L12 declares the seam (`src/model/logs/seams.ts:76`) precisely so a run's bytes can land
 * somewhere that is not `node:fs`: "a browser run supplies its own `RecordFileSystem` (a
 * `Blob`/download-backed sink and an OPFS or download-based `link`) whose gzip path calls
 * `gzipContainer` from `src/model/compress/zlibDeflate.ts` — not `CompressionStream`, which is a
 * different deflate" (PORT-NOTE(l12/node-adapter)). This module is that implementation, and it
 * keeps the lane's promise literally: **the bytes the model writes in the page are the bytes the
 * native writes to disk**, because the format code (W1c's `DataLibWriter`, L12's recorders) is
 * shared and only the sink differs.
 *
 * What it is, exactly:
 *
 *   makeDirs/makeParentDir   -> no-op (a `Map` has no directories; paths are opaque keys)
 *   openPlain( path, mode )  -> `MemoryTextSink`   — the raw `fopen` backend
 *   openAbstract( p, mode )  -> gzip? `MemoryGzipSink` : `MemoryTextSink`, path via
 *                               `abstractFilePath` (native `AbstractFile::createPath`)
 *   openDataLib( … )         -> W1c's `DataLibWriter` over `MemoryByteSink`
 *   exists/link/rename/unlink-> the same "either backend" rules node's implementation uses
 *   SYSTEM( cmd )            -> refuses: a page has no shell
 *   recordFileStatusTextStore-> lane L14's `StatusTextStore` over the same seam (the monitor's
 *                               `run/stats/stat.<t>`, native `Monitor.cc:303-320`)
 *
 * PORT-NOTE (L18/browser-fs-gzip): gzip is `gzipContainer` (the transcribed upstream zlib), and
 * the bytes are deflated once, at `close()` — the same deferred-gzip choice W1c and L12's node
 * sink make. An **append** to an existing gzip file is refused loudly instead of being written
 * wrong: appending needs an inflate, and nothing in the recorded scenarios appends to a gzip file
 * (PORT-NOTE(l12/gzip-append) — the one appending recorder, `AdamiComplexityLog`, is disabled).
 * The refusal is the honest failure mode; writing garbage would be a corrupted artifact nobody
 * would notice until the parity harness is re-run.
 *
 * PORT-NOTE (L18/browser-fs-not-a-file-manager): the shell does not pretend this is storage. The
 * run tree lives in memory for as long as the page (or a test) holds it, and `paths()`/`size()`/
 * `bytes()` exist so the shell and the lane's tests can *report* what was produced — the candidate
 * tree the parity harness reads is written from exactly these bytes (`nodeSources.ts`).
 *
 * PORT-NOTE (L18/browser-fs-link): `link` gives the same bytes a second name (native
 * `AbstractFile::link` is POSIX `::link`; the recorders use it for `run/brain/{Recent,bestSoFar,
 * bestRecent}/**`, which are *links* to the per-agent files, not copies) and `rename` moves the
 * name (the brain-function logger renames `incomplete_brainFunction_N` to `brainFunction_N`).
 * Getting that backwards is invisible in the run's own state and silent in the harness — measured
 * while writing this lane: a `link` that moved the bytes made 521 of minitest_voff's 1369 artifacts
 * disappear from the tree while every remaining byte stayed exact. `size()` therefore counts each
 * buffer once, the way `du` counts a hard-linked file once.
 */

import { DataLibWriter, BufferSink, abstractFilePath, encodeLatin1, type ByteSink } from '../../model/datalib';
import { ConcreteFileType } from '../../model/types/datalib';
import { gzipContainer } from '../../model/compress/zlibDeflate';
import type { RecordFileSystem, SystemCommand, TextSink } from '../../model/logs/seams';
import type { StatusTextStore } from '../../model/monitor/statusTextMonitor';

/** A file in the sink: the chunks written so far, in order (materialised only when read). */
interface ChunkBuffer {
  readonly chunks: Uint8Array[];
  length: number;
}

function appendChunk(buffer: ChunkBuffer, bytes: Uint8Array): void {
  buffer.chunks.push(bytes);
  buffer.length += bytes.length;
}

function materialise(buffer: ChunkBuffer): Uint8Array {
  const out = new Uint8Array(buffer.length);
  let at = 0;
  for (const chunk of buffer.chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Native `fopen( path, mode )` into memory.
 *
 * `'w'` truncates at open and every `printf` **appends** — that is what `FILE *` does, and a sink
 * that replaced the bytes on each call would silently truncate every multi-line artifact (measured:
 * `run/BirthsDeaths.log` came out empty, header included). `'a'` continues whatever is there.
 */
class MemoryTextSink implements TextSink {
  readonly path: string;
  private closed = false;

  constructor(
    private readonly buffer: ChunkBuffer,
    path: string,
  ) {
    this.path = path;
  }

  printf(text: string): void {
    if (this.closed) throw new Error(`browserFiles: write to a closed file ${this.path}`);
    appendChunk(this.buffer, encodeLatin1(text));
  }

  /** Native `fflush( FILE * )` — the bytes are already in the buffer. */
  flush(): void {
    /* in memory */
  }

  close(): void {
    this.closed = true;
  }
}

/**
 * Native `gzopen( path, "w" )`: one deflate at `close()`, container bytes from the transcribed
 * zlib. See PORT-NOTE (L18/browser-fs-gzip) for the append refusal.
 */
class MemoryGzipSink implements TextSink {
  readonly path: string;
  private readonly chunks: Uint8Array[] = [];
  private length = 0;
  private closed = false;

  constructor(private readonly files: Map<string, ChunkBuffer>, path: string) {
    this.path = path;
  }

  printf(text: string): void {
    if (this.closed) throw new Error(`browserFiles: write to a closed file ${this.path}`);
    const bytes = encodeLatin1(text);
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  /** Native `AbstractFile::flush( full )` -> `gzflush`; deferred to `close()`. */
  flush(): void {
    /* see PORT-NOTE (L18/browser-fs-gzip) */
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
    this.chunks.length = 0;
    const container = gzipContainer(payload);
    this.files.set(this.path, { chunks: [container], length: container.length });
  }
}

/** A `ByteSink` (W1c) that lands in the same buffer, for `DataLibWriter`'s `fopen( path, "wb" )`. */
class MemoryByteSink implements ByteSink {
  private readonly sink = new BufferSink();
  private closed = false;

  constructor(
    private readonly buffer: ChunkBuffer,
    private readonly path: string,
  ) {}

  write(data: Uint8Array): void {
    if (this.closed) throw new Error(`browserFiles: write to a closed file ${this.path}`);
    appendChunk(this.buffer, data.slice());
    this.sink.write(data);
  }

  tell(): number {
    return this.sink.tell();
  }

  flush(): void {
    this.sink.flush();
  }

  close(): void {
    this.closed = true;
    this.sink.close();
  }
}

/**
 * Lane L12's `RecordFileSystem` over a `Map<string, Uint8Array>`.
 *
 * `recordFileType` is `globals::recordFileType` — native resolves it from the document
 * (`CompressFiles`), which is what decides whether `openAbstract` writes `.gz`; the caller passes
 * it in for the same reason L11's node runner does (`Simulation.cc:4555`).
 */
export class MemoryRecordFileSystem implements RecordFileSystem {
  private readonly files = new Map<string, ChunkBuffer>();

  constructor(private readonly recordFileType: ConcreteFileType = ConcreteFileType.TYPE_FILE) {}

  /** Native `makeDirs( path )` — memory has no directories. */
  makeDirs(path: string): void {
    void path;
  }

  /** Native `makeParentDir( path )`. */
  makeParentDir(path: string): void {
    void path;
  }

  /**
   * Native `fopen( path, mode )`: `'w'` truncates (native creates the file, so `exists()` is true
   * from here on — even for a logger that never writes), `'a'` continues the file's bytes.
   */
  openPlain(path: string, mode: 'w' | 'a'): TextSink {
    return new MemoryTextSink(this.openBuffer(path, mode), path);
  }

  openAbstract(path: string, mode: 'w' | 'a'): TextSink {
    const abstractPath = abstractFilePath(this.recordFileType, path);
    if (this.recordFileType === ConcreteFileType.TYPE_GZIP_FILE) {
      if (mode === 'a' && (this.files.get(abstractPath)?.length ?? 0) > 0) {
        throw new Error(
          `browserFiles: append to the gzip file ${abstractPath} needs an inflate the browser ` +
            'build does not carry (PORT-NOTE(l12/gzip-append): nothing in the recorded scenarios ' +
            'appends to a gzip file)',
        );
      }
      return new MemoryGzipSink(this.files, abstractPath);
    }
    if (this.recordFileType === ConcreteFileType.TYPE_FILE) {
      return new MemoryTextSink(this.openBuffer(abstractPath, mode), abstractPath);
    }
    throw new Error(
      `browserFiles: AbstractFile of type ${this.recordFileType} (globals::recordFileType unset)`,
    );
  }

  /** Native `new DataLibWriter( path, randomAccess, singleSchema )` — `fopen( path, "wb" )`. */
  openDataLib(path: string, randomAccess: boolean, singleSchema: boolean): DataLibWriter {
    return new DataLibWriter(
      new MemoryByteSink(this.openBuffer(path, 'w'), path),
      randomAccess,
      singleSchema,
    );
  }

  /** Native `AbstractFile::exists( path )` — true when *either* backend has the file. */
  exists(abstractPath: string): boolean {
    return (
      this.files.has(abstractFilePath(ConcreteFileType.TYPE_GZIP_FILE, abstractPath)) ||
      this.files.has(abstractFilePath(ConcreteFileType.TYPE_FILE, abstractPath))
    );
  }

  /**
   * Native `AbstractFile::link( old, new )` — `::link`, which gives the *same* bytes a second name
   * (both paths then exist; PORT-NOTE (L18/browser-fs-link) below). Refuses an existing target.
   */
  link(oldAbstractPath: string, newAbstractPath: string): number {
    if (this.exists(newAbstractPath)) return -1;
    const type = this.existingType(oldAbstractPath);
    if (type === undefined) return -1;
    const buffer = this.files.get(abstractFilePath(type, oldAbstractPath));
    if (buffer === undefined) return -1;
    // The same buffer under both names: a hard link, not a copy, so an append through either name
    // is visible through the other (which is what the recorders' link-then-reopen patterns assume).
    this.files.set(abstractFilePath(type, newAbstractPath), buffer);
    return 0;
  }

  /**
   * Native `AbstractFile::rename( old, new )` — a move: the old name is gone afterwards. The
   * brain-function logger relies on this (`incomplete_brainFunction_N` → `brainFunction_N`).
   */
  rename(oldAbstractPath: string, newAbstractPath: string): number {
    if (this.exists(newAbstractPath)) return -1;
    const type = this.existingType(oldAbstractPath);
    if (type === undefined) return -1;
    const from = abstractFilePath(type, oldAbstractPath);
    const buffer = this.files.get(from);
    if (buffer === undefined) return -1;
    this.files.set(abstractFilePath(type, newAbstractPath), buffer);
    this.files.delete(from);
    return 0;
  }

  /** Native `AbstractFile::unlink( path )`. */
  unlink(abstractPath: string): number {
    const type = this.existingType(abstractPath);
    if (type === undefined) return -1;
    this.files.delete(abstractFilePath(type, abstractPath));
    return 0;
  }

  /**
   * Native `SYSTEM( cmd )` (`utils/misc.h:135`). A page cannot run a shell, and the model only
   * reaches this in lockstep mode (`cp LOCKSTEP-BirthsDeaths.log run/`), which no recorded
   * scenario enables — so this refuses rather than silently skipping a step of the run.
   */
  system: SystemCommand = (command: string): void => {
    throw new Error(`browserFiles: SYSTEM('${command}') — a browser run has no shell`);
  };

  // -------------------------------------------------------------------------
  // the lane's own view of what the run produced (reporting, the candidate tree)
  // -------------------------------------------------------------------------

  /** Every path written so far, sorted (a stable order for a diff or a tree listing). */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  /** The bytes at `path`, or `undefined`. */
  bytes(path: string): Uint8Array | undefined {
    const buffer = this.files.get(path);
    return buffer === undefined ? undefined : materialise(buffer);
  }

  /** The bytes at `path` decoded latin-1 (the encoding the recorders write), or `undefined`. */
  text(path: string): string | undefined {
    const bytes = this.bytes(path);
    if (bytes === undefined) return undefined;
    let out = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return out;
  }

  /** Total bytes held, for the panel's honesty about what is sitting in memory (links count once). */
  size(): number {
    let total = 0;
    const seen = new Set<ChunkBuffer>();
    for (const buffer of this.files.values()) {
      if (seen.has(buffer)) continue;
      seen.add(buffer);
      total += buffer.length;
    }
    return total;
  }

  /** How many files the run wrote. */
  count(): number {
    return this.files.size;
  }

  // -------------------------------------------------------------------------

  /**
   * Native `fopen`'s create/truncate half: `'w'` starts a fresh buffer, `'a'` reuses the file's.
   */
  private openBuffer(path: string, mode: 'w' | 'a'): ChunkBuffer {
    if (mode === 'a') {
      const existing = this.files.get(path);
      if (existing !== undefined) return existing;
    }
    const buffer: ChunkBuffer = { chunks: [], length: 0 };
    this.files.set(path, buffer);
    return buffer;
  }

  private existingType(abstractPath: string): ConcreteFileType | undefined {
    if (this.files.has(abstractFilePath(ConcreteFileType.TYPE_GZIP_FILE, abstractPath))) {
      return ConcreteFileType.TYPE_GZIP_FILE;
    }
    if (this.files.has(abstractFilePath(ConcreteFileType.TYPE_FILE, abstractPath))) {
      return ConcreteFileType.TYPE_FILE;
    }
    return undefined;
  }
}

/**
 * Lane L14's `StatusTextStore` (native `Monitor.cc:303-320`) over the run's own file system.
 *
 * Native's `StatusTextMonitor` does, per stored step,
 *
 * ```
 *   sprintf( statusFileName, "run/stats/stat.%ld", timestep );
 *   makeParentDir( statusFileName );
 *   FILE *statusFile = fopen( statusFileName, "w" );      // ERRIF( null )
 *   for each line: fprintf( statusFile, "%s\n", line );
 *   fclose( statusFile );
 * ```
 *
 * and lane L14 injects that write precisely because a browser has no `fopen`
 * (PORT-NOTE(monitor/status-text-file-write)). This is the browser's implementation, and it is
 * deliberately written **against the `RecordFileSystem` seam**, not against
 * `MemoryRecordFileSystem`: `makeParentDir` + `openPlain( path, 'w' )` + `printf` + `close` is
 * native's own sequence, so the same three lines serve the page's in-memory sink and node's
 * (`runner.ts::nodeStatusTextStore` is the node-side twin, with the same semantics spelled out as
 * `mkdirSync` + `writeFileSync( …, 'latin1' )`).
 *
 * The path is the monitor's own `run/stats/stat.<timestep>` — relative to the run tree, like every
 * other artifact the run writes — so it lands in the same sink the simulation's recorders write
 * through and shows up in the page's `run files` report and in the parity candidate tree. The bytes
 * are latin-1 (`encodeLatin1`), because the status text carries the `\xb1` of the `±` statistics.
 *
 * PORT-NOTE (L18/status-text-store): `'w'` is native's truncate — the sink creates an empty buffer
 * at open and every `printf` appends, which is also why the store hands the whole body over in one
 * call and closes: an `openPlain` that never closed would leave nothing in the gzip case, and here
 * the `TYPE_FILE` path is the one the recorded scenarios take.
 */
export function recordFileStatusTextStore(fs: RecordFileSystem): StatusTextStore {
  return {
    writeTextFile: (path, text) => {
      fs.makeParentDir(path);
      const sink = fs.openPlain(path, 'w');
      sink.printf(text);
      sink.close();
    },
  };
}
