/**
 * Lane W1b — the parse tree (native `proplib/parser.{h,cc}`, class `SyntaxNode`).
 *
 * A deliberately shallow tree: each node records its type, its first and last token, and
 * its children. `DocumentBuilder` (builder.ts) is the only consumer, and it reads the tree
 * positionally (`node->children[0]` is the id, `children[1]` the value, …), exactly as the
 * native builder does — the tree is not a general AST, and nothing else may depend on its
 * shape.
 *
 * PORT-NOTE(proplib/syntax-node-tokens): `beginToken`/`endToken` are what every later
 * stage uses for two things: `DocumentLocation` (ordering, error text) and the *verbatim
 * re-emission* of values and expressions. The tree therefore keeps token identity rather
 * than copying text.
 */

import type { Token } from './lexer';
import { tokenToString } from './lexer';

/** Native `SyntaxNode::Type`, in declaration order. */
export const SYNTAX_NODE_TYPES = [
  'Document',
  'MetaProperty',
  'MetaPropertyValue',
  'Object',
  'Property',
  'PropertyValue',
  'Id',
  'Array',
  'Enum',
  'EnumValues',
  'Class',
  'Dyn',
  'DynAttr',
  'CppClause',
  'Expression',
  'SymbolPath',
  'SymbolPathElement',
  'Misc',
] as const;

export type SyntaxNodeType = (typeof SYNTAX_NODE_TYPES)[number];

/** One parse-tree node (native `proplib::SyntaxNode`). */
export class SyntaxNode {
  readonly type: SyntaxNodeType;
  readonly typeName: string;
  readonly children: SyntaxNode[] = [];

  parent: SyntaxNode | undefined;
  beginToken: Token;
  endToken: Token;

  constructor(type: SyntaxNodeType, typeName: string, begin: Token) {
    this.type = type;
    this.typeName = typeName;
    this.beginToken = begin;
    // Native leaves `endToken` NULL until `popNode`; the tree is never read before then.
    this.endToken = begin;
  }

  /** Native `SyntaxNode::dump()`, used by the parser tests and debugging. */
  dump(indent = ''): string {
    let out = `${indent}${this.typeName}`;

    if (this.children.length === 0) {
      out += `('${tokenToString(this.beginToken, this.endToken)}')\n`;
    } else {
      out += `('${this.beginToken.text}' --> '${this.endToken.text}')\n`;
      for (const child of this.children) out += child.dump(`${indent}  `);
    }

    return out;
  }
}
