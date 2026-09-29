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
