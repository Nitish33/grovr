import { useEffect, useRef, useState } from 'react';
import { Columns3 } from 'lucide-react';
import { columnsFor, type LogColumn } from '@/lib/logs';

interface LogColumnsMenuProps {
  platform: 'ios' | 'android';
  visible: ReadonlySet<LogColumn>;
  onToggle: (id: LogColumn) => void;
}

export function LogColumnsMenu({ platform, visible, onToggle }: LogColumnsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="logs-columns">
      <button
        className="json-button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose which columns to show"
      >
        <Columns3 size={12} />
        <span>Columns</span>
      </button>
      {open && (
        <div className="logs-columns-menu" role="menu">
          {columnsFor(platform).map((column) => (
            <label key={column.id} className="logs-columns-item" role="menuitemcheckbox" aria-checked={visible.has(column.id)}>
              <input type="checkbox" checked={visible.has(column.id)} onChange={() => onToggle(column.id)} />
              <span>{column.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
