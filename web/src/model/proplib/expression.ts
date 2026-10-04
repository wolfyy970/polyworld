/**
 * Lane W1b — expressions (native `proplib/expression.{h,cc}`; the expression *language* is
 * evaluated by lane L4, this file only carries it).
 *
 * An expression is a flat sequence of two kinds of element: a `SymbolPath` (an identifier
 * with dots and array indices) and a "misc" token (operators, parentheses, keywords,
 * literals — every token the parser did not group into a symbol path). Nothing here
 * interprets the sequence: it is carried verbatim because `DocumentWriter` re-emits it, and
 * because the *evaluator* (lane L4, `evaluator.ts` seam) is the only thing that may give it
 * meaning.
 *
 * PORT-NOTE(proplib/expression-clone): native `Expression::clone()` is a `// todo` that
 * returns `this`, so a cloned property (a schema `default` injected into a worldfile)
 * shares its expression *and therefore its tokens* with the schema. That is load-bearing
 * for byte-exactness: the injected property's value text is the schema's text, decorations
 * included. The port keeps the behavior (and the comment is the native one).
 */

import type { Token } from './lexer';
import { tokenToString } from './lexer';

/** Native `SymbolPath::Element`: one identifier or array index in a path. */
export class SymbolPath {
  /** Element tokens in order (native linked `Element` list). */
  readonly elements: Token[] = [];

  /** Native `SymbolPath::add( Token * )`. */
  add(token: Token): void {
    this.elements.push(token);
  }

  get head(): Token | undefined {
    return this.elements[0];
  }

  get tail(): Token | undefined {
    return this.elements[this.elements.length - 1];
  }

  /** Native `SymbolPath::toString()` (decorations as requested). */
  toString(leadingDecoration = false): string {
    const head = this.head;
    if (!head) return '';
    return tokenToString(head, this.tail, leadingDecoration);
  }
}

/** Native `ExpressionElement` (`Symbol` or `Misc`, with its `token`/`symbolPath` payload). */
export type ExpressionElement =
  | { readonly kind: 'symbol'; readonly symbolPath: SymbolPath }
  | { readonly kind: 'misc'; readonly token: Token };

/** Native `Expression`. */
export class Expression {
  readonly elements: ExpressionElement[] = [];

  /** Native `Expression::clone()` — returns `this` (see the PORT-NOTE above). */
  clone(): Expression {
    return this;
  }

  /** Native `Expression::isCppClause()`. */
  isCppClause(): boolean {
    const first = this.elements[0];
    return first !== undefined && first.kind === 'misc' && first.token.type === 'LeftCurly';
  }

  /** First ordinary token of the expression (native `elements.front()` token). */
  firstToken(): Token | undefined {
    const first = this.elements[0];
    if (!first) return undefined;
    return first.kind === 'symbol' ? first.symbolPath.head : first.token;
  }

  /** Last ordinary token of the expression (native `elements.back()` token). */
  lastToken(): Token | undefined {
    const last = this.elements[this.elements.length - 1];
    if (!last) return undefined;
    return last.kind === 'symbol' ? last.symbolPath.tail : last.token;
  }

  /**
   * Native `Expression::write( out, leadingDecoration )`: the source text from the first
   * to the last element token, every token decorated as it was lexed.
   */
  write(leadingDecoration = true): string {
    const begin = this.firstToken();
    const end = this.lastToken();
    if (!begin) return '';
    return tokenToString(begin, end, leadingDecoration);
  }

  /** Native `Expression::toString()`. */
  toString(leadingDecoration = true): string {
    return this.write(leadingDecoration);
  }
}
