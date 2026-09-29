#!/bin/sh
# mdp-setup sql   apply every /setup/sql/*.sql to the local Postgres, in order
# mdp-setup seed  load the course catalog through the local API (seed.js)
set -eu

case "${1:-}" in
  sql)
    export PGPASSWORD="$POSTGRES_PASSWORD"
    for f in /setup/sql/*.sql; do
      echo "applying $(basename "$f")"
      psql -h db -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction -q -f "$f"
    done
    ;;
  seed)
    cd /setup
    exec node seed.js
    ;;
  *)
    echo "usage: mdp-setup sql|seed" >&2
    exit 64
    ;;
esac
