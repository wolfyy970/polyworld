# src/model/logs

Lane L12 — `library/logs/**`: the recorders, on top of W1c's datalib writer.

Only the owning lane writes files here.

## What is in here

| File | Contents |
|---|---|
| `seams.ts` | the lane boundary: every collaborator a recorder reads (`LogAgent`, `LogSimulation`, `LogBrain`, `LogGenome`, `LogEnergy`, `LogFoodType`, `LogSortedObjectList`, `LogGeneStats`, `LogFittestList`, `LogGeneSchema`), the `RecordFileSystem`/`TextSink` file seam and the per-run `LogContext` |
| `agentSlots.ts` | native `AgentAttachedData` (`createSlot`/`alloc`/`dispose`/`get`/`set`) as a store seam with a `Map`-backed default |
| `registry.ts` | native `Logs`' statics: `installLogger`, `registerEvents`, `postEvent`, `getMaxOpenFiles`, plus test resets |
| `logger.ts` | `Logger` + `FileLogger` / `AbstractFileLogger` / `DataLibLogger` and the three state scopes |
| `formatSink.ts` | the `TextSink` that really formats: native's second `fprintf` shape (format + values, applied with L6's `sprintfC`) on top of any backend sink, with a value-less call written verbatim (`l12/text-sink-format`) |
| `logs.ts` | `Logs`: the 23 recorders in `Logs.h` declaration order, the `init` walk, `postEvent`, `dispose` (reverse-order close), the `logs` singleton |
| `agentLogs.ts` | `AgentEnergyLog`, `AgentMaxEnergyLog`, `AgentPositionLog`, `BirthsDeathsLog`, `LifeSpanLog`, `PopulationLog` |
| `eventLogs.ts` | `CarryLog`, `CollisionLog`, `ContactLog` (the MATE/FIGHT/GIVE encoder), `EnergyLog`, `FoodConsumptionLog`, `FoodEnergyLog` |
| `brainLogs.ts` | `BrainAnatomyLog`, `BrainFunctionLog` (rename + link trees), `BrainComplexityLog`, `SynapseLog` |
| `genomeLogs.ts` | `GeneStatsLog`, `GenomeLog`, `GenomeMetaLog`, `GenomeSubsetLog`, `SeparationLog` |
| `simLogs.ts` | `AdamiComplexityLog` (lane L13's computation), `GitRevisionLog` |
| `nodeFiles.ts` | the **node-only** file seam: `node:fs`/`node:zlib` + `child_process` for `SYSTEM`. Deliberately *not* re-exported by `index.ts`, so the browser bundle can import the recorders (same rule as W1c's `datalib/nodeFile.ts`) |
| `index.ts` | the lane's public surface — import the recorders and seams from here |

Tests: `tests/logs-replay.test.ts` (13 — the byte-exact golden replay, both scenarios),
`tests/logs.test.ts` (15 — registry/Logger semantics, the `run/brain/**` path set against the
recorded run, the recorders the recorded scenarios leave off, the contact-flag encoder),
`tests/logs-sink-shape.test.ts` (4 — a recorder's sink accepts both native `fprintf` shapes).
Helpers: `tests/logsReplay.ts` (golden reader + the collaborating lanes as fakes),
`tests/logsCorpus.ts` (the reconstruction and the step-localized byte comparison).

Wiring a run (lane L11's job — see `index.ts`):

```ts
const env: LogContext = {
  fs: nodeRecordFileSystem(globals.recordFileType),   // browser: a Blob/CompressionStream sink
  world: gXSortedObjects,                             // native's global sorted object list
  genomeUtil,                                         // lane L5's singleton
  foodTypes,                                          // lane L10's FoodType table
  computeAdamiComplexity,                             // lane L13
};
const logs = new Logs(sim, createConfig(document), env);
logs.postEvent(stepEndEvent);
logs.dispose();
```
