import { useMemo, useRef, useState } from 'react';
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
import { Check, Copy, GripVertical, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useQuickLinks } from '@/hooks/useQuickLinks';
import * as api from '@/lib/api';
import type { QuickLink } from '@/lib/api';

/** True when focus is moving to another element inside `container` (not leaving the form). */
function stayingInside(container: HTMLElement, next: EventTarget | null): boolean {
  return next instanceof Node && container.contains(next);
}

interface LinkFieldsProps {
  name: string;
  url: string;
  invalid: boolean;
  nameLabel: string;
  urlLabel: string;
  autoFocusName?: boolean;
  onNameChange: (value: string) => void;
  onUrlChange: (value: string) => void;
  /** Enter pressed in either field. */
  onSubmit: () => void;
  onEscape?: () => void;
  /** Focus left both fields. */
  onLeave: () => void;
  className: string;
}

/** Name + link inputs that commit on Enter, or when focus leaves the pair. */
function LinkFields(props: LinkFieldsProps) {
  const urlRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, isNameField: boolean) => {
    if (e.key === 'Escape') props.onEscape?.();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Name without a link yet: move on to the link field instead of submitting
    if (isNameField && props.url.trim() === '') urlRef.current?.focus();
    else props.onSubmit();
  };

  return (
    <div
      className={props.className}
      onBlur={(e) => !stayingInside(e.currentTarget, e.relatedTarget) && props.onLeave()}
    >
      <input
        className="link-name-input"
        value={props.name}
        onChange={(e) => props.onNameChange(e.target.value)}
        onKeyDown={(e) => handleKeyDown(e, true)}
        placeholder="Name"
        aria-label={props.nameLabel}
        maxLength={100}
        autoFocus={props.autoFocusName}
      />
      <input
        ref={urlRef}
        className={`link-url-input ${props.invalid ? 'link-input-invalid' : ''}`}
        value={props.url}
        onChange={(e) => props.onUrlChange(e.target.value)}
        onKeyDown={(e) => handleKeyDown(e, false)}
        placeholder="https://…"
        aria-label={props.urlLabel}
        aria-invalid={props.invalid}
        spellCheck={false}
      />
    </div>
  );
}

interface LinkRowProps {
  link: QuickLink;
  copied: boolean;
  onOpen: () => void;
  onCopy: () => void;
  onSave: (name: string, url: string) => boolean;
  onDelete: () => void;
  onTogglePin: () => void;
}

