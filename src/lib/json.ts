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

export type JsonValueKind = 'string' | 'number' | 'boolean' | 'null' | 'punct';

export interface JsonCodeLine {
  id: string;
  depth: number;
  /** Object key shown before the value; null for array items and the root. */
  key: string | null;
  /** The value text on this line: a primitive, an opening/closing bracket, or "[]" / "{}". */
  text: string;
  kind: JsonValueKind;
  /** Trailing comma after this line. */
  comma: boolean;
  /** Value copied by the line's copy button; absent for closing brackets. */
  copyValue?: unknown;
  hasCopy: boolean;
}

function primitiveKind(value: unknown): JsonValueKind {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'null';
}

/**
 * Lays a value out line by line, matching `JSON.stringify(value, null, 2)`
 * (2-space indent, "[]"/"{}" for empty containers), so each line can carry its own copy button.
 */
export function buildCodeLines(root: unknown): JsonCodeLine[] {
  const lines: JsonCodeLine[] = [];

  const visit = (value: unknown, key: string | null, depth: number, comma: boolean, path: string) => {
    if (isContainer(value)) {
      const entries = childEntries(value);
      const isArray = Array.isArray(value);
      const [open, close] = isArray ? ['[', ']'] : ['{', '}'];

      if (entries.length === 0) {
        lines.push({ id: path, depth, key, text: open + close, kind: 'punct', comma, copyValue: value, hasCopy: true });
        return;
      }

      lines.push({ id: path, depth, key, text: open, kind: 'punct', comma: false, copyValue: value, hasCopy: true });
      entries.forEach(([childKey, child], i) => {
        visit(child, isArray ? null : childKey, depth + 1, i < entries.length - 1, `${path}.${childKey}`);
      });
      lines.push({ id: `${path}#end`, depth, key: null, text: close, kind: 'punct', comma, hasCopy: false });
      return;
    }

    lines.push({
      id: path,
      depth,
      key,
      text: JSON.stringify(value) ?? 'null',
      kind: primitiveKind(value),
      comma,
      copyValue: value,
      hasCopy: true,
    });
  };

  visit(root, null, 0, false, '$');
  return lines;
}
