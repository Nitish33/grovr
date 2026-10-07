import { useEffect, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Camera, Copy, FolderOpen, Play, RefreshCw, Trash2, Video, type LucideIcon } from 'lucide-react';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { useAppTheme } from '@/hooks/useAppTheme';
import { useQuickBarSettings } from '@/hooks/useQuickBarSettings';
import { useRecordings } from '@/hooks/useRecordings';
import * as api from '@/lib/api';
import type { QuickBarSettings, RecordingFile } from '@/lib/api';
import { formatSize } from '@/lib/format';

type Section = 'screenshot' | 'recording';

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'screenshot', label: 'Screenshot', icon: Camera },
  { id: 'recording', label: 'Recording', icon: Video },
];

const FPS_OPTIONS = [
  { value: 0, label: 'Original' },
  { value: 15, label: '15 fps' },
  { value: 24, label: '24 fps' },
  { value: 30, label: '30 fps' },
  { value: 60, label: '60 fps' },
];

const WIDTH_OPTIONS = [
  { value: 0, label: 'Original' },
  { value: 1080, label: '1080 px wide' },
  { value: 720, label: '720 px wide' },
  { value: 540, label: '540 px wide' },
];

const KEEP_OPTIONS = [
  { value: 1, label: '1 hour' },
  { value: 6, label: '6 hours' },
  { value: 24, label: '24 hours' },
  { value: 72, label: '3 days' },
  { value: 168, label: '7 days' },
  { value: 0, label: 'Never' },
];

const CRF_MIN = 18;
const CRF_MAX = 36;

function qualityLabel(crf: number): string {
  if (crf <= 22) return 'High quality';
  if (crf <= 28) return 'Balanced';
  return 'Small file';
}

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

