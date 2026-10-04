/**
 * Lane W1b — the schema (native `proplib/schema.{h,cc}`, class `SchemaDocument`).
 *
 * The schema is what turns a 10-line worldfile into the 465-line `run/normalized.wf`: every
 * property the worldfile does not set is created from the schema's `default`, and every
 * value is then type-checked, range-checked and asserted. Four passes, in this order
 * (`SchemaDocument::apply`):
 *
 *   parseDefaults   read `@defaults` from the worldfile's meta: the list of *variant*
 *                   default-sets to prefer (`SeedAgents { defaults { default InitAgents;
 *                   legacy 0 } }` picks `legacy 0` when `@defaults legacy` is present)
 *   overlay         apply an embedded `overlay` block, if the worldfile has one
 *   normalize       inject the defaults / runtime properties, and attach each value to its
 *                   schema (`setSchema`), which is also what wires symbol resolution
 *   validate        type, `min`/`exmin`/`max`/`exmax`, enum membership, `assert`
 *
 * PORT-NOTE(proplib/schema-injected-default-location): an injected default is a *clone of
 * the schema's `default` property*, so it keeps the schema's file/line/token location. That
 * single fact is why `normalized.wf`'s schema block comes out in schema order (the writer
 * orders by location) and why an injected value's text and indentation are the schema's.
 * Do not "clean up" the location of an injected property.
 *
 * PORT-NOTE(proplib/validate-option): `validate()` is a read-only pass — it evaluates
 * values and throws; it never mutates the document. Because the values it must evaluate are
 * full expressions (lane L4 — a real evaluator is required for `assert ( InitAgents >=
 * MinAgents … ) or AdaptivityMode`), `apply()` takes `validate` (default **true**, the
 * faithful behavior) so that a caller without a real evaluator can still build the document
 * *and say so*: `emitNormalizedWorldfile` passes `validate: false` with the literal-only
 * evaluator, and the emitted bytes are unaffected because validate cannot change the DOM.
 * See PARITY.md → Gaps: "expression evaluation in the schema pass" → lane L4.
 */

import { DocumentBuilder, STANDARD_TYPES } from './builder';
import { DocumentEditor } from './editor';
import {
  Document,
  Identifier,
  ObjectProperty,
  Property,
  RuntimeScalarProperty,
  __ContainerProperty,
  fatal,
  propBool,
  propFloat,
  propInt,
  propString,
} from './dom';
import type { SymbolPath } from './expression';
import { Overlay } from './overlay';

/** Options for `SchemaDocument.apply`. */
export interface ApplyOptions {
  /** Run the validation pass (default: true, as native). */
  readonly validate?: boolean;
}

export class SchemaDocument extends Document {
  /** Native `SchemaDocument::lenient`: allow values with no schema definition. */
  lenient = false;

  /** Native `SchemaDocument::_defaults`: the `@defaults` variant list, in order. */
  private defaults: string[] = [];

  constructor(name: string, path: string) {
    super(name, path);
  }

  /** Native `SchemaDocument::init()`: fold the file's `class` definitions into their uses. */
  init(): void {
    this.injectClasses(this);
  }

  /** Native `SchemaDocument::apply( doc )`. */
  apply(doc: Document, options: ApplyOptions = {}): void {
    this.parseDefaults(doc);

    if (doc.getpProp('overlay')) {
      const editor = new DocumentEditor(this, doc);
      new Overlay().applyEmbedded(doc, editor);
    }

    this.normalize(this, doc);

    if (options.validate ?? true) this.validate(doc);
  }

  /** Native `SchemaDocument::makePathDefaults( values, symbolPath )`. */
  makePathDefaults(values: Document, symbolPath: SymbolPath): void {
    this.parseDefaults(values);
    this.makePathDefaultsInternal(this, values, symbolPath, 0);
  }

  /** Native `SchemaDocument::injectClasses( prop )`. */
  private injectClasses(prop: Property): void {
    if (prop.getType() !== 'Object') return;

    const object = prop as ObjectProperty;
    const propType = object.getpProp('type');

    if (propType) {
      const type = propString(propType);
      if (!STANDARD_TYPES.includes(type)) {
        const builder = new DocumentBuilder();
        const symbolPath = builder.buildSymbolPath(type);
        const sym = object.findSymbol(symbolPath);

        if (!sym) fatal(propType, 'Invalid type name.');
        if (sym.type !== 'Class') fatal(propType, 'Expecting class name.');

        const editor = new DocumentEditor(this, this);
        editor.set(propType, 'Object');
        object.add(sym.klass.getDefinition().clone(new Identifier('properties')));
      }
    }

    for (const child of object.props()) this.injectClasses(child);
  }

