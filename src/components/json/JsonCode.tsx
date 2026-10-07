import { useMemo } from 'react';
import { Check, Copy } from 'lucide-react';
import { useImagePreview } from '@/components/json/ImagePreview';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { buildCodeLines, copyText, imageUrlOf, type JsonCodeLine } from '@/lib/json';

/** Beyond this size, render plain wrapped text: per-line DOM would be too heavy. */
const MAX_LINE_RENDER_CHARS = 300_000;

/** Width of one indent level, matching JSON.stringify's two spaces. */
const INDENT_CH = 2;

interface JsonCodeProps {
  value: unknown;
  /** The same value formatted with JSON.stringify(value, null, 2). */
  text: string;
}

function ValueText({ line }: { line: JsonCodeLine }) {
  const preview = useImagePreview();
  const imageUrl = line.kind === 'string' ? imageUrlOf(JSON.parse(line.text) as string) : null;

  if (!imageUrl) return <span className={`json-${line.kind}`}>{line.text}</span>;

  return (
    <span
      className="json-string json-image-link"
      onMouseEnter={(e) => preview.show(imageUrl, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={preview.hide}
    >
      {line.text}
    </span>
  );
}

export function JsonCode({ value, text }: JsonCodeProps) {
  const { copiedKey, copy } = useCopyToClipboard();
  const lines = useMemo(
    () => (text.length > MAX_LINE_RENDER_CHARS ? null : buildCodeLines(value)),
    [value, text]
  );

  if (!lines) return <pre className="json-code json-code-plain">{text}</pre>;

  return (
    <div className="json-code">
      {lines.map((line) => (
        // Depth-based indent is dynamic, so it needs an inline style; wrapped text stays indented
        <div key={line.id} className="json-line" style={{ paddingLeft: `${line.depth * INDENT_CH}ch` }}>
          {line.key !== null && (
            <>
              <span className="json-key">{JSON.stringify(line.key)}</span>
              <span className="json-punct">: </span>
            </>
          )}
          <ValueText line={line} />
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
