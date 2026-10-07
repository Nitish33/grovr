import JSON5 from 'json5';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** One log message. A multi-line message is a single entry. */
export interface LogEntry {
  id: number;
  level: LogLevel;
  /** Single-letter level shown in the badge (V D I W E F). Empty for lines without a header. */
  levelChar: string;
  /** "2026-10-07" and "20:56:47.350". Empty for lines without a header. */
  date: string;
  time: string;
  pid: string;
  tid: string;
  /** Android tag or iOS process name */
  tag: string;
  message: string;
  /** Lines with the same key may continue this entry (Android: time, pid, tid, level, tag) */
  key: string;
}

type ParsedLine = Omit<LogEntry, 'id'>;

// Android `logcat -v threadtime`: "10-07 20:56:47.350 10585 10762 I ReactNativeJS: message"
const ANDROID_LINE = /^(\d\d-\d\d)\s+(\d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*?)\s*:\s?(.*)$/;
// iOS `log stream --style compact`: "2026-10-07 12:00:00.123 Df App[123:456] message"
const IOS_LINE = /^(\d{4}-\d\d-\d\d)\s+(\d\d:\d\d:\d\d\.\d+)\s+(Df|Db|Ef|Fa|In|[IEF])\s+(.+?)\[(\d+):(\w+)\]\s?(.*)$/;
const STACK_LINE = /^\s+at\s|^Caused by:|^\s*\.\.\. \d+ more/;

const ANDROID_LEVELS: Record<string, LogLevel> = {
  V: 'debug',
  D: 'debug',
  I: 'info',
  W: 'warn',
  E: 'error',
  F: 'error',
};

const IOS_LEVEL_CHARS: Record<string, string> = {
  Db: 'D',
  Df: 'I',
  In: 'I',
  I: 'I',
  E: 'E',
  Ef: 'E',
  F: 'F',
  Fa: 'F',
};

const IOS_LEVELS: Record<string, LogLevel> = {
  Db: 'debug',
  Df: 'info',
  In: 'info',
  I: 'info',
  E: 'error',
  Ef: 'error',
  F: 'error',
  Fa: 'error',
};

function parseLine(text: string, platform: 'ios' | 'android'): ParsedLine | null {
  if (platform === 'android') {
    const m = ANDROID_LINE.exec(text);
    if (!m) return null;
    const [, monthDay, time, pid, tid, level, tag, message] = m;
    // logcat omits the year, so use the current one
    const date = `${new Date().getFullYear()}-${monthDay}`;
    return {
      level: ANDROID_LEVELS[level],
      levelChar: level,
      date,
      time,
      pid,
      tid,
      tag,
      message,
      key: `${date} ${time} ${pid} ${tid} ${level} ${tag}`,
    };
  }
  const m = IOS_LINE.exec(text);
  if (!m) return null;
  const [, date, time, level, process, pid, tid, message] = m;
  return {
    level: IOS_LEVELS[level] ?? 'info',
    levelChar: IOS_LEVEL_CHARS[level] ?? 'I',
    date,
    time,
    pid,
    tid,
    tag: process,
    message,
    key: '',
  };
}

/**
 * True when the message ends inside an open {, [ or ( (or a string within one), meaning the
 * next line of the same log call is probably still part of it.
 */
function isIncomplete(message: string): boolean {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < message.length; i++) {
    const c = message[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (depth > 0 && (c === "'" || c === '"' || c === '`')) quote = c;
    else if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth = Math.max(0, depth - 1);
  }
  return depth > 0 || quote !== '';
}

/**
 * Appends raw lines to `entries` (mutating it), merging the lines of a multi-line message
 * into one entry. Android prints a header on every line of a message, so a line continues
 * the previous entry only when it has the same header and that entry is still open (an
 * unclosed bracket) or looks like a stack trace; iOS continuation lines have no header.
 */
export function appendLogLines(
  entries: LogEntry[],
  lines: string[],
  platform: 'ios' | 'android',
  nextId: () => number
) {
  for (const text of lines) {
    const last = entries[entries.length - 1];
    const parsed = parseLine(text, platform);

    if (!parsed) {
      if (last) entries[entries.length - 1] = { ...last, message: `${last.message}\n${text}` };
      else entries.push({ id: nextId(), level: 'info', levelChar: '', date: '', time: '', pid: '', tid: '', tag: '', message: text, key: '' });
      continue;
    }

    const continues =
      last !== undefined &&
      platform === 'android' &&
      last.key === parsed.key &&
      (isIncomplete(last.message) || STACK_LINE.test(parsed.message));

    if (continues) entries[entries.length - 1] = { ...last, message: `${last.message}\n${parsed.message}` };
    else entries.push({ id: nextId(), ...parsed });
  }
}

export function levelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

/** Index just past the bracket group starting at `start`, or -1 if it never closes. */
function matchingEnd(text: string, start: number): number {
  let depth = 0;
  let quote = '';
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const MIN_FORMAT_LENGTH = 40;

/** Pretty-prints every JSON / JS-object literal found in a message; other text is left as is. */
export function formatLogMessage(message: string): string {
  let result = '';
  let i = 0;
  while (i < message.length) {
    const c = message[i];
    if (c === '{' || c === '[') {
      const end = matchingEnd(message, i);
      if (end !== -1 && end - i >= MIN_FORMAT_LENGTH) {
        try {
          const value: unknown = JSON5.parse(message.slice(i, end));
          result += JSON.stringify(value, null, 2);
          i = end;
          continue;
        } catch {
          // Not JSON (e.g. a truncated or non-literal object): keep the text
        }
      }
    }
    result += c;
    i++;
  }
  return result;
}

/** Plain text of an entry, used for filtering and copying. */
export function entryText(entry: LogEntry): string {
  if (!entry.levelChar) return entry.message;
  return `${entry.date} ${entry.time} ${entry.pid}-${entry.tid} ${entry.tag} ${entry.levelChar} ${entry.message}`;
}

export const TAG_COLOR_COUNT = 8;

/** Stable colour slot for a tag, so the same tag always gets the same colour. */
export function tagColorIndex(tag: string): number {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
  return hash % TAG_COLOR_COUNT;
}

export type LogColumn = 'time' | 'ids' | 'tag' | 'package' | 'level';

interface LogColumnDef {
  id: LogColumn;
  label: string;
  /** CSS grid track for the column; the message column always fills the rest */
  track: string;
  /** Only meaningful on this platform (e.g. iOS logs have no package) */
  platform?: 'ios' | 'android';
}

/** Columns in display order; the message itself is always shown last. */
export const LOG_COLUMNS: readonly LogColumnDef[] = [
  { id: 'time', label: 'Time', track: 'max-content' },
  { id: 'ids', label: 'Process / thread ID', track: 'max-content' },
  { id: 'tag', label: 'Tag', track: 'fit-content(24ch)' },
  { id: 'package', label: 'Package', track: 'fit-content(40ch)', platform: 'android' },
  { id: 'level', label: 'Level', track: 'max-content' },
];

export function columnsFor(platform: 'ios' | 'android'): LogColumnDef[] {
  return LOG_COLUMNS.filter((column) => !column.platform || column.platform === platform);
}

/** CSS `grid-template-columns` for the visible columns plus the message. */
export function gridTemplate(visible: ReadonlySet<LogColumn>, platform: 'ios' | 'android'): string {
  const tracks = columnsFor(platform)
    .filter((column) => visible.has(column.id))
    .map((column) => column.track);
  return [...tracks, 'minmax(0, 1fr)'].join(' ');
}
