#!/usr/bin/env node
// json_patch.mjs: structural edits to JSON files, safely.
//
// Sibling of multi_replace.py. That one edits text; this one edits JSON by path, so a catalog override, a manifest
// decision or a vocabulary entry is one op instead of a throwaway read/modify/write script.
//
//   node local-deploy/tools/json_patch.mjs SPEC [--dry-run]       SPEC is a file, or "-" for stdin
//
// Spec (JSON):
//   {"files": [{"path": "MyDegreePlan_Prototype/catalog/overrides.json", "ops": [
//     {"op": "set",     "path": "/courses/CSC2400/why", "value": "text"},       // create or replace
//     {"op": "add",     "path": "/groups/-",            "value": {"courses": ["A", "B"]}},   // new key / append / insert
//     {"op": "replace", "path": "/hours",               "value": 120},           // must already exist
//     {"op": "remove",  "path": "/courses/CSC9999"},                             // must already exist
//     {"op": "merge",   "path": "/courses/CSC2400",     "value": {"why": "x"}},  // shallow-merge keys into an object
//     {"op": "test",    "path": "/hours",               "value": 128}            // precondition: refuse unless equal
//   ]}]}
//
// Paths are RFC 6901 JSON pointers: "/a/b/0", "-" is one past the end of an array, "~1" is "/", "~0" is "~".
//
// What it guarantees
//   * all-or-nothing: every op on every file is applied in memory first; files are written only if all succeed
//   * formatting is kept: indent (tabs or N spaces), line endings (LF or CRLF), a BOM and the final newline
//   * a file whose layout is NOT what JSON.stringify would write at its indent (inline arrays, one slot object per
//     line, integer-like keys that would reorder, duplicate keys, 1.0 vs 1) is REFUSED, never reflowed: it would
//     turn a one-line edit into a whole-file diff. Edit those with multi_replace.py
//   * `add` never overwrites a key; `replace` / `remove` / `merge` never create one; `set` is the upsert
//   * control characters in string values are refused. In a JSON spec "\b" is a BACKSPACE, not a regex word boundary:
//     write "\\b" (and check the echoed value); the same trap corrupted two regexes before
//   * exit codes: 0 done, 1 refused (nothing written), 2 bad spec or unreadable file, 64 usage

import { readFileSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'

const BOM = '﻿'
// Every control character except tab, LF and CR.
// eslint-disable-next-line no-control-regex
const BAD_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/

export class PatchError extends Error {}
export class SpecError extends Error {}

// ── JSON pointer ─────────────────────────────────────────────────────────────

export function parsePointer(ptr) {
  if (typeof ptr !== 'string' || (ptr !== '' && !ptr.startsWith('/'))) {
    throw new PatchError(`path ${JSON.stringify(ptr)} must be "" or start with "/"`)
  }
  if (ptr === '') return []
  return ptr.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const where = (ptr) => (ptr === '' ? '(root)' : ptr)

function arrayIndex(seg, arr, ptr, { allowEnd }) {
  if (seg === '-') {
    if (!allowEnd) throw new PatchError(`${where(ptr)}: "-" (end of array) is only valid for add and set`)
    return arr.length
  }
  if (!/^(0|[1-9][0-9]*)$/.test(seg)) throw new PatchError(`${where(ptr)}: "${seg}" is not an array index`)
  const i = Number(seg)
  if (i > arr.length || (i === arr.length && !allowEnd)) {
    throw new PatchError(`${where(ptr)}: index ${i} is out of range (length ${arr.length})`)
  }
  return i
}

// Walk to the container that holds the last segment.
function parentOf(doc, segs, ptr) {
  let cur = doc
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    if (Array.isArray(cur)) cur = cur[arrayIndex(seg, cur, ptr, { allowEnd: false })]
    else if (isObj(cur) && Object.hasOwn(cur, seg)) cur = cur[seg]
    else throw new PatchError(`${where(ptr)}: "${segs.slice(0, i + 1).join('/')}" does not exist`)
  }
  if (!Array.isArray(cur) && !isObj(cur)) throw new PatchError(`${where(ptr)}: the parent is not an object or array`)
  return cur
}

function getAt(doc, segs, ptr) {
  if (!segs.length) return doc
  const parent = parentOf(doc, segs, ptr)
  const last = segs[segs.length - 1]
  if (Array.isArray(parent)) return parent[arrayIndex(last, parent, ptr, { allowEnd: false })]
  if (!Object.hasOwn(parent, last)) throw new PatchError(`${where(ptr)}: does not exist`)
  return parent[last]
}

function checkStrings(v, ptr) {
  if (typeof v === 'string') {
    const m = BAD_CONTROL.exec(v)
    if (m) {
      throw new PatchError(
        `${where(ptr)}: value has control character U+${m[0].charCodeAt(0).toString(16).padStart(4, '0')}; ` +
        'in JSON "\\b" is a backspace, write "\\\\b" for a regex word boundary'
      )
    }
  } else if (Array.isArray(v)) v.forEach(x => checkStrings(x, ptr))
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { checkStrings(k, ptr); checkStrings(x, ptr) }
}

// ── ops ──────────────────────────────────────────────────────────────────────

// Returns the new document (the root can be replaced). `doc` is mutated.
export function applyOp(doc, op) {
  if (!isObj(op) || typeof op.op !== 'string') throw new SpecError(`op must be an object with an "op": ${JSON.stringify(op)}`)
  const ptr = op.path
  const segs = parsePointer(ptr)
  const needsValue = ['add', 'set', 'replace', 'merge', 'test'].includes(op.op)
  if (!['add', 'set', 'replace', 'remove', 'merge', 'test'].includes(op.op)) throw new SpecError(`unknown op "${op.op}"`)
  if (needsValue && !Object.hasOwn(op, 'value')) throw new SpecError(`${op.op} ${where(ptr)} needs a "value"`)
  if (needsValue) checkStrings(op.value, ptr)

  if (op.op === 'test') {
    const have = getAt(doc, segs, ptr)
    if (!isDeepStrictEqual(have, op.value)) {
      throw new PatchError(`test ${where(ptr)} failed: found ${JSON.stringify(have)}, expected ${JSON.stringify(op.value)}`)
    }
    return doc
  }

  if (!segs.length) {
    if (op.op === 'replace' || op.op === 'set') return op.value
    if (op.op === 'merge') return mergeInto(doc, op.value, ptr)
    throw new PatchError(`${op.op} cannot target the document root`)
  }

  const parent = parentOf(doc, segs, ptr)
  const last = segs[segs.length - 1]

  if (op.op === 'merge') {
    const target = getAt(doc, segs, ptr)
    mergeInto(target, op.value, ptr)
    return doc
  }

  if (Array.isArray(parent)) {
    if (op.op === 'add') parent.splice(arrayIndex(last, parent, ptr, { allowEnd: true }), 0, op.value)
    else if (op.op === 'set') {
      const i = arrayIndex(last, parent, ptr, { allowEnd: true })
      if (i === parent.length) parent.push(op.value); else parent[i] = op.value
    } else if (op.op === 'replace') parent[arrayIndex(last, parent, ptr, { allowEnd: false })] = op.value
    else parent.splice(arrayIndex(last, parent, ptr, { allowEnd: false }), 1)
    return doc
  }

  const has = Object.hasOwn(parent, last)
  if (op.op === 'add' && has) throw new PatchError(`add ${where(ptr)}: key already exists (use set or replace)`)
  if ((op.op === 'replace' || op.op === 'remove') && !has) throw new PatchError(`${op.op} ${where(ptr)}: does not exist`)
  if (op.op === 'remove') delete parent[last]
  else parent[last] = op.value
  return doc
}

function mergeInto(target, value, ptr) {
  if (!isObj(target)) throw new PatchError(`merge ${where(ptr)}: the target is not an object`)
  if (!isObj(value)) throw new PatchError(`merge ${where(ptr)}: the value is not an object`)
  Object.assign(target, value)
  return target
}

// ── layout ───────────────────────────────────────────────────────────────────

// What a file looks like, so a rewrite can match it. Throws PatchError if it is mixed or not reproducible.
export function readLayout(raw, label) {
  let text = raw
  const bom = text.startsWith(BOM)
  if (bom) text = text.slice(BOM.length)
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  if (crlf && lf) throw new PatchError(`${label}: mixed line endings (${crlf} CRLF, ${lf} LF); not guessing`)
  const eol = crlf ? '\r\n' : '\n'
  const body = crlf ? text.replace(/\r\n/g, '\n') : text
  const finalNewline = body.endsWith('\n')
  const m = /\n([ \t]+)\S/.exec(body)
  const indent = m ? (m[1][0] === '\t' ? '\t' : m[1].length) : 2
  let doc
  try { doc = JSON.parse(body) } catch (e) { throw new SpecError(`${label}: not valid JSON (${e.message})`) }
  return { bom, eol, finalNewline, indent, doc, body }
}

export function serialize(doc, layout) {
  const s = JSON.stringify(doc, null, layout.indent) + (layout.finalNewline ? '\n' : '')
  return (layout.bom ? BOM : '') + (layout.eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s)
}

function firstDifference(a, b) {
  const x = a.split('\n'), y = b.split('\n')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `line ${i + 1}: file has ${JSON.stringify((x[i] ?? '').slice(0, 80))}, JSON.stringify writes ${JSON.stringify((y[i] ?? '').slice(0, 80))}`
  }
  return 'content differs'
}

