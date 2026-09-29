# syntax=docker/dockerfile:1
# One-shot "setup" image: applies the SQL schema/data, then runs the project's
# existing seed.js against the local API. Build context is the MDP workspace root
# (see docker-compose.yml) so it can copy from MyDegreePlan_Prototype/.
FROM node:22-alpine

RUN apk add --no-cache postgresql-client

WORKDIR /setup

COPY MyDegreePlan_Prototype/package.json MyDegreePlan_Prototype/package-lock.json ./
RUN npm ci --omit=dev

# Seed script + catalog data (single source of truth stays in MyDegreePlan_Prototype).
COPY MyDegreePlan_Prototype/seed.js MyDegreePlan_Prototype/slotSync.js MyDegreePlan_Prototype/prototype.json ./
COPY MyDegreePlan_Prototype/csc_core.json MyDegreePlan_Prototype/csc_cybersecurity.json \
     MyDegreePlan_Prototype/csc_dsai.json MyDegreePlan_Prototype/csc_hpc.json ./

# SQL applied in filename order. 010/020 are the project's own files, copied as-is:
#   - MATH1000 is not in prototype.json, so the seed script never inserts it
#   - test_equivalencies.sql is a clean delete-and-reinsert (safe to re-run)
COPY local-deploy/setup/sql/ ./sql/
COPY MyDegreePlan_Prototype/migration_math1000.sql  ./sql/010_math1000.sql
COPY MyDegreePlan_Prototype/test_equivalencies.sql  ./sql/020_test_equivalencies.sql

COPY --chmod=755 local-deploy/setup/run.sh /usr/local/bin/mdp-setup
RUN sed -i 's/\r$//' /usr/local/bin/mdp-setup

ENTRYPOINT ["mdp-setup"]
