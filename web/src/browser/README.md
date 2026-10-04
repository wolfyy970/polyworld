# src/browser — lane L18 (browser wiring)

The browser front end. It **boots a recorded worldfile**, draws the world that file describes and
**steps lane L11's simulation in the page** — no `node:fs`, no backend, no preview stand-in. The
agents on screen are the run's live roster: their positions, yaw, radius and body colour come from
`agent::*` (`x()`/`z()`/`yaw()`/`radius()`/`color()`), and the step loop is native's
`TSimulation::Step`. The run's own artifacts (`run/motion/**`, `run/genome/**`, `run/lifespans.txt`,
…) are written into an in-memory `RecordFileSystem` as the run goes — the monitor's status text
(`run/stats/stat.<timestep>`) included, because the page mounts lane L14's `MonitorManager` off
`stepEnding` exactly as native's app does.

The run-tree artifacts are compared byte-for-byte with the native run (see *Verification*), and —
since L18d (`PORT_SPEC.md` → *The render is a fidelity surface*) — **the scene itself is a fidelity
surface too**: the page must *look* the way the native build renders it. The renderer values
(clear colour, ground, agent mesh, boxes, barriers, lighting, default camera) come from the native
source, not from a house style; the handful of deliberate differences are each a
`PORT-NOTE (L18d/…)` with its reason.

## Run

```
npm run dev        # Vite dev server, http://localhost:5173
npm run build      # production bundle into dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest (node environment)
```

URL parameters (parsed in `config.ts`):

| Param | Default | Meaning |
|---|---|---|
| `scenario` | `minitest_voff` | which recorded scenario to boot (`microtest_voff`, `microtest_von`, `minitest_voff`, `minitest_von`, `hello`); unknown names fall back. `hello` is lane L20's demo world: `worldfiles/hello.wf` pins **one** key (`MaxSteps 500`) and takes everything else from the schema's defaults (`WorldSize 100`, `InitAgents 180` / `MaxAgents 300`) |
| `seed` | the worldfile's `InitSeed` | native `--InitSeed` — which *run* of the world (a model knob, applied through the worldfile converter) |
| `agents` | `32` | renderer **capacity floor** — the world's own agent count wins when larger |
| `stepHz` | `30` | fixed simulation steps per simulated second |
| `speed` | `1` | sim-time multiplier, snapped to one of `0.25 0.5 1 2 4 8` |

Controls: `space` play/pause · `.` single step · `r` new run · `v` reset view · `1`–`6` speed ·
drag to orbit · wheel to zoom. The same actions are on the buttons. "New run" reloads the page with
the next `InitSeed`: the model's tables are process-wide (as native's are), so a run cannot be
rewound or re-spawned inside one page — native's binary runs one simulation per process too.

## Layout

