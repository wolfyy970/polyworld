/**
 * W1f -- acceptance tests for the per-lane parity harness (oracle/run_parity.sh).
 *
 * The card's acceptance criteria, encoded:
 *   - the script exits 0 on a clean copy of a golden;
 *   - the script exits 1 on a perturbed copy of the same golden;
 * and the two supporting behaviours a lane depends on: the registry resolves
 * per-scenario ignore patterns, and a candidate that is missing a manifested
 * file fails.
 *
 * No native build is invoked here: these tests only exercise the comparison
 * path, so they are safe to run in parallel with lane work.
 * Load, not slowness of the code: the guarded test(s) are 389 ms solo and 3.1 s under four
 * concurrent full suites — the band that false-reds when the fleet's three concurrent pairs
 * (6 processes) run. They carry LOAD_TIMEOUT_MS below; no assertion changed.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { stageGoldenCopy } from '../src/oracle/guard';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_PARITY = join(REPO, 'oracle', 'run_parity.sh');
const SCENARIO = 'microtest_voff';
const GOLDEN = join(REPO, 'oracle', SCENARIO);

const work = mkdtempSync(join(tmpdir(), 'pw-parity-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function runParity(args: string[]) {
  return spawnSync('bash', [RUN_PARITY, ...args], { cwd: REPO, encoding: 'utf8' });
}

/**
 * A **real** copy of the golden to perturb.
 *
 * t_37bf7212: `cpSync(GOLDEN, dest, { recursive: true })` does not dereference, so in a lane's
 * git worktree — where `oracle/<scenario>/run` is a symlink into the canonical golden — the
 * "copy" was a tree of links straight back into the frozen oracle, and every perturbation below
 * (`rmSync` a manifested file, `writeFileSync` population.txt/movie.pmv, `reGZip` over every
 * `.gz` the copy holds) wrote the golden itself. 97/225 files verified afterwards, and six unrelated
 * test files went red for every lane grading in that window. `stageGoldenCopy` dereferences,
 * refuses a destination inside a golden, and proves the result holds no symlinks.
 */
function copyGolden(name: string): string {
  return stageGoldenCopy(GOLDEN, join(work, name), SCENARIO, `parity-runner/${name}`);
}

/**
 * Vitest's default is 5 s. The guarded test(s) are 389 ms solo and 3.1 s under four concurrent
 * full suites; the fleet also runs three concurrent pairs (6 processes), and at that load the
 * orchestrator measured a 946 ms-solo test false-red 6/6 on 2026-09-29 — this is the same band.
 * 60 s is the budget the vision-on gate already carries (t_1f4a7a8a): that measurement with room,
 * and still a guard, so a genuine hang fails.
 */
const LOAD_TIMEOUT_MS = 60_000;

