/**
 * Lane W1b — document builder (native `proplib/builder.{h,cc}`).
 *
 * Turns the parse tree into the DOM. Four entry points, matching native:
 *
 *   buildDocumentText        a document (used by `proputil` and the schema itself)
 *   buildSchemaDocument      the schema: injects `type`/`properties`/`__types`, then `init()`
 *   buildWorldfileDocument   a worldfile, incl. v1→v2 conversion and the deprecated-v2
 *                            conversions, plus `--Param value` overrides
 *   buildSymbolPath/buildProperty/buildMetaProperty   synthesised text (`editor.set`)
 *
 * PORT-NOTE(proplib/builder-takes-text): native reads `path` from the filesystem
 * (`new ifstream(path)`) and `cp`s the worldfile next to the run. The port takes the
 * document *text* and keeps the path only as the document's identity (name/path, and the
 * first key of `DocumentLocation` ordering). This keeps `src/model/**` free of `node:fs` so
 * the same code runs in the browser; the CLI (`cli.ts`) does the reading.
 *
 * PORT-NOTE(proplib/v1-conversion-path): native converts a v1 worldfile to
 * `<path>.v2` *on disk* and parses that, so the document's path — and therefore its
 * ordering key — becomes `…/x.wf.v2`. The port converts in memory and keeps the same
 * synthetic `.v2` identity.
 */

import {
  ArrayProperty,
  Class,
  ConstScalarProperty,
  Document,
  DocumentLocation,
  DynamicScalarAttribute,
  DynamicScalarProperty,
  Identifier,
  MetaProperty,
  ObjectProperty,
  ProplibEnum,
  Property,
} from './dom';
import { DocumentEditor } from './editor';
import type { ExpressionEvaluator } from './evaluator';
import { interpreterEvaluator } from './evaluator';
import { Expression, SymbolPath } from './expression';
import { tokenToString } from './lexer';
import { Parser } from './parser';
import type { SchemaDocument } from './schema';
import type { SyntaxNode } from './syntax';
import { WorldfileConverter } from './convert';

/** Native `typedef std::map<std::string, std::string> ParameterMap` (ordered by key). */
export type ParameterMap = ReadonlyMap<string, string>;

/** A worldfile whose text was converted from v1 to v2 (native writes `<path>.v2`). */
export interface ConvertedSource {
  readonly path: string;
  readonly source: string;
}

export class DocumentBuilder {
  private path = '<string>';
  private doc: Document | undefined;

  constructor(private readonly evaluator: ExpressionEvaluator = interpreterEvaluator) {}

  /** Native `DocumentBuilder::buildDocument( path )`. */
  buildDocumentText(path: string, source: string): Document {
    const node = new Parser().parseDocument(path, source);

    this.path = path;
    const doc = new Document(path, path);
    this.doc = doc;

    this.buildDocument(node);

    return doc;
  }

  /**
   * Native `DocumentBuilder::buildWorldfileDocument( schema, path )` — including the v1 and
   * deprecated-v2 conversions. `source` is the worldfile text; `isV1Source` decides whether
   * the v1 syntax conversion runs.
   */
  buildWorldfileDocumentText(schema: SchemaDocument, path: string, source: string): Document {
    let docPath = path;
    let docSource = source;

    if (isV1Source(source)) {
      docPath = `${path}.v2`;
      docSource = new WorldfileConverter().convertV1SyntaxToV2Text(source);
    }

    const node = new Parser().parseDocument(docPath, docSource);

    this.path = docPath;
    const doc = new Document(docPath, docPath);
    this.doc = doc;

    this.buildDocument(node);

    const editor = new DocumentEditor(schema, doc);
    if (isV1Source(source)) new WorldfileConverter().convertV1PropertiesToV2(editor, doc);
    new WorldfileConverter().convertDeprecatedV2Properties(editor, doc);

    return doc;
  }

  /** Native `DocumentBuilder::buildWorldfileDocument( schema, path, parameters )`. */
  buildWorldfileDocumentTextWithParameters(
    schema: SchemaDocument,
    path: string,
    source: string,
    parameters: ParameterMap,
  ): Document {
    const doc = this.buildWorldfileDocumentText(schema, path, source);
    new WorldfileConverter().setParameters(new DocumentEditor(schema, doc), parameters);
    return doc;
  }

  /** Native `DocumentBuilder::buildSchemaDocument( path )`. */
  buildSchemaDocumentText(path: string, source: string, makeSchema: (name: string, path: string) => SchemaDocument): SchemaDocument {
    const node = new Parser().parseDocument(path, source);

    const doc = makeSchema(path, path);

    // The schema file does not have a 'type' attribute at the top-level, so inject one.
    doc.add(this.buildProperty(new DocumentLocation(doc), 'type', 'Object'));

    // The schema file does not have a 'properties' attribute at the top-level, so inject one.
    const properties = new ObjectProperty(new DocumentLocation(doc), new Identifier('properties'));
    doc.add(properties);

    // The schema file does not declare this enum of types, so inject it.
    const types = new ProplibEnum(new DocumentLocation(doc), new Identifier('__types'));
    for (const type of STANDARD_TYPES) types.addValue(type);
    doc.addEnum(types);

    this.path = path;
    this.doc = doc;
    this.buildDocument(node, properties);

    doc.init();

    return doc;
  }