// Patch one file's text. Returns { text, changed, log }.
export function patchText(raw, ops, label = 'file') {
  const layout = readLayout(raw, label)
  const canonical = JSON.stringify(layout.doc, null, layout.indent) + (layout.finalNewline ? '\n' : '')
  if (canonical !== layout.body) {
    throw new PatchError(
      `${label}: its layout is not what JSON.stringify writes at this indent, so a rewrite would reflow it ` +
      `(${firstDifference(layout.body, canonical)}). Edit it with multi_replace.py instead`
    )
  }
  let doc = layout.doc
  const log = []
  ops.forEach((op, i) => {
    try {
      doc = applyOp(doc, op)
      const shown = Object.hasOwn(op, 'value') ? ' ' + JSON.stringify(op.value) : ''
      log.push(`${op.op} ${where(op.path)}${shown.length > 110 ? shown.slice(0, 107) + '...' : shown}`)
    } catch (e) {
      if (e instanceof PatchError) throw new PatchError(`${label}: op ${i + 1}: ${e.message}`)
      throw e
    }
  })
  const text = serialize(doc, layout)
  return { text, changed: text !== raw, log }
}

// ── spec + cli ───────────────────────────────────────────────────────────────

export function parseSpec(text) {
  let spec
  try { spec = JSON.parse(text) } catch (e) { throw new SpecError(`spec is not valid JSON: ${e.message}`) }
  if (!isObj(spec) || !Array.isArray(spec.files) || !spec.files.length) throw new SpecError('spec needs a non-empty "files" array')
  for (const f of spec.files) {
    if (!isObj(f) || typeof f.path !== 'string' || !Array.isArray(f.ops) || !f.ops.length) {
      throw new SpecError('each file needs a "path" and a non-empty "ops" array')
    }
  }
  return spec
}

export function run(argv, { stdin = () => readFileSync(0, 'utf8'), out = console.log, err = console.error } = {}) {
  const args = argv.filter(a => !a.startsWith('--') || a === '-')
  const dry = argv.includes('--dry-run')
  const unknown = argv.filter(a => a.startsWith('--') && a !== '--dry-run')
  if (args.length !== 1 || unknown.length) {
    err('usage: node local-deploy/tools/json_patch.mjs SPEC|- [--dry-run]')
    return 64
  }
  try {
    const spec = parseSpec(args[0] === '-' ? stdin() : readFileSync(args[0], 'utf8'))
    const planned = []
    const byPath = new Map()
    for (const f of spec.files) {
      // Several entries for one file apply in order on the result of the earlier one.
      const raw = byPath.has(f.path) ? byPath.get(f.path) : readSpecFile(f.path)
      const r = patchText(raw, f.ops, f.path)
      byPath.set(f.path, r.text)
      planned.push({ path: f.path, ...r })
    }
    for (const p of planned) {
      out(`${dry ? 'would edit' : 'edited'} ${p.path} (${p.log.length} op${p.log.length === 1 ? '' : 's'}${p.changed ? '' : ', no change'})`)
      for (const line of p.log) out(`  ${line}`)
    }
    if (!dry) for (const [path, text] of byPath) writeFileSync(path, text)
    return 0
  } catch (e) {
    if (e instanceof PatchError) { err(`json_patch: refused, nothing written: ${e.message}`); return 1 }
    if (e instanceof SpecError) { err(`json_patch: ${e.message}`); return 2 }
    throw e
  }
}

function readSpecFile(path) {
  try { return readFileSync(path, 'utf8') } catch (e) { throw new SpecError(`cannot read ${path}: ${e.code ?? e.message}`) }
}

import { fileURLToPath } from 'node:url'
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)))
}
