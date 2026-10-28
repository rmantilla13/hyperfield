/**
 * A prompt box that knows the cast. Typing @ opens the cast list; picking one
 * writes @Name into the text. The server resolves each mention into words in
 * the prompt and pictures for the engine (server/cast.ts). The members a
 * prompt names show as chips under it.
 */
import { useMemo, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import type { CastMember } from './api';
import { useCast } from './castStore';
import { mentionQuery, mentioned } from './mentions';
import { linkProps } from './router';
import { Icon } from './ui';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string;
  onChange: (v: string) => void;
  /** Which way the cast list opens. The Image composer sits at the bottom of the page. */
  dir?: 'up' | 'down';
  /** Show the chips of the members this prompt names. */
  chips?: boolean;
};

export const KIND_LABEL: Record<CastMember['kind'], string> = { character: 'Character', prop: 'Prop', place: 'Place' };

export function MentionBox({ value, onChange, dir = 'down', chips = true, onKeyDown, className, ...rest }: Props) {
  const cast = useCast();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [q, setQ] = useState<{ at: number; query: string } | null>(null);
  const [hi, setHi] = useState(0);

  const matches = useMemo(() => {
    if (!q) return [];
    const s = q.query.toLowerCase();
    return cast
      .filter((m) => m.name.toLowerCase().includes(s))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(s)) - Number(!b.name.toLowerCase().startsWith(s)))
      .slice(0, 6);
  }, [q, cast]);
  const named = useMemo(() => mentioned(value, cast), [value, cast]);

  const sync = (el: HTMLTextAreaElement) => {
    const next = mentionQuery(el.value, el.selectionStart ?? el.value.length);
    setQ(next);
    if (!next || next.query !== q?.query) setHi(0);
  };

  const pick = (m: CastMember) => {
    const el = ref.current;
    if (!el || !q) return;
    const caret = el.selectionStart ?? value.length;
    const after = value.slice(caret);
    const insert = `@${m.name}${/^[\s.,;:!?]/.test(after) ? '' : ' '}`;
    const next = value.slice(0, q.at) + insert + after;
    onChange(next);
    setQ(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = q.at + insert.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (q && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(matches[Math.min(hi, matches.length - 1)]);
        return;
      }
    }
    if (q && e.key === 'Escape') { e.preventDefault(); setQ(null); return; }
    onKeyDown?.(e);
  };

  return (
    <div className="mention-wrap">
      <textarea ref={ref} className={className} value={value} {...rest}
        onChange={(e) => { onChange(e.target.value); sync(e.target); }}
        onKeyDown={keys}
        onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) sync(e.currentTarget); }}
        onClick={(e) => sync(e.currentTarget)}
        onBlur={() => setTimeout(() => setQ(null), 150)} />
      {q && (
        <div className={`popover mention-pop ${dir}`} role="listbox" aria-label="Cast">
          <div className="pop-title label">Cast</div>
          {matches.map((m, i) => (
            <button key={m.id} type="button" role="option" aria-selected={i === hi}
              className={`pop-item mention-item ${i === hi ? 'on' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(m); }} onMouseEnter={() => setHi(i)}>
              <span className="mention-face">{m.refs[0] && <img src={m.refs[0].url} alt="" />}</span>
              <span className="mention-name">{m.name}</span>
              <small>{KIND_LABEL[m.kind]}</small>
            </button>
          ))}
          {!matches.length && (
            <div className="mention-empty">
              {cast.length ? <>No one called <b>{q.query}</b> in your cast.</> : <>Your cast is empty.</>}{' '}
              <a {...linkProps('/cast?new=1')} onMouseDown={(e) => e.preventDefault()}>Add a cast member</a>
            </div>
          )}
        </div>
      )}
      {chips && named.length > 0 && <CastChips members={named} />}
    </div>
  );
}

/** Small chips for the members a prompt names. */
export function CastChips({ members, note }: { members: CastMember[]; note?: string }) {
  return (
    <div className="cast-chips">
      <span className="label">Cast</span>
      {members.map((m) => (
        <span key={m.id} className="cast-chip" title={m.notes || m.name}>
          {m.refs[0] ? <img src={m.refs[0].url} alt="" /> : <Icon name="person" size={12} />}
          {m.name}
        </span>
      ))}
      {note && <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>{note}</span>}
    </div>
  );
}

/** The members a prompt names (for pages that change what they show). */
export function useMentioned(text: string): CastMember[] {
  const cast = useCast();
  return useMemo(() => mentioned(text, cast), [text, cast]);
}
