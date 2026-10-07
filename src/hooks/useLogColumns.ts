import { useCallback, useState } from 'react';
import { columnsFor, type LogColumn } from '@/lib/logs';

type Platform = 'ios' | 'android';

const storageKey = (platform: Platform) => `grovr.logs.columns.${platform}`;

function load(platform: Platform): Set<LogColumn> {
  const all = columnsFor(platform).map((column) => column.id);
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(platform)) ?? 'null');
    if (Array.isArray(parsed)) return new Set(all.filter((id) => parsed.includes(id)));
  } catch {
    // Fall through to the default
  }
  return new Set(all);
}

/** Which log columns are shown, remembered per platform across windows and restarts. */
export function useLogColumns(platform: Platform) {
  const [visible, setVisible] = useState(() => load(platform));

  const toggle = useCallback(
    (id: LogColumn) => {
      setVisible((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        try {
          localStorage.setItem(storageKey(platform), JSON.stringify([...next]));
        } catch {
          // Not persisted; the choice still applies for this window
        }
        return next;
      });
    },
    [platform]
  );

  return { visible, toggle };
}
