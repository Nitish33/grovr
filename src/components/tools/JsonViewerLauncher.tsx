import { Braces } from 'lucide-react';
import * as api from '@/lib/api';

export function JsonViewerLauncher() {
  const handleOpen = async () => {
    try {
      await api.openJsonViewer();
    } catch (err) {
      console.error('Failed to open JSON viewer:', err);
    }
  };

  return (
    <div className="tool-row">
      <span className="tool-label">JSON viewer</span>
      <button
        className="tool-chip"
        onClick={() => void handleOpen()}
        title="Open the JSON viewer and beautifier in a new window"
      >
        <Braces size={12} />
        <span>Launch</span>
      </button>
    </div>
  );
}
