#!/usr/bin/env bash
# release_status.sh: where a GitHub Actions run stands, in one call. Made for the Deploy repo's Release workflow (the half of
# the release after `gh workflow run release.yml`), and now works for any repo and workflow.
#
#   bash local-deploy/tools/release_status.sh [RUN_ID] [--repo OWNER/NAME] [--workflow FILE] [--branch BRANCH]
#                                             [--artifact NAME] [--wait] [--timeout SECONDS]
#
#   RUN_ID       the run to read; default: the latest run of the workflow (on --branch, when given)
#   --repo       OWNER/NAME of the repository; default: the one this folder's git remote names (the Deploy repo)
#   --workflow   the workflow file; default release.yml
#   --branch     only runs on this branch when looking for the latest run (a parity run dispatched with frontend_ref=<branch>)
#   --artifact   when the run has finished, download this artifact and print the text files in it (each cut at 80 lines)
#   --wait       poll every 10 s until the run is done, fails, or the timeout (default 900 s). Run it in the background
#                (run_in_background) or with a long tool timeout: a release takes about 4 to 5 minutes, a parity run about 8
#
# Release mode (workflow release.yml in the Deploy repo, the default): prints the run's status, the steps that matter (Assemble
# and sign, Publish, Verify what students will download, Notify the landing page) and the latest GitHub release. "Published"
# means the Publish and Verify steps succeeded; the run keeps going for a minute or so after that (the "Post Run" cleanup
# steps), which is not a reason to wait.
#
# Any other workflow: prints the run's status and one line per job; done is the run's conclusion (success = exit 0).
#
# Done by hand this was a gh run list, a gh run watch (backgrounded by the tool), a gh run view with a field that does not exist
# and a gh release list, about 15 hand-written poll loops in one session (retro 2026-10-08 and 2026-10-09).
#
# Exit codes: 0 done and good; 1 the run or a key step failed; 2 not finished (without --wait, or --wait ran out of time);
# 64 usage.
#
# Needs: gh (logged in). MDP_ROOT is unused.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN=""; WAIT=0; TIMEOUT=900; POLL="${RELEASE_STATUS_POLL:-10}"; REPO=""; WORKFLOW=release.yml; BRANCH=""; ARTIFACT=""
usage() { echo "usage: bash local-deploy/tools/release_status.sh [RUN_ID] [--repo OWNER/NAME] [--workflow FILE] [--branch BRANCH] [--artifact NAME] [--wait] [--timeout SECONDS]" >&2; exit 64; }
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT=1 ;;
    --timeout) [ $# -ge 2 ] || usage; TIMEOUT="$2"; shift ;;
    --repo) [ $# -ge 2 ] || usage; REPO="$2"; shift ;;
    --workflow) [ $# -ge 2 ] || usage; WORKFLOW="$2"; shift ;;
    --branch) [ $# -ge 2 ] || usage; BRANCH="$2"; shift ;;
    --artifact) [ $# -ge 2 ] || usage; ARTIFACT="$2"; shift ;;
    -*) usage ;;
    *) [ -z "$RUN" ] || usage; RUN="$1" ;;
  esac
  shift
