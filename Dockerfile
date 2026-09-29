# syntax=docker/dockerfile:1

# Для воспроизводимости зафиксируйте образы по digest:
#   docker buildx imagetools inspect node:22-alpine   →   --build-arg NODE_IMAGE=node:22-alpine@sha256:...
ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:stable-alpine

# ---------- 1. сборка (не попадает в итоговый образ) ----------
# hadolint ignore=DL3006
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NODE_ENV=development CI=true
COPY package.json package-lock.json ./
# --ignore-scripts: чужие postinstall-скрипты не выполняются
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
# server/ нужен тестам (tests/sync.test.ts гоняет сервер синхронизации)
COPY server ./server
COPY tests ./tests
RUN npm test && npm run build \
 # заранее сжимаем статику (nginx отдаёт .gz через gzip_static)
 && find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' -o -name '*.webmanifest' \) -exec gzip -9 -k {} +

# ---------- 2. рантайм: только nginx и статика ----------
# hadolint ignore=DL3006
FROM ${NGINX_IMAGE}
LABEL org.opencontainers.image.title="ShtBox" \
      org.opencontainers.image.description="Журнал поломок и обслуживания автомобиля (статическое PWA)" \
      org.opencontainers.image.source="https://github.com/zoixc/shtbox"

# конфиг и статика принадлежат root и недоступны на запись пользователю nginx (uid 101)
COPY --chown=root:root --chmod=0644 docker/nginx.conf /etc/nginx/nginx.conf
COPY --chown=root:root --chmod=0644 docker/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build --chown=root:root /app/dist /usr/share/nginx/html

USER 101:101
EXPOSE 8080
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
# запускаем nginx напрямую, минуя entrypoint-скрипты образа (они пытаются писать в /etc/nginx)
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
