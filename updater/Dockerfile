# syntax=docker/dockerfile:1
# The updater. It is the only service that can reach the Docker socket, so it is kept
# tiny: no npm dependencies, no shell in any request path, and it acts only on
# releases signed by the key baked in below.
# Build context is local-deploy/updater/ (see docker-compose.yml).
FROM node:22-alpine

# docker-cli-compose: `docker compose` inside the container. openssl is not needed;
# signature checks use Node's own crypto.
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app
COPY package.json ./
COPY src/ ./src/

# Public half of the release signing key (see release-tools/keygen.mjs). Optional at
# build time: without it the updater starts but stays disabled, so a developer build
# can never apply a release. The glob keeps the COPY from failing when it is absent.
COPY release-signing.pub.pe[m] /app/

ENV NODE_ENV=production
USER root
ENTRYPOINT ["node", "src/main.js"]
