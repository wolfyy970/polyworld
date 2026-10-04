/**
 * Lane L5 (genome) — `genome/GenomeUtil.{h,cc}`: the process-wide schema/layout and the
 * genome factory.
 *
 * Native keeps both in statics (`GenomeUtil::schema`, `GenomeUtil::layout`) and
 * `createSchema` asserts the schema is not built twice. The port keeps the same
 * single-instance shape in one exported object, because the model has one genome schema per
 * run and its gene offsets are global (they are written into `run/genome/meta/*`).
 *
 * PORT-NOTE(genome/designer-genes): `randomize()` in native is `#if DesignerGenes` ->
 * `schema->seed(g)` else `g->randomize()`. `DesignerGenes` is not defined anywhere in the
 * oracle tree (verified by grep), so the compiled behaviour is `g->randomize()`; the port
 * keeps `seed()` reachable but never calls it from `randomize()`. A build that turns
 * `DesignerGenes` on would change every initial genome, so this is a real switch, not a
 * stylistic choice.
 *
 * PORT-NOTE(genome/metabolism-seam): `getMetabolism` returns the `MetabolismIndex` gene
 * value, which is all the genome owns; the metabolism *table* it indexes is built by lane
 * L11 from the worldfile (`AgentMetabolisms` / `AgentMetabolismSelectionMode`), so the
 * table lookup is not declared here.
 *
 * `genome/sheets/**` is **not ported, and that is a measured deviation rather than a stub**
 * (PORT_SPEC rule 7's other branch: a deviation, and no later task closes it): the shipped
 * oracle grows no Sheets brain to be faithful *to*. Under the worldfile schema's own
 * `GenomeLayout` default (`None` for `Sheets`, `etc/worldfile.wfs:91`) every agent's brain
 * comes out empty — anatomy `numneurons+1=1`, synapses `numsynapses=0`, `CurNeurons 0.0` —
 * raising the `Sheets { … }` block changes nothing (the same 125-file `run/brain` digest),
 * and writing out the only container layout the build has (`GenomeLayout NeurGroup`)
 * SIGSEGVs. `createSchema` still throws for `Sheets`, and the throw *is* the honest
 * equivalent of native's inert run: PARITY.md -> *The `Sheets` architecture in the shipped
 * oracle — measured, and why it is not owed*, re-runnable as
 * `src/model/genome/native/probe_sheets_architecture.sh`.
 */

import type { Config } from '../types';
import {
  GenomeSchema,
  GenomeSchemaConfig,
  type GenomeSchemaInputs,
} from './genomeSchema';
import { GenomeLayout, LayoutType } from './genomeLayout';
import { toInterpolated } from './gene';
import { GroupsGenomeSchema } from './groups/groupsGenomeSchema';
import { buildNeurGroupMapping } from './groups/groupsLayout';
import type { Genome } from './genome';
import type { RngSurface } from '../types';

/** Native `GenomeUtil` (one instance per process — see the module note). */
export class GenomeUtil {
  schema: GenomeSchema | null = null;
  layout: GenomeLayout | null = null;

  /** Native `GenomeUtil::createSchema`. */
  createSchema(inputs: GenomeSchemaInputs): GenomeSchema {
    if (this.schema !== null) throw new Error('GenomeUtil::createSchema: schema already created');

    // Native: switch( Brain::config.architecture ).
    if (inputs.architecture === 'Groups') {
      this.schema = new GroupsGenomeSchema(inputs);
    } else if (inputs.architecture === 'Sheets') {
      // A measured deviation, not a stub: the oracle grows no Sheets brain (see the module note).
      throw new Error(
        'GenomeUtil::createSchema: the Sheets architecture is not ported — the shipped oracle ' +
          'has no Sheets brain to be faithful to (empty brains, 0 synapses, SIGSEGV under its ' +
          'one container layout), so this is a documented deviation rather than outstanding ' +
          'work. See PARITY.md -> "The `Sheets` architecture in the shipped oracle — measured, ' +
          'and why it is not owed" and re-run ' +
          'src/model/genome/native/probe_sheets_architecture.sh',
      );
    } else {
      throw new Error(`GenomeUtil::createSchema: unknown architecture '${String(inputs.architecture)}'`);
    }

    this.schema.define();
    this.schema.complete();

    // --- Configure Interpolation
    for (const [name, power] of GenomeSchemaConfig.geneInterpolationPower) {
      const gene = this.schema.get(name);
      if (!gene) throw new Error(`Invalid gene name for interpolation power: ${name}`);
      const igene = toInterpolated(gene);
      igene.setInterpolationPower(power);
    }

    // --- Layout (native `GenomeLayout::create( schema, config.layoutType )`)
    this.layout = this.createLayout(this.schema);
    return this.schema;
  }

  /** Native `GenomeLayout::create` — the dispatch lives here (see PORT-NOTE in genomeLayout.ts). */
  private createLayout(schema: GenomeSchema): GenomeLayout {
    if (schema instanceof GroupsGenomeSchema && GenomeSchemaConfig.layoutType === LayoutType.NeurGroup) {
      const layout = new GenomeLayout(schema.getMutableSize());
      buildNeurGroupMapping(layout, schema);
      layout.validate();
      return layout;
    }

    if (GenomeSchemaConfig.layoutType !== LayoutType.None) {
      throw new Error(
        `GenomeLayout::create: layout type ${GenomeSchemaConfig.layoutType} needs a Groups schema`,
      );
    }

    const layout = GenomeLayout.createNone(schema.getMutableSize());
    layout.validate();
    return layout;
  }

  /** Native `GenomeUtil::createGenome`. */
  createGenome(randomized: boolean, rng: RngSurface): Genome {
    const schema = this.requireSchema();
    const layout = this.requireLayout();
    if (!(schema instanceof GroupsGenomeSchema)) {
      throw new Error('GenomeUtil::createGenome: only the Groups schema can create a genome');
    }

    const genome = schema.createGenome(layout, rng);
    if (randomized) this.randomize(genome);
    return genome;
  }

  /** Native `GenomeUtil::randomize` (see PORT-NOTE(genome/designer-genes)). */
  randomize(genome: Genome): void {
    genome.randomize();
  }

  /** Native `GenomeUtil::seed` — only reachable through `#if DesignerGenes`. */
  seed(genome: Genome, rng: RngSurface): void {
    const schema = this.requireSchema();
    schema.seed(genome, rng);
  }

  /** Native `GenomeUtil::getMetabolism`: the `MetabolismIndex` gene value. */
  getMetabolismIndex(genome: Genome, definitionCount: number): number {
    if (definitionCount === 1) return 0;
    return genome.get('MetabolismIndex').asInt();
  }

  /** Native `GenomeUtil::getGene( name, err )`. */
  getGene(name: string, err: string): import('./gene').Gene | null {
    const gene = this.requireSchema().get(name);
    if (!gene && err.length > 0) throw new Error(err);
    return gene;
  }

  private requireSchema(): GenomeSchema {
    if (!this.schema) throw new Error('GenomeUtil: no schema (call createSchema first)');
    return this.schema;
  }

  private requireLayout(): GenomeLayout {
    if (!this.layout) throw new Error('GenomeUtil: no layout (call createSchema first)');
    return this.layout;
  }
}

/** Native's statics: one schema/layout for the process. */
export const genomeUtil = new GenomeUtil();
