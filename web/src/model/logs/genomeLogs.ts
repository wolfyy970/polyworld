/**
 * Lane L12 (logs) — the genome recorders (`logs/Logs.cc`):
 *
 *   Logs::GeneStatsLog        run/genome/genestats.txt   (plain text: `%d` header + `%.1f,%.1f` per gene per step)
 *   Logs::GenomeLog           run/genome/agents/genome_<agent>.txt[.gz]
 *   Logs::GenomeMetaLog       run/genome/meta/*.txt       (5 files, incl. the `sort -n` pass)
 *   Logs::GenomeSubsetLog     run/genome/subset.log       (one column per named gene)
 *   Logs::SeparationLog       run/genome/separations.txt  (multi-table: one table per dying agent)
 *
 * The genome *content* is lane L5's (`Genome::dump`, `get_raw_uint`, `Genome::separation`,
 * the `meta/*` renderers and `SeparationCache`); this lane owns the paths, the triggers, the
 * `BR_VIRTUAL` skips, the `%d`/`%.1f` formatting and the multi-table write.
 *
 * PORT-NOTE(l12/genome-barrel-import): the recorders read `GenomeUtil::schema`
 * (`genomeUtil`), the five `meta/*` renderers and the `SeparationCache` singleton straight
 * from lane L5's barrel (`src/model/genome`), because native's loggers call those same
 * functions (`GenomeUtil::schema->printIndexes( f )`, `SeparationCache::getEntries( a )`).
 * A structural copy of the gene-schema printers here would be a second implementation of a
 * file format that is L5's contract.
 *
 * PORT-NOTE(l12/genestats-float-format): `genestats.txt` prints `" %.1f,%.1f"` per mutable
 * gene. `mean[]`/`stddev[]` are native `float *`, so the promoted double is the f32 value:
 * the port rounds with `Math.fround` *before* formatting, then uses W1c's exact-decimal `%f`
 * (`formatFixed`) rather than `toFixed`, which resolves ties the other way.
 */

import {
  BirthReason,
  ColumnType,
  nativeString,
  Event_AgentBirth, Event_AgentDeath, Event_ContactBegin, Event_SimInited, Event_StepEnd, GObjectType } from '../types';
import type { AgentBirthEvent, AgentDeathEvent, AgentContactBeginEvent, Config, SimEvent } from '../types';
import { formatFixed } from '../datalib';
import { renderGeneLayoutSorted, separationCache } from '../genome';
import { AbstractFileLogger, DataLibLogger, FileLogger, StateScope } from './logger';
import {
  forEachSorted,
  type LogAgent,
  type LogContext,
  type LogGeneSchema,
  type LogSimulation,
  type TextOutput,
} from './seams';

/** Native `Logs::GeneStatsLog`. */
export class GeneStatsLog extends FileLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordGeneStats')) {
      this.initRecording(sim, StateScope.SIMULATION, Event_StepEnd);

      sim.geneStats().init(sim.maxAgents());

      const file = this.createFile('run/genome/genestats.txt');

      // Native: `fprintf( f, "%d\n", GenomeUtil::schema->getMutableSize() )`.
      file.printf(`${this.schema().getMutableSize()}\n`);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_StepEnd: {
        const mean = this.simulation().geneStats().getMean();
        const stddev = this.simulation().geneStats().getStddev();
        const ngenes = this.schema().getMutableSize();

        const file = this.getFile();

        file.printf(`${this.getStep()}`);
        for (let i = 0; i < ngenes; i++) {
          file.printf(` ${formatFixed(Math.fround(mean[i]!), 1)},${formatFixed(Math.fround(stddev[i]!), 1)}`);
        }
        file.printf('\n');
        return;
      }
      default:
        return super.processEvent(event);
    }
  }

  private schema(): LogGeneSchema {
    const schema = this.env.genomeUtil.schema;
    if (!schema) throw new Error('logs: GeneStatsLog before GenomeUtil::createSchema');
    return schema;
  }
}

/** Native `Logs::GenomeLog` — an `AbstractFileLogger`: the genome is gzipped under `CompressFiles`. */
export class GenomeLog extends AbstractFileLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordGenomes')) {
      this.initRecording(sim, StateScope.NULL, Event_AgentBirth);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_AgentBirth: {
        const birth = event as AgentBirthEvent<LogAgent>;
        // Native: `if( birth.reason != LifeSpan::BR_VIRTUAL ) { … }`.
        if (birth.reason === BirthReason.VIRTUAL) return;

        const path = `run/genome/agents/genome_${birth.a!.number()}.txt`;
        const out = this.createFile(path);
        birth.a!.genes().dump(out);
        out.close(); // native `delete out`
        return;
      }
      default:
        return super.processEvent(event);
    }
  }
}

