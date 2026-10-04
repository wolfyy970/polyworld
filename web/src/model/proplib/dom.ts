/**
 * Lane W1b — the property document model (native `proplib/dom.{h,cc}`).
 *
 * Two views of the same objects live in this file, on purpose:
 *
 *   1. the **frozen `PropertyNode` surface** (`name`, `kind`, `get`, `getp`, `elements`,
 *      `size`, `scalarText`) from `src/model/types/property.ts`, which every other lane
 *      reads a config through. Its failure semantics are W1a's: `get`/`elements`/
 *      `scalarText` throw `ConfigError` mentioning the *property name* (`requireChild`
 *      et al.), and `getp` returns `undefined` instead of erroring — matching the
 *      reference double `memoryDocument.ts` exactly (see the PORT-NOTE below).
 *   2. the **native-shaped internals** the proplib front end itself uses: `getId()`,
 *      `getpProp()`, `props()`, `getSchema()`, `findSymbol()`, `clone()`, and
 *      `getEvaledString()`, with the native location-based error text
 *      (`DocumentLocation::err` → `<path>:<lineno>: ERROR! <message>`).
 *
 * PORT-NOTE(proplib/error-text-split): native has one error channel for the whole DOM
 * (`DocumentLocation::err`), which prefixes `<path>:<lineno>`. The frozen interface W1a
 * specifies instead prefixes the property *name*, and `memoryDocument.ts` implements that.
 * Both are preserved here rather than unified: the frozen surface (`get`/`elements`/
 * `scalarText`, i.e. what other lanes call) uses the frozen text so that the double and the
 * real document stay indistinguishable; the front end's own errors (parse, validation,
 * conversion) use the native text, because those messages are part of what a lane greps for
 * in a log.
 *
 * PORT-NOTE(proplib/property-map-order): native `PropertyMap` is a `std::map<Identifier,
 * Property*>` compared with `strcmp`, so `props()` iterates in identifier-string order —
 * `"0","1","10","11","2"`, not numerically. The port stores children in a `Map` keyed by
 * identifier name (insertion order) and returns them **sorted by that strcmp order**, so
 * every iteration of `props()` in the port has the same order as native. `ArrayProperty`
 * element *lookup* is by index name (`getp(i)`), so array order in the output is numeric —
 * exactly as native (`DocumentWriter::writeArray` loops `getp(0..size-1)`).
 *
 * PORT-NOTE(proplib/scalar-error): native `__ScalarProperty::getp`/`props` *error* when
 * asked for a child ("Invalid request for property/properties"), and `Property::size()`
 * inherits that (it calls `props()`). W1a's frozen interface instead specifies `getp` ->
 * `undefined`, `size()` -> `0` and a throwing `elements()`. The port follows the frozen
 * interface on the public surface; the front end's own `getpProp()` keeps the native
 * failure (it is what `normalize`/`validate`/`findSymbol` walk).
 */

import { configError } from '../types/errors';
import type { NodeKind, PropertyId, PropertyNode } from '../types/property';
import { requireChild, requireElements, requireScalarText, identifierOrder } from '../types/property';
import { nativeBool, nativeFloat, nativeInt, nativeString } from '../types/scalar';
import type { ExpressionEvaluator } from './evaluator';
import type { Expression, SymbolPath } from './expression';
import type { Token } from './lexer';

/** Native `Node::Type`. */
export type NodeType = 'Enum' | 'Class' | 'Scalar' | 'Object' | 'Array' | 'Attr' | 'Meta';

/** Native `Node::Subtype`. */
export type NodeSubtype = 'None' | 'Const' | 'Dynamic' | 'Runtime' | 'Document';

/**
 * Native `Identifier`: a property name *or* an array index, stringified at construction
 * (`%d` / `%zu`) so that every lookup goes through one string key. `isIndex()` is true when
 * every character is a digit — including the empty name, as in native.
 */
export class Identifier {
  readonly name: string;

  constructor(nameOrIndex: string | number) {
    this.name = typeof nameOrIndex === 'number' ? `${nameOrIndex}` : nameOrIndex;
  }

  getName(): string {
    return this.name;
  }

