/**
 * Lane W1b — the property language lexer (native `proplib/parser.{h,cc}`, classes `Token`
 * and `Tokenizer`; there is no separate `lexer.cc` in the native tree, the tokenizer lives
 * in `parser.cc`).
 *
 * The critical property of this lexer is that it does not discard anything. Whitespace and
 * comments are tokens too, and each ordinary token carries the chain of decoration tokens
 * that preceded it (`Token::decoration`). `DocumentWriter` re-emits a token as
 * `decoration + text`, so the decoration chain *is* the output formatting of
 * `run/normalized.wf` — the writer never invents whitespace.
 *
 * PORT-NOTE(proplib/token-decoration): native keeps decoration as an intrusive singly
 * linked list threaded through `Token::next`; the port keeps the same chain as an array on
 * the token (order identical, `Token.next`/`prev` are the ordinary-token chain only).
 *
 * PORT-NOTE(proplib/istream-semantics): `Tokenizer` streams over an `std::istream`, and
 * the port reproduces the exact read semantics that matter: `get()` at end of input fails
 * (and only then, i.e. reading the final byte of the file still succeeds), `peek()` returns
 * EOF, `_lineno` counts newlines as they are consumed, and `unget()` only ever undoes the
 * byte just read. A token's `lineno` is the line the token *starts* on, captured before its
 * bytes are read.
 */

import { proplibError } from './error';

/** Native `Token::Type`, in declaration order (the names match the native `#TYPE` strings). */
export const TOKEN_TYPES = [
  'Comment',
  'Whitespace',
  'Enum',
  'Class',
  'Dyn',
  'Attrs',
  'MetaId',
  'Id',
  'String',
  'Number',
  'LeftCurly',
  'RightCurly',
  'LeftSquare',
  'RightSquare',
  'LeftParen',
  'RightParen',
  'Comma',
  'Semicolon',
  'Dot',
  'Bof',
  'Eof',
  'Misc',
] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];

/** One lexical token (native `proplib::Token`). */
export class Token {
  readonly type: TokenType;
  readonly text: string;

  /** Line the token starts on (native `Token::lineno`); `Bof` is 0, unset is -1. */
  lineno = -1;

  /**
   * 1-based index in the ordinary-token sequence (native `Token::number`, `_number`
   * pre-incremented in `Tokenizer::next`); `Bof` keeps -1. Used as the final tiebreak when
   * `DocumentLocation` orders two nodes, so it is part of output ordering.
   */
  number = -1;

  /** Next ordinary token (native `Token::next`; also the decoration chain in native). */
  next: Token | undefined;

  /** Previous ordinary token (native `Token::prev`). */
  prev: Token | undefined;

  /** Decoration tokens immediately preceding this one, in source order (native chain). */
  decoration: Token[] = [];

  constructor(type: TokenType, text: string) {
    this.type = type;
    this.text = text;
  }

  /** Native `Token::isDecoration()`. */
  isDecoration(): boolean {
    return this.type === 'Whitespace' || this.type === 'Comment';
  }

  /** Native `Token::getDecorationString()`: concatenated decoration text. */
  getDecorationString(): string {
    let out = '';
    for (const dec of this.decoration) out += dec.text;
    return out;
  }

  /** Native `Token::hasNewline()`: decoration contains a newline (Whitespace only). */
  hasNewline(): boolean {
    for (const dec of this.decoration) {
      if (dec.type === 'Whitespace' && dec.text.includes('\n')) return true;
    }
    return false;
  }

  /** `Token::toString( this, this )` — the token as the writer would emit it. */
  toStringWithDecoration(leadingDecoration = false): string {
    return tokenToString(this, this, leadingDecoration);
  }
}

/**
 * Native `Token::toString( start, end, leadingDecoration )`: re-emit the *ordinary* token
 * chain from `start` to `end` inclusive, each token preceded by its decoration (the first
 * only when `leadingDecoration`). Intervening punctuation, array brackets and dots are
 * ordinary tokens, which is why a re-emitted expression text is byte-identical to the
 * source text it was parsed from.
 */
export function tokenToString(start: Token, end: Token | undefined, leadingDecoration = false): string {
  let out = '';
  let tok: Token | undefined = start;

  while (tok) {
    if (leadingDecoration || tok !== start) out += tok.getDecorationString();
    out += tok.text;
    if (tok === end) break;
    tok = tok.next;
  }

  return out;
}

