/**
 * TEMP probe (lane L11, this run only): print the x-sorted list's order **at boot**, i.e. the order
 * the step-1 body pass walks (`Interact()` is what re-sorts, and it runs after the body pass).
 * Deleted again at the end of this run.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Config, GObjectType } from '../../types';
import { emitNormalizedWorldfile } from '../../proplib';
import { nodeRecordFileSystem } from '../../logs/nodeFiles';
import { ConcreteFileType } from '../../types';
import { Simulation } from '../simulation';
import { Agent } from '../../agent';
import { scenarioParameters } from '../runner';
import { assertUsableStagingRoot } from '../../../oracle/guard';

const AGENTTYPE = GObjectType.AGENT;

function main(argv: readonly string[]): void {
  const scenario = argv[0] ?? 'microtest_voff';
  const repoRoot = process.cwd();
  const outDir = resolve(argv[1] ?? join(repoRoot, '.candidate', 'bootorderprobe'));
  // t_37bf7212: a probe's output tree stages outside the oracle (it writes `run/**` here).
  assertUsableStagingRoot(outDir, 'bootorderprobe outDir');
  const recorded = join(repoRoot, 'oracle', scenario, 'run');
  const worldfilePath = 'worldfiles/tests/low-spec-pc/' + `${scenario.split('_')[0]}.wf`;
  const schemaPath = './etc/worldfile.wfs';

  const built = emitNormalizedWorldfile(
    (path: string) => {
      if (path === worldfilePath) return readFileSync(join(recorded, 'original.wf'), 'utf8');
      if (path === schemaPath) return readFileSync(join(recorded, 'original.wfs'), 'utf8');
      throw new Error(`bootorderprobe: no source text for '${path}'`);
    },
    {
      worldfilePath,
      schemaPath,
      parameters: scenarioParameters(repoRoot, scenario),
      validate: false,
    },
  );

  const doc = new Config(built.worldfileDocument);
  mkdirSync(outDir, { recursive: true });
  process.chdir(outDir);
  const sim = new Simulation({
    doc,
    worldfilePath,
    schemaPath,
    convertedWorldfileText: built.converted,
    normalizedWorldfileText: built.normalized,
    originalWorldfileText: readFileSync(join(recorded, 'original.wf'), 'utf8'),
    originalSchemaText: readFileSync(join(recorded, 'original.wfs'), 'utf8'),
    fs: nodeRecordFileSystem(
      doc.getBool('CompressFiles') ? ConcreteFileType.TYPE_GZIP_FILE : ConcreteFileType.TYPE_FILE,
    ),
    keepRunDirectory: true,
  });

  const list = sim.objects();
  list.reset();
  const agents: Agent[] = [];
  for (;;) {
    const a = list.nextObj(AGENTTYPE) as Agent | null;
    if (a === null) break;
    agents.push(a);
  }
  process.stdout.write(`bootorderprobe: ${scenario} at boot, ${agents.length} agents\n`);
  for (const a of agents) {
    process.stdout.write(
      `  #${a.number()} x=${a.x()} z=${a.z()} radius=${a.radius()} key=${a.x() - a.radius()} ` +
        `lastX=${a.lastX()} lastZ=${a.lastZ()}\n`,
    );
  }
}

main(process.argv.slice(2));
