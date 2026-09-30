import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AttachmentOwner, Attachment } from '../core/types';
import { ValidationError } from '../core/validation';
import { compressImage } from '../image';
import { guard, store, toast, ui } from '../state';

function Thumb({ a }: { a: Attachment }) {
  const url = useMemo(() => URL.createObjectURL(a.thumb), [a.thumb]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <button type="button" class="photo" onClick={() => (ui.lightbox.value = a.id)} title={a.name}>
      <img src={url} alt={a.name} width={56} height={56} loading="lazy" decoding="async" />
    </button>
  );
}

/** Ряд миниатюр + кнопка «добавить фото». Файлы сжимаются и очищаются от EXIF на устройстве. */
export function Photos(props: { type: AttachmentOwner; id: string; addLabel?: string; phase?: 'before' | 'after' }) {
  const all = store.attachmentsByOwner.value.get(`${props.type}:${props.id}`) ?? [];
  const list = props.phase ? all.filter((a) => a.phase === props.phase) : all;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onPick = async (e: Event) => {
    const el = e.target as HTMLInputElement;
    const files = [...(el.files ?? [])];
    el.value = '';
    if (!files.length) return;
    setBusy(true);
    try {
      for (const f of files) {
        try {
          await store.addAttachment(props.type, props.id, await compressImage(f), props.phase);
        } catch (ex) {
          if (ex instanceof ValidationError) toast(ex.message, 'err');
          else await guard(Promise.reject(ex));
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="photos">
      {list.map((a) => (
        <Thumb a={a} key={a.id} />
      ))}
      <button type="button" class="photo-add" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Сжатие…' : (props.addLabel ?? '+ Фото')}
      </button>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={onPick} />
    </div>
  );
}
