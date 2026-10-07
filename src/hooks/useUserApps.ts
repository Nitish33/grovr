import { useCallback, useEffect, useState } from 'react';
import * as api from '@/lib/api';

/** Apps the user installed on the device (no system apps), for filter suggestions. */
export function useUserApps(platform: api.DevicePlatform, deviceId: string) {
  const [apps, setApps] = useState<string[]>([]);

  const refresh = useCallback(() => {
    api
      .listUserApps(platform, deviceId)
      .then(setApps)
      .catch(() => undefined);
  }, [platform, deviceId]);

  useEffect(refresh, [refresh]);

  return { apps, refresh };
}
