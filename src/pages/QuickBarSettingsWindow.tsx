import { useEffect, useMemo, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import {
  Camera,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  Link,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { useAppTheme } from '@/hooks/useAppTheme';
import { useCurrentRunningApp } from '@/hooks/useCurrentRunningApp';
import { useInstalledApps } from '@/hooks/useInstalledApps';
import { useQuickBarSettings } from '@/hooks/useQuickBarSettings';
import { useRecordings } from '@/hooks/useRecordings';
import * as api from '@/lib/api';
import type { AppPermission, DeepLink, DevicePlatform, InstalledApp, QuickBarSettings, RecordingFile } from '@/lib/api';
import { formatSize } from '@/lib/format';

type Section = 'screenshot' | 'recording' | 'deeplinks' | 'permissions';

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'screenshot', label: 'Screenshot', icon: Camera },
  { id: 'recording', label: 'Recording', icon: Video },
  { id: 'deeplinks', label: 'Deep links', icon: Link },
  { id: 'permissions', label: 'Permissions', icon: Shield },
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
const PLATFORM_OPTIONS: { value: DevicePlatform; label: string }[] = [
  { value: 'ios', label: 'Simulator' },
  { value: 'android', label: 'Emulator' },
];

function readSettingsContext() {
  const params = new URLSearchParams(window.location.search);
  return {
    platform: params.get('platform') === 'android' ? 'android' as DevicePlatform : 'ios' as DevicePlatform,
    deviceId: params.get('id') ?? undefined,
  };
}

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

function normalizeDeepLinks(links: DeepLink[] = []): DeepLink[] {
  return links.map((link) => ({ ...link, platform: link.platform ?? 'ios' }));
}

function DeepLinksSection() {
  const [links, setLinks] = useState<DeepLink[]>([]);
  const [platform, setPlatform] = useState<DevicePlatform>('ios');
  const [apps, setApps] = useState<string[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ package: '', name: '', url: '' });
  const [editing, setEditing] = useState<DeepLink | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const visibleLinks = links.filter((link) => link.platform === platform);
  const packageOptions = useMemo(
    () => [
      ...new Set([
        ...apps,
        ...links.filter((link) => link.platform === platform).map((link) => link.package),
      ]),
    ].filter(Boolean),
    [apps, links, platform],
  );
  const groupedLinks = visibleLinks.reduce<Record<string, DeepLink[]>>((groups, link) => {
    const key = link.package || 'App';
    groups[key] = [...(groups[key] ?? []), link];
    return groups;
  }, {});

  useEffect(() => {
    api
      .getSettings()
      .then((settings) => setLinks(normalizeDeepLinks(settings.deep_links ?? [])))
      .catch((err) => {
        console.error('Failed to load deep links:', err);
        setError('Could not load saved deep links.');
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAppsLoading(true);
    setAppsError(null);
    setApps([]);

    const loadApps = async () => {
      const devices = platform === 'ios' ? await api.listIosSimulators() : await api.listAndroidEmulators();
      const runningDevices = devices.filter((device) => {
        const state = (device.state ?? '').toLowerCase();
        return state.includes('booted') || state.includes('running');
      });
      const lists = await Promise.all(
        runningDevices.map((device) => api.listUserApps(platform, device.id).catch(() => [] as string[])),
      );
      const nextApps = [...new Set(lists.flat().filter(Boolean))].sort((a, b) => a.localeCompare(b));
      if (!cancelled) setApps(nextApps);
    };

    loadApps()
      .catch((err) => {
        console.error('Failed to load apps for deep links:', err);
        if (!cancelled) setAppsError('Could not load apps from running devices.');
      })
      .finally(() => {
        if (!cancelled) setAppsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [platform]);

  useEffect(() => {
    setDraft((current) => {
      if (current.package && packageOptions.includes(current.package)) return current;
      return { ...current, package: packageOptions[0] ?? '' };
    });
  }, [packageOptions]);

  const saveLinks = async (next: DeepLink[]) => {
    setLinks(next);
    setError(null);
    try {
      await api.setDeepLinks(next);
    } catch (err) {
      console.error('Failed to save deep links:', err);
      setError('Could not save deep links.');
    }
  };

  const addDeepLink = () => {
    const packageName = draft.package.trim();
    const url = draft.url.trim();
    const name = draft.name.trim() || url;
    if (!packageName || !url) {
      setError('Package/app and link are required.');
      return;
    }

    const next = [
      ...links,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        platform,
        package: packageName,
        name,
        url,
      },
    ];
    setDraft({ package: packageName, name: '', url: '' });
    setExpanded((current) => new Set(current).add(packageName));
    void saveLinks(next);
  };

  const removeDeepLink = (id: string) => {
    void saveLinks(links.filter((link) => link.id !== id));
  };

  const startEdit = (link: DeepLink) => {
    setEditing({ ...link });
    setExpanded((current) => new Set(current).add(link.package));
    setError(null);
  };

  const saveEdit = () => {
    if (!editing) return;
    const packageName = editing.package.trim();
    const url = editing.url.trim();
    const name = editing.name.trim() || url;
    if (!packageName || !url) {
      setError('Package/app and link are required.');
      return;
    }

    const next = links.map((link) =>
      link.id === editing.id ? { ...editing, package: packageName, name, url } : link,
    );
    setEditing(null);
    setExpanded((current) => new Set(current).add(packageName));
    void saveLinks(next);
  };

  const toggleGroup = (packageName: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(packageName)) {
        next.delete(packageName);
      } else {
        next.add(packageName);
      }
      return next;
    });
  };

  return (
    <div className="qb-section">
      <div className="qb-section-title-row">
        <h2 className="qb-heading">Deep links</h2>
        <div className="qb-platform-tabs" role="tablist" aria-label="Deep link platform">
          {PLATFORM_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={platform === option.value}
              className={`qb-platform-tab ${platform === option.value ? 'qb-platform-tab-active' : ''}`}
              onClick={() => setPlatform(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="qb-card qb-deeplink-editor">
        <div className="qb-deeplink-grid">
          <select
            className="qb-input qb-deeplink-package-select"
            value={draft.package}
            disabled={packageOptions.length === 0}
            onChange={(e) => setDraft((current) => ({ ...current, package: e.target.value }))}
            aria-label="Package or app"
          >
            {packageOptions.length === 0 ? (
              <option value="">{appsLoading ? 'Loading apps...' : 'No apps found'}</option>
            ) : (
              packageOptions.map((app) => (
                <option key={app} value={app}>
                  {app}
                </option>
              ))
            )}
          </select>
          <input
            className="qb-input"
            value={draft.name}
            onChange={(e) => setDraft((current) => ({ ...current, name: e.target.value }))}
            placeholder="Name"
            aria-label="Deep link name"
          />
          <input
            className="qb-input qb-deeplink-url-input"
            value={draft.url}
            onChange={(e) => setDraft((current) => ({ ...current, url: e.target.value }))}
            placeholder="Link"
            aria-label="Deep link URL"
          />
          <button className="json-button qb-add-button" type="button" onClick={addDeepLink}>
            <Plus size={14} />
            <span>Add</span>
          </button>
        </div>
        {error && (
          <div className="qb-notice" role="alert">
            {error}
          </div>
        )}
        {appsError && (
          <div className="qb-notice" role="alert">
            {appsError}
          </div>
        )}
      </div>

      {Object.keys(groupedLinks).length === 0 ? (
        <div className="devices-message">No deep links saved for {platform === 'ios' ? 'simulators' : 'emulators'}.</div>
      ) : (
        <div className="qb-deeplink-groups">
          {Object.entries(groupedLinks).map(([packageName, packageLinks]) => {
            const isExpanded = expanded.has(packageName);
            return (
              <section key={packageName} className="qb-deeplink-group">
                <button className="qb-deeplink-group-head" type="button" onClick={() => toggleGroup(packageName)}>
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>{packageName}</span>
                  <strong>{packageLinks.length}</strong>
                </button>
                {isExpanded && (
                  <ul className="qb-deeplink-list">
                    {packageLinks.map((link) => (
                      <li key={link.id} className="qb-deeplink-row">
                        {editing?.id === link.id ? (
                          <div className="qb-deeplink-edit">
                            <select
                              className="qb-input qb-deeplink-package-select"
                              value={editing.package}
                              onChange={(e) => setEditing((current) => current && { ...current, package: e.target.value })}
                              aria-label="Package or app"
                            >
                              {packageOptions.map((app) => (
                                <option key={app} value={app}>
                                  {app}
                                </option>
                              ))}
                            </select>
                            <input
                              className="qb-input"
                              value={editing.name}
                              onChange={(e) => setEditing((current) => current && { ...current, name: e.target.value })}
                              placeholder="Name"
                              aria-label="Deep link name"
                            />
                            <input
                              className="qb-input qb-deeplink-edit-url"
                              value={editing.url}
                              onChange={(e) => setEditing((current) => current && { ...current, url: e.target.value })}
                              placeholder="Link"
                              aria-label="Deep link URL"
                            />
                            <button className="json-button" type="button" onClick={saveEdit}>
                              Save
                            </button>
                            <button className="json-button" type="button" onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="qb-deeplink-main">
                              <div className="qb-deeplink-name">{link.name}</div>
                              <div className="qb-deeplink-url" title={link.url}>
                                {link.url}
                              </div>
                            </div>
                            <div className="qb-deeplink-actions">
                              <button
                                className="json-button"
                                type="button"
                                onClick={() => startEdit(link)}
                                aria-label={`Edit ${link.name}`}
                                title="Edit"
                              >
                                <Pencil size={12} />
                              </button>
                              <button
                                className="json-button"
                                type="button"
                                onClick={() => removeDeepLink(link.id)}
                                aria-label={`Delete ${link.name}`}
                                title="Delete"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function statusLabel(status: string) {
  switch (status) {
    case 'granted':
      return 'Granted';
    case 'denied':
      return 'Denied';
    case 'while_in_use':
      return 'While in use';
    case 'limited':
      return 'Limited';
    case 'partial':
      return 'Partial';
    case 'not_requested':
      return 'Not requested';
    case 'unsupported':
      return 'Unsupported';
    default:
      return 'Unknown';
  }
}

function PermissionsSection({
  initialPlatform,
  initialDeviceId,
}: {
  initialPlatform: DevicePlatform;
  initialDeviceId?: string;
}) {
  const [platform, setPlatform] = useState<DevicePlatform>(initialPlatform);
  const deviceId = platform === initialPlatform ? initialDeviceId : undefined;
  const { app: currentApp, loading: appLoading, error: appError, refresh: refreshApp } = useCurrentRunningApp(platform, deviceId);
  const resolvedDeviceId = currentApp?.device_id ?? deviceId;
  const {
    apps,
    device,
    loading: appsLoading,
    error: appsError,
    refresh: refreshApps,
  } = useInstalledApps(platform, resolvedDeviceId);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [permissions, setPermissions] = useState<AppPermission[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appOptions = useMemo<InstalledApp[]>(() => {
    const merged = [...apps];
    if (currentApp && !merged.some((item) => item.id === currentApp.app_id)) {
      merged.unshift({ id: currentApp.app_id, name: currentApp.app_name });
    }
    return merged;
  }, [apps, currentApp]);
  const selectedApp = appOptions.find((item) => item.id === selectedAppId) ?? null;
  const targetDeviceId = currentApp?.device_id ?? device?.id ?? deviceId;
  const targetDeviceName = currentApp?.device_name ?? device?.name;

  const refreshPermissions = async () => {
    if (!targetDeviceId || !selectedAppId) {
      setPermissions([]);
      return;
    }
    setPermissionsLoading(true);
    setError(null);
    try {
      setPermissions(await api.listAppPermissions(platform, targetDeviceId, selectedAppId));
    } catch (err) {
      setError(String(err));
      setPermissions([]);
    } finally {
      setPermissionsLoading(false);
    }
  };

  useEffect(() => {
    void refreshPermissions();
  }, [platform, targetDeviceId, selectedAppId]);

  useEffect(() => {
    setSelectedAppId((current) => {
      if (current && appOptions.some((item) => item.id === current)) return current;
      return currentApp?.app_id ?? appOptions[0]?.id ?? '';
    });
  }, [appOptions, currentApp?.app_id]);

  useEffect(() => {
    setSelectedAppId('');
    setPermissions([]);
  }, [platform]);

  const applyPermission = async (permission: AppPermission, action: string) => {
    if (!targetDeviceId || !selectedAppId) return;
    const busyId = `${permission.id}:${action}`;
    setBusyAction(busyId);
    setError(null);
    try {
      const next = await api.setAppPermission(platform, targetDeviceId, selectedAppId, permission.id, action);
      setPermissions(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="qb-section">
      <div className="qb-section-title-row">
        <div>
          <h2 className="qb-heading">Permissions</h2>
          <div className="qb-permission-app">
            Permission for {selectedApp ? <strong>{selectedApp.name}</strong> : 'current app'}
          </div>
        </div>
        <div className="qb-platform-tabs" role="tablist" aria-label="Permission platform">
          {PLATFORM_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={platform === option.value}
              className={`qb-platform-tab ${platform === option.value ? 'qb-platform-tab-active' : ''}`}
              onClick={() => setPlatform(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="qb-list-actions">
        <button className="json-button" type="button" onClick={() => void refreshApp()} disabled={appLoading}>
          <RefreshCw size={12} className={appLoading ? 'animate-spin' : ''} />
          <span>Refresh app</span>
        </button>
        <button className="json-button" type="button" onClick={() => void refreshApps()} disabled={appsLoading}>
          <RefreshCw size={12} className={appsLoading ? 'animate-spin' : ''} />
          <span>Refresh apps</span>
        </button>
        <button
          className="json-button"
          type="button"
          onClick={() => void refreshPermissions()}
          disabled={!targetDeviceId || !selectedAppId || permissionsLoading}
        >
          <RefreshCw size={12} className={permissionsLoading ? 'animate-spin' : ''} />
          <span>Refresh status</span>
        </button>
      </div>

      {targetDeviceId && (
        <div className="qb-card qb-permission-selector">
          <select
            className="qb-input qb-deeplink-package-select"
            value={selectedAppId}
            onChange={(event) => setSelectedAppId(event.target.value)}
            disabled={appOptions.length === 0 || appsLoading}
            aria-label="Permission app"
          >
            {appOptions.length === 0 ? (
              <option value="">{appsLoading ? 'Loading apps...' : 'No apps found'}</option>
            ) : (
              appOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name === item.id ? item.id : `${item.name} (${item.id})`}
                </option>
              ))
            )}
          </select>
          <div className="qb-hint">
            {targetDeviceName ?? targetDeviceId} · {selectedAppId || 'No app selected'}
          </div>
        </div>
      )}

      {(appError || appsError || error) && (
        <div className="qb-notice" role="alert">
          {appError || appsError || error}
        </div>
      )}

      {!targetDeviceId && !appLoading && !appsLoading && !appError && !appsError && (
        <div className="devices-message">No current app found on a running {platform === 'ios' ? 'simulator' : 'emulator'}.</div>
      )}

      {targetDeviceId && selectedAppId && (
        <div className="qb-permission-list">
          {permissions.map((permission) => (
            <div key={permission.id} className="qb-permission-row">
              <div className="qb-permission-main">
                <div className="qb-permission-title">{permission.label}</div>
                <div className="qb-permission-description">{permission.description}</div>
              </div>
              <span className={`qb-permission-status qb-permission-status-${permission.status}`}>
                {statusLabel(permission.status)}
              </span>
              <div className="qb-permission-actions">
                {permission.actions.map((action) => {
                  const busy = busyAction === `${permission.id}:${action.id}`;
                  const selected =
                    (action.id === 'grant' && permission.status === 'granted') ||
                    (action.id === 'deny' && permission.status === 'denied') ||
                    (action.id === 'while_in_use' && permission.status === 'while_in_use');
                  return (
                    <button
                      key={action.id}
                      className={`json-button ${selected ? 'qb-permission-action-active' : ''}`}
                      type="button"
                      disabled={!action.enabled || busyAction !== null}
                      onClick={() => void applyPermission(permission, action.id)}
                      title={action.enabled ? action.label : `${action.label} is not scriptable here`}
                    >
                      {busy && <RefreshCw size={12} className="animate-spin" />}
                      <span>{action.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {!permissionsLoading && permissions.length === 0 && (
            <div className="devices-message">No managed permissions declared by this app.</div>
          )}
          {permissionsLoading && <div className="devices-message">Loading permission status...</div>}
        </div>
      )}
    </div>
  );
}

/** Options for the quick bar's screenshot and recording actions, and the saved recordings. */
export function QuickBarSettingsWindow() {
  useAppTheme();
  const { settings, loaded, update } = useQuickBarSettings();
  const settingsContext = useMemo(readSettingsContext, []);
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
        {loaded && section === 'deeplinks' && <DeepLinksSection />}
        {loaded && section === 'permissions' && (
          <PermissionsSection initialPlatform={settingsContext.platform} initialDeviceId={settingsContext.deviceId} />
        )}
      </main>
    </div>
  );
}