describe('oracle/run_parity.sh', () => {
  it('lists the registry and resolves per-scenario ignores', () => {
    const res = runParity(['list', '--json']);
    expect(res.status).toBe(0);
    const registry = JSON.parse(res.stdout) as {
      scenarios: Array<{ name: string; args: string[]; ignore: string[] }>;
    };
    const names = registry.scenarios.map((s) => s.name);
    expect(names).toContain(SCENARIO);
    expect(names).toContain('minitest_von');

    const visionOff = registry.scenarios.find((s) => s.name === SCENARIO)!;
    expect(visionOff.args).toEqual(['--Vision', 'False']);
    expect(visionOff.ignore).toContain('run/.cppprops/');
    // t_588c28e1: PORT_SPEC.md declares `run/movie.pmv` free, not frozen, so it is
    // never part of a byte-exact number -- at ANY tier, not just the vision-on one.
    // Measured: three fresh native runs of minitest_voff produced two distinct
    // movies, one of them the golden.
    expect(visionOff.ignore).toContain('run/movie.pmv');
    // vision on: the movie was the first artifact measured not to reproduce run-to-run
    const visionOn = registry.scenarios.find((s) => s.name === 'minitest_von')!;
    expect(visionOn.ignore).toContain('run/movie.pmv');
  });

  it('exits 0 on a clean goldens copy', () => {
    const candidate = copyGolden('clean');
    const res = runParity([SCENARIO, '--candidate', candidate]);
    expect(res.stderr).not.toMatch(/error/i);
    expect(res.stdout).toMatch(/match 225\/225/);
    expect(res.stdout).toMatch(/parity: PASS/);
    expect(res.status).toBe(0);
  });

  it('exits 1 on a one-byte perturbation, naming the file and the first divergence', () => {
    const candidate = copyGolden('perturbed');
    const file = join(candidate, 'run', 'population.txt');
    const bytes = readFileSync(file);
    const at = bytes.indexOf(Buffer.from('#<Population>'));
    const index = bytes.indexOf(Buffer.from('25'), at + '#<Population>'.length);
    expect(index).toBeGreaterThan(at);
    const perturbed = Buffer.from(bytes);
    perturbed[index] = 0x39; // '9'
    writeFileSync(file, perturbed);

    const res = runParity([SCENARIO, '--candidate', candidate]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/DIFFERS run\/population\.txt/);
    expect(res.stdout).toMatch(/FIRST DIVERGENCE in run\/population\.txt at line \d+/);
    expect(res.stdout).toMatch(/parity: FAIL/);
  });

  it('exits 1 and reports MISSING when a manifested file is absent', () => {
    const candidate = copyGolden('missing');
    rmSync(join(candidate, 'run', 'events', 'carry.log'));
    const res = runParity([SCENARIO, '--candidate', candidate]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/MISSING run\/events\/carry\.log/);
  });

  it('does not fail a tier-A candidate whose only difference is the free movie (t_588c28e1)', () => {
    const candidate = copyGolden('movie-perturbed');
    const movie = join(candidate, 'run', 'movie.pmv');
    const bytes = readFileSync(movie);
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0xff;
    writeFileSync(movie, bytes);

    const res = runParity([SCENARIO, '--candidate', candidate]);
    expect(res.stderr).not.toMatch(/error/i);
    expect(res.stdout).toMatch(/differing=0/);
    expect(res.stdout).toMatch(/IGNORED \(1, not part of the contract\): run\/movie\.pmv/);
    expect(res.stdout).toMatch(/parity: PASS/);
    expect(res.status).toBe(0);
  }, LOAD_TIMEOUT_MS);

  it('emits machine-readable JSON for lane tooling', () => {
    const candidate = copyGolden('json');
    const res = runParity([SCENARIO, '--candidate', candidate, '--json']);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as { verdict: string; manifest_files: number; failed: number };
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.failed).toBe(0);
    expect(parsed.manifest_files).toBe(225);
  }, LOAD_TIMEOUT_MS);

  it('refuses to compare against an unknown scenario (usage error, exit 2)', () => {
    const res = runParity(['no_such_scenario', '--candidate', GOLDEN]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/unknown scenario/);
  });

  it('refuses the frozen golden as a candidate, and writes nothing while refusing (t_37bf7212)', () => {
    // Both spellings a caller reaches for: the scenario dir and the run tree itself. The harness
    // refuses at exit 2 (usage/environment), the same class as "unknown scenario".
    for (const candidate of [GOLDEN, join(GOLDEN, 'run')]) {
      const before = readFileSync(join(GOLDEN, 'run', 'manifest.sha256'), 'utf8');
      const res = runParity([SCENARIO, '--candidate', candidate]);
      expect(res.status, candidate).toBe(2);
      expect(res.stderr, candidate).toMatch(/frozen golden/);
      expect(res.stdout, candidate).not.toMatch(/parity: (PASS|FAIL)/);
      expect(readFileSync(join(GOLDEN, 'run', 'manifest.sha256'), 'utf8'), candidate).toBe(before);
    }
  });
});

