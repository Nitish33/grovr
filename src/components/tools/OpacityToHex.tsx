import { useState } from 'react';
import { opacityToHex } from '@/lib/color';
import { CopyValueButton } from '@/components/tools/CopyValueButton';

export function OpacityToHex() {
  const [opacity, setOpacity] = useState('');

  const hex = opacityToHex(opacity);
  const invalid = opacity.trim() !== '' && hex === null;

  return (
    <div className="tool-row">
      <input
        type="text"
        inputMode="decimal"
        className={`tool-input ${invalid ? 'tool-input-invalid' : ''}`}
        value={opacity}
        onChange={(e) => setOpacity(e.target.value)}
        placeholder="0 – 1"
        aria-label="Opacity from 0 to 1"
        aria-invalid={invalid}
      />
      <CopyValueButton value={hex} placeholder="Hex" emptyHint="Enter a value between 0 and 1" />
    </div>
  );
}
