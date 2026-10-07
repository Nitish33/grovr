import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { Check, ChevronsDownUp, ChevronsUpDown, ClipboardPaste, Copy, History, Save, Search, Trash2, X } from 'lucide-react';
import { ImagePreviewProvider } from '@/components/json/ImagePreview';
import { JsonCode } from '@/components/json/JsonCode';
import { JsonHistoryDialog, SaveJsonDialog } from '@/components/json/JsonSaveDialogs';
import { JsonTree } from '@/components/json/JsonTree';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useSavedJson } from '@/hooks/useSavedJson';
import { usePersistedString } from '@/hooks/usePersistedString';
import * as api from '@/lib/api';
import { parseLooseJson, searchJson, type JsonParseResult } from '@/lib/json';
import { applyTheme, type ThemeMode } from '@/lib/theme';

type ViewMode = 'tree' | 'code';

const MIN_LEFT_PCT = 20;
const MAX_LEFT_PCT = 80;
const KEY_STEP_PCT = 2;
const INPUT_STORAGE_KEY = 'grovr.jsonViewer.input';
const DEFAULT_TREE_DEPTH = 1;
const EXPAND_ALL_DEPTH = Number.POSITIVE_INFINITY;

function ErrorDetails({ result, input }: { result: Extract<JsonParseResult, { ok: false }>; input: string }) {
  const lineText = result.line ? input.split('\n')[result.line - 1] : undefined;

  return (
    <div className="json-error" role="alert">
      <div className="json-error-title">Syntax error</div>
      <div>{result.message}</div>
      {result.line !== undefined && (
        <div className="json-error-location">
          Line {result.line}
          {result.column !== undefined && `, column ${result.column}`}
        </div>
      )}
      {lineText !== undefined && <pre className="json-error-line">{lineText}</pre>}
    </div>
  );
}