  isIndex(): boolean {
    for (let i = 0; i < this.name.length; i++) {
      const c = this.name.charCodeAt(i);
      if (c < 48 || c > 57) return false;
    }
    return true;
  }
}

/** Identifier of `PropertyId` or `Identifier` (the frozen layer uses `string | number`). */
export function toIdentifier(id: PropertyId | Identifier): Identifier {
  return id instanceof Identifier ? id : new Identifier(id);
}

/**
 * Native `DocumentLocation`: where a node came from. It is *load-bearing* for output
 * ordering: `DocumentWriter` sorts a container's children by location, and the location's
 * document path, line number and token index are the three keys.
 *
 * PORT-NOTE(proplib/location-lineno-unsigned): native stores `_lineno` as `unsigned int`
 * and the constructor's default of `-1` therefore reads back as 4294967295, which both the
 * comparison (`a._lineno - b._lineno` wraps to a signed `int`) and `getDescription()`
 * (`if( _lineno > 0 )`) observe. The port keeps the wrapping arithmetic (`(ua - ub) | 0`)
 * and the unsigned test, so the oddity is preserved rather than papered over.
 */
export class DocumentLocation {
  document: Document | undefined;
  readonly lineno: number;
  readonly beginToken: Token | undefined;
  readonly endToken: Token | undefined;

  constructor(
    document: Document | undefined,
    lineno = -1,
    beginToken?: Token,
    endToken?: Token,
  ) {
    this.document = document;
    this.lineno = lineno;
    this.beginToken = beginToken;
    this.endToken = endToken;
  }

  getDocument(): Document | undefined {
    return this.document;
  }

  getPath(): string {
    return this.document?.getName() ?? '';
  }

  getDescription(): string {
    const path = this.getPath();
    return (this.lineno >>> 0) > 0 ? `${path}:${this.lineno >>> 0}` : path;
  }

  /** Native `DocumentLocation::err`: `<path>[:<lineno>]: ERROR! <message>`, then `exit(1)`. */
  err(message: string): never {
    configError(this.getDescription(), message);
  }

  /** Native `DocumentLocation::warn` (does not stop the run). */
  warn(message: string): void {
    // eslint-disable-next-line no-console
    console.warn(`${this.getDescription()}: WARNING! ${message}`);
  }
}

/** Native `operator<( DocumentLocation, DocumentLocation )`. */
export function compareLocation(a: DocumentLocation, b: DocumentLocation): number {
  const ap = a.getPath();
  const bp = b.getPath();
  const cmp = ap < bp ? -1 : ap > bp ? 1 : 0;
  if (cmp !== 0) return cmp;

  const diff = ((a.lineno >>> 0) - (b.lineno >>> 0)) | 0;
  if (diff !== 0) return diff;

  if (a.beginToken && b.beginToken) {
    return a.beginToken.number < b.beginToken.number
      ? -1
      : a.beginToken.number > b.beginToken.number
        ? 1
        : 0;
  }
  // Native returns `true` (i.e. a < b) whenever either begin token is NULL.
  return -1;
}

/** Native `struct Symbol` — what a symbol path resolves to. */
export type Symbol =
  | { readonly type: 'EnumValue' }
  | { readonly type: 'Class'; readonly klass: Class }
  | { readonly type: 'Property'; readonly prop: Property };

/** Native `Node`: the shared identity/error surface of every document node. */
export abstract class Node {
  protected parent: Node | undefined;
  protected symbolSource: Node | undefined;

  private readonly nodeType: NodeType;
  private readonly nodeSubtype: NodeSubtype;
  private readonly loc: DocumentLocation;

  protected constructor(type: NodeType, subtype: NodeSubtype, loc: DocumentLocation) {
    this.nodeType = type;
    this.nodeSubtype = subtype;
    this.loc = loc;
  }

  getType(): NodeType {
    return this.nodeType;
  }

  getSubtype(): NodeSubtype {
    return this.nodeSubtype;
  }

  getLocation(): DocumentLocation {
    return this.loc;
  }

  /** Native `Node::err( msg )` — location-based, fatal. */
  err(message: string): never {
    return this.loc.err(message);
  }

