import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '@/lib/api';
import type { QuickBarSettings } from '@/lib/api';

export const DEFAULT_QUICK_BAR_SETTINGS: QuickBarSettings = {
  shrink_recordings: true,
  video_crf: 28,
  video_fps: 30,
  video_max_width: 0,
  video_codec: 'h264',
  recording_keep_hours: 24,
  recording_show_touches: false,
  recording_touch_color: 'green',
  screenshot_save_to_desktop: false,
};

/** The quick bar options, saved as soon as one changes. */
export function useQuickBarSettings() {
  const [settings, setSettings] = useState<QuickBarSettings>(DEFAULT_QUICK_BAR_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef(settings);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((all) => {
        if (cancelled) return;
        latest.current = { ...DEFAULT_QUICK_BAR_SETTINGS, ...all.quick_bar };
        setSettings(latest.current);
      })
      .catch((err) => console.error('Failed to load the quick bar settings:', err))
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((patch: Partial<QuickBarSettings>) => {
    latest.current = { ...latest.current, ...patch };
    setSettings(latest.current);
    api.setQuickBarSettings(latest.current).catch((err) => console.error('Failed to save the quick bar settings:', err));
  }, []);

  return { settings, loaded, update };
}
