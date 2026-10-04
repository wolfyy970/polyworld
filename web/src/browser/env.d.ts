/// <reference types="vite/client" />
/**
 * Lane L18 (browser wiring) — build-time types.
 *
 * `vite/client` declares the asset-import modules the browser bundle uses
 * (`*?raw`, `*.css`, …). The project's tsconfig sets `types: ["node"]`, so the reference is
 * explicit here rather than global.
 */