```
main.ts              entry: mount, config, BOOT the worldfile, shell, fatal panel, __polyworld
app.ts               PolyworldShell — where world, scene and UI meet (single sim swap point)
config.ts            URL config parsing (pure, unit-tested)
env.d.ts             the `?raw` asset-import types the bundle needs
style.css            design tokens + HUD/control/status styling (no framework)
favicon.svg          inline octahedron, so the page has no 404
worldfiles/          verbatim copies of the native inputs (minitest.wf, microtest.wf, hello.wf,
                     worldfile.wfs) — see PORT-NOTE (L18/bundled-worldfiles)
monitors/            verbatim copies of the native monitor documents (monitors.mfs, term.mf) —
                     see PORT-NOTE (L18/bundled-monitor-documents)

sim/                 no three.js imports; plain numbers and the model's own readers
  scenarios.ts       the four recorded scenarios + `hello` + their native args
  worldBoot.ts       the boot: sources -> converted/normalized/original artifacts + params
  worldParams.ts     the read plan: every Config read, every blocked key, never a substitute
  simSeam.ts         SimulationLike + native <-> scene coordinate conversions (the L11 seam)
  modelWorld.ts      THE WORLD: lane L11's `Simulation` behind the seam (roster, clock, run
                     files, and lane L14's `MonitorManager` mounted off `stepEnding`)
  browserFiles.ts    the page's RecordFileSystem: in-memory run tree, gzip via `gzipContainer`,
                     plus lane L14's `StatusTextStore` over that same seam
  bundledWorlds.ts   the `?raw` sources the browser bundle boots from
  bundledMonitors.ts the `?raw` monitor documents + lane L14's document loader
  nodeSources.ts     node-only: recorded sources, the parity run/tree writer
  fixedStep.ts       fixed-dt accumulator (speed scales simulated time only)
  *.test.ts          boot parity, the bundled monitor documents, the seam contract, the three run
                     trees (`hello`'s is a file of its own: its worldfile records a different
                     artifact set), step maths, config parsing

scene/               the visuals, drawn the way the native renderer draws them (L18d)
  palette.ts         native clear colour + worldfile RGB helpers + the native MainScene camera pose
  agentMesh.ts       the agent body mesh from etc/objects/agent.obj, split into native's two ranges
  ground.ts          the ground: etc/objects/ground.obj, worldSize-scaled, at -GroundClearance
  agents.ts          agent field: 2 instanced meshes (nose range + body range), the model's own
                     mesh lengths and two colours
  objects.ts         food/brick boxes: one instanced mesh per kind, the model's own size and colour
  barriers.ts        barrier walls: one instanced mesh, the worldfile's segments + BarrierColor
  sceneRoot.ts       scene assembly (native black clear, ground, barriers, boxes, agents; no lights,
                     no fog, no grid — nothing native does not draw)
  scene.test.ts      L18c: the native->scene mapping and the per-instance transforms, no WebGL

render/              the GPU-facing layer
  viewport.ts        WebGLRenderer, DPR clamp, ResizeObserver sizing, stats
  cameraRig.ts       orbit camera, framed from the booted world size

ui/                  DOM, no framework
  dom.ts             el()/setText()/setPressed() helpers
  hud.ts             panel layout + the title note's text (`titleNote`, the whole note every tick)
  hud.test.ts        L20: the note keeps the booted worldfile, and its file count is the panel's
                     `run files` count
  controlBar.ts      play/pause, step, speed, new run, reset view + legend
  statusPanel.ts     world / run / cost / identity rows + the notice line
  keyboard.ts        shortcuts, ignoring events from focused form controls

verify/headless.mjs  CDP driver for a real Chrome (dev-server acceptance, not bundled)
verify/demoEvidence.mjs  CDP driver: request budget, controls, screenshot, and the *page's own*
                     run tree exported to disk for `./oracle/run_parity.sh` (L20)
```

## The seams

