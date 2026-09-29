import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Backup } from '../core/types';
import { ValidationError, parseBackupText } from '../core/validation';
import { getModel, listModels } from '../models/registry';
import { guard, store, toast, ui } from '../state';
import { download, parseNum } from '../util';
import { ConfirmButton, Field } from './common';

function Modal(props: { title: string; onClose?: () => void; children: ComponentChildren; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose?.();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose?.()}>
      <div class={`modal ${props.wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title} ref={ref}>
        <header>
          <h2>{props.title}</h2>
          {props.onClose && <button class="btn btn-ghost" onClick={props.onClose} aria-label="Закрыть">✕</button>}
        </header>
        {props.children}
      </div>
    </div>
  );
}

const SWATCHES = ['#b9bec6', '#f2f3f5', '#1c1f24', '#8a9099', '#a3161f', '#1f4e8c', '#2f6b45', '#d4a017', '#5b3a29', '#6b2c7a'];

export function CarDialog(props: { mode: 'new' | 'edit'; forced?: boolean }) {
  const editing = props.mode === 'edit' ? store.activeCar.value : undefined;
  const models = listModels();
  const [name, setName] = useState(editing?.name ?? models[0].name.replace(/ \(.*\)/, ''));
  const [modelId, setModelId] = useState(editing?.modelId ?? models[0].id);
  const [color, setColor] = useState(editing?.color ?? getModel(models[0].id).defaultColor);
  const [plate, setPlate] = useState(editing?.plate ?? '');
  const [vin, setVin] = useState(editing?.vin ?? '');
  const [year, setYear] = useState(editing?.year ? String(editing.year) : '');
  const [mileage, setMileage] = useState(editing ? String(editing.mileage) : '');
  const [withTasks, setWithTasks] = useState(!editing);
  const close = () => (ui.dialog.value = null);

  // живой предпросмотр цвета на модели
  useEffect(() => {
    ui.previewColor.value = color;
  }, [color]);
  useEffect(() => () => void (ui.previewColor.value = null), []);

  const submit = async (e: Event) => {
    e.preventDefault();
    const data = {
      name: name.trim() || 'Мой автомобиль', modelId, color, plate: plate.trim(), vin: vin.trim().toUpperCase(),
      year: parseNum(year), mileage: Math.round(parseNum(mileage) ?? 0),
    };
    if (editing) {
      await guard(store.updateCar(editing.id, data));
    } else {
      const car = await guard(store.addCar(data));
      if (car && withTasks) await guard(store.addTasks(getModel(modelId).defaultMaintenance));
    }
    close();
  };

  return (
    <Modal title={editing ? 'Автомобиль' : 'Новый автомобиль'} onClose={props.forced ? undefined : close}>
      <form class="form" onSubmit={submit}>
        <Field label="Название">
          <input value={name} maxLength={120} onInput={(e) => setName((e.target as HTMLInputElement).value)} required />
        </Field>
        <Field label="Модель (3D)">
          <select
            value={modelId}
            disabled={!!editing}
            onChange={(e) => {
              const id = (e.target as HTMLSelectElement).value;
              setModelId(id);
              setColor(getModel(id).defaultColor);
            }}
          >
            {models.map((m) => (
              <option value={m.id} key={m.id}>{m.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Цвет кузова">
          <div class="swatches">
            {SWATCHES.map((c) => (
              <button type="button" key={c} class={`swatch ${c === color ? 'swatch-on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => setColor(c)} />
            ))}
            <input type="color" value={color} onInput={(e) => setColor((e.target as HTMLInputElement).value)} aria-label="Свой цвет" />
          </div>
        </Field>
        <div class="row2">
          <Field label="Госномер">
            <input value={plate} maxLength={20} onInput={(e) => setPlate((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Год выпуска">
            <input inputMode="numeric" value={year} onInput={(e) => setYear((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <Field label="VIN">
          <input value={vin} maxLength={32} onInput={(e) => setVin((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Текущий пробег, км">
          <input inputMode="numeric" value={mileage} onInput={(e) => setMileage((e.target as HTMLInputElement).value)} placeholder="0" />
        </Field>
        {!editing && (
          <label class="check">
            <input type="checkbox" checked={withTasks} onChange={(e) => setWithTasks((e.target as HTMLInputElement).checked)} />
            Добавить типовой регламент ТО для этой модели
          </label>
        )}
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">{editing ? 'Сохранить' : 'Создать'}</button>
          {!props.forced && <button class="btn btn-ghost" type="button" onClick={close}>Отмена</button>}
          {editing && (
            <ConfirmButton
              class="push-right"
              label="Удалить автомобиль"
              confirm="Удалить со всеми данными?"
              onConfirm={async () => {
                await guard(store.deleteCar(editing.id));
                close();
              }}
            />
          )}
        </div>
      </form>
    </Modal>
  );
}

export function BackupDialog() {
  const close = () => (ui.dialog.value = null);
  const [pending, setPending] = useState<Backup | null>(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const file = useRef<HTMLInputElement>(null);

  const [withPhotos, setWithPhotos] = useState(true);
  const exportAll = async () => {
    const b = await guard(store.exportSnapshot(withPhotos));
    if (!b) return;
    download(`shtbox-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(b, null, 2), 'application/json');
  };
  const onFile = async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    setErr('');
    setPending(null);
    try {
      if (f.size > 120 * 1024 * 1024) throw new ValidationError('Файл слишком большой');
      setPending(parseBackupText(await f.text()));
    } catch (ex) {
      setErr(ex instanceof ValidationError ? ex.message : 'Не удалось прочитать файл');
    }
    if (file.current) file.current.value = '';
  };
  return (
    <Modal title="Резервная копия" onClose={close}>
      <div class="form">
        <p class="hint">Данные хранятся только в этом браузере (IndexedDB). Делайте копии — файл можно перенести на другое устройство.</p>
        {!store.persistent && <p class="form-error">IndexedDB недоступна: данные пропадут после закрытия вкладки. Скачайте копию!</p>}
        <div class="form-actions">
          <button class="btn btn-primary" onClick={exportAll}>Скачать JSON</button>
          <label class="check">
            <input type="checkbox" checked={withPhotos} onChange={(e) => setWithPhotos((e.target as HTMLInputElement).checked)} /> с фотографиями ({store.attachments.value.length})
          </label>
          <button class="btn" onClick={() => file.current?.click()}>Загрузить из файла…</button>
          <input ref={file} type="file" accept="application/json,.json" hidden onChange={onFile} />
        </div>
        {err && <p class="form-error">{err}</p>}
        {pending && (
          <div class="card">
            <p>
              В файле: автомобилей — <b>{pending.cars.length}</b>, записей — <b>{pending.issues.length}</b>, регламент — <b>{pending.tasks.length}</b>, журнал — <b>{pending.logs.length}</b>, фото — <b>{pending.attachments?.length ?? 0}</b>.
            </p>
            <label class="check">
              <input type="radio" name="mode" checked={mode === 'merge'} onChange={() => setMode('merge')} /> Объединить с текущими данными
            </label>
            <label class="check">
              <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Заменить все текущие данные
            </label>
            <div class="form-actions">
              <button
                class="btn btn-primary"
                onClick={async () => {
                  const ok = await guard(store.importBackup(pending, mode).then(() => true));
                  if (ok) {
                    toast('Данные загружены');
                    close();
                  }
                }}
              >
                Импортировать
              </button>
              <button class="btn btn-ghost" onClick={() => setPending(null)}>Отмена</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function PhotoDialog(props: { id: string }) {
  const att = store.attachments.value.find((a) => a.id === props.id);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const close = () => (ui.lightbox.value = null);
  useEffect(() => {
    let made: string | null = null;
    let dead = false;
    store.getAttachmentBlob(props.id).then((b) => {
      if (dead) return;
      if (!b) return setErr('Файл не найден');
      made = URL.createObjectURL(b);
      setUrl(made);
    }, () => setErr('Не удалось прочитать файл'));
    return () => {
      dead = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [props.id]);
  if (!att) return null;
  return (
    <Modal title={att.name} onClose={close} wide>
      <div class="photo-view">
        {url ? <img src={url} alt={att.name} /> : <p class="hint">{err || 'Загрузка…'}</p>}
        <p class="item-meta">{att.w}×{att.h} · {Math.round(att.size / 1024)} КБ · {new Date(att.createdAt).toLocaleDateString('ru-RU')}</p>
        <div class="form-actions">
          {url && <a class="btn" href={url} download={att.name}>Скачать</a>}
          <ConfirmButton label="Удалить" onConfirm={() => void guard(store.deleteAttachment(att.id)).then(close)} />
          <button class="btn btn-ghost" onClick={close}>Закрыть</button>
        </div>
      </div>
    </Modal>
  );
}

export function HelpDialog() {
  return (
    <Modal title="Как пользоваться" onClose={() => (ui.dialog.value = null)}>
      <div class="help">
        <ul>
          <li><b>Клик по детали</b> на 3D-модели — открыть узел: поломки, доделки, регламент ТО и историю работ.</li>
          <li><b>Двойной клик</b> по двери, капоту или багажнику — открыть/закрыть. Пока капот открыт, доступен «Моторный отсек», у багажника — «Багажное отделение».</li>
          <li>Вкладки <b>Кузов / Салон / Агрегаты</b> переключают слой: салон и агрегаты видны сквозь прозрачный кузов.</li>
          <li><b>Ржавчина, вмятина, скол, царапина</b>: выберите тип и нажмите «Указать на модели» — кликните по кузову. Когда отметите «Выполнено», дефект плавно исчезнет с модели, а работа попадёт в журнал.</li>
          <li><b>Регламент ТО</b> — по пробегу и/или времени; срабатывает то, что наступит раньше. Обновляйте пробег в шапке.</li>
          <li>Колесо мыши/щипок — масштаб, ЛКМ — вращение, ПКМ — сдвиг.</li>
        </ul>
      </div>
    </Modal>
  );
}
