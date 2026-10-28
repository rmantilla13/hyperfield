/**
 * Tiny URL router. Every page and picker state lives in the URL
 * (/video?model=ltx25&preset=push-in&select=preset) so any view can be
 * linked, reloaded or shared.
 */
import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener('popstate', notify);

let cached = { path: '', search: '', key: '' };
function snapshot() {
  const key = location.pathname + location.search;
  if (key !== cached.key) cached = { path: location.pathname, search: location.search, key };
  return cached;
}

export function useRoute(): { path: string; params: URLSearchParams } {
  const s = useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), snapshot);
  return { path: s.path, params: new URLSearchParams(s.search) };
}

export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', to);
  notify();
}

/** Patch query params on the current path (null deletes). */
export function setParams(patch: Record<string, string | null | undefined>, replace = true) {
  const p = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') p.delete(k);
    else p.set(k, v);
  }
  const q = p.toString();
  navigate(location.pathname + (q ? `?${q}` : ''), replace);
}

/** <a> that routes client-side. */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(to);
    },
  };
}