* **Simulation (L11).** `app.ts::bootedSimulation()` calls `createModelWorld` (`sim/modelWorld.ts`),
  which builds lane L11's `TSimulation` from the boot's applied document + artifact texts and hands
  it a sink that is not `node:fs` (`sim/browserFiles.ts`). The shell sees `SimulationLike`
  (`sim/simSeam.ts`): agents in **native** coordinates (x ∈ [0, worldSize], z ∈ [-worldSize, 0], yaw
  in degrees, plus the model's radius and body colour), the model's `food` and `brick` boxes (centre,
  `fLength`, own colour — `food`/`brick` are both `gboxf`s), the `barrier` walls
  (`absolutePosition()` + `gBarrierHeight`), `step()`, `stepIndex`, `simSeconds`, `maxSteps`,
  `flavour: 'model'`, `ended`, `notice` and a presentation-grade `stateDigest()`. The worldfile's own
  declarations — `BarrierHeight`/`BrickHeight`, the `Barriers` segments (ratio-scaled exactly as
  `barrier::updateVertices` does) and the `BrickPatches` rectangles/counts/colours — are read by
  `worldParams.ts` (`barriers`, `brickPatches`), so the shell draws the file's geometry and never
  invents it. Since L18c the scene draws all three object families (`scene/objects.ts`,
  `scene/barriers.ts`), and the status panel's `scene objects` row states what is drawn and what is
  not (`0 bricks (no BrickPatches)`, `0/2 barriers` for the boot-degenerate `growingBarriers` walls).
* **Visuals (L15/L16/L18d).** Everything visual lives under `scene/`; `sceneRoot` builds and hands
  back the scene, and `app.ts` never touches three.js internals beyond rendering it. Since L18d the
  scene is held to the native renderer as its contract (`PORT_SPEC.md` → *The render is a fidelity
  surface*): no lights (native never enables `GL_LIGHTING`), native's black clear, the agent body
  mesh from `etc/objects/agent.obj`, the ground from `etc/objects/ground.obj`, and the native
  `MainScene` camera as the default view.
* **Expression evaluation (L4).** `worldParams.ts` reports every unevaluated worldfile expression it
  meets; nothing is substituted, so a worldfile the interpreter cannot read is a fatal panel with
  the keys named.

## Verification (L18/L18b, on this machine)

* **Oracle parity.** The lane's tests boot each recorded scenario from the recorded sources, step
  the **page's own** world to its end and write the resulting run tree (`POLYWORLD_BROWSER_CANDIDATE_ROOT`
  overrides where); `./oracle/run_parity.sh <scenario> --candidate <root>/<scenario>` then compares
  it with the golden. The default root is keyed per worker process
  (`$TMPDIR/polyworld-browser-candidates/pid-<pid>[-t<thread>]`, t_1ce9957f), so a run without the
  env var names its tree in a `PROVENANCE.txt` beside `run/` and prints the path — and the two
  commands above keep meaning what they say, because a pinned `POLYWORLD_BROWSER_CANDIDATE_ROOT=<root>`
  is used verbatim:

  ```
  microtest_voff -> match 224/225  differing=0  missing=0  extra=0   (ignored=1 = movie.pmv)
  minitest_voff  -> match 1368/1369 differing=0 missing=0  extra=0   (ignored=1 = movie.pmv)
  hello          -> match 18/19    differing=0  missing=0  extra=0   (ignored=1 = movie.pmv)
  ```

  The verdict lines read `parity: PASS (225/225 files)` and `PASS (1369/1369 files)` — the harness's
  `match` denominator counts the one ignored file. Every artifact the run writes is byte-identical,
  the monitor's `run/stats/stat.{1,100,200,300}` included: lane L14's `MonitorManager` is mounted off
  `stepEnding` exactly as native's app mounts it, over monitor documents bundled in the page
  (`L18/monitors-in-the-page`, `L18/bundled-monitor-documents`, `L18/status-text-store`). The gzip
  containers compare byte-identical too. The only golden files a page run still does not produce are
  `run/movie.pmv` (Tier C, free) and the harness's own `run/manifest.sha256`; `runTreeSuite.ts` pins
  exactly that pair, so a lost artifact fails the suite instead of hiding in a count.
