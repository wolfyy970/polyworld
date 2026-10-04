# src/model/genome

Lane L5 — `library/genome/**` (gene layout, gene groups, mutation, recombination, seeding)

Only the owning lane writes files here. Oracle: `run/genome/**` byte-compare on
`microtest_voff` and `minitest_voff` (`./oracle/run_parity.sh <scenario> --candidate <dir>`;
`tests/genome.test.ts` writes the candidate tree). RNG comes from the injected
`RngSurface` (`src/model/types/rng.ts`, implemented by lane W1d in `src/model/rng/**`) —
never `Math.random`. Expectations are `main`-branch: read `PARITY.md` → PORT-NOTEs (L5 genome)
and Gaps before changing anything.
