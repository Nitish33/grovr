import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { HighlightText } from '@/components/json/HighlightText';
import { useImagePreview } from '@/components/json/ImagePreview';
import { childEntries, copyText, imageUrlOf, isContainer, type JsonSearch } from '@/lib/json';

/** Children rendered per container before a "show more" button is needed. */
const PAGE_SIZE = 200;

/** Expand/collapse command pushed down a subtree; a new nonce re-applies it. */
interface SubtreeCommand {
  open: boolean;
  nonce: number;
}

let commandNonce = 0;

interface CopyApi {
  copiedKey: string | null;
  copy: (text: string, key?: string) => Promise<void>;
}

interface JsonNodeProps {
  name: string | null;
  /** True when this node is an element of an array (its name is an index). */
  isParentArray?: boolean;
  value: unknown;
  path: string;
  depth: number;
  /** Containers shallower than this start expanded. */
  initialDepth: number;
  /** Inherited expand/collapse-all command from an ancestor. */
  forced?: SubtreeCommand | null;
  /** Active search: only visible nodes render, all expanded, matches highlighted. */
  search: JsonSearch | null;
  clipboard: CopyApi;
}

function StringValue({ value, query }: { value: string; query: string }) {
  const preview = useImagePreview();
  const imageUrl = imageUrlOf(value);

  if (!imageUrl) {
    return (
      <span className="json-string">
        &quot;<HighlightText text={value} query={query} />&quot;
      </span>
    );
  }

  return (
    <span
      className="json-string json-image-link"
      onMouseEnter={(e) => preview.show(imageUrl, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={preview.hide}
    >
      &quot;<HighlightText text={value} query={query} />&quot;
    </span>
  );
}

function PrimitiveValue({ value, query }: { value: unknown; query: string }) {
  if (typeof value === 'string') return <StringValue value={value} query={query} />;
  if (typeof value === 'number') {
    return <span className="json-number"><HighlightText text={String(value)} query={query} /></span>;
  }
  if (typeof value === 'boolean') {
    return <span className="json-boolean"><HighlightText text={String(value)} query={query} /></span>;
  }
  return <span className="json-null">null</span>;
}

function JsonNode({ name, isParentArray = false, value, path, depth, initialDepth, forced = null, search, clipboard }: JsonNodeProps) {
  const container = isContainer(value);
  const [open, setOpen] = useState(forced ? forced.open : depth < initialDepth);
  const [subtree, setSubtree] = useState<SubtreeCommand | null>(forced);
  const [visible, setVisible] = useState(PAGE_SIZE);

  // Apply a command from an ancestor (e.g. "expand all" on a parent)
  useEffect(() => {
    if (!forced) return;
    setOpen(forced.open);
    setSubtree(forced);
  }, [forced]);

  const applyToSubtree = (shouldOpen: boolean) => {
    setOpen(shouldOpen);
    setSubtree({ open: shouldOpen, nonce: ++commandNonce });
  };

  const entries = container ? childEntries(value) : [];
  const searching = search !== null;
  // While searching, show only the visible branches, fully expanded
  const shownEntries = searching ? entries.filter(([key]) => search.visible.has(`${path}.${key}`)) : entries;
  const isOpen = searching || open;
  const query = search?.query ?? '';
  const isArray = Array.isArray(value);
  const copied = clipboard.copiedKey === path;

  return (
    <div>
      <div className="json-row">
        {container ? (
          <button
            className="json-toggle"
            onClick={() => {
              setOpen(!open);
              setSubtree(null); // a manual toggle ends any earlier expand/collapse-all
            }}
            disabled={searching}
            aria-expanded={isOpen}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
          >
            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="json-toggle" />
        )}

        {name !== null && (
          <span>
            <span className={isParentArray ? 'json-index' : 'json-key'}>
              {isParentArray ? name : <HighlightText text={name} query={query} />}
            </span>
            <span className="json-punct">:</span>
          </span>
        )}

        {container ? (
          <span className="json-count">{isArray ? `[${entries.length}]` : `{${entries.length}}`}</span>
        ) : (
          <PrimitiveValue value={value} query={query} />
        )}

        <span className="json-actions">
          {container && !searching && (
            <>
              <button
                className="json-action"
                onClick={() => applyToSubtree(true)}
                title="Expand all inside"
                aria-label={`Expand all inside ${name ?? 'root'}`}
              >
                <ChevronsUpDown size={12} />
              </button>
              <button
                className="json-action"
                onClick={() => applyToSubtree(false)}
                title="Collapse all inside"
                aria-label={`Collapse all inside ${name ?? 'root'}`}
              >
                <ChevronsDownUp size={12} />
              </button>
            </>
          )}
          <button
            className="json-action"
            onClick={() => void clipboard.copy(copyText(value), path)}
            title="Copy"
            aria-label={name !== null ? `Copy ${name}` : 'Copy value'}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </span>
      </div>

      {container && isOpen && (
        <div className="json-children">
          {shownEntries.slice(0, visible).map(([key, child]) => (
            <JsonNode
              key={key}
              name={key}
              isParentArray={isArray}
              value={child}
              path={`${path}.${key}`}
              depth={depth + 1}
              initialDepth={initialDepth}
              forced={subtree}
              search={search}
              clipboard={clipboard}
            />
          ))}
          {shownEntries.length > visible && (
            <button className="json-more" onClick={() => setVisible(visible + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, shownEntries.length - visible)} more of {shownEntries.length - visible}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface JsonTreeProps {
  value: unknown;
  /** Containers shallower than this start expanded; change `resetKey` to re-apply. */
  initialDepth: number;
  resetKey: number;
  search: JsonSearch | null;
}

export function JsonTree({ value, initialDepth, resetKey, search }: JsonTreeProps) {
  const clipboard = useCopyToClipboard();

  return (
    <div className="json-tree">
      <JsonNode
        key={resetKey}
        name={null}
        value={value}
        path="$"
        depth={0}
        initialDepth={initialDepth}
        search={search}
        clipboard={clipboard}
      />
    </div>
  );
}
