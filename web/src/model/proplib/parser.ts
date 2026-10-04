/**
 * Lane W1b — the parser (native `proplib/parser.{h,cc}`, class `Parser`).
 *
 * Recursive descent over the decorated token chain, producing the shallow `SyntaxNode`
 * tree. Three entry points matter to the rest of the lane:
 *
 *   parseDocument(path, source)   a `.wf`, `.wfs` or overlay document
 *   parseSymbolPath(text)         e.g. `"Vision"`, `"Domains[0].FoodPatches.2.CenterX"`
 *   parsePropertyValue(text)      a *synthesised* value, used by `DocumentEditor::set`
 *   parseMetaPropertyValue(text)  a synthesised meta value, used by `DocumentEditor::setMeta`
 *
 * The three text entry points parse from a string with the source name `<string>`, exactly
 * like the native `istringstream` overloads, so a synthesised value carries the same
 * decoration it would have had inline: `parsePropertyValue(' Object')` yields a value whose
 * first token is decorated with the single leading space.
 *
 * PORT-NOTE(proplib/synthesised-locations): a synthesised property does *not* get a
 * location from the text it parsed; `DocumentEditor::set` splices it in at the location of
 * the property it replaces (`builder.buildProperty( prop->getLocation(), … )`), which is
 * why a parameter-overridden value keeps the indentation of the schema's `default` line.
 * That is reproduced here by passing the location through, not by re-deriving it.
 */

import { proplibError } from './error';
import { Tokenizer, type Token, type TokenType } from './lexer';
import { SyntaxNode, type SyntaxNodeType } from './syntax';

export class Parser {
  private path = '<string>';
  private tokenizer!: Tokenizer;
  private currTok!: Token;
  private syntaxNode: SyntaxNode | undefined;

  /** Native `Parser::parseDocument`. */
  parseDocument(path: string, source: string): SyntaxNode {
    this.init(path, source);

    this.nextRequired('Bof');
    this.pushNode('Document', 'Document', this.currTok);

    this.parseMetaProperties();
    this.parseObject();

    this.nextRequired('Eof');
    return this.popNode('Document', 'Document', this.currTok);
  }

  /** Native `Parser::parseSymbolPath( string )`. */
  parseSymbolPath(text: string): SyntaxNode {
    this.init('<string>', text);

    this.nextRequired('Bof');
    const result = this.parseSymbolPathValue();
    this.nextRequired('Eof');

    return result;
  }

  /** Native `Parser::parsePropertyValue( string )`. */
  parsePropertyValue(text: string): SyntaxNode {
    this.init('<string>', text);

    this.nextRequired('Bof');
    const result = this.parsePropertyValueInternal();
    this.nextRequired('Eof');

    return result;
  }

  /** Native `Parser::parseMetaPropertyValue( string )`. */
  parseMetaPropertyValue(text: string): SyntaxNode {
    this.init('<string>', text);

    this.nextRequired('Bof');
    const result = this.parseMetaPropertyValueInternal();
    this.nextRequired('Eof');

    return result;
  }

  private init(path: string, source: string): void {
    this.path = path;
    this.tokenizer = new Tokenizer(path, source);
    this.syntaxNode = undefined;
  }

  /** Native `Parser::err` — `<path>:<lineno> <message>`. */
  private err(tok: Token, message: string): never {
    return proplibError(`${this.path}:${tok.lineno} ${message}`);
  }

  /** Native `Parser::peek()`. */
  private peek(): Token {
    if (this.currTok.next) return this.currTok.next;
    return this.tokenizer.next();
  }

  /** Native `Parser::next( Token::Type required )`. */
  private nextRequired(required: TokenType): Token {
    const tok = this.next();
    if (tok.type !== required) this.err(tok, `Unexpected '${tok.text}'`);
    return tok;
  }

  /** Native `Parser::next()`. */
  private next(): Token {
    if (this.currTok && this.currTok.next) this.currTok = this.currTok.next;
    else this.currTok = this.tokenizer.next();
    return this.currTok;
  }

