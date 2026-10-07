import * as api from '@/lib/api';
import { usePinnedList } from '@/hooks/usePinnedList';

const NOTES_OPTIONS = {
  read: (settings: api.BackendAppSettings) => settings.notes,
  save: api.setNotes,
  label: 'notes',
};

/** Quick-copy notes persisted in settings, with pinning and manual ordering. */
export function useNotes() {
  const { items, loaded, add, patch, remove, togglePin, reorder } = usePinnedList<api.Note>(
    api.getSettings,
    NOTES_OPTIONS
  );

  const addNote = (text: string) => {
    const trimmed = text.trim();
    if (trimmed !== '') add({ id: crypto.randomUUID(), text: trimmed, pinned: false });
  };

  const updateNote = (id: string, text: string) => {
    const trimmed = text.trim();
    if (trimmed !== '') patch(id, { text: trimmed });
  };

  return { notes: items, loaded, addNote, updateNote, removeNote: remove, togglePin, reorder };
}
