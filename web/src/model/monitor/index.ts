/**
 * Lane L14 (monitor) — the lane's public entry point.
 *
 * `library/monitor/**` ported as **pure data**: camera controllers, agent trackers and monitor
 * selection, with no UI, no window manager and no file system of its own. What native gets from
 * the outside arrives as an injected seam, and every seam is named after the native call it
 * replaces:
 *
 * ```
 *   MonitorManager        monitor selection from the two monitor documents       MonitorManager.cc
 *   Monitor + 9 monitors  the observers, stepped from Simulation::stepEnding     Monitor.cc
 *   AgentTracker          which agent a monitor is about                         AgentTracker.cc
 *   CameraController      where the scene camera is, per mode                    CameraController.cc
 *   MovieSettings         which steps a scene is recorded at (frozen schedule)   MovieController.h
 *   SceneMovieController  connect/disconnect the recorder around the render      MovieController.cc
 *   SceneRenderer seam    renderer + movie writer + status-text store            SceneRenderer.h/cc
 * ```
 *
 * The lane's observable contract is `run/stats/stat.<timestep>` (frozen, `run/**`) and the movie
 * frame *schedule*; both are pinned against the recorded goldens in `tests/monitor.test.ts`, and
 * the arithmetic is pinned against the linked native library by
 * `native/monitorprobe.{cpp,sh}` → `native/vectors/*.json`. See `PARITY.md` for the lane's row,
 * its PORT-NOTEs, the four deliberate deviations and the gaps this lane leaves open.
 */

export * from './signal';
export * from './simSurface';
export * from './monitor';
export * from './charts';
export * from './agentTracker';
export * from './cameraController';
export * from './movieWriter';
export * from './movieController';
export * from './sceneRenderer';
export * from './sceneMonitor';
export * from './statusTextMonitor';
export * from './farmMonitor';
export * from './brainMonitor';
export * from './monitorManager';
export * from './monitorDocument';