  /** Native `Parser::pushNode`. */
  private pushNode(type: SyntaxNodeType, typeName: string, begin: Token): void {
    const node = new SyntaxNode(type, typeName, begin);
    node.parent = this.syntaxNode;
    if (this.syntaxNode) this.syntaxNode.children.push(node);
    this.syntaxNode = node;
  }

  /** Native `Parser::popNode`. */
  private popNode(type: SyntaxNodeType, typeName: string, end: Token): SyntaxNode {
    const node = this.syntaxNode;
    if (!node) return proplibError(`${this.path}: parse tree underflow popping ${typeName}`);
    node.endToken = end;
    this.syntaxNode = node.parent;
    return node;
  }

  private pushTo(type: SyntaxNodeType, tok: Token): void {
    this.pushNode(type, type, tok);
  }

  private pushPop(type: SyntaxNodeType): void {
    this.pushTo(type, this.currTok);
    this.popNode(type, type, this.currTok);
  }

  private pushPopPeek(type: SyntaxNodeType): void {
    const tok = this.peek();
    this.pushNode(type, type, tok);
    this.popNode(type, type, tok);
  }

  /** Native `Parser::parseMetaProperties()`. */
  private parseMetaProperties(): void {
    while (this.peek().type === 'MetaId') {
      this.nextRequired('MetaId');
      this.pushTo('MetaProperty', this.currTok);

      this.pushPop('Id');

      this.parseMetaPropertyValueInternal();

      this.popNode('MetaProperty', 'MetaProperty', this.currTok);
    }
  }

  /** Native `Parser::parseMetaPropertyValue()` — to end of line. */
  private parseMetaPropertyValueInternal(): SyntaxNode {
    this.pushNode('MetaPropertyValue', 'MetaPropertyValue', this.peek());

    while (!this.peek().hasNewline() && this.peek().type !== 'Eof') {
      this.next();
      this.pushPop('Misc');
    }

    return this.popNode('MetaPropertyValue', 'MetaPropertyValue', this.currTok);
  }

  /** Native `Parser::parseObject()`. */
  private parseObject(): void {
    this.pushTo('Object', this.currTok);

    let containerComplete = false;

    while (!containerComplete) {
      switch (this.peek().type) {
        case 'Id':
          this.parseProperty();
          break;
        case 'Enum':
          this.parseEnum();
          break;
        case 'Class':
          this.parseClass();
          break;
        default:
          containerComplete = true;
          break;
      }
    }

    this.popNode('Object', 'Object', this.peek());
  }

  /** Native `Parser::parseProperty()`. */
  private parseProperty(): void {
    this.nextRequired('Id');
    this.pushTo('Property', this.currTok);

    this.pushPop('Id');

    this.parsePropertyValueInternal();

    this.popNode('Property', 'Property', this.currTok);
  }

  /** Native `Parser::parsePropertyValue()`. */
  private parsePropertyValueInternal(): SyntaxNode {
    this.pushNode('PropertyValue', 'PropertyValue', this.peek());

    switch (this.peek().type) {
      case 'LeftCurly':
        this.nextRequired('LeftCurly');
        this.parseObject();
        this.nextRequired('RightCurly');
        break;
      case 'LeftSquare':
        this.parseArray();
        break;
      case 'Dyn':
        this.parseDyn();
        break;
      default:
        this.parseExpression();
        break;
    }

    return this.popNode('PropertyValue', 'PropertyValue', this.currTok);
  }

