/**
 * Lane W1b (the seam) + lane L4 (the language) — expression evaluation.
 *
 * Native proplib does not evaluate expressions in C++: it *translates* them to Python, pipes
 * the text to a long-lived `python3` child process (`src/library/proplib/interpreter.py`,
 * `Interpreter::eval`) and stores the child's `str( eval( text ) )` as the property's value
 * (`interpreter.cc::ExpressionEvaluator::evaluate`). This file holds both halves of that:
 *
 *   - `ExpressionEvaluator` — the seam W1b declared, called from `Property.getEvaledString()`
 *     with the token list and the owning property (`PORT-NOTE(proplib/evaluator-seam)`);
 *   - `interpreterEvaluator` — lane L4: `generatePythonExpression()` is the native
 *     *code generation* half, `pythonExpression.ts` is the `eval` half. An out-of-process
 *     `python3` is not available in a browser, so the language is ported in-process; that
 *     evaluator is the default for every document build, and the predecessor stand-in
 *     (`schemaLiteralEvaluator`) is kept only as the seam's test harness.
 *
 * `Expression` is passed by token identity (not text) because the native evaluator reads
 * the token *type* of each element and each symbol path's *tokens*, not a string: an
 * enum value or class name becomes a quoted literal, a property reference becomes that
 * property's evaluated value, and anything else is emitted as a bare Python symbol.
 * Handing over tokens is what lets this reproduce that.
 *
 * PORT-NOTE(proplib/dependency-cycle): native's re-entrancy flag lives on the per-property
 * `ExpressionEvaluator` (`_isEvaluating`), so a property reached from its own expression
 * errors with `Dependency cycle`. The port's evaluator is document-wide, so the flag is the
 * set of properties currently being evaluated — same semantics (A -> A, and A -> B -> A).
 *
 * PORT-NOTE(proplib/schema-literal-evaluator): `schemaLiteralEvaluator` is the pre-L4
 * stand-in and is **not** the expression language: it answers only when the native Python
 * evaluation is provably the identity (a single number, string or Python literal token; a
 * single symbol that resolves to an enum value or a class name, which native emits as a
 * quoted literal) and **throws** for everything else — a property reference, an operator, a
 * function call, `if/else`, `and`/`or`. It cannot silently disagree with the native; it fails
 * loudly. It stays exported because it is the harness other lanes' tests drive the seam with,
 * and because it documents what "cannot silently disagree" looks like; no production path
 * defaults to it since L4 landed.
 */

import { ProplibError } from './error';
import type { Expression } from './expression';
import type { Property } from './dom';
import { PythonError, evaluatePythonExpressionText } from './pythonExpression';

/**
 * Native `Interpreter::ExpressionEvaluator`: evaluate an expression in the scope of the
 * property that owns it, returning the value as text with no trimming.
 */
export interface ExpressionEvaluator {
  evaluate(expression: Expression, owner: Property): string;

  /** For diagnostics, e.g. `"python3"`, `"schema-literals (stand-in, lane L4 pending)"`. */
  readonly name: string;
}

/** The python-literal scalars whose native `str(eval(text))` is `text` itself. */
const PYTHON_LITERALS = new Set(['True', 'False', 'None']);

/**
 * Refuses every evaluation. Used by tests that assert the seam is *consulted* (rather than
 * reaching for a value directly), and available to any lane that wants a document build to
 * fail the moment a value is needed.
 */
export const unavailableEvaluator: ExpressionEvaluator = {
  name: 'unavailable (lane L4 pending)',
  evaluate(expression, owner): string {
    return owner.err(
      `Expression evaluation is not available yet (lane L4). Expression: '${expression.write(false)}'`,
    );
  },
};

/** True when the text is a plain decimal number literal (`0`, `1.0`, `42`). */
function isNumberLiteral(text: string): boolean {
  return /^[0-9]+(\.[0-9]*)?$/.test(text) || /^\.[0-9]+$/.test(text);
}

/**
 * The pre-L4 stand-in documented above (PORT-NOTE(proplib/schema-literal-evaluator)): the
 * seam's test harness, not a default any more.
 */
