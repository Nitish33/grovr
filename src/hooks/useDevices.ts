import { useCallback, useEffect, useState } from 'react';
import * as api from '@/lib/api';

const POLL_INTERVAL_MS = 4000;

export type DevicePlatform = 'ios' | 'android';

function errorMessage(err: unknown): string {
  return typeof err === 'string' ? err : err instanceof Error ? err.message : 'Unknown error';
}

/** Lists simulators/emulators for a platform and manages the shared pinned list. */
export function useDevices(platform: DevicePlatform) {
  const [devices, setDevices] = useState<api.Device[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const list = platform === 'ios' ? api.listIosSimulators : api.listAndroidEmulators;
    Promise.all([list(), api.getSettings()])
      .then(([deviceList, settings]) => {
        if (cancelled) return;
        setDevices(deviceList);
        setPinned(settings.pinned_devices ?? []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDevices([]);
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [platform, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  // Keep running/stopped state fresh (devices can be started or stopped outside Grovr)
  useEffect(() => {
    const list = platform === 'ios' ? api.listIosSimulators : api.listAndroidEmulators;
    let cancelled = false;
    let inFlight = false;

    const id = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      list()
        .then((deviceList) => {
          if (!cancelled) setDevices(deviceList);
        })
        .catch(() => {
          // Keep the last good list; the initial load surfaces errors
        })
        .finally(() => {
          inFlight = false;
        });
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [platform]);

  const togglePin = useCallback(
    async (deviceId: string) => {
      const key = `${platform}:${deviceId}`;
      const previous = pinned;
      const next = previous.includes(key)
        ? previous.filter((k) => k !== key)
        : [...previous, key];

      setPinned(next);
      try {
        await api.setPinnedDevices(next);
      } catch (err) {
        console.error('Failed to save pinned devices:', err);
        setPinned(previous);
      }
    },
    [platform, pinned]
  );

  const launch = useCallback(
    async (deviceId: string) => {
      setLaunchingId(deviceId);
      setLaunchError(null);
      try {
        if (platform === 'ios') {
          await api.launchIosSimulator(deviceId);
        } else {
          await api.launchAndroidEmulator(deviceId);
        }
        refresh(); // pick up the new "Booted" state; polling catches slow boots
      } catch (err) {
        setLaunchError(errorMessage(err));
      } finally {
        setLaunchingId(null);
      }
    },
    [platform, refresh]
  );

  return { devices, pinned, loading, error, refresh, togglePin, launch, launchingId, launchError };
}
