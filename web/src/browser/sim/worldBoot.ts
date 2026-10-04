/**
 * Lane L18 (browser wiring) — the boot: worldfile text in, a drawable world out.
 *
 * This is the browser's copy of the native pre-step path, in the native's own order. Native
 * `TSimulation`'s constructor (the lane W1b header maps it: `src/model/proplib/index.ts`)
 * does
 *
 *     schema    = builder.buildSchemaDocument( "./etc/worldfile.wfs" )
 *     worldfile = builder.buildWorldfileDocument( schema, worldfilePath, parameters )
 *     cp worldfile run/original.wf ;  cp schema run/original.wfs      # Simulation.cc:450-451
 *     converted.wf        <- writer.write( worldfile )               # before apply()
 *     schema.apply( worldfile )
 *     normalized.wf       <- writer.write( worldfile )               # after apply()
 *
 * and then keeps stepping. This module stops after the last line: it produces the boot's
 * artifacts and parameters, and lane L11's `Simulation` (`sim/modelWorld.ts`) steps the world
 * from there — the same class the node-side parity runner constructs.
 *
 * PORT-NOTE (L18/boot-artifacts): the four files this module returns are the frozen artifacts
 * that exist *before the first step* — `run/original.wf`, `run/original.wfs`,
 * `run/converted.wf`, `run/normalized.wf`. They are produced by lane W1b's converter/writer
 * and are byte-compared against the goldens by this lane's own test
 * (`worldBoot.test.ts`), which is also what writes the candidate run tree the parity harness
 * reads. Every other file in the run tree is written by the run itself, after the first step,
 * through the caller's file seam (`sim/browserFiles.ts`); this module invents none of it.
 *
 * PORT-NOTE (L18/inputs): the boot reads its two sources through a caller-supplied reader, so
 * the browser (bundled text / fetch) and the node-side test (recorded `oracle/**` copies)
 * share one code path — the artifacts and the parameters are identical either way.
 */

import { Config } from '../../model/types';
import {
  emitNormalizedWorldfile,
  DocumentWriter,
  type Document,
  type ExpressionEvaluator,
  type SchemaDocument,
  type SourceReader,
} from '../../model/proplib';
import { parameterMap, type Scenario } from './scenarios';
import { readWorldParams, WorldBootError, type ReadReport, type WorldParams } from './worldParams';

/** The two sources a boot needs, already read into text. */
export interface WorldSources {
  readonly scenario: Scenario;
  /** Native argv path of the worldfile — what the document's own name/path derives from. */
  readonly worldfilePath: string;
  /** Native argv path of the schema (`./etc/worldfile.wfs`). */
  readonly schemaPath: string;
  readonly worldfileText: string;
  readonly schemaText: string;
}

/** The frozen artifacts a boot produces, keyed by their path inside the run tree. */
export const ARTIFACT_KEYS = {
  originalWorldfile: 'run/original.wf',
  originalSchema: 'run/original.wfs',
  converted: 'run/converted.wf',
  normalized: 'run/normalized.wf',
} as const;

export type ArtifactKey = (typeof ARTIFACT_KEYS)[keyof typeof ARTIFACT_KEYS];

export interface BootOptions {
  /**
   * The expression evaluator the document builder uses. Defaults to lane L4's
   * `interpreterEvaluator` (native's `python3` port), so every expression-valued worldfile key
   * evaluates; see `worldParams.ts`'s read plan for what happens when one cannot.
   */
  readonly evaluator?: ExpressionEvaluator;
  /** Native `SchemaDocument::apply`'s validation pass (default: off, as in W1b's facade). */
  readonly validate?: boolean;
  /**
   * Extra native `--Key value` parameters, applied by lane W1b's converter **on top of** the
   * scenario's own argv (native's `setParameters` path, which is also where `run/converted.wf`
   * gets its `  Vision False` line). The shell uses it for `?seed=` → native `--InitSeed`
   * (`modelWorld.ts`); absent, the boot is the recorded one byte-for-byte.
   */
  readonly parameters?: readonly (readonly [string, string])[];
}

export interface BootedWorld {
  readonly sources: WorldSources;
  readonly scenario: Scenario;
  /** Everything the shell needs to draw and label the world. */
  readonly params: WorldParams;
  /** What the read plan did: read / blocked / provisional / notes. */
  readonly report: ReadReport;
  /** `run/converted.wf` — the worldfile before `apply()`. */
  readonly converted: string;
  /** `run/normalized.wf` — the worldfile after `apply()`. */
  readonly normalized: string;
  readonly schema: SchemaDocument;
  readonly worldfileDocument: Document;
  /** A `Config` over the normalized document, for anything the params do not cover. */
  readonly config: Config;
  /** Path → text for every artifact this stage produces (see the PORT-NOTE above). */
  readonly artifacts: ReadonlyMap<string, string>;
}

/** Build a `SourceReader` from already-read texts (the browser case). */
export function readerForTexts(sources: {
  worldfilePath: string;
  schemaPath: string;
  worldfileText: string;
  schemaText: string;
}): SourceReader {
  const byPath = new Map<string, string>([
    [sources.worldfilePath, sources.worldfileText],
    [sources.schemaPath, sources.schemaText],
  ]);
  return (path: string): string => {
    const text = byPath.get(path);
    if (text === undefined) throw new Error(`boot: no source text for '${path}'`);
    return text;
  };
}

/**
 * Run the native pre-step path (see the header) and read the shell's parameters out of the
 * resulting document.
 *
 * Throws `WorldBootError` (from `worldParams.ts`) when a *required* key cannot be read —
 * e.g. a worldfile whose `WorldSize` is an expression the interpreter itself cannot evaluate
 * (`WorldSize UndefinedSize`). A throw is the honest outcome: the alternative is drawing a
 * world the file does not describe.
 */
export function bootWorld(sources: WorldSources, options: BootOptions = {}): BootedWorld {
  const read = readerForTexts(sources);

  // The scenario's own argv, then any caller-supplied native parameters on top (see
  // `BootOptions.parameters`). With no extras this is exactly the map the lane has always
  // handed the converter, so the recorded artifacts stay byte-for-byte.
  const parameters = parameterMap(sources.scenario);
  for (const [key, value] of options.parameters ?? []) parameters.set(key, value);

  const built = emitNormalizedWorldfile(read, {
    worldfilePath: sources.worldfilePath,
    schemaPath: sources.schemaPath,
    parameters,
    ...(options.evaluator ? { evaluator: options.evaluator } : {}),
    validate: options.validate ?? false,
  });

  const config = new Config(built.worldfileDocument);
  const { params, report } = readWorldParams(config);

  const artifacts = new Map<string, string>([
    [ARTIFACT_KEYS.originalWorldfile, sources.worldfileText],
    [ARTIFACT_KEYS.originalSchema, sources.schemaText],
    [ARTIFACT_KEYS.converted, built.converted],
    [ARTIFACT_KEYS.normalized, built.normalized],
  ]);

  return {
    sources,
    scenario: sources.scenario,
    params,
    report,
    converted: built.converted,
    normalized: built.normalized,
    schema: built.schema,
    worldfileDocument: built.worldfileDocument,
    config,
    artifacts,
  };
}

/** Re-emit the document (native `DocumentWriter::write`), for a UI-side download link. */
export function writeDocument(document: Document): string {
  return new DocumentWriter().write(document);
}

export { WorldBootError };
export type { ReadReport, WorldParams };
