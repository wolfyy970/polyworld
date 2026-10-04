/**
 * Lane W1a — the property-document surface every lane reads config through.
 *
 * Native: `src/library/proplib/dom.h` (`class Property`, `class __ContainerProperty`,
 * `class __ScalarProperty`, `class Document`) and its `Identifier` key type. The model
 * never parses the worldfile itself; it walks the DOM that proplib built from
 * `run/normalized.wf` and coerces values at the point of use:
 *
 *   agent::config.vision = doc.get( "Vision" );        // operator bool -> toBool()
 *   globals::worldsize   = doc.get( "WorldSize" );     // operator float -> toFloat()
 *   globals::numEnergyTypes = doc.get( "NumEnergyTypes" );  // operator int -> toInt()
 *
 * This file freezes the *shape* of that DOM (so lanes L1–L18 can be written against it
 * before proplib exists) plus the lookup/ordering semantics that the native code depends
 * on. The implementation is proplib's (lane W1b); `memoryDocument.ts` provides a
 * faithful in-memory double for lane unit tests.
 *
 * PORT-NOTE(types/property-node-interface): native `Property` is a class with virtual
 * coercions (`operator bool()` …) and a `PropertyMap` (`std::map<Identifier, Property*>`,
 * i.e. *sorted*). The port splits those: the node carries the evaluated text
 * (`scalarText()`, native `operator string()` == `getEvaledString()`) and `elements()`
 * returns the children already in native map order. Coercion lives in `scalar.ts` and is
 * applied by `Config` in `config.ts`, so there is exactly one definition of it.
 */

import { configError } from './errors';

/** A key: a property name, or an array index (native `Identifier`). */
export type PropertyId = string | number;

/**
 * Native `Identifier(int)` / `Identifier(size_t)` stringify the index (`sprintf "%d"/"%zu"`),
 * and *every* lookup goes through that string. Indices are therefore identifiers, not a
 * separate lookup path: `propArray.get( 3 )` is `propArray.get( "3" )`.
 */
export function identifierName(id: PropertyId): string {
  return typeof id === 'number' ? `${id}` : id;
}

/**
 * Native `operator<( const Identifier &a, const Identifier &b )` is
 * `strcmp( a.getName(), b.getName() ) < 0` — a *string* comparison, even for array
 * indices.
 *
 * PORT-NOTE(types/identifier-order): because the native `PropertyMap` is a `std::map`
 * ordered by that operator, `elements()` walks in strcmp order, so an array of 11+
 * elements iterates `"0","1","10","11",…,"2","20",…` — NOT in numeric order. Anything
 * that accumulates over an array (SummedEnergy, separation statistics) must keep that
 * order. For the ASCII identifiers a worldfile contains, JS `<` on strings is UTF-16
 * code-unit order and equals `strcmp` byte order.
 */
export function compareIdentifier(a: PropertyId, b: PropertyId): number {
  const an = identifierName(a);
  const bn = identifierName(b);
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/** Sort key usable in `[...].sort((x, y) => compareIdentifier(x.name, y.name))`. */
export function identifierOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Native `Node::Type` restricted to what a config read cares about.
 *
 * `scalar` == scalar property (native `Scalar`/`Const`/`Dynamic`), `object` == native
 * `ObjectProperty`, `array` == native `ArrayProperty`, `runtime` == native runtime
 * property, whose value is illegal to read (`err( "Illegal request for value of runtime
 * property." )`).
 */
export type NodeKind = 'scalar' | 'object' | 'array' | 'runtime';

/**
 * One node of the normalized worldfile document.
 *
 * Port of the parts of native `Property` that the model uses. Every method that native
 * implements with `err()` + `exit(1)` on the failure path throws `ConfigError` here
 * instead (the failure must stay loud: a silently-wrong config value is how a port
 * diverges from the oracle without anyone noticing).
 */
export interface PropertyNode {
  /** Native `Property::getName()`. The document root's name is the document path. */
  readonly name: string;
  readonly kind: NodeKind;

  /** Native `Property::get( Identifier )` — required child; errors when absent. */
  get(id: PropertyId): PropertyNode;

  /** Native `Property::getp( Identifier )` — optional child. */
  getp(id: PropertyId): PropertyNode | undefined;

  /**
   * Native `Property::elements()` (an alias for `props()`): the children, in native
   * `std::map` order (see `compareIdentifier`). Errors for a scalar node, exactly like
   * `__ScalarProperty::props()` (`err( "Invalid request for properties." )`).
   */
  elements(): readonly PropertyNode[];

  /** Native `Property::size()` — number of children (0 for a scalar). */
  size(): number;

  /**
   * Native `getEvaledString()` as reached through `operator std::string()`: the scalar's
   * value after proplib evaluated its expression, with no trimming and no conversion.
   * Errors for a container (`err( "Expecting String" )`) and for a runtime property.
   */
  scalarText(): string;
}

/** True for native container nodes (`ObjectProperty` / `ArrayProperty`). */
export function isContainerNode(node: PropertyNode): boolean {
  return node.kind === 'object' || node.kind === 'array';
}

/**
 * Native `__ContainerProperty::get`: missing child -> `err( "No such property: 'X'" )`;
 * asked of a scalar -> `__ScalarProperty::get` -> `err( "Invalid request for property: 'X'" )`.
 */
export function requireChild(node: PropertyNode, id: PropertyId): PropertyNode {
  if (!isContainerNode(node)) {
    configError(node.name, `Invalid request for property: '${identifierName(id)}'`);
  }
  const child = node.getp(id);
  if (child === undefined) {
    configError(node.name, `No such property: '${identifierName(id)}'`);
  }
  return child;
}

/** Native `elements()` / `props()` on a scalar: `err( "Invalid request for properties." )`. */
export function requireElements(node: PropertyNode): readonly PropertyNode[] {
  if (!isContainerNode(node)) {
    configError(node.name, 'Invalid request for properties.');
  }
  return node.elements();
}

/**
 * Native `__ContainerProperty::operator string()`: `err( "Expecting String" )`. The other
 * container coercions error with their own wording (`"Expecting Int"`, `"Expecting Float"`,
 * `"Expecting Bool"`), which is why the accessor in `config.ts` names the type it wanted
 * rather than reusing this one.
 */
export function requireScalarText(node: PropertyNode): string {
  if (isContainerNode(node)) {
    configError(node.name, 'Expecting String');
  }
  return node.scalarText();
}
