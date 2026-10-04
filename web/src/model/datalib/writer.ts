/**
 * Lane W1c — `DataLibWriter`, a port of `DataLibWriter` in `utils/datalib.cc`.
 *
 * This is the byte-level contract for every columnar log the oracle compares, so it is
 * ported literally: the header, the `#@L`/`#@T` schema rows (each field `%-20s`), the
 * single-schema vs table-schema layout, the per-row tab handling, and the footer digest
 * with the `offset`/`data`/`nrows`/`rowlen` bookkeeping (which is itself a checksum of the
 * byte stream — a wrong byte count moves the offsets and fails the diff).
 *
 * Layout, exact (`#schema=single`, `#colformat=none`):
 *
 *   #datalib\n#version=3\n#schema=single\n#colformat=none\n
 *   \n#@L <name>…\n#@T <type>…\n                    <- written once, at the first table
 *   \n#<Table>\n                                    <- written by beginTable
 *   <v1>\t<v2>\t…\n                                 <- addRow, one per row
 *   #</Table>\n                                     <- endTable
 *   \n#TABLES 1\n# <Table> <offset> <data> <nrows> <rowlen>\n#START <n>\n#SIZE <n>
 *
 * PORT-NOTE(w1c/writer): the writer mirrors native's state machine exactly, including
 * `singleSchema` allowing only one table (`beginTable` asserts `tables.empty() ||
 * !singleSchema`), the `rowlen` fixed-record check on the `randomAccess` path, and the
 * footer's missing trailing newline after `#SIZE`.
 * PORT-NOTE(w1c/row-tabs): native appends a `\t` after every formatted value and then
 * erases the last one (`b--`), then writes `\n`. The port does the same thing literally
 * rather than `join('\t')`, so the two agree even for a zero-column table (where native
 * would erase the last byte of the `    ` fixed-record prefix).
 */

import {
  COLUMN_TYPE_NAMES,
  ColumnType,
  DATALIB_COLFORMAT_FIXED,
  DATALIB_COLFORMAT_NONE,
  DATALIB_COLUMN_FIELD_WIDTH as FIELD_WIDTH,
  DATALIB_SCHEMA_SINGLE,
  DATALIB_SCHEMA_TABLE,
  DATALIB_SIGNATURE,
  DATALIB_VERSION_WRITE,
  type ColumnSpec,
  type TableMetaData,
} from '../types/datalib';
import { defaultColumnFormat, formatColumn, padField, type ColumnValue } from './printf';
import { BufferSink, encodeLatin1, type ByteSink } from './sink';

interface WriterColumn {
  readonly name: string;
  readonly type: ColumnType;
  readonly format: string;
}

interface WriterTable {
  readonly name: string;
  readonly offset: number;
  data: number;
  rowlen: number;
  nrows: number;
}

/** Native `DataLibWriter` (`datalib.h:100`). */
export class DataLibWriter {
  private readonly sink: ByteSink;
  private readonly randomAccess: boolean;
  private readonly singleSchema: boolean;
  private readonly tables: WriterTable[] = [];
  private table: WriterTable | null = null;
  private cols: WriterColumn[] = [];
  private finished = false;

  constructor(sink: ByteSink, randomAccess = false, singleSchema = true) {
    this.sink = sink;
    this.randomAccess = randomAccess;
    this.singleSchema = singleSchema;
    this.fileHeader();
  }

  get byteLength(): number {
    return this.sink.tell();
  }

  /** Tables started so far, with the footer bookkeeping native records per table. */
  tableMetaData(): readonly TableMetaData[] {
    return this.tables.map((t) => ({ name: t.name, offset: t.offset, data: t.data, nrows: t.nrows, rowlen: t.rowlen }));
  }

  /**
   * Native `beginTable( name, colnames[], coltypes[], colformats[] )`. `formats` is
   * optional per column, exactly like native's `NULL`-terminated `const char
   * *colformats[]`; a missing entry falls back to the type default (padded when
   * `randomAccess`).
   */
  beginTable(name: string, columns: readonly ColumnSpec[], formats?: readonly (string | undefined)[]): void {
    if (this.finished) throw new Error('datalib: beginTable after close');
    if (this.table) throw new Error('datalib: beginTable while a table is open');
    if (this.tables.length > 0 && this.singleSchema) {
      throw new Error('datalib: single-schema file cannot hold more than one table');
    }
    if (columns.length === 0) throw new Error('datalib: beginTable needs at least one column');

    const table: WriterTable = {
      name,
      offset: this.sink.tell(),
      data: 0,
      rowlen: 0,
      nrows: 0,
    };
    this.tables.push(table);
    this.table = table;

    this.cols = columns.map((column, i) => ({
      name: column.name,
      type: column.type,
      format: formats?.[i] ?? defaultColumnFormat(column.type, this.randomAccess),
    }));

    this.tableHeader();
    table.data = this.sink.tell();
  }

