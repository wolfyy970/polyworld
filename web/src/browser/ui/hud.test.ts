/**
 * Lane L20 — the title panel's note and the status panel's `run files` row are one number.
 *
 * The defect this guards, measured on the live page (2026-09-29 08:16 EDT): the note was built once
 * at boot from `world.runFiles()` and froze there, while the panel re-read the count every UI tick —
 * `hello` showed `(10 files)` beside `run files 11 · 1.1 MB`, `minitest_voff` `(196 files)` beside
 * `257`.
 *
 * The second defect, measured on the live page after the first fix (2026-09-29 08:38 EDT,
 * `t_c824de39`): the booted worldfile sentence was a prefix `app.ts` concatenated at construction
 * (`Worldfile … steps. ` + `headerNote()`), so the first `updateUi` tick's `setNote` replaced the
 * whole note with `titleNote`'s own text and the sentence was gone for the rest of the run —
 * `hello` opened on `Compared byte-for-byte…`, and nothing else on the page named the file. So the
 * note is asserted here to *open* on the worldfile sentence for a tick's snapshot, and the source
 * guard pins that `app.ts` assembles no note text of its own.
 *
 * Two layers, stated plainly because they are not the same layer:
 *
 *   * **here** — the two strings the shell puts on screen are built by `titleNote()` (the note) and
 *     `formatRunFiles()` (the row), and for one snapshot they carry the same number; plus a source
 *     guard that the note is rebuilt *on the tick*, with the tick's own snapshot in hand;
 *   * **on the running page** — `verify/demoEvidence.mjs` reads the note's text and the row's text
 *     inside one evaluate and reports `hudCounts.agree`. The shell needs WebGL, so the live reading
 *     cannot be a case here; it is the L20 page evidence instead.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { titleNote } from './hud';
import { formatRunFiles } from './statusPanel';
import type { RunFileReport } from '../sim/modelWorld';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The boot snapshot and later ticks of the same runs the live page measured, plus "no sink". */
const SNAPSHOTS: readonly (RunFileReport | null)[] = [
  { count: 10, bytes: 1_100_000 },
  { count: 11, bytes: 1_155_000 },
  { count: 196, bytes: 1_500_000 },
  { count: 257, bytes: 1_570_000 },
  null,
];

/** The boot facts the note also carries; none of them change during a run. */
const BOOT = {
  worldfile: {
    path: 'worldfiles/hello.wf',
    worldSize: 100,
    agents: 300,
    vision: false,
    maxSteps: 500,
  },
  artifacts: ['run/original.wf'],
  recorded: true,
  blocked: 0,
  provisional: 0,
};

/** The first sentence the note opens with — the booted worldfile, as the live page measured it. */
const WORLDFILE_SENTENCE =
  'Worldfile worldfiles/hello.wf → 100 × 100 world, 300 agents, vision off, run budget 500 steps. ';

/** The count the note states, or `null` when it states none. */
function noteCount(note: string): number | null {
  const match = /\((\d+) files\)/.exec(note);
  return match === null ? null : Number(match[1]);
}

/** The count the panel's row states, or `null` when it states none (`—`). */
function rowCount(row: string): number | null {
  const match = /^(\d+) · /.exec(row);
  return match === null ? null : Number(match[1]);
}

