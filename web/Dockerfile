# syntax=docker/dockerfile:1
# Builds the React app and serves it with nginx, which also reverse-proxies
# /rest/v1 -> PostgREST and /auth/v1 -> GoTrue so supabase-js works unchanged and
# the browser only ever talks to one same-origin address.
# Build context is the MDP workspace root (see docker-compose.yml).

# Runs on the builder's own CPU even for a multi-arch build: the output is plain JS/CSS.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app

COPY MyDegreePlan_Frontend/package.json MyDegreePlan_Frontend/package-lock.json ./
RUN npm ci

# .env / .env.local are excluded by Dockerfile.dockerignore: they hold the hosted
# Supabase keys and must never end up in this image.
COPY MyDegreePlan_Frontend/ ./
COPY local-deploy/web/prepare-index.mjs /tmp/prepare-index.mjs
RUN node /tmp/prepare-index.mjs && npm run build


FROM nginx:1.27-alpine

RUN rm -f /etc/nginx/conf.d/default.conf
COPY local-deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 local-deploy/web/40-mdp-config.sh /docker-entrypoint.d/40-mdp-config.sh
RUN sed -i 's/\r$//' /docker-entrypoint.d/40-mdp-config.sh /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html