  /** Native `addRow( Variant col0, ... )` — one value per column, in schema order. */
  addRow(values: readonly ColumnValue[]): void {
    const table = this.table;
    if (!table) throw new Error('datalib: addRow without a table');
    if (values.length !== this.cols.length) {
      throw new Error(`datalib: addRow for '${table.name}' got ${values.length} values, schema has ${this.cols.length}`);
    }

    table.nrows++;

    let line = this.randomAccess ? '    ' : '';
    for (let i = 0; i < this.cols.length; i++) {
      const column = this.cols[i]!;
      line += formatColumn(column.format, column.type, values[i] as ColumnValue);
      if (!this.randomAccess) line += '\t';
    }
    if (!this.randomAccess) line = line.slice(0, -1); // native `b--`: erase the last tab
    line += '\n';

    const bytes = encodeLatin1(line);
    if (this.randomAccess) {
      if (table.rowlen === 0) table.rowlen = bytes.length;
      else if (bytes.length !== table.rowlen) {
        throw new Error(`datalib: fixed-length record violated in '${table.name}': ${bytes.length} bytes, first row was ${table.rowlen}`);
      }
    }
    this.sink.write(bytes);
  }

  /** Native `endTable()`. */
  endTable(): void {
    if (!this.table) throw new Error('datalib: endTable without a table');
    this.tableFooter();
    this.table = null;
  }

  /** Native `flush()`. */
  flush(full = false): void {
    this.sink.flush(full);
  }

  /**
   * Native `~DataLibWriter()`: finish the open table, write the footer digest, close the
   * file. Idempotent, so a logger can close explicitly and a caller can still call it.
   */
  close(): void {
    if (this.finished) return;
    if (this.table) this.endTable();
    this.fileFooter();
    this.sink.close();
    this.finished = true;
  }

  // -------------------------------------------------------------------------
  // private — one method per native private method
  // -------------------------------------------------------------------------

  /** Native `fileHeader()`. */
  private fileHeader(): void {
    this.sink.write(encodeLatin1(DATALIB_SIGNATURE + '\n'));
    this.sink.write(encodeLatin1(`#version=${DATALIB_VERSION_WRITE}\n`));
    this.sink.write(encodeLatin1(`#schema=${this.singleSchema ? DATALIB_SCHEMA_SINGLE : DATALIB_SCHEMA_TABLE}\n`));
    this.sink.write(encodeLatin1(`#colformat=${this.randomAccess ? DATALIB_COLFORMAT_FIXED : DATALIB_COLFORMAT_NONE}\n`));
  }

  /** Native `fileFooter()`. */
  private fileFooter(): void {
    const digestStart = this.sink.tell();

    this.sink.write(encodeLatin1('\n'));
    this.sink.write(encodeLatin1(`#TABLES ${this.tables.length}\n`));
    for (const table of this.tables) {
      this.sink.write(encodeLatin1(`# ${table.name} ${table.offset} ${table.data} ${table.nrows} ${table.rowlen}\n`));
    }
    const digestEnd = this.sink.tell();

    this.sink.write(encodeLatin1(`#START ${digestStart}\n`));
    this.sink.write(encodeLatin1(`#SIZE ${digestEnd - digestStart}`));
  }

  /** Native `tableHeader()` — schema rows before the `#<name>` marker in single mode. */
  private tableHeader(): void {
    if (this.singleSchema) this.colMetaData();
    this.sink.write(encodeLatin1(`\n#<${this.table!.name}>\n`));
    if (!this.singleSchema) this.colMetaData();
  }

  /** Native `tableFooter()`. */
  private tableFooter(): void {
    this.sink.write(encodeLatin1(`#</${this.table!.name}>\n`));
  }

  /** Native `colMetaData()` — the `#@L` name row and the `#@T` type row. */
  private colMetaData(): void {
    if (this.singleSchema) this.sink.write(encodeLatin1('\n'));

    this.sink.write(encodeLatin1('#@L '));
    for (const column of this.cols) {
      this.sink.write(encodeLatin1(padField(column.name, FIELD_WIDTH, true)));
    }
    this.sink.write(encodeLatin1('\n'));
    if (!this.singleSchema) this.sink.write(encodeLatin1('#\n'));

    this.sink.write(encodeLatin1('#@T '));
    for (const column of this.cols) {
      this.sink.write(encodeLatin1(padField(typeToken(column.type), FIELD_WIDTH, true)));
    }
    this.sink.write(encodeLatin1('\n'));
    if (!this.singleSchema) this.sink.write(encodeLatin1('#\n'));
  }
}

/** The `#@T` token native `__Column::tname` writes. */
export function typeToken(type: ColumnType): string {
  const token = COLUMN_TYPE_NAMES[type];
  if (token === undefined || type === ColumnType.INVALID) {
    throw new Error(`datalib: column type ${type} has no '#@T' token`);
  }
  return token;
}

/** Convenience: a writer on a plain in-memory sink, for callers that only need the bytes. */
export function writeDataLib(
  build: (writer: DataLibWriter) => void,
  options: { randomAccess?: boolean; singleSchema?: boolean } = {},
): Uint8Array {
  const sink = new BufferSink();
  const writer = new DataLibWriter(sink, options.randomAccess ?? false, options.singleSchema ?? true);
  build(writer);
  writer.close();
  return sink.bytes();
}
