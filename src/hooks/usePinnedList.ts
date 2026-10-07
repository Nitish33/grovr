import { useCallback, useEffect, useRef, useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import type { BackendAppSettings } from '@/lib/api';

export interface PinnableItem {
  id: string;
  pinned: boolean;
}

interface PinnedListOptions<T extends PinnableItem> {
  /** Picks this list out of the loaded settings. */
  read: (settings: BackendAppSettings) => T[] | undefined;
  /** Persists the full list. */
  save: (items: T[]) => Promise<void>;
  /** For error messages, e.g. "notes". */
  label: string;
}

/** The list is always [pinned..., unpinned...]; order within each group is the user's. */
function normalize<T extends PinnableItem>(items: T[]): T[] {
  const clean = items.map((item) => ({ ...item, pinned: item.pinned === true }));
  return [...clean.filter((i) => i.pinned), ...clean.filter((i) => !i.pinned)];
}

/**
 * A persisted list with pinning and manual ordering. Changes apply immediately
 * and roll back if saving fails. `options` should be a stable (module-level) object.
 */
export function usePinnedList<T extends PinnableItem>(
  getSettings: () => Promise<BackendAppSettings>,
  options: PinnedListOptions<T>
) {
  const [items, setItems] = useState<T[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Latest list, so rapid edits build on each other and a failed save can roll back
  const itemsRef = useRef<T[]>([]);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (cancelled) return;
        itemsRef.current = normalize(options.read(settings) ?? []);
        setItems(itemsRef.current);
      })
      .catch((err: unknown) => console.error(`Failed to load ${options.label}:`, err))
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [getSettings, options]);

  const commit = useCallback(
    async (next: T[]) => {
      const previous = itemsRef.current;
      itemsRef.current = next;
      setItems(next);
      try {
        await options.save(next);
      } catch (err) {
        console.error(`Failed to save ${options.label}:`, err);
        itemsRef.current = previous;
        setItems(previous);
      }
    },
    [options]
  );

  /** New items go to the top of the unpinned group, just below the pinned ones. */
  const add = useCallback(
    (item: T) => {
      const current = itemsRef.current;
      const pinnedCount = current.filter((i) => i.pinned).length;
      void commit([...current.slice(0, pinnedCount), { ...item, pinned: false }, ...current.slice(pinnedCount)]);
    },
    [commit]
  );

  const patch = useCallback(
    (id: string, changes: Partial<T>) =>
      void commit(itemsRef.current.map((i) => (i.id === id ? { ...i, ...changes } : i))),
    [commit]
  );

  const remove = useCallback(
    (id: string) => void commit(itemsRef.current.filter((i) => i.id !== id)),
    [commit]
  );

  /** Pinning puts an item at the top of the pinned group; unpinning at the top of the rest. */
  const togglePin = useCallback(
    (id: string) => {
      const current = itemsRef.current;
      const target = current.find((i) => i.id === id);
      if (!target) return;

      const rest = current.filter((i) => i.id !== id);
      const pinnedRest = rest.filter((i) => i.pinned);
      const unpinnedRest = rest.filter((i) => !i.pinned);
      const updated = { ...target, pinned: !target.pinned };

      void commit(
        updated.pinned
          ? [updated, ...pinnedRest, ...unpinnedRest]
          : [...pinnedRest, updated, ...unpinnedRest]
      );
    },
    [commit]
  );

  /** Moves an item onto another item's position. Only within the same (pinned/unpinned) group. */
  const reorder = useCallback(
    (activeId: string, overId: string) => {
      const current = itemsRef.current;
      const from = current.findIndex((i) => i.id === activeId);
      const to = current.findIndex((i) => i.id === overId);
      if (from < 0 || to < 0 || from === to) return;
      if (current[from].pinned !== current[to].pinned) return;
      void commit(arrayMove(current, from, to));
    },
    [commit]
  );

  return { items, loaded, add, patch, remove, togglePin, reorder };
}
