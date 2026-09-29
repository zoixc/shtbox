import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

export function Field(props: { label: string; children: ComponentChildren; hint?: string; class?: string }) {
  return (
    <label class={`field ${props.class ?? ''}`}>
      <span class="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span class="field-hint">{props.hint}</span>}
    </label>
  );
}

/** Кнопка с подтверждением: первый клик — «Точно?», второй — действие. */
export function ConfirmButton(props: { label: string; confirm?: string; onConfirm: () => void; class?: string; title?: string }) {
  const [armed, setArmed] = useState(false);
  const t = useRef(0);
  useEffect(() => () => clearTimeout(t.current), []);
  return (
    <button
      type="button"
      class={`btn ${armed ? 'btn-danger' : 'btn-ghost'} ${props.class ?? ''}`}
      title={props.title}
      onClick={() => {
        if (armed) {
          clearTimeout(t.current);
          setArmed(false);
          props.onConfirm();
        } else {
          setArmed(true);
          t.current = window.setTimeout(() => setArmed(false), 3000);
        }
      }}
    >
      {armed ? (props.confirm ?? 'Точно?') : props.label}
    </button>
  );
}

export function Section(props: { title: string; count?: number; action?: ComponentChildren; children: ComponentChildren; empty?: string }) {
  return (
    <section class="section">
      <header class="section-head">
        <h3>
          {props.title}
          {props.count !== undefined && <span class="count">{props.count}</span>}
        </h3>
        {props.action}
      </header>
      {props.children}
    </section>
  );
}

export function Empty(props: { children: ComponentChildren }) {
  return <p class="empty">{props.children}</p>;
}

export function Chip(props: { tone?: 'red' | 'amber' | 'green' | 'blue' | 'gray'; children: ComponentChildren; title?: string }) {
  return (
    <span class={`chip chip-${props.tone ?? 'gray'}`} title={props.title}>
      {props.children}
    </span>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** пометка справа (например, «вкл.») */
  hint?: string;
  active?: boolean;
  /** не закрывать меню после выбора (переключатели) */
  keepOpen?: boolean;
  separator?: boolean;
}

/**
 * Выпадающее меню (position: fixed, поэтому не обрезается прокручиваемыми панелями).
 * Закрывается по клику снаружи, Esc и после выбора; `up` — раскрывать вверх (для нижних панелей).
 */
export function Menu(props: { label: ComponentChildren; items: MenuItem[]; up?: boolean; align?: 'left' | 'right'; class?: string; title?: string; ariaLabel?: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const open = pos !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !list.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        btn.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    list.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = () => {
    if (open) return setPos(null);
    const r = btn.current!.getBoundingClientRect();
    setPos({ x: props.align === 'right' ? r.right : r.left, y: props.up ? r.top : r.bottom });
  };

  const style = pos
    ? {
        ...(props.up ? { bottom: `${window.innerHeight - pos.y + 6}px` } : { top: `${pos.y + 6}px` }),
        ...(props.align === 'right' ? { right: `${Math.max(8, window.innerWidth - pos.x)}px` } : { left: `${Math.max(8, pos.x)}px` }),
      }
    : undefined;

  return (
    <>
      <button ref={btn} type="button" class={`btn ${props.class ?? ''}`} title={props.title} aria-label={props.ariaLabel} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        {props.label}
      </button>
      {open && (
        <div ref={list} class="menu" role="menu" style={style}>
          {props.items.map((it, i) =>
            it.separator ? (
              <hr key={i} class="menu-sep" />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                class={`menu-item ${it.active ? 'menu-item-on' : ''}`}
                onClick={() => {
                  it.onSelect();
                  if (!it.keepOpen) setPos(null);
                }}
              >
                <span>{it.label}</span>
                {it.hint && <span class="menu-hint">{it.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </>
  );
}
