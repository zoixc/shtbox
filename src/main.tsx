import { render } from 'preact';
import './styles.css';
import { App } from './App';
import { initReminders } from './notify';
import { initStore } from './state';

async function boot() {
  const root = document.getElementById('app')!;
  try {
    const store = await initStore();
    if (import.meta.env.DEV) (window as unknown as { __store: unknown }).__store = store;
    render(<App />, root);
    void initReminders(store);
  } catch (e) {
    console.error(e);
    root.textContent = 'Не удалось запустить приложение: ' + (e instanceof Error ? e.message : String(e));
  }
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }
  // просим браузер не вычищать данные при нехватке места
  navigator.storage?.persist?.().catch(() => undefined);
}
void boot();