  /** Native `DocumentBuilder::buildSymbolPath( text )`. */
  buildSymbolPath(text: string): SymbolPath {
    const node = new Parser().parseSymbolPath(text);

    this.path = '<string>';
    this.doc = undefined;

    return this.buildSymbolPathFromNode(node);
  }

  /** Native `DocumentBuilder::buildMetaProperty( loc, id, value )`. */
  buildMetaProperty(loc: DocumentLocation, id: Identifier, value: string): MetaProperty {
    this.doc = loc.getDocument();
    this.path = this.doc?.getPath() ?? '<string>';

    const node = new Parser().parseMetaPropertyValue(value);

    return this.buildMetaPropertyFromNode(loc, id, node);
  }

  /** Native `DocumentBuilder::buildProperty( loc, id, value )`. */
  buildProperty(loc: DocumentLocation, id: Identifier | string, value: string): Property {
    this.doc = loc.getDocument();
    this.path = this.doc?.getPath() ?? '<string>';

    const identifier = id instanceof Identifier ? id : new Identifier(id);
    const node = new Parser().parsePropertyValue(value);

    return this.buildPropertyFromValueNode(loc, identifier, node);
  }

  private createLocation(node: SyntaxNode): DocumentLocation {
    return new DocumentLocation(this.doc, node.beginToken.lineno, node.beginToken, node.endToken);
  }

  private createId(node: SyntaxNode): Identifier {
    return new Identifier(node.beginToken.text);
  }

  /** Native `DocumentBuilder::buildDocument( node, rootContainer )`. */
  buildDocument(node: SyntaxNode, rootContainer?: ObjectProperty): void {
    const doc = this.requireDoc();

    for (let i = 0; i < node.children.length - 1; i++) {
      const nodeProp = node.children[i];
      if (!nodeProp) continue;
      const idNode = nodeProp.children[0];
      const valueNode = nodeProp.children[1];
      if (!idNode || !valueNode) continue;
      doc.addMeta(
        this.buildMetaPropertyFromNode(this.createLocation(nodeProp), this.createId(idNode), valueNode),
      );
    }

    const last = node.children[node.children.length - 1];
    if (!last) return;
    this.buildObjectPropertyInto(rootContainer ?? doc, last);
  }

  private requireDoc(): Document {
    if (!this.doc) throw new Error('DocumentBuilder: no document under construction');
    return this.doc;
  }

  private buildMetaPropertyFromNode(
    loc: DocumentLocation,
    id: Identifier,
    nodeValue: SyntaxNode,
  ): MetaProperty {
    const value =
      nodeValue.children.length === 0
        ? ''
        : tokenToString(nodeValue.beginToken, nodeValue.endToken, false);

    return new MetaProperty(loc, id, value);
  }

  private buildPropertyFromNode(node: SyntaxNode): Property {
    const idNode = node.children[0];
    const valueNode = node.children[1];
    if (!idNode || !valueNode) throw new Error('DocumentBuilder: malformed property node');
    return this.buildPropertyFromValueNode(this.createLocation(node), this.createId(idNode), valueNode);
  }

  private buildPropertyFromValueNode(
    loc: DocumentLocation,
    id: Identifier,
    nodeValue: SyntaxNode,
  ): Property {
    const first = nodeValue.children[0];
    if (!first) throw new Error('DocumentBuilder: empty property value');

    switch (first.type) {
      case 'Expression':
        return this.buildConstScalarProperty(loc, id, nodeValue);
      case 'Dyn':
        return this.buildDynamicScalarProperty(loc, id, nodeValue);
      case 'Object':
        return this.buildObjectProperty(loc, id, nodeValue);
      case 'Array':
        return this.buildArrayProperty(loc, id, nodeValue);
      default:
        throw new Error(`DocumentBuilder: unexpected value node ${first.type}`);
    }
  }

  private buildConstScalarProperty(loc: DocumentLocation, id: Identifier, nodeValue: SyntaxNode): Property {
    const exprNode = nodeValue.children[0];
    if (!exprNode) throw new Error('DocumentBuilder: missing expression');
    return new ConstScalarProperty(loc, id, this.buildExpression(exprNode), this.evaluator);
  }

  private buildDynamicScalarProperty(
    loc: DocumentLocation,
    id: Identifier,
    nodeValue: SyntaxNode,
  ): Property {
    const nodeDyn = nodeValue.children[0];
    if (!nodeDyn) throw new Error('DocumentBuilder: missing dyn node');

    const initNode = nodeDyn.children[0];
    if (!initNode) throw new Error('DocumentBuilder: missing dyn init expression');

    const prop = new DynamicScalarProperty(loc, id, this.buildExpression(initNode), this.evaluator);

    for (let i = 1; i < nodeDyn.children.length; i++) {
      const child = nodeDyn.children[i];
      if (child) prop.addAttribute(this.buildDynamicScalarAttribute(child));
    }

    return prop;
  }

