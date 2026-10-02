#!/usr/bin/env bash
# Run before Actions -> Release -> Run workflow (or `gh workflow run release.yml`). It checks the things that have
# cost a release time before; it changes nothing and publishes nothing.
#
#   bash release-tools/preflight.sh [VERSION] [--skip-tests]
#
#   1. Frontend, Prototype and Deploy are each on a clean-enough main that equals origin/main. The workflow builds
#      origin/main (frontend_ref / prototype_ref default to it), so an unpushed commit is silently left out.
#   2. VERSION (if given) is not a release yet; otherwise prints the latest and a suggested next one. Versions are immutable.
#   3. No Release run is already queued, waiting for approval, or running. The workflow's concurrency group is `release`
#      with cancel-in-progress false, so one stale run (a duplicate dispatch, an approval nobody clicked) blocks every
#      later run until it is approved or cancelled (a stuck one held the lane for ~7 hours on 2026-10-01).
#   4. The Frontend tests pass in a fresh clone of origin/main with NO sibling MyDegreePlan_Prototype: exactly what the
#      workflow's `test` job does. Tests that read the Prototype must skip when it is absent. Renaming the local sibling
#      folder does not reproduce this (the path still resolves from a worktree); a fresh clone does.
#   5. The Prototype tests pass (`node --test`); the workflow does not run them.
#
# Needs: git, gh (logged in), node/npm. Exit 0 = nothing blocking; 1 = a check failed.
set -u

VERSION=""; SKIP_TESTS=0
for a in "$@"; do
  case "$a" in
    --skip-tests) SKIP_TESTS=1 ;;
    -*) echo "usage: bash release-tools/preflight.sh [VERSION] [--skip-tests]" >&2; exit 64 ;;
    *) VERSION="${a#v}" ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
MDP="$(cd "$DEPLOY/.." && pwd)"
FAILS=0
ok()   { echo "  ok    $*"; }
warn() { echo "  WARN  $*"; }
bad()  { echo "  FAIL  $*"; FAILS=$((FAILS + 1)); }

echo "1. Sources are pushed (the workflow builds origin/main)"
for repo in MyDegreePlan_Frontend MyDegreePlan_Prototype local-deploy; do
  dir="$MDP/$repo"
  if [ ! -d "$dir/.git" ]; then bad "$repo: not found at $dir"; continue; fi
  git -C "$dir" fetch -q origin 2>/dev/null || warn "$repo: fetch failed, comparing against the last fetch"
  branch="$(git -C "$dir" branch --show-current)"
  ahead="$(git -C "$dir" rev-list --count origin/main..HEAD 2>/dev/null || echo '?')"
  behind="$(git -C "$dir" rev-list --count HEAD..origin/main 2>/dev/null || echo '?')"
  if [ "$branch" != main ]; then warn "$repo: on '$branch', not main (the workflow still builds origin/main)"; fi
  if [ "$ahead" != 0 ]; then bad "$repo: $ahead commit(s) on '$branch' are not on origin/main, so they will not be released"
  elif [ "$behind" != 0 ]; then warn "$repo: $behind commit(s) on origin/main you do not have locally"
  else ok "$repo: $(git -C "$dir" rev-parse --short origin/main) = origin/main"; fi
  dirty="$(git -C "$dir" status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
  [ "$dirty" != 0 ] && warn "$repo: $dirty uncommitted change(s); they are not in the release"
done

echo "2. Version"
latest="$(cd "$DEPLOY" && gh release view --json tagName -q .tagName 2>/dev/null)"
if [ -z "$latest" ]; then warn "could not read the latest release (gh logged in?)"
else
  IFS=. read -r MA MI PA <<<"${latest#v}"
  echo "  latest is $latest; next patch would be $MA.$MI.$((PA + 1)), next minor $MA.$((MI + 1)).0"
  if [ -n "$VERSION" ]; then
    if (cd "$DEPLOY" && gh release view "v$VERSION" >/dev/null 2>&1); then bad "v$VERSION already exists; releases are immutable"
    else ok "v$VERSION is free"; fi
  fi
fi

echo "3. Release lane"
busy="$(cd "$DEPLOY" && for s in queued waiting in_progress; do gh run list --workflow release.yml --status "$s" --json databaseId,status,createdAt,headBranch -q '.[] | "\(.databaseId) \(.status) since \(.createdAt)"' 2>/dev/null; done)"
if [ -n "$busy" ]; then
  bad "a Release run is already holding the lane; a new one queues behind it until it is approved or cancelled:"
  echo "$busy" | sed 's/^/          /'
  echo "          cancel a stale one: gh run cancel <id> --repo myDegreePlanTeam/MyDegreePlan_Deploy"
else ok "no Release run is queued, waiting or running"; fi

if [ "$SKIP_TESTS" = 1 ]; then
  echo "4-5. Tests skipped (--skip-tests)"
else
  echo "4. Frontend tests in a fresh clone of origin/main, no Prototype sibling (what the workflow's test job runs)"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  if git clone -q --depth 1 "$(git -C "$MDP/MyDegreePlan_Frontend" remote get-url origin)" "$tmp/MyDegreePlan_Frontend" \
     && (cd "$tmp/MyDegreePlan_Frontend" && npm ci --silent --no-audit --no-fund && npm test --silent >"$tmp/frontend.log" 2>&1); then
    ok "$(grep -E 'Tests ' "$tmp/frontend.log" | tail -1 | sed 's/^ *//')"
  else
    bad "Frontend tests failed in a clean clone; last lines:"; tail -15 "$tmp/frontend.log" 2>/dev/null | sed 's/^/          /'
  fi
  echo "5. Prototype tests"
  if (cd "$MDP/MyDegreePlan_Prototype" && node --test >"$tmp/proto.log" 2>&1); then ok "$(grep -Eo 'pass [0-9]+' "$tmp/proto.log" | tail -1) (node --test)"
  else bad "Prototype tests failed; last lines:"; tail -15 "$tmp/proto.log" | sed 's/^/          /'; fi
fi

echo
if [ "$FAILS" = 0 ]; then
  echo "Nothing blocking. Release: gh workflow run release.yml --repo myDegreePlanTeam/MyDegreePlan_Deploy -f version=${VERSION:-X.Y.Z} -f notes='...' -f required=false"
  echo "Then approve the 'release' environment in Actions (the run sits at 'Waiting' until someone does) and read the run's summary."
  echo "To button-test the in-app Update, turn auto updates off on that install first; with them on it applies the release itself."
else
  echo "$FAILS check(s) failed; fix them before dispatching."
fi
[ "$FAILS" = 0 ]
