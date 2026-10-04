/**
 * Lane L18 (browser wiring) — the monitor documents the page builds its monitors from.
 *
 * Native's app reads three documents before it steps anything: the worldfile, and then, for the
 * monitors (`main.cc:98-103` + `MonitorManager.cc:27-31`),
 *
 * ```
 *   proplib::SchemaDocument *pschema = builder.buildSchemaDocument( "./etc/monitors.mfs" );
 *   proplib::Document      *pdoc    = builder.buildDocument( monitorPath );   // "./etc/term.mf"
 *   pschema->apply( pdoc );
 * ```
 *
 * `etc/monitors.mfs` + `etc/<ui>.mf` live in the **native** tree, outside this repo, so the page
 * cannot read them — exactly the problem `worldfiles/*.wf` had (PORT-NOTE (L18/bundled-worldfiles)).
 * The solution is the same one, and so is the guarantee: `src/browser/monitors/**` holds
 * **verbatim copies** of the two files the recorded scenarios ran with (`--ui term`,
 * `oracle/<scenario>/meta.json`), imported with `?raw` so they are strings in the bundle. Nothing
 * is fetched at run time and no path outside the bundle is consulted.
 *
 * PORT-NOTE (L18/bundled-monitor-documents): the copies cannot drift silently — `worldBoot.test.ts`
 * byte-compares them against the native tree when it is present, and *always* resolves them
 * through lane L14's loader and compares the resulting 89-leaf document against the recorded
 * native probe (`src/model/monitor/native/vectors/monitorConfig.term.json`, in git). So the drift
 * anchor survives a fresh worktree with no native tree at all.
 *
 * PORT-NOTE (L18/monitor-ui-is-native-argv): `--ui` is native's own argv flag; the port does not
 * expose it as a shell knob (native's `main.cc` picks `./<ui>.mf` if it exists, else
 * `./etc/<ui>.mf`, and the recorded runs used `term`). `bundledMonitorDocument()` therefore serves
 * the one document the bundle carries and throws — loudly — for any other path, rather than
 * quietly loading the wrong UI's defaults.
 */

import { loadMonitorDocument, monitorDocumentPath } from '../../model/monitor/monitorDocument';
import type { PropertyNode } from '../../model/types';
import monitorsSchema from '../monitors/monitors.mfs?raw';
import termDocument from '../monitors/term.mf?raw';

/** Native `--ui` the recorded scenarios ran with (`oracle/<scenario>/meta.json` → `command`). */
export const MONITOR_UI = 'term';

/** Native `./etc/monitors.mfs` — the schema every monitor document is applied to. */
export const MONITOR_SCHEMA_PATH = './etc/monitors.mfs';

/** Native `./etc/<ui>.mf` — the document (`etc/term.mf` is just `@defaults term`). */
export const MONITOR_DOCUMENT_PATH = `./etc/${MONITOR_UI}.mf`;

/** The bundled documents, keyed by the native path the loader reads them under. */
export const MONITOR_SOURCE_TEXT: Readonly<Record<string, string>> = {
  [MONITOR_SCHEMA_PATH]: monitorsSchema,
  [MONITOR_DOCUMENT_PATH]: termDocument,
};

/** The bundled text at a native monitor path (`MonitorSourceReader`), or a loud refusal. */
export function monitorSourceText(path: string): string {
  const text = MONITOR_SOURCE_TEXT[path];
  if (text === undefined) {
    const known = Object.keys(MONITOR_SOURCE_TEXT).join(', ');
    throw new Error(`bundledMonitors: no bundled monitor document '${path}' (the bundle carries ${known})`);
  }
  return text;
}

/**
 * Native's three document steps over the bundled text (lane L14's `loadMonitorDocument`): the
 * schema-applied `PropertyNode` `MonitorManager` reads. Built once per world by `modelWorld.ts`.
 *
 * The path goes through native's own selection rule — `monitorDocumentPath` — with the bundle's
 * keys as the existence test, so the port cannot quietly pick a different branch than native did
 * (the bundle has no `./term.mf`, so this resolves to `./etc/term.mf`, native's third branch).
 */
export function bundledMonitorDocument(): PropertyNode {
  const path = monitorDocumentPath(MONITOR_UI, (candidate) => candidate in MONITOR_SOURCE_TEXT);
  return loadMonitorDocument(monitorSourceText, path);
}