  /** Native `SchemaDocument::normalize( propertySchema, propertyValue )`. */
  private normalize(propertySchema: ObjectProperty, propertyValue: Property): void {
    propertyValue.setSchema(propertySchema);

    const type = propString(propertySchema.requireProp('type'));

    if (type === 'Object') {
      if (propertyValue.getType() !== 'Object') {
        propertyValue.err('Schema specifies this property as an Object.');
      }
      this.normalizeObject(propertySchema, propertyValue);
    } else if (type === 'Array') {
      if (propertyValue.getType() !== 'Array') {
        propertyValue.err('Schema specifies this property as an Array.');
      }
      this.normalizeArray(propertySchema, propertyValue);
    } else if (type === 'Enum') {
      const values = propertySchema.getEnum('Values');
      if (!values) propertySchema.err("Invalid schema. Enum type without 'Values'.");
      propertyValue.addEnum(values);
    }
  }

  /** Native `SchemaDocument::normalizeObject( objectSchema, objectValue )`. */
  private normalizeObject(objectSchema: ObjectProperty, objectValue: Property): void {
    if (!(objectValue instanceof __ContainerProperty)) {
      objectValue.err('Schema specifies this property as an Object.');
    }

    const propertiesSchema = objectSchema.requireProp('properties');
    if (propertiesSchema.getType() !== 'Object') {
      propertiesSchema.err("Invalid schema. 'properties' must be an Object.");
    }

    // --- Inject Default & Runtime Properties ---
    for (const propertySchema_ of propertiesSchema.props()) {
      if (propertySchema_.getType() !== 'Object') {
        propertySchema_.err('Invalid schema. Expecting Object describing a property.');
      }
      const propertySchema = propertySchema_ as ObjectProperty;
      const name = propertySchema.getName();

      const propRuntime = propertySchema.getpProp('runtime');
      if (propRuntime && propBool(propRuntime)) {
        if (objectValue.getpProp(name)) {
          objectValue.requireProp(name).err('Cannot assign value to runtime property.');
        }
        objectValue.add(new RuntimeScalarProperty(propertySchema.getLocation(), propertySchema.getId()));
      } else if (objectValue.getpProp(name) === undefined) {
        const propDefault = this.createDefault(propertySchema);

        if (propDefault === null) {
          const propOptional = propertySchema.getpProp('optional');
          if (!propOptional || !propBool(propOptional)) {
            objectValue.err(`Missing property ${name}`);
          }
        } else {
          objectValue.add(propDefault);
        }
      }
    }

    // --- Normalize Children ---
    for (const childSchema_ of propertiesSchema.props()) {
      if (childSchema_.getType() !== 'Object') {
        childSchema_.err('Expecting property schema definition, which should be an object.');
      }
      const childSchema = childSchema_ as ObjectProperty;
      const childValue = objectValue.getpProp(childSchema.getName());

      if (childValue) {
        this.normalize(childSchema, childValue);
      } else {
        // Native `assert( (bool)childSchema.get("optional") )`. The invariant holds by the
        // time this loop runs (a child with no value and no default already failed above),
        // so the port keeps the assert enabled rather than compiling it out.
        const optional = childSchema.getpProp('optional');
        if (!optional || !propBool(optional)) {
          fatal(childSchema, `Missing optional flag for '${childSchema.getName()}'`);
        }
      }
    }
  }

  /** Native `SchemaDocument::normalizeArray( propertySchema, propertyValue )`. */
  private normalizeArray(propertySchema: ObjectProperty, propertyValue: Property): void {
    const elementSchema_ = propertySchema.requireProp('element');
    if (elementSchema_.getType() !== 'Object') {
      elementSchema_.err("Illegal schema. 'element' should be an Object.");
    }
    const elementSchema = elementSchema_ as ObjectProperty;

    for (const element of propertyValue.props()) this.normalize(elementSchema, element);
  }

  // --- validation -----------------------------------------------------------------------

  /** Native `SchemaDocument::validate( propertyValue )`. */
  private validate(propertyValue: Property): void {
    if (
      propertyValue.getName() === 'overlay' &&
      propertyValue.getParent()?.getSubtype() === 'Document'
    ) {
      return;
    }

    const schema = propertyValue.getSchema();
    if (schema === undefined) {
      if (!this.lenient) propertyValue.err('No definition in schema.');
      return;
    }

    if (propertyValue.getSubtype() === 'Dynamic') {
      if (!propertyValue.hasBinding()) {
        propertyValue.err("Properties without 'cppsym' may not use dyn expressions.");
      }
    }

    if (propertyValue.getSubtype() === 'Runtime') {
      if (!propertyValue.hasBinding()) propertyValue.err("Runtime properties must define 'cppsym'.");
      // Runtime properties are controlled by the simulation.
      return;
    }

    const type = propString(schema.requireProp('type'));

    if (type === 'Array') this.validateArray(propertyValue);
    else if (type === 'Object') this.validateObject(propertyValue);
    else if (type === 'Enum') this.validateEnum(propertyValue);
    else this.validateScalarValue(propertyValue);
  }