function LinkRow({ link, copied, onOpen, onCopy, onSave, onDelete, onTogglePin }: LinkRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: link.id });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [invalid, setInvalid] = useState(false);
  const finished = useRef(false);

  const startEditing = () => {
    finished.current = false;
    setName(link.name);
    setUrl(link.url);
    setInvalid(false);
    setEditing(true);
  };

  /**
   * Ends editing. An invalid link keeps the editor open when `keepOpenIfInvalid` (Enter),
   * and otherwise discards the edit (focus left the row) so the user is never trapped.
   */
  const finish = (save: boolean, keepOpenIfInvalid = false) => {
    if (finished.current) return; // Enter then blur must only act once
    if (save) {
      const unchanged = name.trim() === link.name && url.trim() === link.url;
      if (!unchanged && !onSave(name, url) && keepOpenIfInvalid) {
        setInvalid(true);
        return;
      }
    }
    finished.current = true;
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
        aria-label={`Reorder link: ${link.name}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </button>

      {editing ? (
        <LinkFields
          className="link-fields link-fields-edit"
          name={name}
          url={url}
          invalid={invalid}
          nameLabel="Edit link name"
          urlLabel="Edit link URL"
          autoFocusName
          onNameChange={setName}
          onUrlChange={(value) => {
            setUrl(value);
            setInvalid(false);
          }}
          onSubmit={() => finish(true, true)}
          onEscape={() => finish(false)}
          onLeave={() => finish(true)}
        />
      ) : (
        <button className="link-main" onClick={onOpen} title={`Open ${link.url}`} aria-label={`Open ${link.name}`}>
          <span className="link-name">{link.name}</span>
          <span className="link-url">{link.url}</span>
        </button>
      )}

      <div className="note-actions">
        <button
          className={`note-action ${link.pinned ? 'note-action-active' : ''}`}
          onClick={onTogglePin}
          title={link.pinned ? 'Unpin' : 'Pin to top'}
          aria-label={`${link.pinned ? 'Unpin' : 'Pin'} link: ${link.name}`}
          aria-pressed={link.pinned}
        >
          {link.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button className="note-action" onClick={onCopy} title="Copy link" aria-label={`Copy link: ${link.name}`}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button className="note-action" onClick={startEditing} title="Edit" aria-label={`Edit link: ${link.name}`}>
          <Pencil size={14} />
        </button>
        <button className="note-action" onClick={onDelete} title="Delete link" aria-label={`Delete link: ${link.name}`}>
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

export function QuickLinksTab() {
  const { links, loaded, addLink, updateLink, removeLink, togglePin, reorder } = useQuickLinks();
  const { copiedKey, copy } = useCopyToClipboard();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const { pinnedLinks, otherLinks } = useMemo(
    () => ({ pinnedLinks: links.filter((l) => l.pinned), otherLinks: links.filter((l) => !l.pinned) }),
    [links]
  );

  /** Adds the link if there is one. A name alone is kept as a draft, not an error. */
  const commitDraft = () => {
    if (url.trim() === '') return;
    if (addLink(name, url)) {
      setName('');
      setUrl('');
      setInvalid(false);
    } else {
      setInvalid(true);
    }
  };

  const handleOpen = async (link: QuickLink) => {
    setOpenError(null);
    try {
      await api.openLink(link.url);
    } catch (err) {
      setOpenError(typeof err === 'string' ? err : `Couldn't open ${link.url}`);
    }
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) reorder(String(active.id), String(over.id));
  };

  const renderRow = (link: QuickLink) => (
    <LinkRow
      key={link.id}
      link={link}
      copied={copiedKey === link.id}
      onOpen={() => void handleOpen(link)}
      onCopy={() => void copy(link.url, link.id)}
      onSave={(newName, newUrl) => updateLink(link.id, newName, newUrl)}
      onDelete={() => removeLink(link.id)}
      onTogglePin={() => togglePin(link.id)}
    />
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="note-add">
        <LinkFields
          className="link-fields"
          name={name}
          url={url}
          invalid={invalid}
          nameLabel="Link name"
          urlLabel="Link URL"
          autoFocusName
          onNameChange={setName}
          onUrlChange={(value) => {
            setUrl(value);
            setInvalid(false);
          }}
          onSubmit={commitDraft}
          onLeave={commitDraft}
        />
        {invalid && <div className="link-error">Enter a valid link, e.g. https://example.com</div>}
      </div>

      {/* Plain scroll container: Radix ScrollArea would widen to fit long links */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="pl-2 pr-3 pb-2">
          {openError && <div className="devices-message">{openError}</div>}
          {loaded && links.length === 0 && (
            <div className="devices-message">No links yet. Add a name and a link above to save it here.</div>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            {pinnedLinks.length > 0 && (
              <>
                <div className="devices-section-label">Pinned</div>
                <SortableContext items={pinnedLinks.map((l) => l.id)} strategy={verticalListSortingStrategy}>
                  {pinnedLinks.map(renderRow)}
                </SortableContext>
                {otherLinks.length > 0 && <div className="devices-section-label">Links</div>}
              </>
            )}
            <SortableContext items={otherLinks.map((l) => l.id)} strategy={verticalListSortingStrategy}>
              {otherLinks.map(renderRow)}
            </SortableContext>
          </DndContext>
        </div>
      </div>
    </div>
  );
}
