import { useEffect, useMemo, useRef, useState } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check, Copy, GripVertical, Pin, PinOff, Trash2 } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useNotes } from '@/hooks/useNotes';
import type { Note } from '@/lib/api';
import type { IncomingNote } from '@/types';

/** Rough characters per line in the edit box, used to size it to the note. */
const CHARS_PER_ROW = 90;
const MAX_EDIT_ROWS = 8;

interface NoteRowProps {
  note: Note;
  copied: boolean;
  onCopy: () => void;
  onSave: (text: string) => void;
  onDelete: () => void;
  onTogglePin: () => void;
}

function NoteRow({ note, copied, onCopy, onSave, onDelete, onTogglePin }: NoteRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: note.id });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const finished = useRef(false);

  const startEditing = () => {
    finished.current = false;
    setDraft(note.text);
    setEditing(true);
  };

  const finish = (save: boolean) => {
    if (finished.current) return; // Enter then blur must only act once
    finished.current = true;
    if (save && draft.trim() !== '' && draft.trim() !== note.text) onSave(draft);
    setEditing(false);
  };

  return (
    <div
      ref={setNodeRef}
      className={`note-row ${isDragging ? 'note-row-dragging' : ''}`}
      // dnd-kit supplies the live drag offset; keep it vertical-only
      style={{ transform: CSS.Transform.toString(transform && { ...transform, x: 0 }), transition }}
    >
      <button
        ref={setActivatorNodeRef}
        className="note-grip"
        title="Drag to reorder"
        aria-label={`Reorder note: ${note.text}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </button>
      {editing ? (
        <textarea
          className="note-edit-input"
          value={draft}
          rows={Math.min(MAX_EDIT_ROWS, Math.max(draft.split('\n').length, Math.ceil(draft.length / CHARS_PER_ROW)))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter saves; Shift+Enter adds a line break
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              finish(true);
            }
            if (e.key === 'Escape') finish(false);
          }}
          onBlur={() => finish(true)}
          aria-label="Edit note"
          autoFocus
        />
      ) : (
        <button className="note-text" onClick={startEditing} title="Click to edit" aria-label={`Edit note: ${note.text}`}>
          <span className="note-text-content">{note.text}</span>
        </button>
      )}
      <div className="note-actions">
        <button
          className={`note-action ${note.pinned ? 'note-action-active' : ''}`}
          onClick={onTogglePin}
          title={note.pinned ? 'Unpin' : 'Pin to top'}
          aria-label={`${note.pinned ? 'Unpin' : 'Pin'} note: ${note.text}`}
          aria-pressed={note.pinned}
        >
          {note.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button className="note-action" onClick={onCopy} title="Copy" aria-label={`Copy note: ${note.text}`}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button className="note-action" onClick={onDelete} title="Delete note" aria-label={`Delete note: ${note.text}`}>
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

interface NotesTabProps {
  /** Clipboard text captured by ctrl+v, to be saved as a new note once. */
  incomingNote?: IncomingNote | null;
  onIncomingNoteHandled?: () => void;
}

export function NotesTab({ incomingNote = null, onIncomingNoteHandled }: NotesTabProps) {
  const { notes, loaded, addNote, updateNote, removeNote, togglePin, reorder } = useNotes();
  const { copiedKey, copy } = useCopyToClipboard();
  const [draft, setDraft] = useState('');
  const handledIncoming = useRef<number | null>(null);

  // Save a captured clipboard note, but only after the saved notes have loaded
  // (adding earlier would overwrite them), and only once per capture.
  useEffect(() => {
    if (!incomingNote || !loaded || handledIncoming.current === incomingNote.id) return;
    handledIncoming.current = incomingNote.id;
    addNote(incomingNote.text);
    onIncomingNoteHandled?.();
    // The tab autofocuses its input, which would turn the next cmd+v into a plain paste
    // there. Release focus so repeated cmd+v keeps capturing notes.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, [incomingNote, loaded, addNote, onIncomingNoteHandled]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const { pinnedNotes, otherNotes } = useMemo(
    () => ({ pinnedNotes: notes.filter((n) => n.pinned), otherNotes: notes.filter((n) => !n.pinned) }),
    [notes]
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) reorder(String(active.id), String(over.id));
  };

  const renderRow = (note: Note) => (
    <NoteRow
      key={note.id}
      note={note}
      copied={copiedKey === note.id}
      onCopy={() => void copy(note.text, note.id)}
      onSave={(text) => updateNote(note.id, text)}
      onDelete={() => removeNote(note.id)}
      onTogglePin={() => togglePin(note.id)}
    />
  );

  const commitDraft = () => {
    if (draft.trim() === '') return;
    addNote(draft);
    setDraft('');
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="note-add">
        <input
          className="note-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commitDraft()}
          onBlur={commitDraft}
          placeholder="Type a note, then press Enter…"
          aria-label="New note"
          spellCheck={false}
          autoFocus
        />
      </div>

      {/* Plain scroll container: Radix ScrollArea sizes its content to the widest
          unbroken string, which would push long notes and their buttons off-screen. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="pl-2 pr-3 pb-2">
          {loaded && notes.length === 0 && (
            <div className="devices-message">No notes yet. Type something above to save it here.</div>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            {pinnedNotes.length > 0 && (
              <>
                <div className="devices-section-label">Pinned</div>
                <SortableContext items={pinnedNotes.map((n) => n.id)} strategy={verticalListSortingStrategy}>
                  {pinnedNotes.map(renderRow)}
                </SortableContext>
                {otherNotes.length > 0 && <div className="devices-section-label">Notes</div>}
              </>
            )}
            <SortableContext items={otherNotes.map((n) => n.id)} strategy={verticalListSortingStrategy}>
              {otherNotes.map(renderRow)}
            </SortableContext>
          </DndContext>
        </div>
      </div>
    </div>
  );
}
