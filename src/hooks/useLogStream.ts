import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as api from '@/lib/api';
import { appendLogLines, type LogEntry } from '@/lib/logs';

const MAX_ENTRIES = 5000;
const MAX_HELD_LINES = 20000;
const PROCESS_LOOKUP_DELAY_MS = 700;

/**
 * Cuts `list` down to MAX_ENTRIES. Entries the current filters hide go first (oldest first),
 * so filtered-out noise can't push out the entries being looked at.
 */
function trimEntries(list: LogEntry[], isKept?: (entry: LogEntry) => boolean) {
  let excess = list.length - MAX_ENTRIES;
  if (isKept) {
    const survivors: LogEntry[] = [];
    for (const entry of list) {
      if (excess > 0 && !isKept(entry)) excess--;
      else survivors.push(entry);
    }
    list.splice(0, list.length, ...survivors);
  }
  if (excess > 0) list.splice(0, excess);
}

export type StreamStatus = 'connecting' | 'live' | 'ended' | 'error';

/**
 * Live native log entries for one device, capped to the most recent MAX_ENTRIES.
 * On iOS, `appFilter` narrows the stream itself (restarting it and clearing the view) */
export function useLogStream(
  platform: api.DevicePlatform,
  deviceId: string,
  appFilter = '',
  /** When the buffer is full, entries this returns false for are dropped before any others */
  isKeptRef?: MutableRefObject<(entry: LogEntry) => boolean>
) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [error, setError] = useState('');
  const [paused, setPausedState] = useState(false);
  const pausedRef = useRef(false);
  const heldRef = useRef<string[]>([]);
  const entriesRef = useRef<LogEntry[]>([]);
  const nextIdRef = useRef(0);
  const [processNames, setProcessNames] = useState<Record<string, string>>({});
  const triedPidsRef = useRef(new Set<string>());
  const lookupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Android logs only carry a PID, so look up which app each one belongs to. Each PID is
  // tried once; lookups are batched since many new PIDs usually appear together.
  const resolveProcesses = useCallback(
    (newEntries: LogEntry[]) => {
      if (platform !== 'android') return;
      let hasNew = false;
      for (const entry of newEntries) {
        if (entry.pid && !triedPidsRef.current.has(entry.pid)) {
          triedPidsRef.current.add(entry.pid);
          hasNew = true;
        }
      }
      if (!hasNew || lookupTimerRef.current) return;
      lookupTimerRef.current = setTimeout(() => {
        lookupTimerRef.current = null;
        api
          .listAndroidProcesses(deviceId)
          .then((names) => setProcessNames((prev) => ({ ...prev, ...names })))
          .catch(() => undefined);
      }, PROCESS_LOOKUP_DELAY_MS);
    },
    [platform, deviceId]
  );

  // Entries are built in a ref so a message split over several lines can be merged
  // into the previous entry, even across batches
  const append = useCallback(
    (lines: string[]) => {
      const list = entriesRef.current;
      const before = list.length;
      appendLogLines(list, lines, platform, () => nextIdRef.current++);
      resolveProcesses(list.slice(before));
      if (list.length > MAX_ENTRIES) trimEntries(list, isKeptRef?.current);
      setEntries(list.slice());
    },
    [platform, resolveProcesses, isKeptRef]
  );

  const start = useCallback(async () => {
    setStatus('connecting');
    setError('');
    try {
      await api.startLogStream(platform, deviceId, platform === 'ios' ? appFilter : '');
      setStatus('live');
    } catch (err) {
      setError(String(err));
      setStatus('error');
    }
  }, [platform, deviceId, appFilter]);

  useEffect(() => {
    // A new stream (e.g. after the app filter changed) starts from an empty view
    heldRef.current = [];
    entriesRef.current = [];
    setEntries([]);

    const unlistenLog = listen<string[]>('device-log', (event) => {
      if (pausedRef.current) heldRef.current = heldRef.current.concat(event.payload).slice(-MAX_HELD_LINES);
      else append(event.payload);
    });
    const unlistenEnd = listen('device-log-end', () => setStatus('ended'));

    // Listeners are registered before the stream starts so no early lines are missed
    void Promise.all([unlistenLog, unlistenEnd]).then(() => start());

    // No explicit stop: starting replaces any previous stream and the backend kills
    // the process when the window closes
    return () => {
      if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current);
      lookupTimerRef.current = null;
      void unlistenLog.then((off) => off());
      void unlistenEnd.then((off) => off());
    };
  }, [platform, append, start]);

  const setPaused = useCallback(
    (next: boolean) => {
      pausedRef.current = next;
      setPausedState(next);
      if (!next && heldRef.current.length > 0) {
        append(heldRef.current);
        heldRef.current = [];
      }
    },
    [append]
  );

  const clear = useCallback(() => {
    heldRef.current = [];
    entriesRef.current = [];
    setEntries([]);
  }, []);

  return { entries, processNames, status, error, paused, setPaused, clear, restart: start };
}
