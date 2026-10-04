/**
 * Lane W1a — a faithful in-memory `PropertyNode`, for lane unit tests and fixtures.
 *
 * Not a parser: proplib (lane W1b) builds the real document from `run/normalized.wf`.
 * This is the *reference implementation of the interface's semantics* — child order,
 * index naming, duplicate detection and the native failure paths — so a lane can test a
 * config read (and the browser shell can build a canned world) without proplib.
 *
 * PORT-NOTE(types/memory-document): test double that encodes the frozen semantics
 * (strcmp child order, `Identifier(index)` == decimal string, duplicate names are an
 * error, scalar-vs-container confusion is an error). It must stay behaviorally identical
 * to proplib's document; if it drifts, the tests that pass against it stop meaning
 * anything.
 */

import { configError } from './errors';
import type { NodeKind, PropertyId, PropertyNode } from './property';
import { identifierName, identifierOrder, isContainerNode, requireChild } from './property';

class MemoryNode implements PropertyNode {
  readonly name: string;
  readonly kind: NodeKind;

  private readonly text: string;
  private readonly ordered: readonly PropertyNode[];
  private readonly byId: ReadonlyMap<string, PropertyNode>;

  constructor(name: string, kind: NodeKind, text: string, children: readonly PropertyNode[]) {
    this.name = name;
    this.kind = kind;
    this.text = text;

    if (kind === 'object' || kind === 'array') {
      const byId = new Map<string, PropertyNode>();
      for (const child of children) {
        const key = child.name;
        if (byId.has(key)) {
          // Native `__ContainerProperty::add`: err( "Duplicate property name 'X' ..." ).
          configError(name, `Duplicate property name '${key}'`);
        }
        byId.set(key, child);
      }
      // Native `std::map<Identifier, Property*>` order: strcmp on the identifier name.
      this.ordered = [...children].sort((a, b) => identifierOrder(a.name, b.name));
      this.byId = byId;
    } else {
      this.ordered = [];
      this.byId = new Map();
    }
  }

  get(id: PropertyId): PropertyNode {
    return requireChild(this, id);
  }

  getp(id: PropertyId): PropertyNode | undefined {
    return this.byId.get(identifierName(id));
  }

  elements(): readonly PropertyNode[] {
    // Native `__ScalarProperty::props()`: err( "Invalid request for properties." ).
    if (!isContainerNode(this)) configError(this.name, 'Invalid request for properties.');
    return this.ordered;
  }

  size(): number {
    return this.ordered.length;
  }

  scalarText(): string {
    // Native `__ContainerProperty::operator string()`: err( "Expecting String" ).
    if (isContainerNode(this)) configError(this.name, 'Expecting String');
    return this.text;
  }
}

/** A scalar property (native `ConstScalarProperty` / `DynamicScalarProperty`). */
export function scalarNode(name: string, text: string): PropertyNode {
  return new MemoryNode(name, 'scalar', text, []);
}

/** An object property (native `ObjectProperty`) — children keep native map order. */
export function objectNode(name: string, children: readonly PropertyNode[]): PropertyNode {
  return new MemoryNode(name, 'object', '', children);
}

/** An array property (native `ArrayProperty`): elements are renamed `"0"`, `"1"`, … */
export function arrayNode(name: string, elements: readonly PropertyNode[]): PropertyNode {
  const renamed = elements.map(
    (element, index) =>
      new MemoryNode(
        String(index),
        element.kind,
        element.kind === 'scalar' ? element.scalarText() : '',
        element.kind === 'scalar' ? [] : element.elements(),
      ),
  );
  return new MemoryNode(name, 'array', '', renamed);
}

/** The document root: native `Document`, an `ObjectProperty` named after its path. */
export function documentNode(children: readonly PropertyNode[], name = ''): PropertyNode {
  return new MemoryNode(name, 'object', '', children);
}

/** A plain JS shape for fixtures: `{ Name: 'Standard', EnergyPolarity: ['1'] }`. */
export type MemoryValue = string | readonly MemoryValue[] | { readonly [name: string]: MemoryValue };

/** Build a node from a plain JS value (`string` = scalar, array = array, object = object). */
export function valueNode(name: string, value: MemoryValue): PropertyNode {
  if (typeof value === 'string') return scalarNode(name, value);
  if (Array.isArray(value)) {
    return arrayNode(
      name,
      value.map((element, index) => valueNode(String(index), element as MemoryValue)),
    );
  }
  const entries = Object.entries(value as { readonly [name: string]: MemoryValue });
  return objectNode(
    name,
    entries.map(([key, child]) => valueNode(key, child)),
  );
}

/**
 * Build a document root from a plain JS object, e.g.
 *
 *   documentFromJs({ Vision: 'False', WorldSize: '100', NumEnergyTypes: '1' })
 */
export function documentFromJs(values: { readonly [name: string]: MemoryValue }, name = ''): PropertyNode {
  return valueNode(name, values) as PropertyNode;
}
