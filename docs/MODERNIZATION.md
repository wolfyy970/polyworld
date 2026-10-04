# Modernization notes (Qt 6 / macOS arm64 / C++17)

This tree is the 2019-era Polyworld source brought forward to build and run on
current macOS (Apple Silicon, Xcode clang 21, Qt 6, Homebrew). The work is an
**in-place modernization**: same language, same architecture, same behavior —
only the platform layer changed. Nothing was rewritten for style, and no
feature was dropped or stubbed.

## Frozen surface

What must behave as before:

- The simulation itself: worldfile parsing/normalization, the property-language
  evaluation, agent brains, genetics, logging, and the on-disk output formats
  (`run/` recordings, `lifespans.txt`, `BirthsDeaths.log`, genome metadata,
  `.pmv` movies).
- The command-line interface (`Polyworld [--ui gui|term] [--key value]... worldfile`),
  the other binaries (`PwMoviePlayer`, `proputil`, `pmvutil`, `nullevo`,
  `passive`, `neurons`, `expansion`, `bifurcation`, `timeseries`, `rancalc`,
  `qt_clust`), and the `./configure` → `make` build workflow.
- The renderer's *output*, not its mechanism: the scene and agent-POV views are
  still rendered off-screen and blitted into the monitor windows.

Free to change: Qt API usage, build flags, dependency discovery, internal types.

## Platform changes

| Area | Before | Now |
|---|---|---|
| `configure` | Python 2 (`print` statements) | Python 3; discovers Homebrew prefix, Qt 6 `qmake`, GSL (`gsl-config`), `libomp` |
| Qt | 5.x (`QGLWidget`, `QGLPixelBuffer`, `QDesktopWidget`, `QGLFormat`, `renderText`) | 6.x (`QOpenGLWidget`, `QOpenGLFramebufferObject`, `QScreen`, `QOpenGLContext`, `QPainter`) |
| OpenGL | legacy API via `QGLWidget` | same legacy API, explicitly requested compatibility-profile context |
| Compiler flags | `-std=c++11`, hardcoded `/usr/local`, hardcoded Xcode SDK path | `-std=c++17`, Homebrew prefix, SDK located with `xcrun --show-sdk-path` |
| OpenMP | `-fopenmp` (never worked with Apple clang → silently disabled) | `-Xpreprocessor -fopenmp` + Homebrew `libomp`, probe passes |
| GSL | `-L/usr/local/lib` (Intel Homebrew) | prefix from `gsl-config` |
| Runtime Python | spawned `python` (Python 2) | spawns `python3` (falls back to `python`) |

### Qt 5 → Qt 6 mappings used

- `QGLWidget` → `QOpenGLWidget` (monitor views, movie-player GL widget).
  QOpenGLWidget may only be drawn from `paintGL()`, so the views that used to
  paint immediately from a signal (`SceneMonitorView`, `PovMonitorView`,
  `ChartMonitorView`, `BrainMonitorView`, `StatusTextMonitorView`) now mark
  themselves dirty (`update()`) and draw in `paintGL()`. `makeCurrent()`,
  `swapBuffers()` and `setAutoBufferSwap()` have no Qt 6 equivalents and are
  gone; `QGLWidget::renderText()` and `qglClearColor()` are replaced by
  `QPainter` and `glClearColor()`.
- `QGLPixelBuffer` (removed in Qt 6) → `PwOffscreenGLSurface`
  (`src/qtrenderer/renderer/qt/PwOffscreenGLSurface.{h,cc}`): a
  `QOffscreenSurface` plus `QOpenGLFramebufferObject`, exposing the
  `makeCurrent()`/`doneCurrent()`/`size()`/`toImage()` subset the renderers
  used. Scene rendering, agent-POV rendering (agent vision) and movie recording
  all continue through this class.
- `QGLFormat::hasOpenGL()` → creating a `QOpenGLContext` and checking success.
- `QDesktopWidget` / `QApplication::desktop()` → `QGuiApplication::primaryScreen()->geometry()`.
- `QMainWindow(0, 0)` / `MainWindow(..., 0, ...)` → `Qt::WindowFlags()`.
- Qt 6 no longer includes widgets transitively from other headers; missing
  includes (`<QWidget>`, `<QPainter>`, `<QImage>`, `<QScreen>`, `<QOpenGLWidget>`,
  `<QAction>`) were added where the code used those types.

## Defects found while making it run (all pre-existing)

Each was reproduced, diagnosed from a crash report, fixed minimally, and
re-verified. None is a behavior change.

1. **End-of-run double free** (`Logs`/`TSimulation`).
   `TSimulation::Step()` re-triggers the end condition (`MaxSteps`) on the next
   timer tick, before the application processes the quit request, so
   `TSimulation::End()` ran twice and dispatched a second `SimEndEvent`; the
   brain-function log's cleanup deleted log files that its first pass had
   already deleted. macOS malloc made the double free fatal.
   *Fix:* `End()` is now idempotent (`fEnded` in `Simulation.h`), and the
   log's per-agent file slot is cleared when its file is deleted
   (`Logs::BrainFunctionLog`), so the cleanup is idempotent as well.
   *Evidence:* crash reports showed `BrainFunctionLog::processEvent(SimEndEvent)`
   → SIGSEGV; instrumented runs showed the handler iterating twice with
   identical file pointers, and `[END] call 2` with a backtrace through
   `TSimulation::Step()`.