  /** Native `Parser::parseArray()`. */
  private parseArray(): void {
    this.nextRequired('LeftSquare');
    this.pushTo('Array', this.currTok);

    switch (this.peek().type) {
      case 'RightSquare':
        // Empty array.
        break;
      case 'LeftCurly':
        for (;;) {
          this.nextRequired('LeftCurly');
          this.pushTo('PropertyValue', this.currTok);
          this.parseObject();
          this.nextRequired('RightCurly');
          this.popNode('PropertyValue', 'PropertyValue', this.currTok);

          if (this.peek().type === 'Comma') this.nextRequired('Comma');
          else break;
        }
        break;
      default:
        for (;;) {
          this.pushNode('PropertyValue', 'PropertyValue', this.peek());
          if (this.peek().type === 'Dyn') this.parseDyn();
          else this.parseExpression();
          this.popNode('PropertyValue', 'PropertyValue', this.currTok);

          if (this.peek().type === 'Comma') this.nextRequired('Comma');
          else break;
        }
        break;
    }

    this.nextRequired('RightSquare');
    this.popNode('Array', 'Array', this.currTok);
  }

  /** Native `Parser::parseDyn()`. */
  private parseDyn(): void {
    this.nextRequired('Dyn');
    this.pushTo('Dyn', this.currTok);

    this.parseExpression();

    switch (this.peek().type) {
      case 'Attrs':
        this.parseDynAttrs();
        break;
      case 'LeftCurly':
        this.parseCppClause();
        break;
      default:
        break;
    }

    this.popNode('Dyn', 'Dyn', this.currTok);
  }

  /** Native `Parser::parseDynAttrs()`. */
  private parseDynAttrs(): void {
    this.nextRequired('Attrs');
    this.nextRequired('LeftCurly');

    while (this.peek().type !== 'RightCurly') {
      if (this.peek().type !== 'Id') this.err(this.peek(), 'Expecting identifier');

      this.nextRequired('Id');
      this.pushTo('DynAttr', this.currTok);

      this.pushPop('Id');

      if (this.peek().type === 'LeftCurly') this.parseCppClause();
      else this.parseExpression();

      this.popNode('DynAttr', 'DynAttr', this.currTok);
    }

    this.nextRequired('RightCurly');
  }

  /** Native `Parser::parseCppClause()` — a brace-matched C++ snippet. */
  private parseCppClause(): void {
    if (this.peek().type !== 'LeftCurly') this.err(this.peek(), "Expecting '{'");

    this.pushNode('CppClause', 'CppClause', this.peek());

    let depth = 0;
    const tokStart = this.peek();
    do {
      if (this.peek().type === 'Id') {
        this.parseSymbolPathValue();
      } else {
        switch (this.next().type) {
          case 'LeftCurly':
            depth++;
            break;
          case 'RightCurly':
            depth--;
            break;
          case 'Eof':
            this.err(tokStart, "Missing '}'");
            break;
          default:
            break;
        }

        this.pushPop('Misc');
      }
    } while (depth);

    this.popNode('CppClause', 'CppClause', this.currTok);
  }

  /** Native `Parser::parseExpression()`. */
  private parseExpression(parenDelimited = false): SyntaxNode {
    this.pushNode('Expression', 'Expression', this.peek());

    let tokStart: Token | undefined;
    let parenDepth = 0;
    let complete = false;

    while (!complete) {
      if (parenDepth === 0 && tokStart && this.peek().hasNewline()) {
        complete = true;
      } else {
        let tok: Token | undefined;

        if (this.peek().type === 'Id') {
          tok = this.peek();
          this.parseSymbolPathValue();
        } else {
          if (parenDepth) {
            tok = this.next();
            if (tok.type === 'Eof') complete = true;
          } else {
            switch (this.peek().type) {
              case 'Semicolon':
                complete = true;
                tok = this.next();
                break;
              case 'Comma':
              case 'RightSquare':
              case 'LeftCurly':
              case 'RightCurly':
              case 'Eof':
                complete = true;
                break;
              default:
                tok = this.next();
                break;
            }
          }

          if (tok) this.pushPop('Misc');
        }

        if (tok) {
          if (tokStart === undefined) {
            if (parenDelimited && tok.type !== 'LeftParen') this.err(tok, "Expecting '('");
            tokStart = tok;
          }

          switch (tok.type) {
            case 'LeftParen':
              parenDepth++;
              break;
            case 'RightParen':
              parenDepth--;
              if (parenDepth < 0) this.err(tok, "Unexpected ')'");
              if (parenDelimited && parenDepth === 0) complete = true;
              break;
            default:
              break;
          }
        }
      }
    }

    if (tokStart === undefined) this.err(this.currTok, `Expecting scalar after '${this.currTok.text}'`);
    else if (parenDepth > 0) this.err(tokStart, "Missing ')'");

    return this.popNode('Expression', 'Expression', this.currTok);
  }

