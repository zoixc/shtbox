# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
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