  /** Native `Node::warn( msg )`. */
  warn(message: string): void {
    this.loc.warn(message);
  }

  /**
   * Native `Node::add( Node * )`: adopt a child. Named `adopt` because the concrete
   * containers declare `add( Property * )` with a narrower parameter type, and native
   * overloads what TypeScript would reject as an override.
   */
  protected adopt(node: Node): void {
    node.parent = this;
  }

  /** Native `Node::findSymbol( SymbolPath *, Symbol & )`. */
  findSymbol(path: SymbolPath): Symbol | undefined {
    return this.findSymbolFrom(path, 0);
  }

  protected findSymbolFrom(path: SymbolPath, index: number): Symbol | undefined {
    if (this.symbolSource) {
      const viaSource = this.symbolSource.findSymbolFrom(path, index);
      if (viaSource) return viaSource;
    }

    const local = this.__findLocalSymbol(path, index);
    if (local) return local;

    if (this.parent) return this.parent.findSymbolFrom(path, index);

    return undefined;
  }

  /**
   * Native `Node::__findLocalSymbol( SymbolPath::Element *, Symbol & )`.
   *
   * PORT-NOTE(proplib/symbol-path-cursor): native walks the symbol path as a linked list
   * (`name->next`). The port passes the path plus the index of the element being resolved;
   * the traversal is identical. Public (not protected) because a parent resolves through a
   * *child* object (a class, an enum, a nested container).
   */
  __findLocalSymbol(_path: SymbolPath, _index: number): Symbol | undefined {
    return undefined;
  }
}

/** Native `class Enum`: a named set of value names, attached to the property that owns it. */
export class ProplibEnum extends Node {
  private readonly id: Identifier;
  private readonly values = new Set<string>();

  constructor(loc: DocumentLocation, id: Identifier) {
    super('Enum', 'None', loc);
    this.id = id;
  }

  getId(): Identifier {
    return this.id;
  }

  /** Native `Enum::addValue` — a duplicate name is fatal. */
  addValue(name: string): void {
    if (this.values.has(name)) this.err(`Duplicate name: ${name}`);
    this.values.add(name);
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }

  valuesInOrder(): readonly string[] {
    return [...this.values];
  }

  clone(): ProplibEnum {
    const copy = new ProplibEnum(this.getLocation(), this.id);
    for (const value of this.values) copy.values.add(value);
    return copy;
  }

  override __findLocalSymbol(path: SymbolPath, index: number): Symbol | undefined {
    const token = path.elements[index];
    if (token === undefined) return undefined;
    if (index === path.elements.length - 1 && this.contains(token.text)) {
      return { type: 'EnumValue' };
    }
    return undefined;
  }
}

/** Native `class Class`: a named `ObjectProperty` definition usable as a schema type. */
export class Class extends Node {
  private readonly id: Identifier;
  private readonly definition: ObjectProperty;

  constructor(loc: DocumentLocation, id: Identifier, definition: ObjectProperty) {
    super('Class', 'None', loc);
    this.id = id;
    this.definition = definition;
    this.adopt(definition);
  }

  getId(): Identifier {
    return this.id;
  }

  getDefinition(): ObjectProperty {
    return this.definition;
  }

  clone(): Class {
    // Native dynamic_casts the clone back to an ObjectProperty.
    const definition = this.definition.clone(this.definition.getId());
    if (!(definition instanceof ObjectProperty)) {
      this.err('Cloning a class definition must yield an object.');
    }
    return new Class(this.getLocation(), this.id, definition);
  }
}

/** Native `class MetaProperty` (`@version`, `@defaults`, …). */
export class MetaProperty extends Node {
  private readonly id: Identifier;
  private readonly value: string;

  constructor(loc: DocumentLocation, id: Identifier, value: string) {
    super('Attr', 'Dynamic', loc);
    this.id = id;
    this.value = value;
  }

  getId(): Identifier {
    return this.id;
  }

  getValue(): string {
    return this.value;
  }
}

/** Ordering-stable, strcmp-ordered child table (native `PropertyMap`). */
class PropertyTable {
  private readonly byName = new Map<string, Property>();

  get(name: string): Property | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  set(name: string, prop: Property): void {
    this.byName.set(name, prop);
  }

