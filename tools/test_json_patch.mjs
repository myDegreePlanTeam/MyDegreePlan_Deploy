// Run with: node --test local-deploy/tools/test_json_patch.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchText, run, PatchError } from './json_patch.mjs'

const doc = { a: 1, list: ['x', 'y'], obj: { k: 'v' } }
const text = (indent = 2, eol = '\n', bom = '') => bom + JSON.stringify(doc, null, indent).replace(/\n/g, eol) + eol
const patch = (raw, ...ops) => patchText(raw, ops)
const result = (raw, ...ops) => JSON.parse(patch(raw, ...ops).text.replace(/^﻿/, ''))

test('set creates or replaces; add refuses an existing key; replace refuses a missing one', () => {
  assert.equal(result(text(), { op: 'set', path: '/b', value: 2 }).b, 2)
  assert.equal(result(text(), { op: 'set', path: '/a', value: 9 }).a, 9)
  assert.throws(() => patch(text(), { op: 'add', path: '/a', value: 9 }), /already exists/)
  assert.throws(() => patch(text(), { op: 'replace', path: '/zz', value: 9 }), /does not exist/)
})

test('array ops: add inserts, "-" appends, set at "-" appends, remove splices', () => {
  assert.deepEqual(result(text(), { op: 'add', path: '/list/0', value: 'w' }).list, ['w', 'x', 'y'])
  assert.deepEqual(result(text(), { op: 'add', path: '/list/-', value: 'z' }).list, ['x', 'y', 'z'])
  assert.deepEqual(result(text(), { op: 'set', path: '/list/-', value: 'z' }).list, ['x', 'y', 'z'])
  assert.deepEqual(result(text(), { op: 'remove', path: '/list/0' }).list, ['y'])
  assert.throws(() => patch(text(), { op: 'replace', path: '/list/2', value: 1 }), /out of range/)
  assert.throws(() => patch(text(), { op: 'remove', path: '/list/-' }), /only valid for add and set/)
  assert.throws(() => patch(text(), { op: 'add', path: '/list/01', value: 1 }), /not an array index/)
})

test('remove, merge and nested paths', () => {
  assert.equal('a' in result(text(), { op: 'remove', path: '/a' }), false)
  assert.deepEqual(result(text(), { op: 'merge', path: '/obj', value: { k: 'w', n: 1 } }).obj, { k: 'w', n: 1 })
  assert.throws(() => patch(text(), { op: 'merge', path: '/list', value: {} }), /not an object/)
  assert.throws(() => patch(text(), { op: 'set', path: '/nope/deeper', value: 1 }), /does not exist/)
})

test('pointer escapes: ~1 is a slash, ~0 is a tilde', () => {
  const raw = JSON.stringify({ 'a/b': 1, 'c~d': 2 }, null, 2) + '\n'
  const out = JSON.parse(patch(raw, { op: 'replace', path: '/a~1b', value: 5 }, { op: 'replace', path: '/c~0d', value: 6 }).text)
  assert.deepEqual(out, { 'a/b': 5, 'c~d': 6 })
})

test('test is a precondition: equal passes, different refuses', () => {
  assert.equal(patch(text(), { op: 'test', path: '/obj', value: { k: 'v' } }).changed, false)
  assert.throws(() => patch(text(), { op: 'test', path: '/a', value: 2 }), /test \/a failed/)
})

test('indent, CRLF, BOM and the final newline are kept', () => {
  for (const [indent, eol, bom] of [[2, '\n', ''], [1, '\r\n', ''], ['\t', '\n', ''], [4, '\r\n', '﻿']]) {
    const raw = text(indent, eol, bom)
    const out = patch(raw, { op: 'set', path: '/b', value: 2 }).text
    assert.equal(out, bom + JSON.stringify({ ...doc, b: 2 }, null, indent).replace(/\n/g, eol) + eol)
  }
  const noNewline = JSON.stringify(doc, null, 2)
  assert.equal(patch(noNewline, { op: 'set', path: '/a', value: 2 }).text.endsWith('}'), true)
})

test('a no-op reports no change and returns the file byte for byte', () => {
  const r = patch(text(2, '\r\n'), { op: 'set', path: '/a', value: 1 })
  assert.equal(r.changed, false)
  assert.equal(r.text, text(2, '\r\n'))
})

