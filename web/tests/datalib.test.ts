/**
 * W1c — acceptance tests for the datalib columnar log format (`src/library/utils/datalib.cc`
 * plus the file/compression half of `utils/AbstractFile.cc`).
 *
 * The card's acceptance, encoded:
 *   - `run/lifespans.txt` and `run/BirthsDeaths.log` are reproduced **byte-for-byte** from a
 *     fixed set of rows and diffed against the recorded goldens;
 *   - every datalib artifact the oracle recorded is re-written from its own parsed rows and
 *     diffed byte-for-byte (the strongest available statement of format fidelity: the footer
 *     digest encodes byte offsets, so one wrong byte anywhere moves them);
 *   - `%f` matches clang/glibc, not `toFixed` (the tie rule differs — see `printf.ts`);
 *   - the zlib gzip path produces the same bytes as native `gzopen`.
 *
 * The goldens live in `oracle/<scenario>/run/**` and are **gitignored** (~35 MB), so the
 * golden-dependent tests skip when they are absent (a lane worktree can point
 * `POLYWORLD_ORACLE_ROOT` at the canonical tree; the main tree always has them). Nothing
 * here writes to `oracle/**`.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { BirthReason, DeathReason, birthReasonName, deathReasonName } from '../src/model/types/lifespan';
import {
  BIRTHS_DEATHS_HEADER,
  BirthsDeathsLog,
  BufferSink,
  ColumnType,
  DataLibFormatError,
  DataLibReader,
  DataLibWriter,
  abstractFilePath,
  applyFormatSpec,
  defaultColumnFormat,
  formatBirthLine,
  formatColumn,
  formatDeathLine,
  formatFixed,
  parseFormatSpec,
  type ColumnSpec,
} from '../src/model/datalib';
import {
  GzipByteSink,
  abstractFileExists,
  openAbstractFileWriter,
  openAutoFileWriter,
  readAbstractFileBytes,
} from '../src/model/datalib/nodeFile';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORACLE = join(REPO, 'oracle');
const MICRO = join(ORACLE, 'microtest_voff', 'run');
const MINI = join(ORACLE, 'minitest_voff', 'run');
const GOLDENS_PRESENT = existsSync(join(MICRO, 'lifespans.txt')) && existsSync(join(MINI, 'lifespans.txt'));

const work = mkdtempSync(join(tmpdir(), 'pw-datalib-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/**
 * True when the local toolchain can build a zlib reference program (macOS SDK zlib.h + `-lz`).
 * Computed at module scope so `it.skipIf` can see it during collection.
 */
const HAVE_CLANG_ZLIB = (() => {
  if (spawnSync('clang', ['--version'], { encoding: 'utf8' }).status !== 0) return false;
  const dir = mkdtempSync(join(tmpdir(), 'pw-zlib-'));
  try {
    writeFileSync(join(dir, 'probe.c'), '#include <zlib.h>\nint main(void){ return Z_OK == 0 ? 1 : 0; }\n');
    return spawnSync('clang', ['-O0', '-o', join(dir, 'probe'), join(dir, 'probe.c'), '-lz'], { encoding: 'utf8' }).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

/** Native `Logs::LifeSpanLog::init` schema (`logs/Logs.cc:1610`). */
const LIFESPANS_COLUMNS: readonly ColumnSpec[] = [
  { name: 'Agent', type: ColumnType.INT },
  { name: 'BirthStep', type: ColumnType.INT },
  { name: 'BirthReason', type: ColumnType.STRING },
  { name: 'DeathStep', type: ColumnType.INT },
  { name: 'DeathReason', type: ColumnType.STRING },
];

/**
 * The rows `microtest_voff` records, in the order the death events arrived (native writes
 * `lifespans.txt` in `AgentDeathEvent` order, which is not agent order). Every agent is born
 * at step 0 (`SIMINIT`) and dies at step 1 (`SIMEND`, MaxSteps 1).
 */
const MICROTEST_LIFESPANS_ROWS: readonly (readonly [number, number])[] = [
  [3, 1], [6, 1], [11, 1], [12, 1], [23, 1], [14, 1], [1, 1], [21, 1], [13, 1], [20, 1],
  [18, 1], [17, 1], [24, 1], [15, 1], [2, 1], [5, 1], [25, 1], [10, 1], [19, 1], [7, 1],
  [16, 1], [4, 1], [22, 1], [8, 1], [9, 1],
];

/**
 * Native `Logs::AgentPositionLog::init` passes explicit formats (`logs/Logs.cc:345`); the
 * reader cannot recover them (writer-only state — see the PORT-NOTE in `reader.ts`), so the
 * corpus round-trip re-supplies them by table name.
 */
const TABLE_FORMATS: Readonly<Record<string, readonly string[]>> = {
  Positions: ['%d', '%.2f', '%.2f'],
};

function expectBytes(actual: Uint8Array, goldenPath: string): void {
  const golden = new Uint8Array(readFileSync(goldenPath));
  if (actual.length === golden.length && Buffer.compare(Buffer.from(actual), Buffer.from(golden)) === 0) return;

  let at = -1;
  const limit = Math.min(actual.length, golden.length);
  for (let i = 0; i < limit; i++) {
    if (actual[i] !== golden[i]) {
      at = i;
      break;
    }
  }
  const from = Math.max(0, (at < 0 ? limit : at) - 60);
  const window = (bytes: Uint8Array) => JSON.stringify(Buffer.from(bytes.subarray(from, from + 140)).toString('latin1'));
  throw new Error(
    `${relative(REPO, goldenPath)}: bytes differ (candidate ${actual.length} bytes, golden ${golden.length} bytes, ` +
      `first difference at ${at})\n  at ${from}: golden    ${window(golden)}\n  at ${from}: candidate ${window(actual)}`,
  );
}

/** A file whose first bytes are the datalib signature (reads 9 bytes, not the whole file). */
function isDataLibFile(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(9);
    const n = readSync(fd, head, 0, 9, 0);
    return head.subarray(0, n).toString('latin1').startsWith('#datalib');
  } finally {
    closeSync(fd);
  }
}

function collectDataLibFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...collectDataLibFiles(path));
    else if (entry.isFile() && statSync(path).size > 0 && isDataLibFile(path)) out.push(path);
  }
  return out.sort();
}

