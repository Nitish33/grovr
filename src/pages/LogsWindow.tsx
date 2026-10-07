import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  Check,
  Copy,
  Pause,
  Play,
  RotateCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { LogColumnsMenu } from "@/components/log-viewer/LogColumnsMenu";
import { useAppTheme } from "@/hooks/useAppTheme";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useUserApps } from "@/hooks/useUserApps";
import { useLogColumns } from "@/hooks/useLogColumns";
import { useLogStream } from "@/hooks/useLogStream";
import * as api from "@/lib/api";
import type { DevicePlatform } from "@/lib/api";
import {
  LOG_LEVELS,
  entryText,
  formatLogMessage,
  gridTemplate,
  levelRank,
  tagColorIndex,
  type LogColumn,
  type LogEntry,
  type LogLevel,
} from "@/lib/logs";

const SCROLL_BOTTOM_THRESHOLD_PX = 8;
const STREAM_FILTER_DELAY_MS = 600;

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "Debug",
  info: "Info",
  warn: "Warning",
  error: "Error",
};

const STATUS_TEXT = {
  connecting: "Connecting…",
  live: "Live",
  ended: "Stream ended (device stopped?)",
  error: "Could not start the log stream",
} as const;

const LogEntryRow = memo(function LogEntryRow({
  entry,
  packageName,
  columns,
}: {
  entry: LogEntry;
  packageName: string;
  columns: ReadonlySet<LogColumn>;
}) {
  const message = useMemo(() => formatLogMessage(entry.message), [entry.message]);
  return (
    <div className={`logs-line logs-line-${entry.level}`}>
      {columns.has("time") && (
        <span className="logs-time">{entry.time}</span>
      )}
      {columns.has("ids") && (
        <span className="logs-ids">{entry.pid && `${entry.pid}-${entry.tid}`}</span>
      )}
      {columns.has("tag") && (
        <span className={`logs-tag logs-tag-${tagColorIndex(entry.tag)}`}>{entry.tag}</span>
      )}
      {columns.has("package") && <span className="logs-package">{packageName}</span>}
      {columns.has("level") && (
        <span>
          {entry.levelChar && (
            <span className={`logs-badge logs-badge-${entry.level}`}>{entry.levelChar}</span>
          )}
        </span>
      )}
      <span className="logs-message">{message}</span>
    </div>
  );
});

function readParams() {
  const params = new URLSearchParams(window.location.search);
  const platform: DevicePlatform =
    params.get("platform") === "android" ? "android" : "ios";
  return {
    platform,
    deviceId: params.get("id") ?? "",
    name: params.get("name") ?? "",
  };
}