function Switch({ checked, onChange, label }: SwitchProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`qb-switch ${checked ? 'qb-switch-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="qb-switch-knob" />
    </button>
  );
}

interface RowProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  disabled?: boolean;
}

function Row({ title, description, children, disabled }: RowProps) {
  return (
    <div className={`qb-row ${disabled ? 'qb-row-disabled' : ''}`}>
      <div className="qb-row-text">
        <div className="qb-row-title">{title}</div>
        {description && <div className="qb-row-description">{description}</div>}
      </div>
      <div className="qb-row-control">{children}</div>
    </div>
  );
}

interface SelectProps {
  value: number | string;
  options: { value: number | string; label: string }[];
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
}

function Select({ value, options, onChange, label, disabled }: SelectProps) {
  return (
    <select
      className="logs-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      disabled={disabled}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function ScreenshotSection({
  settings,
  update,
}: {
  settings: QuickBarSettings;
  update: (patch: Partial<QuickBarSettings>) => void;
}) {
  return (
    <div className="qb-section">
      <h2 className="qb-heading">Screenshot</h2>
      <div className="qb-card">
        <Row
          title="Also save to the Desktop"
          description="Screenshots are always copied to the clipboard. Turn this on to keep a PNG copy on your Desktop too."
        >
          <Switch
            checked={settings.screenshot_save_to_desktop}
            onChange={(checked) => update({ screenshot_save_to_desktop: checked })}
            label="Also save screenshots to the Desktop"
          />
        </Row>
      </div>
    </div>
  );
}

function RecordingRow({
  recording,
  onCopy,
  onDelete,
  copied,
}: {
  recording: RecordingFile;
  onCopy: (recording: RecordingFile) => void;
  onDelete: (recording: RecordingFile) => void;
  copied: boolean;
}) {
  const act = (action: () => Promise<void>) => action().catch((err) => console.error(err));
  return (
    <li className="qb-recording">
      <div className="qb-recording-main">
        <div className="qb-recording-name" title={recording.path}>
          {recording.name}
        </div>
        <div className="qb-recording-meta">
          {new Date(recording.modified_ms).toLocaleString()} · {formatSize(recording.size)}
          {recording.in_progress && <span className="qb-recording-live"> · recording…</span>}
        </div>
      </div>
      <div className="qb-recording-actions">
        <button
          className="json-button"
          onClick={() => act(() => api.openRecording(recording.path))}
          disabled={recording.in_progress}
          title="Play in the default video player"
          aria-label={`Play ${recording.name}`}
        >
          <Play size={12} />
        </button>
        <button
          className="json-button"
          onClick={() => onCopy(recording)}
          title="Copy the file path"
          aria-label={`Copy the path of ${recording.name}`}
        >
          <Copy size={12} />
          {copied && <span>Copied</span>}
        </button>
        <button
          className="json-button"
          onClick={() => act(() => api.revealRecording(recording.path))}
          title="Show in Finder"
          aria-label={`Show ${recording.name} in Finder`}
        >
          <FolderOpen size={12} />
        </button>
        <button
          className="json-button"
          onClick={() => onDelete(recording)}
          disabled={recording.in_progress}
          title="Delete"
          aria-label={`Delete ${recording.name}`}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </li>
  );
}

function RecordingSection({
  settings,
  update,
}: {
  settings: QuickBarSettings;
  update: (patch: Partial<QuickBarSettings>) => void;
}) {
  const { recordings, loading, error, refresh, remove, removeAll } = useRecordings();
  const [ffmpeg, setFfmpeg] = useState<string | null | undefined>(undefined);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const shrink = settings.shrink_recordings;
  const totalBytes = recordings.reduce((sum, r) => sum + r.size, 0);

  useEffect(() => {
    api
      .ffmpegLocation()
      .then(setFfmpeg)
      .catch(() => setFfmpeg(null));
  }, []);

  useEffect(() => {
    if (!copiedPath) return;
    const timer = setTimeout(() => setCopiedPath(null), 1200);
    return () => clearTimeout(timer);
  }, [copiedPath]);

  const copyPath = async (recording: RecordingFile) => {
    try {
      await writeText(recording.path);
      setCopiedPath(recording.path);
    } catch (err) {
      console.error('Failed to copy the path:', err);
    }
  };

  return (
    <div className="qb-section">
      <h2 className="qb-heading">Recording</h2>

      <div className="qb-card">
        <Row
          title="Shrink simulator recordings"
          description="After you stop, re-encode the video to a much smaller file. Emulator recordings are saved as recorded."
        >
          <Switch
            checked={shrink}
            onChange={(checked) => update({ shrink_recordings: checked })}
            label="Shrink simulator recordings"
          />
        </Row>
        {shrink && ffmpeg === null && (
          <div className="qb-notice" role="alert">
            ffmpeg wasn&apos;t found, so recordings won&apos;t be shrunk. Install it with{' '}
            <code>brew install ffmpeg</code>.
          </div>
        )}
        {shrink && ffmpeg && <div className="qb-hint">Using ffmpeg at {ffmpeg}</div>}

        <Row
          title="Quality"
          description={`${qualityLabel(settings.video_crf)} (CRF ${settings.video_crf}). Lower numbers look better but make bigger files.`}
          disabled={!shrink}
        >
          <div className="qb-slider">
            <span>Best</span>
            <input
              type="range"
              min={CRF_MIN}
              max={CRF_MAX}
              step={1}
              value={settings.video_crf}
              disabled={!shrink}
              onChange={(e) => update({ video_crf: Number(e.target.value) })}
              aria-label="Video quality (CRF)"
            />
            <span>Smallest</span>
          </div>
        </Row>
        <Row title="Frame rate" description="Fewer frames per second means a smaller file." disabled={!shrink}>
          <Select
            value={settings.video_fps}
            options={FPS_OPTIONS}
            onChange={(value) => update({ video_fps: Number(value) })}
            label="Frame rate"
            disabled={!shrink}
          />
        </Row>
        <Row title="Size" description="Scale the video down to at most this width (never up)." disabled={!shrink}>
          <Select
            value={settings.video_max_width}
            options={WIDTH_OPTIONS}
            onChange={(value) => update({ video_max_width: Number(value) })}
            label="Maximum width"
            disabled={!shrink}
          />
        </Row>
        <Row
          title="Format"
          description="H.264 plays everywhere. HEVC isn't supported by every app or browser."
          disabled={!shrink}
        >
          <Select
            value={settings.video_codec}
            options={[
              { value: 'h264', label: 'H.264' },
              { value: 'hevc', label: 'HEVC (H.265)' },
            ]}
            onChange={(value) => update({ video_codec: value === 'hevc' ? 'hevc' : 'h264' })}
            label="Video format"
            disabled={!shrink}
          />
        </Row>
        <Row
          title="Delete old recordings"
          description="Recordings older than this are removed when a new recording starts."
        >
          <Select
            value={settings.recording_keep_hours}
            options={KEEP_OPTIONS}
            onChange={(value) => update({ recording_keep_hours: Number(value) })}
            label="Keep recordings for"
          />
        </Row>
      </div>

      <div className="qb-list-header">
        <h3 className="qb-subheading">
          Saved recordings
          <span className="qb-count">
            {recordings.length} · {formatSize(totalBytes)}
          </span>
        </h3>
        <div className="qb-list-actions">
          <button className="json-button" onClick={() => void refresh()} title="Refresh the list">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
          <button
            className="json-button"
            onClick={() => setConfirmDeleteAll(true)}
            disabled={recordings.filter((r) => !r.in_progress).length === 0}
            title="Delete all saved recordings"
          >
            <Trash2 size={12} />
            <span>Delete all</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="qb-notice" role="alert">
          {error}
        </div>
      )}
      {!loading && recordings.length === 0 && <div className="devices-message">No saved recordings.</div>}
      <ul className="qb-recordings">
        {recordings.map((recording) => (
          <RecordingRow
            key={recording.path}
            recording={recording}
            onCopy={(r) => void copyPath(r)}
            onDelete={(r) => void remove(r.path)}
            copied={copiedPath === recording.path}
          />
        ))}
      </ul>

      <ConfirmModal
        open={confirmDeleteAll}
        onOpenChange={setConfirmDeleteAll}
        title="Delete all recordings?"
        description={`${recordings.filter((r) => !r.in_progress).length} recordings will be deleted. This can't be undone.`}
        confirmLabel="Delete all"
        variant="destructive"
        onConfirm={() => void removeAll()}
        onCancel={() => setConfirmDeleteAll(false)}
      />
    </div>
  );
}

/** Options for the quick bar's screenshot and recording actions, and the saved recordings. */
export function QuickBarSettingsWindow() {
  useAppTheme();
  const { settings, loaded, update } = useQuickBarSettings();
  const [section, setSection] = useState<Section>('recording');

  useEffect(() => {
    document.title = 'Quick bar settings';
  }, []);

  return (
    <div className="qb-layout">
      <nav className="qb-nav" aria-label="Settings sections">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`qb-nav-item ${section === id ? 'qb-nav-item-active' : ''}`}
            aria-current={section === id ? 'page' : undefined}
            onClick={() => setSection(id)}
          >
            <Icon size={14} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <main className="qb-content">
        {loaded && section === 'screenshot' && <ScreenshotSection settings={settings} update={update} />}
        {loaded && section === 'recording' && <RecordingSection settings={settings} update={update} />}
      </main>
    </div>
  );
}
