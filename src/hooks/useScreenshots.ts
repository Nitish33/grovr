import { useCallback, useEffect, useState } from 'react';
import * as api from '@/lib/api';
import type { ScreenshotFile } from '@/lib/api';

/** Saved screenshots; refreshed when the settings window regains focus. */
export function useScreenshots() {
  const [screenshots, setScreenshots] = useState<ScreenshotFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .listScreenshots()
      .then((files) => {
        setScreenshots(files);
        setError(null);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const remove = useCallback(
    async (path: string) => {
      await api.deleteScreenshot(path);
      refresh();
    },
    [refresh],
  );

  const removeAll = useCallback(async () => {
    await api.deleteAllScreenshots();
    refresh();
  }, [refresh]);

  return { screenshots, loading, error, refresh, remove, removeAll };
}
