/**
 * Suite-level net for the frozen goldens (task t_37bf7212).
 *
 * Installed for **every** vitest run (`vitest.config.ts` -> `setupFiles`), in each worker process:
 * any write into `oracle/<scenario>/run/**` throws `GoldenWriteRefused` instead of landing, no
 * matter which test or helper performs it. That is the "a test fails if any non-`_t_*` path under
 * `oracle/<scenario>/run` is opened for write" half of the guard: a new writer is caught the
 * moment it tries, and the test that tried it fails with the golden's path in the message.
 *
 * It is symlink-aware: a worktree's `oracle/<s>/run` symlinked into the canonical golden is
 * refused too (see `src/oracle/guard.ts` for the incident this comes from).
 */
import { installGoldenWriteTripwire, oracleRoot } from '../../src/oracle/guard';

installGoldenWriteTripwire();

// Report once per worker so a run's transcript names the net that is actually armed.
process.env.POLYWORLD_GOLDEN_TRIPWIRE = 'installed';
process.stdout.write(`golden tripwire armed (oracle root: ${oracleRoot()})\n`);