  /** Native `SchemaDocument::validateScalar( propertyValue )`. */
  private validateScalarValue(propertyValue: Property): void {
    const schema = propertyValue.getSchema();
    if (!schema) fatal(propertyValue, 'No definition in schema.');
    this.validateScalar(schema, propertyValue);
  }

  /** Native `SchemaDocument::validateScalar( schema, value )`. */
  private validateScalar(schema: ObjectProperty, value: Property): void {
    const type = propString(schema.requireProp('type'));

    // `__test_cast(TYPE)`: coerce the value now, so a wrong type fails here (and only here).
    if (type === 'Int') propInt(value);
    else if (type === 'Float') propFloat(value);
    else if (type === 'Bool') propBool(value);
    else if (type === 'String') propString(value);
    else schema.requireProp('type').err('Invalid scalar type.');

    for (const attr of schema.props()) {
      const attrName = attr.getName();

      const constraint = (op: (a: number, b: number) => boolean, errDesc: string): void => {
        let valid = true;

        if (type === 'Int') valid = op(propInt(value), propInt(attr));
        else if (type === 'Float') valid = op(propFloat(value), propFloat(attr));
        else attr.err(`'${attrName}' is not valid for type ${type}`);

        if (!valid) value.err(`${propString(value)} ${errDesc} ${attrName} ${propString(attr)}`);
      };

      if (attrName === 'min') {
        constraint((a, b) => a >= b, '<');
      } else if (attrName === 'exmin') {
        constraint((a, b) => a > b, '<=');
      } else if (attrName === 'max') {
        constraint((a, b) => a <= b, '>');
      } else if (attrName === 'exmax') {
        constraint((a, b) => a < b, '>=');
      } else {
        this.validateCommonAttribute(attr, value);
      }
    }
  }

  /** Native `SchemaDocument::validateEnum( propertyValue )`. */
  private validateEnum(propertyValue: Property): void {
    const schema = propertyValue.getSchema();
    if (!schema) fatal(propertyValue, 'No definition in schema.');

    const enum_ = schema.getEnum('Values');
    if (!enum_) fatal(schema, "Invalid schema. Enum type without 'Values'.");

    if (!enum_.contains(propString(propertyValue))) {
      const scalarSchema = schema.getpProp('scalar');
      if (!scalarSchema) fatal(propertyValue, 'Invalid enum value.');
      if (scalarSchema.getType() !== 'Object') {
        fatal(scalarSchema, 'Invalid schema. Scalar definition must be object.');
      }
      this.validateScalar(scalarSchema as ObjectProperty, propertyValue);
    }

    for (const attr of schema.props()) {
      if (attr.getName() === 'scalar') continue;
      this.validateCommonAttribute(attr, propertyValue);
    }
  }

  /** Native `SchemaDocument::validateObject( propertyValue )`. */
  private validateObject(propertyValue: Property): void {
    if (propertyValue.getType() !== 'Object') fatal(propertyValue, 'Expecting Object.');

    const schema = propertyValue.getSchema();
    if (!schema) fatal(propertyValue, 'No definition in schema.');

    for (const attr of schema.props()) {
      if (attr.getName() === 'properties') continue;
      this.validateCommonAttribute(attr, propertyValue);
    }

    for (const child of propertyValue.props()) this.validate(child);
  }

  /** Native `SchemaDocument::validateArray( propertyValue )`. */
  private validateArray(propertyValue: Property): void {
    if (propertyValue.getType() !== 'Array') fatal(propertyValue, 'Expecting Array.');

    const schema = propertyValue.getSchema();
    if (!schema) fatal(propertyValue, 'No definition in schema.');

    for (const attr of schema.props()) {
      const attrName = attr.getName();

      const constraint = (op: (a: number, b: number) => boolean, errDesc: string): void => {
        const valid = op(propertyValue.props().length, propInt(attr));
        if (!valid) {
          propertyValue.err(
            `Element count ${errDesc} ${attrName} ${propString(attr)}`,
          );
        }
      };

      if (attrName === 'min') {
        constraint((a, b) => a >= b, '<');
      } else if (attrName === 'exmin') {
        constraint((a, b) => a > b, '<=');
      } else if (attrName === 'max') {
        constraint((a, b) => a <= b, '>');
      } else if (attrName === 'exmax') {
        constraint((a, b) => a < b, '>=');
      } else if (attrName === 'element') {
        // no-op
      } else {
        this.validateCommonAttribute(attr, propertyValue);
      }
    }

    for (const element of propertyValue.props()) this.validate(element);
  }

