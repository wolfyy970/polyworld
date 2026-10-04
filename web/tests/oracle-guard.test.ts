/**
 * t_37bf7212 — the frozen-golden guard, tested against the incident it comes from.
 *
 * The incident (measured 2026-09-29 00:51–01:03, reproduced at 01:15:46 and again at 01:17:59):
 * a lane's acceptance pass ran `npx vitest run` in a git worktree whose `oracle/<scenario>/run`
 * was a **symlink into the canonical golden** (that is how a worktree gets the gitignored goldens).
 * `tests/parity-runner.test.ts` copies the golden and perturbs the copy; `cpSync` does not
 * dereference, so the copy was a tree of links into the frozen tree and the perturbations —
 * `rmSync` one manifested file, `writeFileSync` population.txt and movie.pmv, and a `reGZip()` walk
 * over every `.gz` — landed in the golden. `shasum -a 256 -c` afterwards: **97/225 OK**, with
 * `run/events/carry.log` and `run/brain/anatomy/brainAnatomy_10_birth.txt.gz` gone. Six unrelated
 * test files went red for every lane that graded in that window.
 *
 * Every test below is non-destructive: the refusals happen before a byte is written, and the one
 * test that does write writes into a **fixture** oracle under $TMPDIR (so a reverted guard makes
 * the test fail without touching the repo's goldens).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fsNamespace from 'node:fs';
import fsDefault from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { rmSync as rawRmSync } from 'fs';
// The **unaliased** builtin, reached as the module object (`import fs from 'fs'` — the spelling the
// guard internals use). `vitest.config.ts` aliases only the `node:fs` specifier, so this is the raw
// builtin whose own members `installGoldenWriteTripwire` patches; t_833bee5f's test below is what
// holds that half of the net to account.
import rawFs from 'fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  GoldenWriteRefused,
  assertNotGoldenWrite,
  assertUsableStagingRoot,
  goldenTripwireInstalled,
  goldenWriteTarget,
  isGoldenPath,
  isStagedPath,
  oracleRoot,
  resolveExisting,
  stageGoldenCopy,
} from '../src/oracle/guard';
import { candidateRoot, writeCandidateTree } from '../src/browser/sim/nodeSources';
import { runScenario } from '../src/model/sim/runner';
import { freshDir } from './logsReplay';
import { CANDIDATE_ROOT, defaultLogsCandidateRoot } from './logsCorpus';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'pw-guard-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** The scenarios the repo has recorded (a golden = a scenario dir holding a manifested `run/`). */
function recordedScenarios(): string[] {
  return readdirSync(oracleRoot()).filter((name) => {
    if (name.startsWith('_')) return false;
    try {
      return statSync(join(oracleRoot(), name, 'run', 'manifest.sha256')).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * A miniature oracle under $TMPDIR: one scenario whose `run/` holds a manifested file. The guard
 * judges by shape, not by the real tree, so this exercises every refusal without going near the
 * repository's goldens.
 */
function fixtureOracle(label: string): { root: string; scenarioDir: string; runDir: string; file: string } {
  const root = join(work, label, 'oracle');
  const scenarioDir = join(root, 'microtest_voff');
  const runDir = join(scenarioDir, 'run');
  mkdirSync(runDir, { recursive: true });
  const file = join(runDir, 'population.txt');
  writeFileSync(file, '#<Population>\n0 1\n');
  writeFileSync(join(runDir, 'manifest.sha256'), 'irrelevant  run/population.txt\n');
  return { root, scenarioDir, runDir, file };
}

function withOracleRoot<T>(root: string, body: () => T): T {
  const previous = process.env.POLYWORLD_ORACLE_ROOT;
  process.env.POLYWORLD_ORACLE_ROOT = root;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.POLYWORLD_ORACLE_ROOT;
    else process.env.POLYWORLD_ORACLE_ROOT = previous;
  }
}

describe('the frozen-golden guard', () => {
  it('arms a tripwire that every import style of node:fs goes through', async () => {
    expect(goldenTripwireInstalled()).toBe(true);
    expect(process.env.POLYWORLD_GOLDEN_TRIPWIRE).toBe('installed');

    // Every import style a test can write with, asserted rather than assumed. The static named
    // import is the style patching the builtin's own object does *not* intercept (measured) and the
    // reason vitest.config.ts aliases the specifier; the other three are here so the claim in this
    // test's name is proven, and so a style that stops being intercepted fails here (t_06238505:
    // the removal entry points were exactly that, one style along).
    const dynamicFs = await import('node:fs');
    const styles: [string, (file: string) => void][] = [
      ['named import', (file) => writeFileSync(file, 'clobbered\n')],
      ['namespace import', (file) => fsNamespace.writeFileSync(file, 'clobbered\n')],
      ['default import', (file) => fsDefault.writeFileSync(file, 'clobbered\n')],
      ['dynamic import', (file) => dynamicFs.writeFileSync(file, 'clobbered\n')],
    ];

    const fixture = fixtureOracle('armed');
    const before = readFileSync(fixture.file, 'utf8');
    withOracleRoot(fixture.root, () => {
      for (const [style, write] of styles) {
        expect(() => write(fixture.file), style).toThrow(GoldenWriteRefused);
      }
      expect(() => rmSync(fixture.runDir, { recursive: true })).toThrow(/frozen golden/);
    });
    expect(readFileSync(fixture.file, 'utf8')).toBe(before);
    expect(readdirSync(fixture.runDir).sort()).toEqual(['manifest.sha256', 'population.txt']);
  });

  it('refuses a removal at the call, not by hoping the runtime re-enters our wrappers', () => {
    // t_06238505. `rmSync`/`rm` were in neither half of the net, and the tripwire only looked like
    // it covered them: node ≤ 22 implements `rmSync(recursive)` by calling the public
    // `unlinkSync`/`rmdirSync` the net does wrap, so the wipe was refused — node ≥ 24 walks the
    // tree through internal bindings and never re-enters them. Measured, the same committed test
    // file, one engine per run: node 22.22.2 refuses, node 24.21.0 and node 26.7.0 **delete the
    // tree** (the assertion above was the one red test in the suite, on the engines a login shell
    // resolves to). The removal entry points are wrapped now, so the refusal is the guard's own
    // and engine-independent.
    const fixture = fixtureOracle('removal');
    const worktree = join(work, 'removal-wt');
    const linkedScenario = join(worktree, 'oracle', 'microtest_voff');
    mkdirSync(linkedScenario, { recursive: true });
    symlinkSync(fixture.runDir, join(linkedScenario, 'run'), 'dir');

    withOracleRoot(fixture.root, () => {
      // The incident's own wipe step, one manifested file at a time, through a symlinked `run/`.
      expect(() => rmSync(join(linkedScenario, 'run', 'population.txt'))).toThrow(/frozen golden/);
      expect(() => rmSync(fixture.runDir, { recursive: true })).toThrow(/frozen golden/);
      expect(() => rmSync(join(fixture.scenarioDir), { recursive: true })).toThrow(/frozen golden/);
      // …and the promise form, which is the same entry point on the alias' `promises` surface.
      expect(() => fsPromises.rm(fixture.runDir, { recursive: true })).toThrow(/frozen golden/);
    });
    expect(readdirSync(fixture.runDir).sort()).toEqual(['manifest.sha256', 'population.txt']);
    expect(readFileSync(fixture.file, 'utf8')).toBe('#<Population>\n0 1\n');

    // A lane can still clean its worktree up: removing the *link* writes nothing.
    rmSync(join(linkedScenario, 'run'));
    expect(existsSync(join(linkedScenario, 'run'))).toBe(false);
  });

  it('wraps the builtin’s own top-level async entry points — the `fs` spelling, callback form', async () => {
    // t_833bee5f. `installGoldenWriteTripwire` wrapped the 16 sync names and the 13 `promises.*`
    // names; the builtin's **own** top-level async/callback names were not in the report, so
    // `import fs from 'fs'` (the unaliased spelling, which reaches the raw module object — the
    // alias only rewrites the `node:fs` specifier) went straight through with the tripwire armed:
    // measured on node 22.22.2 against a fixture oracle, `fs.rm(<golden run dir>, {recursive:true},
    // cb)` deleted the tree, `fs.unlink(<golden file>, cb)` deleted the file and
    // `fs.writeFile(<golden file>, …, cb)` overwrote it, while `fs.rmSync`/`fs.promises.rm` were
    // refused. The net exists to catch a writer nobody has thought of; a new test written in this
    // spelling with the callback form would have deleted a golden on every engine.
    //
    // Engine-independent by construction: the refusal happens at the call (the wrapper never
    // invokes the builtin), so it does not depend on node's own `rm` walk re-entering the public
    // per-entry functions — which node ≥ 24's internal-binding walk does not do (t_06238505).
    const fixture = fixtureOracle('async-builtin');
    const worktree = join(work, 'async-wt');
    const linkedScenario = join(worktree, 'oracle', 'microtest_voff');
    mkdirSync(linkedScenario, { recursive: true });
    const linkedRun = join(linkedScenario, 'run');
    symlinkSync(fixture.runDir, linkedRun, 'dir');

    const landed: string[] = [];
    withOracleRoot(fixture.root, () => {
      const callback = (label: string) => () => landed.push(label);
      // The three callback shapes the probe measured, through the raw builtin object.
      expect(() => rawFs.rm(fixture.runDir, { recursive: true }, callback('rm'))).toThrow(
        GoldenWriteRefused,
      );
      expect(() => rawFs.rm(fixture.scenarioDir, { recursive: true }, callback('rm-scenario'))).toThrow(
        /frozen golden/,
      );
      expect(() => rawFs.unlink(join(fixture.runDir, 'manifest.sha256'), callback('unlink'))).toThrow(
        GoldenWriteRefused,
      );
      expect(() => rawFs.writeFile(fixture.file, 'clobbered\n', callback('writeFile'))).toThrow(
        GoldenWriteRefused,
      );
      // …and through a `run/` symlinked at the golden, the shape a lane's worktree has.
      expect(() => rawFs.unlink(join(linkedRun, 'population.txt'), callback('unlink-link'))).toThrow(
        GoldenWriteRefused,
      );
    });

    // The refusal is synchronous (the callback never runs), and nothing lands on a later tick
    // either: the builtin was never called.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(landed).toEqual([]);
    expect(readdirSync(fixture.runDir).sort()).toEqual(['manifest.sha256', 'population.txt']);
    expect(readFileSync(fixture.file, 'utf8')).toBe('#<Population>\n0 1\n');

    // …and the net does not over-refuse: removing the *link* through the same spelling is legal and
    // still removes the link, not what it points at (a lane has to be able to clean its worktree).
    await new Promise((resolve, reject) => rawFs.rm(linkedRun, (err) => (err ? reject(err) : resolve(null))));
    expect(existsSync(linkedRun)).toBe(false);
    expect(readdirSync(fixture.runDir).sort()).toEqual(['manifest.sha256', 'population.txt']);
  });

  it('refuses the canonical golden as a write target, a candidate and a staging root', () => {
    const scenarios = recordedScenarios();
    expect(scenarios.length, 'this repo has recorded goldens').toBeGreaterThan(0);

    for (const scenario of scenarios) {
      const runDir = join(oracleRoot(), scenario, 'run');
      const runFile = join(runDir, 'population.txt');
      expect(isGoldenPath(runFile), scenario).toBe(true);
      expect(goldenWriteTarget(runFile)?.scenario, scenario).toBe(scenario);
      expect(() => assertNotGoldenWrite(runFile, 'test'), scenario).toThrow(/frozen golden/);
      expect(() => assertNotGoldenWrite(runDir, 'test'), scenario).toThrow(GoldenWriteRefused);
      expect(() => assertUsableStagingRoot(join(oracleRoot(), scenario), 'test'), scenario).toThrow(
        /frozen golden|oracle's own namespace/,
      );
      expect(() => assertUsableStagingRoot(runDir, 'test'), scenario).toThrow(GoldenWriteRefused);
    }
    // The oracle root itself is never a staging root.
    expect(() => assertUsableStagingRoot(oracleRoot(), 'test')).toThrow(/namespace|frozen golden/);
  });

  it('reaches a golden through a worktree symlink and still refuses (the incident)', () => {
    const fixture = fixtureOracle('symlinked');
    // `<worktree>/oracle/<scenario>` with its `run/` symlinked at the golden — exactly how a lane's
    // worktree gets the gitignored goldens.
    const worktree = join(work, 'symlinked-wt');
    const linkedScenario = join(worktree, 'oracle', 'microtest_voff');
    mkdirSync(linkedScenario, { recursive: true });
    symlinkSync(fixture.runDir, join(linkedScenario, 'run'), 'dir');

    withOracleRoot(fixture.root, () => {
      expect(isGoldenPath(join(linkedScenario, 'run', 'population.txt'))).toBe(true);
      expect(() => assertNotGoldenWrite(join(linkedScenario, 'run', 'population.txt'), 'worktree')).toThrow(
        /frozen golden/,
      );
      // The candidate/staging roots a lane in that worktree would hand a tool: the scenario dir
      // and the symlinked run tree both resolve into the golden, so both are refused.
      expect(() => assertUsableStagingRoot(linkedScenario, 'worktree')).toThrow(/frozen golden/);
      expect(() => assertUsableStagingRoot(join(linkedScenario, 'run'), 'worktree')).toThrow(/frozen golden/);
      // …and the same shape pointed at the *real* oracle: the refusal names the real golden.
      const realLink = join(work, 'real-wt', 'oracle', recordedScenarios()[0]!);
      mkdirSync(realLink, { recursive: true });
      symlinkSync(
        join(oracleRoot(), recordedScenarios()[0]!, 'run'),
        join(realLink, 'run'),
        'dir',
      );
      expect(() => assertNotGoldenWrite(join(realLink, 'run', 'population.txt'), 'real-wt')).toThrow(
        /frozen golden/,
      );
    });
  });

  it('hands out a copy that is a copy: perturbing it cannot reach the golden', () => {
    const fixture = fixtureOracle('copy');
    const worktree = join(work, 'copy-wt');
    const linkedScenario = join(worktree, 'oracle', 'microtest_voff');
    mkdirSync(linkedScenario, { recursive: true });
    symlinkSync(fixture.runDir, join(linkedScenario, 'run'), 'dir');

    withOracleRoot(fixture.root, () => {
      const staged = stageGoldenCopy(linkedScenario, join(work, 'staged'), 'microtest_voff');
      const links: string[] = [];
      const walk = (dir: string, prefix: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) links.push(`${prefix}${entry.name}`);
          else if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
        }
      };
      walk(staged, '');
      expect(links).toEqual([]);

      // The perturbation that clobbered the golden: it must now land in the copy only.
      writeFileSync(join(staged, 'run', 'population.txt'), 'perturbed\n');
      rmSync(join(staged, 'run', 'manifest.sha256'));
      expect(readFileSync(fixture.file, 'utf8')).toBe('#<Population>\n0 1\n');
      expect(readdirSync(fixture.runDir).sort()).toEqual(['manifest.sha256', 'population.txt']);
    });
  });

  it('allows the staging roots the project reserves, and refuses the wipe of a golden', () => {
    expect(isStagedPath(join(oracleRoot(), '_t_logs_candidates', 'microtest_voff'))).toBe(true);
    expect(isStagedPath(join(work, 'anything'))).toBe(true);
    expect(isStagedPath(join(oracleRoot(), 'microtest_voff', 'run'))).toBe(false);

    expect(() => assertUsableStagingRoot(join(oracleRoot(), '_t_logs_candidates'), 'test')).not.toThrow();
    expect(() => assertUsableStagingRoot(join(work, 'candidate'), 'test')).not.toThrow();

    const fixture = fixtureOracle('freshdir');
    withOracleRoot(fixture.root, () => {
      // `freshDir` is `rmSync(recursive)` + `mkdir` — the wipe half of the incident (a candidate
      // root of `oracle` made the replay's candidate tree *be* the golden).
      expect(() => freshDir(fixture.runDir)).toThrow(GoldenWriteRefused);
      expect(() => freshDir(join(fixture.scenarioDir))).toThrow(GoldenWriteRefused);
      expect(readdirSync(fixture.runDir).sort()).toEqual(['manifest.sha256', 'population.txt']);
    });
  });

  it('refuses the golden as the browser lane candidate root, and as a write root', () => {
    const fixture = fixtureOracle('browser');
    const previous = process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT;
    try {
      withOracleRoot(fixture.root, () => {
        process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT = fixture.root;
        expect(() => candidateRoot()).toThrow(GoldenWriteRefused);
        process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT = fixture.scenarioDir;
        expect(() => candidateRoot()).toThrow(GoldenWriteRefused);
        process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT = join(work, 'browser-candidates');
        expect(() => candidateRoot()).not.toThrow();

        // …and `writeCandidateTree` (which writes `<root>/<scenario>/run/**` file by file) refuses
        // before the first byte.
        expect(() =>
          writeCandidateTree(fixture.root, 'microtest_voff', new Map([['run/population.txt', 'x']])),
        ).toThrow(GoldenWriteRefused);
      });
      expect(readFileSync(fixture.file, 'utf8')).toBe('#<Population>\n0 1\n');
    } finally {
      if (previous === undefined) delete process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT;
      else process.env.POLYWORLD_BROWSER_CANDIDATE_ROOT = previous;
    }
  });

  it('refuses a golden reached through a symlink that resolves outside the configured oracle root', () => {
    // The lane shape measured in t_4bb10112's log: `ln -sfn <canonical>/oracle/<s>/run
    // <worktree>/oracle/<s>/run`, with the worktree's own oracle root in play. The golden the link
    // points at then sits *outside* the root the guard is configured with — no oracle-relative test
    // can see it, which is why the manifest marker is the second half of the rule.
    const scenario = 'microtest_voff';
    expect(recordedScenarios(), 'the incident scenario is recorded here').toContain(scenario);
    const canonicalRun = join(oracleRoot(), scenario, 'run');

    const laneOracle = join(work, 'lane-wt', 'oracle');
    const linkedScenario = join(laneOracle, scenario);
    mkdirSync(linkedScenario, { recursive: true });
    symlinkSync(canonicalRun, join(linkedScenario, 'run'), 'dir');

    withOracleRoot(laneOracle, () => {
      const throughLink = join(linkedScenario, 'run', 'population.txt');
      expect(isGoldenPath(throughLink), 'the symlink resolves into a golden').toBe(true);
      expect(isGoldenPath(join(linkedScenario, 'run'))).toBe(true);
      expect(goldenWriteTarget(throughLink)?.runDir).toBe(resolveExisting(canonicalRun));
      expect(() => assertNotGoldenWrite(throughLink, 'lane worktree')).toThrow(/frozen golden/);
      // The tripwire refuses the write itself, wherever the pointer came from. The probe name is
      // not a manifested file, so a reverted guard leaves a stray unlisted file rather than
      // corrupting a golden — and the test cleans that up below.
      const probe = join(linkedScenario, 'run', 't37-guard-probe.txt');
      expect(() => writeFileSync(probe, 'clobbered\n')).toThrow(/frozen golden/);
      if (existsSync(probe)) rawRmSync(probe, { force: true });
      expect(existsSync(probe)).toBe(false);
    });

    // A candidate that holds a *copied* manifest is still a candidate ($TMPDIR and `_t_*` paths are
    // staging): otherwise every golden copy the parity tests perturb would be refused.
    const staged = join(work, 'staged-with-manifest', 'run');
    mkdirSync(staged, { recursive: true });
    copyFileSync(join(canonicalRun, 'manifest.sha256'), join(staged, 'manifest.sha256'));
    expect(isGoldenPath(join(staged, 'population.txt'))).toBe(false);
    writeFileSync(join(staged, 'population.txt'), 'perturbed\n');

    // …and a lane can still clean its worktree up: removing the *link* writes nothing.
    rmSync(join(linkedScenario, 'run'));
    expect(existsSync(join(linkedScenario, 'run'))).toBe(false);
  });

  it('keys the logs corpus staging root by worker process, so two runs cannot share it', () => {
    const root = defaultLogsCandidateRoot(REPO, 111, 0);
    expect(root).toBe(join(REPO, 'oracle', '_t_logs_candidates', 'pid-111'));
    // A second process — or a second vitest worker thread inside one process — never gets the same
    // tree: the shared root was the second false-red generator (ENOTEMPTY/EEXIST/ENOENT in the
    // replay's `freshDir`, which wipes `rmSync(recursive)` + mkdir while the recorders write).
    expect(defaultLogsCandidateRoot(REPO, 222, 0)).not.toBe(root);
    expect(defaultLogsCandidateRoot(REPO, 111, 1)).not.toBe(root);
    // …and what it produces is a staging root the guard allows.
    expect(isStagedPath(root)).toBe(true);
    expect(() => assertUsableStagingRoot(root, 'logs corpus')).not.toThrow();

    if (process.env.POLYWORLD_LOGS_CANDIDATE_ROOT === undefined) {
      // The live constant a lane stages into: per-process, and a legal (staged) root.
      expect(CANDIDATE_ROOT.startsWith(join(REPO, 'oracle', '_t_logs_candidates', 'pid-'))).toBe(true);
      expect(isStagedPath(CANDIDATE_ROOT)).toBe(true);
      expect(() => assertUsableStagingRoot(CANDIDATE_ROOT, 'logs corpus')).not.toThrow();
    }
  });

  it('refuses the golden as the model runner outDir — the entry point every lane grades with', () => {
    const fixture = fixtureOracle('runner');
    withOracleRoot(fixture.root, () => {
      for (const outDir of [fixture.root, fixture.scenarioDir, fixture.runDir]) {
        // The runner's own refusal, not the tripwire's: `assertUsableStagingRoot` runs before the
        // first `mkdirSync`, so this test fails if that call is dropped (the tripwire would then
        // throw a `golden tripwire: mkdirSync() refused …` message instead) and it fails fast —
        // no scenario is read and no simulation boots.
        expect(
          () => runScenario({ scenario: 'microtest_voff', outDir, maxSteps: 1, repoRoot: REPO }),
          outDir,
        ).toThrow(/runScenario\('microtest_voff'\) outDir: refusing .* as a staging root/);
      }
    });
    expect(readdirSync(fixture.runDir).sort()).toEqual(['manifest.sha256', 'population.txt']);
    expect(readFileSync(fixture.file, 'utf8')).toBe('#<Population>\n0 1\n');
  });

  it('the harness refuses a golden candidate too (tools/check_parity.py)', () => {
    const fixture = fixtureOracle('python');
    const script = join(REPO, 'tools', 'check_parity.py');
    const env = { ...process.env, POLYWORLD_ORACLE_ROOT: fixture.root };
    // `--candidate` is resolved; the same predicate runs in python, on the real path it resolves
    // to, so a symlinked worktree oracle is refused there as well.
    for (const candidate of [fixture.runDir, fixture.scenarioDir, fixture.root]) {
      const res = spawnSync('python3', [script, '--golden', fixture.scenarioDir, '--candidate', candidate], {
        cwd: REPO,
        encoding: 'utf8',
        env,
      });
      expect(res.status, `${candidate}: ${res.stderr}`).toBe(2);
      expect(res.stderr, candidate).toMatch(/frozen golden/);
    }
    const allowed = spawnSync(
      'python3',
      [script, '--golden', fixture.scenarioDir, '--candidate', join(work, 'nowhere')],
      { cwd: REPO, encoding: 'utf8', env },
    );
    // Not a golden refusal: the candidate simply does not exist (that is the harness's own path).
    expect(allowed.stderr).not.toMatch(/frozen golden/);
  });

  it('the python half refuses the worktree shape — a symlinked run/ whose golden is outside the configured root (t_f049065c)', () => {
    // The card's table, measured at its parent d150ac6 and at d0231eb in a real git worktree: with
    // `POLYWORLD_ORACLE_ROOT` unset (the harness's root is then `<worktree>/oracle`), `--candidate
    // <wt>/oracle/<scenario>/run` — the symlink a lane gets its gitignored goldens through — was
    // **allowed**, and the harness reported `PASS (225/225 files)`: the frozen golden compared with
    // itself. The scenario-dir spelling was refused, so the two halves of the net disagreed on
    // exactly the shape a lane grades in, and the false green is worse than a missing refusal. The
    // python half now decides with the same marker predicate as `src/oracle/guard.ts`
    // (`goldenWriteTarget`/`resolvedGoldenRunDir`), so which root is configured decides nothing
    // about what a golden *is*.
    const scenario = 'microtest_voff';
    expect(recordedScenarios(), 'the incident scenario is recorded here').toContain(scenario);
    const canonical = join(oracleRoot(), scenario);
    const manifest = join(canonical, 'run', 'manifest.sha256');
    const before = readFileSync(manifest, 'utf8');

    // A lane's worktree oracle under $TMPDIR: `<root>/<scenario>/run` is a symlink at the golden,
    // which then lives *outside* the root handed to the harness — and outside $TMPDIR, so it is not
    // a candidate path either. `$TMPDIR` and `oracle/_t_*` stay exempt (a lane's own staged copies
    // hold a manifest too, and perturbing those is the point of `tests/parity-runner.test.ts`).
    const laneOracle = join(work, 'python-worktree', 'oracle');
    const linkedScenario = join(laneOracle, scenario);
    mkdirSync(linkedScenario, { recursive: true });
    symlinkSync(join(canonical, 'run'), join(linkedScenario, 'run'), 'dir');

    const script = join(REPO, 'tools', 'check_parity.py');
    for (const candidate of [linkedScenario, join(linkedScenario, 'run')]) {
      const env: NodeJS.ProcessEnv = { ...process.env, POLYWORLD_ORACLE_ROOT: laneOracle };
      const res = spawnSync(
        'python3',
        [script, '--golden', canonical, '--scenario', scenario, '--candidate', candidate],
        { cwd: REPO, encoding: 'utf8', env },
      );
      expect(res.status, `${candidate}: ${res.stderr}`).toBe(2);
      expect(res.stderr, candidate).toMatch(/frozen golden/);
      // The false green this closes: the golden is never compared with itself.
      expect(res.stdout, candidate).not.toMatch(/parity: (PASS|FAIL)/);
    }
    // …and nothing was written through the link while refusing.
    expect(readFileSync(manifest, 'utf8')).toBe(before);
  });
});