  delete(name: string): void {
    this.byName.delete(name);
  }

  clear(): void {
    this.byName.clear();
  }

  get size(): number {
    return this.byName.size;
  }

  /** Native `std::map` iteration order: `strcmp` on the identifier name. */
  ordered(): Property[] {
    return [...this.byName.values()].sort((a, b) => identifierOrder(a.getName(), b.getName()));
  }
}

/**
 * Native `class Property`. Abstract: the two concrete families are the scalar properties
 * (`__ScalarProperty`) and the containers (`__ContainerProperty`), and an array/object
 * cannot be confused with a scalar anywhere in the model.
 */
export abstract class Property extends Node implements PropertyNode {
  protected id: Identifier;
  private schemaProp: ObjectProperty | undefined;
  protected readonly enums = new Map<string, ProplibEnum>();

  protected constructor(
    type: NodeType,
    subtype: NodeSubtype,
    loc: DocumentLocation,
    id: Identifier,
  ) {
    super(type, subtype, loc);
    this.id = id;
  }

  // --- frozen PropertyNode surface ------------------------------------------------------

  /** Native `Property::getName()`. */
  get name(): string {
    return this.id.getName();
  }

  abstract get kind(): NodeKind;

  /** Native `Property::get( Identifier )` — required child (frozen failure text). */
  get(id: PropertyId): PropertyNode {
    return requireChild(this, id);
  }

  /** Native `Property::getp( Identifier )` — optional child (frozen: `undefined`). */
  abstract getp(id: PropertyId): PropertyNode | undefined;

  /** Native `Property::elements()` — children in native map order (frozen failure text). */
  abstract elements(): readonly PropertyNode[];

  abstract size(): number;

  /** Native `operator std::string()` == `getEvaledString()`. */
  abstract scalarText(): string;

  // --- native-shaped internals ----------------------------------------------------------

  getId(): Identifier {
    return this.id;
  }

  getName(): string {
    return this.id.getName();
  }

  /** Native `Property::getp( Identifier )`, with the native scalar failure. */
  abstract getpProp(id: PropertyId | Identifier): Property | undefined;

  /** Native `Property::props()`: children in native map order (empty for a scalar here). */
  abstract props(): readonly Property[];

  /** Native `Property::getParent()` (the dynamic_cast to `Property*`). */
  getParent(): Property | undefined {
    const parent = this.parent;
    return parent instanceof Property ? parent : undefined;
  }

  /** Native `Property::getDepth()`. */
  getDepth(): number {
    const parent = this.getParent();
    return parent === undefined ? 0 : parent.getDepth() + 1;
  }

  /** Native `Property::getFullName( minDepth, delimiter )`. */
  getFullName(minDepth = 0, delimiter?: string): string {
    if (this.getDepth() < minDepth) return '';
    const parent = this.getParent();
    if (parent === undefined) return this.getName();

    const parentFullName = parent.getFullName(minDepth, delimiter);
    if (parentFullName === '') return this.getName();
    if (delimiter !== undefined) return `${parentFullName}${delimiter}${this.getName()}`;
    return this.id.isIndex()
      ? `${parentFullName}[${this.getName()}]`
      : `${parentFullName}.${this.getName()}`;
  }

  /** Native `Property::hasProperty( Identifier )`. */
  hasProperty(id: PropertyId | Identifier): boolean {
    return this.getpProp(id) !== undefined;
  }

  /**
   * Native `DocumentEditor::rename` writes `prop->_id` directly (it is a friend of
   * `Property`); the port exposes the same one-way mutation.
   */
  renameId(newName: string | Identifier): void {
    this.id = newName instanceof Identifier ? newName : new Identifier(newName);
  }

  /**
   * Native `Property::get( Identifier )` returning the property itself (`Property &`), used
   * by the front end (schema/validate/convert). The frozen `get()` above returns the
   * interface type and is what other lanes call.
   */
  requireProp(id: PropertyId | Identifier): Property {
    const child = this.getpProp(id);
    if (child === undefined) this.err(`No such property: '${toIdentifier(id).getName()}'`);
    return child;
  }

