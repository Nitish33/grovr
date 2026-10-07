import * as api from '@/lib/api';
import { usePinnedList } from '@/hooks/usePinnedList';
import { defaultLinkName, normalizeUrl } from '@/lib/links';

const LINKS_OPTIONS = {
  read: (settings: api.BackendAppSettings) => settings.quick_links,
  save: api.setQuickLinks,
  label: 'quick links',
};

/** Named links persisted in settings, with pinning and manual ordering. */
export function useQuickLinks() {
  const { items, loaded, add, patch, remove, togglePin, reorder } = usePinnedList<api.QuickLink>(
    api.getSettings,
    LINKS_OPTIONS
  );

  /** Returns false when the link isn't valid, so the caller can keep the draft. */
  const addLink = (name: string, link: string): boolean => {
    const url = normalizeUrl(link);
    if (!url) return false;
    add({ id: crypto.randomUUID(), name: name.trim() || defaultLinkName(url), url, pinned: false });
    return true;
  };

  const updateLink = (id: string, name: string, link: string): boolean => {
    const url = normalizeUrl(link);
    if (!url) return false;
    patch(id, { name: name.trim() || defaultLinkName(url), url });
    return true;
  };

  return { links: items, loaded, addLink, updateLink, removeLink: remove, togglePin, reorder };
}
