import { useCallback, useEffect, useState } from 'react';
import * as api from '@/lib/api';
import type { RecordingFile } from '@/lib/api';

/** The saved recordings; refreshed when the window regains focus (recordings finish elsewhere). */
export function useRecordings() {
  const [recordings, setRecordings] = useState<RecordingFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setRecordings(await api.listRecordings());
      setError('');
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  /** Runs a file action, then refreshes; failures show in `error`. */
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        setError('');
      } catch (err) {
        setError(String(err));
      }
      await refresh();
    },
    [refresh]
  );

  const remove = useCallback((path: string) => run(() => api.deleteRecording(path)), [run]);
  const removeAll = useCallback(() => run(() => api.deleteAllRecordings()), [run]);

  return { recordings, loading, error, refresh, remove, removeAll };
}
