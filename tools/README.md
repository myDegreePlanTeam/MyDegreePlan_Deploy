# tools

Small editing and release helpers for the MDP workspace (the three repos checked out side by side under `MDP/`). They are
not part of any image: no Dockerfile copies this folder. Run them from the `MDP/` folder.

| Tool | Use |
|---|---|
| `multi_replace.py` | Exact-text edits across files, all-or-nothing, CRLF and BOM kept, control characters refused. `python local-deploy/tools/multi_replace.py - <<'EOF'` with `@@@ file PATH` / `@@@ old` / `@@@ new` blocks; `--dry-run` previews. |
| `json_patch.mjs` | Structural JSON edits by path (`set`, `add`, `replace`, `remove`, `merge`, `test`; RFC 6901 pointers), same all-or-nothing and format-keeping guarantees. Refuses a file whose layout `JSON.stringify` would not reproduce, so use `multi_replace.py` for hand-formatted JSON. |
| `mdp_status.sh` | Read-only snapshot of every repo under `MDP/` in about 30 lines: branch, +ahead/-behind `origin/main`, dirty files, the PR for the branch, and one verdict per other local branch (in main / merged with tip == PR head, so deletable / merged with commits beyond the PR / open / no PR). Never deletes or checks anything out; deletable branches are printed as a command to copy. `bash local-deploy/tools/mdp_status.sh [REPO...] [--no-fetch] [--no-gh] [--files N]`. |
| `finish_pr.sh` | Wait for CI, merge a PR, fast-forward local `main`, delete the PR's local branch only if its tip is the merged head. `bash local-deploy/tools/finish_pr.sh REPO PR [--method ...] [--wait N] [--delete-remote] [--dry-run]`. |

Release preflight is separate: `release-tools/preflight.sh` (see the README's "Shipping a release").

Tests (also run by CI): `node --test local-deploy/tools/test_json_patch.mjs`,
`python -m unittest local-deploy/tools/test_multi_replace.py`, `bash local-deploy/tools/test_finish_pr.sh`,
`bash local-deploy/tools/test_mdp_status.sh`.
