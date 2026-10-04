/**
 * Lane L11 (`src/model/sim/runner.ts`) — the runner's scenario resolution, against the **merged**
 * registry the parity harness uses.
 *
 * Regression guard for the shared-boundary break `t_163c7379`: `hello` was a registered Tier-A
 * golden that `./oracle/run_parity.sh list` showed but the runner could not run, because
 * `scenarioParameters` parsed `oracle/scenarios/scenarios.json` alone — invisible to the lane
 * overlays in `tools/scenarios.d/*.json` that `tools/parity_common.py` merges over it — and it
 * *derived* the worldfile path from the scenario name (`<name-before-first-underscore>.wf` under
 * `worldfiles/tests/low-spec-pc/`), which is right for the two `low-spec-pc` test worlds by
 * coincidence and wrong for `hello` (`worldfiles/hello.wf`).
 *
 * PORT-NOTE(sim/runner-scenario-registry) and PORT-NOTE(sim/runner-scenario-worldfile) in
 * `runner.ts` carry the semantics; these assertions are the executable half. They read the
 * registry documents from disk and need no golden and no native tree, so they run everywhere.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { scenarioEntry, scenarioRegistry } from '../src/model/sim/runner';

/** The shape both registry documents share (`oracle/scenarios/scenarios.json`, lane overlays). */
interface RegistryDocument {
  scenarios?: readonly { name?: string; worldfile?: string; args?: readonly string[] }[];
}

const repoRoot = process.cwd();
const BASE_REGISTRY = join(repoRoot, 'oracle', 'scenarios', 'scenarios.json');
const OVERLAY_DIR = join(repoRoot, 'tools', 'scenarios.d');

/** Every registry document, in the merge order `parity_common.load_registry()` uses. */
function registrySources(): string[] {
  const sources = [BASE_REGISTRY];
  if (existsSync(OVERLAY_DIR)) {
    for (const name of readdirSync(OVERLAY_DIR).sort()) {
      if (name.endsWith('.json')) sources.push(join(OVERLAY_DIR, name));
    }
  }
  return sources;
}

function readDocument(path: string): RegistryDocument {
  return JSON.parse(readFileSync(path, 'utf8')) as RegistryDocument;
}

/**
 * The path the runner *used* to build from the scenario name. It is still the correct worldfile
 * for the two `low-spec-pc` test worlds; the point of the fix is that it is no longer how the
 * runner learns the path.
 */
function derivedWorldfile(name: string): string {
  return `worldfiles/tests/low-spec-pc/${name.split('_')[0]}.wf`;
}

describe('sim runner — scenario resolution', () => {
  it('merges the lane overlays over the base registry, exactly as the harness does', () => {
    const registry = scenarioRegistry(repoRoot);

    const declared = new Set<string>();
    for (const path of registrySources()) {
      for (const candidate of readDocument(path).scenarios ?? []) {
        if (candidate.name) declared.add(candidate.name);
      }
    }

    // Every scenario either document declares is resolvable by name...
    for (const name of declared) expect(registry.has(name), `missing '${name}'`).toBe(true);
    // ...and the registry invents nothing of its own.
    expect([...registry.keys()].sort()).toEqual([...declared].sort());
  });

  it('registers `hello` — the Tier-A scenario this fix unblocked', () => {
    const entry = scenarioEntry(repoRoot, 'hello');

    // `oracle/hello/meta.json` → `worldfile`/`args`/`command`
    // (`Polyworld --ui term --Vision False worldfiles/hello.wf`). The name-derived path,
    // `worldfiles/tests/low-spec-pc/hello.wf`, does not exist in the native tree: this assertion
    // is what pins "the path is read from the entry, not rebuilt from the name".
    expect(entry.worldfile).toBe('worldfiles/hello.wf');
    expect(entry.worldfile).not.toBe(derivedWorldfile('hello'));
    expect([...entry.args]).toEqual(['--Vision', 'False']);
  });

  it('does not move the four scenarios that ran before the fix', () => {
    for (const name of ['microtest_voff', 'minitest_voff', 'microtest_von', 'minitest_von']) {
      const entry = scenarioEntry(repoRoot, name);
      expect(entry.worldfile, `${name} worldfile`).toBe(derivedWorldfile(name));
      expect([...entry.args], `${name} args`).toEqual(
        [...(readDocument(entry.source).scenarios ?? [])].find((sc) => sc.name === name)?.args ?? [],
      );
    }
  });

  it('refuses an unregistered scenario, naming what is registered', () => {
    const registered = [...scenarioRegistry(repoRoot).keys()];
    expect(registered.length).toBeGreaterThan(0);

    expect(() => scenarioEntry(repoRoot, 'no_such_scenario')).toThrow(/merged scenario registry/);

    try {
      scenarioEntry(repoRoot, 'no_such_scenario');
      expect.unreachable('scenarioEntry must throw for an unregistered scenario');
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain("'no_such_scenario'");
      for (const name of registered) expect(message, `error must list '${name}'`).toContain(name);
    }
  });
});
