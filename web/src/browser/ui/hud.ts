/**
 * Lane W1g — HUD layout. Lane L20 — the title panel's note is live.
 *
 * Three corners, flat panels, no chrome: identity top-left, diagnostics top-right, controls
 * bottom-centre. The overlay itself is click-through (`pointer-events: none` in
 * style.css) so dragging anywhere else orbits the camera, which is what a viewer tries
 * first.
 *
 * PORT-NOTE (L20/live-note): the note states a fact about the page ("writing its run tree into the
 * page (N files)"), so N has to be the page's *current* count — the status panel beside it prints
 * the same number, from the same tick. The note used to be built once, at boot, and froze there:
 * measured on the live page (2026-09-29), `hello` read `(10 files)` beside the panel's `11`, and
 * `minitest_voff` `(196 files)` beside `257`. `TitlePanel.setNote` is how the shell keeps the two in
 * step (`app.ts::updateUi`), and `titleNote` takes the snapshot as an argument so that no caller can
 * print a count it did not read on the tick it is rendering.
 *
 * PORT-NOTE (L20/worldfile-in-the-note): the note's *first* sentence — the booted worldfile, its
 * world size, the agent count, vision, the run budget — is part of the same builder, not a prefix
 * the boot call site glued on. It used to be (`app.ts` built `Worldfile … steps. ` + `headerNote()`),
 * so the very first `updateUi` tick replaced the note with `titleNote`'s own text alone and the
 * sentence disappeared from the page for the rest of the run — measured 2026-09-29: the `hello` note
 * opened on `Compared byte-for-byte…` and nothing else on the page named the booted worldfile
 * (`t_c824de39`). Boot facts do not move during a run, but they are still rendered on every tick, so
 * the only way to state them is here, where a caller cannot forget them.
 */

import { el, setText } from './dom';
import type { RunFileReport } from '../sim/modelWorld';

export interface TitlePanelOptions {
  title: string;
  subtitle: string;
  note: string;
}

export interface TitlePanel {
  element: HTMLElement;
  /** Replace the note — the shell calls this once per UI tick, with that tick's own snapshot. */
  setNote(note: string): void;
}

export function createTitlePanel(options: TitlePanelOptions): TitlePanel {
  const note = el('p', { className: 'panel__note', text: options.note });
  const element = el('section', { className: 'panel', attrs: { 'aria-label': options.title } }, [
    el('h1', { className: 'panel__title', text: options.title }),
    el('p', { className: 'panel__subtitle', text: options.subtitle }),
    note,
  ]);
  return { element, setNote: (text) => setText(note, text) };
}

export interface TitleNoteInput {
  /**
   * The booted worldfile and the boot parameters the note's first sentence states. Boot facts: none
   * of them change during a run, but the note is rebuilt every tick and they are part of its text.
   */
  worldfile: {
    /** The worldfile the boot read, by run-tree path. */
    path: string;
    worldSize: number;
    /** Native's own agent roster size for the booted worldfile (`InitAgents`, the `?agents=` floor). */
    agents: number;
    vision: boolean;
    maxSteps: number;
  };
  /** The boot artifacts the page reproduced, by run-tree path. */
  artifacts: readonly string[];
  /**
   * Whether `artifacts` are the *recorded* scenario's, byte-compared against a golden
   * (`SCENARIOS`), or a demo world's with no golden to compare against
   * (`PORT-NOTE (L18/demo-scenarios)` in `sim/scenarios.ts`). The note must not claim a
   * comparison that does not exist.
   */
  recorded: boolean;
  /** Worldfile keys the boot could not read (never substituted). */
  blocked: number;
  /** Keys read *provisionally*. */
  provisional: number;
  /**
   * The run tree as it stands on this tick — the **same** snapshot the status panel's `run files`
   * row is built from (`statusPanel.ts::formatRunFiles`).
   */
  files: RunFileReport | null;
}

/**
 * The title panel's note text — the whole note, boot sentence included.
 *
 * The first sentence names the worldfile the page booted; it is built here rather than prepended at
 * the boot call site, so the shell's per-tick `setNote` cannot drop it (`L20/worldfile-in-the-note`).
 *
 * The file count is the caller's snapshot, never sampled here, so the note and the panel row cannot
 * read two different counts on one tick. With no run tree the note keeps its sentence and drops the
 * parenthetical rather than claiming `0 files` while the row reads `—`.
 */
export function titleNote(input: TitleNoteInput): string {
  const worldfile = input.worldfile;
  const blocked = input.blocked;
  const provisional = input.provisional;
  const files = input.files === null ? '' : ` (${input.files.count} files)`;
  // A demo world has no golden (PORT-NOTE (L18/demo-scenarios)), so the note must not claim a
  // byte-for-byte comparison it cannot back — it names the artifacts as the boot's own instead.
  const comparison = input.recorded
    ? `Compared byte-for-byte with the native run: ${input.artifacts.join(', ')}. `
    : `A demo world (no recorded golden); the boot’s own artifacts: ${input.artifacts.join(', ')}. `;
  return (
    `Worldfile ${worldfile.path} → ${worldfile.worldSize} × ${worldfile.worldSize} world, ` +
    `${worldfile.agents} agents, vision ${worldfile.vision ? 'on' : 'off'}, ` +
    `run budget ${worldfile.maxSteps} steps. ` +
    comparison +
    `${blocked} key${blocked === 1 ? '' : 's'} not readable, ` +
    `${provisional} provisional. The agents are the run's own — lane L11's \`Simulation\` step ` +
    `loop, writing its run tree into the page${files}.`
  );
}

export interface HudParts {
  title: HTMLElement;
  status: HTMLElement;
  controls: HTMLElement;
}

export function createHud(parts: HudParts): HTMLElement {
  return el('div', { className: 'hud' }, [
    el('div', { className: 'hud__row' }, [parts.title, parts.status]),
    el('div', { className: 'hud__row hud__row--bottom' }, [parts.controls]),
  ]);
}
