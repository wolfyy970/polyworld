# src/model/agent

Lane L8 — agent core: energy, lifespan, movement/steering, eat/mate/carry, collisions,
carrying (`src/library/agent/agent.cc`, `LifeSpan.*`, `Metabolism.*`, `*Sensor.cc`).

Only the owning lane writes files here.

- `agent.ts`        `class Agent` — the step (`UpdateBody`), eating, mating, damage, carries.
- `agentConfig.ts`  `agent::config` + `agent::processWorldfile` + the class statics.
- `energy.ts`       native `environment/Energy.{h,cc}`; held here until lane L10 lands (see
                    PARITY.md → Gaps and the `L8/energy-home` PORT-NOTE — this must stay the
                    *single* definition of the energy vector).
- `lifeSpan.ts`, `metabolism.ts`, `sensors.ts`, `numeric.ts`, `nervousSystem.ts`.
- `contracts.ts`    the lane boundary (genome, brain, environment, graphics, simulation).
- `native/`         the probe that generates the lane's differential vectors from the real
                    C++ build, plus the committed vectors `tests/agent.test.ts` replays.
- `index.ts`        the lane's public surface.

Verify: `npx vitest run tests/agent.test.ts` (needs no native tree — the vectors are
committed) and, to regenerate the vectors, `src/model/agent/native/agentprobe.sh all`.
