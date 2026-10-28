/** The cast list, fetched once and shared by every prompt box and the Cast page. */
import { useEffect, useSyncExternalStore } from 'react';
import { api, type CastMember } from './api';

let list: CastMember[] = [];
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function refreshCast(): Promise<void> {
  inflight ??= api.cast()
    .then((c) => { list = c; loaded = true; emit(); })
    .catch(() => { /* server down; the status chip says so */ })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useCast(): CastMember[] {
  const v = useSyncExternalStore((l) => (listeners.add(l), () => { listeners.delete(l); }), () => list);
  useEffect(() => { if (!loaded) void refreshCast(); }, []);
  return v;
}

export const getCast = () => list;