/**
 * t_091ec5b8 -- the `content_compare` rule for gzipped artifacts, t_9c9fa3de --
 * its revert, t_16ac7810 -- *whose* zlib writes the containers, measured instead
 * of assumed.
 *
 * The recorded `.gz` goldens are upstream-zlib level-6 deflate. Whether the node
 * running this file writes that stream back is a property of the zlib the binary
 * is **linked against**, not of node -- measured on this machine over the whole
 * `microtest_voff` container set (all 150 `.gz` under `run/`, re-compressed with
 * `gzipSync(gunzipSync(golden), { level: 6 })` and compared to the golden bytes):
 * v22.22.2 (`process.versions.zlib` `1.3.1-e00f703`) and v24.21.0
 * (`1.3.2.1-motley-8002e91`) carry Google's "motley" fork and reproduce 25 of the
 * 150 containers, while `/opt/homebrew/opt/node@24/bin/node` v24.16.0 -- linked
 * against upstream zlib **1.2.12** -- reproduces **all 150** (`container
 * byte-identical 150, container differs 0`).
 * This block used to hard-code the motley counts as facts about node, so on the
 * 1.2.12 engine the containers came back byte-identical, `container differs`
 * collapsed to 0 and four assertions went red. The numbers now come from `ENGINE`
 * below, measured with the same `node:zlib` call `reGzip` writes, and every
 * behaviour that only a *differing* container can reach is exercised through a
 * difference the test constructs itself (`stampContainers`) -- so both families
 * are green *and* both branches are still pinned, which a bare "if (reproducible)
 * skip" would not have achieved.
 *
 * The rule makes the *decompressed payload* the contract for the paths it selects,
 * and the harness must count and report every file it compares that way -- a
 * container the harness cannot read, a payload difference and a missing file all
 * still fail.
 *
 * The rule is no longer **shipped**: the port writes upstream's stream now
 * (`src/model/compress/zlibDeflate.ts`, t_431ed2f0), so the registry declares an
 * empty `content_compare` list and every `.gz` is byte-compared by default
 * (t_9c9fa3de). The tests below therefore select the rule explicitly with
 * `--content-compare`, testing the *mechanism*, which still exists for a future
 * case; the last ones pin the strict default that ships.
 */
