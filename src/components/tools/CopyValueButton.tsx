import { Check, Copy } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';

interface CopyValueButtonProps {
  /** Value to display and copy. Null shows the placeholder and disables the button. */
  value: string | null;
  placeholder: string;
  emptyHint: string;
}

export function CopyValueButton({ value, placeholder, emptyHint }: CopyValueButtonProps) {
  const { copiedKey, copy } = useCopyToClipboard();
  // Keyed by value, so changing the value naturally clears the "copied" state
  const copied = value !== null && copiedKey === value;

  return (
    <button
      className="tool-result"
      onClick={() => value && void copy(value)}
      disabled={!value}
      title={value ? 'Click to copy' : emptyHint}
      aria-label={value ? `Copy ${value}` : placeholder}
    >
      <span className="tool-result-value">{value ?? placeholder}</span>
      {value && (copied ? <Check size={12} /> : <Copy size={12} />)}
    </button>
  );
}
