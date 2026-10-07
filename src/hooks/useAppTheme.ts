import { useEffect } from 'react';
import * as api from '@/lib/api';
import { applyTheme, type ThemeMode } from '@/lib/theme';

/** Follows the saved app theme (and the OS theme in "system" mode) in secondary windows. */
export function useAppTheme() {
  useEffect(() => {
    let theme: ThemeMode = 'system';
    const apply = () => applyTheme(theme);
    api
      .getSettings()
      .then((settings) => {
        theme = (settings.theme as ThemeMode) || 'system';
        apply();
      })
      .catch(apply);

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => theme === 'system' && apply();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
}