  /** Native `Property::addEnum( Enum * )`. */
  addEnum(enum_: ProplibEnum): void {
    const key = enum_.getId().getName();
    if (this.enums.has(key)) enum_.err('Duplicate enum');
    this.enums.set(key, enum_);
    this.adopt(enum_);
  }

  /** Native `Property::getEnum( const std::string & )`. */
  getEnum(name: string): ProplibEnum | undefined {
    return this.enums.get(name);
  }

  /** Native `Property::isEnumValue( const std::string & )`. */
  isEnumValue(name: string): boolean {
    for (const enum_ of this.enums.values()) if (enum_.contains(name)) return true;
    return false;
  }

  /** Native `Property::isString()`. */
  isString(): boolean {
    if (!this.schemaProp) return false;
    return propString(this.schemaProp.requireProp('type')) === 'String';
  }

  /** Native `Property::setSchema( ObjectProperty * )` (also wires the symbol source). */
  setSchema(schema: ObjectProperty): void {
    this.schemaProp = schema;
    schema.setSymbolSource(this);
  }

  /** Native `Property::getSchema()`. */
  getSchema(): ObjectProperty | undefined {
    return this.schemaProp;
  }

  /** Native `Property::hasBinding()`: the schema declares a `cppsym`. */
  hasBinding(): boolean {
    return this.schemaProp !== undefined && this.schemaProp.getpProp('cppsym') !== undefined;
  }

  /** Native `Property::clone( Identifier )`. */
  abstract clone(cloneId: Identifier): Property;

  /** Native `Property::baseClone`. */
  protected baseClone(clone: Property): Property {
    for (const [key, enum_] of this.enums) clone.enums.set(key, enum_.clone());
    return clone;
  }

  override __findLocalSymbol(path: SymbolPath, index: number): Symbol | undefined {
    for (const enum_ of this.enums.values()) {
      const found = enum_.__findLocalSymbol(path, index);
      if (found) return found;
    }
    const token = path.elements[index];
    const parent = this.getParent();
    if (token !== undefined && token.text === 'parent' && parent !== undefined) {
      if (index + 1 < path.elements.length) return parent.__findLocalSymbol(path, index + 1);
      return { type: 'Property', prop: parent };
    }

    return undefined;
  }

  /** Native `setSchema`'s other half: the schema object resolves symbols through the value. */
  setSymbolSource(source: Node): void {
    this.symbolSource = source;
  }

  override toString(): string {
    return this.getName();
  }
}

/**
 * Native `__ScalarProperty`. Its value is always *evaluated text* (`getEvaledString()`),
 * obtained from the injected evaluator; nothing here interprets an expression.
 */
export abstract class __ScalarProperty extends Property {
  protected constructor(subtype: NodeSubtype, loc: DocumentLocation, id: Identifier) {
    super('Scalar', subtype, loc, id);
  }

  override get kind(): NodeKind {
    return this.getSubtype() === 'Runtime' ? 'runtime' : 'scalar';
  }

  override getpProp(id: PropertyId | Identifier): Property | undefined {
    const name = toIdentifier(id).getName();
    return this.err(`Invalid request for property: '${name}'`);
  }

  override getp(id: PropertyId): PropertyNode | undefined {
    // Frozen semantics: an absent child is `undefined` (the native path above errors).
    void id;
    return undefined;
  }

  override props(): readonly Property[] {
    return [];
  }

  override elements(): readonly PropertyNode[] {
    return requireElements(this);
  }

  override size(): number {
    return 0;
  }

  /** Native `__ScalarProperty::operator std::string()` / `getEvaledString()`. */
  override scalarText(): string {
    return this.getEvaledString();
  }

  protected abstract getEvaledString(): string;
}

/** Native `class ConstScalarProperty`: a const scalar, i.e. an expression to evaluate. */
export class ConstScalarProperty extends __ScalarProperty {
  private readonly expr: Expression;
  private readonly evaluator: ExpressionEvaluator;

  constructor(loc: DocumentLocation, id: Identifier, expr: Expression, evaluator: ExpressionEvaluator) {
    super('Const', loc, id);
    this.expr = expr;
    this.evaluator = evaluator;
  }