2. **Terminal UI killed the run when stdin was not a terminal**
   (`termio::setEchoEnabled`). `SYSTEM()` is fatal on any failing command
   (`misc.h`: `if (rc != 0) ... exit(1)`), and `stty -echo` fails when stdin is
   a pipe or `/dev/null` — so a headless run exited with status 1 before the
   first step. *Fix:* skip `stty` when `!isatty(STDIN_FILENO)`, and guard the
   prompt thread's `fgets` against EOF.
   *Evidence:* every no-tty run printed "Failed executing command 'stty -echo'"
   and exited 1; with `stdout` on a pty (or with the fix) the same worldfile
   runs to completion.

## Verified behavior

Environment: Apple clang 21, macOS 26.5.2 (arm64), Qt 6.11.2, GSL 2.8, libomp 23.1.2.

- `./configure` → OpenMP supported: True; `make` → all targets build, zero errors.
- `./Polyworld --ui term worldfiles/tests/low-spec-pc/minitest.wf`
  (the project's own regression worldfile: 301 steps, `RecordAll True`):
  runs to completion, writes `run/endReason.txt` = `MaxSteps`, exit status 0,
  no crash report; produces ~1300 recording files (brain anatomy/function,
  energy, motion, genomes, events).
- `./Polyworld worldfiles/tests/low-spec-pc/minitest.wf` (GUI): runs the same
  worldfile to `MaxSteps`, exits 0.
- `./Polyworld --ui term worldfiles/hello.wf` (the example in the wiki install
  instructions): runs, exit status 0.
- Two identical `minitest.wf` runs produce byte-identical output: 1312 of 1313
  files match; the only differing file is the run-time-compiled
  `run/.cppprops/libcppprops.dylib`, whose source (`generated.cc`) is identical
  (shared libraries embed a build UUID).
- Every built tool (`proputil`, `pmvutil`, `rancheck`, `qt_clust`, `neurons`,
  `expansion`, `bifurcation`, `timeseries`, `nullevo`, `passive`,
  `PwMoviePlayer`) loads its libraries, initializes, and reaches its
  usage/argument handling; `rancheck` runs its random-number checks.
- The property language is exercised end-to-end: `run/normalized.wf` contains
  evaluated expressions (e.g. `SeedAgents InitAgents;`, `InitFood ( MinFood if
  MinFood > 0 else 90 )`), which require the Python expression interpreter
  (`src/library/proplib/interpreter.py`, now spawned as `python3`).
- The runtime C++-properties path is exercised: `run/.cppprops/` is compiled by
  clang at run time and loaded as a dylib.
- No crash reports are generated by any run after the fixes above (verified
  against `~/Library/Logs/DiagnosticReports/Polyworld-*.ips` timestamps vs. the
  fixed library's build time).

## Pace control (requested addition, not part of the port)

Faster machines run many more steps per second than the original hardware did.
The model is step-indexed — I checked: nothing in `Step()` reads a clock; the
only wall-clock uses in the library are file-locking retries, a run-directory
name, and a movie header timestamp — so there is no "correct" speed to restore.
What was missing was a way to *watch* a run, so:

- `StepsPerSecond` (Int, min 0, default **0 = unlimited**) is now a worldfile
  property, so it can also be overridden on the command line:
  `./Polyworld --StepsPerSecond 10 worldfiles/hello.wf`.
- `SimulationController::setStepsPerSecond()` realizes it as a `QTimer`
  interval (0 keeps the original "as fast as the event loop allows" behavior).
  It takes effect mid-run.
- GUI: a **Run → Speed** submenu with presets (Unlimited, 1000, 100, 30, 10, 1
  steps/s), kept in sync if the pace is changed elsewhere.
- Terminal UI: a `speed N` command (`speed 0` = unlimited).

The default is unchanged behavior. Verified that pacing cannot alter a run: the
301-step regression worldfile run uncapped (10.5 s wall) and capped at 20
steps/s (16.2 s wall) produced **byte-identical** genomes, brains, energy,
motion, lifespans, births/deaths and `movie.pmv`; the only differences anywhere
in the two output trees were the `StepsPerSecond` line echoed back in
`normalized.wf`/`converted.wf`, i.e. the input, not the result.

## What was *not* verified here

- **The old build is not an oracle.** The 2019 tree does not build on this
  machine (that was the job), so no run-by-run comparison against the original
  binaries exists. What stands in for it: the project's own regression
  worldfiles, the documented run commands, deterministic re-runs (identical
  seeds → identical outputs), and the absence of stubs.
- Rendering *appearance* was checked by the runs completing with the views
  active, not by pixel comparison against 2019 screenshots.
- `docs/`-only tools (`CalcComplexity.py` and friends in `scripts/`) were not
  run; `scripts/` is out of scope for the build.
