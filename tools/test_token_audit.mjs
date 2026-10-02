// Tests for token_audit.mjs: synthetic transcripts and a synthetic retro log in a temp dir.
// Run: node --test local-deploy/tools/test_token_audit.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'token_audit.mjs')
const root = mkdtempSync(join(tmpdir(), 'token-audit-'))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

let id = 0
const use = (ts, name, input) => ({ timestamp: ts, message: { content: [{ type: 'tool_use', id: `t${++id}`, name, input }] } })
const result = (ts, content) => ({ timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: `t${id}`, content }] } })
const jsonl = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n'
const pair = (ts, name, input, content) => [use(ts, name, input), result(ts, content)]

const dir = join(root, 'transcripts')
mkdirSync(dir)
writeFileSync(join(dir, 'a.jsonl'), jsonl([
  ...pair('2026-10-01T10:00:00Z', 'Bash', { command: 'git -C Repo status' }, 'x'.repeat(1000)),
  ...pair('2026-10-01T10:01:00Z', 'Bash', { command: 'cd /w && cat docs/claude/CLAUDE.md' }, 'x'.repeat(5000)),
  ...pair('2026-10-01T10:02:00Z', 'Bash', { command: "python - <<'EOF'\nprint(1)\nEOF" }, 'x'.repeat(200)),
  ...pair('2026-10-01T10:03:00Z', 'Read', { file_path: 'C:\\w\\docs\\claude\\CLAUDE.md' }, 'x'.repeat(3000)),
  ...pair('2026-10-01T10:04:00Z', 'Read', { file_path: 'C:\\w\\shot.png' }, [{ type: 'image', source: { data: 'A'.repeat(900000) } }]),
  ...pair('2026-10-01T10:05:00Z', 'Bash', { command: 'npm run test' }, 'x'.repeat(9000)),
]))
writeFileSync(join(dir, 'b.jsonl'), jsonl([
  ...pair('2026-10-03T09:00:00Z', 'Bash', { command: 'npx eslint .' }, 'x'.repeat(300)),
]))

const log = join(root, 'log.md')
writeFileSync(log, [
  '# Retro log',
  '2026-10-01 | t | repeated-step | wrote throwaway edit scripts | 2 turns | script: x | new',
  'FIXED | 2026-10-02 | match: throwaway edit|multi.?replace | tools/multi_replace.py',
  '2026-10-03 | t | repeated-step | wrote throwaway edit scripts again | 1 turn | script: x | REPEAT (first seen 2026-10-01)',
  '2026-10-03 | t | near-miss | something unrelated | 1 turn | test: y | new',
  'FIXED | 2026-10-03 | match: ([unclosed | broken pattern on purpose',
  '',
].join('\n'))
const metrics = join(root, 'metrics.tsv')

const audit = (...extra) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--log', log, '--metrics', metrics, '--repos', 'none', ...extra], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test('counts calls and result characters by category, with an image priced flat', () => {
  const { code, out } = audit()
  assert.equal(code, 0)
  assert.match(out, /sessions 2 {2}calls 7 /)
  // 1000 + 5000 + 200 + 3000 + 6000 (image) + 9000 + 300
  assert.match(out, /result chars 25k/)
  assert.match(out, /^git +1 +1\.0k/m)
  assert.match(out, /^tests +1 +9\.0k/m)
  assert.match(out, /^lint +1 +300/m)
  assert.match(out, /^edit-scripts +1 +200/m)
})

test('counts reading CLAUDE.md in full as redundant, by Bash cat and by the Read tool', () => {
  const { out } = audit()
  assert.match(out, /CLAUDE\.md read in full 2x \(8\.0k chars; it is already loaded\), 0 ranged/)
  assert.match(out, /results over 8k chars: 1\b/) // the 9,000-char test run; the image is flat 6,000
})

test('a ranged read of CLAUDE.md (sed -n, head, tail, a piped cat, Read with offset or limit) is not counted as redundant', () => {
  const dir2 = join(root, 'transcripts-ranged')
  mkdirSync(dir2)
  writeFileSync(join(dir2, 'r.jsonl'), jsonl([
    ...pair('2026-10-01T10:00:00Z', 'Bash', { command: 'cat docs/claude/CLAUDE.md' }, 'x'.repeat(5000)), // whole file: counted
    ...pair('2026-10-01T10:01:00Z', 'Read', { file_path: '/w/docs/claude/CLAUDE.md' }, 'x'.repeat(3000)), // whole file: counted
    ...pair('2026-10-01T10:02:00Z', 'Bash', { command: 'sed -n 1,20p docs/claude/CLAUDE.md' }, 'x'.repeat(400)),
    ...pair('2026-10-01T10:03:00Z', 'Bash', { command: 'cd /w && cat docs/claude/CLAUDE.md | head -30' }, 'x'.repeat(300)),
    ...pair('2026-10-01T10:04:00Z', 'Bash', { command: 'head -5 CLAUDE.md' }, 'x'.repeat(100)),
    ...pair('2026-10-01T10:05:00Z', 'Bash', { command: 'tail -n 20 docs/claude/CLAUDE.md' }, 'x'.repeat(200)),
    ...pair('2026-10-01T10:06:00Z', 'Read', { file_path: '/w/docs/claude/CLAUDE.md', offset: 100, limit: 40 }, 'x'.repeat(500)),
    ...pair('2026-10-01T10:07:00Z', 'Read', { file_path: '/w/docs/claude/CLAUDE.md', limit: 50 }, 'x'.repeat(200)),
    // writing a note that mentions CLAUDE.md is not reading it
    ...pair('2026-10-01T10:08:00Z', 'Bash', { command: "cat > memory/note.md <<'EOF'\nsee CLAUDE.md for the layout\nEOF" }, 'x'.repeat(10)),
  ]))
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir2, '--log', log, '--metrics', metrics, '--repos', 'none'], { encoding: 'utf8' })
  assert.match(r.stdout, /CLAUDE\.md read in full 2x \(8\.0k chars; it is already loaded\), 6 ranged lookup\(s\) \(fine\)/)
  assert.match(r.stdout, /^claude-md-read +2 +8\.0k/m)
  assert.match(r.stdout, /^file-reads +4 +/m) // the four ranged Bash lookups
  assert.match(r.stdout, /^Read tool +2 +700/m) // the two ranged Read calls
})

