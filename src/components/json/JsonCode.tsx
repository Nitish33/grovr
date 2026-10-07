import { useMemo } from 'react';
import { Check, Copy } from 'lucide-react';
import { HighlightText } from '@/components/json/HighlightText';
import { useImagePreview } from '@/components/json/ImagePreview';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { buildCodeLines, copyText, imageUrlOf, type JsonCodeLine, type JsonSearch } from '@/lib/json';

/** Beyond this size, render plain wrapped text: per-line DOM would be too heavy. */
const MAX_LINE_RENDER_CHARS = 300_000;

/** Width of one indent level, matching JSON.stringify's two spaces. */
const INDENT_CH = 2;

interface JsonCodeProps {
  value: unknown;
  /** The same value formatted with JSON.stringify(value, null, 2). */
  text: string;
  /** Active search: only matching lines (and their structure) render, with matches highlighted. */
  search: JsonSearch | null;
}

function ValueText({ line, query }: { line: JsonCodeLine; query: string }) {
  const preview = useImagePreview();
  const imageUrl = line.kind === 'string' ? imageUrlOf(JSON.parse(line.text) as string) : null;

  if (!imageUrl) {
    return (
      <span className={`json-${line.kind}`}>
        {line.kind === 'punct' ? line.text : <HighlightText text={line.text} query={query} />}
      </span>
    );
  }

  return (
    <span
      className="json-string json-image-link"
      onMouseEnter={(e) => preview.show(imageUrl, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={preview.hide}
    >
      <HighlightText text={line.text} query={query} />
    </span>
  );
}

export function JsonCode({ value, text, search }: JsonCodeProps) {
  const { copiedKey, copy } = useCopyToClipboard();
  const lines = useMemo(
    () => (text.length > MAX_LINE_RENDER_CHARS ? null : buildCodeLines(value)),
    [value, text]
  );

  if (!lines) return <pre className="json-code json-code-plain">{text}</pre>;

  // While searching, keep matching lines, the lines leading to them, and closing brackets of kept containers
  const shownLines = search
    ? lines.filter((line) =>
        search.visible.has(line.id.endsWith('#end') ? line.id.slice(0, -'#end'.length) : line.id)
      )
    : lines;
  const query = search?.query ?? '';

  return (
    <div className="json-code">
      {shownLines.map((line) => (
        // Depth-based indent is dynamic, so it needs an inline style; wrapped text stays indented
        <div key={line.id} className="json-line" style={{ paddingLeft: `${line.depth * INDENT_CH}ch` }}>
          {line.key !== null && (
            <>
              <span className="json-key">
                <HighlightText text={JSON.stringify(line.key)} query={query} />
              </span>
              <span className="json-punct">: </span>
            </>
          )}
          <ValueText line={line} query={query} />
          {line.comma && <span className="json-punct">,</span>}
          {line.hasCopy && (
            <button
              className="json-action json-line-copy"
              onClick={() => void copy(copyText(line.copyValue), line.id)}
              title="Copy"
              aria-label={line.key !== null ? `Copy ${line.key}` : 'Copy value'}
            >
              {copiedKey === line.id ? <Check size={12} /> : <Copy size={12} />}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