  /** Native `ConstScalarProperty::getExpression()`. */
  getExpression(): Expression {
    return this.expr;
  }

  protected override getEvaledString(): string {
    return this.evaluator.evaluate(this.expr, this);
  }

  override clone(cloneId: Identifier): Property {
    return this.baseClone(
      new ConstScalarProperty(this.getLocation(), cloneId, this.expr.clone(), this.evaluator),
    );
  }
}

/** Native `class RuntimeScalarProperty`: a value the simulation owns; reading it is illegal. */
export class RuntimeScalarProperty extends __ScalarProperty {
  constructor(loc: DocumentLocation, id: Identifier) {
    super('Runtime', loc, id);
  }

  protected override getEvaledString(): string {
    return this.err('Illegal request for value of runtime property.');
  }

  override clone(_cloneId: Identifier): Property {
    // Native: "Clone runtime makes no sense." (assert(false)).
    return this.err('Cannot clone a runtime property.');
  }
}

/** Native `class DynamicScalarAttribute`: a `dyn` attribute (e.g. `attrs { update … }`). */
export class DynamicScalarAttribute extends Node {
  private readonly id: Identifier;
  private readonly expr: Expression;

  constructor(loc: DocumentLocation, id: Identifier, expr: Expression) {
    super('Attr', 'Dynamic', loc);
    this.id = id;
    this.expr = expr;
  }

  getName(): string {
    return this.id.getName();
  }

  getExpression(): Expression {
    return this.expr;
  }

  clone(): DynamicScalarAttribute {
    return new DynamicScalarAttribute(this.getLocation(), this.id, this.expr.clone());
  }
}

/** Native `class DynamicScalarProperty`: a `dyn` scalar (init expression + attributes). */
export class DynamicScalarProperty extends __ScalarProperty {
  private readonly initExpr: Expression;
  private readonly evaluator: ExpressionEvaluator;
  private readonly attrs = new Map<string, DynamicScalarAttribute>();

  constructor(
    loc: DocumentLocation,
    id: Identifier,
    initExpr: Expression,
    evaluator: ExpressionEvaluator,
  ) {
    super('Dynamic', loc, id);
    this.initExpr = initExpr;
    this.evaluator = evaluator;
  }

  /** Native `DynamicScalarProperty::getInitExpression()`. */
  getInitExpression(): Expression {
    return this.initExpr;
  }

  protected override getEvaledString(): string {
    return this.evaluator.evaluate(this.initExpr, this);
  }

  /** Native `DynamicScalarProperty::add( DynamicScalarAttribute * )`. */
  addAttribute(attr: DynamicScalarAttribute): void {
    const name = attr.getName();
    if (this.getAttr(name)) attr.err('Duplicate attribute.');
    this.attrs.set(name, attr);
    this.adopt(attr);
  }

  /** Native `DynamicScalarProperty::attrs()` — a `std::map`, so identifier order. */
  attrsInOrder(): DynamicScalarAttribute[] {
    return [...this.attrs.values()].sort((a, b) => identifierOrder(a.getName(), b.getName()));
  }

  /** Native `DynamicScalarProperty::getAttr( std::string )`. */
  getAttr(name: string): DynamicScalarAttribute | undefined {
    return this.attrs.get(name);
  }

  override clone(cloneId: Identifier): Property {
    const clone = new DynamicScalarProperty(
      this.getLocation(),
      cloneId,
      this.initExpr.clone(),
      this.evaluator,
    );
    for (const attr of this.attrs.values()) clone.addAttribute(attr.clone());
    return this.baseClone(clone);
  }
}

/**
 * Native `__ContainerProperty`: an object or an array. The only difference between the two
 * subclasses is the identifier shape they accept (`ObjectProperty` refuses index names,
 * `ArrayProperty` requires them) and their symbol lookup.
 */
export abstract class __ContainerProperty extends Property {
  private readonly table = new PropertyTable();

  protected constructor(type: NodeType, subtype: NodeSubtype, loc: DocumentLocation, id: Identifier) {
    super(type, subtype, loc, id);
  }

  override get kind(): NodeKind {
    return this.getType() === 'Array' ? 'array' : 'object';
  }

