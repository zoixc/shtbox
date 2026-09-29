import { useState } from 'preact/hooks';
import { patchProfile } from '../import/container';
import { deleteUserModel, readUserModelFile, userModels } from '../models/user';
import { listModels } from '../models/registry';
import { guard, store, toast, ui } from '../state';
import { ConfirmButton } from './common';
import { Modal } from './Dialogs';

const mb = (n: number) => `${(n / 1048576).toFixed(1)} МБ`;

export function ModelsDialog() {
  const [, bump] = useState(0);
  const close = () => (ui.dialog.value = null);
  const metas = userModels();
  const used = (id: string) => store.cars.value.filter((c) => c.modelId === id).length;

  const open = (id: string | null) => {
    ui.importReturn.value = null;
    ui.replaceId.value = null;
    ui.editModel.value = id;
    ui.dialog.value = 'import';
  };
  const exportModel = async (id: string) => {
    const m = metas.find((x) => x.id === id);
    const bytes = m && (await guard(readUserModelFile(store.backend, id)));
    if (!m || !bytes) return;
    const url = URL.createObjectURL(new Blob([patchProfile(bytes, m.profile) as BlobPart], { type: 'model/gltf-binary' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${m.name.replace(/[^\w.-]+/g, '_')}.shtcar.glb`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <Modal title="Модели автомобилей" onClose={close} wide>
      <div class="form">
        <p class="hint">
          Встроенных моделей: {listModels().length - metas.length}. Собственные модели хранятся только в этом браузере и не отправляются на сервер синхронизации — на другом устройстве
          загрузите тот же файл (кнопка «Экспорт» создаёт пакет вместе с разметкой).
        </p>
        {metas.length === 0 && <p class="hint">Своих моделей пока нет.</p>}
        <ul class="model-list">
          {metas.map((m) => (
            <li key={m.id}>
              <div class="model-name">
                <b>{m.name}</b>
                <span class="hint">
                  {m.body === 'sedan' ? 'седан' : m.body === 'hatch' ? 'хэтчбек' : 'купе'} · {m.layout === 'rear' ? 'двигатель сзади' : 'двигатель спереди'} · {mb(m.size)}
                  {used(m.id) > 0 && ` · используется: ${used(m.id)}`}
                </span>
                {m.profile.credits?.author && <span class="hint">Автор: {m.profile.credits.author}{m.profile.credits.license ? ` · ${m.profile.credits.license}` : ''}</span>}
              </div>
              <div class="model-actions">
                <button class="btn" onClick={() => open(m.id)}>Разметка</button>
                <button class="btn" onClick={() => void exportModel(m.id)}>Экспорт</button>
                {used(m.id) > 0 ? (
                  <button class="btn btn-ghost" disabled title="Сначала смените модель у автомобилей, которые её используют">Удалить</button>
                ) : (
                  <ConfirmButton
                    label="Удалить"
                    confirm="Точно?"
                    onConfirm={async () => {
                      if ((await guard(deleteUserModel(store.backend, m.id).then(() => true))) === true) {
                        toast('Модель удалена');
                        ui.modelsRev.value++;
                        bump((n) => n + 1);
                      }
                    }}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
        <div class="form-actions">
          <button class="btn btn-primary" onClick={() => open(null)}>+ Загрузить модель (.glb)…</button>
          <button class="btn btn-ghost" onClick={close}>Закрыть</button>
        </div>
      </div>
    </Modal>
  );
}
