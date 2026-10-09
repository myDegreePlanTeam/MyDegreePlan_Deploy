#!/usr/bin/env bash
# Tests for release_status.sh: a fake `gh` on PATH. Run: bash local-deploy/tools/test_release_status.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/release_status.sh"
PASS=0; FAIL=0
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/bin"
TAB="$(printf '\t')"

ok()   { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [ -n "${2:-}" ] && echo "$2" | sed 's/^/         /'; }
check() { if eval "$2"; then ok "$1"; else fail "$1" "$OUT"; fi; }

# The fake prints what the script's -q templates would have produced. FAKE_STATE_FILE holds the run state and FAKE_STEPS_FILE
# the key steps; both are read on every call, so a test can change them between polls (FAKE_ADVANCE swaps in the next state).
cat > "$ROOT/bin/gh" <<'GH'
#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "repo view") echo "acme/deploy" ;;
  "run list") echo "${FAKE_LATEST:-4242}" ;;
  "run view")
    case "$*" in
      *"--json jobs"*) cat "$FAKE_STEPS_FILE" ;;
      *) if [ -n "${FAKE_ADVANCE:-}" ] && [ -f "$FAKE_ADVANCE" ]; then cp "$FAKE_ADVANCE" "$FAKE_STATE_FILE"; cp "$FAKE_ADVANCE.steps" "$FAKE_STEPS_FILE"; rm -f "$FAKE_ADVANCE"; fi
         cat "$FAKE_STATE_FILE" ;;
    esac ;;
  "release list") printf 'MyDegreePlan 0.6.1\tLatest\tv0.6.1\t2026-10-08T20:36:05Z\n' ;;
  "run download")
    [ -f "$FAKE_ROOT/no-artifact" ] && exit 1
    dir=""; while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir="$2"; shift; done
    mkdir -p "$dir"
    echo "PASS: no differences" > "$dir/report.txt"
    seq 1 200 | sed 's/^/line /' > "$dir/big.log"
    printf '\211PNG\r\n' > "$dir/shot.png"
    ;;
esac
GH
chmod +x "$ROOT/bin/gh"

state() { printf '%s\t%s\t%s\n' "$1" "$2" "2026-10-08T20:33:22Z" > "$ROOT/state"; }
steps() { # name=result ...
  : > "$ROOT/steps"
  for kv in "$@"; do printf '%s\t%s\n' "${kv%%=*}" "${kv#*=}" >> "$ROOT/steps"; done
}
run() { OUT="$(PATH="$ROOT/bin:$PATH" FAKE_ROOT="$ROOT" FAKE_LOG="$ROOT/log" FAKE_STATE_FILE="$ROOT/state" FAKE_STEPS_FILE="$ROOT/steps" RELEASE_STATUS_POLL=0 bash "$SCRIPT" "$@" 2>&1)"; CODE=$?; }
: > "$ROOT/log"

echo "published: Publish and Verify succeeded, the run still finishing its cleanup steps"
state in_progress ""
steps "Assemble and sign the release=success" "Publish=success" "Verify what students will download=success" "Notify the landing page=success"
run
check "exits 0" '[ $CODE = 0 ]'
check "says published and verified" 'echo "$OUT" | grep -q "published and verified"'
check "reads the latest run when no id is given" 'grep -q "run list" "$ROOT/log"'
check "names the run and the repository" 'echo "$OUT" | grep -q "release run 4242 in acme/deploy"'
check "lists the key steps" 'echo "$OUT" | grep -q "Verify what students will download *success"'
check "prints the latest release" 'echo "$OUT" | grep -q "latest release: MyDegreePlan 0.6.1 Latest v0.6.1"'

echo "a run id on the command line is used as given"
: > "$ROOT/log"; run 777
check "no run list call" '! grep -q "run list" "$ROOT/log"'
check "asks for run 777" 'grep -q "run view 777" "$ROOT/log"'

echo "still building: exit 2 without --wait"
state in_progress ""
steps "Assemble and sign the release=success" "Publish=in_progress"
run
check "exits 2" '[ $CODE = 2 ]'
check "says not finished" 'echo "$OUT" | grep -q "not finished yet"'
check "shows the step that is running" 'echo "$OUT" | grep -q "Publish *in_progress"'

echo "a failed key step: exit 1"
state in_progress ""
steps "Assemble and sign the release=success" "Publish=failure"
run
check "exits 1" '[ $CODE = 1 ]'
check "says failed and where to look" 'echo "$OUT" | grep -q "FAILED.*--log-failed"'

echo "a run that completed without success: exit 1"
state completed cancelled
steps "Assemble and sign the release=cancelled"
run
check "exits 1" '[ $CODE = 1 ]'

