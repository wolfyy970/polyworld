/**
 * `node:fs` with the frozen-golden write tripwire in front of the write **and removal** entry points
 * (t_37bf7212; the removal half is t_06238505).
 *
 * `vitest.config.ts` aliases the specifier `node:fs` to this module for the test run, so **every**
 * import style a test uses — `import { writeFileSync } from 'node:fs'`, `import fs from 'node:fs'`,
 * `import * as fs from 'node:fs'`, `await import('node:fs')` — lands on these wrappers. That is
 * deliberate, and measured: the named bindings of a Node builtin are a *snapshot* taken at link
 * time, so patching the builtin's own object from a setup file does **not** intercept
 * `import { writeFileSync } from 'node:fs'` (verified with `.candidate/t37/probe.mts`: the write
 * landed). Aliasing the specifier is the only way to make the net actually cover the suite.
 *
 * **The boundary, stated as measured (t_833bee5f).** The alias is the *import-style* half: it covers
 * every style of the `node:fs` specifier, for every call shape. The *object* half is the runtime
 * tripwire this file installs (`installGoldenWriteTripwire`), which patches the builtin's own object
 * — the sync names, the **top-level async/callback names** (`fs.writeFile`, `fs.rm`, …) and the
 * members of `fs.promises` — so a caller that holds the module object itself (`import fs from 'fs'`,
 * `require('fs')`) is covered for every call shape too. What *neither* half can reach is the
 * **ESM namespace of the unaliased `fs` specifier**: a builtin's namespace is a link-time snapshot
 * taken when the builtin is first linked, before any setup file runs, so
 * `import { rm } from 'fs'` / `import * as fs from 'fs'` / `(await import('fs')).writeFileSync` keep
 * the un-patched bindings (measured on node 22.22.2: their `default` is the live object and *is*
 * patched; the named members are not). The `node:fs` spelling has no such hole. Only readers and
 * `tests/oracle-guard.test.ts`'s `rawRmSync` (deliberately unguarded cleanup) use that spelling.
 *
 * Why the alias is safe from recursion: this file and `src/oracle/guard.ts` import `'fs'` (the
 * unaliased spelling of the same builtin) for the real implementation; only `node:fs` is aliased.
 *
 * What it is for: a write into `oracle/<scenario>/run/**` from *any* test or helper throws
 * `GoldenWriteRefused` instead of landing — including a write that only reaches the golden through
 * a symlink (a lane's worktree `oracle/<s>/run`), which is exactly how the frozen tree was
 * clobbered on 2026-09-29. Reads are untouched.
 */
import * as realFs from 'fs';

import {
  ASYNC_WRAPPERS as WRAPPED_ASYNC,
  GoldenWriteRefused,
  SYNC_WRAPPERS as WRAPPED_SYNC,
  goldenWriteHit,
  goldenWriteMessage,
  installGoldenWriteTripwire,
} from '../../src/oracle/guard';

function wrap(name: string, fn: unknown): unknown {
  if (typeof fn !== 'function') return fn;
  return function wrapped(this: unknown, ...args: unknown[]) {
    const hit = goldenWriteHit(name, args);
    if (hit !== null) {
      throw new GoldenWriteRefused(goldenWriteMessage('golden tripwire (node:fs alias)', hit));
    }
    return (fn as (...a: unknown[]) => unknown).apply(this, args);
  };
}

// The wrapped entry points come from `src/oracle/guard.ts` — one list for both halves of the net
// (this module's `default`/`promises`/namespace surface, and the runtime tripwire below), so the
// two cannot drift. They had drifted: `rmSync`/`rm` were in neither, and node ≤ 22 only *looked*
// covered because its `rmSync(recursive)` re-entered the public per-entry functions the net wraps
// (t_06238505 — node 24/26 delete the tree, this alias included).

// Also patch the builtin's own object, so code that reaches the real `fs` object (this module's
// own `realFs`, or a `default` import that bypassed the alias) is covered too.
installGoldenWriteTripwire();

