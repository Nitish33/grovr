import { useEffect, useMemo, useState } from 'react';
import { useAppTheme } from '@/hooks/useAppTheme';

const TICK_MS = 500;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** A red dot and a running timer shown over a device while it is being recorded (click-through). */
export function RecordingIndicatorWindow() {
  useAppTheme();
  const startedAt = useMemo(() => Number(new URLSearchParams(window.location.search).get('start')) || Date.now(), []);
  const [now, setNow] = useState(() => Date.now());

  // The window is transparent so only the pill is visible
  useEffect(() => {
    document.documentElement.classList.add('dock-root');
    return () => document.documentElement.classList.remove('dock-root');
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="device-toast-frame">
      <div className="recording-pill" role="timer" aria-label="Recording">
        <span className="recording-dot" />
        <span>REC</span>
        <span className="recording-time">{formatElapsed(now - startedAt)}</span>
      </div>
    </div>
  );
}
