/**
 * Lane L14 — native's three document steps for the monitor documents, in native's order:
 *
 * ```
 *   proplib::DocumentBuilder builder;
 *   proplib::SchemaDocument *pschema = builder.buildSchemaDocument( "./etc/monitors.mfs" );
 *   proplib::Document *pdoc         = builder.buildDocument( monitorPath );   // "./etc/term.mf"
 *   pschema->apply( pdoc );
 * ```
 * (`main.cc:98-103` picks `monitorPath` = `./<ui>.mf` if it exists, else `./etc/<ui>.mf`;
 * `MonitorManager.cc:27-31` is the three steps above.)
 *
 * This module is the *only* file in the lane that imports proplib, so `monitorManager.ts`
 * stays a pure function of a document (`PORT-NOTE(monitor/manager-takes-documents)`), and a
 * caller with paths — the node test, the browser shell, a future CLI — gets the native path
 * end to end.
 *
 * PORT-NOTE(monitor/apply-validate-opt-in): native `SchemaDocument::apply` runs the validation
 * pass, which evaluates schema expressions (`assert ( not Enabled or (len(Name) > 0) )`,
 * `assert ( Rank != 0 )`, `max SampleFrequency`) — lane L4's language, which has landed and is what
 * these documents are built with. The port still passes `validate: false` by default, exactly as
 * lane W1b did for the worldfile facade, and for the same unchanged reason: the pass is read-only,
 * so the *resolved document* (defaults, types, coercion) is identical either way. `validate: true`
 * is one option away. Listed in PARITY.md → Deviations.
 *
 * PORT-NOTE(monitor/document-not-worldfile): the monitor document is built with
 * `buildDocument` (the plain v2 path), not `buildWorldfileDocument`: it has no v1 form and no
 * `--Key value` overrides, and native never runs the worldfile converter on it.
 */

import {
  interpreterEvaluator,
  SchemaDocument,
  type DocumentBuilder,
  type ExpressionEvaluator,
  DocumentBuilder as Builder,
} from '../proplib';
import type { PropertyNode } from '../types';

/** Native `etc/monitors.mfs`, relative to the native tree. */
export const NATIVE_MONITOR_SCHEMA_PATH = './etc/monitors.mfs';

/**
 * The evaluator the monitor documents are built with: lane L4's `interpreterEvaluator`, i.e.
 * the port of the `python3` child native piped to.
 *
 * PORT-NOTE(monitor/document-evaluator-cutover): until lane L4 landed this file carried a
 * stand-in (`schemaLiteralEvaluator` plus single property references) for the one shape the
 * monitor documents need beyond literals — `etc/monitors.mfs` gives `Movie.Record` the default
 * `RecordMovie`, a *reference to the top-level property* of the same document, which every
 * scene document inherits. That stand-in is **deleted**: the real language answers it (code
 * generation substitutes the referenced property's value, exactly as native did), and the same
 * `native/vectors/monitorConfig.{term,gui}.json` recording that proved the stand-in — 89 + 89
 * leaves of both real monitor documents — now proves the real evaluator, through
 * `tests/monitor.test.ts`.
 */
export const monitorDocumentEvaluator: ExpressionEvaluator = interpreterEvaluator;

/** Native `main.cc:99-103`: `./<ui>.mf` if present, else `./etc/<ui>.mf`. */
export function monitorDocumentPath(ui: string, exists: (path: string) => boolean): string {
  const local = `./${ui}.mf`;
  return exists(local) ? local : `./etc/${ui}.mf`;
}

/** Read a document source (the CLI/tests pass a file reader; the browser passes a fetch). */
export type MonitorSourceReader = (path: string) => string;

export interface MonitorDocumentOptions {
  /** Native path of the schema; defaults to `./etc/monitors.mfs`. */
  readonly schemaPath?: string;
  /** Run native's validation pass (default false — see the PORT-NOTE above). */
  readonly validate?: boolean;
  /** Build the schema object (native `new SchemaDocument( name, path )`). */
  readonly makeSchema?: (name: string, path: string) => SchemaDocument;
  /** Inject a builder (tests); defaults to a builder over `evaluator`. */
  readonly builder?: DocumentBuilder;
  /** Expression evaluator; defaults to `monitorDocumentEvaluator` (lane L4's language). */
  readonly evaluator?: ExpressionEvaluator;
}

/**
 * Build the schema-applied monitor document root — the `PropertyNode` `MonitorManager` reads.
 *
 * PORT-NOTE(monitor/document-evaluator-default): the default evaluator is lane L4's
 * `interpreterEvaluator` (see `monitorDocumentEvaluator`); `options.evaluator` still overrides it,
 * which is how a test can drive the seam with a scripted evaluator.
 */
export function loadMonitorDocument(
  read: MonitorSourceReader,
  monitorPath: string,
  options: MonitorDocumentOptions = {},
): PropertyNode {
  const schemaPath = options.schemaPath ?? NATIVE_MONITOR_SCHEMA_PATH;
  const builder =
    options.builder ?? new Builder(options.evaluator ?? monitorDocumentEvaluator);
  const makeSchema = options.makeSchema ?? ((name: string, path: string) => new SchemaDocument(name, path));

  const schema = builder.buildSchemaDocumentText(schemaPath, read(schemaPath), makeSchema);
  const doc = builder.buildDocumentText(monitorPath, read(monitorPath));

  schema.apply(doc, { validate: options.validate ?? false });

  return doc;
}
