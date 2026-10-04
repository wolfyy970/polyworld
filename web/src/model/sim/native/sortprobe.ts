/**
 * Lane L11 (sim) — `sortprobe.ts`: does lane L10's x-sorted list actually re-sort after the objects
 * move? (`contactprobe.ts` measured that after one step of `microtest_voff` the live list is **not**
 * in `x - radius` order, which is what `TSimulation::Interact`'s early-out depends on.)
 *
 * Constructs a list, adds objects in a deliberately unsorted order (native `add` insert-sorts), then
 * moves their `x` (what a step does) and calls `sort()`, printing the walk order at each stage.
 *
 * Usage: `npx tsx src/model/sim/native/sortprobe.ts`
 */

import { GObjectType } from '../../types';
import { XSortedObjects } from '../../environment';

interface FakeObject {
  label: string;
  value: number;
  readonly radius: number;
  x(): number;
  getType(): number;
  listLink?: unknown;
}

function make(label: string, x: number): FakeObject {
  return {
    label,
    value: x,
    radius: 0.5,
    x() {
      return this.value;
    },
    getType() {
      return GObjectType.AGENT;
    },
  };
}

function order(list: XSortedObjects): string {
  const out: string[] = [];
  list.reset();
  for (;;) {
    const o = list.nextObj(GObjectType.AGENT) as unknown as FakeObject | null;
    if (o === null) break;
    out.push(`${o.label}@${o.value}`);
  }
  return out.join(' ');
}

const list = new XSortedObjects();
// Native `add` is an x-sorted insertion, so a list of adds is already ordered by `x - radius`.
for (const [label, x] of [
  ['a', 5],
  ['b', 2],
  ['c', 9],
  ['d', 1],
] as const) {
  list.add(make(label, x) as never);
}
process.stdout.write(`after adds (native insert-sorted): ${order(list)}\n`);

// Now move them the way a step does, and re-sort (native `Interact`'s first act).
const moved: Record<string, number> = { a: 7, b: 3, c: 0.5, d: 8 };
list.reset();
for (;;) {
  const o = list.nextObj(GObjectType.AGENT) as unknown as FakeObject | null;
  if (o === null) break;
  o.value = moved[o.label]!;
}
process.stdout.write(`after move, before sort():        ${order(list)}\n`);

list.sort();
process.stdout.write(`after sort():                     ${order(list)}\n`);
