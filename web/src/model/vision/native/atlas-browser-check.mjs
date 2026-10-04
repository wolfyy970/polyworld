#!/usr/bin/env node
/**
 * Lane W1j/L16 — real-WebGL2 atlas probe, driven as a real browser page.
 *
 * `src/model/vision/raster.ts` is exercised by a *recording GL double* in
 * `tests/vision-raster.test.ts`: the double proves the readback count, the viewport assignment
 * and the row arithmetic, but it cannot prove that GL really rasterized the atlas or that the
 * byte GL hands back is the byte the encoder expects. This script closes that gap on a real
 * context:
 *
 *   1. `atlas-probe.ts` is built with the project's own vite (no new dependency) into one IIFE
 *      bundle, written next to a one-line HTML page and served over `node:http` on 127.0.0.1;
 *   2. headless Chrome (`--headless=new --remote-debugging-port`, the pattern the W1g lane
 *      proved for the browser shell) opens that page and is driven from plain node with the
 *      global `WebSocket` — no puppeteer, no chrome-remote-interface;
 *   3. the page runs the probe and returns a JSON report: 16 checks over the built 25-agent
 *      atlas (240×72), the sampled-row bytes, a per-viewport `readPixels` equivalence, the
 *      colour quantization, the depth fixtures, the per-step GL-state re-arming (and the two
 *      negative controls that show that check can fail), and the per-step
 *      wall time of the batched path next to native's per-agent readback.
 *
 * Usage (from the repo root):
 *
 *   node src/model/vision/native/atlas-browser-check.mjs            # human-readable report
 *   node src/model/vision/native/atlas-browser-check.mjs --json     # the report as JSON only
 *   node src/model/vision/native/atlas-browser-check.mjs --iterations=100 --keep-open
 *
 * Exit codes: 0 = every check passed, 1 = a check failed (or the page threw), 3 = skipped
 * (no Chrome, or no vite in `node_modules`). `tests/vision-raster.test.ts` runs this script and
 * treats 3 as a skip, so a machine without Chrome still has a green suite.
 *
 * PORT-NOTE(vision/probe-swiftshader): a headless Chrome on a machine with no usable GPU (this
 * one's fallback: ANGLE/Vulkan/SwiftShader) still implements WebGL2 — the claims this probe
 * asserts are spec-defined (RGBA8 quantization on write, `readPixels`' lower-left origin in
 * WebGL2, `GL_LESS` on an exact depth tie), not vendor extensions, so the software rasterizer is
 * a valid witness. The report always carries the unmasked renderer string so a reader can see
 * which implementation was measured; `--require-gpu` turns a software renderer into a failure
 * for a run that wants a hardware witness.
 *
 * PORT-NOTE(vision/raster-gl-state-armed-once): the driver flips `DEPTH_TEST`/BLEND/depthFunc and
 * front-face culling between steps in step 3 (check `gl-state-re-armed-every-step`, measured in
 * `native/atlas-probe.ts`) and then measures that the step is byte-identical to step 1 and that
 * the context is left armed, because `VisionRaster.beginStep()` re-arms its four GL state calls on
 * **every** step: the browser context is shared with the rest of the app, where native's arming
 * lived in a private `QOpenGLContext`. Steps 4 and 5 are the negative controls — the same fixture
 * with the re-arm swallowed, so the equal-depth tie quad wins and the culled atlas goes black.
 * The id names native's one-shot arming; the port deliberately does not reproduce it (PARITY.md's
 * L16 section, finding 5).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const JSON_ONLY = flag('json');
const KEEP_OPEN = flag('keep-open');
const REQUIRE_GPU = flag('require-gpu');
const ITERATIONS = Number.parseInt(option('iterations', '40'), 10);
const DEADLINE_MS = Number.parseInt(option('deadline', '240'), 10) * 1000;

/** stdout stays machine-readable in `--json` mode; every human line goes to stderr. */
const say = (...parts) => {
  if (!JSON_ONLY) console.log(...parts);
};
const note = (...parts) => {
  if (!JSON_ONLY || flag('verbose')) console.error(...parts);
};

