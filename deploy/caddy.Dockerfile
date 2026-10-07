# DevSpace's web server: Caddy with the Cloudflare DNS module (for the IDE's wildcard certificate),
# plus the web app's static files and deploy/Caddyfile.
#
# Built by deploy/compose.prod.yml, which passes the devspace-app image as the build context `app`
# (the web build is copied out of it, so the web app is built only once).

# Caddy 2.11.7 and caddy-dns/cloudflare v0.2.4, pinned (images by digest).
FROM caddy:2.11.7-builder-alpine@sha256:80331d37e7d4d230f186f2707079e279f32552924f101ee659e8cae9f9877c26 AS builder
RUN xcaddy build v2.11.7 --with github.com/caddy-dns/cloudflare@v0.2.4 \
    && /usr/bin/caddy list-modules | grep -q '^dns.providers.cloudflare$'

# The web build from the devspace-app image (named context `app`, see compose.prod.yml).
FROM app AS web

FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY --from=web /app/apps/web/dist /srv/web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
RUN caddy version && caddy list-modules | grep -q '^dns.providers.cloudflare$'