const CHAR_SPACE = 0x20;
const CHAR_TAB = 0x09;
const CHAR_LF = 0x0a;
const CHAR_VT = 0x0b;
const CHAR_FF = 0x0c;
const CHAR_CR = 0x0d;
const CHAR_HASH = 0x23;
const CHAR_AT = 0x40;
const CHAR_QUOTE = 0x22;
const CHAR_BACKSLASH = 0x5c;
const CHAR_ASTERISK = 0x2a;
const CHAR_UNDERSCORE = 0x5f;
const EOF = -1;

/** Native file-local `isspace()`: the six C whitespace bytes. */
function isSpaceCode(c: number): boolean {
  return c === CHAR_SPACE || c === CHAR_LF || c === CHAR_TAB || c === CHAR_CR || c === CHAR_VT || c === CHAR_FF;
}

/** Native file-local `isalpha()`: ASCII letters only (a negative/signed char fails). */
function isAlphaCode(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** Native file-local `isdigit()`: ASCII 0-9 only. */
function isDigitCode(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** Native file-local `isalnum()`. */
function isAlnumCode(c: number): boolean {
  return isDigitCode(c) || isAlphaCode(c);
}

/**
 * Native `Tokenizer`. Reads `source` (already decoded latin-1, so one char == one byte)
 * and yields the decorated token chain.
 */
export class Tokenizer {
  private pos = 0;
  private lineno = 1;
  private failed = false;
  private lastNumber = 0;
  private prevToken: Token | undefined;

  constructor(
    private readonly sourceName: string,
    private readonly source: string,
  ) {}

  /** Native `Tokenizer::next()`: `Bof` once, then the decorated ordinary tokens. */
  next(): Token {
    if (this.prevToken === undefined) {
      const bof = new Token('Bof', '');
      bof.lineno = 0;
      this.prevToken = bof;
      return bof;
    }

    const decoration: Token[] = [];

    for (;;) {
      const lineno = this.lineno;

      const tok = this.__next();
      tok.lineno = lineno;
      tok.number = ++this.lastNumber;

      if (tok.isDecoration()) {
        decoration.push(tok);
      } else {
        tok.decoration = decoration;
        tok.prev = this.prevToken;
        this.prevToken.next = tok;
        this.prevToken = tok;
        return tok;
      }
    }
  }

  /** Native `Tokenizer::get()`: consume one byte; newlines advance the line counter. */
  private get(): number {
    if (this.pos >= this.source.length) {
      this.failed = true;
      return EOF;
    }
    const c = this.source.charCodeAt(this.pos++);
    if (c === CHAR_LF) this.lineno++;
    return c;
  }

  /** Native `std::istream::good()`: false once a read has hit end of input. */
  private good(): boolean {
    return !this.failed;
  }

  /** Native `std::istream::peek()`. */
  private peek(): number {
    return this.pos >= this.source.length ? EOF : this.source.charCodeAt(this.pos);
  }

  /** Native `std::istream::unget()`: push the byte just read back. */
  private unget(): void {
    if (this.pos > 0) this.pos--;
  }

  /** Native `std::istream::ignore()`. */
  private ignore(): void {
    if (this.pos < this.source.length) this.pos++;
  }

  private take(): string {
    return String.fromCharCode(this.get());
  }

  private err(lineno: number, message: string): never {
    return proplibError(`${this.sourceName}:${lineno}: ${message}`);
  }

  /** Native `Tokenizer::__next()`. */
  private __next(): Token {
    const c = this.get();

    if (!this.good()) {
      if (c === EOF) return new Token('Eof', '');
      return proplibError(`Failed reading from ${this.sourceName}`);
    }

    if (c === CHAR_HASH) return this.parseComment();
    if (isSpaceCode(c)) return this.parseWhitespace();
    if (c === CHAR_AT) return this.parseMetaId();
    if (c === CHAR_UNDERSCORE || isAlphaCode(c)) return this.parseWord();
    if (c === CHAR_QUOTE) return this.parseString();
    if (c === CHAR_BACKSLASH) return this.parseEscape();
    if (isDigitCode(c)) return this.parseNumber();

    switch (c) {
      case 0x7b:
        return new Token('LeftCurly', '{');
      case 0x7d:
        return new Token('RightCurly', '}');
      case 0x5b:
        return new Token('LeftSquare', '[');
      case 0x5d:
        return new Token('RightSquare', ']');
      case 0x28:
        return new Token('LeftParen', '(');
      case 0x29:
        return new Token('RightParen', ')');
      case 0x2c:
        return new Token('Comma', ',');
      case 0x3b:
        return new Token('Semicolon', ';');
      case 0x2e:
        return new Token('Dot', '.');
      default:
        return new Token('Misc', String.fromCharCode(c));
    }
  }

  /** Native `Tokenizer::parseComment()`: `#…` to end of line, or `#* … *#`. */
  private parseComment(): Token {
    const linenoStart = this.lineno;

    if (this.peek() === CHAR_ASTERISK) {
      // Multi-line comment.
      let buf = '#*';
      this.ignore();

      let state: 'Init' | 'Splat' | 'Complete' = 'Init';

      while (this.good() && state !== 'Complete') {
        const c = this.get();
        buf += String.fromCharCode(c);

        if (c === CHAR_ASTERISK) state = 'Splat';
        else if (c === CHAR_HASH && state === 'Splat') state = 'Complete';
        else state = 'Init';
      }

      if (state !== 'Complete') this.err(linenoStart, 'Unterminated multi-line comment.');

      return new Token('Comment', buf);
    }

    // Single-line comment: up to (not including) the newline.
    let buf = '#';
    while (this.good() && this.peek() !== CHAR_LF) buf += this.take();

    return new Token('Comment', buf);
  }

  /** Native `Tokenizer::parseWhitespace()`: a maximal run of the six whitespace bytes. */
  private parseWhitespace(): Token {
    this.unget();
    if (this.peek() === CHAR_LF) this.lineno--;

    let buf = '';
    while (this.good()) {
      const c = this.peek();
      if (!isSpaceCode(c)) break;
      buf += this.take();
    }

    return new Token('Whitespace', buf);
  }

  /** Native `Tokenizer::parseMetaId()`: `@` plus everything up to whitespace. */
  private parseMetaId(): Token {
    let buf = '@';
    while (this.good()) {
      const c = this.peek();
      if (isSpaceCode(c)) break;
      buf += this.take();
    }
    return new Token('MetaId', buf);
  }

  /** Native `Tokenizer::parseWord()`: identifier, or one of the four keywords. */
  private parseWord(): Token {
    this.unget();

    let buf = this.take();
    while (this.good()) {
      const c = this.peek();
      if (!isAlnumCode(c) && c !== CHAR_UNDERSCORE) break;
      buf += this.take();
    }

    if (buf === 'enum') return new Token('Enum', 'enum');
    if (buf === 'class') return new Token('Class', 'class');
    if (buf === 'dyn') return new Token('Dyn', 'dyn');
    if (buf === 'attrs') return new Token('Attrs', 'attrs');

    return new Token('Id', buf);
  }

  /** Native `Tokenizer::parseEscape()`: backslash plus the next byte, as one Misc token. */
  private parseEscape(): Token {
    return new Token('Misc', `\\${this.take()}`);
  }

  /** Native `Tokenizer::parseString()`: a double-quoted literal, escapes skipped. */
  private parseString(): Token {
    const lineno = this.lineno;

    let buf = '"';
    let state: 'Init' | 'Escape' | 'Complete' = 'Init';

    while (this.good() && state !== 'Complete') {
      const c = this.get();
      buf += String.fromCharCode(c);

      if (state === 'Escape') state = 'Init';
      else if (c === CHAR_BACKSLASH) state = 'Escape';
      else if (c === CHAR_QUOTE) state = 'Complete';
      else if (c === CHAR_LF) break;
    }

    if (state !== 'Complete') this.err(lineno, 'Unterminated string literal.');

    return new Token('String', buf);
  }

  /** Native `Tokenizer::parseNumber()`: digits, one dot, optional `l`/`f`/`d` suffix. */
  private parseNumber(): Token {
    this.unget();

    let buf = '';
    let state: 'Init' | 'Dot' | 'Complete' = 'Init';

    while (this.good() && state !== 'Complete') {
      const c = this.peek();

      if (c === 0x2e /* . */) {
        if (state === 'Dot') this.err(this.lineno, "Unexpected '.'");
        state = 'Dot';
      } else if (c === 0x6c /* l */) {
        if (state === 'Dot') this.err(this.lineno, "Illegal combination of '.' and 'l' suffix");
        state = 'Complete';
      } else if (c === 0x66 /* f */ || c === 0x64 /* d */) {
        state = 'Complete';
      } else if (!isDigitCode(c)) {
        state = 'Complete';
        break;
      }

      buf += this.take();
    }

    return new Token('Number', buf);
  }
}

/** Tokenize a whole document (used by tests and tools; the parser drives the tokenizer lazily). */
export function tokenize(sourceName: string, source: string): Token[] {
  const tokenizer = new Tokenizer(sourceName, source);
  const tokens: Token[] = [];
  for (;;) {
    const tok = tokenizer.next();
    tokens.push(tok);
    if (tok.type === 'Eof') return tokens;
  }
}