export const schemaLiteralEvaluator: ExpressionEvaluator = {
  name: 'schema-literals (stand-in, lane L4 pending)',

  evaluate(expression: Expression, owner: Property): string {
    const elements = expression.elements;

    // Native drops a trailing semicolon before generating Python ("Don't add trailing
    // semicolon"), so `default 5;` evaluates as `5`.
    const last = elements[elements.length - 1];
    const end =
      elements.length > 1 && last !== undefined && last.kind === 'misc' && last.token.type === 'Semicolon'
        ? elements.length - 1
        : elements.length;

    const only = end === 1 ? elements[0] : undefined;

    if (only === undefined) {
      throw new ProplibError(
        `${expression.write(false)}: expression evaluation is lane L4; only single literal/` +
          `enum/class expressions can be read before it lands (owner '${owner.getFullName(0, '.')}')`,
      );
    }

    if (only.kind === 'misc') {
      const text = only.token.text;
      if (only.token.type === 'Number' && isNumberLiteral(text)) return text;
      if (only.token.type === 'Id' && PYTHON_LITERALS.has(text)) return text;
      if (only.token.type === 'String') {
        // Python would interpret the escapes and strip the quotes. Escapes are not
        // interpreted here (documented limit; no schema/default attribute needs it).
        return text.slice(1, text.endsWith('"') && text.length > 1 ? -1 : undefined);
      }
      throw new ProplibError(
        `'${text}': expression evaluation is lane L4 (owner '${owner.getFullName(0, '.')}')`,
      );
    }

    // A single symbol: native emits a *quoted* literal when the symbol is an enum value or
    // a class name, and the referenced property's value when it is a property.
    const sym = owner.findSymbol(only.symbolPath);
    if (sym === undefined) {
      if (PYTHON_LITERALS.has(only.symbolPath.toString())) return only.symbolPath.toString();
      throw new ProplibError(
        `'${only.symbolPath.toString()}': unresolved symbol; expression evaluation is lane L4`,
      );
    }
    if (sym.type === 'EnumValue' || sym.type === 'Class') {
      // Native: `exprbuf << '\"' << symbolPath->tail->getText() << '\"'` -> quotes stripped
      // again by the Python round trip, so the value is the name itself.
      const tail = only.symbolPath.tail;
      return tail ? tail.text : '';
    }

    throw new ProplibError(
      `'${only.symbolPath.toString()}': reference to property '${sym.prop?.getFullName(0, '.') ?? '?'}' ` +
        `needs expression evaluation (lane L4)`,
    );
  },
};

/**
 * Native `Interpreter::ExpressionEvaluator::evaluate`'s *code generation* half
 * (`interpreter.cc`): render an expression's tokens as the Python source text `python3` was
 * fed. Kept separate from the evaluation so it can be asserted on directly.
 *
 * The three rules are native's, in native's order:
 *
 *  1. a `Misc` element contributes its token's *decoration* (unless it is the first element)
 *     followed by its text — except a trailing semicolon, which is dropped;
 *  2. a `Symbol` element contributes its path's head decoration (unless it is first) and then,
 *     if the path resolves, either a quoted literal (an enum value or a class name) or the
 *     referenced property's evaluated value — quoted too when that property is an enum or a
 *     `String`; a non-scalar or a runtime property is an error, as native;
 *  3. an *unresolved* path is emitted verbatim ("Hopefully a Python symbol."), which is how
 *     `True`/`False`/`None` and Python builtins get through, and how a typo becomes the
 *     Python `NameError` native reports as `[Python] name '...' is not defined`.
 */
export function generatePythonExpression(expression: Expression, owner: Property): string {
  const elements = expression.elements;
  let out = '';

  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    const isFirst = index === 0;

    if (element.kind === 'misc') {
      if (!isFirst) out += element.token.getDecorationString();
      if (index !== elements.length - 1 || element.token.type !== 'Semicolon') {
        out += element.token.text;
      }
      continue;
    }

    const path = element.symbolPath;
    const head = path.head;
    if (head === undefined) continue;
    if (!isFirst) out += head.getDecorationString();

    const symbol = owner.findSymbol(path);
    if (symbol === undefined) {
      out += path.toString();
      continue;
    }

    switch (symbol.type) {
      case 'EnumValue':
      case 'Class': {
        // `exprbuf << '\"' << symbolPath->tail->getText() << '\"'`
        const tail = path.tail;
        out += `"${tail ? tail.text : ''}"`;
        break;
      }
      case 'Property': {
        const prop = symbol.prop;
        if (prop.getType() !== 'Scalar') {
          owner.err(`Illegal reference to non-scalar ${path.toString()}.`);
        }
        if (prop.getSubtype() === 'Runtime') {
          owner.err(
            `Illegal reference to runtime property ${path.toString()}. ` +
              `Only dynamic expresssions may use runtime properties.`,
          );
        }
        const value = prop.scalarText();
        out += prop.isEnumValue(value) || prop.isString() ? `"${value}"` : value;
        break;
      }
    }
  }

  return out;
}

/**
 * Lane L4 — `python3`, in process: native's `Interpreter::ExpressionEvaluator` with the
 * out-of-process child replaced by `pythonExpression.ts`.
 *
 * The result is `str( eval( text ) )`, unmodified and untrimmed — exactly the text native
 * stored as the property's value. A Python failure is reported the way native reported it,
 * `prop->err( "[Python] " + result )`, carrying the interpreter's own message.
 */
export function createInterpreterEvaluator(): ExpressionEvaluator {
  /** Properties whose expression is currently being evaluated (native `_isEvaluating`). */
  const evaluating = new Set<Property>();

  return {
    name: 'python3 (interpreter.py port)',

    evaluate(expression: Expression, owner: Property): string {
      if (evaluating.has(owner)) owner.err('Dependency cycle');

      evaluating.add(owner);
      try {
        const python = generatePythonExpression(expression, owner);
        try {
          return evaluatePythonExpressionText(python);
        } catch (error) {
          if (error instanceof PythonError) owner.err(`[Python] ${error.message}`);
          throw error;
        }
      } finally {
        evaluating.delete(owner);
      }
    },
  };
}

/**
 * The lane's evaluator. Native built one per property at document-build time; the port
 * builds one per document and calls it from the same lazy call sites. The shared instance is
 * safe because evaluation is synchronous and its only state is the re-entrancy set, which is
 * empty whenever a build is not inside a call — while a private instance is what a caller
 * wants for isolation (`createInterpreterEvaluator()`).
 */
export const interpreterEvaluator: ExpressionEvaluator = createInterpreterEvaluator();
