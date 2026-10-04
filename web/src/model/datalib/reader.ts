/**
 * Lane W1c — `DataLibReader`, a port of `DataLibReader` in `utils/datalib.cc`.
 *
 * The reader is what makes the writer's output *checkable*: it walks the file the same way
 * native does (header at the front, `#TABLES`/`#START`/`#SIZE` digest at the back, the
 * schema rows immediately before/after the `#<Table>` marker depending on `#schema=`), and
 * it is what the round-trip corpus test in `tests/datalib.test.ts` uses to re-emit every
 * datalib artifact the oracle recorded and diff it byte-for-byte.
 *
 * PORT-NOTE(w1c/reader-asserts): native `DataLibReader` has no error path — a malformed
 * file hits `assert(f)`/`assert(false)` and aborts the process. The port throws
 * `DataLibFormatError` with the same condition (signature, version range, unknown table,
 * unknown column, out-of-range row, out-of-bounds digest) so a lane gets a message instead
 * of a dead process.
 * PORT-NOTE(w1c/reader-bool-columns): native's row parser asserts false for a `bool`
 * column (`add_col`'s switch has no `BOOL` case), so reading a bool column cannot work in
 * native. The port throws the same way rather than inventing behaviour.
 * PORT-NOTE(w1c/reader-no-formats): the per-column *format* is writer-only state; native's
 * reader reconstructs columns from `#@L`/`#@T` with `format = NULL` (the type defaults),
 * so re-writing a file whose logger passed `%.2f` (the position logs) needs the format
 * re-supplied by whoever owns the schema. Documented, not fixed.
 */

import {
  COLUMN_TYPE_NAMES,
  ColumnType,
  DATALIB_COLFORMAT_FIXED,
  DATALIB_SCHEMA_SINGLE,
  DATALIB_SIGNATURE,
  DATALIB_VERSION_PREFIX,
  DATALIB_VERSION_READ,
  DATALIB_VERSION_READ_MIN,
  columnTypeFromName,
  type TableMetaData,
} from '../types/datalib';
import { toInt32, type ColumnValue } from './printf';
import { decodeLatin1 } from './sink';

/** Native `assert()` in the reader, as an exception. */
export class DataLibFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataLibFormatError';
  }
}

/** Native `DataLibReader::parseHeader` reads at most this many bytes. */
const HEADER_READ_LIMIT = 127;
/** Native `parseTableHeader` reads at most 1024 bytes from the table offset. */
const TABLE_HEADER_READ_LIMIT = 1024;
/** Native `parseDigest` reads the last 63 bytes to find `#START`/`#SIZE`. */
const DIGEST_TAIL_LIMIT = 63;

interface ReaderColumn {
  readonly name: string;
  readonly type: ColumnType;
  value: ColumnValue;
}

interface ReaderTable {
  readonly name: string;
  readonly offset: number;
  readonly data: number;
  readonly nrows: number;
  readonly rowlen: number;
}

/** Native `DataLibReader` (`datalib.h:142`). */
export class DataLibReader {
  private readonly text: string;
  private singleSchema = true;
  private randomAccess = false;
  private rowIndex = -1;
  private filePos = 0;
  private table: ReaderTable | null = null;
  private cols: ReaderColumn[] = [];
  private colmap = new Map<string, ReaderColumn>();
  private readonly tables = new Map<string, ReaderTable>();

  constructor(bytes: Uint8Array) {
    // latin-1 decode: one char per byte, so string indices are native byte offsets.
    this.text = decodeLatin1(bytes);
    this.parseHeader();
    this.parseDigest();
  }

  /** Whether the file uses one schema for all tables (`#schema=single`). */
  isSingleSchema(): boolean {
    return this.singleSchema;
  }

  /** Whether the file has fixed-length records (`#colformat=fixed`). */
  isRandomAccess(): boolean {
    return this.randomAccess;
  }

  /** Every table in the digest, in file order. */
  tableNames(): string[] {
    return [...this.tables.keys()];
  }

  /** The footer digest entry for a table (`# <name> <offset> <data> <nrows> <rowlen>`). */
  tableMetaData(name: string): TableMetaData | undefined {
    const table = this.tables.get(name);
    if (!table) return undefined;
    return { name: table.name, offset: table.offset, data: table.data, nrows: table.nrows, rowlen: table.rowlen };
  }

