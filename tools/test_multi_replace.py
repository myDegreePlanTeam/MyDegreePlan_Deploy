"""Tests for multi_replace.py. Run: python -m unittest local-deploy/tools/test_multi_replace.py  (from the MDP folder)"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import multi_replace as mr  # noqa: E402

BS = chr(8)       # backspace: what "\b" means in JSON
BACKSLASH = chr(92)


class Case(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="mr_")
        self.log = []

    def put(self, name, data: bytes) -> str:
        p = os.path.join(self.dir, name)
        with open(p, "wb") as fh:
            fh.write(data)
        return p

    def get(self, path) -> bytes:
        with open(path, "rb") as fh:
            return fh.read()

    def run_blocks(self, text, dry=False):
        return mr.run(text, dry, out=self.log.append)

    def run_json(self, obj, dry=False):
        return mr.run(json.dumps(obj), dry, out=self.log.append)


class Replacing(Case):
    def test_lf_file_is_edited_in_place(self):
        p = self.put("a.js", b"one\ntwo\nthree\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\ntwo\n@@@ new\n2\n"), 0)
        self.assertEqual(self.get(p), b"one\n2\nthree\n")

    def test_crlf_is_kept_and_old_is_written_with_plain_newlines(self):
        p = self.put("a.js", b"one\r\ntwo\r\nthree\r\n")
        spec = f"@@@ file {p}\n@@@ old\none\ntwo\n@@@ new\nuno\ndos\ntres\n"
        self.assertEqual(self.run_blocks(spec), 0)
        self.assertEqual(self.get(p), b"uno\r\ndos\r\ntres\r\nthree\r\n")
        self.assertIn("CRLF", self.log[-1])

    def test_bom_is_kept(self):
        p = self.put("a.json", b"\xef\xbb\xbf{\"a\": 1}\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\n\"a\": 1\n@@@ new\n\"a\": 2\n"), 0)
        self.assertEqual(self.get(p), b"\xef\xbb\xbf{\"a\": 2}\n")

    def test_utf8_text_survives(self):
        p = self.put("a.md", "café → x\n".encode("utf-8"))
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\nx\n@@@ new\ny\n"), 0)
        self.assertEqual(self.get(p).decode("utf-8"), "café → y\n")

    def test_empty_new_deletes(self):
        p = self.put("a.txt", b"keep\ndrop\nkeep2\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\ndrop\n@@@ new\n"), 0)
        self.assertEqual(self.get(p), b"keep\n\nkeep2\n")

    def test_edits_apply_in_order_within_a_file(self):
        p = self.put("a.txt", b"a\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\na\n@@@ new\nb\n@@@ old\nb\n@@@ new\nc\n"), 0)
        self.assertEqual(self.get(p), b"c\n")

    def test_several_files(self):
        a, b = self.put("a.txt", b"x\n"), self.put("b.txt", b"x\r\n")
        self.assertEqual(self.run_blocks(f"@@@ file {a}\n@@@ old\nx\n@@@ new\ny\n@@@ file {b}\n@@@ old\nx\n@@@ new\nz\n"), 0)
        self.assertEqual((self.get(a), self.get(b)), (b"y\n", b"z\r\n"))

    def test_dry_run_writes_nothing(self):
        p = self.put("a.txt", b"x\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\nx\n@@@ new\ny\n", dry=True), 0)
        self.assertEqual(self.get(p), b"x\n")
        self.assertIn("would edit", self.log[-1])

    def test_blocks_need_no_escaping(self):
        p = self.put("a.js", b"const r = /x/\n")
        spec = f"@@@ file {p}\n@@@ old\n/x/\n@@@ new\n/{BACKSLASH}bword{BACKSLASH}b/\n"
        self.assertEqual(self.run_blocks(spec), 0)
        self.assertEqual(self.get(p), b"const r = /" + b"\\bword\\b" + b"/\n")


class Counting(Case):
    def test_no_match_is_an_error_and_names_the_text(self):
        p = self.put("a.txt", b"x\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\nnope\n@@@ new\ny\n"), 1)
        self.assertTrue(any("expected 1 match, found 0" in line and "nope" in line for line in self.log))

    def test_two_matches_for_a_single_edit_is_an_error(self):
        p = self.put("a.txt", b"x\nx\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\nx\n@@@ new\ny\n"), 1)
        self.assertEqual(self.get(p), b"x\nx\n")

    def test_xN_and_xall(self):
        p = self.put("a.txt", b"x\nx\nx\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old x3\nx\n@@@ new\ny\n"), 0)
        self.assertEqual(self.get(p), b"y\ny\ny\n")
        q = self.put("b.txt", b"x\nx\n")
        self.assertEqual(self.run_blocks(f"@@@ file {q}\n@@@ old xall\nx\n@@@ new\nz\n"), 0)
        self.assertEqual(self.get(q), b"z\nz\n")
        self.assertEqual(self.run_blocks(f"@@@ file {q}\n@@@ old xall\nnone\n@@@ new\nz\n"), 1)
        self.assertEqual(self.run_blocks(f"@@@ file {q}\n@@@ old x2\nz\n@@@ new\nw\n"), 0)

    def test_nothing_is_written_when_any_edit_fails(self):
        a, b = self.put("a.txt", b"x\n"), self.put("b.txt", b"y\n")
        spec = f"@@@ file {a}\n@@@ old\nx\n@@@ new\nchanged\n@@@ file {b}\n@@@ old\nmissing\n@@@ new\nz\n"
        self.assertEqual(self.run_blocks(spec), 1)
        self.assertEqual((self.get(a), self.get(b)), (b"x\n", b"y\n"), "the first file must not be written either")
        self.assertIn("nothing written", self.log[0])

    def test_every_problem_is_reported_not_just_the_first(self):
        a = self.put("a.txt", b"x\n")
        spec = f"@@@ file {a}\n@@@ old\nm1\n@@@ new\nz\n@@@ old\nm2\n@@@ new\nz\n@@@ file {os.path.join(self.dir, 'gone.txt')}\n@@@ old\nq\n@@@ new\nr\n"
        self.assertEqual(self.run_blocks(spec), 1)
        self.assertEqual(len([line for line in self.log if line.startswith("  - ")]), 3)

    def test_missing_file(self):
        self.assertEqual(self.run_blocks(f"@@@ file {os.path.join(self.dir, 'nope.txt')}\n@@@ old\nx\n@@@ new\ny\n"), 1)
        self.assertTrue(any("no such file" in line for line in self.log))

    def test_old_equal_new_and_empty_old_are_mistakes(self):
        p = self.put("a.txt", b"x\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\nx\n@@@ new\nx\n"), 1)
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\n@@@ new\nx\n"), 1)

    def test_a_file_listed_twice_is_refused(self):
        p = self.put("a.txt", b"x\ny\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\nx\n@@@ new\n1\n@@@ file {p}\n@@@ old\ny\n@@@ new\n2\n"), 1)
        self.assertEqual(self.get(p), b"x\ny\n")


class Refusing(Case):
    def test_mixed_line_endings(self):
        p = self.put("a.txt", b"a\r\nb\nc\r\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\nb\n@@@ new\nB\n"), 1)
        self.assertTrue(any("mixed line endings" in line for line in self.log))
        self.assertEqual(self.get(p), b"a\r\nb\nc\r\n")

    def test_json_backspace_is_caught(self):
        """A JSON "\\b" decodes to a backspace; that is how two regexes were once corrupted."""
        p = self.put("a.js", b"const r = /x/\n")
        self.assertEqual(self.run_blocks(f'{{"files":[{{"path":{json.dumps(p)},"edits":[{{"old":"/x/","new":"/\\bword\\b/"}}]}}]}}'), 1)
        self.assertTrue(any("backspace" in line and "\\\\b" in line for line in self.log))
        self.assertEqual(self.get(p), b"const r = /x/\n")

    def test_control_characters_in_old_are_caught_too(self):
        p = self.put("a.txt", b"x\n")
        self.assertEqual(self.run_json({"files": [{"path": p, "edits": [{"old": "x" + BS, "new": "y"}]}]}), 1)

    def test_json_escaped_backslash_is_fine(self):
        p = self.put("a.js", b"const r = /x/\n")
        self.assertEqual(self.run_json({"files": [{"path": p, "edits": [{"old": "/x/", "new": "/" + BACKSLASH + "bword" + BACKSLASH + "b/"}]}]}), 0)
        self.assertEqual(self.get(p), b"const r = /\\bword\\b/\n")

    def test_not_utf8(self):
        p = self.put("a.bin", b"\xff\xfe\x00bad")
        with self.assertRaises(mr.SpecError):
            self.run_blocks(f"@@@ file {p}\n@@@ old\nx\n@@@ new\ny\n")


class Parsing(Case):
    def test_json_format_with_counts(self):
        p = self.put("a.txt", b"x\nx\nq\n")
        self.assertEqual(self.run_json({"files": [{"path": p, "edits": [{"old": "x", "new": "y", "count": 2}, {"old": "q", "new": "r", "count": "all"}]}]}), 0)
        self.assertEqual(self.get(p), b"y\ny\nr\n")

    def test_json_list_form_and_bad_shapes(self):
        p = self.put("a.txt", b"x\n")
        self.assertEqual(self.run_json([{"path": p, "edits": [{"old": "x", "new": "y"}]}]), 0)
        for bad in ('{"files": 3}', '{"files": [{"path": "a"}]}', '{"files": [{"path": "a", "edits": [{"old": 1, "new": "b"}]}]}',
                    '{"files": [{"path": "a", "edits": [{"old": "a", "new": "b", "count": 0}]}]}', '{not json'):
            with self.assertRaises(mr.SpecError, msg=bad):
                mr.parse_spec(bad)

    def test_block_errors(self):
        for bad, why in [
            ("@@@ old\nx\n@@@ new\ny\n", "old before file"),
            ("@@@ file a\n@@@ new\ny\n", "new without old"),
            ("@@@ file a\n@@@ old\nx\n", "old without new"),
            ("@@@ file a\n@@@ old\nx\n@@@ old\ny\n@@@ new\nz\n", "second old before new"),
            ("@@@ file a\n@@@ old x0\nx\n@@@ new\ny\n", "bad count"),
            ("@@@ file a\n@@@ bogus\n", "unknown directive"),
            ("stray text\n@@@ file a\n", "text outside a block"),
            ("@@@ file\n", "file without a path"),
            ("", "empty"),
            ("@@@ file a\n", "file without edits"),
        ]:
            with self.assertRaises(mr.SpecError, msg=why):
                mr.parse_spec(bad)

    def test_blank_lines_inside_blocks_are_kept(self):
        p = self.put("a.txt", b"a\n\nb\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\na\n\nb\n@@@ new\nA\n\n\nB\n"), 0)
        self.assertEqual(self.get(p), b"A\n\n\nB\n")

    def test_a_trailing_newline_in_old_is_written_as_an_empty_line(self):
        p = self.put("a.txt", b"a\nb\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\n@@@ old\na\n\n@@@ new\nz\n"), 0)   # old is "a\n"
        self.assertEqual(self.get(p), b"zb\n")

    def test_a_crlf_spec_is_read_the_same(self):
        p = self.put("a.txt", b"x\n")
        self.assertEqual(self.run_blocks(f"@@@ file {p}\r\n@@@ old\r\nx\r\n@@@ new\r\ny\r\n"), 0)
        self.assertEqual(self.get(p), b"y\n")


class CommandLine(Case):
    def test_spec_file_and_exit_codes(self):
        p = self.put("a.txt", b"x\n")
        spec = self.put("spec.txt", f"@@@ file {p}\n@@@ old\nx\n@@@ new\ny\n".encode())
        self.assertEqual(mr.main([spec]), 0)
        self.assertEqual(self.get(p), b"y\n")
        self.assertEqual(mr.main([spec]), 1, "the old text is gone now")
        self.assertEqual(mr.main(["--dry-run", spec]), 1, "still refused: dry run does not hide a bad edit")
        self.assertEqual(mr.main([os.path.join(self.dir, "none.txt")]), 2, "a missing spec file is a clean error, not a traceback")
        self.assertEqual(mr.main(["--help"]), 64)


if __name__ == "__main__":
    unittest.main()
