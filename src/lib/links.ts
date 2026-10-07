/** Schemes that can run code or read local files; never accepted as links. */
const BLOCKED_SCHEMES = new Set(['file', 'javascript', 'data', 'vbscript', 'blob']);

const HAS_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const MAIL_OR_TEL = /^(mailto|tel):/i;

/**
 * Turns user input into an openable link: keeps explicit schemes (https://, myapp://, mailto:),
 * and assumes https:// when there is none ("github.com/x" -> "https://github.com/x").
 * Returns null for empty or unsafe/invalid input.
 */
export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (text === '') return null;

  const url = HAS_SCHEME.test(text) || MAIL_OR_TEL.test(text) ? text : `https://${text}`;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase();
  if (!scheme || BLOCKED_SCHEMES.has(scheme)) return null;

  // Web links must parse as real URLs; other schemes are the app's own business
  if (scheme === 'http' || scheme === 'https') {
    try {
      return new URL(url).hostname ? url : null;
    } catch {
      return null;
    }
  }
  return url;
}

/** A short label for a link without a name: the host for web links, else the link itself. */
export function defaultLinkName(url: string): string {
  try {
    const { protocol, hostname } = new URL(url);
    if ((protocol === 'http:' || protocol === 'https:') && hostname) return hostname.replace(/^www\./, '');
  } catch {
    // fall through
  }
  return url;
}
