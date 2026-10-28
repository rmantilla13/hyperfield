/**
 * Drag and drop. Files from the desktop and takes dragged out of any feed land
 * in the slot under the cursor (useDropZone). Anything dropped elsewhere goes to
 * the page's main slot (usePageDrop), never to the browser, which would
 * otherwise navigate away to the file.
 */
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { mediaUrl } from './api';
import { toast } from './store';

/** dataTransfer type carrying a take id when a card is dragged inside the app. */
export const TAKE_MIME = 'application/x-openfield-take';

type AnyDrag = DragEvent | ReactDragEvent;

/** Is this drag carrying something we can use (files or a take)? */
export function carriesMedia(e: AnyDrag): boolean {
  const types = Array.from(e.dataTransfer?.types ?? []);
  return types.includes('Files') || types.includes(TAKE_MIME);
}

/** Everything a drop delivered, as Files. A dragged take is fetched from the server. */
export async function droppedFiles(dt: DataTransfer): Promise<File[]> {
  const files = Array.from(dt.files);
  if (files.length) return files;
  const id = dt.getData(TAKE_MIME);
  if (!id) return [];
  const blob = await (await fetch(mediaUrl(Number(id)))).blob();
  const ext = blob.type.startsWith('video/') ? 'mp4' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
  return [new File([blob], `take_${id}.${ext}`, { type: blob.type })];
}

/** Props for a card that can be dragged into a slot, or out to the desktop. */
export function takeDragProps(id: number, name: string, mime: string) {
  return {
    draggable: true,
    onDragStart: (e: ReactDragEvent) => {
      const url = new URL(mediaUrl(id), location.href).href;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData(TAKE_MIME, String(id));
      e.dataTransfer.setData('text/uri-list', url);
      // Chrome: dropping onto the desktop or a folder saves the file.
      e.dataTransfer.setData('DownloadURL', `${mime}:${name}:${url}`);
    },
  };
}

/** A slot that accepts drops. `over` is true while something droppable hovers it. */
export function useDropZone(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const cb = useRef(onFiles);
  cb.current = onFiles;
  return {
    over,
    props: {
      onDragEnter: (e: ReactDragEvent) => { if (!carriesMedia(e)) return; e.preventDefault(); depth.current++; setOver(true); },
      onDragOver: (e: ReactDragEvent) => { if (!carriesMedia(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; },
      onDragLeave: () => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); },
      onDrop: (e: ReactDragEvent) => {
        if (!carriesMedia(e)) return;
        e.preventDefault();
        e.stopPropagation();
        depth.current = 0;
        setOver(false);
        void droppedFiles(e.dataTransfer).then((f) => f.length && cb.current(f)).catch((err) => toast(String(err), true));
      },
    },
  };
}

// ---------- page-level fallback ----------

interface PageDrop { label: string; onFiles: (files: File[]) => void }
let page: PageDrop | null = null;
const listeners = new Set<(p: PageDrop | null) => void>();

/** Register where a drop anywhere on this page goes, and what the overlay says. */
export function usePageDrop(label: string, onFiles: (files: File[]) => void) {
  const cb = useRef(onFiles);
  cb.current = onFiles;
  useEffect(() => {
    const mine: PageDrop = { label, onFiles: (f) => cb.current(f) };
    page = mine;
    listeners.forEach((l) => l(page));
    return () => {
      if (page === mine) page = null;
      listeners.forEach((l) => l(page));
    };
  }, [label]);
}

/** App-level drop handling: stops the browser opening files and shows the page's drop hint. */
export function useGlobalDrop(): { dragging: boolean; label: string | null } {
  const [dragging, setDragging] = useState(false);
  const [current, setCurrent] = useState<PageDrop | null>(page);
  useEffect(() => {
    listeners.add(setCurrent);
    // Child effects run before this one, so the page may have registered already.
    setCurrent(page);
    let depth = 0;
    const enter = (e: DragEvent) => { if (!carriesMedia(e)) return; depth++; setDragging(true); };
    const over = (e: DragEvent) => { if (!carriesMedia(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = page ? 'copy' : 'none'; };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const drop = (e: DragEvent) => {
      if (!carriesMedia(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const target = page;
      if (!target || !e.dataTransfer) {
        toast('Open an app to use this file: drop it on Video, Edit, Stage, Mirror, Reshoot, Director, Effects, Upscale, Extend or Speak');
        return;
      }
      void droppedFiles(e.dataTransfer).then((f) => f.length && target.onFiles(f)).catch((err) => toast(String(err), true));
    };
    // Slots stop the drop from bubbling, so clear the overlay in the capture phase too.
    const reset = () => { depth = 0; setDragging(false); };
    window.addEventListener('drop', reset, true);
    window.addEventListener('dragend', reset);
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      listeners.delete(setCurrent);
      window.removeEventListener('drop', reset, true);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);
  return { dragging, label: current?.label ?? null };
}