  /** Native `__ContainerProperty::add( Property * )` — duplicate names are fatal. */
  add(prop: Property): void {
    const name = prop.getName();
    if (this.table.get(name) !== undefined) {
      const previous = this.table.get(name);
      prop.err(
        `Duplicate property name '${name}' (see ${previous?.getLocation().getDescription() ?? '?'})`,
      );
    }
    this.table.set(name, prop);
    this.adopt(prop);
  }

  /** Native `__ContainerProperty::replace( Property * )`. */
  replace(newProp: Property): void {
    const oldProp = this.table.get(newProp.getName());
    if (oldProp === undefined) this.err(`Cannot replace missing property '${newProp.getName()}'`);
    this.table.set(newProp.getName(), newProp);
    this.adopt(newProp);
  }

  /** Native `__ContainerProperty::remove( Property * )` (`props().erase`). */
  remove(prop: Property): void {
    this.table.delete(prop.getName());
  }

  /** Native `__ContainerProperty::removeChildren()`. */
  removeChildren(): void {
    this.table.clear();
  }

  override getpProp(id: PropertyId | Identifier): Property | undefined {
    return this.table.get(toIdentifier(id).getName());
  }

  override getp(id: PropertyId): PropertyNode | undefined {
    return this.getpProp(id);
  }

  /** Native `__ContainerProperty::props()`. */
  override props(): readonly Property[] {
    return this.table.ordered();
  }

  override elements(): readonly PropertyNode[] {
    return this.props();
  }

  override size(): number {
    return this.table.size;
  }

  override scalarText(): string {
    return requireScalarText(this);
  }

  override __findLocalSymbol(path: SymbolPath, index: number): Symbol | undefined {
    const token = path.elements[index];
    if (token === undefined) return undefined;

    const child = this.table.get(token.text);
    if (child) {
      if (index + 1 < path.elements.length) return child.__findLocalSymbol(path, index + 1);
      return { type: 'Property', prop: child };
    }

    return super.__findLocalSymbol(path, index);
  }

  /** Native `__ContainerProperty::dump()` — a debugging aid. */
  dump(indent = ''): string {
    let out = `${indent}${this.getName()}\n${indent}{\n`;
    for (const prop of this.props()) {
      out += prop instanceof __ContainerProperty ? prop.dump(`${indent}  `) : `${indent}  ${prop.getName()}\n`;
    }
    out += `${indent}}\n`;
    return out;
  }
}

/** Native `class ObjectProperty`. */
export class ObjectProperty extends __ContainerProperty {
  private readonly classes = new Map<string, Class>();

  constructor(loc: DocumentLocation, id: Identifier, subtype: NodeSubtype = 'None') {
    super('Object', subtype, loc, id);
  }

  /** Native `ObjectProperty::add` — an index name is invalid here (assert in native). */
  override add(prop: Property): void {
    if (prop.getId().isIndex()) {
      this.err(`Illegal index name '${prop.getName()}' in an object property.`);
    }
    super.add(prop);
  }

  /** Native `ObjectProperty::addClass( Class * )`. */
  addClass(klass: Class): void {
    const key = klass.getId().getName();
    if (this.classes.has(key)) klass.err('Duplicate class');
    this.classes.set(key, klass);
    this.adopt(klass);
  }

  /** Native `ObjectProperty::getClass( const std::string & )`. */
  getClass(name: string): Class | undefined {
    return this.classes.get(name);
  }

  override clone(cloneId: Identifier): Property {
    const clone = new ObjectProperty(this.getLocation(), cloneId);
    for (const prop of this.props()) clone.add(prop.clone(prop.getId()));
    for (const klass of this.classes.values()) clone.addClass(klass.clone());
    return this.baseClone(clone);
  }

  override __findLocalSymbol(path: SymbolPath, index: number): Symbol | undefined {
    const token = path.elements[index];
    if (token !== undefined) {
      const klass = this.classes.get(token.text);
      if (klass) {
        if (index + 1 < path.elements.length) return klass.__findLocalSymbol(path, index + 1);
        return { type: 'Class', klass };
      }
    }

    return super.__findLocalSymbol(path, index);
  }
}

