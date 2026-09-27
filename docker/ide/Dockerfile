# DevSpace IDE image (devspace-ide:1): OpenVSCode Server for one member's copy.
# Build with `npm run ide:build`. Started by the API through dockerode (Phase 5 contract in CLAUDE.md).
#
# Runtime contract:
# - env DEVSPACE_CONNECTION_TOKEN (required): the connection token; the API proxy adds it.
# - env DEVSPACE_BASE_PATH (required): e.g. /ide/<copyId>; the server answers only under this path.
# - listens on 0.0.0.0:3000 and opens the folder /home/workspace (the copy, mounted by the API).
# - runs as any uid:gid; HOME is /tmp/devspace-home, created on start, so it is always writable.
# - works with all capabilities dropped and no-new-privileges.

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

COPY --chmod=0755 start.sh /usr/local/bin/devspace-ide-start

# HOME must not be the workspace (VS Code would write its data into the member's copy) and must be
# writable for whatever uid the API runs us as, so it lives under /tmp and is created on start.
ENV HOME=/tmp/devspace-home

WORKDIR /home/workspace
EXPOSE 3000

# Default user when run by hand; the API passes its own uid:gid.
USER 1000:1000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/devspace-ide-start"]