test('a hand-formatted file is refused, not reflowed', () => {
  const inline = '{\n  "groups": [\n    {"courses":["A","B"]}\n  ]\n}\n'
  assert.throws(() => patch(inline, { op: 'set', path: '/x', value: 1 }), err => err instanceof PatchError && /multi_replace/.test(err.message) && /line 3/.test(err.message))
  // integer-like keys would be reordered by JS, so the rewrite would not match the file
  assert.throws(() => patch('{\n  "b": 1,\n  "2": 2\n}\n', { op: 'set', path: '/x', value: 1 }), /layout/)
  // a duplicate key is dropped by JSON.parse
  assert.throws(() => patch('{\n  "a": 1,\n  "a": 2\n}\n', { op: 'set', path: '/x', value: 1 }), /layout/)
})

test('mixed line endings are refused', () => {
  assert.throws(() => patch('{\r\n  "a": 1,\n  "b": 2\r\n}\n', { op: 'set', path: '/x', value: 1 }), /mixed line endings/)
})

test('control characters in values are refused (a JSON "\\b" is a backspace)', () => {
  const bad = JSON.parse('{"v": "none\\b"}').v
  assert.throws(() => patch(text(), { op: 'set', path: '/re', value: bad }), /U\+0008/)
  assert.throws(() => patch(text(), { op: 'set', path: '/re', value: { nested: [bad] } }), /U\+0008/)
  assert.equal(result(text(), { op: 'set', path: '/re', value: 'a\tb\nc' }).re, 'a\tb\nc')
  assert.equal(result(text(), { op: 'set', path: '/re', value: JSON.parse('"none\\\\b"') }).re, 'none\\b')
})

test('the op number is in the error', () => {
  assert.throws(() => patch(text(), { op: 'set', path: '/b', value: 1 }, { op: 'remove', path: '/zz' }), /op 2: .*\/zz/)
})

// ── cli ──────────────────────────────────────────────────────────────────────

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'json_patch-'))
  const a = join(dir, 'a.json'), b = join(dir, 'b.json')
  writeFileSync(a, text(2, '\r\n')); writeFileSync(b, text())
  return { dir, a, b }
}
const cli = (spec, ...flags) => {
  const lines = [], errs = []
  const code = run(['-', ...flags], { stdin: () => JSON.stringify(spec), out: l => lines.push(l), err: l => errs.push(l) })
  return { code, lines, errs }
}

test('cli writes every file when every op succeeds, and echoes the values', () => {
  const { a, b } = fixture()
  const r = cli({ files: [{ path: a, ops: [{ op: 'set', path: '/a', value: 5 }] }, { path: b, ops: [{ op: 'add', path: '/list/-', value: 'z' }] }] })
  assert.equal(r.code, 0)
  assert.match(r.lines.join('\n'), /edited .*a\.json \(1 op\)\n  set \/a 5/)
  assert.equal(readFileSync(a, 'utf8'), text(2, '\r\n').replace('"a": 1', '"a": 5'))
  assert.deepEqual(JSON.parse(readFileSync(b, 'utf8')).list, ['x', 'y', 'z'])
})

test('cli is all-or-nothing: one refused op writes nothing anywhere', () => {
  const { a, b } = fixture()
  const before = [readFileSync(a, 'utf8'), readFileSync(b, 'utf8')]
  const r = cli({ files: [{ path: a, ops: [{ op: 'set', path: '/a', value: 5 }] }, { path: b, ops: [{ op: 'remove', path: '/nope' }] }] })
  assert.equal(r.code, 1)
  assert.match(r.errs.join(''), /nothing written/)
  assert.deepEqual([readFileSync(a, 'utf8'), readFileSync(b, 'utf8')], before)
})

test('cli --dry-run writes nothing; two entries for one file apply in order', () => {
  const { a } = fixture()
  const before = readFileSync(a, 'utf8')
  const spec = { files: [{ path: a, ops: [{ op: 'set', path: '/n', value: 1 }] }, { path: a, ops: [{ op: 'test', path: '/n', value: 1 }, { op: 'set', path: '/n', value: 2 }] }] }
  assert.equal(cli(spec, '--dry-run').code, 0)
  assert.equal(readFileSync(a, 'utf8'), before)
  assert.equal(cli(spec).code, 0)
  assert.equal(JSON.parse(readFileSync(a, 'utf8')).n, 2)
})

test('cli exit codes: 2 for a bad spec or a missing file, 64 for usage', () => {
  assert.equal(cli({ files: [] }).code, 2)
  assert.equal(cli({ files: [{ path: 'no/such/file.json', ops: [{ op: 'set', path: '/a', value: 1 }] }] }).code, 2)
  assert.equal(cli({ files: [{ path: 'x.json', ops: [{ op: 'frobnicate', path: '/a' }] }] }).code, 2)
  assert.equal(run([], { err: () => {} }), 64)
  assert.equal(run(['-', '--wat'], { err: () => {} }), 64)
})
