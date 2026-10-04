/**
 * Probe hygiene (t_96ac5a1b) — `probe_sheets_architecture.sh` may not write into the native tree.
 *
 * The incident (measured 2026-09-29 06:01:20): the probe copies the native tree's runtime pieces
 * into its own work tree and writes the three worldfiles it generates into `<work>/worldfiles`.
 * With a `$NATIVE` that is a *symlink farm* — `$NATIVE/worldfiles -> <native>/worldfiles`, exactly
 * the shape the t_e1a5d852 lock-verification runs of this probe used — macOS `cp -R` copied the
 * symlink rather than the tree (`man cp`: `-R ... also causes symbolic links to be copied, rather
 * than indirected through`), so those three writes went *through* it: untracked
 * `worldfiles/sheets_{a_minimal,b_full,c_neurgroup}.wf` appeared in the native tree, byte-identical
 * to the probe's cache copies. The native tree is the oracle and is read-only (PORT_SPEC.md ground
 * rule 8); a probe that can drop a worldfile there can also one day overwrite a *tracked* worldfile
 * a golden was recorded from, and every byte-exact verdict would still read PASS.
 *
 * What is pinned here:
 *   1. a run against a symlink farm leaves the farm's target untouched (and generates the three
 *      worldfiles into a *real* work copy instead) — the pre-fix probe fails this;
 *   2. a work tree that already holds symlinks is refused outright (exit 2, before any native
 *      run), instead of being written through;
 *   3. `tools/native_lock.sh` / `tools/native_lock.py` take the shared lock on a native tree that
 *      has no `worldfiles/` at all — the lock path must never need a worldfile to exist there.
 *
 * Nothing here touches the real native tree: the farm's target is a `$TMPDIR` copy of the tracked
 * `worldfiles/`, and every work tree is under `$TMPDIR`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const NATIVE_ROOT = resolve(process.env['POLYWORLD_NATIVE'] ?? join(REPO, '..', 'polyworld'));
const PROBE = join(REPO, 'src', 'model', 'genome', 'native', 'probe_sheets_architecture.sh');
const NORMALIZED = join(REPO, 'oracle', 'minitest_voff', 'run', 'normalized.wf');
const NATIVE_LOCK = join(REPO, 'tools', 'native_lock.sh');

const HAVE_NATIVE =
  existsSync(join(NATIVE_ROOT, 'Polyworld')) && existsSync(join(NATIVE_ROOT, 'lib', 'libpolyworld.dylib'));
/** The probe exits 2 without a normalized worldfile, so its own guard tests need one too. */
const HAVE_NORMALIZED = existsSync(NORMALIZED);

const work = mkdtempSync(join(tmpdir(), 'pw-probe-sheets-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/**
 * A probe run copies the native pieces (including `src/library`) and starts four native runs, so
 * it is load-sensitive: the fleet's 4-way concurrency measured the whole-suite class of red at
 * 5 s (t_84885d07), so this carries the repo's explicit budget instead of vitest's default.
 */
const LOAD_TIMEOUT_MS = 60_000;

/** The generated worldfiles, by name — the probe's own output, nowhere else in the repo. */
function sheetsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith('sheets_'))
    .sort();
}

/** A native tree made of symlinks (`$NATIVE/<piece> -> <native>/<piece>`), as the probes build. */
function symlinkFarm(name: string, worldfiles: string): string {
  const farm = join(work, name);
  mkdirSync(farm, { recursive: true });
  for (const piece of ['Polyworld', 'lib', 'etc', 'scripts', 'src']) {
    symlinkSync(join(NATIVE_ROOT, piece), join(farm, piece));
  }
  symlinkSync(worldfiles, join(farm, 'worldfiles'));
  return farm;
}

/** A copy of the tracked `worldfiles/` under `$TMPDIR`: what a farm's `worldfiles` symlink points at. */
function worldfilesCopy(name: string): string {
  const target = join(work, name);
  cpSync(join(NATIVE_ROOT, 'worldfiles'), target, { recursive: true });
  return target;
}

