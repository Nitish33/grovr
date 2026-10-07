const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ' +
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ' +
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.';

/** Returns lorem ipsum text of exactly `length` characters. */
export function generateLorem(length: number): string {
  if (length <= 0) return '';

  const text = (LOREM + ' ').repeat(Math.ceil(length / (LOREM.length + 1))).slice(0, length);

  // Avoid ending on a dangling comma or mid-sentence space, keeping the exact length
  return /[^.]\s$|,$/.test(text) ? text.slice(0, -1) + '.' : text;
}
