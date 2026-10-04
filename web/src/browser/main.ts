/**
 * Lane L18 — entry point (referenced by index.html).
 *
 * Responsibilities, all of them: find the mount point, parse the URL config, **boot the world**
 * (worldfile → `run/*.wf` artifacts + parameters, `sim/worldBoot.ts`), build the shell, start
 * it, and — if anything above throws — replace the boot placeholder with a readable panel
 * instead of leaving a blank page.
 *
 * PORT-NOTE (L18/boot-failure): a worldfile the browser cannot read is not a mystery: the boot
 * throws `WorldBootError` naming the keys the expression evaluator could not produce, and this file
 * prints them.
 * Nothing is substituted to make the page come up — a demo of a different world would be worse
 * than an honest error panel.
 *
 * PORT-NOTE (L18/debug): `window.__polyworld` is a deliberate, always-on debug handle. It is
 * what lets a headless check (or a human in devtools) assert the shell is genuinely rendering —
 * canvas size, draw calls, step count, seed — *and* which scenario was booted, which artifacts
 * were reproduced and which keys are still blocked. It exposes diagnostics only: no setters, so
 * nothing external can drive the shell through it. The one non-scalar it hands back is the run
 * tree the page itself wrote (`runTree()`, base64) — read-only, and the only way a driver can
 * diff the **running page's** artifacts against the golden with `tools/check_parity.py` instead of
 * trusting the node-side equivalent of the same code path.
 */

import { PolyworldShell, type RunTreeEntry, type RunTreeFile, type ShellDiagnostics } from './app';
import { parseShellConfig, type ShellConfig } from './config';
import { bundledSources } from './sim/bundledWorlds';
import { bootWorld, WorldBootError, type BootedWorld } from './sim/worldBoot';
import { el } from './ui/dom';

export interface ShellHandle {
  readonly config: ShellConfig;
  readonly boot: {
    scenario: string;
    worldfilePath: string;
    worldSize: number;
    displayAgents: number;
    vision: boolean;
    maxSteps: number;
    artifacts: string[];
    blockedKeys: string[];
    provisionalKeys: string[];
  };
  diagnostics(): ShellDiagnostics;
  /** The run tree the page wrote: a manifest, plus per-file / per-range base64 reads (L18/debug). */
  runTreeManifest(): readonly RunTreeEntry[];
  runTreeFile(path: string, from?: number, length?: number): RunTreeFile | null;
  runTreeFiles(paths: readonly string[]): readonly RunTreeFile[];
  dispose(): void;
}

declare global {
  interface Window {
    __polyworld?: ShellHandle;
  }
}

function boot(): void {
  const mount = document.getElementById('app');
  if (!mount) throw new Error('#app mount point is missing from index.html');

  const config = parseShellConfig(window.location.search);
  // A seed on the URL is native's `--InitSeed` (`config.ts`'s PORT-NOTE): it goes through lane W1b's
  // converter with the scenario's own argv, so `run/converted.wf` records it exactly as native's does.
  const built: BootedWorld = bootWorld(bundledSources(config.scenario), {
    parameters: config.seed === null ? [] : [['InitSeed', String(config.seed)]],
  });

  if (typeof console !== 'undefined') {
    // One line, on purpose: the boot's own report is the first thing a reviewer wants to see in
    // devtools, and it is not an error.
    console.info(
      `[polyworld] booted ${built.scenario.name}: ${built.sources.worldfilePath} → ` +
        `${built.params.worldSize}×${built.params.worldSize}, ${built.params.displayAgents} agents, ` +
        `vision ${built.params.vision}, ${[...built.artifacts.keys()].join(', ')} ` +
        `(${built.report.blocked.length} key(s) not readable)`,
    );
  }

  const shell = new PolyworldShell({ mount, config, boot: built });

  // The pre-boot placeholder has done its job once the shell is constructed.
  document.getElementById('boot')?.remove();

  shell.start();

  window.__polyworld = {
    config,
    boot: {
      scenario: built.scenario.name,
      worldfilePath: built.sources.worldfilePath,
      worldSize: built.params.worldSize,
      displayAgents: built.params.displayAgents,
      vision: built.params.vision,
      maxSteps: built.params.maxSteps,
      artifacts: [...built.artifacts.keys()],
      blockedKeys: built.report.blocked.map((entry) => entry.key),
      provisionalKeys: built.report.provisional.map((entry) => entry.key),
    },
    diagnostics: () => shell.diagnostics(),
    runTreeManifest: () => shell.runTreeManifest(),
    runTreeFile: (filePath, from, length) => shell.runTreeFile(filePath, from, length),
    runTreeFiles: (paths) => shell.runTreeFiles(paths),
    dispose: () => shell.dispose(),
  };
}

function showFatal(error: unknown): void {
  const host = document.getElementById('app') ?? document.body;
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof Error && error.stack ? error.stack : '';

  const children: (Node | string)[] = [
    el('h2', { text: 'Polyworld could not start' }),
    el('p', { text: message }),
  ];

  if (error instanceof WorldBootError) {
    children.push(
      el(
        'ul',
        { className: 'boot__list' },
        error.blockedKeys.map((entry) => el('li', { text: `${entry.key} — ${entry.reason}` })),
      ),
      el('p', {
        className: 'panel__note',
        text:
          'These keys are worldfile expressions the expression evaluator could not produce ' +
          '(the port of the native interpreter.py step reports the underlying reason above). ' +
          'A worldfile whose required keys are literal always boots — try ?scenario=minitest_voff.',
      }),
    );
  } else {
    children.push(
      el('p', {
        className: 'panel__note',
        text:
          'This demo needs WebGL2 and a readable worldfile. If the browser has both, the ' +
          'message above is the first error the shell hit — the console has the full trace.',
      }),
    );
  }

  if (detail) children.push(el('pre', { text: detail }));

  host.replaceChildren(el('div', { className: 'boot' }, [el('section', { className: 'panel fatal', attrs: { role: 'alert' } }, children)]));
}

try {
  boot();
} catch (error) {
  showFatal(error);
  // Only reachable when the shell could not start; the acceptance criteria for this lane
  // require a clean console on success, not a silent failure on error.
  console.error('[polyworld] shell failed to start:', error);
}
