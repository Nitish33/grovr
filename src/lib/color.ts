/**
 * Converts an opacity string in [0, 1] to a two-digit hex alpha value ("80" for 0.5).
 * Returns null for empty or out-of-range input.
 */
export function opacityToHex(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;

  return Math.round(value * 255).toString(16).padStart(2, '0').toUpperCase();
}

const HEX_PATTERN = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function parseHex(input: string): string | null {
  const match = HEX_PATTERN.exec(input);
  if (!match) return null;

  let digits = match[1];
  if (digits.length <= 4) {
    digits = digits.replace(/./g, (c) => c + c); // expand #RGB / #RGBA
  }

  const channel = (i: number) => parseInt(digits.slice(i, i + 2), 16);
  const [r, g, b] = [channel(0), channel(2), channel(4)];

  if (digits.length === 6) return `rgb(${r}, ${g}, ${b})`;

  const alpha = Number((channel(6) / 255).toFixed(2));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parseRgb(input: string): string | null {
  const body = input.replace(/^rgba?\(/i, '').replace(/\)$/, '');
  const parts = body.split(/[\s,/]+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;

  const channels = parts.slice(0, 3).map(Number);
  if (channels.some((c) => !Number.isInteger(c) || c < 0 || c > 255)) return null;

  let hex = '#' + channels.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();

  if (parts.length === 4) {
    const alphaHex = opacityToHex(parts[3]);
    if (alphaHex === null) return null;
    hex += alphaHex;
  }
  return hex;
}

/**
 * Converts between hex and RGB, detecting the direction from the input.
 *   "#FF5733" / "ff5733" / "#F53" / "#FF573380" -> "rgb(255, 87, 51)" / "rgba(…, 0.5)"
 *   "rgb(255, 87, 51)" / "255 87 51" / "255,87,51,0.5" -> "#FF5733" / "#FF573380"
 * Returns null for empty or unrecognised input.
 */
export function convertColor(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  const looksLikeRgb = /^rgba?\(/i.test(trimmed) || /[\s,]/.test(trimmed);
  return looksLikeRgb ? parseRgb(trimmed) : parseHex(trimmed);
}