echo "a run that completed successfully but never published: exit 2 (not a verified release)"
state completed success
steps "Assemble and sign the release=success"
run
check "exits 2" '[ $CODE = 2 ]'

echo "--wait: polls until the release is published"
state in_progress ""
steps "Assemble and sign the release=success" "Publish=in_progress"
printf 'in_progress\t\t2026-10-08T20:33:22Z\n' > "$ROOT/next"
printf 'Assemble and sign the release\tsuccess\nPublish\tsuccess\nVerify what students will download\tsuccess\n' > "$ROOT/next.steps"
FAKE_ADVANCE="$ROOT/next" run --wait
check "exits 0 once published" '[ $CODE = 0 ]'
check "said so" 'echo "$OUT" | grep -q "published and verified"'

echo "--wait: gives up at the timeout"
state in_progress ""
steps "Assemble and sign the release=success" "Publish=in_progress"
run --wait --timeout 0
check "exits 2" '[ $CODE = 2 ]'
check "says it timed out" 'echo "$OUT" | grep -q "timed out waiting"'

echo "another repo and workflow: judged by the run and its jobs, no release line"
: > "$ROOT/log"
state completed success
steps "parity (web, Windows app)=success" "docs=success"
run --repo acme/frontend --workflow parity.yml
check "exits 0" '[ $CODE = 0 ]'
check "says passed" 'echo "$OUT" | grep -q "^passed"'
check "names the repo and calls it a run, not a release" 'echo "$OUT" | grep -q "^parity.yml run 4242 in acme/frontend"'
check "lists the jobs" 'echo "$OUT" | grep -q "parity (web, Windows app) *success"'
check "prints no latest release" '! echo "$OUT" | grep -q "latest release"'
check "asks for that workflow in that repo" 'grep -q "run list --repo acme/frontend --workflow parity.yml" "$ROOT/log"'
check "does not look up the repository" '! grep -q "repo view" "$ROOT/log"'

echo "another workflow still running: exit 2; one job failed: exit 1; completed red: exit 1"
state in_progress ""; steps "parity=in_progress"
run --repo acme/frontend --workflow parity.yml;       check "running is 2" '[ $CODE = 2 ]'
state in_progress ""; steps "parity=failure"
run --repo acme/frontend --workflow parity.yml;       check "a failed job is 1" '[ $CODE = 1 ]'
state completed failure; steps "parity=success"
run --repo acme/frontend --workflow parity.yml;       check "a red run is 1" '[ $CODE = 1 ]'

echo "--branch: the latest run on that branch"
: > "$ROOT/log"; state completed success; steps "parity=success"
run --repo acme/deploy --workflow parity.yml --branch fix/x
check "run list is limited to the branch" 'grep -q "run list .*--branch fix/x" "$ROOT/log"'

echo "--artifact: prints the report of a finished run, and says so when the run is still going"
state completed success; steps "parity=success"
: > "$ROOT/log"; run --repo acme/deploy --workflow parity.yml --artifact parity-all-platforms
check "downloads the named artifact" 'grep -q "run download 4242 --repo acme/deploy --name parity-all-platforms" "$ROOT/log"'
check "prints the text report" 'echo "$OUT" | grep -q "^--- report.txt" && echo "$OUT" | grep -q "PASS: no differences"'
check "cuts a long file at 80 lines" 'echo "$OUT" | grep -q "(200 lines, cut at 80)" && ! echo "$OUT" | grep -q "line 150"'
check "names a binary file without printing it" 'echo "$OUT" | grep -q "shot.png (binary"'
state in_progress ""; steps "parity=in_progress"
: > "$ROOT/log"; run --repo acme/deploy --workflow parity.yml --artifact parity-all-platforms
check "no download while running" '! grep -q "run download" "$ROOT/log" && echo "$OUT" | grep -q "run has not finished"'
state completed success; steps "parity=success"; touch "$ROOT/no-artifact"
run --repo acme/deploy --workflow parity.yml --artifact missing
check "a missing artifact is a message, not a changed exit code" '[ $CODE = 0 ] && echo "$OUT" | grep -q "could not be downloaded"'
rm -f "$ROOT/no-artifact"

echo "usage errors"
run --repo;             check "--repo without a value is 64" '[ $CODE = 64 ]'
run --repo nonsense;    check "a --repo without a slash is 64" '[ $CODE = 64 ]'
run abc;                check "a run id that is not a number is 64" '[ $CODE = 64 ]'
run --bogus;            check "an unknown flag is 64" '[ $CODE = 64 ]'
run --timeout;          check "--timeout without a number is 64" '[ $CODE = 64 ]'
run --timeout abc;      check "a non-numeric timeout is 64" '[ $CODE = 64 ]'
run 1 2;                check "two run ids is 64" '[ $CODE = 64 ]'

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