export function JsonViewerWindow() {
  const [input, setInput] = usePersistedString(INPUT_STORAGE_KEY);
  const [view, setView] = useState<ViewMode>('tree');
  const [treeDepth, setTreeDepth] = useState(DEFAULT_TREE_DEPTH);
  const [treeResetKey, setTreeResetKey] = useState(0);
  const [leftPct, setLeftPct] = useState(45);
  const [query, setQuery] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const saved = useSavedJson();
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { copiedKey, copy } = useCopyToClipboard();

  // Follow the saved app theme (and the OS theme in "system" mode)
  useEffect(() => {
    let theme: ThemeMode = 'system';
    const apply = () => applyTheme(theme);
    api
      .getSettings()
      .then((settings) => {
        theme = (settings.theme as ThemeMode) || 'system';
        apply();
      })
      .catch(apply);

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => theme === 'system' && apply();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const deferredInput = useDeferredValue(input);
  const result = useMemo(() => parseLooseJson(deferredInput), [deferredInput]);
  const formatted = useMemo(
    () => (result?.ok ? (JSON.stringify(result.value, null, 2) ?? '') : ''),
    [result]
  );

  // Search runs on a deferred copy of the query so typing stays responsive on big documents
  const deferredQuery = useDeferredValue(query);
  const search = useMemo(
    () => (result?.ok && deferredQuery.trim() !== '' ? searchJson(result.value, deferredQuery) : null),
    [result, deferredQuery]
  );

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(timer);
  }, [toast]);

  const hasInput = input.trim() !== '';
  const activeItem = saved.items.find((item) => item.id === activeSavedId);

  // Updates the loaded/saved record in place; otherwise asks for a title
  const requestSave = () => {
    if (!hasInput) return;
    if (activeItem) {
      setToast(saved.update(activeItem.id, input) ? `Updated "${activeItem.title}"` : 'Could not save - storage is full');
    } else {
      setSaveOpen(true);
    }
  };

  // Cmd/Ctrl+F jumps to the search box, Cmd/Ctrl+S saves
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        requestSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const handlePaste = useCallback(async () => {
    try {
      setInput(await readText());
      setActiveSavedId(null);
    } catch (err) {
      console.error('Failed to read clipboard:', err);
    }
  }, []);

  const setExpansion = (depth: number) => {
    setTreeDepth(depth);
    setTreeResetKey((k) => k + 1);
  };

  const resizeTo = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setLeftPct(Math.min(MAX_LEFT_PCT, Math.max(MIN_LEFT_PCT, pct)));
  };

  const status = !result
    ? 'Paste JSON on the left'
    : result.ok
      ? (result.note ?? 'Valid JSON')
      : 'Invalid JSON';

  return (
    <ImagePreviewProvider>
    <div className="h-full flex flex-col">
      <div
        ref={containerRef}
        className="json-split"
        style={{ gridTemplateColumns: `${leftPct}% 6px minmax(0, 1fr)` }}
      >
        {/* Input pane */}
        <section className="json-pane" aria-label="Input">
          <div className="json-toolbar">
            <span className="json-toolbar-title">Input</span>
            <div className="json-toolbar-actions">
              <button className="json-button" onClick={() => void handlePaste()} title="Paste from clipboard">
                <ClipboardPaste size={12} />
                <span>Paste</span>
              </button>
              <button
                className="json-button"
                onClick={requestSave}
                disabled={!hasInput}
                title={activeItem ? `Update "${activeItem.title}"` : 'Save this JSON for later'}
              >
                <Save size={12} />
                <span>Save</span>
              </button>
              <button className="json-button" onClick={() => setHistoryOpen(true)} title="Saved JSON history">
                <History size={12} />
                <span>History</span>
              </button>
              <button className="json-button" onClick={() => {
                  setInput('');
                  setActiveSavedId(null);
                }}
                disabled={!input} title="Clear input">
                <Trash2 size={12} />
                <span>Clear</span>
              </button>
            </div>
          </div>
          <textarea
            className="json-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste raw JSON or a JavaScript object here…"
            spellCheck={false}
            autoFocus
            aria-label="Raw JSON input"
          />
        </section>

        <div
          className="json-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panes"
          aria-valuenow={Math.round(leftPct)}
          aria-valuemin={MIN_LEFT_PCT}
          aria-valuemax={MAX_LEFT_PCT}
          tabIndex={0}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && resizeTo(e.clientX)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setLeftPct((p) => Math.max(MIN_LEFT_PCT, p - KEY_STEP_PCT));
            if (e.key === 'ArrowRight') setLeftPct((p) => Math.min(MAX_LEFT_PCT, p + KEY_STEP_PCT));
          }}
        />

        {/* Output pane */}
        <section className="json-pane" aria-label="Output">
          <div className="json-toolbar">
            <div className="json-segmented" role="tablist" aria-label="View mode">
              {(['tree', 'code'] as const).map((mode) => (
                <button
                  key={mode}
                  role="tab"
                  aria-selected={view === mode}
                  className={`json-segment ${view === mode ? 'json-segment-active' : ''}`}
                  onClick={() => setView(mode)}
                >
                  {mode === 'tree' ? 'Tree' : 'Code'}
                </button>
              ))}
            </div>
            <div className="json-toolbar-actions">
              {result?.ok && view === 'tree' && !search && (
                <>
                  <button
                    className="json-button"
                    onClick={() => setExpansion(EXPAND_ALL_DEPTH)}
                    title="Expand all"
                    aria-label="Expand all"
                  >
                    <ChevronsUpDown size={12} />
                  </button>
                  <button
                    className="json-button"
                    onClick={() => setExpansion(DEFAULT_TREE_DEPTH)}
                    title="Collapse all"
                    aria-label="Collapse all"
                  >
                    <ChevronsDownUp size={12} />
                  </button>
                </>
              )}
              {result?.ok && view === 'code' && (
                <button className="json-button" onClick={() => void copy(formatted, 'code')} title="Copy formatted JSON">
                  {copiedKey === 'code' ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copiedKey === 'code' ? 'Copied' : 'Copy'}</span>
                </button>
              )}
            </div>
          </div>

          {result?.ok && (
            <div className="json-search">
              <Search size={12} className="json-search-icon" />
              <input
                ref={searchRef}
                className="json-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
                placeholder="Filter keys and values…  (⌘F)"
                aria-label="Filter keys and values"
                spellCheck={false}
              />
              {search && (
                <span className="json-search-count" aria-live="polite">
                  {search.matches.size === 0
                    ? 'No matches'
                    : `${search.matches.size} match${search.matches.size === 1 ? '' : 'es'}`}
                </span>
              )}
              {query !== '' && (
                <button className="json-button" onClick={() => setQuery('')} title="Clear filter" aria-label="Clear filter">
                  <X size={12} />
                </button>
              )}
            </div>
          )}

          <div className={`json-status ${result && !result.ok ? 'json-status-error' : ''}`}>{status}</div>

          <div className="json-output">
            {result?.ok === false && <ErrorDetails result={result} input={deferredInput} />}
            {result?.ok && search && search.matches.size === 0 && (
              <div className="devices-message">Nothing matches &quot;{query.trim()}&quot;.</div>
            )}
            {result?.ok && view === 'tree' && !(search && search.matches.size === 0) && (
              <JsonTree value={result.value} initialDepth={treeDepth} resetKey={treeResetKey} search={search} />
            )}
            {result?.ok && view === 'code' && !(search && search.matches.size === 0) && (
              <JsonCode value={result.value} text={formatted} search={search} />
            )}
          </div>
        </section>
      </div>
    </div>
    <SaveJsonDialog open={saveOpen} onOpenChange={setSaveOpen} onSave={(title) => {
        const id = saved.save(title, input);
        if (!id) return false;
        setActiveSavedId(id);
        setToast(`Saved "${title}"`);
        return true;
      }} />
    <JsonHistoryDialog
      open={historyOpen}
      onOpenChange={setHistoryOpen}
      items={saved.items}
      onLoad={(item) => {
        setInput(item.content);
        setActiveSavedId(item.id);
      }}
      onDelete={saved.remove}
    />
    {toast && (
      <div className="json-toast" role="status">
        {toast}
      </div>
    )}
    </ImagePreviewProvider>
  );
}
