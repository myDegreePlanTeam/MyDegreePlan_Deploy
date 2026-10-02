#!/usr/bin/env bash
# regen.sh: run the whole generated-data chain in order, then say which generated files changed and where to commit them.
#
#   bash local-deploy/tools/regen.sh [--check]
#
# The chain (about 3 s in all):
#   1. Prototype  node catalog/build_courses.mjs       catalog_raw.json + overrides  ->  courses.json
#   2. Prototype  node degree-specs/build.mjs          specs + pools + courses.json  ->  degree_plans.json
#   3. Frontend   npm run build:catalog                 courses + degree_plans + exams  ->  src/data/catalog*.json, pools.json
# Each step reads the one before it, so the order is fixed. A failing step stops the chain and prints the tail of its
# output; the files an earlier step already wrote are kept (so are the ones listed as changed).
#
# Default: runs the chain, prints one line per step, then per generated file "changed" or "unchanged" (a byte
# comparison with line endings ignored, not `git status`: with core.autocrlf the Frontend shows these files as modified
# when they are not), the diffstat per repo, and what to commit in which repo. Prototype first: the Frontend's catalog is
# built from the Prototype's files, so a Frontend commit must not land before the Prototype one.
# --check: the same chain, then put every generated file back as it was and exit 1 if any of them differed, i.e. a
#          committed generated file is stale. Leaves the working tree exactly as it found it.
#
# Not part of the chain: the scrape (`node catalog_scrape/scrape_catalog.mjs`: network, minutes, only when Coursedog changed).
# Writes nothing but the five generated files. Never commits, pushes or switches branch.
# MDP_ROOT overrides the workspace root (the tests use it).
set -u

usage() { echo "usage: bash local-deploy/tools/regen.sh [--check]" >&2; exit 64; }

CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    *) usage ;;
  esac
  shift
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MDP="${MDP_ROOT:-$(cd "$HERE/../.." && pwd)}"   # this file is MDP/local-deploy/tools/regen.sh
PROTO=MyDegreePlan_Prototype
FRONT=MyDegreePlan_Frontend

for r in "$PROTO" "$FRONT"; do
  [ -d "$MDP/$r" ] || { echo "regen: $MDP/$r not found (run from a workspace with the Frontend and Prototype checked out side by side)" >&2; exit 2; }
done

# repo:path of every file the chain writes, in chain order
FILES=(
  "$PROTO:courses.json"
  "$PROTO:degree_plans.json"
  "$FRONT:src/data/catalog.json"
  "$FRONT:src/data/catalog.descriptions.json"
  "$FRONT:src/data/pools.json"
)

SNAP="$(mktemp -d)"; trap 'rm -rf "$SNAP"' EXIT
snap_of() { echo "$SNAP/$(echo "$1" | tr '/:' '__')"; }
for f in "${FILES[@]}"; do
  src="$MDP/${f%%:*}/${f#*:}"
  if [ -f "$src" ]; then cp "$src" "$(snap_of "$f")"; else : > "$(snap_of "$f").missing"; fi
done

# $1 = label, $2 = repo, rest = command. Prints one line; on failure the tail of the output.
step() {
  local label="$1" repo="$2"; shift 2
  local log="$SNAP/step.log" t0=$SECONDS
  if (cd "$MDP/$repo" && "$@") > "$log" 2>&1; then
    echo "ok     $label ($((SECONDS - t0))s)"
  else
    echo "FAILED $label (exit $?), last lines:"
    tail -n 12 "$log" | sed 's/^/         /'
    return 1
  fi
}

same() { # $1 = snapshot, $2 = current file: equal once carriage returns are dropped
  cmp -s <(tr -d '\r' < "$1") <(tr -d '\r' < "$2")
}

FAILED=0
step "courses.json         (Prototype: node catalog/build_courses.mjs)" "$PROTO" node catalog/build_courses.mjs \
  && step "degree_plans.json     (Prototype: node degree-specs/build.mjs)" "$PROTO" node degree-specs/build.mjs \
  && step "catalog data          (Frontend: npm run build:catalog)" "$FRONT" npm run build:catalog --silent \
  || FAILED=1

CHANGED=(); CHANGED_REPOS=()
for f in "${FILES[@]}"; do
  repo="${f%%:*}"; path="${f#*:}"; cur="$MDP/$repo/$path"; s="$(snap_of "$f")"
  if [ -f "$s.missing" ]; then
    [ -f "$cur" ] && { CHANGED+=("$f"); echo "  new        $repo/$path"; }
  elif [ ! -f "$cur" ]; then
    CHANGED+=("$f"); echo "  deleted    $repo/$path"
  elif same "$s" "$cur"; then
    echo "  unchanged  $repo/$path"
  else
    CHANGED+=("$f"); echo "  CHANGED    $repo/$path"
  fi
done
for f in ${CHANGED[@]+"${CHANGED[@]}"}; do
  r="${f%%:*}"; case " ${CHANGED_REPOS[*]-} " in *" $r "*) ;; *) CHANGED_REPOS+=("$r") ;; esac
done

if [ "$CHECK" = 1 ]; then
  for f in "${FILES[@]}"; do
    dest="$MDP/${f%%:*}/${f#*:}"; s="$(snap_of "$f")"
    if [ -f "$s.missing" ]; then rm -f "$dest"; else cp "$s" "$dest"; fi
  done
  [ $FAILED = 1 ] && { echo "check: chain failed; generated files restored"; exit 1; }
  if [ ${#CHANGED[@]} -gt 0 ]; then
    echo "check: STALE. A committed generated file is not what the sources produce (restored to its committed state); run regen.sh without --check and commit the result."
    exit 1
  fi
  echo "check: ok, every generated file is current."
  exit 0
fi

[ $FAILED = 1 ] && { echo "regen: stopped at the failing step above."; exit 1; }
if [ ${#CHANGED[@]} -eq 0 ]; then echo "regen: nothing changed."; exit 0; fi

echo
for r in "${CHANGED_REPOS[@]}"; do
  files=(); for f in "${CHANGED[@]}"; do [ "${f%%:*}" = "$r" ] && files+=("${f#*:}"); done
  branch="$(git -C "$MDP/$r" branch --show-current 2>/dev/null)"
  stat="$(git -C "$MDP/$r" -c core.safecrlf=false diff --shortstat -- "${files[@]}" 2>/dev/null)"
  echo "$r (${branch:-no branch}):${stat:+ $stat}"
  echo "    git -C $r add ${files[*]}"
  case "$branch" in main|master) echo "    on $branch: make a branch first (git -C $r switch -c chore/regen-catalog)" ;; esac
done
echo "Commit $PROTO first. Then in $FRONT: npm run test, and commit src/data/ together."