type AnyFn = (...args: never[]) => unknown;

export const writeFileSync = wrap('writeFileSync', realFs.writeFileSync) as typeof realFs.writeFileSync;
export const appendFileSync = wrap('appendFileSync', realFs.appendFileSync) as typeof realFs.appendFileSync;
export const writeSync = wrap('writeSync', realFs.writeSync) as typeof realFs.writeSync;
export const truncateSync = wrap('truncateSync', realFs.truncateSync) as typeof realFs.truncateSync;
export const unlinkSync = wrap('unlinkSync', realFs.unlinkSync) as typeof realFs.unlinkSync;
export const rmdirSync = wrap('rmdirSync', realFs.rmdirSync) as typeof realFs.rmdirSync;
export const rmSync = wrap('rmSync', realFs.rmSync) as typeof realFs.rmSync;
export const mkdirSync = wrap('mkdirSync', realFs.mkdirSync) as typeof realFs.mkdirSync;
export const renameSync = wrap('renameSync', realFs.renameSync) as typeof realFs.renameSync;
export const copyFileSync = wrap('copyFileSync', realFs.copyFileSync) as typeof realFs.copyFileSync;
export const cpSync = wrap('cpSync', realFs.cpSync) as typeof realFs.cpSync;
export const linkSync = wrap('linkSync', realFs.linkSync) as typeof realFs.linkSync;
export const symlinkSync = wrap('symlinkSync', realFs.symlinkSync) as typeof realFs.symlinkSync;
export const createWriteStream = wrap('createWriteStream', realFs.createWriteStream) as typeof realFs.createWriteStream;
export const openSync = wrap('openSync', realFs.openSync) as typeof realFs.openSync;
export const writeFile = wrap('writeFile', realFs.writeFile) as typeof realFs.writeFile;
export const appendFile = wrap('appendFile', realFs.appendFile) as typeof realFs.appendFile;
export const truncate = wrap('truncate', realFs.truncate) as typeof realFs.truncate;
export const unlink = wrap('unlink', realFs.unlink) as typeof realFs.unlink;
export const rmdir = wrap('rmdir', realFs.rmdir) as typeof realFs.rmdir;
export const mkdir = wrap('mkdir', realFs.mkdir) as typeof realFs.mkdir;
export const rename = wrap('rename', realFs.rename) as typeof realFs.rename;
export const copyFile = wrap('copyFile', realFs.copyFile) as typeof realFs.copyFile;
export const cp = wrap('cp', realFs.cp) as typeof realFs.cp;
export const rm = wrap('rm', realFs.rm) as typeof realFs.rm;
export const link = wrap('link', realFs.link) as typeof realFs.link;
export const symlink = wrap('symlink', realFs.symlink) as typeof realFs.symlink;
export const open = wrap('open', realFs.open) as typeof realFs.open;

/** `fs.promises` with the same tripwire. */
export const promises = new Proxy(realFs.promises, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && (WRAPPED_ASYNC as readonly string[]).includes(prop)) {
      return wrap(prop, (target as unknown as Record<string, unknown>)[prop]);
    }
    return Reflect.get(target, prop, receiver);
  },
});

/** `import fs from 'node:fs'` lands here: the real module object with guarded write members. */
const guardedFs: typeof realFs = new Proxy(realFs, {
  get(target, prop, receiver) {
    if (typeof prop === 'string') {
      if (prop === 'promises') return promises;
      if ((WRAPPED_SYNC as readonly string[]).includes(prop) || (WRAPPED_ASYNC as readonly string[]).includes(prop)) {
        return wrap(prop, (target as unknown as Record<string, unknown>)[prop]);
      }
    }
    return Reflect.get(target, prop, receiver);
  },
});

export default guardedFs;

export type { AnyFn };

// Everything else (all the readers, constants, types) passes through untouched.
export * from 'fs';
