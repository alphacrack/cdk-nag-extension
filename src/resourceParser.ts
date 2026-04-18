// Multi-line-aware parser for `new TypeName(this, 'id'[, { ... }])` expressions.
//
// The prior implementation used a single-line regex:
//   /new\s+([\w.]+)\s*\(\s*this\s*,\s*['"]([^'"]+)['"]\s*,\s*({[^}]+})/g
// which fails on two common real-world patterns:
//   1. Constructs spanning multiple lines (the usual shape in CDK code).
//   2. Constructs with no options object — e.g. `new Bucket(this, 'B');`.
//
// This module walks the source once with a small brace-balanced scanner.
// It is deliberately tiny (no TypeScript AST dep, no regex back-tracking):
// we only need to locate `new X(this, 'id', {...})` occurrences and carve
// out their argument ranges. Edge cases we intentionally accept in exchange
// for simplicity:
//   • String literals with back-slash escapes (handled).
//   • Template literals — `${...}` substitutions are tracked as a single
//     brace level so `} }` inside a template does not confuse the scanner.
//   • Line comments (//…) and block comments (/* … */) are skipped.
//   • Regex literals are NOT tracked — `{`/`}` inside a character class is
//     vanishingly rare in CDK construct args. If it appears, the match is
//     simply skipped (no false positives emitted).

export interface ResourceDefinition {
  /** Type expression between `new` and `(` — e.g. `s3.Bucket`, `Bucket`. */
  type: string;
  /** Second constructor argument — the logical id. */
  id: string;
  /** Inside-braces text of the third argument, or `null` if absent. */
  config: string | null;
  /** Start offset in the source (byte offset of the `new` keyword). */
  start: number;
  /** End offset in the source (exclusive; position of the closing `)`). */
  end: number;
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const TYPE_EXPR = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/y;

/**
 * Walks `source` and returns every `new TypeName(this, 'id', {...}?)` it
 * finds. Occurrences are returned in source order.
 *
 * The parser is non-throwing — malformed input simply produces no match
 * for that occurrence and the scan continues from the next character.
 */
export function parseResourceDefinitions(source: string): ResourceDefinition[] {
  const out: ResourceDefinition[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    // Fast path: skip comments and strings between `new` keywords so we
    // don't trip on `// new Bucket(...)` or `"new Bucket(...)"`.
    const ch = source[i];

    // Line comment
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) return out;
      i += 1;
      continue;
    }
    // Block comment
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return out;
      i = end + 2;
      continue;
    }
    // String literals — skip to matching quote, honouring back-slash escapes.
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(source, i);
      continue;
    }

    // `new` must be whitespace-preceded (or at offset 0) to be a keyword.
    if (ch !== 'n' || !source.startsWith('new', i)) {
      i += 1;
      continue;
    }
    const preceding = i === 0 ? ' ' : source[i - 1];
    if (/[\w$]/.test(preceding)) {
      i += 1;
      continue;
    }
    const afterKeyword = source[i + 3];
    if (!/\s/.test(afterKeyword)) {
      i += 1;
      continue;
    }

    const parsed = tryParseNewCall(source, i);
    if (parsed) {
      out.push(parsed);
      i = parsed.end;
    } else {
      i += 1;
    }
  }

  return out;
}

/**
 * Attempt to parse a single `new X(this, 'id'[, {...}])` expression starting
 * at `start`. Returns `null` if the shape does not match; does NOT throw.
 */
function tryParseNewCall(source: string, start: number): ResourceDefinition | null {
  // Position after `new` + mandatory whitespace.
  let i = start + 3;
  i = skipTrivia(source, i);

  // Type expression (may include dots: `aws_s3.Bucket`).
  TYPE_EXPR.lastIndex = i;
  const typeMatch = TYPE_EXPR.exec(source);
  if (!typeMatch || typeMatch.index !== i) return null;
  const type = typeMatch[0];
  i += type.length;

  i = skipTrivia(source, i);
  if (source[i] !== '(') return null;
  i += 1;

  // First arg must be the identifier `this` (that's what cdk constructs use).
  i = skipTrivia(source, i);
  IDENT.lastIndex = i;
  const firstIdent = IDENT.exec(source);
  if (!firstIdent || firstIdent.index !== i || firstIdent[0] !== 'this') return null;
  i += 4;

  i = skipTrivia(source, i);
  if (source[i] !== ',') return null;
  i += 1;

  // Second arg: string literal → the id.
  i = skipTrivia(source, i);
  const idStart = source[i];
  if (idStart !== '"' && idStart !== "'" && idStart !== '`') return null;
  const idEnd = skipString(source, i);
  if (idEnd <= i + 1) return null;
  // Inclusive quote stripping — template literal substitutions are rare for
  // ids so we just take the raw inner text.
  const idInner = source.slice(i + 1, idEnd - 1);
  i = idEnd;

  i = skipTrivia(source, i);

  let config: string | null = null;

  if (source[i] === ',') {
    i += 1;
    i = skipTrivia(source, i);
    if (source[i] === '{') {
      const objEnd = findMatchingBrace(source, i);
      if (objEnd === -1) return null;
      config = source.slice(i + 1, objEnd); // inside-braces content
      i = objEnd + 1;
      i = skipTrivia(source, i);
    } else {
      // The optional third arg is not a brace literal (could be a variable,
      // a `props` pass-through, etc.). Walk to the closing paren matching
      // whatever the user wrote — we just need the `end` offset.
      const parenEnd = findMatchingParen(source, start);
      if (parenEnd === -1) return null;
      return {
        type,
        id: idInner,
        config: null,
        start,
        end: parenEnd + 1,
      };
    }
  }

  if (source[i] !== ')') {
    // Trailing args we don't care about (e.g. 4-arg constructors). Locate
    // the closing paren and accept.
    const parenEnd = findMatchingParen(source, start);
    if (parenEnd === -1) return null;
    return {
      type,
      id: idInner,
      config,
      start,
      end: parenEnd + 1,
    };
  }

  return {
    type,
    id: idInner,
    config,
    start,
    end: i + 1,
  };
}

function skipTrivia(source: string, i: number): number {
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
    } else if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      if (nl === -1) return n;
      i = nl + 1;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return n;
      i = end + 2;
    } else {
      break;
    }
  }
  return i;
}

/** Returns the offset just past the closing quote of the string at `start`. */
function skipString(source: string, start: number): number {
  const quote = source[start];
  const n = source.length;
  let i = start + 1;
  while (i < n) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) {
      return i + 1;
    }
    // Template literal ${...} — honour brace balancing but stay in string mode.
    if (quote === '`' && c === '$' && source[i + 1] === '{') {
      const end = findMatchingBrace(source, i + 1);
      if (end === -1) return n;
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return n;
}

/**
 * Given an index pointing at `{`, return the index of the matching `}`,
 * or -1 if unbalanced. Tracks strings and comments so that e.g.
 *   { foo: "}" }
 * returns the second `}`.
 */
function findMatchingBrace(source: string, open: number): number {
  return findMatchingCloser(source, open, '{', '}');
}

function findMatchingParen(source: string, newKeywordStart: number): number {
  // Locate the first `(` after the type expression, then brace-match.
  const paren = source.indexOf('(', newKeywordStart);
  if (paren === -1) return -1;
  return findMatchingCloser(source, paren, '(', ')');
}

function findMatchingCloser(source: string, open: number, o: string, c: string): number {
  const n = source.length;
  let depth = 0;
  let i = open;
  while (i < n) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      if (nl === -1) return -1;
      i = nl + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    if (ch === o) depth += 1;
    else if (ch === c) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}
