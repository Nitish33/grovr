import { Check } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { generateLorem } from '@/lib/lorem';

const LENGTHS = [100, 250, 500];

export function LoremIpsum() {
  const { copiedKey, copy } = useCopyToClipboard();

  return (
    <div className="tool-row">
      <span className="tool-label">Lorem ipsum</span>
      {LENGTHS.map((length) => {
        const key = String(length);
        return (
          <button
            key={length}
            className="tool-chip"
            onClick={() => void copy(generateLorem(length), key)}
            title={`Copy ${length} characters of lorem ipsum`}
            aria-label={`Copy ${length} characters of lorem ipsum`}
          >
            {copiedKey === key ? <Check size={12} /> : null}
            <span>{copiedKey === key ? 'Copied' : `${length} chars`}</span>
          </button>
        );
      })}
    </div>
  );
}