  /** Native `Parser::parseSymbolPath()` — `A`, `A.B`, `A[0].B`, `A[]`. */
  private parseSymbolPathValue(): SyntaxNode {
    this.pushNode('SymbolPath', 'SymbolPath', this.peek());

    let complete = false;
    let beginArrayIndex: Token | undefined;

    while (!complete) {
      if (beginArrayIndex) {
        switch (this.next().type) {
          case 'RightSquare':
            if (this.currTok.prev === beginArrayIndex) {
              // Empty `[]`.
              complete = true;
            } else {
              const begin = beginArrayIndex.next;
              const end = this.currTok.prev;
              if (!begin || !end) this.err(beginArrayIndex, "Missing ']'");
              this.pushNode('SymbolPathElement', 'SymbolPathElement', begin);
              this.popNode('SymbolPathElement', 'SymbolPathElement', end);
              if (this.peek().type !== 'Dot') complete = true;
            }
            beginArrayIndex = undefined;
            break;
          case 'Eof':
            // This yields an error message downstream, as in native.
            complete = true;
            break;
          default:
            break;
        }
      } else {
        switch (this.peek().type) {
          case 'Id':
            this.next();
            this.pushPop('SymbolPathElement');
            if (this.peek().type !== 'Dot' && this.peek().type !== 'LeftSquare') complete = true;
            break;
          case 'LeftSquare':
            this.next();
            beginArrayIndex = this.currTok;
            break;
          case 'Dot':
            this.next();
            break;
          default:
            complete = true;
            break;
        }
      }
    }

    if (beginArrayIndex) this.err(beginArrayIndex, "Missing ']'");

    return this.popNode('SymbolPath', 'SymbolPath', this.currTok);
  }

  /** Native `Parser::parseEnum()`. */
  private parseEnum(): void {
    this.nextRequired('Enum');
    this.pushTo('Enum', this.currTok);

    this.nextRequired('Id');
    this.pushTo('Id', this.currTok);
    this.popNode('Id', 'Id', this.currTok);

    this.nextRequired('LeftCurly');
    this.pushTo('EnumValues', this.currTok);

    for (;;) {
      this.nextRequired('Id');
      this.pushPop('Id');

      if (this.peek().type === 'Comma') this.nextRequired('Comma');
      else break;
    }

    this.nextRequired('RightCurly');
    this.popNode('EnumValues', 'EnumValues', this.currTok);
    this.popNode('Enum', 'Enum', this.currTok);
  }

  /** Native `Parser::parseClass()`. */
  private parseClass(): void {
    this.nextRequired('Class');
    this.pushTo('Class', this.currTok);

    this.nextRequired('Id');
    this.pushTo('Id', this.currTok);
    this.popNode('Id', 'Id', this.currTok);

    this.nextRequired('LeftCurly');
    this.parseObject();
    this.nextRequired('RightCurly');

    this.popNode('Class', 'Class', this.currTok);
  }
}

/** Convenience: parse a whole document. */
export function parseDocument(path: string, source: string): SyntaxNode {
  return new Parser().parseDocument(path, source);
}

/** Convenience: parse a synthesised property value (e.g. `' Vision False'`). */
export function parsePropertyValue(text: string): SyntaxNode {
  return new Parser().parsePropertyValue(text);
}
