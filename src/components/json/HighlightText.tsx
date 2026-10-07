/** Renders `text` with case-insensitive matches of `query` wrapped in <mark>. */
export function HighlightText({ text, query }: { text: string; query: string }) {
  if (query === '') return <>{text}</>;

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Splitting on a capture group puts the matches at the odd indices
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));

  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="json-match">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}
