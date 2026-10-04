import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// t_841decd7: the run's whole temp footprint — vitest's own SSR/transform cache
// (`join(os.tmpdir(), nanoid())`, one per run, ~1.5-6 MB, never removed), the tests'
// `mkdtempSync(join(tmpdir(), …))` run trees (~10-90 MB each) and the per-process candidate roots —
// moves under one keyed root (`$TMPDIR/polyworld-run-tmp/pid-<pid>`) that dies with this process.
// Must run before vitest constructs its project: the config module is evaluated first (measured).
// See src/hygiene/runTempRoot.ts; `POLYWORLD_KEEP_RUN_TMP=1` keeps the root for inspection.
import { installRunTempRoot } from './src/hygiene/runTempRoot';

installRunTempRoot();

export default defineConfig({
  resolve: {
    alias: [
      // t_37bf7212: the frozen-golden write tripwire has to cover the ordinary
      // `import { writeFileSync } from 'node:fs'` — and a Node builtin's named bindings are a
      // snapshot taken at link time, so patching the builtin's own object from a setup file is
      // *not* observed by them (measured). The specifier is therefore aliased to the guarded
      // module (tests/setup/fsGuard.ts) for the test run; `src/oracle/guard.ts` and that module
      // import the unaliased `'fs'`, which is what keeps this from being a cycle.
      { find: /^node:fs$/, replacement: fileURLToPath(new URL('./tests/setup/fsGuard.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // t_37bf7212: every worker arms the tripwire explicitly too, so a run with the alias disabled
    // (a bare `node --test`, a probe script) still gets the guard's diagnostics.
    setupFiles: ['tests/setup/oracleTripwire.ts'],
  },
});
