#!/usr/bin/env python3
"""multi_replace.py: exact-text replacements across files, safely.

Replaces the throwaway "read file, assert the old text appears once, replace, write back" scripts.

    python local-deploy/tools/multi_replace.py SPEC [--dry-run]       SPEC is a file, or "-" for stdin

What it guarantees
  * every `old` must match exactly the expected number of times (default 1), or nothing is written
  * all-or-nothing across files: every edit is applied in memory first, files are written only if all succeed
  * line endings are kept: a CRLF file stays CRLF (you write \\n in `old` and `new`; matching ignores the EOL style)
  * a UTF-8 byte order mark is kept
  * control characters in `old`/`new` are refused. In JSON, "\\b" is a BACKSPACE, not a regex word boundary: write
    "\\\\b". That mistake silently corrupted two regexes once; the block format below needs no escaping at all.
  * a file with mixed line endings is refused rather than guessed at
  * edits to one file apply in order (the second sees the first's result); exit codes: 0 done, 1 refused (nothing
    written), 2 bad spec or unreadable file, 64 usage

Block format (no escaping; good with a quoted heredoc)

    python local-deploy/tools/multi_replace.py - <<'EOF'
    @@@ file MyDegreePlan_Frontend/src/lib/foo.js
    @@@ old
    const x = /\\bword\\b/
    @@@ new
    const x = /\\bnew\\b/
    @@@ old x2
    repeated text
    @@@ new
    replaced
    @@@ file MyDegreePlan_Prototype/other.mjs
    @@@ old xall
    every occurrence
    @@@ new
    all of them
    EOF

  `@@@ file PATH` starts a file (relative to the current directory). `@@@ old` / `@@@ new` take the text up to the next
  `@@@` line (the line break before it is not part of the text; an empty `new` deletes). `@@@ old xN` expects N matches,
  `@@@ old xall` replaces however many there are (at least one).

JSON format (a file whose first character is { or [)

    {"files": [{"path": "a.js", "edits": [{"old": "x", "new": "y"}, {"old": "z", "new": "w", "count": 2}]}]}
    ("count": "all" replaces every occurrence, at least one.)
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field

BOM = "﻿"
BAD_CONTROL = {c for c in map(chr, range(32)) if c not in "\t\n\r"}


class SpecError(Exception):
    pass


@dataclass
class Edit:
    old: str
    new: str
    count: object = 1  # int, or "all"
    where: str = ""


@dataclass
class FileEdits:
    path: str
    edits: list = field(default_factory=list)


# ── parsing ──────────────────────────────────────────────────────────────────

def parse_json(text: str) -> list:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise SpecError(f"spec is not valid JSON: {e}")
    files = data.get("files") if isinstance(data, dict) else data
    if not isinstance(files, list):
        raise SpecError('JSON spec must be {"files": [...]} or a list of files')
    out = []
    for i, f in enumerate(files, 1):
        if not isinstance(f, dict) or "path" not in f or not isinstance(f.get("edits"), list):
            raise SpecError(f'file #{i}: needs "path" and a list "edits"')
        fe = FileEdits(f["path"])
        for j, e in enumerate(f["edits"], 1):
            if not isinstance(e, dict) or not isinstance(e.get("old"), str) or not isinstance(e.get("new"), str):
                raise SpecError(f'{f["path"]} edit #{j}: needs string "old" and "new"')
            count = e.get("count", 1)
            if count != "all" and not (isinstance(count, int) and count >= 1):
                raise SpecError(f'{f["path"]} edit #{j}: count must be a positive integer or "all"')
            fe.edits.append(Edit(e["old"], e["new"], count, f'{f["path"]} edit #{j}'))
        out.append(fe)
    return out


def parse_blocks(text: str) -> list:
    out: list = []
    cur_file = None
    cur_edit = None      # the Edit being built
    target = None        # "old" or "new": which side lines are going to
    buf: list = []

    def flush(lineno):
        nonlocal buf
        if target is None:
            if any(line.strip() for line in buf):
                raise SpecError(f"line {lineno}: text outside an old/new block")
            buf = []
            return
        value = "\n".join(buf)
        setattr(cur_edit, target, value)
        buf = []

    lines = text.replace("\r\n", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    for n, line in enumerate(lines, 1):
        if not line.startswith("@@@"):
            buf.append(line)
            continue
        flush(n)
        parts = line[3:].strip().split(None, 1)
        directive = parts[0] if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        if directive == "file":
            if not rest:
                raise SpecError(f"line {n}: '@@@ file' needs a path")
            check_edit_complete(cur_edit, n)
            cur_file = FileEdits(rest)
            out.append(cur_file)
            cur_edit, target = None, None
        elif directive == "old":
            if cur_file is None:
                raise SpecError(f"line {n}: '@@@ old' before any '@@@ file'")
            check_edit_complete(cur_edit, n)
            count: object = 1
            if rest:
                if rest == "xall":
                    count = "all"
                elif rest.startswith("x") and rest[1:].isdigit() and int(rest[1:]) >= 1:
                    count = int(rest[1:])
                else:
                    raise SpecError(f"line {n}: '@@@ old' takes nothing, xN (N matches) or xall, not {rest!r}")
            cur_edit = Edit("", "", count, f"{cur_file.path} edit #{len(cur_file.edits) + 1} (line {n})")
            cur_file.edits.append(cur_edit)
            cur_edit._saw_new = False  # type: ignore[attr-defined]
            target = "old"
        elif directive == "new":
            if cur_edit is None or target != "old":
                raise SpecError(f"line {n}: '@@@ new' must follow an '@@@ old'")
            cur_edit._saw_new = True  # type: ignore[attr-defined]
            target = "new"
        else:
            raise SpecError(f"line {n}: unknown directive '@@@ {directive}'")
    flush(len(lines) + 1)
    check_edit_complete(cur_edit, len(lines) + 1)
    return out


def check_edit_complete(edit, lineno):
    if edit is not None and not getattr(edit, "_saw_new", True):
        raise SpecError(f"{edit.where}: no '@@@ new' after its '@@@ old' (before line {lineno})")


def parse_spec(text: str) -> list:
    stripped = text.lstrip(BOM).lstrip()
    files = parse_json(text.lstrip(BOM)) if stripped[:1] in "{[" else parse_blocks(text.lstrip(BOM))
    if not files:
        raise SpecError("the spec names no files")
    for f in files:
        if not f.edits:
            raise SpecError(f"{f.path}: no edits")
    return files


# ── applying ─────────────────────────────────────────────────────────────────

def control_chars(s: str) -> list:
    return sorted({repr(c) for c in s if c in BAD_CONTROL})


def apply_to_text(raw: str, edits: list, path: str, problems: list):
    """Returns the new text (original line endings and BOM kept) or None, appending to `problems`."""
    bom = raw.startswith(BOM)
    body = raw[1:] if bom else raw
    crlf = body.count("\r\n")
    lone_lf = body.count("\n") - crlf
    lone_cr = body.count("\r") - crlf
    if crlf and (lone_lf or lone_cr):
        problems.append(f"{path}: mixed line endings ({crlf} CRLF, {lone_lf} bare LF); fix the file's endings first")
        return None
    if lone_cr:
        problems.append(f"{path}: contains bare CR line endings; not supported")
        return None
    eol = "\r\n" if crlf else "\n"
    text = body.replace("\r\n", "\n") if crlf else body
    ok = True
    for e in edits:
        for side, value in (("old", e.old), ("new", e.new)):
            bad = control_chars(value)
            if bad:
                problems.append(f"{e.where}: '{side}' contains control character(s) {', '.join(bad)}. "
                                'In JSON "\\b" is a backspace: write "\\\\b" for a regex word boundary, or use the block format.')
                ok = False
        if not e.old:
            problems.append(f"{e.where}: 'old' is empty")
            ok = False
            continue
        if e.old == e.new:
            problems.append(f"{e.where}: 'old' and 'new' are identical")
            ok = False
            continue
        found = text.count(e.old)
        if e.count == "all":
            if found == 0:
                problems.append(f"{e.where}: expected at least one match, found 0")
                ok = False
                continue
        elif found != e.count:
            problems.append(f"{e.where}: expected {e.count} match{'es' if e.count != 1 else ''}, found {found}: {preview(e.old)}")
            ok = False
            continue
        if ok:
            text = text.replace(e.old, e.new)
    if not ok:
        return None
    if crlf:
        text = text.replace("\n", "\r\n")
    return (BOM if bom else "") + text


def preview(s: str) -> str:
    first = s.split("\n", 1)[0]
    return repr(first if len(first) <= 70 else first[:67] + "...")


def read_text(path: str) -> str:
    with open(path, "rb") as fh:
        data = fh.read()
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise SpecError(f"{path}: not valid UTF-8 ({e})")


def run(spec_text: str, dry_run: bool = False, out=print) -> int:
    files = parse_spec(spec_text)
    problems: list = []
    results = []
    seen = set()
    for f in files:
        key = os.path.normcase(os.path.abspath(f.path))
        if key in seen:
            problems.append(f"{f.path}: listed twice; put its edits under one '@@@ file'")
            continue
        seen.add(key)
        if not os.path.isfile(f.path):
            problems.append(f"{f.path}: no such file")
            continue
        raw = read_text(f.path)
        new = apply_to_text(raw, f.edits, f.path, problems)
        if new is not None:
            results.append((f, raw, new))
    if problems:
        out(f"multi_replace: nothing written; {len(problems)} problem(s):")
        for p in problems:
            out(f"  - {p}")
        return 1
    for f, raw, new in results:
        eol = "CRLF" if "\r\n" in raw else "LF"
        if raw == new:
            out(f"unchanged {f.path}")
            continue
        if not dry_run:
            with open(f.path, "wb") as fh:  # bytes: no newline translation
                fh.write(new.encode("utf-8"))
        out(f"{'would edit' if dry_run else 'edited'} {f.path} ({len(f.edits)} edit{'s' if len(f.edits) != 1 else ''}, {eol})")
    return 0


def main(argv: list) -> int:
    args = [a for a in argv if a != "--dry-run"]
    dry = len(args) != len(argv)
    if len(args) != 1 or args[0] in ("-h", "--help"):
        print(__doc__)
        return 64
    try:
        text = sys.stdin.buffer.read().decode("utf-8") if args[0] == "-" else read_text(args[0])
        return run(text, dry)
    except SpecError as e:
        print(f"multi_replace: {e}")
        return 2
    except OSError as e:
        print(f"multi_replace: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