  /** Native `seekTable( name )` — false when the file has no such table. */
  seekTable(name: string): boolean {
    const table = this.tables.get(name);
    if (!table) {
      this.table = null;
      return false;
    }
    this.table = table;
    this.rowIndex = -1;
    this.filePos = table.data;
    this.parseTableHeader();
    return true;
  }

  /** Native `rewindTable()`. */
  rewindTable(): void {
    this.rowIndex = -1;
  }

  /** Native `nrows()`. */
  nrows(): number {
    return this.requireTable().nrows;
  }

  /** Native `seekRow( index )` — negative indexes count from the end. */
  seekRow(index: number): void {
    const table = this.requireTable();
    let target = index;
    if (target < 0) target = table.nrows + target;
    if (!(target >= 0 && target < table.nrows)) {
      throw new DataLibFormatError(`datalib: row ${index} out of range for table '${table.name}' (${table.nrows} rows)`);
    }
    if (target === this.rowIndex) return;

    const next = target === this.rowIndex + 1;
    this.rowIndex = target;

    let rowText: string;
    if (this.randomAccess) {
      rowText = this.text.substr(table.data + target * table.rowlen, table.rowlen);
      if (rowText.length !== table.rowlen) {
        throw new DataLibFormatError(`datalib: short fixed-length record in '${table.name}' at row ${target}`);
      }
    } else {
      if (!next || target === 0) this.filePos = table.data;
      const start = next ? target : 0;
      rowText = '';
      for (let i = start; i <= target; i++) {
        const line = this.readLine(this.filePos);
        rowText = line.text;
        this.filePos = line.end;
      }
    }

    this.parseRow(rowText);
  }

  /** Native `nextRow()` — false at the end of the table. */
  nextRow(): boolean {
    const table = this.requireTable();
    const next = this.rowIndex + 1;
    if (next >= table.nrows) return false;
    this.seekRow(next);
    return true;
  }

  /** Native `position()` — the row index, -1 before the first row. */
  position(): number {
    return this.rowIndex;
  }

  /** The column names of the current table, in schema order. */
  columnNames(): string[] {
    return this.cols.map((c) => c.name);
  }

  /** The column types of the current table, in schema order. */
  columnTypes(): ColumnType[] {
    return this.cols.map((c) => c.type);
  }

  /** Native `col( name )` — the value of a column in the current row. */
  col(name: string): ColumnValue {
    if (this.rowIndex === -1) this.seekRow(0);
    const column = this.colmap.get(name);
    if (!column) throw new DataLibFormatError(`datalib: no column '${name}' in table '${this.requireTable().name}'`);
    return column.value;
  }

  /** The current row's values, in schema order. */
  rowValues(): ColumnValue[] {
    if (this.rowIndex === -1) this.seekRow(0);
    return this.cols.map((c) => c.value);
  }

  /** The current row as `{ column: value }`. */
  row(): Record<string, ColumnValue> {
    if (this.rowIndex === -1) this.seekRow(0);
    const out: Record<string, ColumnValue> = {};
    for (const column of this.cols) out[column.name] = column.value;
    return out;
  }

  /** Every row of the current table, in file order. */
  allRows(): ColumnValue[][] {
    this.requireTable();
    const rows: ColumnValue[][] = [];
    this.rewindTable();
    while (this.nextRow()) rows.push(this.rowValues());
    return rows;
  }

  // -------------------------------------------------------------------------
  // private — one method per native private method
  // -------------------------------------------------------------------------

