import { useEffect, useMemo } from 'react';
import { AlertCircle, Check, LoaderCircle } from 'lucide-react';
import { useAppTheme } from '@/hooks/useAppTheme';

/** A short message shown over a simulator/emulator window; the window itself is click-through. */
export function ToastWindow() {
  useAppTheme();
  const { message, kind } = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return { message: params.get('message') ?? '', kind: params.get('kind') ?? 'ok' };
  }, []);

  // The window is transparent so only the pill is visible
  useEffect(() => {
    document.documentElement.classList.add('dock-root');
    return () => document.documentElement.classList.remove('dock-root');
  }, []);

  const Icon = kind === 'busy' ? LoaderCircle : kind === 'error' ? AlertCircle : Check;
  return (
    <div className="device-toast-frame">
      <div className={`device-toast ${kind === 'error' ? 'device-toast-error' : ''}`} role="status">
        <Icon size={14} className={`flex-shrink-0 ${kind === 'busy' ? 'animate-spin' : ''}`} />
        <span className="truncate">{message}</span>
      </div>
    </div>
  );
}
