# One image per release: the API, which also serves the built admin app at /admin/. The API is
# bundled except for better-sqlite3, which ships prebuilt binaries in its npm package, so install
# scripts (its node-gyp fallback needs a compiler) are skipped.
# Build from the repo root: docker build -f deploy/Dockerfile --target app|backup .

# Mainland servers cannot reach the default registries reliably, so each source can be swapped
# for a mirror at build time (see deploy/README.md).
ARG NODE_IMAGE=node:22-bookworm-slim
ARG RCLONE_IMAGE=rclone/rclone:1.71

FROM ${RCLONE_IMAGE} AS rclone

FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=$NPM_REGISTRY \
    COREPACK_NPM_REGISTRY=$NPM_REGISTRY \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@rs/api..." --filter "@rs/admin..." \
 && pnpm --filter @rs/admin build \
 && pnpm --filter @rs/api build \
 && mkdir -p /out/node_modules \
 && cp -r apps/api/package.json apps/api/dist apps/api/drizzle /out/ \
 && cp -rL apps/api/node_modules/better-sqlite3 /out/node_modules/ \
 && rm -rf /out/node_modules/better-sqlite3/deps /out/node_modules/better-sqlite3/src

FROM ${NODE_IMAGE} AS app
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/data/app.db \
    UPLOADS_DIR=/data/uploads \
    ADMIN_DIR=/app/admin
WORKDIR /app/api
COPY --from=build /out ./
COPY --from=build /src/apps/admin/dist /app/admin
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Outside production the API falls back to the password "admin", so refuse to start without one.
CMD ["sh", "-c", "[ -n \"$ADMIN_PASSWORD\" ] || { echo 'ADMIN_PASSWORD is not set'; exit 1; }; exec node dist/server.js"]

# Nightly copies of the database and images to COS, built from the same release as the app.
FROM app AS backup
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY deploy/backup /app/api/backup
# rclone takes its settings from RCLONE_CONFIG_COS_* variables; the empty file keeps it quiet.
RUN mkdir -p /home/node/.config/rclone && touch /home/node/.config/rclone/rclone.conf
HEALTHCHECK NONE
CMD ["/app/api/backup/schedule.sh"]