/** Re-write a recorded datalib file from its own parsed content, using its own header flags. */
function rewriteThroughPort(path: string): { candidate: Uint8Array; tables: number; rows: number } {
  const reader = new DataLibReader(new Uint8Array(readFileSync(path)));
  const sink = new BufferSink();
  const writer = new DataLibWriter(sink, reader.isRandomAccess(), reader.isSingleSchema());

  let tables = 0;
  let rows = 0;
  for (const tableName of reader.tableNames()) {
    if (!reader.seekTable(tableName)) throw new Error(`${path}: table '${tableName}' not found`);
    const columns: ColumnSpec[] = reader.columnNames().map((name, i) => ({ name, type: reader.columnTypes()[i]! }));
    writer.beginTable(tableName, columns, TABLE_FORMATS[tableName]);
    for (const row of reader.allRows()) {
      writer.addRow(row);
      rows++;
    }
    writer.endTable();
    tables++;
  }
  writer.close();
  return { candidate: sink.bytes(), tables, rows };
}

function doubleFromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, Number.parseInt(hex.slice(0, 8), 16));
  view.setUint32(4, Number.parseInt(hex.slice(8, 16), 16));
  return view.getFloat64(0);
}

interface CPrintfVector {
  readonly bits?: string;
  readonly int?: number;
  readonly str?: string;
  readonly fmt: string;
  readonly out: string;
}

/** The expected output of a vector generated by clang/glibc (see the fixture block below). */
function cVector(bits: string, fmt: string): string {
  const found = C_PRINTF_VECTORS.find((vector) => vector.bits === bits && vector.fmt === fmt);
  if (!found) throw new Error(`no reference vector for ${fmt} of ${bits}`);
  return found.out;
}

describe.skipIf(!GOLDENS_PRESENT)('DataLibWriter — run/lifespans.txt byte parity', () => {
  it('reproduces oracle/microtest_voff/run/lifespans.txt from the recorded rows', () => {
    const sink = new BufferSink();
    const writer = new DataLibWriter(sink);
    writer.beginTable('LifeSpans', LIFESPANS_COLUMNS);
    for (const [agent, deathStep] of MICROTEST_LIFESPANS_ROWS) {
      writer.addRow([agent, 0, birthReasonName(BirthReason.SIMINIT), deathStep, deathReasonName(DeathReason.SIMEND)]);
    }
    writer.close();

    expectBytes(sink.bytes(), join(MICRO, 'lifespans.txt'));
    // the footer digest native recorded for this table (offset/data/nrows/rowlen)
    expect(writer.tableMetaData()).toEqual([{ name: 'LifeSpans', offset: 51, data: 276, nrows: 25, rowlen: 0 }]);
  });

  it('reads the golden back with the same schema, digest and rows', () => {
    const reader = new DataLibReader(new Uint8Array(readFileSync(join(MICRO, 'lifespans.txt'))));
    expect(reader.isSingleSchema()).toBe(true);
    expect(reader.isRandomAccess()).toBe(false);
    expect(reader.tableNames()).toEqual(['LifeSpans']);
    expect(reader.tableMetaData('LifeSpans')).toEqual({ name: 'LifeSpans', offset: 51, data: 276, nrows: 25, rowlen: 0 });
    expect(reader.seekTable('LifeSpans')).toBe(true);
    expect(reader.columnNames()).toEqual(['Agent', 'BirthStep', 'BirthReason', 'DeathStep', 'DeathReason']);
    expect(reader.columnTypes()).toEqual([
      ColumnType.INT,
      ColumnType.INT,
      ColumnType.STRING,
      ColumnType.INT,
      ColumnType.STRING,
    ]);
    expect(reader.position()).toBe(-1);
    expect(reader.nextRow()).toBe(true);
    expect(reader.row()).toEqual({
      Agent: 3,
      BirthStep: 0,
      BirthReason: 'SIMINIT',
      DeathStep: 1,
      DeathReason: 'SIMEND',
    });
    expect(reader.col('Agent')).toBe(3);
    reader.seekRow(-1);
    expect(reader.rowValues()).toEqual([9, 0, 'SIMINIT', 1, 'SIMEND']);
    expect(reader.allRows()).toHaveLength(25);
    expect(reader.allRows().map((row) => row[0])).toEqual(MICROTEST_LIFESPANS_ROWS.map(([agent]) => agent));
  });
});

