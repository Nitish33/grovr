import { useEffect, useState } from 'react';

const SAVE_DEBOUNCE_MS = 400;

function load(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/**
 * String state that survives closing the window/app. Writes are debounced, and
 * storage failures (e.g. quota exceeded for very large input) are ignored.
 */
export function usePersistedString(key: string) {
  const [value, setValue] = useState(() => load(key));

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (value === '') localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // Not persisted; the in-memory value still works
      }
    }, SAVE_DEBOUNCE_MS);

    // Flush on close/unmount so a quick close doesn't lose the last edit
    return () => clearTimeout(timer);
  }, [key, value]);

  useEffect(() => {
    const flush = () => {
      try {
        if (value === '') localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // ignore
      }
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [key, value]);

  return [value, setValue] as const;
}
