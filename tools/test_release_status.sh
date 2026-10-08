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
esac
GH
chmod +x "$ROOT/bin/gh"

state() { printf '%s\t%s\t%s\n' "$1" "$2" "2026-10-08T20:33:22Z" > "$ROOT/state"; }
steps() { # name=result ...
  : > "$ROOT/steps"
  for kv in "$@"; do printf '%s\t%s\n' "${kv%%=*}" "${kv#*=}" >> "$ROOT/steps"; done
}
run() { OUT="$(PATH="$ROOT/bin:$PATH" FAKE_LOG="$ROOT/log" FAKE_STATE_FILE="$ROOT/state" FAKE_STEPS_FILE="$ROOT/steps" RELEASE_STATUS_POLL=0 bash "$SCRIPT" "$@" 2>&1)"; CODE=$?; }
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

echo "usage errors"
run --bogus;            check "an unknown flag is 64" '[ $CODE = 64 ]'
run --timeout;          check "--timeout without a number is 64" '[ $CODE = 64 ]'
run --timeout abc;      check "a non-numeric timeout is 64" '[ $CODE = 64 ]'
run 1 2;                check "two run ids is 64" '[ $CODE = 64 ]'

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