function runProbe(outDir: string, native: string, timeout = '1'): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('sh', [PROBE, NORMALIZED], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, POLYWORLD_NATIVE: native, SHEETS_PROBE_OUT: outDir, SHEETS_PROBE_TIMEOUT: timeout },
  });
  return { status: res.status, stdout: String(res.stdout), stderr: String(res.stderr) };
}

describe.skipIf(!HAVE_NATIVE || !HAVE_NORMALIZED)('probe_sheets_architecture.sh — the native tree stays read-only', () => {
  it('writes the generated worldfiles into a real work copy, never through a symlinked one', () => {
    const target = worldfilesCopy('wf-target');
    const before = sheetsFiles(target);
    const farm = symlinkFarm('farm', target);
    const out = join(work, 'out-farm');

    const res = runProbe(out, farm);

    // The pre-fix probe wrote the three worldfiles straight into `target` (which, in the incident,
    // was the native tree) — twice over, once per generated file.
    expect(sheetsFiles(target)).toEqual(before);
    expect(before).toEqual([]);
    // ... and it generated them where they belong: `<work>/worldfiles`, a real directory.
    const copy = join(out, 'work', 'worldfiles');
    expect(lstatSync(copy).isSymbolicLink()).toBe(false);
    expect(sheetsFiles(copy)).toEqual(['sheets_a_minimal.wf', 'sheets_b_full.wf', 'sheets_c_neurgroup.wf']);
    // The probe reached its verdicts (it did not die in the guard).
    expect(res.stdout).toContain('A1 vs A2');
    // And the real native tree — the oracle — is untouched by all of this.
    expect(sheetsFiles(join(NATIVE_ROOT, 'worldfiles'))).toEqual([]);
  }, LOAD_TIMEOUT_MS);

  it('refuses a work tree that already holds symlinks instead of writing through it', () => {
    const target = worldfilesCopy('wf-target-refused');
    const out = join(work, 'out-symlinked-work');
    mkdirSync(join(out, 'work'), { recursive: true });
    for (const piece of ['Polyworld', 'lib', 'etc', 'worldfiles', 'scripts', 'src']) {
      symlinkSync(join(NATIVE_ROOT, piece), join(out, 'work', piece));
    }

    const res = runProbe(out, NATIVE_ROOT);

    expect(res.status).toBe(2);
    expect(res.stderr).toContain('is a symlink');
    // Refused *before* anything ran: no native run tree, nothing in the symlink target.
    expect(existsSync(join(out, 'work', 'out-a1'))).toBe(false);
    expect(sheetsFiles(target)).toEqual([]);
    expect(sheetsFiles(join(NATIVE_ROOT, 'worldfiles'))).toEqual([]);
  }, LOAD_TIMEOUT_MS);
});

describe.skipIf(!existsSync(NATIVE_LOCK))('tools/native_lock.sh — the lock does not need a worldfile', () => {
  it('takes the shared lock on a native tree that holds only the `Polyworld` binary', () => {
    const stub = join(work, 'native-no-worldfiles');
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, 'Polyworld'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { ...process.env };
    delete env['POLYWORLD_NATIVE'];

    const res = spawnSync(
      'sh',
      [NATIVE_LOCK, '--native', stub, '--wait', '0', '--purpose', 't_96ac5a1b: the lock needs no worldfile', '--', 'sh', '-c', 'echo the command ran'],
      { cwd: REPO, encoding: 'utf8', env },
    );

    expect(res.status).toBe(0);
    expect(String(res.stdout)).toContain('the command ran');
    expect(existsSync(join(stub, '.parity-native.lock'))).toBe(true);
    expect(readFileSync(join(stub, '.parity-native.lock'), 'utf8')).toContain('t_96ac5a1b');
    expect(existsSync(join(stub, 'worldfiles'))).toBe(false);
  });
});