/** Native `class ArrayProperty`. */
export class ArrayProperty extends __ContainerProperty {
  constructor(loc: DocumentLocation, id: Identifier) {
    super('Array', 'None', loc, id);
  }

  /** Native `ArrayProperty::add` — a non-index name is invalid here (assert in native). */
  override add(prop: Property): void {
    if (!prop.getId().isIndex()) {
      this.err(`Illegal name '${prop.getName()}' in an array property.`);
    }
    super.add(prop);
  }

  override clone(cloneId: Identifier): Property {
    const clone = new ArrayProperty(this.getLocation(), cloneId);
    for (const prop of this.props()) clone.add(prop.clone(prop.getId()));
    return this.baseClone(clone);
  }
}

/**
 * Native `class Document`: an `ObjectProperty` that also carries the `@`-meta properties.
 * `name` is the document path in every construction the front end performs
 * (`new Document( path, path )`), which is also why `DocumentLocation::getPath()` gives the
 * file name and why the writer's ordering separates documents by path first.
 */
export class Document extends ObjectProperty {
  private readonly docPath: string;
  private readonly metaprops = new Map<string, MetaProperty>();

  constructor(name: string, path: string) {
    super(new DocumentLocation(undefined, 0), new Identifier(name), 'Document');
    // Native `DocumentLocation( this, 0 )`: the location refers back to the document, which
    // is what `getDescription()` needs for an error inside the document itself.
    this.getLocation().document = this;
    this.docPath = path;
  }

  /** Native `Document::getPath()`. */
  getPath(): string {
    return this.docPath;
  }

  /** Native `Document::hasMeta`. */
  hasMeta(name: string): boolean {
    return this.metaprops.has(name);
  }

  /** Native `Document::getMeta`. */
  getMeta(name: string): MetaProperty | undefined {
    return this.metaprops.get(name);
  }

  /** Native `Document::addMeta` — a duplicate is fatal. */
  addMeta(prop: MetaProperty): void {
    const key = prop.getId().getName();
    if (this.hasMeta(key)) prop.err('Duplicate meta property');
    this.metaprops.set(key, prop);
    this.adopt(prop);
  }

  /** Native `Document::metaprops()` — a `std::map`, i.e. identifier order. */
  metapropsInOrder(): MetaProperty[] {
    return [...this.metaprops.values()].sort((a, b) =>
      identifierOrder(a.getId().getName(), b.getId().getName()),
    );
  }

  /** Native `DocumentEditor::setMeta` writes into the map directly (no duplicate check). */
  setMetaDirect(prop: MetaProperty): void {
    this.metaprops.set(prop.getId().getName(), prop);
  }
}

// --------------------------------------------------------------------------------------
// Coercion helpers used by the proplib front end itself
// --------------------------------------------------------------------------------------
//
// Native reads a value with `operator int()/float()/bool()/string()`, and a *container*
// read fails with a type-specific message ("Expecting Int", …). The coercion logic itself
// lives once, in `src/model/types/scalar.ts` (lane W1a); these four wrappers only add the
// native container failure and hand the *evaluated* text to it, so proplib never defines a
// second coercion.

/** Native `Property::err` as a standalone call: never-returning, so it narrows in TypeScript. */
export function fatal(prop: Property, message: string): never {
  return prop.err(message);
}

/** Native `(string)prop`. */
export function propString(prop: Property): string {
  return nativeString(prop.scalarText());
}

/** Native `(int)prop`. */
export function propInt(prop: Property): number {
  if (prop.getType() !== 'Scalar') prop.err('Expecting Int');
  return nativeInt(prop.scalarText(), prop.getLocation().getDescription());
}

/** Native `(float)prop`. */
export function propFloat(prop: Property): number {
  if (prop.getType() !== 'Scalar') prop.err('Expecting Float');
  return nativeFloat(prop.scalarText(), prop.getLocation().getDescription());
}

/** Native `(bool)prop`. */
export function propBool(prop: Property): boolean {
  if (prop.getType() !== 'Scalar') prop.err('Expecting Bool');
  return nativeBool(prop.scalarText(), prop.getLocation().getDescription());
}