  /** Native `parseHeader()`. */
  private parseHeader(): void {
    const first = this.readLine(0);
    // native `strncmp( line, SIGNATURE, strlen(SIGNATURE) )`: the signature is the first
    // line *including* its newline
    if (first.text !== `${DATALIB_SIGNATURE}\n`) {
      throw new DataLibFormatError(`datalib: not a datalib file (signature ${JSON.stringify(first.text)})`);
    }
    if (first.end > HEADER_READ_LIMIT) {
      throw new DataLibFormatError('datalib: header exceeds the native 128-byte read');
    }

    const versionLine = this.readLine(first.end);
    const versionMatch = new RegExp(`^${DATALIB_VERSION_PREFIX}(\\d+)`).exec(versionLine.text);
    if (!versionMatch) throw new DataLibFormatError(`datalib: missing version line (${JSON.stringify(versionLine.text)})`);
    const version = Number(versionMatch[1]);
    if (!(version >= DATALIB_VERSION_READ_MIN && version <= DATALIB_VERSION_READ)) {
      throw new DataLibFormatError(`datalib: unsupported version ${version}`);
    }

    if (version < 3) {
      // native: pre-3 files are always table-schema, fixed-length records
      this.singleSchema = false;
      this.randomAccess = true;
      return;
    }

    const schemaLine = this.readLine(versionLine.end);
    const schema = /^#schema=(\S+)/.exec(schemaLine.text);
    if (!schema) throw new DataLibFormatError(`datalib: missing schema line (${JSON.stringify(schemaLine.text)})`);
    this.singleSchema = schema[1] === DATALIB_SCHEMA_SINGLE;

    const colformatLine = this.readLine(schemaLine.end);
    const colformat = /^#colformat=(\S+)/.exec(colformatLine.text);
    if (!colformat) throw new DataLibFormatError(`datalib: missing colformat line (${JSON.stringify(colformatLine.text)})`);
    this.randomAccess = colformat[1] === DATALIB_COLFORMAT_FIXED;
  }

  /** Native `parseDigest()`. */
  private parseDigest(): void {
    const tailStart = Math.max(0, this.text.length - DIGEST_TAIL_LIMIT);
    const tail = this.text.slice(tailStart);

    const sizeLineStart = tail.lastIndexOf('\n') + 1;
    const size = parseDigestField(tail.slice(sizeLineStart), '#SIZE');
    const startLineEnd = sizeLineStart - 1; // the '\n' that terminates the #START line
    const startLineStart = tail.lastIndexOf('\n', startLineEnd - 1) + 1;
    const start = parseDigestField(tail.slice(startLineStart, startLineEnd), '#START');

    if (start < 0 || size < 0 || start + size > this.text.length) {
      throw new DataLibFormatError(`datalib: digest out of bounds (start ${start}, size ${size}, file ${this.text.length})`);
    }
    const digest = this.text.slice(start, start + size);

    // native: `char *line = digest + 1` — skip the leading newline
    const tableCountMatch = /^#TABLES (\d+)/.exec(digest.slice(1));
    if (!tableCountMatch) throw new DataLibFormatError('datalib: digest has no #TABLES line');
    const tableCount = Number(tableCountMatch[1]);
    if (tableCount !== 1 && this.singleSchema) {
      throw new DataLibFormatError(`datalib: single-schema file claims ${tableCount} tables`);
    }

    // native keeps `line` at the start of the current line and advances one line per
    // iteration (`line = 1 + strchr( line, '\n' )`), so `at` is *not* advanced here
    let at = 1;
    for (let i = 0; i < tableCount; i++) {
      at = digest.indexOf('\n', at) + 1;
      if (at <= 0) throw new DataLibFormatError('datalib: digest missing a table entry');
      const line = this.readLineIn(digest, at);
      const match = /^# (\S+) (\d+) (\d+) (\d+) (\d+)/.exec(line.text);
      if (!match) throw new DataLibFormatError(`datalib: malformed table entry ${JSON.stringify(line.text)}`);
      const table: ReaderTable = {
        name: match[1]!,
        offset: Number(match[2]),
        data: Number(match[3]),
        nrows: Number(match[4]),
        rowlen: Number(match[5]),
      };
      this.tables.set(table.name, table);
    }
  }

