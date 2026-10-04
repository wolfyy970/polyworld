/**
 * Lane L11 probe — the x-sorted list's *history* around the minitest_voff step-64 order swap.
 *
 * `run/events/contacts.log` first diverges at step 64 with a pure ordering swap between agents 4
 * and 32 (golden `64 14 4` / `64 14 32` / `64 4 32`; candidate the same three rows with 4 and 32
 * exchanged). Both agents carry a bit-identical `(x, radius)` key at that point, so the order is
 * decided by native's `objectxsortedlist` insertion/sort tie semantics — which this probe dumps
 * step by step so the *history* (not just the end state) can be compared against the orders the
 * golden's contact rows imply.
 *
 * Reads nothing outside the recorded scenario; writes nothing but `<treedir>/l11-order.log`.
 *
 *   npx tsx src/model/sim/native/stepprobe.ts minitest_voff <freshOutDir> [firstStep] [lastStep]
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gXSortedObjects } from '../../environment';
import type { XSortedObjects } from '../../environment';
import { GObjectType } from '../../types';
import { runScenario } from '../runner';
import { assertUsableStagingRoot } from '../../../oracle/guard';

const WATCH = new Set(
  (process.env.L11_WATCH ?? '4,11,32')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v)),
);

function hex(value: number): string {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, value);
  return `0x${buf.getUint32(0).toString(16).padStart(8, '0')}`;
}

/** The *double* bits — what the port's `add`/`sort` compare today (native compares `float`). */
function hex8(value: number): string {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, value);
  return `0x${buf.getBigUint64(0).toString(16).padStart(16, '0')}`;
}

function typeNumberOf(o: unknown): number {
  return (o as { typeNumber: number }).typeNumber;
}

function key(o: { x(): number; radius(): number }): number {
  return o.x() - o.radius();
}

const [scenario, outDir] = process.argv.slice(2);
if (!scenario || !outDir) {
  console.error('usage: stepprobe.ts <scenario> <outDir>  (window/agents via L11_FIRST/L11_LAST/L11_WATCH)');
  process.exit(2);
}
const first = Number(process.env.L11_FIRST ?? 60);
const last = Number(process.env.L11_LAST ?? 66);

const lines: string[] = [];
let step = 0;

const list = gXSortedObjects as unknown as XSortedObjects;
const originalSort = list.sort.bind(list);

function dump(label: string): void {
  const entries: string[] = [];
  const watched: string[] = [];
  gXSortedObjects.reset();
  for (;;) {
    const o = gXSortedObjects.next();
    if (o === null) break;
    const kind =
      (o.getType() & GObjectType.AGENT) !== 0 ? 'A' : (o.getType() & GObjectType.FOOD) !== 0 ? 'F' : 'B';
    entries.push(`${kind}${typeNumberOf(o)}`);
    if (kind === 'A' && WATCH.has(typeNumberOf(o))) {
      watched.push(
        `      #${typeNumberOf(o)} x=${hex(o.x())} z=${hex((o as unknown as { z(): number }).z())} ` +
          `r=${hex(o.radius())} key=${hex(key(o))} keyd=${hex8(key(o))}`,
      );
    }
  }
  lines.push(`step ${step} ${label}: ${entries.join(' ')}`);
  for (const w of watched) lines.push(w);
}

list.sort = function patchedSort(this: XSortedObjects): void {
  step++;
  const inWindow = step >= first && step <= last;
  if (inWindow) dump('pre-sort');
  originalSort();
  if (inWindow) dump('post-sort');
} as unknown as XSortedObjects['sort'];

const result = runScenario({ scenario, outDir: assertUsableStagingRoot(outDir, 'stepprobe outDir'), repoRoot: process.cwd() });
writeFileSync(join(outDir, 'l11-order.log'), `${lines.join('\n')}\n`);
console.log(JSON.stringify({ ...result, watched: [...WATCH] }));
