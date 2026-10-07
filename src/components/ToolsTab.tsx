import { ColorConverter } from '@/components/tools/ColorConverter';
import { JsonViewerLauncher } from '@/components/tools/JsonViewerLauncher';
import { LoremIpsum } from '@/components/tools/LoremIpsum';
import { OpacityToHex } from '@/components/tools/OpacityToHex';

export function ToolsTab() {
  return (
    <div className="flex-1 min-h-0 px-2">
      <OpacityToHex />
      <ColorConverter />
      <LoremIpsum />
      <JsonViewerLauncher />
    </div>
  );
}