test('--since and --until window the calls by timestamp', () => {
  assert.match(audit('--since', '2026-10-03').out, /sessions 1 {2}calls 1 /)
  assert.match(audit('--until', '2026-10-03').out, /sessions 1 {2}calls 6 /)
  assert.match(audit('--since', '2026-10-01T10:02', '--until', '2026-10-01T10:04').out, /calls 2 /)
})

test('is read-only by default: no metrics file without --record', () => {
  audit()
  assert.equal(existsSync(metrics), false)
})

test('--record appends a header and a row, and the next run reports the change against it', () => {
  audit('--record', '--label', 'first')
  const first = readFileSync(metrics, 'utf8').trim().split('\n')
  assert.equal(first.length, 2)
  assert.match(first[0], /^date\tlabel\tsessions\tcalls\tresult_chars\tchars_per_session/)
  assert.match(first[1], /\tfirst\t2\t7\t24500\t12250\t/)
  const second = audit('--since', '2026-10-03', '--record', '--label', 'later')
  assert.match(second.out, /vs last row \(\d{4}-\d{2}-\d{2} first\): per session 12k -> 300 chars \(-98%\)/)
  assert.equal(readFileSync(metrics, 'utf8').trim().split('\n').length, 3)
})

test('--check-log reports a recurrence only for entries written after the FIXED line', () => {
  const { out } = audit('--check-log')
  assert.match(out, /fixed marker: 2 fixed, 1 recurrence/)
  assert.match(out, /RECURRED line 4: .*throwaway edit scripts again.*fixed 2026-10-02 by tools\/multi_replace\.py/)
  assert.doesNotMatch(out, /RECURRED line 2/)
  assert.doesNotMatch(out, /unrelated/)
})

test('a recurrence that a later FIXED line also matches is handled, not reported again', () => {
  const log2 = join(root, 'log2.md')
  writeFileSync(log2, [
    '# Retro log',
    '2026-10-01 | t | repeated-step | wrote throwaway edit scripts | 2 turns | script: x | new',
    'FIXED | 2026-10-02 | match: throwaway edit | tools/a',
    '2026-10-03 | t | repeated-step | throwaway edit scripts again, in a slow chain | 1 turn | script: y | REPEAT (first seen 2026-10-01)',
    'FIXED | 2026-10-03 | match: slow chain | tools/b',
    '2026-10-04 | t | near-miss | a different thing entirely | 1 turn | test: z | new',
    '2026-10-05 | t | repeated-step | throwaway edit scripts a third time | 1 turn | script: y | REPEAT (first seen 2026-10-01)',
    '',
  ].join('\n'))
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--log', log2, '--metrics', metrics, '--repos', 'none', '--check-log'], { encoding: 'utf8' })
  assert.match(r.stdout, /fixed marker: 2 fixed, 1 recurrence\(s\) to look at \(1 already handled by a later FIXED\)/)
  assert.match(r.stdout, /RECURRED line 7: .*a third time/)
  assert.doesNotMatch(r.stdout, /RECURRED line 4/) // handled by the later FIXED line 5
  assert.doesNotMatch(r.stdout, /RECURRED line 2/) // before the FIXED line
})

test('a FIXED line written before the recurrence does not hide it', () => {
  const { out } = audit('--check-log')
  assert.match(out, /RECURRED line 4: .*throwaway edit scripts again/)
  assert.doesNotMatch(out, /already handled/)
})

test('a bad regex in a FIXED line is reported, not a crash', () => {
  const { code, out } = audit('--check-log')
  assert.equal(code, 0)
  assert.match(out, /FIXED line 6: bad regex/)
})

test('counts near-misses and REPEATs in the retro log, limited to the window', () => {
  assert.match(audit().out, /retro log: 3 entries, 1 near-miss, 1 REPEAT/)
  assert.match(audit('--since', '2026-10-03').out, /retro log \(window\): 2 entries, 1 near-miss, 1 REPEAT/)
})

test('usage errors exit 64 and a missing transcript directory exits 2', () => {
  assert.equal(audit('--bogus').code, 64)
  assert.equal(audit('--since', 'yesterday').code, 64)
  assert.equal(audit('--label').code, 64)
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', join(root, 'nope'), '--repos', 'none'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
})
