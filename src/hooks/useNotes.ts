import { useCallback, useEffect, useRef, useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import * as api from '@/lib/api';

/** The list is always [pinned..., unpinned...]; order within each group is the user's. */
function normalize(notes: api.Note[]): api.Note[] {
  const clean = notes.map((n) => ({ ...n, pinned: n.pinned === true }));
  return [...clean.filter((n) => n.pinned), ...clean.filter((n) => !n.pinned)];
}

/** Quick-copy notes persisted in settings, with pinning and manual ordering. */
export function useNotes() {
  const [notes, setNotes] = useState<api.Note[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Latest list, so rapid edits build on each other and a failed save can roll back
  const notesRef = useRef<api.Note[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        notesRef.current = normalize(settings.notes ?? []);
        setNotes(notesRef.current);
      })
      .catch((err: unknown) => console.error('Failed to load notes:', err))
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = useCallback(async (next: api.Note[]) => {
    const previous = notesRef.current;
    notesRef.current = next;
    setNotes(next);
    try {
      await api.setNotes(next);
    } catch (err) {
      console.error('Failed to save notes:', err);
      notesRef.current = previous;
      setNotes(previous);
    }
  }, []);

  /** New notes go to the top of the unpinned group, just below the pinned ones. */
  const addNote = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '') return;
      const current = notesRef.current;
      const pinnedCount = current.filter((n) => n.pinned).length;
      const note: api.Note = { id: crypto.randomUUID(), text: trimmed, pinned: false };
      void commit([...current.slice(0, pinnedCount), note, ...current.slice(pinnedCount)]);
    },
    [commit]
  );

  const updateNote = useCallback(
    (id: string, text: string) => {
      const trimmed = text.trim();
      if (trimmed === '') return;
      void commit(notesRef.current.map((n) => (n.id === id ? { ...n, text: trimmed } : n)));
    },
    [commit]
  );

  const removeNote = useCallback(
    (id: string) => void commit(notesRef.current.filter((n) => n.id !== id)),
    [commit]
  );

  /** Pinning puts a note at the top of the pinned group; unpinning at the top of the rest. */
  const togglePin = useCallback(
    (id: string) => {
      const current = notesRef.current;
      const target = current.find((n) => n.id === id);
      if (!target) return;

      const rest = current.filter((n) => n.id !== id);
      const pinnedRest = rest.filter((n) => n.pinned);
      const unpinnedRest = rest.filter((n) => !n.pinned);
      const updated = { ...target, pinned: !target.pinned };

      void commit(
        updated.pinned
          ? [updated, ...pinnedRest, ...unpinnedRest]
          : [...pinnedRest, updated, ...unpinnedRest]
      );
    },
    [commit]
  );

  /** Moves a note onto another note's position. Only within the same (pinned/unpinned) group. */
  const reorder = useCallback(
    (activeId: string, overId: string) => {
      const current = notesRef.current;
      const from = current.findIndex((n) => n.id === activeId);
      const to = current.findIndex((n) => n.id === overId);
      if (from < 0 || to < 0 || from === to) return;
      if (current[from].pinned !== current[to].pinned) return;
      void commit(arrayMove(current, from, to));
    },
    [commit]
  );

  return { notes, loaded, addNote, updateNote, removeNote, togglePin, reorder };
}
