import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  Check,
  Link,
  LoaderCircle,
  Power,
  ScrollText,
  Settings,
  Square,
  SunMoon,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useAppTheme } from '@/hooks/useAppTheme';
import * as api from '@/lib/api';
import { formatSize } from '@/lib/format';
import type { DevicePlatform } from '@/lib/api';

const FEEDBACK_MS = 1600;

interface DockAction {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => Promise<string | null>;
  /** The action reports its own progress (toasts, button state), so skip the generic feedback */
  selfReporting?: boolean;
}

type RecordingState = 'idle' | 'starting' | 'recording' | 'processing';

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
  const [recording, setRecording] = useState<RecordingState>('idle');

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

  // The bar may have been closed and reopened while a recording was running
  useEffect(() => {
    api
      .deviceRecordingStartedAt(platform, deviceId)
      .then((startedAt) => {
        if (startedAt === null) return;
        setRecording('recording');
        void api.showRecordingIndicator(startedAt);
      })
      .catch(() => undefined);
  }, [platform, deviceId]);

  const toast = (message: string, kind: api.ToastKind = 'ok', sticky = false) =>
    api.showDeviceToast(message, kind, sticky).catch((err) => console.error('Failed to show the toast:', err));

  const toggleRecording = async (): Promise<null> => {
    if (recording === 'starting' || recording === 'processing') return null;

    if (recording === 'idle') {
      // Show something right away: the recorder takes a moment to come up
      setRecording('starting');
      try {
        const startedAt = await api.startDeviceRecording(platform, deviceId);
        setRecording('recording');
        void api.showRecordingIndicator(startedAt);
        void toast('Recording started. Click again to stop');
      } catch (err) {
        setRecording('idle');
        void toast(String(err), 'error');
      }
      return null;
    }

    // Stopping flushes the video to disk (and copies it off the emulator), which takes a moment
    setRecording('processing');
    void api.hideRecordingIndicator();
    void toast('Processing video…', 'busy', true);
    try {
      const video = await api.stopDeviceRecording(platform, deviceId);
      await writeText(video.path);
      void toast(
        video.final_bytes < video.original_bytes
          ? `Video path copied (${formatSize(video.original_bytes)} → ${formatSize(video.final_bytes)})`
          : `Video path copied to the clipboard (${formatSize(video.final_bytes)})`
      );
    } catch (err) {
      void toast(String(err), 'error');
    } finally {
      setRecording('idle');
    }
    return null;
  };

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
      label: 'Copy a screenshot to the clipboard',
      icon: Camera,
      run: async () => {
        await api.deviceQuickAction(platform, deviceId, 'screenshot');
        return 'Screenshot copied to the clipboard';
      },
    },
    {
      id: 'record',
      label: recording === 'recording' ? 'Stop recording' : 'Record the screen',
      icon: Video,
      run: toggleRecording,
      selfReporting: true,
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
    {
      id: 'settings',
      label: 'Quick bar settings',
      icon: Settings,
      run: async () => {
        await api.openQuickBarSettings();
        return null;
      },
      selfReporting: true,
    },
  ];

  const handleClick = async (action: DockAction) => {
    if (action.selfReporting) {
      await action.run();
      return;
    }
    let result: { ok: boolean; message: string };
    let toast = true;
    try {
      const message = await action.run();
      // Some actions (opening the log window) have nothing worth announcing
      toast = message !== null;
      result = { ok: true, message: message ?? action.label };
    } catch (err) {
      result = { ok: false, message: String(err) };
    }
    if (toast) {
      api.showDeviceToast(result.message, result.ok ? 'ok' : 'error').catch((err) => console.error('Failed to show the toast:', err));
    }
    setFeedback({ id: action.id, ...result });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);
  };

  return (
    <div className="dock-bar" role="toolbar" aria-label={`Quick actions for ${name}`} aria-orientation="vertical">
      {actions.map((action) => {
        const active = feedback?.id === action.id;
        const isRecord = action.id === 'record';
        const recordBusy = isRecord && (recording === 'starting' || recording === 'processing');
        const Icon = active
          ? feedback.ok
            ? Check
            : AlertCircle
          : isRecord && recording === 'recording'
            ? Square
            : recordBusy
              ? LoaderCircle
              : action.icon;
        const stateClass = active
          ? feedback.ok
            ? 'dock-button-ok'
            : 'dock-button-error'
          : isRecord && recording === 'recording'
            ? 'dock-button-recording'
            : '';
        return (
          <button
            key={action.id}
            className={`dock-button ${stateClass} ${action.id === 'shutdown' ? 'dock-button-danger' : ''} ${
              action.id === 'settings' ? 'dock-button-settings' : ''
            }`}
            disabled={recordBusy}
            title={active ? feedback.message : action.label}
            aria-label={action.label}
            onClick={() => void handleClick(action)}
          >
            <Icon size={16} className={recordBusy ? 'animate-spin' : ''} />
          </button>
        );
      })}
    </div>
  );
}