  /** Native `SchemaDocument::validateCommonAttribute( attr, value )`. */
  private validateCommonAttribute(attr: Property, value: Property): void {
    const attrName = attr.getName();

    if (attrName === 'assert') {
      if (!propBool(attr)) {
        value.err(`Failed assertion at ${attr.getLocation().getDescription()}`);
      }
    } else if (
      attrName === 'cpptype' ||
      attrName === 'cppsym' ||
      attrName === 'type' ||
      attrName === 'default' ||
      attrName === 'defaults' ||
      attrName === 'optional'
    ) {
      // no-op
    } else {
      attr.err('Invalid schema attribute.');
    }
  }

  // --- defaults -------------------------------------------------------------------------

  /** Native `SchemaDocument::parseDefaults( doc )`. */
  private parseDefaults(doc: Document): void {
    this.defaults = [];

    const meta = doc.getMeta('@defaults');
    if (!meta) return;

    for (const value of meta.getValue().split(/\s+/).filter((token) => token.length > 0)) {
      const last = value[value.length - 1] as string;

      if (last === '.') {
        this.defaults.push(value.slice(0, -1));
      } else if (last >= '0' && last <= '9') {
        let digitStart = value.length - 1;
        while (digitStart > 0) {
          const c = value[digitStart - 1] as string;
          if (c < '0' || c > '9') break;
          digitStart--;
        }
        const prefix = value.slice(0, digitStart);
        const num = Number.parseInt(value.slice(digitStart), 10);
        // Native asserts `num < 200` (sanity check) and expands downwards, 0 last.
        if (num >= 200) throw new Error(`@defaults index too large: ${value}`);
        for (let n = num; n >= 0; n--) this.defaults.push(`${prefix}${n}`);
      } else {
        this.defaults.push(value);
      }
    }
  }

  /** Native `SchemaDocument::createDefault( schema )` (null when there is none). */
  private createDefault(schema: Property): Property | null {
    let propDefault = schema.getpProp('default');

    if (!propDefault) {
      const propDefaults = schema.getpProp('defaults');
      if (propDefaults) {
        for (const name of this.defaults) {
          propDefault = propDefaults.getpProp(name);
          if (propDefault) break;
        }
        if (!propDefault) propDefault = propDefaults.getpProp('default');
      }
    } else if (schema.getpProp('defaults')) {
      propDefault.err("If 'defaults' exists, 'default' must be a child of it.");
    }

    if (!propDefault) return null;
    return propDefault.clone(schema.getId());
  }

  /** Native `SchemaDocument::makePathDefaults( schema, value, pathElement )`. */
  private makePathDefaultsInternal(
    schema: ObjectProperty,
    value: __ContainerProperty,
    path: SymbolPath,
    index: number,
  ): void {
    const pathElement = path.elements[index];
    if (!pathElement) return;

    const type = propString(schema.requireProp('type'));
    const childName = pathElement.text;
    const hasNext = index + 1 < path.elements.length;

    if (type === 'Array') {
      if (!hasNext) schema.err('Unexpected array index as end of symbol path');
      if (value.getType() !== 'Array') value.err('Expecting array');

      const schemaChild = schema.requireProp('element');
      const valueChild = value.requireProp(childName);

      if (valueChild.getType() === 'Scalar') valueChild.err('Unexpected scalar');

      this.makePathDefaultsInternal(
        asObject(schemaChild),
        asContainer(valueChild),
        path,
        index + 1,
      );
      return;
    }

    if (type === 'Object') {
      const properties = schema.requireProp('properties');
      const schemaChild = properties.requireProp(childName);

      if (value.getpProp(childName) === undefined) {
        const defaultProperty = this.createDefault(schemaChild);
        if (defaultProperty === null) schema.err(`No default for ${childName}`);
        value.add(defaultProperty);
      }

      if (!hasNext) return;

      const valueChild = value.requireProp(childName);
      if (valueChild.getType() === 'Scalar') valueChild.err('Unexpected scalar');

      this.makePathDefaultsInternal(asObject(schemaChild), asContainer(valueChild), path, index + 1);
      return;
    }

    value.err('Expecting Object or Array');
  }
}

/** Native `dynamic_cast<ObjectProperty &>` on a schema node (a failed cast is fatal). */
function asObject(prop: Property): ObjectProperty {
  if (!(prop instanceof ObjectProperty)) prop.err('Expecting Object.');
  return prop;
}

/** Native `dynamic_cast<__ContainerProperty &>` on a document node (a failed cast is fatal). */
function asContainer(prop: Property): __ContainerProperty {
  if (!(prop instanceof __ContainerProperty)) prop.err('Expecting Object or Array');
  return prop;
}