describe.skipIf(!GOLDENS_PRESENT)('run/BirthsDeaths.log byte parity', () => {
  it('writes the header only when every birth is SIMINIT and every death is SIMEND', () => {
    const sink = new BufferSink();
    const log = new BirthsDeathsLog(sink);
    for (const [agent] of MICROTEST_LIFESPANS_ROWS) {
      log.birth(0, BirthReason.SIMINIT, agent, 0, 0);
      log.death(1, DeathReason.SIMEND, agent);
    }
    log.close();

    expect(log.lineCount()).toBe(0);
    expectBytes(sink.bytes(), join(MICRO, 'BirthsDeaths.log'));
  });

  it('reproduces the 126 recorded birth/death lines of minitest_voff', () => {
    const goldenPath = join(MINI, 'BirthsDeaths.log');
    const goldenLines = readFileSync(goldenPath, 'latin1').split('\n');
    expect(`${goldenLines[0]!}\n`).toBe(BIRTHS_DEATHS_HEADER);
    const events = goldenLines.slice(1).filter((line) => line !== '');
    expect(events).toHaveLength(126); // 62 BIRTH + 64 DEATH

    const sink = new BufferSink();
    const log = new BirthsDeathsLog(sink);
    let births = 0;
    let deaths = 0;
    for (const line of events) {
      const fields = line.split(' ');
      const step = Number(fields[0]);
      if (fields[1] === 'BIRTH') {
        expect(fields).toHaveLength(5);
        log.birth(step, BirthReason.NATURAL, Number(fields[2]), Number(fields[3]), Number(fields[4]));
        births++;
      } else if (fields[1] === 'DEATH') {
        expect(fields).toHaveLength(3);
        // the golden does not record which non-SIMEND reason fired; native only special-cases
        // DR_SIMEND, so every other reason produces this same line — pin that here too
        for (const reason of Object.values(DeathReason)) {
          if (reason === DeathReason.SIMEND) continue;
          expect(formatDeathLine(step, reason, Number(fields[2]))).toBe(`${line}\n`);
        }
        log.death(step, DeathReason.NATURAL, Number(fields[2]));
        deaths++;
      } else {
        throw new Error(`unexpected event '${line}'`);
      }
    }
    log.close();

    expect([births, deaths]).toEqual([62, 64]);
    expect(log.lineCount()).toBe(126);
    expectBytes(sink.bytes(), goldenPath);
  });

  it('formats the event variants native prints (VIRTUAL, CREATION, non-SIMEND deaths)', () => {
    expect(formatBirthLine(7, BirthReason.NATURAL, 26, 3, 20)).toBe('7 BIRTH 26 3 20\n');
    expect(formatBirthLine(7, BirthReason.LOCKSTEP, 26, 3, 20)).toBe('7 BIRTH 26 3 20\n');
    expect(formatBirthLine(7, BirthReason.VIRTUAL, 26, 3, 20)).toBe('7 VIRTUAL 0 3 20\n');
    expect(formatBirthLine(7, BirthReason.CREATE, 26, 0, 0)).toBe('7 CREATION 26\n');
    expect(formatBirthLine(7, BirthReason.SIMINIT, 26, 0, 0)).toBe('');
    expect(formatDeathLine(7, DeathReason.SIMEND, 26)).toBe('');
    expect(formatDeathLine(7, DeathReason.FIGHT, 26)).toBe('7 DEATH 26\n');
    expect(() => formatBirthLine(7, BirthReason.INVALID, 26, 0, 0)).toThrow(/no BirthsDeaths\.log line/);
  });
});

describe.skipIf(!GOLDENS_PRESENT)('columnar artifacts recorded by the oracle', () => {
  it('re-writes every datalib file the oracle recorded, byte-for-byte', () => {
    const scenarios = [
      { name: 'microtest_voff', root: MICRO, minimum: 60 },
      { name: 'minitest_voff', root: MINI, minimum: 184 },
    ];

    for (const scenario of scenarios) {
      const files = collectDataLibFiles(scenario.root);
      expect(files.length, `${scenario.name}: datalib files found`).toBeGreaterThanOrEqual(scenario.minimum);

      const mismatches: string[] = [];
      let tables = 0;
      let rows = 0;
      for (const path of files) {
        const rewritten = rewriteThroughPort(path);
        tables += rewritten.tables;
        rows += rewritten.rows;
        try {
          expectBytes(rewritten.candidate, path);
        } catch (error) {
          mismatches.push((error as Error).message);
        }
      }
      // eslint-disable-next-line no-console
      console.log(`${scenario.name}: ${files.length} datalib files, ${tables} tables, ${rows} rows re-written`);
      expect(mismatches, mismatches.join('\n\n')).toEqual([]);
    }
  });

  it('covers the recorded header variants (schema single/table x colformat none/fixed)', () => {
    const seen = new Set<string>();
    for (const path of collectDataLibFiles(MICRO)) {
      const reader = new DataLibReader(new Uint8Array(readFileSync(path)));
      seen.add(`${reader.isSingleSchema() ? 'single' : 'table'}/${reader.isRandomAccess() ? 'fixed' : 'none'}`);
    }
    expect([...seen].sort()).toEqual(['single/none', 'table/fixed', 'table/none']);
    // minitest adds the padded fixed-length per-agent energy logs on top of the same three
    expect(collectDataLibFiles(MINI).length).toBeGreaterThanOrEqual(184);
  });

  it('keeps the digest bookkeeping of the 24-table genome log', () => {
    const reader = new DataLibReader(new Uint8Array(readFileSync(join(MICRO, 'genome', 'separations.txt'))));
    expect(reader.isSingleSchema()).toBe(false);
    expect(reader.tableNames().slice(0, 4)).toEqual(['3', '6', '11', '12']);
    expect(reader.tableNames()).toHaveLength(24);
    expect(reader.tableMetaData('3')).toEqual({ name: '3', offset: 50, data: 150, nrows: 22, rowlen: 0 });
    expect(reader.tableMetaData('24')).toEqual({ name: '24', offset: 3015, data: 3116, nrows: 1, rowlen: 0 });
    expect(reader.seekTable('24')).toBe(true);
    expect(reader.allRows()).toEqual([[25, 0]]);
  });
});

describe('DataLibWriter — native assert parity', () => {
  it('refuses a second table in a single-schema file (`assert( tables.empty() || !singleSchema )`)', () => {
    const writer = new DataLibWriter(new BufferSink());
    writer.beginTable('A', [{ name: 'x', type: ColumnType.INT }]);
    writer.addRow([1]);
    writer.endTable();
    expect(() => writer.beginTable('B', [{ name: 'y', type: ColumnType.INT }])).toThrow(/single-schema/);
  });

  it('accepts many tables in a table-schema file, with a digest entry each', () => {
    const sink = new BufferSink();
    const writer = new DataLibWriter(sink, false, false);
    for (const name of ['a', 'b']) {
      writer.beginTable(name, [{ name: 'n', type: ColumnType.INT }]);
      writer.addRow([1]);
      writer.endTable();
    }
    writer.close();

    const reader = new DataLibReader(sink.bytes());
    expect(reader.isSingleSchema()).toBe(false);
    expect(reader.tableNames()).toEqual(['a', 'b']);
    expect(reader.tableMetaData('b')!.nrows).toBe(1);
  });

  it('enforces fixed-length records on the randomAccess path (`assert( nwrite == rowlen )`)', () => {
    // the padded default formats give every row the same length, so an unpadded format is
    // what exposes the check (native asserts on the *second* row that differs)
    const writer = new DataLibWriter(new BufferSink(), true, false);
    writer.beginTable('T', [{ name: 'n', type: ColumnType.INT }], ['%d']);
    writer.addRow([1]);
    expect(() => writer.addRow([22])).toThrow(/fixed-length record/);
  });
});