  private buildObjectProperty(loc: DocumentLocation, id: Identifier, nodeValue: SyntaxNode): ObjectProperty {
    const obj = new ObjectProperty(loc, id);
    const objectNode = nodeValue.children[0];
    if (!objectNode) throw new Error('DocumentBuilder: missing object node');
    return this.buildObjectPropertyInto(obj, objectNode);
  }

  private buildObjectPropertyInto(obj: ObjectProperty, nodeObject: SyntaxNode): ObjectProperty {
    for (const childNode of nodeObject.children) {
      switch (childNode.type) {
        case 'Property':
          obj.add(this.buildPropertyFromNode(childNode));
          break;
        case 'Enum':
          obj.addEnum(this.buildEnum(childNode));
          break;
        case 'Class':
          obj.addClass(this.buildClass(childNode));
          break;
        default:
          throw new Error(`DocumentBuilder: unexpected object child ${childNode.type}`);
      }
    }
    return obj;
  }

  private buildArrayProperty(loc: DocumentLocation, id: Identifier, nodeValue: SyntaxNode): Property {
    const arrayNode = nodeValue.children[0];
    if (!arrayNode) throw new Error('DocumentBuilder: missing array node');

    const prop = new ArrayProperty(loc, id);
    let index = 0;

    for (const childNode of arrayNode.children) {
      const element = this.buildPropertyFromValueNode(
        this.createLocation(childNode),
        new Identifier(index++),
        childNode,
      );
      prop.add(element);
    }

    return prop;
  }

  private buildDynamicScalarAttribute(node: SyntaxNode): DynamicScalarAttribute {
    switch (node.type) {
      case 'DynAttr': {
        const idNode = node.children[0];
        const exprNode = node.children[1];
        if (!idNode || !exprNode) throw new Error('DocumentBuilder: malformed dyn attribute');
        return new DynamicScalarAttribute(this.createLocation(node), this.createId(idNode), this.buildExpression(exprNode));
      }
      case 'CppClause':
        // A bare `{ … }` clause inside a `dyn` is the `update` attribute.
        return new DynamicScalarAttribute(
          this.createLocation(node),
          new Identifier('update'),
          this.buildExpression(node),
        );
      default:
        throw new Error(`DocumentBuilder: unexpected dyn child ${node.type}`);
    }
  }

  private buildEnum(node: SyntaxNode): ProplibEnum {
    const idNode = node.children[0];
    const valuesNode = node.children[1];
    if (!idNode || !valuesNode) throw new Error('DocumentBuilder: malformed enum');

    const enum_ = new ProplibEnum(this.createLocation(node), this.createId(idNode));
    for (const valueNode of valuesNode.children) enum_.addValue(valueNode.beginToken.text);

    return enum_;
  }

  private buildClass(node: SyntaxNode): Class {
    const idNode = node.children[0];
    const objectNode = node.children[1];
    if (!idNode || !objectNode) throw new Error('DocumentBuilder: malformed class');

    const definition = new ObjectProperty(this.createLocation(node), new Identifier('definition'));
    this.buildObjectPropertyInto(definition, objectNode);

    return new Class(this.createLocation(node), this.createId(idNode), definition);
  }

  private buildExpression(node: SyntaxNode): Expression {
    const expression = new Expression();

    for (const elementNode of node.children) {
      switch (elementNode.type) {
        case 'SymbolPath':
          expression.elements.push({ kind: 'symbol', symbolPath: this.buildSymbolPathFromNode(elementNode) });
          break;
        case 'Misc':
          expression.elements.push({ kind: 'misc', token: elementNode.beginToken });
          break;
        default:
          throw new Error(`DocumentBuilder: unexpected expression element ${elementNode.type}`);
      }
    }

    return expression;
  }

  private buildSymbolPathFromNode(node: SyntaxNode): SymbolPath {
    const path = new SymbolPath();
    for (const elementNode of node.children) path.add(elementNode.beginToken);
    return path;
  }
}

/** Native `SchemaDocument::standardTypes`. */
export const STANDARD_TYPES: readonly string[] = [
  'Int',
  'Float',
  'Bool',
  'Object',
  'Array',
  'String',
  'Enum',
];

/**
 * Native `WorldfileConverter::isV1( path )`: a v1 file does not start with `@`.
 *
 * PORT-NOTE(proplib/isv1-empty-file): native `in.get() != '@'` is true for an empty file
 * too (the read fails and leaves -1), so an empty worldfile is reported as v1. Kept.
 */
export function isV1Source(source: string): boolean {
  return source.length === 0 || source[0] !== '@';
}
