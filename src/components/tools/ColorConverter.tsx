import { useState } from 'react';
import { convertColor } from '@/lib/color';
import { CopyValueButton } from '@/components/tools/CopyValueButton';

export function ColorConverter() {
  const [input, setInput] = useState('');

  const result = convertColor(input);
  const invalid = input.trim() !== '' && result === null;

  return (
    <div className="tool-row">
      <input
        type="text"
        className={`tool-input tool-input-wide ${invalid ? 'tool-input-invalid' : ''}`}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="#FF5733 or 255, 87, 51"
        aria-label="Hex or RGB color"
        aria-invalid={invalid}
        spellCheck={false}
      />
      <CopyValueButton
        value={result}
        placeholder="RGB / Hex"
        emptyHint="Enter a hex (#FF5733) or RGB (255, 87, 51) color"
      />
    </div>
  );
}