describe('DataLibReader', () => {
  it('rejects a non-datalib file, a bad version and an unknown table/column', () => {
    expect(() => new DataLibReader(new Uint8Array(Buffer.from('nope\n')))).toThrow(DataLibFormatError);
    expect(() => new DataLibReader(new Uint8Array(Buffer.from('#datalib\n#version=9\n')))).toThrow(/unsupported version/);

    const sink = new BufferSink();
    const writer = new DataLibWriter(sink);
    writer.beginTable('T', [{ name: 'x', type: ColumnType.INT }]);
    writer.addRow([1]);
    writer.close();
    const reader = new DataLibReader(sink.bytes());
    expect(reader.seekTable('missing')).toBe(false);
    expect(() => reader.nrows()).toThrow(/no table selected/);
    reader.seekTable('T');
    expect(() => reader.col('missing')).toThrow(/no column 'missing'/);
    expect(() => reader.seekRow(5)).toThrow(/out of range/);
  });

  it('reads a pre-version-3 file as table-schema + fixed records (native parseHeader)', () => {
    // native v2 files carry no #schema/#colformat lines: version < 3 *implies* table/fixed
    const head = '#datalib\n#version=2\n';
    const schema = '\n#<Fixed>\n#@L A                   \n#\n#@T int                 \n#\n';
    const rows = '7                   \n8                   \n';
    const offset = head.length;
    const data = offset + schema.length;
    const digestStart = data + rows.length;
    const digest = `\n#TABLES 1\n# Fixed ${offset} ${data} 2 21\n`;
    const file = `${head}${schema}${rows}${digest}#START ${digestStart}\n#SIZE ${digest.length}`;

    const reader = new DataLibReader(new Uint8Array(Buffer.from(file, 'latin1')));
    expect(reader.isSingleSchema()).toBe(false);
    expect(reader.isRandomAccess()).toBe(true);
    expect(reader.seekTable('Fixed')).toBe(true);
    expect(reader.nrows()).toBe(2);
    expect(reader.allRows()).toEqual([[7], [8]]);
  });

  it('cannot read a bool column, because native cannot (its row parser asserts)', () => {
    const sink = new BufferSink();
    const writer = new DataLibWriter(sink);
    writer.beginTable('T', [
      { name: 'flag', type: ColumnType.BOOL },
      { name: 'n', type: ColumnType.INT },
    ]);
    writer.addRow([true, 3]);
    writer.close();
    const reader = new DataLibReader(sink.bytes());
    reader.seekTable('T');
    expect(() => reader.nextRow()).toThrow(/cannot read a column of type bool/);
  });
});

