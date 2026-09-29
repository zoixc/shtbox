import { useState } from 'preact/hooks';
import { disableReminders, enableReminders, permission, remindersOn, remindersSupported } from '../notify';
import { store, toast } from '../state';

export function RemindersSection() {
  const [busy, setBusy] = useState(false);
  if (!remindersSupported()) {
    return (
      <>
        <h3 class="dlg-h">Напоминания о ТО</h3>
        <p class="hint">Этот браузер не поддерживает уведомления. Можно выгрузить даты ТО в календарь (вкладка «ТО» → «Календарь»).</p>
      </>
    );
  }
  const on = remindersOn.value;
  const denied = permission() === 'denied';
  const toggle = async (want: boolean) => {
    setBusy(true);
    try {
      if (want) {
        if (!(await enableReminders(store))) toast('Уведомления запрещены в настройках браузера для этого сайта.', 'err');
      } else await disableReminders(store);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h3 class="dlg-h">Напоминания о ТО</h3>
      <label class="check">
        <input type="checkbox" checked={on} disabled={busy || denied} onChange={(e) => void toggle((e.target as HTMLInputElement).checked)} /> уведомлять о просроченном и скором ТО
      </label>
      <p class="hint">
        {denied
          ? 'Уведомления заблокированы в браузере — разрешите их для этого сайта в настройках.'
          : 'Не чаще раза в сутки на авто. Проверка идёт при открытии приложения, а в установленном PWA (Chrome/Edge) — и в фоне. Данные не покидают устройство.'}
      </p>
    </>
  );
}
