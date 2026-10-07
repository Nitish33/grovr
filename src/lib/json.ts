import JSON5 from 'json5';

export type JsonParseResult =
  | { ok: true; value: unknown; note?: string }
  | { ok: false; message: string; line?: number; column?: number };

const MAX_UNWRAP_DEPTH = 3;

function looksLikeJsonContainer(text: string): boolean {
  const t = text.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

function describeError(err: unknown): { message: string; line?: number; column?: number } {
  if (err instanceof SyntaxError) {
    const { lineNumber, columnNumber } = err as SyntaxError & {
      lineNumber?: number;
      columnNumber?: number;
    };
    return {
      message: err.message.replace(/^JSON5:\s*/, '').replace(/\s+at \d+:\d+$/, ''),
      line: lineNumber,
      column: columnNumber,
    };
  }
  return { message: 'Unable to parse input' };
}

/**
 * Parses strict JSON first, then falls back to JS-style object literals
 * (unquoted keys, single quotes, comments, trailing commas) via JSON5.
 * Also unwraps JSON that was stringified into a string ("{\"a\":1}").
 * Returns null for empty input.
 */
export function parseLooseJson(text: string): JsonParseResult | null {
  if (text.trim() === '') return null;

  let note: string | undefined;
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    try {
      value = JSON5.parse(text);
      note = 'Parsed as a JavaScript object (not strict JSON)';
    } catch (err) {
      return { ok: false, ...describeError(err) };
    }
  }

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    if (typeof value !== 'string' || !looksLikeJsonContainer(value)) break;
    try {
      value = JSON5.parse(value);
      note = 'Unwrapped a stringified JSON value';
    } catch {
      break;
    }
  }

  return { ok: true, value, note };
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const MAX_URL_LENGTH = 2048;

/** Returns the string if it looks like an image link (by extension or data URI), else null. */
export function imageUrlOf(value: string): string | null {
  const text = value.trim();

  if (text.startsWith('data:image/')) return text;
  if (text.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(text)) return null;

  try {
    return IMAGE_EXTENSION.test(new URL(text).pathname) ? text : null;
  } catch {
    return null;
  }
}

export function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

export function childEntries(value: Record<string, unknown> | unknown[]): [string, unknown][] {
  return Array.isArray(value)
    ? value.map((item, i) => [String(i), item])
    : Object.entries(value);
}

/** Text copied for a node: strings as-is, everything else as formatted JSON. */
export function copyText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

export type JsonTokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'plain';

const TOKEN_PATTERN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Splits formatted JSON into tokens for syntax highlighting. */
export function tokenizeJson(text: string): { kind: JsonTokenKind; text: string }[] {
  const tokens: { kind: JsonTokenKind; text: string }[] = [];
  let last = 0;

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ kind: 'plain', text: text.slice(last, index) });

    if (match[1] !== undefined) {
      if (match[2] !== undefined) {
        tokens.push({ kind: 'key', text: match[1] });
        tokens.push({ kind: 'plain', text: match[2] });
      } else {
        tokens.push({ kind: 'string', text: match[1] });
      }
    } else if (match[3] !== undefined) {
      tokens.push({ kind: 'boolean', text: match[0] });
    } else if (match[0] === 'null') {
      tokens.push({ kind: 'null', text: match[0] });
    } else {
      tokens.push({ kind: 'number', text: match[0] });
    }
    last = index + match[0].length;
  }

  if (last < text.length) tokens.push({ kind: 'plain', text: text.slice(last) });
  return tokens;
}