export function LogsWindow() {
  useAppTheme();
  const { platform, deviceId, name } = useMemo(readParams, []);
  // Keep logs from apps whose package (Android) or process name (iOS) contains this text
  const [appFilter, setAppFilter] = useState("");
  // On iOS the simulator logs every process, so the filter also narrows the stream itself.
  // That restarts the stream, so only apply it once typing pauses.
  const [streamFilter, setStreamFilter] = useState("");
  useEffect(() => {
    if (platform !== "ios") return;
    const timer = setTimeout(() => setStreamFilter(appFilter.trim()), STREAM_FILTER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [platform, appFilter]);

  // Which entries the buffer drops last when it is full; kept in sync with the filters below
  const isKeptRef = useRef<(entry: LogEntry) => boolean>(() => true);
  const { entries, processNames, status, error, paused, setPaused, clear, restart } =
    useLogStream(platform, deviceId, streamFilter, isKeptRef);
  const { visible: columns, toggle: toggleColumn } = useLogColumns(platform);
  const [minLevel, setMinLevel] = useState<LogLevel>("debug");
  const [query, setQuery] = useState("");
  // Following = pinned to the newest line. Mirrored in a ref so a batch of new lines that
  // arrives mid-gesture sees the user's latest scroll intent before React re-renders.
  const [following, setFollowingState] = useState(true);
  const followingRef = useRef(true);
  const [seenId, setSeenId] = useState(-1);
  const outputRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { copiedKey, copy } = useCopyToClipboard();

  const deferredQuery = useDeferredValue(query);
  const { apps: userApps, refresh: refreshUserApps } = useUserApps(platform, deviceId);

  const matches = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const minRank = levelRank(minLevel);
    const appNeedle = appFilter.trim().toLowerCase();
    // Android logs carry a PID resolved to a package; iOS logs carry the process name
    const appOf = (entry: LogEntry) => (platform === "android" ? (processNames[entry.pid] ?? "") : entry.tag);
    return (entry: LogEntry) =>
      levelRank(entry.level) >= minRank &&
      (appNeedle === "" || appOf(entry).toLowerCase().includes(appNeedle)) &&
      (needle === "" || entryText(entry).toLowerCase().includes(needle));
  }, [deferredQuery, minLevel, appFilter, processNames, platform]);

  const visible = useMemo(() => entries.filter(matches), [entries, matches]);

  // A PID not yet resolved to a package might still match, so don't count it as hidden
  useEffect(() => {
    const appActive = appFilter.trim() !== "";
    isKeptRef.current = (entry) =>
      matches(entry) || (platform === "android" && appActive && !processNames[entry.pid]);
  }, [matches, appFilter, processNames, platform]);

  useEffect(() => {
    document.title = `Logs - ${name}`;
  }, [name]);

  // Cmd/Ctrl+F jumps to the filter box
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const setFollowing = (next: boolean) => {
    followingRef.current = next;
    setFollowingState(next);
  };

  // Stick to the bottom while following; otherwise leave the scroll position alone
  useEffect(() => {
    const el = outputRef.current;
    if (!followingRef.current || !el) return;
    el.scrollTop = el.scrollHeight;
    setSeenId(visible.length > 0 ? visible[visible.length - 1].id : -1);
  }, [visible, following]);

  // Entries (matching the current filter) that arrived after the user scrolled away
  const newCount = useMemo(() => {
    let count = 0;
    for (let i = visible.length - 1; i >= 0 && visible[i].id > seenId; i--)
      count++;
    return count;
  }, [visible, seenId]);

  const handleScroll = () => {
    const el = outputRef.current;
    if (!el) return;
    setFollowing(
      el.scrollHeight - el.scrollTop - el.clientHeight <
        SCROLL_BOTTOM_THRESHOLD_PX,
    );
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) setFollowing(false);
  };

  const jumpToLatest = () => setFollowing(true);

  const handleCopyForAi = async () => {
    try {
      const path = await api.saveLogSnapshot(
        name,
        visible.map(entryText).join("\n"),
      );
      await copy(`Check this file for logs '${path}'`, "ai");
    } catch (err) {
      console.error("Failed to save the log snapshot:", err);
    }
  };

  const statusText = status === "error" && error ? error : STATUS_TEXT[status];

  return (
    <div className="h-full flex flex-col">
      <div className="json-toolbar">
        <div className="logs-filters">
          <select
            className="logs-select"
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value as LogLevel)}
            aria-label="Minimum log level"
          >
            {LOG_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level === "debug" ? "All levels" : `${LEVEL_LABELS[level]}+`}
              </option>
            ))}
          </select>
          <div className="logs-app-filter">
            <span className="logs-app-filter-prefix">{platform === "android" ? "package:" : "app:"}</span>
            <input
              className="logs-app-filter-input"
              list="logs-app-options"
              value={appFilter}
              onChange={(e) => setAppFilter(e.target.value)}
              onFocus={refreshUserApps}
              onKeyDown={(e) => e.key === "Escape" && setAppFilter("")}
              aria-label={platform === "android" ? "Filter by package name" : "Filter by app name"}
              title="Show logs from apps whose name contains this text"
              spellCheck={false}
            />
            {appFilter !== "" && (
              <button
                className="logs-app-filter-clear"
                onClick={() => setAppFilter("")}
                title="Clear the app filter"
                aria-label="Clear the app filter"
              >
                <X size={12} />
              </button>
            )}
            <datalist id="logs-app-options">
              {userApps.map((app) => (
                <option key={app} value={app} />
              ))}
            </datalist>
          </div>
          <div className="logs-search">
            <Search size={12} className="json-search-icon" />
            <input
              ref={searchRef}
              className="json-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Filter logs…  (⌘F)"
              aria-label="Filter logs"
              spellCheck={false}
            />
          </div>
        </div>
        <div className="json-toolbar-actions">
          <LogColumnsMenu platform={platform} visible={columns} onToggle={toggleColumn} />
          {(status === "ended" || status === "error") && (
            <button
              className="json-button"
              onClick={() => void restart()}
              title="Restart the log stream"
            >
              <RotateCw size={12} />
              <span>Restart</span>
            </button>
          )}
          <button
            className="json-button"
            onClick={() => setPaused(!paused)}
            title={paused ? "Resume the live view" : "Pause the live view"}
          >
            {paused ? <Play size={12} /> : <Pause size={12} />}
            <span>{paused ? "Resume" : "Pause"}</span>
          </button>
          <button
            className="json-button"
            onClick={() => void copy(visible.map(entryText).join("\n"), "logs")}
            disabled={visible.length === 0}
            title="Copy the visible lines"
          >
            {copiedKey === "logs" ? <Check size={12} /> : <Copy size={12} />}
            <span>{copiedKey === "logs" ? "Copied" : "Copy"}</span>
          </button>
          <button
            className="json-button"
            onClick={() => void handleCopyForAi()}
            disabled={visible.length === 0}
            title="Save the visible lines to a temp file and copy a prompt pointing to it"
          >
            {copiedKey === "ai" ? <Check size={12} /> : <Sparkles size={12} />}
            <span>{copiedKey === "ai" ? "Prompt copied" : "Copy for AI"}</span>
          </button>
          <button
            className="json-button"
            onClick={clear}
            disabled={entries.length === 0}
            title="Clear the log"
          >
            <Trash2 size={12} />
            <span>Clear</span>
          </button>
        </div>
      </div>

      <div
        className={`json-status ${status === "error" || status === "ended" ? "json-status-error" : ""}`}
        title={`${entries.length} entries buffered`}
      >
        {name} · {paused ? "Paused" : statusText} · {visible.length}
        entries
      </div>

      <div className="logs-viewport">
        <div
          ref={outputRef}
          className="logs-output"
          style={{ gridTemplateColumns: gridTemplate(columns, platform) }}
          onScroll={handleScroll}
          onWheel={handleWheel}
          role="log"
          aria-live="off"
        >
          {visible.length === 0 && (
            <div className="devices-message">
              {entries.length === 0
                ? "Waiting for log output…"
                : "No lines match the current filter."}
            </div>
          )}
          {visible.map((entry) => (
            <LogEntryRow
              key={entry.id}
              entry={entry}
              packageName={processNames[entry.pid] ?? ''}
              columns={columns}
            />
          ))}
        </div>
        {!following && newCount > 0 && (
          <button
            className="logs-new-pill"
            onClick={jumpToLatest}
            title="Scroll to the latest messages"
          >
            <ArrowDown size={12} />
            <span>
              {newCount} new message{newCount === 1 ? "" : "s"}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
