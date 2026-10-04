/**
 * Lane L11 (sim) — `contactprobe.ts`: a lane-local probe of the **contact pass** (`TSimulation::Interact`'s
 * agent-agent walk, `Simulation.cc:1561-1650`) as the run's first step sees it.
 *
 * Why it exists: `./oracle/run_parity.sh microtest_voff` reports the run's *last* divergence in
 * `run/events/contacts.log` — the golden records two contacts at step 1 (`15 2` and `2 5`) and the
 * candidate records **none** — while every other artifact of the step (positions, collisions,
 * brain anatomy/synapses/function, energy) is byte-exact. The contact test is therefore either a
 * radius or a walk-order difference; this probe prints both, so the two can be told apart without
 * guessing.
 *
 * It boots the recorded scenario exactly as `runner.ts` does (lane W1b's converter, the scenario's
 * argv, lane L12's file backend), runs `--max-steps 1`, and then prints, from the live object list:
 *
 *   * the agent order the walk sees (the x-sorted list's key is `x - radius`),
 *   * each agent's `x`, `z`, `radius`, `carryRadius` and `length`,
 *   * for the golden's own contact pairs, the distance and the contact predicate's verdict.
 *
 * Usage: `npx tsx src/model/sim/runner.ts` is the runner; this probe is run directly:
 *   `npx tsx src/model/sim/native/contactprobe.ts <scenario>`
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
  const outDir = resolve(argv[1] ?? join(repoRoot, '.candidate', 'contactprobe'));
  // t_37bf7212: a probe's output tree stages outside the oracle (it writes `run/**` here).
  assertUsableStagingRoot(outDir, 'contactprobe outDir');
  const recorded = join(repoRoot, 'oracle', scenario, 'run');
  const worldfilePath = 'worldfiles/tests/low-spec-pc/' + `${scenario.split('_')[0]}.wf`;
  const schemaPath = './etc/worldfile.wfs';

  const built = emitNormalizedWorldfile(
    (path: string) => {
      if (path === worldfilePath) return readFileSync(join(recorded, 'original.wf'), 'utf8');
      if (path === schemaPath) return readFileSync(join(recorded, 'original.wfs'), 'utf8');
      throw new Error(`contactprobe: no source text for '${path}'`);
    },
    {
      worldfilePath,
      schemaPath,
      parameters: scenarioParameters(repoRoot, scenario),
      validate: false,
    },
  );

  const doc = new Config(built.worldfileDocument);
  const previousCwd = process.cwd();
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

  // One step, then read the live list — `Interact` runs after the body update, so the walk below
  // sees the same positions/radii the contact pass saw.
  sim.step();

  const list = sim.objects();
  list.reset();
  const agents: Agent[] = [];
  for (;;) {
    const a = list.nextObj(AGENTTYPE) as Agent | null;
    if (a === null) break;
    agents.push(a);
  }

  process.stdout.write(`contactprobe: ${scenario} step ${sim.getStepNumber()}\n`);
  process.stdout.write(`  list order (key = x - radius), ${agents.length} agents:\n`);
  for (const a of agents) {
    process.stdout.write(
      `    #${a.number()} x=${a.x()} z=${a.z()} radius=${a.radius()} carryRadius=${a.carryRadius()} ` +
        `key=${a.x() - a.radius()}\n`,
    );
  }

  // The golden's own contact pairs (read from `oracle/<scenario>/run/events/contacts.log` by the
  // caller): evaluate the predicate the walk applies, in both visit orders.
  const pairs: readonly (readonly [number, number])[] = [[15, 2], [2, 5], [15, 5]];
  const byNumber = new Map<number, Agent>(agents.map((a) => [a.number(), a]));
  process.stdout.write('  predicate (native: sqrt(dx^2+dz^2) <= r_c + r_d, x early-out first):\n');
  for (const [n1, n2] of pairs) {
    const c = byNumber.get(n1);
    const d = byNumber.get(n2);
    if (c === undefined || d === undefined) {
      process.stdout.write(`    ${n1}-${n2}: agent missing\n`);
      continue;
    }
    const dx = d.x() - c.x();
    const dz = d.z() - c.z();
    const distance = Math.sqrt(dx * dx + dz * dz);
    const earlyOut = d.x() - d.radius() >= c.x() + c.radius();
    process.stdout.write(
      `    ${n1}-${n2}: distance=${distance} rsum=${d.radius() + c.radius()} ` +
        `contact=${!earlyOut && distance <= d.radius() + c.radius()} (x early-out ${earlyOut ? 'FIRES' : 'no'})\n`,
    );
  }

  // --- the walk the sim's own contact pass performs, replayed over this list -------------------
  //
  // This is `interact.ts`'s contact loop, verbatim in structure: outer walk in list order, `setMark`
  // then an inner walk, breaking on the x early-out. What matters is which `(c, d)` pairs the walk
  // ever *reaches* — a pair the walk never reaches can never produce a contact event, whatever its
  // geometry says.
  process.stdout.write('  contact walk replay (pairs the walk actually tests):\n');
  const list2 = sim.objects();
  let tested = 0;
  list2.reset();
  for (;;) {
    const c = list2.nextObj(AGENTTYPE) as Agent | null;
    if (c === null) break;
    if (c.age() <= 0) continue;
    list2.setMark(AGENTTYPE);
    for (;;) {
      const d = list2.nextObj(AGENTTYPE) as Agent | null;
      if (d === null) break;
      if (d === c) continue;
      if (d.x() - d.radius() >= c.x() + c.radius()) break;
      tested++;
      const dx = d.x() - c.x();
      const dz = d.z() - c.z();
      const distance = Math.sqrt(dx * dx + dz * dz);
      process.stdout.write(
        `    #${c.number()} -> #${d.number()}: distance=${distance} ` +
          `contact=${distance <= d.radius() + c.radius()}\n`,
      );
    }
  }
  process.stdout.write(`    (${tested} pair(s) reached at all)\n`);

  sim.dispose();
  process.chdir(previousCwd);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('contactprobe.ts')) {
  main(process.argv.slice(2));
}
