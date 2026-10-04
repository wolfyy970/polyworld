/**
 * Lane L18 — headless driver for the browser port (verification only; not part of the bundle).
 *
 * Drives the dev server with a real Chrome over CDP using node's built-in WebSocket, so a lane
 * can assert the *running* shell (step loop, pause, single step, speed, diagnostics) rather than
 * a DOM dump at one instant. Run: node <this file> <url>   (Chrome must already be listening on
 * --remote-debugging-port=9222.)
 */

const port = process.env.CDP_PORT ?? '9222';
const targetUrl = process.argv[2] ?? 'http://localhost:5173/';

async function findTarget() {
  for (let attempt = 0; attempt < 40; attempt++) {
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
  throw new Error('no CDP page target');
}

const page = await findTarget();
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const consoleMessages = [];

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
});

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
  if (result.result?.exceptionDetails) {
    throw new Error(JSON.stringify(result.result.exceptionDetails));
  }
  return result.result?.result?.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Booting the world is more than fetching a page now: `main.ts` runs the worldfile through lane
 * W1b's converter and `createModelWorld` constructs lane L11's `TSimulation` (genomes, brains,
 * the initial population) before the HUD exists. Poll for the handle instead of guessing a
 * duration, and report a page that never got there instead of throwing on a missing button.
 */
async function waitForShell(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const ready = await evaluate('typeof window.__polyworld !== "undefined"');
      if (ready === true) return true;
    } catch {
      // navigation in flight
    }
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

await new Promise((resolve) => socket.addEventListener('open', resolve));
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: targetUrl });
const shellUp = await waitForShell();

const report = { shellUp, url: targetUrl };
report.diagnostics = await evaluate('JSON.stringify(window.__polyworld?.diagnostics() ?? null)');
report.boot = await evaluate('JSON.stringify(window.__polyworld?.boot ?? null)');
report.statusTextEarly = await evaluate('document.querySelector(".status")?.innerText?.slice(0, 600) ?? null');

if (!shellUp) {
  report.errors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'exception' || m.type === 'warning');
  console.log(JSON.stringify(report, null, 2));
  socket.close();
  process.exit(1);
}

// Pause via the button, then confirm the step counter freezes while frames continue.
await evaluate('document.querySelector(".controls .btn--primary").click()');
const pausedA = await evaluate('window.__polyworld.diagnostics().stepIndex');
await sleep(900);
const pausedB = await evaluate('window.__polyworld.diagnostics().stepIndex');
report.pauseFroze = pausedA === pausedB;

// Single step advances exactly one step.
await evaluate('[...document.querySelectorAll(".controls .btn")].find(b => b.textContent === "Step").click()');
const afterStep = await evaluate('window.__polyworld.diagnostics().stepIndex');
report.stepDelta = afterStep - pausedB;

// Speed buttons: 8x is the last one.
await evaluate('[...document.querySelectorAll(".speed .btn")].at(-1).click()');
report.speedAfterClick = await evaluate('window.__polyworld.diagnostics().speed');

// Play again and confirm it moves.
await evaluate('document.querySelector(".controls .btn--primary").click()');
const runningA = await evaluate('window.__polyworld.diagnostics().stepIndex');
await sleep(900);
const runningB = await evaluate('window.__polyworld.diagnostics().stepIndex');
report.advancedWhileRunning = runningB > runningA;

// Camera reset (keyboard shortcut path) and a new run. A new run is a *page* reload: the model's
// tables are process-wide (native's are too), so lane L11's `Simulation` cannot be constructed
// twice in one process — the shell reloads with the next `InitSeed` (`app.ts::resetRun`).
await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "v" }))');
report.cameraAfterReset = await evaluate('JSON.stringify(window.__polyworld.diagnostics().cameraPosition)');
const before = JSON.parse(await evaluate('JSON.stringify({seed: window.__polyworld.diagnostics().seed, digest: window.__polyworld.diagnostics().digest})'));
await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }))');
let after = null;
for (let attempt = 0; attempt < 40 && after === null; attempt++) {
  await sleep(250);
  try {
    const seen = await evaluate('window.__polyworld ? JSON.stringify({seed: window.__polyworld.diagnostics().seed, digest: window.__polyworld.diagnostics().digest, url: location.search}) : null');
    if (seen !== null && seen !== undefined) {
      const parsed = JSON.parse(seen);
      if (parsed.seed !== before.seed) after = parsed;
    }
  } catch {
    // the navigation is in flight: the execution context is gone, try again
  }
}
report.newRun = { before, after };
report.newRunChangedSeed = after !== null && after.seed === before.seed + 1;
report.newRunChangedDigest = after !== null && after.digest !== before.digest;

report.canvas = await evaluate('JSON.stringify({w: document.querySelector("canvas")?.width, h: document.querySelector("canvas")?.height})');
report.statusText = await evaluate('document.querySelector(".status")?.innerText?.slice(0, 400) ?? null');
report.errors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'exception' || m.type === 'warning');

console.log(JSON.stringify(report, null, 2));
socket.close();
