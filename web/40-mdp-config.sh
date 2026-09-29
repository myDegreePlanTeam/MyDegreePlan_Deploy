#!/bin/sh
# Runs at container start (nginx image executes /docker-entrypoint.d/*.sh).
# Writes /config.js so the app gets this install's anon key without it being baked
# into the image. The API URL is simply whatever address the page was loaded from.
set -eu

: "${ANON_KEY:?ANON_KEY is not set - start the stack with mdp start so .env exists}"

cat > /usr/share/nginx/html/config.js <<EOF
window.__MDP_CONFIG__ = {
  supabaseUrl: window.location.origin,
  supabaseAnonKey: "${ANON_KEY}"
};
EOF
