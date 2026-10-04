/**
 * Lane W1b — the document writer (native `proplib/writer.{h,cc}`).
 *
 * `run/normalized.wf` is the output of this class, and getting it byte-exact is the whole
 * point of the lane. It is *not* a pretty-printer: it re-emits the tokens the document was
 * built from, so the text of a value is exactly the text it was parsed from, and the
 * whitespace/comments in front of each property are exactly the ones that preceded it in
 * its source file.
 *
 * Three rules produce the file, and all three are subtle:
 *
 *   1. **Order.** A container's children are sorted by `DocumentLocation` (path, line,
 *      token index), *not* by name and not by insertion. Because every schema-injected
 *      default carries the location of the schema's `default` node, the whole schema block
 *      of `normalized.wf` comes out in schema-declaration order, and because the schema's
 *      path sorts before the worldfile's (`.` < `w`), the schema block precedes the
 *      worldfile's own properties.
 *   2. **Decoration.** A property is written as `<its id token's decoration><name>
 *      <value expression, decorations included>`. So the indentation of the schema source
 *      is the indentation of the output — `  SeedAgents InitAgents;` is indented with one
 *      space because the schema writes `defaults { default InitAgents; … }` with one space.
 *   3. **The newline guard.** A `\n` is inserted in front of a property only when the
 *      property's id token has *no* newline in its decoration, and only when it is the
 *      first property written from that document in this run of the writer. That is what
 *      keeps `@version 2` followed directly by the first schema property on the next line,
 *      and what keeps the blank lines of the worldfile intact at the end of the file.
 *
 * PORT-NOTE(proplib/writer-returns-text): native takes an `ostream&` and streams into it;
 * the port accumulates and returns the text, which is byte-identical. `write( doc )` is
 * still the entry point and still resets the "previous property's document" state.
 */

import {
  ConstScalarProperty,
  Document,
  DynamicScalarAttribute,
  DynamicScalarProperty,
  Property,
  __ContainerProperty,
  compareLocation,
  type MetaProperty,
  type Node,
} from './dom';
import { tokenToString, type Token, type TokenType } from './lexer';
import { proplibError } from './error';

export class DocumentWriter {
  private out = '';
  private doc!: Document;
  private prevPropertyDoc!: Document;

  /** Native `DocumentWriter::write( doc )`. */
  write(doc: Document): string {
    this.out = '';
    this.doc = doc;
    this.prevPropertyDoc = doc;
    this.writeMetaProperties(doc);
    this.writeProperties(doc);
    return this.out;
  }

  /** Native `DocumentWriter::writeScalarNames( doc, depthStart )`. */
  writeScalarNames(doc: Document, depthStart: number): string {
    this.out = '';
    this.writeScalarNamesFor(doc, depthStart);
    return this.out;
  }

  /** Native `DocumentWriter::findPrevToken`. */
  private findPrevToken(node: Node, type: TokenType, search = true): Token | undefined {
    let tok = node.getLocation().beginToken?.prev;
    while (tok) {
      if (tok.type === type) return tok;
      if (!search) break;
      tok = tok.prev;
    }
    return undefined;
  }

  /** Native `DocumentWriter::findBeginToken`. */
  private findBeginToken(node: Node, type: TokenType, search = true): Token | undefined {
    const tokEnd = node.getLocation().endToken;
    let tok = node.getLocation().beginToken;
    while (tok) {
      if (tok.type === type) return tok;
      if (tok === tokEnd || !search) break;
      tok = tok.next;
    }
    return undefined;
  }

  /** Native `DocumentWriter::findEndToken`. */
  private findEndToken(node: Node, type: TokenType): Token | undefined {
    const tokBegin = node.getLocation().beginToken;
    let tok = node.getLocation().endToken;
    while (tok) {
      if (tok.type === type) return tok;
      if (tok === tokBegin) break;
      tok = tok.prev;
    }
    return undefined;
  }

  /** Native `DocumentWriter::findNextToken`. */
  private findNextToken(node: Node, type: TokenType, search = true): Token | undefined {
    let tok = node.getLocation().endToken?.next;
    while (tok) {
      if (tok.type === type) return tok;
      if (!search) break;
      tok = tok.next;
    }
    return undefined;
  }

  /** Native `DocumentWriter::writeToken` — a missing token is a null dereference in native. */
  private writeToken(tok: Token | undefined, what: string): void {
    if (tok === undefined) {
      // PORT-NOTE(proplib/writer-missing-token): native dereferences NULL here. The port
      // raises a located error instead, because a silent segment of the file would be a
      // worse failure than a stopped build.
      proplibError(`DocumentWriter: no ${what} token to write for '${this.doc.getPath()}'`);
    }
    this.out += tok.getDecorationString();
    this.out += tok.text;
  }

  /** Native `DocumentWriter::sortMeta`. */
  private sortMeta(doc: Document): MetaProperty[] {
    return [...doc.metapropsInOrder()].sort((a, b) =>
      compareLocation(a.getLocation(), b.getLocation()),
    );
  }

  /** Native `DocumentWriter::sortChildren`. */
  private sortChildren(prop: __ContainerProperty): Property[] {
    return [...prop.props()].sort((a, b) => compareLocation(a.getLocation(), b.getLocation()));
  }

  /** Native `DocumentWriter::sortAttributes`. */
  private sortAttributes(prop: DynamicScalarProperty): DynamicScalarAttribute[] {
    return [...prop.attrsInOrder()].sort((a, b) =>
      compareLocation(a.getLocation(), b.getLocation()),
    );
  }