* `npx tsc --noEmit` clean; `npm test` — `src/browser/**` 79 tests, whole suite 626 passed / 1
  skipped / 1 red file (`tests/cppprops-sim-engine.test.ts`, a *different* lane's in-flight test:
  it constructs a second `TSimulation` in one process, which the model refuses by design —
  `PORT-NOTE (L18/one-run-per-process)`; measured 2026-09-28 20:23, not this lane's);
  `npm run build` succeeds (the >500 kB chunk notice is informational: three.js plus the 48 kB
  worldfile schema).
* **Running shell**, driven by a real headless Chrome over CDP
  (`node src/browser/verify/headless.mjs "<url>"` with Chrome on `--remote-debugging-port`):
  60 fps, 30 steps/s at 1× and 240 at 8×, pause freezes the step counter, single step +1, a new run
  reloads with the next `InitSeed`, camera reset works, 9 draw calls for `minitest_voff` (agents,
  nose pointers, ground, the two barrier walls and the food boxes — L18c), and
  **0 console errors/warnings**. Re-measured in L18c against the **built bundle** (`npm run build`,
  `python3 -m http.server` over `dist/`, Chrome's resolver pinned to the static server so nothing
  outside the bundle could be fetched): the only three requests are the page, its JS and its CSS,
  all same-origin; `RUN FILES 197` for `minitest_voff` and `223` for `microtest_voff` (one more than
  L18b in both — `run/stats/stat.1`), `errors: []`, and the whole pause/step/speed/new-run sequence
  reproduces.
* The status panel shows the world, not vibes: scenario, extent, agents/capacity, `Vision`, the
  run budget, that the world data is the **model**, how many files the run has written, how many
  worldfile keys are still blocked, and — since L18c — what the scene draws (`SCENE OBJECTS`:
  `2 barriers · 0 bricks (no BrickPatches) · 10 food` for `minitest_voff`,
  `0/2 barriers · 100 bricks · 0 food` for the `bricks_voff` demo world, whose two `dyn` barriers
  are still degenerate at boot and whose food patches start off).

## Verification (L20, on this machine, 2026-09-28)

L20 is the demo card: the *served* page, in a real browser, running the real model — and the run tree
that **page** wrote, diffed against the golden. Everything below is measured; the driver is
`verify/demoEvidence.mjs` (Chrome on `--remote-debugging-port`, no other dependency).

* **The served page runs the model** (`npm run dev`, then the driver against the dev URL; after
  boot: `flavour: 'model'`, `seed 42`, `blockedKeys: []`):
  - status panel reads `MINITEST_VOFF · MODEL`, `WORLD DATA model`, `RUN FILES 269 · 1.6 MB`,
    `STEP 49`, `FPS 60`, `STEPS/S 30.0`, `DRAW CALLS 7`, `TRIANGLES 358`;
  - controls, on the live run: pause froze the counter (`50 → 50` over 0.9 s), `Step` advanced
    exactly one (`51`), the `8×` button set the multiplier (`speedAfterClick 8`), play advanced
    (`51 → 209`);
  - screenshot: agents drawn from the model's own roster and body colour — 25 agents in
    `minitest_voff` (`hello` renders ~180–254 in its `100 × 100` world at `2.7k` triangles), two
    food-patch strips at their real rectangles, WebGL 2.0 (`OpenGL ES 3.0 Chromium`), **0 console
    errors/warnings** on both scenarios.
* **First-load budget.** Dev: 215 requests, every one same-origin — vite serves one module per
  request, and *nothing* compiles in the page (the transform is the server's). Production
  (`npm run build` + a static server over `dist/`): **4 requests** — document, `index-*.js`
  (1.04 MB), `index-*.css`, `favicon.svg` — all same-origin, and the page still boots the model.
  Zero off-origin requests and zero `.wasm`/`compiler`/`emscripten`/`pyodide`/CDN requests in both.
* **The page's own tree, diffed with `tools/check_parity.py`.** The page exposes what it wrote
  (`__polyworld.runTreeManifest()`, `runTreeFile(path, from, length)`, `runTreeFiles(paths)` — see
  PORT-NOTE (L18/run-tree-export)); the driver runs to the run's own end, `dispose()`s (native's end
  phase is the destructor, PORT-NOTE (L18/end-phase-is-the-destructor)), dumps the tree to disk and
  hands it to `./oracle/run_parity.sh <scenario> --candidate <dir>`:

  ```
  microtest_voff  exported 224 files /   431 kB -> PASS (225/225 files)  differing=0 missing=0
                                                 150 .gz payloads identical, containers identical
  minitest_voff   exported 1368 files / 10.1 MB -> PASS (1369/1369 files) differing=0 missing=0
                                                 1167 .gz payloads identical, containers identical
  hello           exported 18 files /   1.14 MB -> PASS (19/19 files)     differing=0 missing=0
  ```

  Each exported tree is also `diff -r` identical to the node-side tree the lane's tests write, so
  "the browser run's artifacts byte-match the oracle" holds for the running page itself and not only
  for the shared code path. `hello` was added to the demo for exactly this reason: its worldfile
  pins one key, so the page had to prove it boots the *schema's* world too — for which
  `worldBoot.test.ts` carries a per-scenario `WORLD_SHAPE` table (measured, not assumed) and
  `runTree.hello.test.ts` asserts its tree as a whole (20 files, 18 written by the page).

Reproduce (port 5199 and 9444 are examples; the driver takes any URL, and `CDP_PORT` any debug port):

```
npm run dev -- --port 5199 &                       # or: npm run build && python3 -m http.server 5301 -d dist
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=9444 --remote-allow-origins='*' --user-data-dir=$(mktemp -d) \
  --no-first-run --enable-unsafe-swiftshader --window-size=1280,800 about:blank &
CDP_PORT=9444 node src/browser/verify/demoEvidence.mjs "http://localhost:5199/?scenario=hello" \
  --export /tmp/page-tree-hello --screenshot /tmp/hello.png --json /tmp/hello.json
./oracle/run_parity.sh hello --candidate /tmp/page-tree-hello
```

The driver's JSON report carries the request list, the control measurements, the render counters
(draw calls, triangles, GL version) and every exported path, so a reviewer can check the claims
without re-running the browser.
