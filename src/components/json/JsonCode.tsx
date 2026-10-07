import { useMemo } from 'react';
import { useImagePreview } from '@/components/json/ImagePreview';
import { imageUrlOf, tokenizeJson } from '@/lib/json';

/** Beyond this size, skip syntax highlighting to keep the window responsive. */
const MAX_HIGHLIGHT_CHARS = 300_000;

/** Image URL inside a quoted JSON string token, if it is one. */
function imageUrlFromToken(token: string): string | null {
  try {
    const parsed: unknown = JSON.parse(token);
    return typeof parsed === 'string' ? imageUrlOf(parsed) : null;
  } catch {
    return null;
  }
}

export function JsonCode({ text }: { text: string }) {
  const preview = useImagePreview();
  const tokens = useMemo(
    () => (text.length > MAX_HIGHLIGHT_CHARS ? null : tokenizeJson(text)),
    [text]
  );

  return (
    <pre className="json-code">
      {tokens
        ? tokens.map((token, i) =>
            token.kind === 'plain' ? (
              token.text
            ) : (
              <HighlightedToken key={i} kind={token.kind} text={token.text} preview={preview} />
            )
          )
        : text}
    </pre>
  );
}

function HighlightedToken({
  kind,
  text,
  preview,
}: {
  kind: string;
  text: string;
  preview: ReturnType<typeof useImagePreview>;
}) {
  const imageUrl = kind === 'string' ? imageUrlFromToken(text) : null;
  const className = kind === 'key' ? 'json-key' : `json-${kind}`;

  if (!imageUrl) return <span className={className}>{text}</span>;

  return (
    <span
      className={`${className} json-image-link`}
      onMouseEnter={(e) => preview.show(imageUrl, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={preview.hide}
    >
      {text}
    </span>
  );
}
