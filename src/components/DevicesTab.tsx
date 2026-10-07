import { useMemo } from 'react';
import { Pin, PinOff, RefreshCw, Smartphone } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useDevices, type DevicePlatform } from '@/hooks/useDevices';
import type { Device } from '@/lib/api';

interface DevicesTabProps {
  platform: DevicePlatform;
}

const COPY: Record<DevicePlatform, { noun: string; empty: string }> = {
  ios: { noun: 'simulator', empty: 'No simulators found. Create one in Xcode → Window → Devices and Simulators.' },
  android: { noun: 'emulator', empty: 'No emulators found. Create one in Android Studio → Device Manager.' },
};

export function DevicesTab({ platform }: DevicesTabProps) {
  const {
    devices, pinned, loading, error, refresh, togglePin, launch, launchingId, launchError,
  } = useDevices(platform);
  const { noun, empty } = COPY[platform];

  const { pinnedDevices, otherDevices } = useMemo(() => {
    const isPinned = (d: Device) => pinned.includes(`${platform}:${d.id}`);
    return {
      pinnedDevices: devices.filter(isPinned),
      otherDevices: devices.filter((d) => !isPinned(d)),
    };
  }, [devices, pinned, platform]);

  const renderRow = (device: Device, isPinned: boolean) => {
    const launching = launchingId === device.id;
    return (
      <div key={device.id} className="device-row">
        <button
          className="device-row-main"
          title={`Open ${device.name}`}
          aria-label={`Open ${device.name}`}
          disabled={launchingId !== null}
          onClick={() => void launch(device.id)}
        >
          <Smartphone size={14} className="device-row-icon" />
          <span className="device-row-name">{device.name}</span>
          {device.runtime && <span className="device-row-meta">{device.runtime}</span>}
          {launching ? (
            <span className="device-row-badge">Starting…</span>
          ) : (
            device.state === 'Booted' && <span className="device-row-badge">Running</span>
          )}
        </button>
        <button
          className={`worktree-action device-pin ${isPinned ? 'device-pin-active' : ''}`}
          title={isPinned ? `Unpin ${noun}` : `Pin ${noun} to top`}
          aria-label={isPinned ? `Unpin ${device.name}` : `Pin ${device.name} to top`}
          aria-pressed={isPinned}
          onClick={() => void togglePin(device.id)}
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

      <ScrollArea className="flex-1">
        <div className="pl-2 pr-3 pb-2">
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
      </ScrollArea>
    </div>
  );
}
