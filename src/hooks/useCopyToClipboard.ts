import { useCallback, useEffect, useRef, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

const COPIED_RESET_MS = 1200;

/**
 * Copies text to the clipboard and tracks which item was just copied (by `key`)
 * so the UI can show brief "Copied" feedback.
 */
export function useCopyToClipboard() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const copy = useCallback(async (text: string, key: string = text) => {
    try {
      await writeText(text);
      setCopiedKey(key);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopiedKey(null), COPIED_RESET_MS);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, []);

  return { copiedKey, copy };
}