  /** Native `DocumentWriter::writeMetaProperties`. */
  private writeMetaProperties(doc: Document): void {
    const sorted = this.sortMeta(doc);

    for (const prop of sorted) {
      const tokId = this.findBeginToken(prop, 'MetaId');
      if (tokId) {
        if (prop !== sorted[0] && !tokId.hasNewline()) this.out += '\n';
        this.writeToken(tokId, 'meta id');
      } else {
        if (prop !== sorted[0]) this.out += '\n';
        this.out += prop.getId().getName();
      }

      this.out += ` ${prop.getValue()}`;
    }
  }

  /** Native `DocumentWriter::writeProperties`. */
  private writeProperties(object: __ContainerProperty): void {
    for (const prop of this.sortChildren(object)) this.writeProperty(prop);
  }

  /** Native `DocumentWriter::writeProperty`. */
  private writeProperty(prop: Property): void {
    if (prop.getSubtype() === 'Runtime') return;

    const parent = prop.getParent();
    if (!parent) prop.err(`Writer: property '${prop.getName()}' has no parent.`);

    if (parent.getType() !== 'Array') {
      const tokId = this.findBeginToken(prop, 'Id');
      if (tokId === undefined) {
        prop.err(`Writer: property '${prop.getName()}' has no id token.`);
      }
      let decoration = tokId.getDecorationString();

      const doc = prop.getLocation().getDocument();
      if ((doc !== this.doc || doc !== this.prevPropertyDoc) && !tokId.hasNewline()) {
        decoration = `\n${decoration}`;
      }
      this.prevPropertyDoc = doc as Document;

      this.out += decoration;
      this.out += prop.getName();
    }

    switch (prop.getType()) {
      case 'Scalar':
        switch (prop.getSubtype()) {
          case 'Const':
            this.writeConst(prop);
            break;
          case 'Dynamic':
            this.writeDynamic(prop);
            break;
          default:
            prop.err(`Writer: unexpected scalar subtype for '${prop.getName()}'`);
        }
        break;
      case 'Array':
        this.writeArray(prop);
        break;
      case 'Object':
        this.writeObject(prop);
        break;
      default:
        prop.err(`Writer: unexpected node type for '${prop.getName()}'`);
    }
  }

  /** Native `DocumentWriter::writeConst`. */
  private writeConst(prop: Property): void {
    const expr = prop instanceof ConstScalarProperty ? prop.getExpression() : undefined;
    if (!expr) prop.err(`Writer: '${prop.getName()}' is not a const scalar.`);
    this.writeExpression(expr);
  }

  /** Native `DocumentWriter::writeDynamic`. */
  private writeDynamic(prop: Property): void {
    if (!(prop instanceof DynamicScalarProperty)) prop.err(`Writer: '${prop.getName()}' is not dynamic.`);

    this.writeToken(this.findBeginToken(prop, 'Dyn'), 'dyn');
    this.writeExpression(prop.getInitExpression());

    const attrs = this.sortAttributes(prop);

    const first = attrs[0];
    if (attrs.length === 1 && first && this.findBeginToken(first, 'LeftCurly', false)) {
      this.writeExpression(first.getExpression());
    } else if (first) {
      this.writeToken(this.findPrevToken(first, 'Attrs'), 'attrs');
      this.writeToken(this.findPrevToken(first, 'LeftCurly', false), 'left curly');

      for (const attr of attrs) {
        this.writeToken(this.findBeginToken(attr, 'Id'), 'attribute id');
        this.writeExpression(attr.getExpression());
      }

      const last = attrs[attrs.length - 1];
      this.writeToken(last ? this.findNextToken(last, 'RightCurly', false) : undefined, 'right curly');
    }
  }

  /** Native `DocumentWriter::writeArray`. */
  private writeArray(prop: Property): void {
    this.writeToken(this.findBeginToken(prop, 'LeftSquare'), 'left square');

    const nelements = prop.size();
    for (let i = 0; i < nelements; i++) {
      const element = prop.requireProp(i);
      this.writeProperty(element);

      if (i !== nelements - 1) this.writeToken(this.findNextToken(element, 'Comma'), 'comma');
    }

    this.writeToken(this.findEndToken(prop, 'RightSquare'), 'right square');
  }

  /** Native `DocumentWriter::writeObject`. */
  private writeObject(prop: Property): void {
    this.writeToken(this.findBeginToken(prop, 'LeftCurly'), 'left curly');

    if (!(prop instanceof __ContainerProperty)) prop.err(`Writer: '${prop.getName()}' is not a container.`);
    this.writeProperties(prop);

    this.writeToken(this.findEndToken(prop, 'RightCurly'), 'right curly');
  }

  /** Native `DocumentWriter::writeExpression`. */
  private writeExpression(expr: import('./expression').Expression): void {
    this.out += expr.write(true);
  }

  /** Native `DocumentWriter::writeScalarNames`. */
  private writeScalarNamesFor(prop: Property, depthStart: number): void {
    switch (prop.getType()) {
      case 'Array':
      case 'Object': {
        if (!(prop instanceof __ContainerProperty)) prop.err(`Writer: '${prop.getName()}' is not a container.`);
        for (const child of this.sortChildren(prop)) this.writeScalarNamesFor(child, depthStart);
        break;
      }
      case 'Scalar':
        this.out += `${prop.getFullName(depthStart)}\n`;
        break;
      default:
        prop.err(`Writer: unexpected node type for '${prop.getName()}'`);
    }
  }
}

/** Convenience: write a document the way `Simulation.cc` writes `run/normalized.wf`. */
export function writeDocument(doc: Document): string {
  return new DocumentWriter().write(doc);
}

/** Re-exported for lanes that only need the range form of a token. */
export { tokenToString };
