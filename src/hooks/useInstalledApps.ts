import { useCallback, useEffect, useState } from 'react';
import * as api from '@/lib/api';
import type { Device, DevicePlatform, InstalledApp } from '@/lib/api';

function isRunning(device: Device) {
  const state = (device.state ?? '').toLowerCase();
  return state.includes('booted') || state.includes('running');
}

export function useInstalledApps(platform: DevicePlatform, preferredDeviceId?: string) {
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const devices = platform === 'ios' ? await api.listIosSimulators() : await api.listAndroidEmulators();
      const running = devices.filter(isRunning);
      const selected =
        running.find((item) => item.id === preferredDeviceId) ??
        running[0] ??
        null;
      setDevice(selected);
      if (!selected) {
        setApps([]);
        return [];
      }
      const next = await api.listInstalledApps(platform, selected.id);
      setApps(next);
      return next;
    } catch (err) {
      setApps([]);
      setDevice(null);
      setError(String(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, [platform, preferredDeviceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { apps, device, loading, error, refresh };
}
