# DevSpace IDE image (devspace-ide:2): OpenVSCode Server for one member's copy.
# Build with `npm run ide:build`. Started by the API through dockerode (Phase 5 contract in CLAUDE.md).
#
# Runtime contract:
# - env DEVSPACE_CONNECTION_TOKEN (required): the connection token; the API proxy adds it.
# - env DEVSPACE_BASE_PATH (required): e.g. /ide/<copyId>; the server answers only under this path.
# - listens on 0.0.0.0:3000 and opens the folder /home/workspace (the copy, mounted by the API).
# - runs as any uid:gid; HOME is /tmp/devspace-home, created on start, so it is always writable.
# - works with all capabilities dropped and no-new-privileges.
# - includes Node.js 24 LTS and npm (cache and global installs under HOME).
# - includes DevSpace's tracker extension (Phase 9), built by `npm run ide:build` first.

# Node.js 24.21.0 LTS with npm 11.19.0, pinned by digest; only its files are copied below.
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node

# openvscode-server v1.105.1, pinned by digest.
FROM gitpod/openvscode-server:1.105.1@sha256:5e7b8750749f282940a799ed59ccd02fac698ef6744f9113ac01c0ef8e76485e

USER root

# The base image gives its user password-less sudo. Nobody gets root inside a DevSpace IDE.
# tini runs as PID 1 so `docker stop` ends the server at once and terminal zombies are reaped.
RUN rm -f /etc/sudoers.d/openvscode-server \
    && SUDO_FORCE_REMOVE=yes apt-get purge -y --auto-remove sudo \
    && apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Node.js and npm for the member's terminal (owner's choice: Node 24 LTS).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/include/node /usr/local/include/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=node /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/corepack
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
    && node --version && npm --version

COPY --chmod=0755 start.sh /usr/local/bin/devspace-ide-start

# devspace-tracker (Phase 9): a web extension that reports the open file and activity to the API
# through the IDE's own origin. Installed with VS Code's built-in extensions, outside HOME and owned
# by root, so a member cannot remove or change it (only disable it for themselves).
COPY --chown=root:root tracker/package.json $OPENVSCODE_SERVER_ROOT/extensions/devspace-tracker/package.json
COPY --chown=root:root tracker/dist/extension.js $OPENVSCODE_SERVER_ROOT/extensions/devspace-tracker/dist/extension.js
# The base image's user (uid 1000, which may also be the uid the API runs us as) owns the
# extensions folder, so hand that folder to root too: then the tracker cannot be renamed away.
RUN chmod -R u=rwX,go=rX $OPENVSCODE_SERVER_ROOT/extensions/devspace-tracker \
    && chown root:root $OPENVSCODE_SERVER_ROOT/extensions \
    && chmod 0755 $OPENVSCODE_SERVER_ROOT/extensions

# HOME must not be the workspace (VS Code would write its data into the member's copy) and must be
# writable for whatever uid the API runs us as, so it lives under /tmp and is created on start.
# npm keeps its cache in HOME (~/.npm) and installs global packages there too, since /usr/local
# is root's.
ENV HOME=/tmp/devspace-home \
    NPM_CONFIG_PREFIX=/tmp/devspace-home/.npm-global \
    PATH=/tmp/devspace-home/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /home/workspace
EXPOSE 3000

# Default user when run by hand; the API passes its own uid:gid.
USER 1000:1000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/devspace-ide-start"]
