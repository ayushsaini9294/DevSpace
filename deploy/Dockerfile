# DevSpace production image (devspace-app): the API, the worker and the web build in one image.
# Built by deploy/compose.prod.yml from the repository root (context `..`):
#
#   docker compose -f deploy/compose.prod.yml build
#
# The same image runs three ways (see compose.prod.yml): `api`, `worker` and `migrate`.
# The web build (apps/web/dist) is served by Caddy, which copies it out of this image
# (deploy/caddy.Dockerfile).
#
# Other targets:
#   tracker-dist  the IDE's tracker extension, built here so a server needs no Node.js of its own.
#                 deploy/host-setup.sh exports it with
#                 `docker build --target tracker-dist --output type=local,dest=docker/ide/tracker/dist`.

# Node.js 24.21.0 LTS with npm 11.19.0 (the same Node as the IDE image) on Debian 13, pinned by
# digest. Debian 13 because the API needs Git 2.40 or newer (`git merge-tree --merge-base`);
# Debian 12's Git is 2.39.
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS node
# OpenSSL in every stage: Prisma picks its migration engine by the OpenSSL it finds when it is
# installed, and must find the same one when `migrate` runs (else it tries to download another).
# git: the API keeps projects as real Git repositories on disk.
RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends openssl git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && openssl version && git --version

# ---- build: install everything, then build the API, the worker, the web app and the tracker ----
FROM node AS build
WORKDIR /app
# Package files first, so the install is cached until a dependency changes.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY docker/ide/tracker/package.json docker/ide/tracker/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY apps/web apps/web
COPY docker/ide/tracker docker/ide/tracker
RUN npm run build -w @devspace/api \
    && npm run build -w @devspace/worker \
    && npm run build -w @devspace/web \
    && npm run build -w devspace-tracker \
    && test -f apps/api/dist/index.js \
    && test -f apps/worker/dist/main.js \
    && test -f apps/web/dist/index.html \
    && test -f docker/ide/tracker/dist/extension.js

# ---- tracker-dist: only the tracker's built file (exported by host-setup.sh) ----
FROM scratch AS tracker-dist
COPY --from=build /app/docker/ide/tracker/dist/extension.js /extension.js

# ---- deps: production dependencies only (no build tools, no tsx at run time) ----
FROM node AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY docker/ide/tracker/package.json docker/ide/tracker/
RUN npm ci --omit=dev --no-audit --no-fund \
      -w @devspace/api -w @devspace/worker -w @devspace/shared \
    && npm cache clean --force \
    && mkdir -p apps/api/node_modules apps/worker/node_modules packages/shared/node_modules

# ---- app: the image that runs ----
FROM node AS app
# (tini comes from Compose: init: true.)
# A fixed, non-root user. It owns DATA_DIR on the server (deploy/host-setup.sh), and the API starts
# IDE containers with the same uid:gid so file ownership matches. Never root.
RUN groupadd --system --gid 10001 devspace \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/devspace --create-home --shell /usr/sbin/nologin devspace
ENV NODE_ENV=production \
    HOME=/home/devspace \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules node_modules
COPY --from=deps --chown=root:root /app/package.json /app/package-lock.json ./
# Packages npm couldn't hoist live in each workspace's own node_modules (e.g. the Prisma CLI).
COPY --from=deps --chown=root:root /app/apps/api/node_modules apps/api/node_modules
COPY --from=deps --chown=root:root /app/apps/worker/node_modules apps/worker/node_modules
COPY --from=deps --chown=root:root /app/packages/shared/node_modules packages/shared/node_modules
# The API: its build, its starter templates and its migrations (for `migrate`).
COPY --from=build --chown=root:root /app/apps/api/package.json /app/apps/api/prisma.config.ts apps/api/
COPY --from=build --chown=root:root /app/apps/api/dist apps/api/dist
COPY --from=build --chown=root:root /app/apps/api/templates apps/api/templates
COPY --from=build --chown=root:root /app/apps/api/prisma apps/api/prisma
# The worker.
COPY --from=build --chown=root:root /app/apps/worker/package.json apps/worker/
COPY --from=build --chown=root:root /app/apps/worker/dist apps/worker/dist
# The shared package stays TypeScript source; Node 24 strips the types when it loads it.
COPY --from=build --chown=root:root /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=root:root /app/packages/shared/src packages/shared/src
# The web build, for Caddy to copy (never served by Node).
COPY --from=build --chown=root:root /app/apps/web/dist apps/web/dist
# Workspace links (node_modules/@devspace/*) point at these folders, so check they resolve.
RUN node -e "import('@devspace/shared').then(() => console.log('shared ok'))"
USER 10001:10001
# The Prisma CLI (for `migrate`) runs as the app's user.
RUN cd apps/api && npx --no prisma --version >/dev/null && echo "prisma ok"
# The API by default; compose.prod.yml sets the worker's and migrate's commands.
WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]