describe('L20 — one file count on screen', () => {
  it('the note states the count the panel row states, for the same snapshot', () => {
    for (const files of SNAPSHOTS) {
      const note = titleNote({ ...BOOT, files });
      const row = formatRunFiles(files);
      const expected = files === null ? null : files.count;
      expect(noteCount(note), `note: ${note}`).toBe(expected);
      expect(rowCount(row), `row: ${row}`).toBe(expected);
    }
  });

  it('is a function of the snapshot, so a note frozen at boot could not read as agreement', () => {
    const atBoot = titleNote({ ...BOOT, files: { count: 10, bytes: 1_100_000 } });
    const laterTick = titleNote({ ...BOOT, files: { count: 11, bytes: 1_155_000 } });

    // The note follows the tree…
    expect(noteCount(atBoot)).toBe(10);
    expect(noteCount(laterTick)).toBe(11);
    // …and this is the assertion the defect trips: a note frozen at boot, read beside the live row,
    // disagrees — which is exactly what `noteCount`/`rowCount` compare.
    expect(noteCount(atBoot)).not.toBe(rowCount(formatRunFiles({ count: 11, bytes: 1_155_000 })));
  });

  it('claims no count at all when the page has no run tree', () => {
    const note = titleNote({ ...BOOT, files: null });
    expect(noteCount(note), note).toBeNull();
    expect(note.endsWith('writing its run tree into the page.'), note).toBe(true);
    // The row says `—`; the note says nothing rather than `0 files` beside it.
    expect(formatRunFiles(null)).toBe('—');
  });

  it('keeps the sentence the note has always had', () => {
    const note = titleNote({
      worldfile: BOOT.worldfile,
      artifacts: ['run/original.wf', 'run/normalized.wf'],
      recorded: true,
      blocked: 2,
      provisional: 1,
      files: { count: 19, bytes: 2048 },
    });
    expect(note).toContain(
      'Compared byte-for-byte with the native run: run/original.wf, run/normalized.wf.',
    );
    expect(note).toContain('2 keys not readable, 1 provisional.');
    expect(note).toContain(
      "The agents are the run's own — lane L11's `Simulation` step loop, writing its run tree into " +
        'the page (19 files).',
    );
  });

  it('states a demo world without claiming a comparison it cannot back', () => {
    // `bricks_voff` (L18c) is a browser-only demo world with no recorded golden, so the note must
    // not read `Compared byte-for-byte with the native run` — there is nothing to compare.
    const note = titleNote({ ...BOOT, recorded: false, files: { count: 11, bytes: 1024 } });
    expect(note).not.toContain('Compared byte-for-byte');
    expect(note).toContain(
      'A demo world (no recorded golden); the boot’s own artifacts: run/original.wf.',
    );
    expect(note.startsWith(WORLDFILE_SENTENCE)).toBe(true);
  });

  // The defect this card measured (`t_c824de39`): the booted worldfile sentence was a prefix `app.ts`
  // glued onto `headerNote()` at construction, so the first `updateUi` tick's `setNote` replaced the
  // note with `titleNote`'s own text and the page never named the worldfile again. The assertion
  // below is about a *tick's* snapshot, i.e. what the shell renders from the second frame onward.
  it('states the booted worldfile on every tick, not only at construction', () => {
    for (const files of SNAPSHOTS) {
      const note = titleNote({ ...BOOT, files });
      expect(note.startsWith(WORLDFILE_SENTENCE), note).toBe(true);
    }
    // The tick the live page measured (`hello`, 2026-09-29): the note opened on the comparison
    // sentence alone and nothing else on the page named the file. That text is now impossible.
    const tick = titleNote({ ...BOOT, files: { count: 11, bytes: 1_155_000 } });
    expect(tick).toContain(
      'Worldfile worldfiles/hello.wf → 100 × 100 world, 300 agents, vision off, run budget 500 steps.',
    );
    // …and the comparison sentence is still the note's second one: nothing was traded away.
    expect(tick).toContain('Compared byte-for-byte with the native run: run/original.wf.');
  });

  // The layer above the strings: the shell has to *rebuild* the note on the tick, and it has to
  // hand it the snapshot the panel row is built from. No golden can see this (the HUD is not part of
  // the run tree), so it is read off the source — the way `tests/agent.test.ts` pins the motion call
  // site.
  it('the shell refreshes the note on the UI tick, from the tick’s own snapshot', () => {
    const source = readFileSync(join(HERE, '..', 'app.ts'), 'utf8');
    const updateUi = source.slice(source.indexOf('private updateUi('));

    expect(updateUi, 'the note is rebuilt every tick').toContain(
      'this.titlePanel.setNote(this.headerNote(files));',
    );
    expect(updateUi, 'the row is built from the same snapshot').toContain(
      'runFiles: formatRunFiles(files),',
    );
    // One read per tick is what makes "the same snapshot" a property rather than a coincidence.
    expect(updateUi.match(/this\.world\.runFiles\(\)/g)?.length, 'one run-tree read per tick').toBe(1);
    // The constructor says what the note is at boot through the same builder call the tick makes,
    // reading in hand…
    expect(source).toContain('note: this.headerNote(this.world.runFiles()),');
    // …so the worldfile sentence cannot be a prefix only the boot call knows: `app.ts` assembles no
    // note text of its own (the only builder is `hud.ts::titleNote`, called from `headerNote`)…
    expect(source, 'the shell glues no note sentence of its own').not.toMatch(/Worldfile \$\{/);
    const headerNote = source.slice(source.indexOf('private headerNote('));
    expect(headerNote, 'the boot facts reach the note builder').toContain(
      'path: this.boot.sources.worldfilePath,',
    );
    expect(headerNote, 'the worldfile sentence is built, not appended').toContain('return titleNote({');
    // …and the pre-fix shape cannot come back: a note built with no snapshot at all.
    expect(source).not.toContain('this.headerNote()');
  });
});
