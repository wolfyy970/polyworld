# src/browser

Lane L18 — browser front end (Vite + Three.js): the worldfile boot, the shell that renders it, and
lane L11's simulation stepped **in the page**. Built on lane W1g's shell.

Acceptance for the lane: `./oracle/run_parity.sh <scenario> --candidate <tree>` reports
`differing=0` and `missing=0` for every artifact the run writes (`microtest_voff` 224/225,
`minitest_voff` 1368/1369, `hello` 18/19 — `ignored=1` is the Tier-C movie, which stays free at
every tier; the verdict lines read `PASS (225/225)`, `PASS (1369/1369)`, `PASS (19/19)`), the same
numbers hold for a tree exported **out of the running page** (`verify/demoEvidence.mjs` → the
`__polyworld.runTree*` readers), `npm run build` and `npm run typecheck` are clean, and the dev
server boots in a real browser with zero console errors — see `README.md` → Verification.

Only the owning lane writes files here. `oracle/**` is read-only (the boot reads the recorded
sources and the tests compare against them; nothing under `oracle/` is ever written).

Files added by this lane (beyond W1g's shell): `sim/{scenarios,worldBoot,worldParams,simSeam,`
`modelWorld,browserFiles,bundledWorlds,bundledMonitors,nodeSources,runTreeSuite}.ts` + their tests
(`runTree.{microtest_voff,minitest_voff,hello}.test.ts`), `worldfiles/**`, `monitors/**`,
`verify/{headless,demoEvidence}.mjs`, `env.d.ts`. W1g's `sim/placeholderWorld.ts` and this lane's own
`sim/previewWorld.ts` are both deleted: the world is `sim/modelWorld.ts` (lane L11's `TSimulation`
over `sim/browserFiles.ts`, with lane L14's `MonitorManager` on `stepEnding`), driven by the
worldfile's own document and writing the run's own tree.
