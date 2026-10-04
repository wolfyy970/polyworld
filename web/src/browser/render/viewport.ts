/**
 * Lane W1g — WebGL viewport (renderer + sizing).
 *
 * Keep this the only place that knows about the canvas. Everything else talks in
 * three.js objects, which is what makes swapping the shell's renderer (e.g. for lane L16's
 * vision path) a local change.
 *
 * PORT-NOTE (W1g/perf): pixel ratio is clamped to 2 and the canvas is sized from
 * `clientWidth/clientHeight` via ResizeObserver rather than a window `resize` listener, so
 * the page keeps working when embedded in a panel of a different size later.
 */

import * as THREE from 'three';
import { SCENE_CLEAR } from '../scene/palette';

export interface Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  /** CSS pixels of the drawing surface. */
  width(): number;
  height(): number;
  devicePixelRatio(): number;
  dispose(): void;
}

export interface ViewportStats {
  drawCalls: number;
  triangles: number;
}

export function createViewport(mount: HTMLElement): Viewport {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Polyworld scene');
  mount.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    // PORT-NOTE (L18d/antialias): native's offscreen GL surface draws with no multisampling, so its
    // edges are hard; the browser keeps WebGL's MSAA on. This is a display-quality choice, not a
    // scene difference — objects, placement, colours and framing are identical either way (see
    // `docs/media/visual-parity-minitest_voff.png`), and the browser's softer edges are the only
    // visible residue.
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    // The scene is a single flat-shaded frame; nothing needs to survive a context loss
    // beyond a reload, so we let the browser reclaim it (and report it, see app.ts).
    preserveDrawingBuffer: false,
  });

  // Off-screen-only scenes (screenshots, hidden tags) and hidpi laptops both report odd
  // values here; clamping keeps the fragment cost predictable.
  const clampPixelRatio = (): number => {
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    return Math.min(Math.max(dpr, 1), 2);
  };

  renderer.setPixelRatio(clampPixelRatio());
  // PORT-NOTE (L18d/raw-colour-output): native writes `glColor3f` values straight to the
  // framebuffer — `GroundColor {0.1, 0.15, 0.05}` lands as bytes `(25, 38, 13)`, no sRGB
  // round-trip. three.js normally treats colours as sRGB (converting in and out), which would
  // brighten every one of them. Colour management is therefore off and the output colour space is
  // the linear working space, so a `0.1/0.15/0.05` material renders as the same bytes native
  // writes.
  THREE.ColorManagement.enabled = false;
  renderer.setClearColor(SCENE_CLEAR, 1);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  // Flat retro look: no filmic curve, no shadows.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = false;

  let cssWidth = 1;
  let cssHeight = 1;

  const applySize = (): void => {
    const rect = mount.getBoundingClientRect();
    // A hidden mount measures 0; keep the last non-zero size so the frame does not
    // degenerate into a 1x1 buffer while the tab (or panel) is hidden.
    const w = rect.width > 1 ? Math.floor(rect.width) : cssWidth;
    const h = rect.height > 1 ? Math.floor(rect.height) : cssHeight;
    if (w === cssWidth && h === cssHeight && renderer.getPixelRatio() === clampPixelRatio()) return;
    cssWidth = w;
    cssHeight = h;
    renderer.setPixelRatio(clampPixelRatio());
    renderer.setSize(w, h, false);
  };

  applySize();

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(applySize);
  observer?.observe(mount);
  if (!observer) window.addEventListener('resize', applySize);

  return {
    renderer,
    canvas,
    width: () => cssWidth,
    height: () => cssHeight,
    devicePixelRatio: () => renderer.getPixelRatio(),
    dispose(): void {
      observer?.disconnect();
      if (!observer) window.removeEventListener('resize', applySize);
      renderer.dispose();
      canvas.remove();
    },
  };
}

export function readViewportStats(viewport: Viewport): ViewportStats {
  const info = viewport.renderer.info;
  return {
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
  };
}
