import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Camera, Check, Link, Power, ScrollText, SunMoon, type LucideIcon } from 'lucide-react';
import { useAppTheme } from '@/hooks/useAppTheme';
import * as api from '@/lib/api';
import type { DevicePlatform } from '@/lib/api';

const FEEDBACK_MS = 1600;

interface DockAction {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => Promise<string | null>;
}

function readParams() {
  const params = new URLSearchParams(window.location.search);
  const platform: DevicePlatform = params.get('platform') === 'android' ? 'android' : 'ios';
  return { platform, deviceId: params.get('id') ?? '', name: params.get('name') ?? '' };
}

/** The quick actions bar shown beside a simulator/emulator window (positioned by the backend). */
export function DockWindow() {
  useAppTheme();
  const { platform, deviceId, name } = useMemo(readParams, []);
  const [feedback, setFeedback] = useState<{ id: string; ok: boolean; message: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The window is transparent so the bar can have rounded corners
  useEffect(() => {
    document.documentElement.classList.add('dock-root');
    return () => document.documentElement.classList.remove('dock-root');
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const actions: DockAction[] = [
    {
      id: 'logs',
      label: 'Stream logs',
      icon: ScrollText,
      run: async () => {
        await api.openLogWindow(platform, deviceId, name);
        return null;
      },
    },
    {
      id: 'screenshot',
      label: 'Screenshot to Desktop',
      icon: Camera,
      run: async () => {
        const path = await api.deviceQuickAction(platform, deviceId, 'screenshot');
        return path ? `Saved ${path.split('/').pop()} to Desktop` : null;
      },
    },
    {
      id: 'appearance',
      label: 'Toggle dark mode',
      icon: SunMoon,
      run: async () => {
        const mode = await api.deviceQuickAction(platform, deviceId, 'toggle_appearance');
        return mode ? `Switched to ${mode} mode` : null;
      },
    },
    {
      id: 'open-url',
      label: 'Open the link on the clipboard',
      icon: Link,
      run: async () => {
        const url = (await api.readClipboardText()).trim();
        await api.deviceQuickAction(platform, deviceId, 'open_url', url);
        return 'Opened the link';
      },
    },
    {
      id: 'shutdown',
      label: platform === 'ios' ? 'Shut down simulator' : 'Shut down emulator',
      icon: Power,
      run: async () => {
        await api.deviceQuickAction(platform, deviceId, 'shutdown');
        return null;
      },
    },
  ];

  const handleClick = async (action: DockAction) => {
    let result: { ok: boolean; message: string };
    try {
      result = { ok: true, message: (await action.run()) ?? action.label };
    } catch (err) {
      result = { ok: false, message: String(err) };
    }
    setFeedback({ id: action.id, ...result });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);
  };

  return (
    <div className="dock-bar" role="toolbar" aria-label={`Quick actions for ${name}`} aria-orientation="vertical">
      {actions.map((action) => {
        const active = feedback?.id === action.id;
        const Icon = active ? (feedback.ok ? Check : AlertCircle) : action.icon;
        return (
          <button
            key={action.id}
            className={`dock-button ${active ? (feedback.ok ? 'dock-button-ok' : 'dock-button-error') : ''} ${
              action.id === 'shutdown' ? 'dock-button-danger' : ''
            }`}
            title={active ? feedback.message : action.label}
            aria-label={action.label}
            onClick={() => void handleClick(action)}
          >
            <Icon size={16} />
          </button>
        );
      })}
    </div>
  );
}
