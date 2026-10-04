/**
 * Lane L18 (browser wiring) — the worldfiles the browser bundle boots from.
 *
 * PORT-NOTE (L18/bundled-worldfiles): `src/browser/worldfiles/**` holds **verbatim copies**
 * of the native inputs the recorded scenarios ran on —
 * `../polyworld/worldfiles/tests/low-spec-pc/{minitest,microtest}.wf`,
 * `../polyworld/worldfiles/hello.wf` (lane L20's demo world) and
 * `../polyworld/etc/worldfile.wfs` — because the recorded copies of exactly those files
 * (`oracle/<scenario>/run/original.{wf,wfs}`) are *not* in git (the goldens under `oracle/`
 * are untracked), and a lane in a fresh git worktree must still be able to `vite build`. The
 * copies are byte-compared against the recorded originals by this lane's test
 * (`worldBoot.test.ts` → "bundled worldfiles are the native inputs"), so the duplication
 * cannot drift silently.
 *
 * The schema is the same 48 KB file for every scenario; only the worldfile differs (173/171/25
 * bytes for minitest/microtest/hello). They are imported with `?raw`, so they end up as strings in
 * the bundle and the boot path is identical in dev and in `dist/`.
 *
 * `bricks_voff` (the demo world — PORT-NOTE (L18/demo-scenarios) in `scenarios.ts`) follows the
 * same rule: its copy of native `worldfiles/m-neurons/growingBarriers_grayBricks.wf` is byte-checked
 * against the native tree by `worldBoot.test.ts`. It has no recorded golden, so it is bundled for
 * the page's *look*, not for parity.
 */

import helloWorldfile from '../worldfiles/hello.wf?raw';
import bricksWorldfile from '../worldfiles/growingBarriers_grayBricks.wf?raw';
import minitestWorldfile from '../worldfiles/minitest.wf?raw';
import microtestWorldfile from '../worldfiles/microtest.wf?raw';
import worldfileSchema from '../worldfiles/worldfile.wfs?raw';
import { scenarioByName, type Scenario, type ScenarioName } from './scenarios';
import type { WorldSources } from './worldBoot';

const WORLDFILE_TEXT: Record<ScenarioName, string> = {
  microtest_voff: microtestWorldfile,
  microtest_von: microtestWorldfile,
  minitest_voff: minitestWorldfile,
  minitest_von: minitestWorldfile,
  hello: helloWorldfile,
  bricks_voff: bricksWorldfile,
};

export const SCHEMA_TEXT = worldfileSchema;

/** The two sources for a scenario, as the boot wants them. */
export function bundledSources(scenario: Scenario | ScenarioName): WorldSources {
  const resolved = typeof scenario === 'string' ? scenarioByName(scenario) : scenario;
  return {
    scenario: resolved,
    worldfilePath: resolved.worldfilePath,
    schemaPath: resolved.schemaPath,
    worldfileText: WORLDFILE_TEXT[resolved.name],
    schemaText: SCHEMA_TEXT,
  };
}
