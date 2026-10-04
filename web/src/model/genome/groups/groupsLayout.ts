/**
 * Lane L5 (genome) — `GenomeLayout::createNeurGroup`, moved out of `GenomeLayout` so the
 * layout class stays free of any group dependency (see
 * PORT-NOTE(genome/layout-dispatch) in `genomeLayout.ts`).
 *
 * This is the *order of the mutable data*, and it is what `run/genome/meta/genelayout.txt`
 * records. Native's walk, transcribed:
 *
 *   1. every **mutable scalar** gene, in schema order;
 *   2. every **mutable neuron-group** gene, in schema order (the group counts themselves);
 *   3. for each group `g` of `getMaxGroupCount( NGT_ANY )`:
 *        a. that group's `NEURGROUP_ATTR` genes, when the group is a member of the gene's
 *           group type, one byte each;
 *        b. then, for every `group_to` that is not an input group, for every synapse type,
 *           for every `SYNAPSE_ATTR` gene, one byte — i.e. the section that makes the
 *           synapse matrix contiguous per (type, from, to).
 *
 * The `ADD( x, 1 )` macro asserts its size is exactly 1; so does the port (`addOne`).
 */

import { GeneType, GroupsGeneType, NeurGroupType } from '../vocabulary';
import type { GenomeLayout } from '../genomeLayout';
import {
  type NeurGroupAttrGene,
  type NeurGroupGene,
  type SynapseAttrGene,
} from './groupsGene';
import type { GroupsGenomeSchema } from './groupsGenomeSchema';

/** Native `GenomeLayout::createNeurGroup`. */
export function buildNeurGroupMapping(
  layout: GenomeLayout,
  schema: GroupsGenomeSchema,
): void {
  let index = 0;

  /** Native `ADD( GENE_OFFSET, N )`: asserts N == 1 and claims the next data offset. */
  const addOne = (geneOffset: number): void => {
    layout.set(geneOffset, index);
    index += 1;
  };

  // --- SCALARS
  for (const gene of schema.getAll(GeneType.SCALAR)) {
    if (gene.ismutable) addOne(gene.offset);
  }

  // --- NEURGROUP
  for (const gene of schema.getAll(GroupsGeneType.NEURGROUP)) {
    if (gene.ismutable) addOne(gene.offset);
  }

  const maxGroups = schema.getMaxGroupCount(NeurGroupType.ANY);
  const groupAttrGenes = schema.getAll(GroupsGeneType.NEURGROUP_ATTR) as readonly NeurGroupAttrGene[];
  const synapseAttrGenes = schema.getAll(GroupsGeneType.SYNAPSE_ATTR) as readonly SynapseAttrGene[];

  // --- NEURGROUP_ATTR & SYNAPSE_ATTR
  for (let group = 0; group < maxGroups; group++) {
    const groupGene: NeurGroupGene = schema.getGroupGene(group);

    // --- NEURGROUP_ATTR
    for (const attrGene of groupAttrGenes) {
      if (groupGene.isMember(attrGene.groupType) && attrGene.ismutable) {
        addOne(attrGene.getGroupOffset(group));
      }
    }

    // --- SYNAPSE_ATTR
    for (let groupTo = 0; groupTo < maxGroups; groupTo++) {
      if (NeurGroupType.INPUT !== schema.getNeurGroupType(groupTo)) {
        for (const synapseType of schema.getSynapseTypes()) {
          for (const attrGene of synapseAttrGenes) {
            addOne(attrGene.getSynapseOffset(synapseType, group, groupTo));
          }
        }
      }
    }
  }
}