  /** Native `parseTableHeader()` — the `#@L`/`#@T` rows for the current table. */
  private parseTableHeader(): void {
    const table = this.requireTable();
    const region = this.text.slice(table.offset, table.offset + TABLE_HEADER_READ_LIMIT);

    // native NEXT(): the first line is either the single-schema blank/schema line or
    // the `#<Name>` marker in table schema.
    let line = this.readLineIn(region, 0);
    line = this.readLineIn(region, line.end);
    if (!this.singleSchema) line = this.readLineIn(region, line.end);

    const names = tokenize(line.text).filter((token) => !token.startsWith('#'));
    if (names.length === 0) throw new DataLibFormatError(`datalib: no column names in table '${table.name}'`);

    line = this.readLineIn(region, line.end);
    if (!this.singleSchema) line = this.readLineIn(region, line.end);

    const typeTokens = tokenize(line.text).filter((token) => !token.startsWith('#'));
    const types = typeTokens.map((token) => {
      const type = columnTypeFromName(token);
      if (type === undefined) throw new DataLibFormatError(`datalib: unknown column type '${token}' in table '${table.name}'`);
      return type;
    });

    if (types.length !== names.length) {
      throw new DataLibFormatError(`datalib: table '${table.name}' has ${names.length} names but ${types.length} types`);
    }

    this.cols = names.map((name, i) => ({ name, type: types[i]!, value: 0 }));
    this.colmap = new Map(this.cols.map((column) => [column.name, column]));
  }

  /** Native `seekRow()`'s row parser (`local::add_col`). */
  private parseRow(rowText: string): void {
    const tokens = tokenize(rowText);
    if (tokens.length !== this.cols.length) {
      throw new DataLibFormatError(
        `datalib: row ${this.rowIndex} of table '${this.requireTable().name}' has ${tokens.length} fields, schema has ${this.cols.length}`,
      );
    }
    for (let i = 0; i < this.cols.length; i++) {
      const column = this.cols[i]!;
      const token = tokens[i]!;
      switch (column.type) {
        case ColumnType.INT:
          column.value = parseAtoi(token);
          break;
        case ColumnType.FLOAT:
          column.value = parseAtof(token);
          break;
        case ColumnType.STRING:
          column.value = token;
          break;
        default:
          // native `assert(false)`: the row parser has no bool case
          throw new DataLibFormatError(`datalib: cannot read a column of type ${COLUMN_TYPE_NAMES[column.type]} (native asserts)`);
      }
    }
  }

  private requireTable(): ReaderTable {
    if (!this.table) throw new DataLibFormatError('datalib: no table selected (call seekTable first)');
    return this.table;
  }

  /** Native `fgets`: the line at `offset`, including its `\n`, in a latin-1 string. */
  private readLine(offset: number): { text: string; end: number } {
    return this.readLineIn(this.text, offset);
  }

  private readLineIn(haystack: string, offset: number): { text: string; end: number } {
    if (offset >= haystack.length) return { text: '', end: haystack.length };
    const newline = haystack.indexOf('\n', offset);
    if (newline < 0) return { text: haystack.slice(offset), end: haystack.length };
    return { text: haystack.slice(offset, newline + 1), end: newline + 1 };
  }
}

/** The `#START`/`#SIZE` value of the first matching digest line. */
function parseDigestField(line: string, prefix: string): number {
  const match = new RegExp(`^${prefix} (\\d+)`).exec(line);
  if (!match) throw new DataLibFormatError(`datalib: missing '${prefix}' line in the digest tail`);
  return Number(match[1]);
}

/**
 * Native `parseLine()`: split on spaces and tabs, stopping at `\n` or end of buffer.
 * Empty tokens never occur (native only starts a token on a non-separator).
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\n' || c === '\0') {
      if (start >= 0) tokens.push(line.slice(start, i));
      break;
    }
    if (c === ' ' || c === '\t') {
      if (start >= 0) {
        tokens.push(line.slice(start, i));
        start = -1;
      }
    } else if (start < 0) {
      start = i;
    }
  }
  return tokens;
}

/** Native `atoi()`. */
export function parseAtoi(text: string): number {
  const match = /^[\s]*([+-]?\d+)/.exec(text);
  if (!match) return 0;
  return toInt32(Number(match[1]));
}

/**
 * Native `atof()`/`strtod()` for the tokens the writer emits. Non-finite spellings
 * (`inf`, `nan`) are accepted like `strtod`; anything unparsable becomes 0.
 */
export function parseAtof(text: string): number {
  const trimmed = text.replace(/^\s+/, '');
  if (/^[+-]?inf(inity)?/i.test(trimmed)) return trimmed.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan/i.test(trimmed)) return NaN;
  const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(trimmed);
  if (!match) return 0;
  return Number(match[0]);
}
