/**
 * Lane W1b — the lane's public entry point.
 *
 * One function that does what `Simulation.cc` does before it starts stepping
 * (`TSimulation::TSimulation`, lines ~270 and ~450):
 *
 *     schema    = builder.buildSchemaDocument( "./etc/worldfile.wfs" )
 *     worldfile = builder.buildWorldfileDocument( schema, worldfilePath, parameters )
 *     converted.wf        <- writer.write( worldfile )            (before apply)
 *     schema->apply( worldfile )
 *     normalized.wf       <- writer.write( worldfile )            (after apply)
 *
 * Both artifacts are returned, because both are frozen goldens
 * (`oracle/<scenario>/run/{converted,normalized}.wf`) and because the pair localizes a
 * failure: if `converted.wf` matches and `normalized.wf` does not, the defaults/validation
 * pass is at fault; if `converted.wf` is wrong, the lexer/parser/builder/writer/converter is.
 *
 * PORT-NOTE(proplib/validate-default): `validate` defaults to `false` at this facade, as it
 * did before lane L4 — *not* because a value cannot be evaluated any more (it can, that is
 * what `interpreterEvaluator` is), but because the pass is read-only and cannot change either
 * artifact, and because two callers deliberately present the split: the browser boot
 * (`worldBoot.ts`) and the sim runner both build the document the model reads with the
 * validation pass off and then read values themselves. A caller reproducing native's ctor,
 * which validates, passes `validate: true` — this lane's own L4 parity test does exactly that
 * for all four recorded variants. `converted.wf` is written before `apply()` either way, so
 * its bytes never depend on the flag at all.
 */

import { DocumentBuilder, isV1Source, type ParameterMap } from './builder';
import { Document } from './dom';
import { interpreterEvaluator, type ExpressionEvaluator } from './evaluator';
import { SchemaDocument } from './schema';
import { DocumentWriter } from './writer';

export * from './error';
export * from './lexer';
export * from './syntax';
export * from './parser';
export * from './expression';
export * from './evaluator';
export * from './pythonExpression';
export * from './dom';
export * from './builder';
export * from './editor';
export * from './schema';
export * from './convert';
export * from './writer';
export * from './overlay';

/** Where the native build keeps the worldfile schema, relative to the native tree. */
export const NATIVE_SCHEMA_PATH = './etc/worldfile.wfs';

/** The two documents a run writes, in the order the native writes them. */
export interface NormalizedWorldfile {
  readonly converted: string;
  readonly normalized: string;
  readonly worldfileDocument: Document;
  readonly schema: SchemaDocument;
}

export interface EmitOptions {
  /** Native path of the worldfile (`worldfiles/tests/low-spec-pc/minitest.wf`, as passed on argv). */
  readonly worldfilePath: string;
  /** Native path of the schema (default `./etc/worldfile.wfs`). */
  readonly schemaPath?: string;
  /** `--Key value` overrides, in the native `std::map` (key) order. */
  readonly parameters?: ParameterMap;
  /** Expression evaluator; defaults to lane L4's `interpreterEvaluator` (native `python3`). */
  readonly evaluator?: ExpressionEvaluator;
  /** Run the validation pass (default: false at this facade — see the PORT-NOTE above). */
  readonly validate?: boolean;
}

/** Read a document from some source (the CLI passes a file reader; tests pass literals). */
export type SourceReader = (path: string) => string;

/**
 * Build the schema + worldfile documents, emit `converted.wf`, apply the schema and emit
 * `normalized.wf`.
 */
export function emitNormalizedWorldfile(
  read: SourceReader,
  options: EmitOptions,
): NormalizedWorldfile {
  const evaluator = options.evaluator ?? interpreterEvaluator;
  const schemaPath = options.schemaPath ?? NATIVE_SCHEMA_PATH;

  const builder = new DocumentBuilder(evaluator);
  const schema = builder.buildSchemaDocumentText(
    schemaPath,
    read(schemaPath),
    (name, path) => new SchemaDocument(name, path),
  );

  const worldfileDocument = builder.buildWorldfileDocumentTextWithParameters(
    schema,
    options.worldfilePath,
    read(options.worldfilePath),
    options.parameters ?? new Map<string, string>(),
  );

  const writer = new DocumentWriter();
  const converted = writer.write(worldfileDocument);

  schema.apply(worldfileDocument, { validate: options.validate ?? false });

  const normalized = writer.write(worldfileDocument);

  return { converted, normalized, worldfileDocument, schema };
}

/** True when the worldfile text is v1 (native `WorldfileConverter::isV1`). */
export { isV1Source };
