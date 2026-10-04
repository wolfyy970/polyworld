/**
 * Lane L18 (browser wiring) — the recorded scenarios the shell can boot, and the two source
 * files each one needs.
 *
 * PORT-NOTE (L18/scenarios): the browser boots from the *recorded source files* of a golden
 * scenario. Native `TSimulation` runs on a worldfile passed on argv plus
 * `./etc/worldfile.wfs`; the recorded `run/` tree keeps byte-identical copies of both
 * (`run/original.wf`, `run/original.wfs` — native `Simulation.cc:450-451` `cp`s its inputs
 * there), and those copies are what the browser reads. Verified on this machine: the
 * recorded `original.wf` is sha256-identical to `../polyworld/worldfiles/tests/low-spec-pc/
 * microtest.wf`, and `original.wfs` to `../polyworld/etc/worldfile.wfs`.
 *
 * PORT-NOTE (L18/parameters): a scenario's `args` are the native command line. Native
 * `--Key value` parameters reach the worldfile through `WorldfileConverter::setParameters`
 * ("`--Vision False`"), which is the same path `emitNormalizedWorldfile` takes, so the
 * parameters are applied by lane W1b's converter, not re-implemented here. The parameter
 * *is* part of the golden bytes: `microtest_voff` and `microtest_von` have different
 * `run/normalized.wf` (Vision False vs True).
 *
 * PORT-NOTE (L18/hello-is-a-literal-world): `hello` (lane L20's demo world) is registered here
 * like any other scenario, and its recorded sources are the same two files: its
 * `oracle/hello/run/original.wf` is a byte copy of native `worldfiles/hello.wf` and its
 * `original.wfs` of native `etc/worldfile.wfs` (both verified on this machine, and the
 * `bundledWorlds.ts` copies with them). What differs is that `hello.wf` pins **one** key
 * (`MaxSteps 500`, 25 bytes) and lets the schema defaults describe everything else — so the
 * world it boots is the schema's, not a test fixture's: `WorldSize 100`, `InitAgents 180` /
 * `MinAgents 90` / `MaxAgents 300`, `RecordAll False` / `RecordFrequency 1000`, and only six
 * status files over the run (`run/stats/stat.{1,100,200,300,400,500}`).
 */

import { NATIVE_SCHEMA_PATH } from '../../model/proplib';

export type ScenarioName =
  | 'microtest_voff'
  | 'microtest_von'
  | 'minitest_voff'
  | 'minitest_von'
  | 'hello'
  | 'bricks_voff';

export interface Scenario {
  readonly name: ScenarioName;
  /** Native argv path (`worldfiles/tests/low-spec-pc/minitest.wf`). */
  readonly worldfilePath: string;
  /** Native argv path of the schema (`./etc/worldfile.wfs`). */
  readonly schemaPath: string;
  /** Native `--Key value` overrides, in argv order (see the PORT-NOTE above). */
  readonly parameters: readonly (readonly [string, string])[];
  /** `A`/`B` describe a *recorded* golden's tier; `demo` is a browser-only world with no golden. */
  readonly tier: 'A' | 'B' | 'demo';
}

const TEST_WORLDFILES = 'worldfiles/tests/low-spec-pc';

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'microtest_voff',
    worldfilePath: `${TEST_WORLDFILES}/microtest.wf`,
    schemaPath: NATIVE_SCHEMA_PATH,
    parameters: [['Vision', 'False']],
    tier: 'A',
  },
  {
    name: 'microtest_von',
    worldfilePath: `${TEST_WORLDFILES}/microtest.wf`,
    schemaPath: NATIVE_SCHEMA_PATH,
    parameters: [],
    tier: 'B',
  },
  {
    name: 'minitest_voff',
    worldfilePath: `${TEST_WORLDFILES}/minitest.wf`,
    schemaPath: NATIVE_SCHEMA_PATH,
    parameters: [['Vision', 'False']],
    tier: 'A',
  },
  {
    name: 'minitest_von',
    worldfilePath: `${TEST_WORLDFILES}/minitest.wf`,
    schemaPath: NATIVE_SCHEMA_PATH,
    parameters: [],
    tier: 'B',
  },
  {
    name: 'hello',
    worldfilePath: 'worldfiles/hello.wf',
    schemaPath: NATIVE_SCHEMA_PATH,
    parameters: [['Vision', 'False']],
    tier: 'A',
  },
];

/**
 * PORT-NOTE (L18/demo-scenarios): browser-only worlds. Every entry in {@link SCENARIOS} is a
 * *recorded* scenario — it has an `oracle/<name>/run/**` golden the parity suite compares against
 * (`worldBoot.test.ts`), so its `tier` is `A`/`B`. A demo scenario has **no golden**: it exists so
 * the page can show a piece of the model the recorded worlds do not exercise. `bricks_voff` is the
 * one such world today — native's `worldfiles/m-neurons/growingBarriers_grayBricks.wf`, which is the
 * smallest native worldfile that declares `BrickPatches` (100 bricks at the world's far edge) and is
 * therefore the only way to *see* bricks on the page (the low-spec-pc fixtures declare none). It is
 * a verbatim copy of the native file, byte-checked against `../polyworld/**` by `worldBoot.test.ts`,
 * and its numbers are the model's own — nothing about the world is invented here.
 *
 * The parity suite never iterates this list: `SCENARIOS` is the recorded set, so a demo world cannot
 * silently acquire parity expectations it has no golden for (`goldenAvailable` stays a property of
 * the recorded set).
 */
export const DEMO_SCENARIOS: readonly Scenario[] = [
  {
    name: 'bricks_voff',
    worldfilePath: 'worldfiles/m-neurons/growingBarriers_grayBricks.wf',
    schemaPath: NATIVE_SCHEMA_PATH,
    parameters: [['Vision', 'False']],
    tier: 'demo',
  },
];

/** Recorded + demo worlds — what the page may be asked to boot (`?scenario=`). */
const ALL_SCENARIOS: readonly Scenario[] = [...SCENARIOS, ...DEMO_SCENARIOS];

/**
 * PORT-NOTE (L18/default-scenario): the demo's default is `minitest_voff` — the recorded
 * scenario with a non-trivial step budget (`MaxSteps 301`; `microtest` records a single
 * step). Nothing in the shell is frozen, so this is a usability choice, not a model one.
 */
export const DEFAULT_SCENARIO: ScenarioName = 'minitest_voff';

export function scenarioByName(name: string | null | undefined): Scenario {
  const match = ALL_SCENARIOS.find((scenario) => scenario.name === name);
  if (match) return match;
  return SCENARIOS.find((scenario) => scenario.name === DEFAULT_SCENARIO)!;
}

export function isScenarioName(name: string | null | undefined): name is ScenarioName {
  return ALL_SCENARIOS.some((scenario) => scenario.name === name);
}

export function scenarioNames(): readonly ScenarioName[] {
  return ALL_SCENARIOS.map((scenario) => scenario.name);
}

/** The `ParameterMap` shape `emitNormalizedWorldfile` takes (a fresh Map per boot). */
export function parameterMap(scenario: Scenario): Map<string, string> {
  return new Map(scenario.parameters.map(([key, value]) => [key, value]));
}
