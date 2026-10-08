import { useCallback, useEffect, useState } from 'react';
import * as api from '@/lib/api';
import type { CurrentRunningApp, DevicePlatform } from '@/lib/api';

export function useCurrentRunningApp(platform: DevicePlatform, deviceId?: string) {
  const [app, setApp] = useState<CurrentRunningApp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const current = await api.currentRunningApp(platform, deviceId);
      setApp(current);
      return current;
    } catch (err) {
      setApp(null);
      setError(String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [platform, deviceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { app, loading, error, refresh };
}
