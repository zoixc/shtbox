# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-alpine
# hadolint ignore=DL3006
FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=8081 DATA_DIR=/data
WORKDIR /app
COPY --chown=root:root --chmod=0444 sync-server.mjs ./
# /data принадлежит непривилегированному пользователю; именованный том унаследует права
RUN mkdir /data && chown node:node /data && chmod 0700 /data
VOLUME ["/data"]
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8081/healthz || exit 1
CMD ["node", "--disable-proto=delete", "sync-server.mjs"]
