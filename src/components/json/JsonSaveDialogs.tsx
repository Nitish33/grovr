import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import type { SavedJson } from '@/hooks/useSavedJson';

interface SaveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (title: string) => boolean;
}

export function SaveJsonDialog({ open, onOpenChange, onSave }: SaveDialogProps) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setTitle('');
      setError('');
    }
    onOpenChange(next);
  };

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('Enter a title');
      return;
    }
    if (!onSave(trimmed)) {
      setError('Could not save - storage is full');
      return;
    }
    onOpenChange(false);
  };

  return (
    <Modal open={open} onOpenChange={handleOpenChange}>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>Save JSON</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <input
            className="link-name-input w-full"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setError('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Title"
            aria-label="Title"
            autoFocus
            spellCheck={false}
          />
          {error && <div className="link-error">{error}</div>}
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit}>
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

interface HistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: SavedJson[];
  onLoad: (item: SavedJson) => void;
  onDelete: (id: string) => void;
}

export function JsonHistoryDialog({ open, onOpenChange, items, onLoad, onDelete }: HistoryDialogProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>Saved JSON</ModalTitle>
        </ModalHeader>
        <ModalBody>
          {items.length === 0 ? (
            <div className="devices-message">Nothing saved yet.</div>
          ) : (
            <ul className="json-history-list">
              {items.map((item) => (
                <li key={item.id} className="json-history-item">
                  <button
                    className="json-history-main"
                    onClick={() => {
                      onLoad(item);
                      onOpenChange(false);
                    }}
                    title="Load into the input"
                  >
                    <span className="json-history-title">{item.title}</span>
                    <span className="json-history-date">{new Date(item.savedAt).toLocaleString()}</span>
                  </button>
                  <button
                    className="json-button"
                    onClick={() => onDelete(item.id)}
                    title="Delete"
                    aria-label={`Delete ${item.title}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
