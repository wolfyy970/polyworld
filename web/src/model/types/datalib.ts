/**
 * Lane W1a — the frozen part of the columnar log surface.
 *
 * Every artifact the oracle compares (`population.txt`, `energy/**`, `lifespans.txt`,
 * `BirthsDeaths.log`, …) is written by `datalib` (`src/library/utils/datalib.cc`) and
 * starts with a header that is part of the byte-level contract:
 *
 *   #datalib
 *   #version=3
 *   #schema=single            (or "table")
 *   #colformat=none           (or "fixed")
 *
 *   #@L <name padded to 20>…
 *   #@T <type padded to 20>…  type token: int | float | string | bool
 *
 *   #<TableName>
 *   …rows…
 *   #</TableName>
 *   #TABLES <n>
 *   # <name> <offset> <data> <nrows> <rowlen>
 *   #START <offset>
 *   #SIZE <size>
 *
 * What is frozen here is the *schema registry* (the column types and their file tokens)
 * and the header tokens; the writer/reader that produces the bytes is lane W1c's
 * (`src/model/datalib/`). Native `datalib::Type` is what every logger declares its
 * columns with, so a port with a different type vocabulary would produce files the oracle
 * cannot compare.
 *
 * PORT-NOTE(types/datalib-type-registry): the enum values are native's
 * (`datalib::INVALID, INT, FLOAT, STRING, BOOL`) and the type tokens are the exact strings
 * `__Column` writes into the `#@T` row (`datalib.cc`).
 */

/** Native `datalib::Type` — column datatype. */
export const ColumnType = {
  INVALID: 0,
  INT: 1,
  FLOAT: 2,
  STRING: 3,
  BOOL: 4,
} as const;

export type ColumnType = (typeof ColumnType)[keyof typeof ColumnType];

/** The `#@T` token for each column type (native `__Column::tname`). */
export const COLUMN_TYPE_NAMES: readonly string[] = ['invalid', 'int', 'float', 'string', 'bool'];

/** The `#@T` token for a column type, and its inverse (the reader's `strncmp` ladder). */
export function columnTypeName(type: ColumnType): string {
  if (type === ColumnType.INVALID) return 'invalid';
  return COLUMN_TYPE_NAMES[type]!;
}

export function columnTypeFromName(token: string): ColumnType | undefined {
  switch (token) {
    case 'int':
      return ColumnType.INT;
    case 'float':
      return ColumnType.FLOAT;
    case 'string':
      return ColumnType.STRING;
    case 'bool':
      return ColumnType.BOOL;
    default:
      return undefined;
  }
}

/** One column of a log table: native `__Column` (name + type; format is writer-internal). */
export interface ColumnSpec {
  readonly name: string;
  readonly type: ColumnType;
}

/** A log table's schema: native `__Table` (name + columns, plus footer bookkeeping). */
export interface TableSpec {
  readonly name: string;
  readonly columns: readonly ColumnSpec[];
}

/** Native `__Table` footer line fields (`# <name> <offset> <data> <nrows> <rowlen>`). */
export interface TableMetaData {
  readonly name: string;
  readonly offset: number;
  readonly data: number;
  readonly nrows: number;
  readonly rowlen: number;
}

/** datalib file-level tokens (`datalib.cc` `#define`s). */
export const DATALIB_SIGNATURE = '#datalib';
export const DATALIB_VERSION_WRITE = 3;
export const DATALIB_VERSION_READ = 3;
export const DATALIB_VERSION_READ_MIN = 2;
export const DATALIB_VERSION_PREFIX = '#version=';
export const DATALIB_SCHEMA_PREFIX = '#schema=';
export const DATALIB_COLFORMAT_PREFIX = '#colformat=';
/** Column-name row prefix (the parity checker reads this to name a diverging column). */
export const DATALIB_COLUMN_NAMES_PREFIX = '#@L';
/** Column-type row prefix. */
export const DATALIB_COLUMN_TYPES_PREFIX = '#@T';
export const DATALIB_TABLES_PREFIX = '#TABLES';
export const DATALIB_START_PREFIX = '#START';
export const DATALIB_SIZE_PREFIX = '#SIZE';
/** `#schema=` values: `single` or `table`. */
export const DATALIB_SCHEMA_SINGLE = 'single';
export const DATALIB_SCHEMA_TABLE = 'table';
/** `#colformat=` values: `none` or `fixed`. */
export const DATALIB_COLFORMAT_NONE = 'none';
export const DATALIB_COLFORMAT_FIXED = 'fixed';
/** Column fields are printed `%-20s` (native `colMetaData`). */
export const DATALIB_COLUMN_FIELD_WIDTH = 20;

/**
 * Native `AbstractFile::ConcreteFileType` (`utils/AbstractFile.h`): the two concrete file
 * backends the model can write through (`globals::recordFileType` selects one from the
 * worldfile's `CompressFiles`).
 */
export const ConcreteFileType = {
  TYPE_UNDEFINED: 0,
  TYPE_FILE: 1,
  TYPE_GZIP_FILE: 2,
} as const;

export type ConcreteFileType = (typeof ConcreteFileType)[keyof typeof ConcreteFileType];
