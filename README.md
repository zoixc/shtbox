# ShtBox — журнал поломок и обслуживания автомобиля

Лёгкое офлайн-приложение (PWA): 3D-модель авто (по умолчанию седан в стиле Hyundai Solaris),
узлы, дефекты и доделки, регламентное ТО с периодичностью, история выполненных работ.

## Скриншоты

| | |
| --- | --- |
| ![Обзор: дефекты на кузове](docs/screenshots/01-overview.jpg) **Кузов с дефектами** — ржавчина, вмятины, сколы и царапины видны на модели, бейджи показывают открытые записи | ![Панель узла](docs/screenshots/02-zone.jpg) **Узел из списка** — камера подъезжает к нему, панель показывает открытые записи, регламент и историю |
| ![Агрегаты и ТО](docs/screenshots/03-maintenance-units.jpg) **Слой «Агрегаты» и регламентное ТО** — просрочено/скоро/нет данных | ![Журнал, открытые двери и капот](docs/screenshots/04-journal-open-doors.jpg) **Журнал работ** и открытые двери/капот/багажник |

<p align="center"><img src="docs/screenshots/05-mobile.jpg" alt="Мобильная версия" width="280"><br><em>Мобильная версия: 3D сверху, панель узлов — снизу</em></p>

## Возможности

- **3D-модель** с тремя слоями: кузов / салон / агрегаты (двигатель, КПП, подвеска, тормоза, выхлоп).
  Клик по узлу — панель узла (выбор из списка плавно подводит камеру к узлу); двойной клик по двери, капоту, багажнику — открыть. Бейджи показывают открытые записи и просроченное ТО.
- **Кузовные дефекты**: ржавчина, вмятины, сколы, царапины ставятся меткой прямо на панель (радиус 2–30 см).
  После отметки «выполнено» дефект исчезает с модели, остаётся лёгкий след ремонта, а запись уходит в журнал.
- **Узлы**: поломки, доработки, регламентные работы. Двери/капот/багажник, салон и колёса — отдельные узлы.
- **ТО**: периодичность по пробегу и/или по времени, статусы «просрочено / скоро / ОК», типовой регламент при создании авто.
- **Журнал**: все выполненные работы с датой, пробегом, стоимостью; фильтры, поиск, CSV. Выполнение можно вернуть в работу.
- **Несколько автомобилей**, экспорт/импорт резервной копии (JSON).

## Запуск

```bash
npm install
npm run dev        # разработка, http://localhost:5173
npm test           # unit-тесты (core + контракт моделей)
npm run build      # проверка типов + production-сборка в dist/
npm run preview    # просмотр prod-сборки
```

Node ≥ 20.

## Docker

Образ — статика в `nginx-unprivileged` (Alpine): ~50 МБ, без Node в рантайме, без root.

```bash
docker compose up -d --build     # http://localhost:8080
# или без compose:
docker build -t shtbox .
docker run -d --name shtbox -p 127.0.0.1:8080:8080 \
  --read-only --tmpfs /tmp:size=16m,mode=1777,noexec,nosuid,nodev \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 64 --memory 128m --cpus 0.5 shtbox
```

Что сделано для безопасности:

- **Многоступенчатая сборка**: Node, исходники и `node_modules` в итоговый образ не попадают; в сборке `npm ci --ignore-scripts`, перед упаковкой прогоняются тесты.
- **Не root**: `USER 101`, порт 8080, `cap_drop: ALL`, `no-new-privileges`.
- **Read-only ФС**: `read_only: true`, единственная записываемая область — `tmpfs /tmp` (`noexec,nosuid,nodev`); конфиг и статика принадлежат root.
- **Ограничения ресурсов**: `pids_limit`, память, CPU, `nofile`, ротация логов.
- **nginx**: только `GET/HEAD`, `server_tokens off`, короткие таймауты и лимиты запросов/соединений, `client_max_body_size 1k`, скрытые файлы и `.map` закрыты.
- **Заголовки** (`docker/security-headers.conf`): CSP (в т.ч. `frame-ancestors 'none'`), `nosniff`, `X-Frame-Options`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP/CORP.
- Порт в compose привязан к `127.0.0.1`. Для доступа снаружи поставьте перед контейнером TLS-прокси (Caddy/Traefik/nginx) и включите на нём HSTS: service worker и `storage.persist()` работают только по HTTPS (или localhost).
- Для воспроизводимости зафиксируйте базовые образы по digest: `--build-arg NODE_IMAGE=node:22-alpine@sha256:…`, `--build-arg NGINX_IMAGE=nginxinc/nginx-unprivileged:stable-alpine@sha256:…`.

Дополнительно можно проверить образ: `docker scout cves shtbox`, `trivy image shtbox`.

Данные пользователя хранятся в браузере (IndexedDB), поэтому у контейнера нет томов и состояния.

## Стек и почему

| Задача | Решение |
| --- | --- |
| UI | Preact + @preact/signals (~10 KB, точечные обновления без vdom-перерисовок всего) |
| 3D | three.js, модель генерируется процедурно (без тяжёлых ассетов), грузится лениво |
| Данные | IndexedDB, только локально; ничего не уходит в сеть |
| Сборка | Vite; стартовый бандл ≈ 28 KB gzip, three и 3D — отдельные чанки |
| Оффлайн | service worker (network-first), `navigator.storage.persist()` |
| Безопасность | строгий CSP в prod (`script-src 'self'; style-src 'self'; connect-src 'self'`), нет `innerHTML`/eval, валидация импорта бэкапа, защита CSV от формульных инъекций |

## Архитектура

```
src/core/      предметная логика без UI и three: типы, валидация, IndexedDB, Store (signals)
src/models/    реестр моделей авто; sedan/ — процедурный седан (loft → build → solaris)
src/view3d/    Viewer (three), шейдер краски с дефектами (paintMaterial)
src/ui/, App.tsx, ViewerPane.tsx   интерфейс
tests/         core и контракт моделей
```

Данные ссылаются на модель по `modelId`, на узлы — по `zoneId`, на дефект кузова — по локальным
координатам метки в панели. Поэтому новые модели не ломают старые записи.

## Как добавить другую модель авто

1. Создайте `CarModelDef` (см. `src/models/types.ts`, пример — `src/models/sedan/solaris.ts`):
   - `zones` — список узлов (`id`, `label`, `group`, `layer`, `openable`, `paintable`, `requiresOpen`);
   - `defaultMaintenance` — типовой регламент;
   - `create(color)` — асинхронная фабрика, возвращающая `ModelRig`. Внутри можно сгенерировать
     геометрию процедурно или загрузить glTF (`GLTFLoader` через dynamic `import`) и разложить
     меши по `paint` / `pick` / `openables` / `anchors` / `shell`.
2. Добавьте модель в массив в `src/models/registry.ts`.
3. `npm test` — тест контракта проверит, что у каждого узла есть геометрия, якорь бейджа,
   окрашиваемые узлы имеют меш, а у регламента существуют узлы.

Окрашиваемые меши используют `createPaintMaterial` (`src/view3d/paintMaterial.ts`): он читает
локальные координаты вершины, поэтому подходит для любой геометрии.

## Кастомизация

- Регламент ТО — `defaultMaintenance` модели или вручную в интерфейсе.
- Типы дефектов, стили — `src/core/types.ts`, `src/styles.css` (CSS-переменные в `:root`).
- Резервные копии — кнопка «Копия» (экспорт/импорт JSON).
