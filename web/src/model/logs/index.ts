/**
 * Lane L12 (logs) — `src/library/logs/**` ported to TypeScript.
 *
 *   seams.ts        the lane boundary: every collaborator the recorders read (agent, sim,
 *                   brain, genome, food, energy, the sorted object list) plus the file-system
 *                   and `LogContext` seams
 *   agentSlots.ts   native `AgentAttachedData` (per-agent recorder state)
 *   registry.ts     native `Logs`' statics: install / register / postEvent / getMaxOpenFiles
 *   logger.ts       `Logger`, `FileLogger`, `AbstractFileLogger`, `DataLibLogger`
 *   formatSink.ts   the `TextSink` that formats native's `fprintf( f, format, … )` shape (`%g`
 *                   included) over any backend sink, pre-formatted lines written verbatim
 *   logs.ts         `Logs`: the 23 recorders, their construction order, `init` walk, `dispose`
 *   agentLogs.ts    AgentEnergy, AgentMaxEnergy, AgentPosition, BirthsDeaths, LifeSpan, Population
 *   eventLogs.ts    Carry, Collision, Contact, Energy, FoodConsumption, FoodEnergy
 *   brainLogs.ts    BrainAnatomy, BrainFunction, BrainComplexity, Synapse
 *   genomeLogs.ts   GeneStats, Genome, GenomeMeta, GenomeSubset, Separation
 *   simLogs.ts      AdamiComplexity, GitRevision
 *   nodeFiles.ts    the **node-only** file seam (`node:fs`/`node:zlib`/`child_process`) —
 *                   deliberately *not* exported here, so the browser bundle can import the
 *                   recorders (same rule as W1c's `datalib/nodeFile.ts`)
 *
 * The sim lane wires a run like this:
 *
 *   const env: LogContext = { fs: nodeRecordFileSystem(globals.recordFileType), world,
 *                             genomeUtil, foodTypes, computeAdamiComplexity };
 *   const logs = new Logs(sim, createConfig(document), env);
 *   ...
 *   logs.postEvent(stepEndEvent);
 *   logs.dispose();
 *
 * The recorders decide *which* bytes are written (paths, table schemas, formats, per-agent
 * file lifecycle); the values come from the collaborating lanes through `seams.ts`.
 */

export * from './seams';
export * from './agentSlots';
export * from './registry';
export * from './logger';
export * from './logs';
export * from './agentLogs';
export * from './eventLogs';
export * from './brainLogs';
export * from './genomeLogs';
export * from './simLogs';
