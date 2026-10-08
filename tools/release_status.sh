#!/usr/bin/env bash
# release_status.sh: where a Release run stands, in one call. The half of the release after `gh workflow run release.yml`.
#
#   bash local-deploy/tools/release_status.sh [RUN_ID] [--wait] [--timeout SECONDS]
#
#   RUN_ID     the Release workflow run to read; default: the latest run of release.yml
#   --wait     poll every 10 s until the release is published and verified, the run fails, or the timeout (default 900 s).
#              Run it in the background (run_in_background) or with a long tool timeout: a release takes about 4 to 5 minutes
#
# Prints the run's status, the steps that matter (Assemble and sign, Publish, Verify what students will download, Notify the
# landing page) and the latest GitHub release. Done by hand this was a gh run list, a gh run watch (backgrounded by the tool),
# a gh release view with a field that does not exist and a gh release list, twice in one session (retro 2026-10-08).
#
# "Published" means the Publish and Verify steps succeeded. The run keeps going for a minute or so after that (the "Post Run"
# cleanup steps), which is not a reason to wait.
#
# Exit codes: 0 published and verified; 1 the run or one of those steps failed; 2 not finished (without --wait, or --wait ran
# out of time); 64 usage.
#
# Needs: gh (logged in). MDP_ROOT is unused; the repo comes from this folder's git remote.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN=""; WAIT=0; TIMEOUT=900; POLL="${RELEASE_STATUS_POLL:-10}"
usage() { echo "usage: bash local-deploy/tools/release_status.sh [RUN_ID] [--wait] [--timeout SECONDS]" >&2; exit 64; }
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT=1 ;;
    --timeout) [ $# -ge 2 ] || usage; TIMEOUT="$2"; shift ;;
    -*) usage ;;
    *) [ -z "$RUN" ] || usage; RUN="$1" ;;
  esac
  shift
done
case "$TIMEOUT" in ''|*[!0-9]*) usage ;; esac

REPO="$(cd "$HERE" && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"
[ -n "$REPO" ] || { echo "release_status: cannot read the repository (is gh logged in, and is this folder a clone?)" >&2; exit 1; }

if [ -z "$RUN" ]; then
  RUN="$(gh run list --repo "$REPO" --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null)"
  [ -n "$RUN" ] || { echo "release_status: no Release run found in $REPO" >&2; exit 1; }
fi

KEY_STEPS='^(Assemble and sign the release|Publish|Verify what students will download|Notify the landing page)$'

snapshot() {
  RUN_STATE="$(gh run view "$RUN" --repo "$REPO" --json status,conclusion,createdAt -q '[.status, (.conclusion // ""), .createdAt] | @tsv' 2>/dev/null)"
  STEPS="$(gh run view "$RUN" --repo "$REPO" --json jobs -q ".jobs[].steps[] | select(.name | test(\"$KEY_STEPS\")) | [.name, (.conclusion // .status)] | @tsv" 2>/dev/null)"
}

# 0 published and verified, 1 failed, 2 not finished
verdict() {
  local status conclusion
  status="$(printf '%s' "$RUN_STATE" | cut -f1)"; conclusion="$(printf '%s' "$RUN_STATE" | cut -f2)"
  if printf '%s\n' "$STEPS" | awk -F'\t' '$2 == "failure" || $2 == "cancelled"' | grep -q .; then return 1; fi
  if [ "$status" = completed ] && [ "$conclusion" != success ]; then return 1; fi
  local pub ver
  pub="$(printf '%s\n' "$STEPS" | awk -F'\t' '$1 == "Publish" { print $2 }')"
  ver="$(printf '%s\n' "$STEPS" | awk -F'\t' '$1 == "Verify what students will download" { print $2 }')"
  if [ "$pub" = success ] && [ "$ver" = success ]; then return 0; fi
  return 2
}

START=$SECONDS
while :; do
  snapshot
  verdict; V=$?
  [ "$V" = 2 ] && [ "$WAIT" = 1 ] && [ $((SECONDS - START)) -lt "$TIMEOUT" ] || break
  sleep "$POLL"
done

if [ -z "$RUN_STATE" ]; then echo "release_status: cannot read run $RUN in $REPO" >&2; exit 1; fi
echo "release run $RUN in $REPO: $(printf '%s' "$RUN_STATE" | cut -f1) $(printf '%s' "$RUN_STATE" | cut -f2) (started $(printf '%s' "$RUN_STATE" | cut -f3))"
printf '%s\n' "$STEPS" | awk -F'\t' 'NF { printf "  %-40s %s\n", $1, $2 }'
echo "latest release: $(gh release list --repo "$REPO" --limit 1 2>/dev/null | head -1 | tr '\t' ' ')"
case "$V" in
  0) echo "published and verified" ;;
  1) echo "FAILED: the run or a key step did not succeed (gh run view $RUN --repo $REPO --log-failed)" ;;
  *) echo "not finished yet$([ "$WAIT" = 1 ] && echo ' (timed out waiting)')" ;;
esac
exit "$V"
