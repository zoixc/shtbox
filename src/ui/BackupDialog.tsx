import { useRef, useState } from 'preact/hooks';
import { CryptoError, decryptFile, encryptFile, generateSyncKey, isEncryptedFile, parseSyncKey } from '../core/crypto';
import { SyncClient, SyncError, loadSyncConfig, pushStore, saveSyncConfig } from '../core/sync';
import type { SyncConfig } from '../core/sync';
import type { Backup } from '../core/types';
import { ValidationError, parseBackupText } from '../core/validation';
import { store, toast, ui } from '../state';
import { download } from '../util';
import { ConfirmButton, Field } from './common';
import { Modal } from './Dialogs';
import { RemindersSection } from './Reminders';

const fmtKey = (k: string) => k.toUpperCase().replace(/[\s-]/g, '').match(/.{4}/g)?.join('-') ?? k;
const maskKey = (k: string) => `••••-••••-••••-••••-••••-••••-••••-${k.slice(-4)}`;
const errText = (e: unknown) =>
  e instanceof ValidationError || e instanceof CryptoError || e instanceof SyncError ? e.message : 'Что-то пошло не так: ' + (e instanceof Error ? e.message : String(e));

type Source = { kind: 'file' } | { kind: 'sync'; rev: number };

export function BackupDialog() {
  const close = () => (ui.dialog.value = null);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [invite, setInvite] = useState('');

  // файл
  const [withPhotos, setWithPhotos] = useState(true);
  const [encrypt, setEncrypt] = useState(false);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [encText, setEncText] = useState<string | null>(null);
  const [decPass, setDecPass] = useState('');

  // загруженная копия (из файла или с сервера) → предпросмотр → импорт
  const [pending, setPending] = useState<{ backup: Backup; source: Source } | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');

  // синхронизация
  const [cfg, setCfg] = useState<SyncConfig | null>(loadSyncConfig());
  const [showKey, setShowKey] = useState(false);
  const [joinKey, setJoinKey] = useState('');
  const [joining, setJoining] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setErr('');
    setInfo('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const updateCfg = (c: SyncConfig | null) => {
    saveSyncConfig(c);
    setCfg(c);
  };

  const exportAll = () =>
    run(async () => {
      if (encrypt && pass !== pass2) throw new CryptoError('Пароли не совпадают');
      const snap = await store.exportSnapshot(withPhotos);
      const json = JSON.stringify(snap);
      const day = new Date().toISOString().slice(0, 10);
      if (encrypt) download(`shtbox-backup-${day}.shtbox`, await encryptFile(json, pass), 'application/octet-stream');
      else download(`shtbox-backup-${day}.json`, JSON.stringify(snap, null, 2), 'application/json');
      setInfo(encrypt ? 'Зашифрованная копия скачана. Пароль нигде не сохраняется — не потеряйте его.' : 'Копия скачана.');
    });

  const onFile = (e: Event) =>
    run(async () => {
      const f = (e.target as HTMLInputElement).files?.[0];
      (e.target as HTMLInputElement).value = '';
      if (!f) return;
      setPending(null);
      setEncText(null);
      if (f.size > 120 * 1024 * 1024) throw new ValidationError('Файл слишком большой');
      const text = await f.text();
      if (isEncryptedFile(text)) return setEncText(text);
      setPending({ backup: parseBackupText(text), source: { kind: 'file' } });
    });

  const decrypt = () =>
    run(async () => {
      const text = await decryptFile(encText!, decPass);
      setPending({ backup: parseBackupText(text), source: { kind: 'file' } });
      setEncText(null);
      setDecPass('');
    });

  const doImport = () =>
    run(async () => {
      if (!pending) return;
      await store.importBackup(pending.backup, mode);
      if (pending.source.kind === 'sync' && cfg) updateCfg({ ...cfg, rev: pending.source.rev, at: Date.now() });
      toast('Данные загружены');
      close();
    });

  // ---- синхронизация
  const enableSync = () => {
    updateCfg({ key: generateSyncKey(), rev: null, invite: invite.trim() || undefined });
    setShowKey(true);
    setInfo('Ключ создан. Сохраните его в надёжном месте: без него данные с сервера не восстановить.');
  };
  const joinSync = () =>
    run(async () => {
      parseSyncKey(joinKey);
      updateCfg({ key: fmtKey(joinKey), rev: null, invite: invite.trim() || undefined });
      setJoining(false);
      setJoinKey('');
      setInfo('Устройство подключено. Нажмите «Получить», чтобы загрузить данные.');
    });
  const push = () =>
    run(async () => {
      const next = await pushStore(store, cfg!, withPhotos, { invite: cfg!.invite });
      updateCfg(next);
      setInfo(`Отправлено (ревизия ${next.rev}).`);
    });
  const pull = () =>
    run(async () => {
      const client = await SyncClient.create(cfg!.key, { invite: cfg!.invite });
      const got = await client.pull();
      if (!got) return setInfo('На сервере пока пусто — нажмите «Отправить» на устройстве, где есть данные.');
      setPending({ backup: got.backup, source: { kind: 'sync', rev: got.rev } });
    });
  const wipeServer = () =>
    run(async () => {
      await (await SyncClient.create(cfg!.key, { invite: cfg!.invite })).remove();
      updateCfg({ ...cfg!, rev: null });
      setInfo('Данные на сервере удалены.');
    });

  return (
    <Modal title="Данные, синхронизация и напоминания" onClose={close} wide>
      <div class="form">
        <p class="hint">Данные хранятся только в этом браузере (IndexedDB). Копию можно перенести на другое устройство файлом или через собственный сервер синхронизации — всё шифруется на вашем устройстве.</p>
        {!store.persistent && <p class="form-error">IndexedDB недоступна: данные пропадут после закрытия вкладки. Скачайте копию!</p>}

        <RemindersSection />

        <h3 class="dlg-h">Файл</h3>
        <label class="check">
          <input type="checkbox" checked={withPhotos} onChange={(e) => setWithPhotos((e.target as HTMLInputElement).checked)} /> с фотографиями ({store.attachments.value.length})
        </label>
        <label class="check">
          <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt((e.target as HTMLInputElement).checked)} /> зашифровать паролем (AES-256-GCM)
        </label>
        {encrypt && (
          <div class="row2">
            <Field label="Пароль (от 8 символов)">
              <input type="password" autocomplete="new-password" value={pass} onInput={(e) => setPass((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Повторите пароль">
              <input type="password" autocomplete="new-password" value={pass2} onInput={(e) => setPass2((e.target as HTMLInputElement).value)} />
            </Field>
          </div>
        )}
        <div class="form-actions">
          <button class="btn btn-primary" disabled={busy || (encrypt && pass.length < 8)} onClick={exportAll}>{encrypt ? 'Скачать .shtbox' : 'Скачать JSON'}</button>
          <button class="btn" disabled={busy} onClick={() => file.current?.click()}>Загрузить из файла…</button>
          <input ref={file} type="file" accept="application/json,.json,.shtbox" hidden onChange={onFile} />
        </div>
        {encText && (
          <div class="card">
            <p>Файл зашифрован. Введите пароль.</p>
            <Field label="Пароль">
              <input type="password" autocomplete="current-password" value={decPass} onInput={(e) => setDecPass((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && decPass && decrypt()} />
            </Field>
            <div class="form-actions">
              <button class="btn btn-primary" disabled={busy || !decPass} onClick={decrypt}>Расшифровать</button>
              <button class="btn btn-ghost" onClick={() => setEncText(null)}>Отмена</button>
            </div>
          </div>
        )}

        <h3 class="dlg-h">Синхронизация между устройствами</h3>
        {!cfg && !joining && (
          <>
            <p class="hint">Нужен сервер синхронизации (см. README, <code>docker compose --profile sync up</code>). Сервер хранит только зашифрованные данные; ключ создаётся здесь и известен только вам.</p>
            <Field label="Код-приглашение (только если сервер его требует)">
              <input value={invite} maxLength={64} autocomplete="off" spellcheck={false} onInput={(e) => setInvite((e.target as HTMLInputElement).value)} />
            </Field>
            <div class="form-actions">
              <button class="btn" onClick={enableSync}>Включить синхронизацию</button>
              <button class="btn" onClick={() => setJoining(true)}>Подключить это устройство по ключу…</button>
            </div>
          </>
        )}
        {!cfg && joining && (
          <div class="card">
            <Field label="Ключ синхронизации">
              <input value={joinKey} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck={false} onInput={(e) => setJoinKey((e.target as HTMLInputElement).value)} />
            </Field>
            <div class="form-actions">
              <button class="btn btn-primary" disabled={!joinKey.trim()} onClick={joinSync}>Подключить</button>
              <button class="btn btn-ghost" onClick={() => setJoining(false)}>Отмена</button>
            </div>
          </div>
        )}
        {cfg && (
          <div class="card">
            <p class="sync-key">
              Ключ: <code>{showKey ? cfg.key : maskKey(cfg.key)}</code>
            </p>
            <div class="form-actions">
              <button class="btn btn-ghost" onClick={() => setShowKey(!showKey)}>{showKey ? 'Скрыть' : 'Показать'}</button>
              <button
                class="btn btn-ghost"
                onClick={() => navigator.clipboard?.writeText(cfg.key).then(() => toast('Ключ скопирован'), () => toast('Не удалось скопировать', 'err'))}
              >
                Копировать
              </button>
            </div>
            <p class="item-meta">
              {cfg.rev === null ? 'Ещё не синхронизировано' : `Ревизия ${cfg.rev}`}
              {cfg.at && ` · ${new Date(cfg.at).toLocaleString('ru-RU')}`}
            </p>
            <div class="form-actions">
              <button class="btn btn-primary" disabled={busy} onClick={push}>Отправить на сервер</button>
              <button class="btn" disabled={busy} onClick={pull}>Получить с сервера</button>
            </div>
            <p class="hint">Синхронизация ручная: «Получить» объединяет данные по id (удаления не переносятся; чтобы перенести их, выберите «заменить»). Если на сервере более новая версия, отправка будет отклонена — сначала получите её.</p>
            <div class="form-actions">
              <ConfirmButton label="Забыть ключ на этом устройстве" confirm="Точно? Ключ пропадёт отсюда" onConfirm={() => (updateCfg(null), setShowKey(false))} />
              <ConfirmButton label="Удалить данные на сервере" confirm="Удалить с сервера?" onConfirm={wipeServer} />
            </div>
          </div>
        )}

        {busy && <p class="hint">Подождите…</p>}
        {err && <p class="form-error" role="alert">{err}</p>}
        {info && <p class="hint" role="status">{info}</p>}

        {pending && (
          <div class="card">
            <p>
              {pending.source.kind === 'sync' ? `На сервере (ревизия ${pending.source.rev})` : 'В файле'}: автомобилей — <b>{pending.backup.cars.length}</b>, записей — <b>{pending.backup.issues.length}</b>, регламент — <b>{pending.backup.tasks.length}</b>, журнал — <b>{pending.backup.logs.length}</b>, пробег — <b>{pending.backup.mileages?.length ?? 0}</b>, осмотры — <b>{pending.backup.inspections?.length ?? 0}</b>, OBD — <b>{pending.backup.diagnostics?.length ?? 0}</b>, фото — <b>{pending.backup.attachments?.length ?? 0}</b>.
            </p>
            <label class="check">
              <input type="radio" name="mode" checked={mode === 'merge'} onChange={() => setMode('merge')} /> Объединить с текущими данными
            </label>
            <label class="check">
              <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Заменить все текущие данные
            </label>
            <div class="form-actions">
              <button class="btn btn-primary" disabled={busy} onClick={doImport}>Импортировать</button>
              <button class="btn btn-ghost" onClick={() => setPending(null)}>Отмена</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
