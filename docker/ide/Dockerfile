# DevSpace IDE image (devspace-ide:5): OpenVSCode Server for one member's copy.
# Build with `npm run ide:build`. Started by the API through dockerode (Phase 5 contract in CLAUDE.md).
#
# Runtime contract:
# - env DEVSPACE_CONNECTION_TOKEN (required): the connection token; the API proxy adds it.
# - env DEVSPACE_BASE_PATH (required): e.g. /ide/<copyId>; the server answers only under this path.
# - listens on 0.0.0.0:3000 and opens the folder /home/workspace (the copy, mounted by the API).
# - runs as any uid:gid; HOME is /tmp/devspace-home, created on start, so it is always writable.
# - works with all capabilities dropped and no-new-privileges.
# - includes Node.js 24 LTS and npm (cache and global installs under HOME).
# - includes DevSpace's tracker extension (Phase 9; Phase 10 adds "DevSpace: Send review findings"),
#   built by `npm run ide:build` first.
# - includes Python 3 with pip and venv (Phase 11); `pip install` goes to HOME (~/.local) or to a
#   venv inside the copy.
# - sets DEVSPACE_PREVIEW_BASE_5173, DEVSPACE_PREVIEW_BASE_8080 and DEVSPACE_PREVIEW_BASE (the 5173
#   one) to <DEVSPACE_BASE_PATH>/__preview/<port>/, the path Preview serves an app under (Phase 11).
# - includes the Cline AI assistant (Phase 12). env DEVSPACE_AI_TOKEN, DEVSPACE_AI_BASE_URL
#   (http://<AI_GATEWAY_HOST>:<AI_GATEWAY_PORT>/v1) and DEVSPACE_AI_MODEL: start.sh connects Cline
#   to DevSpace's AI gateway with them, then removes them from the environment.

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

# Python 3 for the Python template (owner, Phase 11), from the base image's distribution
# (Ubuntu 22.04). As a non-root uid, `pip install` falls back to a user install in HOME.
RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 --version && python3 -m pip --version

# Node.js and npm for the member's terminal (owner's choice: Node 24 LTS).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/include/node /usr/local/include/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=node /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/corepack
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
    && node --version && npm --version

# The AI assistant (Phase 12, owner): Cline, pinned, from Open VSX, checked against its sha256.
# Installed with VS Code's built-in extensions, outside HOME and owned by root (like the tracker),
# so it is there in every IDE and a member cannot change it. start.sh connects it to DevSpace's
# AI gateway.
ARG CLINE_VERSION=4.1.22
ADD --checksum=sha256:134b54af94e1e4cc6cd07224a61f6873c40c845d9fba1f9e6aa510dd6e2c5382 \
    https://open-vsx.org/api/saoudrizwan/claude-dev/${CLINE_VERSION}/file/saoudrizwan.claude-dev-${CLINE_VERSION}.vsix \
    /tmp/cline.vsix
RUN python3 -m zipfile -e /tmp/cline.vsix /tmp/cline \
    && mv /tmp/cline/extension $OPENVSCODE_SERVER_ROOT/extensions/saoudrizwan.claude-dev \
    && rm -rf /tmp/cline /tmp/cline.vsix \
    && chown -R root:root $OPENVSCODE_SERVER_ROOT/extensions/saoudrizwan.claude-dev \
    && chmod -R u=rwX,go=rX $OPENVSCODE_SERVER_ROOT/extensions/saoudrizwan.claude-dev \
    && grep -q "\"version\": \"${CLINE_VERSION}\"" $OPENVSCODE_SERVER_ROOT/extensions/saoudrizwan.claude-dev/package.json

# DevSpace's default settings (Phase 12, owner): VS Code's own AI chat (Copilot; Cline is the
# assistant) and the "Setup VS Code Web" walkthrough are off by default. The web client takes
# default settings only from the page's workbench configuration, so devspace-defaults.js adds them
# there, loaded just before workbench.js (module scripts run in order). Members can still change
# both.
COPY --chown=root:root --chmod=0644 defaults/devspace-defaults.js $OPENVSCODE_SERVER_ROOT/out/vs/code/browser/workbench/devspace-defaults.js
RUN html=$OPENVSCODE_SERVER_ROOT/out/vs/code/browser/workbench/workbench.html \
    && grep -q 'src="{{WORKBENCH_WEB_BASE_URL}}/out/vs/code/browser/workbench/workbench.js"' "$html" \
    && sed -i 's#^\(\s*\)<script type="module" src="{{WORKBENCH_WEB_BASE_URL}}/out/vs/code/browser/workbench/workbench.js"></script>#\1<script type="module" src="{{WORKBENCH_WEB_BASE_URL}}/out/vs/code/browser/workbench/devspace-defaults.js"></script>\n&#' "$html" \
    && grep -q 'devspace-defaults.js' "$html"

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
# is root's. pip's user installs put their commands in ~/.local/bin.
ENV HOME=/tmp/devspace-home \
    NPM_CONFIG_PREFIX=/tmp/devspace-home/.npm-global \
    PATH=/tmp/devspace-home/.npm-global/bin:/tmp/devspace-home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /home/workspace
EXPOSE 3000

# Default user when run by hand; the API passes its own uid:gid.
USER 1000:1000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/devspace-ide-start"]