describe('printf compatibility', () => {
  it('matches clang/glibc printf for %f, %.2f, %-20f, %d, %5d, %-20d, %s, %-20s', () => {
    let checked = 0;
    for (const vector of C_PRINTF_VECTORS) {
      const value = vector.bits !== undefined ? doubleFromBits(vector.bits) : (vector.int ?? vector.str ?? '');
      const actual = applyFormatSpec(parseFormatSpec(vector.fmt), value);
      expect(actual, `${vector.fmt} of ${vector.bits ?? vector.int ?? JSON.stringify(vector.str)}`).toBe(vector.out);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(160);
  });

  it('rounds %f ties like glibc (to even), which toFixed does not', () => {
    expect(formatFixed(0.0078125, 6)).toBe('0.007812');
    expect((0.0078125).toFixed(6)).toBe('0.007813'); // the trap this port avoids
    expect(formatFixed(0.125, 2)).toBe('0.12');
    expect(formatFixed(0.375, 2)).toBe('0.38');
    expect(formatFixed(-0.001, 2)).toBe('-0.00');
    expect(formatFixed(-0, 2)).toBe('-0.00');
    expect(formatFixed(1e-7, 6)).toBe(cVector('3e7ad7f29abcaf48', '%f'));
    expect(formatFixed(Number.MIN_VALUE * 2 ** 52, 6)).toBe(cVector('0010000000000000', '%f'));
    expect(formatFixed(Number.MAX_VALUE, 6)).toBe(cVector('7fefffffffffffff', '%f'));
    expect(formatFixed(1.5, 340)).toBe(`1.5${'0'.repeat(339)}`);
  });

  it('stores float columns as float32 before formatting (native `float`, PORT_SPEC rule 3)', () => {
    expect(formatColumn('%f', ColumnType.FLOAT, 123456.78999999)).toBe(cVector('40fe240ca0000000', '%f'));
    expect(formatColumn('%.2f', ColumnType.FLOAT, 5.05)).toBe(cVector('4014333340000000', '%.2f'));
    expect(formatColumn('%.2f', ColumnType.FLOAT, -0.47)).toBe(cVector('bfde147ae0000000', '%.2f'));
    expect(formatColumn('%f', ColumnType.FLOAT, 739.6690673828125)).toBe(cVector('40871d5a40000000', '%f'));
    expect(formatColumn('%f', ColumnType.FLOAT, 750.9804077148438)).toBe(cVector('408777d7e0000000', '%f'));
    // a bool column prints as %d, like native's `case datalib::BOOL: TOBUF(bool)`
    expect(formatColumn('%d', ColumnType.BOOL, true)).toBe('1');
    expect(formatColumn('%d', ColumnType.BOOL, false)).toBe('0');
  });

  it('picks native default formats per type (padded when randomAccess)', () => {
    expect(defaultColumnFormat(ColumnType.INT, false)).toBe('%d');
    expect(defaultColumnFormat(ColumnType.FLOAT, false)).toBe('%f');
    expect(defaultColumnFormat(ColumnType.STRING, false)).toBe('%s');
    expect(defaultColumnFormat(ColumnType.INT, true)).toBe('%-20d');
    expect(defaultColumnFormat(ColumnType.FLOAT, true)).toBe('%-20f');
    expect(defaultColumnFormat(ColumnType.STRING, true)).toBe('%-20s');
    expect(() => parseFormatSpec('%q')).toThrow(/unsupported column format/);
    expect(() => parseFormatSpec('%e')).toThrow(/not used by native datalib/);
  });
});

describe('gzip file path (native AbstractFile TYPE_GZIP_FILE)', () => {
  it('appends .gz like native createPath, and reads it back through the auto-detect order', () => {
    expect(abstractFilePath(1, 'run/file.txt')).toBe('run/file.txt'); // TYPE_FILE
    expect(abstractFilePath(1, 'run/file.txt.gz')).toBe('run/file.txt'); // strips the suffix
    expect(abstractFilePath(2, 'run/file.txt')).toBe('run/file.txt.gz'); // TYPE_GZIP_FILE
    expect(abstractFilePath(2, 'run/file.txt.gz')).toBe('run/file.txt.gz');

    const payload = 'i = 000000, i * 1.5 = 0.000000\n'.repeat(100);
    mkdirSync(join(work, 'gz'), { recursive: true });
    const sink = new GzipByteSink(join(work, 'gz', 'reference.bin'));
    expect(sink.path).toBe(join(work, 'gz', 'reference.bin.gz'));
    sink.write(new Uint8Array(Buffer.from(payload, 'latin1')));
    expect(sink.tell()).toBe(payload.length); // native gztell() is the *uncompressed* offset
    sink.flush(true);
    sink.close();

    const written = readFileSync(sink.path);
    // gzip container header: magic, deflate, no flags, mtime 0, XFL 0, OS 0x13 — measured
    // identical from zlib's gzopen and node's zlib on this platform (see the skipIf test)
    expect(written.subarray(0, 10).toString('hex')).toBe('1f8b0800000000000013');
    // the auto-detect reader finds the .gz sibling and hands back the plain bytes
    expect(Buffer.from(readAbstractFileBytes(join(work, 'gz', 'reference.bin'))).toString('latin1')).toBe(payload);
    expect(abstractFileExists(2, join(work, 'gz', 'reference.bin'))).toBe(true);
    expect(abstractFileExists(1, join(work, 'gz', 'reference.bin'))).toBe(false);

    const viaPort = new GzipByteSink(join(work, 'gz', 'port.bin'));
    viaPort.write(new Uint8Array(Buffer.from(payload, 'latin1')));
    viaPort.close();
    expect(readFileSync(viaPort.path).equals(written)).toBe(true);

    const plain = openAbstractFileWriter(1, join(work, 'gz', 'plain.bin'));
    plain.write(new Uint8Array(Buffer.from('plain\n', 'latin1')));
    plain.close();
    expect(readFileSync(join(work, 'gz', 'plain.bin'), 'latin1')).toBe('plain\n');

    // no .gz sibling for this path, so the auto-detect open resolves to the plain file
    const auto = openAutoFileWriter(join(work, 'gz', 'plain.bin'));
    auto.write(new Uint8Array(Buffer.from('plain2\n', 'latin1')));
    auto.close();
    expect(readFileSync(join(work, 'gz', 'plain.bin'), 'latin1')).toBe('plain2\n');
  });

  it.skipIf(!HAVE_CLANG_ZLIB)('produces the same bytes as native zlib gzopen/gzwrite/gzclose', () => {
    const dir = mkdtempSync(join(work, 'clang-'));
    const src = join(dir, 'gzref.c');
    const bin = join(dir, 'gzref');
    const out = join(dir, 'ref.gz');
    writeFileSync(
      src,
      [
        '#include <stdio.h>',
        '#include <string.h>',
        '#include <zlib.h>',
        'int main(int argc, char **argv) {',
        '  gzFile gz = gzopen(argv[1], "wb");',
        '  if (!gz) return 1;',
        '  const char *payload = "i = 000000, i * 1.5 = 0.000000\\n";',
        '  for (int i = 0; i < 100; i++) gzwrite(gz, payload, (unsigned) strlen(payload));',
        '  return gzclose(gz) == Z_OK ? 0 : 1;',
        '}',
        '',
      ].join('\n'),
    );
    const build = spawnSync('clang', ['-O0', '-o', bin, src, '-lz'], { encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
    expect(spawnSync(bin, [out], { encoding: 'utf8' }).status).toBe(0);

    const payload = 'i = 000000, i * 1.5 = 0.000000\n'.repeat(100);
    const sink = new GzipByteSink(join(dir, 'port.bin'));
    sink.write(new Uint8Array(Buffer.from(payload, 'latin1')));
    sink.close();

    // byte-identical to zlib's gzopen stream (67 bytes for this payload)
    const reference = readFileSync(out);
    const produced = readFileSync(sink.path);
    expect(produced.length).toBe(reference.length);
    expect(produced.equals(reference)).toBe(true);
  });
});

/**
 * C reference vectors for the column-format machinery, generated on this machine
 * (Apple clang 21.0.0 / glibc-less macOS libsystem printf, zlib 1.3.1, 2026-09-28) by a
 * program that prints `snprintf` output for the doubles whose exact IEEE-754 bit patterns
 * are listed below, plus the integer/string conversions native datalib uses. Regenerate
 * with the same program if a libc change is ever suspected:
 *
 *   clang -O0 -o ref ref.c && ./ref > vectors.json
 *
 * `bits` is a double given as a 64-bit pattern, so both sides format the identical value
 * (no decimal-literal parsing in between). The tie cases (0.0078125 at %f, 0.125 at %.2f,
 * 123456.7890625 at %f) are the ones `Number.prototype.toFixed` gets wrong.
 */
/**
 * C reference vectors for the column-format machinery, generated on this machine
 * (Apple clang 21.0.0 / macOS libsystem printf, 2026-09-28) by a program that prints
 * `snprintf` output for the doubles whose exact IEEE-754 bit patterns are listed here, plus
 * the integer/string conversions native datalib uses. Regenerate by re-running that program
 * if a libc change is ever suspected.
 *
 * `bits` is a double given as its 64-bit pattern, so both sides format the identical value
 * (no decimal-literal parsing in between); the trailing comment is `%.17g` of that pattern.
 * The tie cases (0.0078125 at %f, 0.125 at %.2f, 123456.7890625 at %f) are the ones
 * `Number.prototype.toFixed` gets wrong.
 */
/**
 * C reference vectors for the column-format machinery, generated on this machine
 * (Apple clang 21.0.0 / macOS libsystem printf, 2026-09-28) by a ~40-line C program: bit
 * patterns in, `snprintf` out. That generator is deliberately not committed, so this test
 * (a lane gate) never needs a C toolchain — the gzip test below is the one that compiles C,
 * and it skips when clang/zlib is absent.
 *
 * `bits` is a double given as its 64-bit pattern, so both sides format the identical value
 * (no decimal-literal parsing in between); the trailing comment is `%.17g` of that pattern.
 * The tie cases (0.0078125 at %f, 0.125 at %.2f, 123456.7890625 at %f) are the ones
 * `Number.prototype.toFixed` gets wrong.
 */
const C_PRINTF_VECTORS: readonly CPrintfVector[] = [
  { bits: "0000000000000000", fmt: "%f", out: "0.000000" }, // 0
  { bits: "0000000000000000", fmt: "%.2f", out: "0.00" }, // 0
  { bits: "0000000000000000", fmt: "%-20f", out: "0.000000            " }, // 0
  { bits: "8000000000000000", fmt: "%f", out: "-0.000000" }, // -0
  { bits: "8000000000000000", fmt: "%.2f", out: "-0.00" }, // -0
  { bits: "8000000000000000", fmt: "%-20f", out: "-0.000000           " }, // -0
  { bits: "3ff0000000000000", fmt: "%f", out: "1.000000" }, // 1
  { bits: "3ff0000000000000", fmt: "%.2f", out: "1.00" }, // 1
  { bits: "3ff0000000000000", fmt: "%-20f", out: "1.000000            " }, // 1
  { bits: "bff0000000000000", fmt: "%f", out: "-1.000000" }, // -1
  { bits: "bff0000000000000", fmt: "%.2f", out: "-1.00" }, // -1
  { bits: "bff0000000000000", fmt: "%-20f", out: "-1.000000           " }, // -1
  { bits: "3ff8000000000000", fmt: "%f", out: "1.500000" }, // 1.5
  { bits: "3ff8000000000000", fmt: "%.2f", out: "1.50" }, // 1.5
  { bits: "3ff8000000000000", fmt: "%-20f", out: "1.500000            " }, // 1.5
  { bits: "4004000000000000", fmt: "%f", out: "2.500000" }, // 2.5
  { bits: "4004000000000000", fmt: "%.2f", out: "2.50" }, // 2.5
  { bits: "4004000000000000", fmt: "%-20f", out: "2.500000            " }, // 2.5
  { bits: "3f80000000000000", fmt: "%f", out: "0.007812" }, // 0.0078125
  { bits: "3f80000000000000", fmt: "%.2f", out: "0.01" }, // 0.0078125
  { bits: "3f80000000000000", fmt: "%-20f", out: "0.007812            " }, // 0.0078125
  { bits: "3f90000000000000", fmt: "%f", out: "0.015625" }, // 0.015625
  { bits: "3f90000000000000", fmt: "%.2f", out: "0.02" }, // 0.015625
  { bits: "3f90000000000000", fmt: "%-20f", out: "0.015625            " }, // 0.015625
  { bits: "3fd0000000000000", fmt: "%f", out: "0.250000" }, // 0.25
  { bits: "3fd0000000000000", fmt: "%.2f", out: "0.25" }, // 0.25
  { bits: "3fd0000000000000", fmt: "%-20f", out: "0.250000            " }, // 0.25
  { bits: "3fd8000000000000", fmt: "%f", out: "0.375000" }, // 0.375
  { bits: "3fd8000000000000", fmt: "%.2f", out: "0.38" }, // 0.375
  { bits: "3fd8000000000000", fmt: "%-20f", out: "0.375000            " }, // 0.375
  { bits: "3fc0000000000000", fmt: "%f", out: "0.125000" }, // 0.125
  { bits: "3fc0000000000000", fmt: "%.2f", out: "0.12" }, // 0.125
  { bits: "3fc0000000000000", fmt: "%-20f", out: "0.125000            " }, // 0.125
  { bits: "bf50624dd2f1a9fc", fmt: "%f", out: "-0.001000" }, // -0.001
  { bits: "bf50624dd2f1a9fc", fmt: "%.2f", out: "-0.00" }, // -0.001
  { bits: "bf50624dd2f1a9fc", fmt: "%-20f", out: "-0.001000           " }, // -0.001
  { bits: "3e7ad7f29abcaf48", fmt: "%f", out: "0.000000" }, // 9.9999999999999995e-08
  { bits: "3e7ad7f29abcaf48", fmt: "%.2f", out: "0.00" }, // 9.9999999999999995e-08
  { bits: "3e7ad7f29abcaf48", fmt: "%-20f", out: "0.000000            " }, // 9.9999999999999995e-08
  { bits: "3e7ad7f29abca000", fmt: "%f", out: "0.000000" }, // 9.9999999999948221e-08
  { bits: "3e7ad7f29abca000", fmt: "%.2f", out: "0.00" }, // 9.9999999999948221e-08
  { bits: "3e7ad7f29abca000", fmt: "%-20f", out: "0.000000            " }, // 9.9999999999948221e-08
  { bits: "3ea2f1a9fbe76c8b", fmt: "%f", out: "0.000001" }, // 5.6457519531249997e-07
  { bits: "3ea2f1a9fbe76c8b", fmt: "%.2f", out: "0.00" }, // 5.6457519531249997e-07
  { bits: "3ea2f1a9fbe76c8b", fmt: "%-20f", out: "0.000001            " }, // 5.6457519531249997e-07
  { bits: "3fd5555555555555", fmt: "%f", out: "0.333333" }, // 0.33333333333333331
  { bits: "3fd5555555555555", fmt: "%.2f", out: "0.33" }, // 0.33333333333333331
  { bits: "3fd5555555555555", fmt: "%-20f", out: "0.333333            " }, // 0.33333333333333331
  { bits: "40a4000000000000", fmt: "%f", out: "2560.000000" }, // 2560
  { bits: "40a4000000000000", fmt: "%.2f", out: "2560.00" }, // 2560
  { bits: "40a4000000000000", fmt: "%-20f", out: "2560.000000         " }, // 2560
  { bits: "408b3b645a1cac08", fmt: "%f", out: "871.424000" }, // 871.42399999999998
  { bits: "408b3b645a1cac08", fmt: "%.2f", out: "871.42" }, // 871.42399999999998
  { bits: "408b3b645a1cac08", fmt: "%-20f", out: "871.424000          " }, // 871.42399999999998
  { bits: "4087195eb851eb85", fmt: "%f", out: "739.171250" }, // 739.17124999999999
  { bits: "4087195eb851eb85", fmt: "%.2f", out: "739.17" }, // 739.17124999999999
  { bits: "4087195eb851eb85", fmt: "%-20f", out: "739.171250          " }, // 739.17124999999999
  { bits: "40b4340000000000", fmt: "%f", out: "5172.000000" }, // 5172
  { bits: "40b4340000000000", fmt: "%.2f", out: "5172.00" }, // 5172
  { bits: "40b4340000000000", fmt: "%-20f", out: "5172.000000         " }, // 5172
  { bits: "41412d6873eab000", fmt: "%f", out: "2251472.905600" }, // 2251472.9055995941
  { bits: "41412d6873eab000", fmt: "%.2f", out: "2251472.91" }, // 2251472.9055995941
  { bits: "41412d6873eab000", fmt: "%-20f", out: "2251472.905600      " }, // 2251472.9055995941
  { bits: "3fb3333333333333", fmt: "%f", out: "0.075000" }, // 0.074999999999999997
  { bits: "3fb3333333333333", fmt: "%.2f", out: "0.07" }, // 0.074999999999999997
  { bits: "3fb3333333333333", fmt: "%-20f", out: "0.075000            " }, // 0.074999999999999997
  { bits: "3fe051eb851eb852", fmt: "%f", out: "0.510000" }, // 0.51000000000000001
  { bits: "3fe051eb851eb852", fmt: "%.2f", out: "0.51" }, // 0.51000000000000001
  { bits: "3fe051eb851eb852", fmt: "%-20f", out: "0.510000            " }, // 0.51000000000000001
  { bits: "bffc28f5c28f5c29", fmt: "%f", out: "-1.760000" }, // -1.76
  { bits: "bffc28f5c28f5c29", fmt: "%.2f", out: "-1.76" }, // -1.76
  { bits: "bffc28f5c28f5c29", fmt: "%-20f", out: "-1.760000           " }, // -1.76
  { bits: "4340000000000000", fmt: "%f", out: "9007199254740992.000000" }, // 9007199254740992
  { bits: "4340000000000000", fmt: "%.2f", out: "9007199254740992.00" }, // 9007199254740992
  { bits: "4340000000000000", fmt: "%-20f", out: "9007199254740992.000000" }, // 9007199254740992
  { bits: "43e0000000000000", fmt: "%f", out: "9223372036854775808.000000" }, // 9.2233720368547758e+18
  { bits: "43e0000000000000", fmt: "%.2f", out: "9223372036854775808.00" }, // 9.2233720368547758e+18
  { bits: "43e0000000000000", fmt: "%-20f", out: "9223372036854775808.000000" }, // 9.2233720368547758e+18
  { bits: "4415af1d78b58c40", fmt: "%f", out: "100000000000000000000.000000" }, // 1e+20
  { bits: "4415af1d78b58c40", fmt: "%.2f", out: "100000000000000000000.00" }, // 1e+20
  { bits: "4415af1d78b58c40", fmt: "%-20f", out: "100000000000000000000.000000" }, // 1e+20
  { bits: "3bc79ca10c924223", fmt: "%f", out: "0.000000" }, // 9.9999999999999995e-21
  { bits: "3bc79ca10c924223", fmt: "%.2f", out: "0.00" }, // 9.9999999999999995e-21
  { bits: "3bc79ca10c924223", fmt: "%-20f", out: "0.000000            " }, // 9.9999999999999995e-21
  { bits: "0010000000000000", fmt: "%f", out: "0.000000" }, // 2.2250738585072014e-308
  { bits: "0010000000000000", fmt: "%.2f", out: "0.00" }, // 2.2250738585072014e-308
  { bits: "0010000000000000", fmt: "%-20f", out: "0.000000            " }, // 2.2250738585072014e-308
  { bits: "7fefffffffffffff", fmt: "%f", out: "179769313486231570814527423731704356798070567525844996598917476803157260780028538760589558632766878171540458953514382464234321326889464182768467546703537516986049910576551282076245490090389328944075868508455133942304583236903222948165808559332123348274797826204144723168738177180919299881250404026184124858368.000000" }, // 1.7976931348623157e+308
  { bits: "7fefffffffffffff", fmt: "%.2f", out: "179769313486231570814527423731704356798070567525844996598917476803157260780028538760589558632766878171540458953514382464234321326889464182768467546703537516986049910576551282076245490090389328944075868508455133942304583236903222948165808559332123348274797826204144723168738177180919299881250404026184124858368.00" }, // 1.7976931348623157e+308
  { bits: "7fefffffffffffff", fmt: "%-20f", out: "179769313486231570814527423731704356798070567525844996598917476803157260780028538760589558632766878171540458953514382464234321326889464182768467546703537516986049910576551282076245490090389328944075868508455133942304583236903222948165808559332123348274797826204144723168738177180919299881250404026184124858368.000000" }, // 1.7976931348623157e+308
  { bits: "7ff0000000000000", fmt: "%f", out: "inf" }, // inf
  { bits: "7ff0000000000000", fmt: "%.2f", out: "inf" }, // inf
  { bits: "7ff0000000000000", fmt: "%-20f", out: "inf                 " }, // inf
  { bits: "fff0000000000000", fmt: "%f", out: "-inf" }, // -inf
  { bits: "fff0000000000000", fmt: "%.2f", out: "-inf" }, // -inf
  { bits: "fff0000000000000", fmt: "%-20f", out: "-inf                " }, // -inf
  { bits: "7ff8000000000000", fmt: "%f", out: "nan" }, // nan
  { bits: "7ff8000000000000", fmt: "%.2f", out: "nan" }, // nan
  { bits: "7ff8000000000000", fmt: "%-20f", out: "nan                 " }, // nan
  { bits: "7ff4000000000000", fmt: "%f", out: "nan" }, // nan
  { bits: "7ff4000000000000", fmt: "%.2f", out: "nan" }, // nan
  { bits: "7ff4000000000000", fmt: "%-20f", out: "nan                 " }, // nan
  { bits: "3fe0000000000001", fmt: "%f", out: "0.500000" }, // 0.50000000000000011
  { bits: "3fe0000000000001", fmt: "%.2f", out: "0.50" }, // 0.50000000000000011
  { bits: "3fe0000000000001", fmt: "%-20f", out: "0.500000            " }, // 0.50000000000000011
  { bits: "3fdfffffffffffff", fmt: "%f", out: "0.500000" }, // 0.49999999999999994
  { bits: "3fdfffffffffffff", fmt: "%.2f", out: "0.50" }, // 0.49999999999999994
  { bits: "3fdfffffffffffff", fmt: "%-20f", out: "0.500000            " }, // 0.49999999999999994
  { bits: "41e0000000000000", fmt: "%f", out: "2147483648.000000" }, // 2147483648
  { bits: "41e0000000000000", fmt: "%.2f", out: "2147483648.00" }, // 2147483648
  { bits: "41e0000000000000", fmt: "%-20f", out: "2147483648.000000   " }, // 2147483648
  { bits: "c1e0000000000000", fmt: "%f", out: "-2147483648.000000" }, // -2147483648
  { bits: "c1e0000000000000", fmt: "%.2f", out: "-2147483648.00" }, // -2147483648
  { bits: "c1e0000000000000", fmt: "%-20f", out: "-2147483648.000000  " }, // -2147483648
  { bits: "40fe240ca0000000", fmt: "%f", out: "123456.789062" }, // 123456.7890625
  { bits: "40fe240ca0000000", fmt: "%.2f", out: "123456.79" }, // 123456.7890625
  { bits: "40fe240ca0000000", fmt: "%-20f", out: "123456.789062       " }, // 123456.7890625
  { bits: "3fb99999a0000000", fmt: "%f", out: "0.100000" }, // 0.10000000149011612
  { bits: "3fb99999a0000000", fmt: "%.2f", out: "0.10" }, // 0.10000000149011612
  { bits: "3fb99999a0000000", fmt: "%-20f", out: "0.100000            " }, // 0.10000000149011612
  { bits: "bfde147ae0000000", fmt: "%f", out: "-0.470000" }, // -0.4699999988079071
  { bits: "bfde147ae0000000", fmt: "%.2f", out: "-0.47" }, // -0.4699999988079071
  { bits: "bfde147ae0000000", fmt: "%-20f", out: "-0.470000           " }, // -0.4699999988079071
  { bits: "4014333340000000", fmt: "%f", out: "5.050000" }, // 5.0500001907348633
  { bits: "4014333340000000", fmt: "%.2f", out: "5.05" }, // 5.0500001907348633
  { bits: "4014333340000000", fmt: "%-20f", out: "5.050000            " }, // 5.0500001907348633
  { bits: "40871d5a40000000", fmt: "%f", out: "739.669067" }, // 739.6690673828125
  { bits: "40871d5a40000000", fmt: "%.2f", out: "739.67" }, // 739.6690673828125
  { bits: "40871d5a40000000", fmt: "%-20f", out: "739.669067          " }, // 739.6690673828125
  { bits: "408777d7e0000000", fmt: "%f", out: "750.980408" }, // 750.98040771484375
  { bits: "408777d7e0000000", fmt: "%.2f", out: "750.98" }, // 750.98040771484375
  { bits: "408777d7e0000000", fmt: "%-20f", out: "750.980408          " }, // 750.98040771484375
  { int: 0, fmt: "%d", out: "0" },
  { int: 0, fmt: "%-20d", out: "0                   " },
  { int: 0, fmt: "%5d", out: "    0" },
  { int: 1, fmt: "%d", out: "1" },
  { int: 1, fmt: "%-20d", out: "1                   " },
  { int: 1, fmt: "%5d", out: "    1" },
  { int: -1, fmt: "%d", out: "-1" },
  { int: -1, fmt: "%-20d", out: "-1                  " },
  { int: -1, fmt: "%5d", out: "   -1" },
  { int: 2147483647, fmt: "%d", out: "2147483647" },
  { int: 2147483647, fmt: "%-20d", out: "2147483647          " },
  { int: 2147483647, fmt: "%5d", out: "2147483647" },
  { int: -2147483648, fmt: "%d", out: "-2147483648" },
  { int: -2147483648, fmt: "%-20d", out: "-2147483648         " },
  { int: -2147483648, fmt: "%5d", out: "-2147483648" },
  { int: 100, fmt: "%d", out: "100" },
  { int: 100, fmt: "%-20d", out: "100                 " },
  { int: 100, fmt: "%5d", out: "  100" },
  { int: 25, fmt: "%d", out: "25" },
  { int: 25, fmt: "%-20d", out: "25                  " },
  { int: 25, fmt: "%5d", out: "   25" },
  { int: 63, fmt: "%d", out: "63" },
  { int: 63, fmt: "%-20d", out: "63                  " },
  { int: 63, fmt: "%5d", out: "   63" },
  { str: "SIMINIT", fmt: "%s", out: "SIMINIT" },
  { str: "SIMINIT", fmt: "%-20s", out: "SIMINIT             " },
  { str: "SIMEND", fmt: "%s", out: "SIMEND" },
  { str: "SIMEND", fmt: "%-20s", out: "SIMEND              " },
  { str: "FIGHT", fmt: "%s", out: "FIGHT" },
  { str: "FIGHT", fmt: "%-20s", out: "FIGHT               " },
  { str: "NATURAL", fmt: "%s", out: "NATURAL" },
  { str: "NATURAL", fmt: "%-20s", out: "NATURAL             " },
  { str: "", fmt: "%s", out: "" },
  { str: "", fmt: "%-20s", out: "                    " },
  { str: "a b", fmt: "%s", out: "a b" },
  { str: "a b", fmt: "%-20s", out: "a b                 " },
];