done
case "$TIMEOUT" in ''|*[!0-9]*) usage ;; esac
case "$RUN" in *[!0-9]*) usage ;; esac
case "$REPO" in ''|*/*) ;; *) usage ;; esac

if [ -z "$REPO" ]; then
  REPO="$(cd "$HERE" && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"
  [ -n "$REPO" ] || { echo "release_status: cannot read the repository (is gh logged in, and is this folder a clone? or pass --repo OWNER/NAME)" >&2; exit 1; }
fi

if [ -z "$RUN" ]; then
  if [ -n "$BRANCH" ]; then RUN="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null)"
  else RUN="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null)"; fi
  [ -n "$RUN" ] || { echo "release_status: no run of $WORKFLOW found in $REPO${BRANCH:+ on $BRANCH}" >&2; exit 1; }
fi

# Release mode: the Deploy repo's release workflow, judged by its Publish and Verify steps. Everything else: judged by the run.
RELEASE_MODE=0; [ "$WORKFLOW" = release.yml ] && RELEASE_MODE=1
KEY_STEPS='^(Assemble and sign the release|Publish|Verify what students will download|Notify the landing page)$'

snapshot() {
  RUN_STATE="$(gh run view "$RUN" --repo "$REPO" --json status,conclusion,createdAt -q '[.status, (.conclusion // ""), .createdAt] | @tsv' 2>/dev/null)"
  if [ "$RELEASE_MODE" = 1 ]; then
    STEPS="$(gh run view "$RUN" --repo "$REPO" --json jobs -q ".jobs[].steps[] | select(.name | test(\"$KEY_STEPS\")) | [.name, (.conclusion // .status)] | @tsv" 2>/dev/null)"
  else
    STEPS="$(gh run view "$RUN" --repo "$REPO" --json jobs -q '.jobs[] | [.name, (.conclusion // .status)] | @tsv' 2>/dev/null)"
  fi
}

# 0 done and good, 1 failed, 2 not finished
verdict() {
  local status conclusion
  status="$(printf '%s' "$RUN_STATE" | cut -f1)"; conclusion="$(printf '%s' "$RUN_STATE" | cut -f2)"
  if printf '%s\n' "$STEPS" | awk -F'\t' '$2 == "failure" || $2 == "cancelled"' | grep -q .; then return 1; fi
  if [ "$status" = completed ] && [ "$conclusion" != success ]; then return 1; fi
  if [ "$RELEASE_MODE" = 1 ]; then
    local pub ver
    pub="$(printf '%s\n' "$STEPS" | awk -F'\t' '$1 == "Publish" { print $2 }')"
    ver="$(printf '%s\n' "$STEPS" | awk -F'\t' '$1 == "Verify what students will download" { print $2 }')"
    if [ "$pub" = success ] && [ "$ver" = success ]; then return 0; fi
    return 2
  fi
  [ "$status" = completed ] && return 0
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
LABEL="$WORKFLOW"; [ "$RELEASE_MODE" = 1 ] && LABEL=release
echo "$LABEL run $RUN in $REPO: $(printf '%s' "$RUN_STATE" | cut -f1) $(printf '%s' "$RUN_STATE" | cut -f2) (started $(printf '%s' "$RUN_STATE" | cut -f3))"
printf '%s\n' "$STEPS" | awk -F'\t' 'NF { printf "  %-40s %s\n", $1, $2 }'
if [ "$RELEASE_MODE" = 1 ]; then echo "latest release: $(gh release list --repo "$REPO" --limit 1 2>/dev/null | head -1 | tr '\t' ' ')"; fi
case "$V" in
  0) if [ "$RELEASE_MODE" = 1 ]; then echo "published and verified"; else echo "passed"; fi ;;
  1) echo "FAILED: the run or a key step did not succeed (gh run view $RUN --repo $REPO --log-failed)" ;;
  *) echo "not finished yet$([ "$WAIT" = 1 ] && echo ' (timed out waiting)')" ;;
esac

# --artifact: the report a finished run uploaded (the parity run's JSON and text), printed instead of a download-and-cat by hand
if [ -n "$ARTIFACT" ]; then
  if [ "$V" = 2 ]; then echo "artifact $ARTIFACT: the run has not finished, nothing to download yet"
  else
    DL="$(mktemp -d)"
    if gh run download "$RUN" --repo "$REPO" --name "$ARTIFACT" --dir "$DL" >/dev/null 2>&1; then
      echo "artifact $ARTIFACT:"
      find "$DL" -type f | sort | head -20 | while IFS= read -r f; do
        case "$f" in
          *.json|*.txt|*.md|*.log|*.yml|*.yaml|*.tsv|*.csv)
            echo "--- ${f#"$DL"/}"; head -80 "$f"; [ "$(wc -l < "$f")" -gt 80 ] && echo "... ($(wc -l < "$f") lines, cut at 80)" ;;
          *) echo "--- ${f#"$DL"/} (binary, $(wc -c < "$f") bytes)" ;;
        esac
      done
    else echo "artifact $ARTIFACT: could not be downloaded (gh run download $RUN --repo $REPO --name $ARTIFACT)"; fi
    rm -rf "$DL"
  fi
fi
exit "$V"
