# syntax=docker/dockerfile:1

# Multi-platform manifest digests pin current Node 24 LTS and unprivileged stable Nginx images.
# Dependabot keeps these pins fresh; override build args only with a verified tag@sha256 digest.
ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:stable-alpine@sha256:ed04ec1ff34502c339ee5c3ae3f855442398edc1d05591e2b98981dcbbd20b1e

# ---------- 1. сборка (не попадает в итоговый образ) ----------
# hadolint ignore=DL3006
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# BusyBox gzip lacks -n; install GNU gzip for deterministic headers in precompressed static assets.
# hadolint ignore=DL3018
RUN apk add --no-cache gzip
ENV NODE_ENV=development CI=true
COPY package.json package-lock.json ./
# --ignore-scripts: чужие postinstall-скрипты не выполняются
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
# server/ нужен тестам (tests/sync.test.ts гоняет сервер синхронизации)
COPY server ./server
COPY tests ./tests
RUN npm test && npm run build \
 && find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' -o -name '*.webmanifest' -o -name '*.glb' \) \
    -exec sh -ec '\
      for file do \
        compressed="$file.gz.tmp"; \
        gzip -9 -n -c "$file" > "$compressed"; \
        original_size=$(wc -c < "$file" | tr -d "[:space:]"); \
        compressed_size=$(wc -c < "$compressed" | tr -d "[:space:]"); \
        if [ "$compressed_size" -lt "$original_size" ]; then mv "$compressed" "$file.gz"; else rm -f "$compressed"; fi; \
      done \
    ' sh {} +

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
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
# запускаем nginx напрямую, минуя entrypoint-скрипты образа (они пытаются писать в /etc/nginx)
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
