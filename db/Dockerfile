# syntax=docker/dockerfile:1
# Supabase's Postgres with the per-install role setup baked in. roles.sql runs once,
# when a data volume is first created, and reads the password from the container's
# POSTGRES_PASSWORD (set from .env), so nothing secret lives in the image.
# Build context is local-deploy/db/ (see docker-compose.yml).
FROM supabase/postgres:17.6.1.136

COPY roles.sql /docker-entrypoint-initdb.d/init-scripts/99-roles.sql