/**
 * Native `Logs::GenomeMetaLog` — note it has **no worldfile guard**: `init` registers for
 * `SimInited` unconditionally and the five files are written on that event. The five
 * renderers are L5's (`renderGenomeMeta`); the last one is the `SYSTEM( "cat … | sort -n" )`
 * pass, which the port runs in-process (same bytes, no shell, works in a browser).
 */
export class GenomeMetaLog extends FileLogger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, _doc: Config): void {
    this.initRecording(sim, StateScope.NULL, Event_SimInited);
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_SimInited:
        return this.writeMetaFiles();
      default:
        return super.processEvent(event);
    }
  }

  private writeMetaFiles(): void {
    const schema = this.env.genomeUtil.schema;
    if (!schema) throw new Error('logs: GenomeMetaLog before GenomeUtil::createSchema');
    const layout = this.env.genomeUtil.layout;

    // Native, file by file (each with its own `createFile`/`fclose` pair), in this order:
    //   geneindex.txt          schema->printIndexes( f )
    //   genelayout.txt         schema->printIndexes( f, layout )
    //   genelayout-sorted.txt  SYSTEM( "cat genelayout.txt | sort -n" )   <- rendered in-process
    //   genetitle.txt          schema->printTitles( f )
    //   generange.txt          schema->printRanges( f )
    const geneIndex = renderWith(schema, (out) => schema.printIndexes(out));
    const geneLayout = renderWith(schema, (out) => schema.printIndexes(out, layout));

    const files: [string, string][] = [
      ['run/genome/meta/geneindex.txt', geneIndex],
      ['run/genome/meta/genelayout.txt', geneLayout],
      ['run/genome/meta/genelayout-sorted.txt', renderGeneLayoutSorted(geneLayout)],
      ['run/genome/meta/genetitle.txt', renderWith(schema, (out) => schema.printTitles(out))],
      ['run/genome/meta/generange.txt', renderWith(schema, (out) => schema.printRanges(out))],
    ];

    for (const [path, text] of files) {
      const file = this.createFile(path);
      file.printf(text);
      file.close();
    }
  }
}

/** Native `Logs::GenomeSubsetLog`. */
export class GenomeSubsetLog extends DataLibLogger {
  private _geneIndexes: number[] = [];

  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    const subset = doc.at('GenomeSubsetLog');
    if (subset.getBool('Record')) {
      this.initRecording(sim, StateScope.SIMULATION, Event_AgentBirth);

      const geneNames = subset.getArray('GeneNames').map((node) => nativeString(node.scalarText()));

      const schema = this.env.genomeUtil.schema;
      if (!schema) throw new Error('logs: GenomeSubsetLog before GenomeUtil::createSchema');

      this._geneIndexes = schema.getIndexes(geneNames);
      for (let i = 0; i < geneNames.length; i++) {
        if ((this._geneIndexes[i] ?? -1) < 0) {
          // Native: `cerr << "Invalid gene name for GenomeSubsetLog: " << name << endl; exit( 1 );`
          throw new Error(`Invalid gene name for GenomeSubsetLog: ${geneNames[i]}`);
        }
      }

      const columns = [{ name: 'Agent', type: ColumnType.INT }];
      for (const name of geneNames) columns.push({ name, type: ColumnType.INT });

      const writer = this.createWriter('run/genome/subset.log');
      writer.beginTable('GenomeSubset', columns);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_AgentBirth: {
        const birth = event as AgentBirthEvent<LogAgent>;
        if (birth.reason === BirthReason.VIRTUAL) return;

        const a = birth.a!;
        const values: number[] = [a.number()];
        for (const index of this._geneIndexes) values.push(a.genes().getRawUint(index));

        this.getWriter().addRow(values);
        return;
      }
      default:
        return super.processEvent(event);
    }
  }
}

/** Native `Logs::SeparationLog::Mode`. */
export const SeparationMode = {
  CONTACT: 0,
  ALL: 1,
} as const;

export type SeparationMode = (typeof SeparationMode)[keyof typeof SeparationMode];

