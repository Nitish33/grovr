import { useCallback, useState } from 'react';

export interface SavedJson {
  id: string;
  title: string;
  content: string;
  savedAt: number;
}

const STORAGE_KEY = 'grovr.jsonViewer.saved';

function load(): SavedJson[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as SavedJson[]) : [];
  } catch {
    return [];
  }
}

/** JSON snippets saved for later lookup, newest first. Persisted in localStorage. */
export function useSavedJson() {
  const [items, setItems] = useState<SavedJson[]>(load);

  /** Returns false when storage rejects the write (e.g. quota exceeded), so the caller can warn. */
  const persist = (next: SavedJson[]): boolean => {
    setItems(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  };

  /** Saves a new item and returns its id, or null when storage rejects the write. */
  const save = useCallback(
    (title: string, content: string): string | null => {
      const id = crypto.randomUUID();
      return persist([{ id, title, content, savedAt: Date.now() }, ...items]) ? id : null;
    },
    [items]
  );

  /** Overwrites an existing item's content. Returns false when it no longer exists or storage fails. */
  const update = useCallback(
    (id: string, content: string): boolean =>
      items.some((item) => item.id === id) &&
      persist(items.map((item) => (item.id === id ? { ...item, content, savedAt: Date.now() } : item))),
    [items]
  );

  const remove = useCallback(
    (id: string) => {
      persist(items.filter((item) => item.id !== id));
    },
    [items]
  );

  return { items, save, update, remove };
}
