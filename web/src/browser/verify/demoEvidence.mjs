/**
 * Lane L18/L20 — end-to-end evidence from the **running page** (verification only; not part of the
 * bundle).
 *
 *   node src/browser/verify/demoEvidence.mjs <url> [--export <dir>] [--screenshot <png>]
 *                                           [--json <file>] [--speed <n>] [--timeout <s>]
 *
 * Chrome must already be listening on `--remote-debugging-port` (`CDP_PORT`, default 9222), exactly
 * like `headless.mjs` — the caller owns the browser's lifetime and its profile:
 *
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
 *     --remote-debugging-port=9444 --remote-allow-origins='*' \
 *     --user-data-dir=$(mktemp -d) --no-first-run --no-default-browser-check \
 *     --disable-extensions --disable-background-networking --enable-unsafe-swiftshader \
 *     --window-size=1280,800 about:blank
 *   CDP_PORT=9444 node src/browser/verify/demoEvidence.mjs http://localhost:5173/?scenario=hello \
 *     --export /tmp/l20-page-tree --screenshot /tmp/l20.png
 *
 * What it asserts (all of it measured on the live page, none of it from a fixture):
 *
 *   1. **first-load budget** — every request the page makes is same-origin, and the list is the
 *      page + its own bundle/static assets: no compiler, no CDN, nothing off-origin (`--export`
 *      keeps the request list in the JSON report);
 *   2. **the shell is the model** — `flavour === 'model'`, the status panel says so, the roster
 *      count on screen is the run's own, and the run has written its own artifacts;
 *   3. **the controls drive the run** — pause freezes the step counter, single step advances one,
 *      a speed button changes the multiplier, play advances again;
 *   4. **the scene draws the run's agents** — draw calls and triangles are non-zero (Three.js
 *      `renderer.info`, read through the diagnostics) and the agent count matches the roster;
 *   5. optional `--export <dir>` — run to the run's own end, then dump the **page's** run tree to
 *      `<dir>/run/**` so `./oracle/run_parity.sh <scenario> --candidate <dir>` can diff it with the
 *      golden (`window.__polyworld.runTree()`, base64 per file; see PORT-NOTE (L18/debug)).
 */

import { mkdirSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = process.env.CDP_PORT ?? '9222';
const argv = process.argv.slice(2);

function flag(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

/**
 * t_37bf7212 — a frozen golden is never a write target.
 *
 * `--export <dir>` writes the page's run tree to `<dir>/run/**`, so `--export oracle/microtest_voff`
 * would rebuild the golden in place (and a lane's worktree `oracle/<scenario>/run` symlink resolves
 * there too). The rule and its TS implementation live in `src/oracle/guard.ts`, which the tests and
 * the lane tooling import; this plain-node script has no TS loader, so it carries the same check.
 */
function refuseGoldenExport(dir) {
  const real = (target) => {
    let current = path.resolve(target);
    const tail = [];
    for (;;) {
      if (existsSync(current)) {
        let resolved = current;
        try {
          resolved = realpathSync(current);
        } catch {
          /* a dangling symlink has no real path */
        }
        return path.join(resolved, ...[...tail].reverse());
      }
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...tail.reverse());
      tail.push(path.basename(current));
      current = parent;
    }
  };
  const inside = (child, parent) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const oracle = real(process.env.POLYWORLD_ORACLE_ROOT ?? path.join(repoRoot, 'oracle'));
  const resolved = real(dir);
  if (!inside(resolved, oracle)) return;
  const first = path.relative(oracle, resolved).split(path.sep)[0] ?? '';
  if (first.startsWith('_t_')) return;
  throw new Error(
    `--export ${dir}: refusing to write ${resolved} — it resolves into the frozen oracle ` +
      `(oracle/${first}/run/**), which only \`run_parity.sh <scenario> --record\` may write. ` +
      'Export to $TMPDIR or oracle/_t_* instead (src/oracle/guard.ts).',
  );
}

const targetUrl = argv[0] ?? 'http://localhost:5173/';
const exportDir = flag('export');
const screenshotPath = flag('screenshot');
const jsonPath = flag('json');
const speed = Number(flag('speed', '8'));
const timeoutMs = Number(flag('timeout', '300')) * 1000;

async function findTarget() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no CDP page target on port ${port}`);
}

const target = await findTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const consoleMessages = [];
const requests = [];

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    consoleMessages.push({
      type: message.params.type,
      text: message.params.args.map((a) => a.value ?? a.description ?? '').join(' '),
    });
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleMessages.push({ type: 'exception', text: JSON.stringify(message.params.exceptionDetails) });
  }
  if (message.method === 'Log.entryAdded') {
    consoleMessages.push({ type: `log:${message.params.entry.level}`, text: message.params.entry.text });
  }
  if (message.method === 'Network.requestWillBeSent') {
    requests.push({
      url: message.params.request.url,
      method: message.params.request.method,
      type: message.params.type,
    });
  }
});

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, (message) => resolve(message.result ?? message.error ?? {})));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function evaluateJson(expression) {
  const text = await evaluate(`JSON.stringify(${expression})`);
  return text === undefined ? null : JSON.parse(text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(expression, what, budgetMs = timeoutMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      if ((await evaluate(expression)) === true) return true;
    } catch {
      // navigation in flight: the execution context is gone
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

await new Promise((resolve) => socket.addEventListener('open', resolve));
await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Log.enable');

const report = { url: targetUrl, startedAt: new Date().toISOString() };
const firstLoadFrom = requests.length;
await send('Page.navigate', { url: targetUrl });
await waitFor('typeof window.__polyworld !== "undefined"', 'the shell handle');
await waitFor('document.querySelector("canvas") !== null', 'the canvas');
await sleep(1500); // let the run step a little before the first reading

report.firstLoad = requests.slice(firstLoadFrom);

// ---- the shell is the model ------------------------------------------------------------------
const shell = await evaluateJson(`(() => ({
  scenario: window.__polyworld.boot.scenario,
  worldfile: window.__polyworld.boot.worldfilePath,
  worldSize: window.__polyworld.boot.worldSize,
  maxSteps: window.__polyworld.boot.maxSteps,
  vision: window.__polyworld.boot.vision,
  artifacts: window.__polyworld.boot.artifacts,
  blockedKeys: window.__polyworld.boot.blockedKeys,
  provisionalKeys: window.__polyworld.boot.provisionalKeys,
  flavour: window.__polyworld.diagnostics().flavour,
  agentCount: window.__polyworld.diagnostics().agentCount,
  agentCapacity: window.__polyworld.diagnostics().agentCapacity,
  seed: window.__polyworld.diagnostics().seed,
  runFiles: window.__polyworld.diagnostics().runFiles,
  notice: window.__polyworld.diagnostics().notice,
  canvas: { w: document.querySelector("canvas").width, h: document.querySelector("canvas").height },
  pixelRatio: window.devicePixelRatio,
}))()`);
report.shell = shell;

// ---- the two file counts on screen (the title note and the `run files` row) -------------------
// PORT-NOTE (L20/live-note): the title note names the run tree's file count, and so does the status
// panel's `run files` row; they have to be the same number. Both are read inside **one**
// `Runtime.evaluate`, so the comparison cannot race a run whose tree is still growing — and the two
// numbers are reported, not just the panel's text (measured before the fix: `hello` note 10 /
// panel 11, `minitest_voff` note 196 / panel 257).
// PORT-NOTE (L20/worldfile-in-the-note): the note's other half — the sentence naming the worldfile
// the page booted — is read here too (`worldfileInNote`), against the path the page's own
// diagnostics report, because that sentence was silently dropped on the first tick once
// (`t_c824de39`) and no other surface on the page carries the path.
const hud = await evaluateJson(`(() => {
  const countIn = (text, pattern) => {
    if (text === null) return null;
    const match = pattern.exec(text);
    return match === null ? null : Number(match[1]);
  };
  const noteNode = document.querySelector("section.panel:not(.status) .panel__note");
  const keys = [...document.querySelectorAll(".status__key")];
  const index = keys.findIndex((key) => key.textContent === "run files");
  const rowNode = index < 0 ? null : keys[index].nextElementSibling;
  const noteText = noteNode === null ? null : noteNode.textContent;
  const rowText = rowNode === null ? null : rowNode.textContent;
  const noteFiles = countIn(noteText, /\\((\\d+) files\\)/);
  const rowFiles = countIn(rowText, /^(\\d+)/);
  const worldfilePath = window.__polyworld.diagnostics().worldfile;
  return {
    note: noteText,
    row: rowText,
    noteFiles,
    rowFiles,
    // Two numbers on screen and they differ: the defect this reading exists to catch.
    disagree: noteFiles !== null && rowFiles !== null && noteFiles !== rowFiles,
    worldfilePath,
    // The booted worldfile is still named on the note *after* ticks — the tick text, not the
    // construction argument (that is the whole point of reading it here rather than at boot).
    worldfileInNote: noteText !== null && noteText.includes("Worldfile " + worldfilePath + " "),
    statusPanel: document.querySelector(".status")?.innerText ?? null,
    titlePanel: document.querySelector(".hud")?.innerText?.slice(0, 700) ?? null,
  };
})()`);
report.titleNote = hud.note;
report.runFilesRow = hud.row;
report.hudCounts = {
  note: hud.noteFiles,
  row: hud.rowFiles,
  disagree: hud.disagree,
  worldfilePath: hud.worldfilePath,
  worldfileInNote: hud.worldfileInNote,
};
report.statusPanel = hud.statusPanel;
report.titlePanel = hud.titlePanel;
report.controls = await evaluateJson(
  '[...document.querySelectorAll(".controls .btn, .speed .btn")].map((b) => b.textContent)',
);

// ---- the controls drive the run --------------------------------------------------------------
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const stepIndex = () => evaluate('window.__polyworld.diagnostics().stepIndex');

await click('.controls .btn--primary'); // pause
const pausedA = await stepIndex();
await sleep(900);
const pausedB = await stepIndex();

await evaluate('[...document.querySelectorAll(".controls .btn")].find((b) => b.textContent === "Step").click()');
const afterStep = await stepIndex();

await evaluate(`[...document.querySelectorAll(".speed .btn")].find((b) => b.textContent.includes("${speed}")).click()`);
const speedAfterClick = await evaluate('window.__polyworld.diagnostics().speed');

await click('.controls .btn--primary'); // play
const runningA = await stepIndex();
await sleep(1200);
const runningB = await stepIndex();

report.controlsRun = {
  pauseFroze: pausedA === pausedB,
  pausedSteps: [pausedA, pausedB],
  stepDelta: afterStep - pausedB,
  speedRequested: speed,
  speedAfterClick,
  advancedWhileRunning: runningB > runningA,
  runningSteps: [runningA, runningB],
};

// ---- the scene draws the run's agents --------------------------------------------------------
report.render = await evaluateJson(`(() => {
  const d = window.__polyworld.diagnostics();
  const canvas = document.querySelector("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  return {
    drawCalls: d.drawCalls,
    triangles: d.triangles,
    agentCount: d.agentCount,
    agentCapacity: d.agentCapacity,
    stepIndex: d.stepIndex,
    digest: d.digest,
    canvas: { w: canvas.width, h: canvas.height },
    glVersion: gl === null ? null : gl.getParameter(gl.VERSION),
    glRenderer: gl === null ? null : gl.getParameter(gl.RENDERER),
  };
})()`);
report.stepEvidence = await evaluateJson(`(() => {
  const before = window.__polyworld.diagnostics();
  return { digestBefore: before.digest, stepBefore: before.stepIndex };
})()`);

if (screenshotPath !== null) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
  report.screenshot = screenshotPath;
}

// ---- optional: export the page's own run tree ------------------------------------------------
if (exportDir !== null) {
  // t_37bf7212: refuse a frozen golden before a single byte is written (see the helper above).
  refuseGoldenExport(exportDir);
  // Run to the run's own end at the fastest offered multiplier, then dispose: native's destructor
  // is part of a run (it writes `run/endStep.txt` and the `DR_SIMEND` kills), and `dispose()` is
  // what triggers the same end phase in the page.
  await evaluate(`[...document.querySelectorAll(".speed .btn")].at(-1).click()`);
  const playButton = await evaluate(
    'document.querySelector(".controls .btn--primary")?.textContent ?? null',
  );
  if (playButton !== null && !/pause/i.test(playButton)) await click('.controls .btn--primary');
  await waitFor('window.__polyworld.diagnostics().ended === true', 'the run to reach its own end');
  report.ended = await evaluateJson('window.__polyworld.diagnostics()');
  await evaluate('window.__polyworld.dispose()');

  // The tree is pulled in batches: minitest's 1368 files are 16 MB with one 7.7 MB artifact, and a
  // single CDP message cannot carry that (measured: the single-shot form left the await unsettled
  // and the driver exited 13). Small files go out in batches; a file bigger than one batch is read
  // in byte ranges, base64-joined here.
  const manifest = await evaluateJson('window.__polyworld.runTreeManifest()');
  const BATCH_BASE64 = 512 * 1024; // ~384 kB of bytes per message
  const files = [];
  let batch = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const chunk = await evaluateJson(
      `window.__polyworld.runTreeFiles(${JSON.stringify(batch)}).map((f) => [f.path, f.base64])`,
    );
    for (const entry of chunk) files.push(entry);
    batch = [];
    batchBytes = 0;
  };

  for (const entry of manifest) {
    if (entry.bytes * 4 / 3 <= BATCH_BASE64) {
      batch.push(entry.path);
      batchBytes += entry.bytes;
      if (batchBytes * 4 / 3 >= BATCH_BASE64) await flush();
      continue;
    }
    await flush();
    const SLICE = 384 * 1024;
    let parts = '';
    for (let offset = 0; offset < entry.bytes; offset += SLICE) {
      const slice = await evaluateJson(
        `window.__polyworld.runTreeFile(${JSON.stringify(entry.path)}, ${offset}, ${SLICE})`,
      );
      parts += slice.base64;
    }
    files.push([entry.path, parts]);
  }
  await flush();

  for (const [relative, base64] of files) {
    const file = path.join(exportDir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(base64, 'base64'));
  }
  report.export = {
    dir: exportDir,
    files: files.length,
    bytes: files.reduce((total, [, base64]) => total + Buffer.from(base64, 'base64').length, 0),
  };
  report.exportedPaths = files.map(([relative]) => relative).sort();
}

// ---- summary ---------------------------------------------------------------------------------
report.errors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'exception');
report.warnings = consoleMessages.filter((m) => m.type === 'warning' || m.type === 'log:warning');
report.consoleInfo = consoleMessages.filter((m) => m.type === 'info').map((m) => m.text);
report.offOriginRequests = report.firstLoad
  .map((request) => request.url)
  .filter((url) => {
    try {
      return new URL(url).origin !== new URL(targetUrl).origin;
    } catch {
      return false;
    }
  });
report.firstLoadSummary = {
  total: report.firstLoad.length,
  byType: report.firstLoad.reduce((counts, request) => {
    counts[request.type] = (counts[request.type] ?? 0) + 1;
    return counts;
  }, {}),
  // On the dev server vite serves one request per module, so the count is the module graph; built
  // and served statically (`npm run build` + a static server) it is the bundle: 4 requests.
  note: 'dev: one request per module (vite transforms on the server — nothing compiles in the page); dist: page + JS + CSS + favicon',
};
report.suspiciousRequests = report.firstLoad
  .map((request) => request.url)
  .filter((url) => /\.(wasm|wasm\.map)(\?|$)/i.test(url) || /compiler|emscripten|pyodide|cdn/i.test(url));
report.finishedAt = new Date().toISOString();

const text = JSON.stringify(report, null, 2);
if (jsonPath !== null) writeFileSync(jsonPath, text);
console.log(text);
socket.close();