function fail(code, reason, extra = {}) {
  const report = { kind: 'polyworld-atlas-browser-check', passed: false, skipped: code === 3, reason, ...extra };
  if (JSON_ONLY) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  console.error(`\n${reason}`);
  process.exit(code);
}

/**
 * Locate a Chrome. An explicitly configured path (CLI `--chrome=` or `CHROME`/`CHROME_BIN`/
 * `CHROME_PATH`) wins and must exist — no silent fallback to another browser; the literal value
 * `off` means "pretend this machine has no Chrome", which is how the skip path is exercised.
 */
function findChrome() {
  const explicit = option('chrome', undefined) ?? process.env.CHROME ?? process.env.CHROME_BIN ?? process.env.CHROME_PATH;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    if (/^(off|none|skip)$/i.test(explicit.trim())) return { path: null, skip: true, source: 'CHROME=off' };
    if (existsSync(explicit)) return { path: explicit, skip: false, source: 'configured' };
    return { path: null, skip: false, missing: explicit };
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/opt/homebrew/bin/chromium',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, skip: false, source: 'known location' };
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const which = spawnSync('which', [name], { encoding: 'utf8' });
    const found = which.stdout?.trim();
    if (which.status === 0 && found) return { path: found, skip: false, source: 'PATH' };
  }
  return { path: null, skip: true, source: 'not found' };
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Build `atlas-probe.ts` into one IIFE bundle with the project's vite (write-nothing build). */
async function bundleProbe() {
  const vite = await import('vite');
  const result = await vite.build({
    configFile: false,
    root: REPO_ROOT,
    logLevel: 'error',
    build: {
      write: false,
      minify: false,
      target: 'esnext',
      lib: {
        entry: join(HERE, 'atlas-probe.ts'),
        formats: ['iife'],
        name: 'PolyworldAtlasProbe',
        fileName: 'atlas-probe',
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    const chunk = (output.output ?? []).find((entry) => entry.type === 'chunk');
    if (chunk) return chunk.code;
  }
  throw new Error('vite produced no chunk for atlas-probe.ts');
}

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="data:," />
    <title>Polyworld — L16 atlas probe</title>
  </head>
  <body>
    <p>L16 real-WebGL2 atlas probe (see src/model/vision/native/atlas-probe.ts).</p>
    <script src="/atlas-probe.js"></script>
  </body>
</html>
`;

function servePage(page, bundle, port) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/' || path === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }
    if (path === '/atlas-probe.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(bundle);
      return;
    }
    if (path === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found\n');
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cleanup handles for the watchdog and for signals: this script must not leak a headless Chrome
 * (a leaked browser from an earlier lane's run was still spinning when that lane was reviewed).
 */
let liveChrome = null;
let liveWorkdir = null;
/** `fs.rmSync` cannot remove a profile tree while Chrome's helpers still hold its files. */
const forceRemove = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* best effort: a locked profile dir is not worth failing the run over */
  }
};
/** Synchronous sleep, for the signal path where there is no event loop left to await on. */
const syncSleep = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable (should not happen on node ≥ 16) */
  }
};
function reap(signal) {
  try {
    liveChrome?.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  if (liveWorkdir) {
    // Chrome's helpers take a moment to die; without the wait the profile tree stays locked and
    // the removal silently leaves the directory behind.
    syncSleep(700);
    forceRemove(liveWorkdir);
  }
  process.exit(signal === undefined ? 1 : 130);
}

async function main() {
  const chromeFound = findChrome();
  if (chromeFound.skip) {
    fail(3, `skipped: no Chrome/Chromium binary found (${chromeFound.source}; set CHROME=/path/to/chrome)`);
  }
  if (!chromeFound.path) {
    fail(1, `configured Chrome does not exist: ${chromeFound.missing} (CHROME=off skips instead)`);
  }
  const chromePath = chromeFound.path;
  if (!existsSync(join(REPO_ROOT, 'node_modules', 'vite', 'package.json'))) {
    fail(3, 'skipped: vite is not installed (npm install)');
  }
  say(`chrome: ${chromePath} (${chromeFound.source})`);
  if (!JSON_ONLY) {
    const version = spawnSync(chromePath, ['--version'], { encoding: 'utf8' }).stdout?.trim();
    if (version) say(`         ${version}`);
  }

  note('building atlas-probe.ts with vite …');
  const bundle = await bundleProbe();
  note(`bundle: ${bundle.length} bytes`);

  const workdir = mkdtempSync(join(tmpdir(), 'polyworld-atlas-probe-'));
  liveWorkdir = workdir;
  writeFileSync(join(workdir, 'index.html'), html);
  writeFileSync(join(workdir, 'atlas-probe.js'), bundle);
  const userDataDir = join(workdir, 'chrome-profile');

  const pagePort = await freePort();
  const debugPort = await freePort();
  const server = await servePage(html, bundle, pagePort);
  const url = `http://127.0.0.1:${pagePort}/`;
  note(`serving ${url} (bundle in ${workdir})`);

  const chromeArgs = [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--enable-unsafe-swiftshader',
    '--window-size=512,512',
    url,
  ];
  const chrome = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  liveChrome = chrome;
  liveWorkdir = workdir;
  let chromeStderr = '';
  chrome.stderr.on('data', (data) => {
    chromeStderr = (chromeStderr + data.toString()).slice(-8000);
  });

  const consoleMessages = [];
  let socket = null;
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try {
      chrome.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };

  try {
    const target = await (async () => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (chrome.exitCode !== null) throw new Error(`chrome exited with ${chrome.exitCode}\n${chromeStderr}`);
        try {
          const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
          const targets = await response.json();
          const page = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
          if (page) return page;
        } catch {
          /* Chrome is still starting. */
        }
        await sleep(250);
      }
      throw new Error(`no CDP page target on port ${debugPort}\n${chromeStderr}`);
    })();

    socket = new WebSocket(target.webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        consoleMessages.push({
          type: message.params.type,
          text: message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '),
        });
      }
      if (message.method === 'Runtime.exceptionThrown') {
        consoleMessages.push({ type: 'exception', text: JSON.stringify(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails) });
      }
      if (message.method === 'Log.entryAdded') {
        consoleMessages.push({ type: `log:${message.params.entry.level}`, text: message.params.entry.text });
      }
    });
    const send = (method, params = {}) => {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolve(message)));
      });
    };
    await new Promise((resolve) => socket.addEventListener('open', resolve));
    await send('Runtime.enable');
    await send('Log.enable');

    const evaluate = async (expression, awaitPromise = false) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
      const details = result.result?.exceptionDetails;
      if (details) {
        throw new Error(`page threw: ${details.exception?.description ?? JSON.stringify(details)}`);
      }
      return result.result?.result?.value;
    };

    // Wait for the bundle to execute — a build/runtime error leaves the page without the hook.
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      ready = (await evaluate('typeof window.__atlasProbe')) === 'function';
      if (ready) break;
      await sleep(250);
    }
    if (!ready) {
      throw new Error(
        `the probe never installed window.__atlasProbe\nconsole: ${JSON.stringify(consoleMessages.slice(-10))}\nchrome: ${chromeStderr.slice(-2000)}`,
      );
    }

    note(`running the probe (${ITERATIONS} timed iterations per path) …`);
    const probe = await evaluate(`window.__atlasProbe({ iterations: ${ITERATIONS} })`, true);
    if (!probe || typeof probe !== 'object') throw new Error(`probe returned ${JSON.stringify(probe)}`);

    const report = {
      ...probe,
      driver: {
        url,
        chrome: chromePath,
        chromeVersion: spawnSync(chromePath, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? null,
        requiresGpu: REQUIRE_GPU,
        iterations: ITERATIONS,
      },
      rendererIsSoftware: /swiftshader|llvmpipe|software/i.test(String(probe.context?.renderer ?? '')),
      consoleErrors: consoleMessages.filter((message) => /error|exception|warning/.test(message.type)),
      consoleMessages: consoleMessages.length,
      chromeStderrTail: chromeStderr.slice(-2000) || null,
    };
    if (REQUIRE_GPU && report.rendererIsSoftware) {
      report.passed = false;
      report.failures = [...(report.failures ?? []), `--require-gpu: renderer is software (${String(probe.context?.renderer)})`];
    }

    if (JSON_ONLY) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      // NB: never `process.exit()` inside the try — it skips the `finally`, which is how this
      // script leaked a headless Chrome on its first failing run.
      return report.passed ? 0 : 1;
    }

    say('');
    say(`renderer      ${String(probe.context?.renderer)}`);
    say(`context       ${String(probe.context?.version)} (${String(probe.context?.extensions)} extensions)`);
    say(`atlas         ${String(probe.layout?.width)}x${String(probe.layout?.height)}, ${String(probe.layout?.viewports)} viewports of ${String(probe.layout?.cell)}`);
    say(`sampling rows ${(probe.layout?.samplingRows ?? []).join(',')} (readbackRow = viewport.y + height/2)`);
    say('');
    for (const step of probe.steps ?? []) {
      say(
        `step ${step.step}  ${step.label.padEnd(34)} draws=${String(step.drawArrays).padStart(4)} ` +
          `readPixels=${step.readPixels} rects=[${step.readPixelRects.join(';')}] clears=${step.clears} clearColor=${step.clearColour}` +
          (step.enable.length || step.disable.length || step.depthFunc.length
            ? ` enable=[${step.enable.join(',')}] disable=[${step.disable.join(',')}] depthFunc=[${step.depthFunc.join(',')}]`
            : ''),
      );
    }
    say('');
    say('checks:');
    for (const entry of probe.checks ?? []) {
      say(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.id.padEnd(38)} ${entry.detail}`);
    }
    const perf = probe.perf ?? {};
    say('');
    say(`perf (${perf.iterations} iterations, ${perf.warmup} warmup, ${perf.fixture}):`);
    for (const key of ['clearOnly', 'batched', 'perAgentReadback']) {
      const entry = perf[key];
      if (!entry) continue;
      say(
        `  ${key.padEnd(18)} median ${entry.median.toFixed(3)} ms  mean ${entry.mean.toFixed(3)}  p95 ${entry.p95.toFixed(3)}` +
          `  readPixels/step ${entry.readPixelsPerStep}  draws/step ${entry.drawArraysPerStep}  bytes/step ${entry.bytesPerStep}`,
      );
    }
    if (report.consoleErrors?.length) {
      say('');
      say(`console errors/warnings: ${JSON.stringify(report.consoleErrors.slice(0, 5))}`);
    }
    say('');
    say(probe.passed ? `PASS — ${(probe.checks ?? []).length} checks, 0 failures` : `FAIL — ${(probe.failures ?? []).join('; ')}`);
    return probe.passed ? 0 : 1;
  } finally {
    kill();
    liveChrome = null;
    socket?.close();
    await new Promise((resolve) => server.close(resolve));
    if (KEEP_OPEN) {
      note(`--keep-open: leaving ${workdir}`);
    } else {
      // Chrome's helpers outlive the main process by a moment, and the profile tree cannot be
      // removed while they hold it: wait for the child, then retry the removal.
      if (chrome.exitCode === null && chrome.signalCode === null) {
        await new Promise((resolve) => {
          const done = () => resolve();
          chrome.once('exit', done);
          setTimeout(done, 2000);
        });
      }
      forceRemove(workdir);
    }
    liveWorkdir = null;
  }
}

const watchdog = setTimeout(() => {
  console.error(`\natlas-browser-check: exceeded its ${DEADLINE_MS / 1000}s deadline`);
  reap(undefined);
}, DEADLINE_MS);
watchdog.unref();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => reap(signal));
}

main()
  .then((code) => {
    process.exit(code ?? 1);
  })
  .catch((error) => {
    if (JSON_ONLY) {
      process.stdout.write(
        `${JSON.stringify(
          {
            kind: 'polyworld-atlas-browser-check',
            passed: false,
            skipped: false,
            reason: `driver error: ${error?.message ?? String(error)}`,
          },
          null,
          2,
        )}\n`,
      );
    }
    console.error(`\natlas-browser-check failed: ${error?.stack ?? String(error)}`);
    process.exit(1);
  });
