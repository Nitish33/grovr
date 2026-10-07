import { useRef, useState } from 'react';
import { MAX_NOTE_LENGTH } from '@/hooks/useDevices';

interface DeviceNoteProps {
  note: string;
  deviceName: string;
  onSave: (note: string) => void;
}

/** A short click-to-edit note shown next to a device. Enter/blur saves, Escape cancels. */
export function DeviceNote({ note, deviceName, onSave }: DeviceNoteProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const finished = useRef(false);

  const startEditing = () => {
    finished.current = false;
    setDraft(note);
    setEditing(true);
  };

  const finish = (save: boolean) => {
    if (finished.current) return; // Enter then blur (or vice versa) must only act once
    finished.current = true;
    if (save && draft.trim() !== note) onSave(draft);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        className="device-note-input"
        value={draft}
        maxLength={MAX_NOTE_LENGTH}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(true);
          if (e.key === 'Escape') finish(false);
        }}
        onBlur={() => finish(true)}
        placeholder="Add a short note…"
        aria-label={`Note for ${deviceName}`}
        autoFocus
      />
    );
  }

  return (
    <button
      className={`device-note ${note ? '' : 'device-note-empty'}`}
      onClick={startEditing}
      title={note ? `${note} (click to edit)` : 'Add a note'}
      aria-label={note ? `Edit note for ${deviceName}: ${note}` : `Add note for ${deviceName}`}
    >
      {note || 'Add note'}
    </button>
  );
}
