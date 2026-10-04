/**
 * Lane W1a — the config accessor: typed reads of the normalized worldfile document.
 *
 * This is the port's stand-in for the native idiom the whole model is written in:
 *
 *   agent::config.maxVelocity = doc.get( "MaxVelocity" );     // float
 *   agent::config.vision      = doc.get( "Vision" );          // bool
 *   globals::numEnergyTypes   = doc.get( "NumEnergyTypes" );  // int
 *   proplib::Property &sheets = doc.get( "Sheets" );          // object, read further
 *   propBarriers.get( ibarrier ).get( "X1" );                 // array element -> child
 *
 * `Config` wraps any `PropertyNode` (the document root, or a sub-object such as `Sheets`)
 * and exposes the coercion as a named method, so a lane reads
 *
 *   const cfg = createConfig( doc );
 *   const vision = cfg.getBool( 'Vision' );
 *   const size   = cfg.at( 'Sheets' ).getInt( 'MinExplicitVectorSize' );
 *   const names  = cfg.getArray( 'FoodTypes' ).map( type => createConfig( type ).getString( 'Name' ) );
 *
 * Semantics are native's, not JS-nice's: no defaults, no lenient parsing, no coercion
 * between types. A missing property, a wrong type, or a value the C library would not
 * consume whole throws `ConfigError` (native: `err()` + `exit(1)`), because a config
 * value that silently reads as something else is indistinguishable from a divergence.
 * Use `has()` / `find()` when a property is genuinely optional (`doc.getp`).
 *
 * PORT-NOTE(types/config-accessor): the accessor is a thin façade over the document; all
 * coercion is `scalar.ts` (native `toInt`/`toFloat`/`toBool`), so `Config` adds lookup
 * and typing only. Lanes must not add their own parsing of worldfile text.
 */

import type { PropertyId, PropertyNode } from './property';
import {
  identifierName,
  isContainerNode,
  requireChild,
  requireElements,
  requireScalarText,
} from './property';
import { configError } from './errors';
import { nativeBool, nativeFloat, nativeInt, nativeString } from './scalar';

export class Config {
  /** The document node this accessor reads. Native: `proplib::Document &doc`. */
  readonly doc: PropertyNode;

  constructor(doc: PropertyNode) {
    this.doc = doc;
  }

  /** Native `doc.get( name )` — the raw node, for further walking. */
  node(id: PropertyId): PropertyNode {
    return requireChild(this.doc, id);
  }

  /** Native `doc.getp( name )` — the raw node, or undefined. */
  find(id: PropertyId): PropertyNode | undefined {
    return this.doc.getp(id);
  }

  /** True when the property exists (native: `getp(...) != NULL`). */
  has(id: PropertyId): boolean {
    return this.doc.getp(id) !== undefined;
  }

  /** A `Config` for a nested object, e.g. `cfg.at( 'Sheets' )`. Errors if it is not there. */
  at(...path: readonly PropertyId[]): Config {
    let node = this.doc;
    for (const id of path) node = requireChild(node, id);
    return new Config(node);
  }

  /** Native `(bool)doc.get( name )`. */
  getBool(id: PropertyId): boolean {
    return nativeBool(this.readScalar(id, 'Bool'), propertyWhere(this.doc, id));
  }

  /** Native `(int)doc.get( name )`. */
  getInt(id: PropertyId): number {
    return nativeInt(this.readScalar(id, 'Int'), propertyWhere(this.doc, id));
  }

  /** Native `(float)doc.get( name )` — rounded to `float` (f32). */
  getFloat(id: PropertyId): number {
    return nativeFloat(this.readScalar(id, 'Float'), propertyWhere(this.doc, id));
  }

  /** Native `(std::string)doc.get( name )` — the evaluated string, unconverted. */
  getString(id: PropertyId): string {
    return nativeString(requireScalarText(requireChild(this.doc, id)));
  }

  /**
   * Native `doc.get( name ).elements()`, in native map order (strcmp on the index name:
   * `"0","1","10","11","2",…` for an 11+ element array). Errors for a scalar node, as
   * `__ScalarProperty::props()` does.
   */
  getArray(id: PropertyId): readonly PropertyNode[] {
    return requireElements(requireChild(this.doc, id));
  }

  /**
   * Native `doc.get( name )` used as a container. Identical to `node()`; spelled out
   * because the native distinction between "scalar read" and "container read" is what
   * decides the coercion that runs.
   */
  getObject(id: PropertyId): PropertyNode {
    return requireChild(this.doc, id);
  }

  /**
   * The scalar side of a read: fetch the child and make sure it is a scalar, failing with
   * the wording native uses for *that* coercion (`__ContainerProperty::operator int()` is
   * `err( "Expecting Int" )`, and so on). Native can never reach the text conversion on a
   * container, so neither can the port.
   */
  private readScalar(id: PropertyId, expecting: 'Int' | 'Float' | 'Bool'): string {
    const node = requireChild(this.doc, id);
    if (isContainerNode(node)) {
      configError(propertyWhere(this.doc, id), `Expecting ${expecting}`);
    }
    return node.scalarText();
  }
}

/** `new Config( doc )` — the whole normalized worldfile document. */
export function createConfig(doc: PropertyNode): Config {
  return new Config(doc);
}

/** `parent.name/child` — what native `err()` reports through `DocumentLocation::getPath()`. */
function propertyWhere(parent: PropertyNode, id: PropertyId): string {
  const name = identifierName(id);
  return parent.name.length > 0 ? `${parent.name}/${name}` : name;
}