describe('oracle/run_parity.sh -- content-compared gzip containers', () => {
  const CONTROL = 'brain/anatomy/brainAnatomy_10_birth.txt.gz';
  /** The rule this registry used to ship globally; now a per-check opt-in. */
  const CONTENT_GLOB = 'run/**/*.gz';
  /** What the node log sinks compress at -- and what `reGzip` below writes. */
  const GZIP_LEVEL = 6;

  function walkGz(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walkGz(path, out);
      else if (entry.name.endsWith('.gz')) out.push(path);
    }
    return out.sort();
  }

  /** Every recorded container the content glob selects, golden side. */
  const GOLDEN_GZ = walkGz(join(GOLDEN, 'run'));

  /** Does this engine's `node:zlib` write this golden's container bytes back? */
  function reGzipsExactly(goldenPath: string): boolean {
    const golden = readFileSync(goldenPath);
    return gzipSync(gunzipSync(golden), { level: GZIP_LEVEL }).equals(golden);
  }

  // PORT-NOTE(parity-runner/engine-measured-zlib) t_16ac7810: measured once, at
  // collection, over the whole golden set. The containers this engine reproduces are
  // exactly the ones a `reGzip`d candidate leaves byte-identical, i.e. exactly what
  // the harness reports as `container_identical` -- so the assertions below stay
  // exact instead of being loosened to "some number". 12 ms for the 150 here.
  const NODE_REPRODUCED = GOLDEN_GZ.filter(reGzipsExactly).length;
  const NODE_DIFFERING = GOLDEN_GZ.length - NODE_REPRODUCED;
  /** Rides on every derived assertion: a red run says which engine produced it. */
  const ENGINE = `node ${process.version} (zlib ${process.versions.zlib}) reproduces ` +
    `${NODE_REPRODUCED}/${GOLDEN_GZ.length} recorded .gz containers byte-for-byte`;

  /**
   * Give every container a byte difference the strict compare cannot miss, on **any**
   * engine: XOR the 4-byte gzip MTIME field with a constant.
   *
   * t_16ac7810 -- "node wrote it" is not "it differs from the golden". On v24.16.0
   * (zlib 1.2.12) `reGzip` alone leaves all 150 containers byte-identical, so a
   * container-only difference -- the case the whole mechanism exists for -- cannot be
   * built out of `node:zlib` there at all and the strict default would have nothing to
   * catch. The gzip header here is 10 bytes with no FEXTRA/FNAME/FCOMMENT (asserted),
   * so bytes 4..7 are the MTIME: `gzip`/`gunzip` ignore it, the deflate stream and the
   * CRC trailer are untouched, and the payload stays byte-identical while the container
   * bytes differ -- on every engine, by construction.
   */
  const MTIME_MASK = 0x5f3759df;
  function stampContainers(candidate: string): void {
    for (const path of walkGz(join(candidate, 'run'))) {
      const bytes = readFileSync(path);
      expect([bytes[0], bytes[1], bytes[2], bytes[3]], path).toEqual([0x1f, 0x8b, 0x08, 0x00]);
      bytes.writeUInt32LE(bytes.readUInt32LE(4) ^ MTIME_MASK, 4);
      writeFileSync(path, bytes);
    }
  }

  /** Rewrite every `.gz` the way the node log sinks do (node:zlib, level 6). */
  function reGzip(candidate: string, opts: { flip?: string; notGz?: string; remove?: string } = {}) {
    for (const path of walkGz(join(candidate, 'run'))) {
      const rel = relative(join(candidate, 'run'), path);
      if (opts.remove && rel === opts.remove) {
        rmSync(path);
        continue;
      }
      if (opts.notGz && rel === opts.notGz) {
        writeFileSync(path, 'this is not a gzip container\n');
        continue;
      }
      let payload = gunzipSync(readFileSync(path));
      if (opts.flip && rel === opts.flip) {
        const copy = Buffer.from(payload);
        const at = Math.floor(copy.length / 2);
        copy[at] = copy[at] === 0x39 ? 0x38 : 0x39;
        payload = copy;
      }
      writeFileSync(path, gzipSync(payload, { level: GZIP_LEVEL }));
    }
  }

  it('passes containers node wrote, counting and printing what it compared by content', () => {
    const candidate = copyGolden('node-gzip');
    reGzip(candidate);
    const res = runParity([SCENARIO, '--candidate', candidate, '--content-compare', CONTENT_GLOB]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/match 225\/225/);
    expect(res.stdout).toMatch(/content-compared 150 file\(s\) \[run\/\*\*\/\*\.gz\]/);
    // t_16ac7810: the two container numbers are *this* engine's (see ENGINE): 25/125 on the
    // motley fork both fleet engines run, 150/0 on a node linked against upstream zlib 1.2.12.
    // The reporting line is still pinned exactly, against the measurement rather than a guess.
    expect(res.stdout, ENGINE).toMatch(new RegExp(
      `payload identical 150 \\(container byte-identical ${NODE_REPRODUCED}, container differs ${NODE_DIFFERING}\\)`));
    expect(res.stdout).toMatch(/parity: PASS/);
  }, LOAD_TIMEOUT_MS);

  it('reports a container-only difference on every engine, and passes once the payload is compared (t_16ac7810)', () => {
    // The instance the mechanism exists for, built instead of hoped for: node's own gzip
    // bytes with every container's MTIME stamped (payloads untouched), so exactly 150 of the
    // 150 containers differ. Un-stamped on this engine NODE_DIFFERING differ -- and 0 on a
    // node linked against zlib 1.2.12, which is what the four red assertions depended on.
    const candidate = copyGolden('node-gzip-stamped');
    reGzip(candidate);
    stampContainers(candidate);
    const res = runParity([SCENARIO, '--candidate', candidate, '--content-compare', CONTENT_GLOB]);
    expect(res.status).toBe(0);
    expect(res.stdout, ENGINE).toMatch(/match 225\/225/);
    expect(res.stdout, ENGINE).toMatch(/payload identical 150 \(container byte-identical 0, container differs 150\)/);
    // The row a container-only difference prints, named and localized to the file.
    expect(res.stdout).toMatch(/CONTENT run\/brain\/anatomy\/brainAnatomy_10_birth\.txt\.gz {2}\(gzip container differs, payload identical\)/);
    expect(res.stdout).toMatch(/parity: PASS/);
  }, LOAD_TIMEOUT_MS);

  it('reports the container-only differences in JSON, payload_failing empty', () => {
    const candidate = copyGolden('node-gzip-json');
    reGzip(candidate);
    const res = runParity([SCENARIO, '--candidate', candidate, '--content-compare', CONTENT_GLOB, '--json']);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      verdict: string;
      matched: number;
      content_compare: {
        patterns: string[];
        files: number;
        payload_identical: number;
        container_identical: number;
        container_differing: number;
        container_differing_files: string[];
        payload_failing: string[];
        unreadable: unknown[];
      };
    };
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.matched).toBe(225);
    expect(parsed.content_compare.patterns).toEqual(['run/**/*.gz']);
    expect(parsed.content_compare.files).toBe(150);
    expect(parsed.content_compare.payload_identical).toBe(150);
    // t_16ac7810: exactly the containers this engine's zlib did not reproduce (`ENGINE`), and
    // the file list has to agree with the count.
    expect(parsed.content_compare.container_identical, ENGINE).toBe(NODE_REPRODUCED);
    expect(parsed.content_compare.container_differing, ENGINE).toBe(NODE_DIFFERING);
    expect(parsed.content_compare.container_differing_files).toHaveLength(NODE_DIFFERING);
    expect(parsed.content_compare.payload_failing).toEqual([]);
  }, LOAD_TIMEOUT_MS);

  it('still fails a changed payload, localizing it to the line inside the gzip', () => {
    const candidate = copyGolden('payload-flip');
    reGzip(candidate, { flip: CONTROL });
    const res = runParity([SCENARIO, '--candidate', candidate, '--content-compare', CONTENT_GLOB]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/DIFFERS run\/brain\/anatomy\/brainAnatomy_10_birth\.txt\.gz/);
    expect(res.stdout).toMatch(/CONTENT DIFFERS in run\/brain\/anatomy\/brainAnatomy_10_birth\.txt\.gz/);
    expect(res.stdout).toMatch(/payload first divergence at line \d+/);
    expect(res.stdout).toMatch(/parity: FAIL/);
  }, LOAD_TIMEOUT_MS);

  it('fails a file at a content-compared path that is not a gzip container at all', () => {
    const candidate = copyGolden('not-gzip');
    reGzip(candidate, { notGz: CONTROL });
    const res = runParity([SCENARIO, '--candidate', candidate, '--content-compare', CONTENT_GLOB]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/not a gzip container/);
    expect(res.stdout).toMatch(/DIFFERS run\/brain\/anatomy\/brainAnatomy_10_birth\.txt\.gz/);
  }, LOAD_TIMEOUT_MS);

  it('still reports a missing .gz as MISSING (content-compare is not an absence excuse)', () => {
    const candidate = copyGolden('missing-gz');
    reGzip(candidate, { remove: CONTROL });
    const res = runParity([SCENARIO, '--candidate', candidate, '--content-compare', CONTENT_GLOB]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/MISSING run\/brain\/anatomy\/brainAnatomy_10_birth\.txt\.gz/);
  }, LOAD_TIMEOUT_MS);

  it('ships no rule, so a node-written container that is not byte-identical fails the default byte compare (t_9c9fa3de)', () => {
    // The revert, pinned. The registry's global `content_compare` list is empty
    // again now that the port writes upstream's stream (`zlibDeflate.ts`,
    // t_431ed2f0), so a tree whose `.gz` bytes differ from the goldens is a byte
    // difference with no flag to thank -- and no `content-compared` line is
    // printed, because nothing is content-compared.
    //
    // t_16ac7810: node-written *and* stamped (`stampContainers`), so the instance exists on
    // every engine. A plain `reGzip` leaves all 150 containers byte-identical on a node linked
    // against zlib 1.2.12 -- there this test used to assert a PASS, i.e. nothing at all.
    const candidate = copyGolden('node-gzip-default');
    reGzip(candidate);
    stampContainers(candidate);
    const res = runParity([SCENARIO, '--candidate', candidate]);
    expect(res.status).toBe(1);
    expect(res.stdout, ENGINE).toMatch(/differing=150/);
    expect(res.stdout).not.toMatch(/content-compared/);
    expect(res.stdout).toMatch(/parity: FAIL/);
  }, LOAD_TIMEOUT_MS);

  it('--no-content-compare restores the strict byte contract for that check', () => {
    // t_16ac7810: stamped for the same reason as the test above -- on a node linked against
    // zlib 1.2.12 a plain `reGzip` leaves the tree byte-identical and this check would have
    // passed without asserting anything.
    // t_a59843f4: the flag *alone*. This test used to be the only way the flag could be
    // exercised, because an explicit `--content-compare <glob>` was appended after the reset and
    // the pair therefore selected the glob (tools/check_parity.py:146-151). That is fixed -- the
    // next test pins the flag winning over the glob on the same check, in both argument orders.
    const candidate = copyGolden('node-gzip-strict');
    reGzip(candidate);
    stampContainers(candidate);
    const res = runParity([SCENARIO, '--candidate', candidate, '--no-content-compare']);
    expect(res.status).toBe(1);
    expect(res.stdout, ENGINE).toMatch(/differing=150/);
    expect(res.stdout).not.toMatch(/content-compared/);
    expect(res.stdout).toMatch(/parity: FAIL/);
  }, LOAD_TIMEOUT_MS);

  it('--no-content-compare wins over an explicit --content-compare glob on the same check (t_a59843f4)', () => {
    // The pair used to mean the opposite of what the flag says. `--no-content-compare` reset the
    // rules (registry plus scenario) and the explicit glob was appended *after* that reset
    // (tools/check_parity.py:146-151), so `--content-compare GLOB --no-content-compare` selected
    // GLOB and the check ran in content-compare mode. Measured on this candidate before the fix:
    // exit 0 / `parity: PASS` with `content-compared 150`, against exit 1 / `differing=150` for the
    // same candidate with the flag alone. The flag's help says it disables *every* content_compare
    // rule, so the flag is the one that wins now, and this pins it in both argument orders
    // (argparse makes the order irrelevant; pinning both states that instead of assuming it).
    const candidate = copyGolden('node-gzip-flag-precedence');
    reGzip(candidate);
    stampContainers(candidate);
    for (const extra of [
      ['--content-compare', CONTENT_GLOB, '--no-content-compare'],
      ['--no-content-compare', '--content-compare', CONTENT_GLOB],
    ]) {
      const how = extra.join(' ');
      const res = runParity([SCENARIO, '--candidate', candidate, ...extra]);
      expect(res.status, how).toBe(1);
      expect(res.stdout, how).toMatch(/differing=150/);
      expect(res.stdout, how).not.toMatch(/content-compared/);
      expect(res.stdout, how).toMatch(/parity: FAIL/);
    }
    // The flag drops the rule; it does not excuse a typo. The glob is still validated before it
    // is cleared, so a malformed one stays a usage error (exit 2) rather than being swallowed.
    const bad = runParity([SCENARIO, '--candidate', candidate,
                           '--content-compare', 'notrun/**.gz', '--no-content-compare']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/must be a run\/-relative glob/);
  }, LOAD_TIMEOUT_MS);

  it('applies the rule to the direct --golden form of the DoD line too', () => {
    const candidate = copyGolden('node-gzip-direct');
    reGzip(candidate);
    const res = spawnSync('python3', [join(REPO, 'tools', 'check_parity.py'),
                                      '--golden', GOLDEN, '--candidate', candidate,
                                      '--content-compare', CONTENT_GLOB],
                          { cwd: REPO, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/content-compared 150/);
    expect(res.stdout).toMatch(/parity: PASS/);
  });
});

