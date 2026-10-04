/**
 * Lane W1c — public surface of the columnar log format (`utils/datalib.{h,cc}` plus the
 * file/compression half of `utils/AbstractFile.{h,cc}`).
 *
 * Importable from anywhere (no `node:*` in the graph):
 *
 *   - `DataLibWriter` / `DataLibReader` — the format itself;
 *   - `BirthsDeathsLog` + line formatters — `run/BirthsDeaths.log`;
 *   - `BufferSink` — an in-memory `ByteSink`, so a browser recorder can produce the exact
 *     bytes without a file system.
 *
 * The node adapters (`FileByteSink`, `GzipByteSink`, `openAbstractFileWriter`,
 * `readAbstractFileBytes`) live in `./nodeFile` and are deliberately *not* re-exported
 * here, because they pull in `node:fs`/`node:zlib` and would poison a browser bundle.
 *
 * PORT-NOTE(w1c/index-surface): the browser lane replaces the native `FILE *` / `gzFile`
 * choice with its own `ByteSink`; nothing else about the format changes, which is what keeps
 * a browser recording byte-comparable with the oracle.
 */

export * from './printf';
export * from './sink';
export * from './writer';
export * from './reader';
export * from './birthsDeaths';

// The frozen registry this module is built on, re-exported for loggers (L12) that declare
// their schemas through W1c rather than importing `src/model/types` directly.
export {
  COLUMN_TYPE_NAMES,
  ColumnType,
  columnTypeFromName,
  columnTypeName,
  ConcreteFileType,
  DATALIB_COLFORMAT_FIXED,
  DATALIB_COLFORMAT_NONE,
  DATALIB_COLUMN_FIELD_WIDTH,
  DATALIB_COLUMN_NAMES_PREFIX,
  DATALIB_COLUMN_TYPES_PREFIX,
  DATALIB_SCHEMA_SINGLE,
  DATALIB_SCHEMA_TABLE,
  DATALIB_SIGNATURE,
  DATALIB_SIZE_PREFIX,
  DATALIB_START_PREFIX,
  DATALIB_TABLES_PREFIX,
  DATALIB_VERSION_PREFIX,
  DATALIB_VERSION_READ,
  DATALIB_VERSION_READ_MIN,
  DATALIB_VERSION_WRITE,
  type ColumnSpec,
  type TableMetaData,
  type TableSpec,
} from '../types/datalib';