/**
 * Native `Logs::SeparationLog` — a **multi-table** datalib file (`singleSchema = false`):
 * one table per agent that dies with cached separations, named by the agent's number.
 *
 * PORT-NOTE(l12/separation-table-name): the table name is `sprintf( buf, "%ld", agent
 * number )` into a 16-byte buffer, so a table name is the decimal agent number — which is
 * why the golden's tables read `#<23>`, `#<13>`, … in *death* order.
 */
export class SeparationLog extends DataLibLogger {
  private _mode: SeparationMode | null = null;
  private readonly _births: LogAgent[] = [];

  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getString('RecordSeparations') !== 'False') {
      const mode = doc.getString('RecordSeparations');
      if (mode === 'Contact') {
        this._mode = SeparationMode.CONTACT;
        this.initRecording(sim, StateScope.SIMULATION, Event_AgentDeath | Event_ContactBegin);
      } else if (mode === 'All') {
        this._mode = SeparationMode.ALL;
        this.initRecording(sim, StateScope.SIMULATION, Event_AgentDeath | Event_AgentBirth | Event_StepEnd);
      } else {
        throw new Error(`logs: unknown RecordSeparations mode '${mode}' (native asserts)`);
      }

      this.createWriter('run/genome/separations.txt', false, false);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_AgentBirth:
        return this.onBirth(event as AgentBirthEvent<LogAgent>);
      case Event_ContactBegin:
        return this.onContactBegin(event as AgentContactBeginEvent<LogAgent>);
      case Event_AgentDeath:
        return this.onDeath(event as AgentDeathEvent<LogAgent>);
      case Event_StepEnd:
        return this.onStepEnd();
      default:
        return super.processEvent(event);
    }
  }

  /** Native `processEvent( const AgentBirthEvent & )`. */
  private onBirth(e: AgentBirthEvent<LogAgent>): void {
    if (e.reason === BirthReason.VIRTUAL) return;

    if (this._mode !== SeparationMode.ALL) {
      throw new Error('logs: SeparationLog birth event outside `All` mode (native asserts)');
    }

    this._births.push(e.a!);
  }

  /** Native `processEvent( const AgentContactBeginEvent & )`. */
  private onContactBegin(e: AgentContactBeginEvent<LogAgent>): void {
    if (this._mode !== SeparationMode.CONTACT) {
      throw new Error('logs: SeparationLog contact event outside `Contact` mode (native asserts)');
    }

    separationCache.createEntry(e.c.a, e.d.a);
  }

  /** Native `processEvent( const AgentDeathEvent & )`. */
  private onDeath(death: AgentDeathEvent<LogAgent>): void {
    const entries = separationCache.getEntries(death.a);

    if (entries.size > 0) {
      const name = `${death.a.number()}`;

      const writer = this.getWriter();

      writer.beginTable(name, [
        { name: 'Agent', type: ColumnType.INT },
        { name: 'Separation', type: ColumnType.FLOAT },
      ]);

      // Native iterates a `std::map< long, float >`, so the rows are ordered by the other
      // agent's number — not by when the pair was cached. The port sorts explicitly instead
      // of relying on insertion order, which is what L5's `Map`-backed cache has.
      const ordered = [...entries.entries()].sort((a, b) => a[0] - b[0]);
      for (const [otherNumber, separation] of ordered) writer.addRow([otherNumber, separation]);

      writer.endTable();
    }
  }

  /** Native `processEvent( const StepEndEvent & )` — seed the cache for each new agent. */
  private onStepEnd(): void {
    if (this._mode !== SeparationMode.ALL) {
      throw new Error('logs: SeparationLog step-end event outside `All` mode (native asserts)');
    }

    if (this._births.length > 0) {
      for (const aBorn of this._births) {
        forEachSorted(this.env.world, GObjectType.AGENT, (obj) => {
          const aOther = obj as LogAgent;
          if (aBorn !== aOther) separationCache.createEntry(aBorn, aOther);
        });
      }

      this._births.length = 0;
    }
  }
}

/** Native `FILE *` for the genome printers. */
class StringSink implements TextOutput {
  private text = '';

  write(chunk: string): void {
    this.text += chunk;
  }

  toString(): string {
    return this.text;
  }
}

/** Run one `GeneSchema::print*` into a string (the printers stream into a `FILE *`). */
function renderWith(schema: LogGeneSchema, print: (out: TextOutput) => void): string {
  const sink = new StringSink();
  print(sink);
  return sink.toString();
}
