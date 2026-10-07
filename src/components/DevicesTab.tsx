import { useMemo, useState } from 'react';
import { PanelRight, Pin, PinOff, RefreshCw, ScrollText, Smartphone } from 'lucide-react';
import { DeviceNote } from '@/components/DeviceNote';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { useDevices, type DevicePlatform } from '@/hooks/useDevices';
import * as api from '@/lib/api';
import type { Device } from '@/lib/api';

type PendingAction = { type: 'launch' | 'unpin'; deviceId: string };

interface DevicesTabProps {
  platform: DevicePlatform;
}

const COPY: Record<DevicePlatform, { noun: string; empty: string }> = {
  ios: { noun: 'simulator', empty: 'No simulators found. Create one in Xcode → Window → Devices and Simulators.' },
  android: { noun: 'emulator', empty: 'No emulators found. Create one in Android Studio → Device Manager.' },
};

export function DevicesTab({ platform }: DevicesTabProps) {
  const {
    devices, pinned, notes, loading, error, refresh, togglePin, saveNote, launch, launchingId, launchError,
  } = useDevices(platform);
  const { noun, empty } = COPY[platform];
  const [pending, setPending] = useState<PendingAction | null>(null);

  // A launch confirmation is moot once the device is already running (e.g. started
  // elsewhere while the dialog was open), so don't show it.
  const pendingDevice = pending ? devices.find((d) => d.id === pending.deviceId) : undefined;
  const confirmOpen =
    pending !== null && pendingDevice !== undefined && !(pending.type === 'launch' && pendingDevice.state === 'Booted');

  const handleConfirm = () => {
    if (!pending) return;
    if (pending.type === 'launch') void launch(pending.deviceId);
    else void togglePin(pending.deviceId);
  };

  const { pinnedDevices, otherDevices } = useMemo(() => {
    const isPinned = (d: Device) => pinned.includes(`${platform}:${d.id}`);
    return {
      pinnedDevices: devices.filter(isPinned),
      otherDevices: devices.filter((d) => !isPinned(d)),
    };
  }, [devices, pinned, platform]);

  const openLogs = async (device: Device) => {
    try {
      await api.openLogWindow(platform, device.id, device.name);
    } catch (err) {
      console.error('Failed to open the log window:', err);
    }
  };

  const toggleDock = async (device: Device) => {
    try {
      await api.toggleDeviceDock(platform, device.id, device.name);
    } catch (err) {
      console.error('Failed to toggle the quick actions bar:', err);
    }
  };

  const renderRow = (device: Device, isPinned: boolean) => {
    const launching = launchingId === device.id;
    const running = device.state === 'Booted';
    return (
      <div key={device.id} className="device-row">
        <div className="device-row-body">
          <button
            className="device-row-main"
            title={running ? `${device.name} is running` : `Open ${device.name}`}
            aria-label={running ? `${device.name} (running)` : `Open ${device.name}`}
            disabled={launchingId !== null || running}
            onClick={() => !running && setPending({ type: 'launch', deviceId: device.id })}
          >
            <Smartphone size={14} className="device-row-icon" />
            <span className="device-row-name">{device.name}</span>
            {device.runtime && <span className="device-row-meta">{device.runtime}</span>}
            {launching ? (
              <span className="device-row-badge">Starting…</span>
            ) : (
              running && <span className="device-row-badge">Running</span>
            )}
          </button>
          {running && (
            <div className="device-row-tools">
              <button
                className="device-row-logs"
                title={`Stream native logs from ${device.name} in a new window`}
                onClick={() => void openLogs(device)}
              >
                <ScrollText size={12} />
                <span>Stream logs</span>
              </button>
              <button
                className="device-row-logs"
                title={`Show or hide the quick actions bar docked to ${device.name}`}
                onClick={() => void toggleDock(device)}
              >
                <PanelRight size={12} />
                <span>Quick bar</span>
              </button>
            </div>
          )}
        </div>
        <DeviceNote
          note={notes[`${platform}:${device.id}`] ?? ''}
          deviceName={device.name}
          onSave={(note) => void saveNote(device.id, note)}
        />
        <button
          className={`worktree-action device-pin ${isPinned ? 'device-pin-active' : ''}`}
          title={isPinned ? `Unpin ${noun}` : `Pin ${noun} to top`}
          aria-label={isPinned ? `Unpin ${device.name}` : `Pin ${device.name} to top`}
          aria-pressed={isPinned}
          // Pinning is instant; unpinning asks first
          onClick={() => (isPinned ? setPending({ type: 'unpin', deviceId: device.id }) : void togglePin(device.id))}
        >
          {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="devices-toolbar">
        <span className="devices-count">
          {loading ? 'Loading…' : `${devices.length} ${noun}${devices.length === 1 ? '' : 's'}`}
        </span>
        <button className="icon-button-sm" onClick={refresh} title={`Refresh ${noun}s`} aria-label={`Refresh ${noun}s`}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Plain scroll container: Radix ScrollArea would widen to fit long notes */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="devices-table pl-2 pr-3 pb-2">
          {error && <div className="devices-message">{error}</div>}
          {launchError && <div className="devices-message">{launchError}</div>}
          {!error && !loading && devices.length === 0 && <div className="devices-message">{empty}</div>}

          {pinnedDevices.length > 0 && (
            <>
              <div className="devices-section-label">Pinned</div>
              {pinnedDevices.map((d) => renderRow(d, true))}
              {otherDevices.length > 0 && <div className="devices-section-label">All {noun}s</div>}
            </>
          )}
          {otherDevices.map((d) => renderRow(d, false))}
        </div>
      </div>

      <ConfirmModal
        open={confirmOpen}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending?.type === 'unpin' ? `Unpin ${noun}?` : `Open ${noun}?`}
        description={
          pending?.type === 'unpin'
            ? `"${pendingDevice?.name ?? ''}" will move back to the main list.`
            : `Start "${pendingDevice?.name ?? ''}"?`
        }
        confirmLabel={pending?.type === 'unpin' ? 'Unpin' : 'Open'}
        variant={pending?.type === 'unpin' ? 'warning' : 'info'}
        onConfirm={handleConfirm}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
