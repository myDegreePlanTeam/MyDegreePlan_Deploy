// Tests for yaml_check.mjs. Run: node --test local-deploy/tools/test_yaml_check.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkYaml, loadYaml } from './yaml_check.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'yaml_check.mjs')
const yaml = loadYaml()
const lines = (...l) => l.join('\n') + '\n'

test('the yaml package is found (release-tools installs it)', () => { assert.ok(yaml, 'run npm ci in local-deploy/release-tools') })

test('a good workflow is one line with its job and step counts', () => {
  const text = lines('name: x', 'on: push', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4', '      - run: echo hi',
    '  b:', '    runs-on: windows-latest', '    steps:', '      - run: echo b')
  assert.equal(checkYaml(yaml, 'w.yml', text).line, 'ok:    w.yml  (2 jobs, 3 steps)')
})

test('the three mistakes of 2026-10-09: an unquoted colon-space in a step name, in a one-line run value, and a bad indent', () => {
  const name = lines('jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - name: Verify: the download', '        run: echo hi')
  const run = lines('jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo "x" && echo note: this', '      - run: echo ok')
  const indent = lines('jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo hi', '       - run: echo bad')
  for (const text of [name, run, indent]) {
    const r = checkYaml(yaml, 'w.yml', text)
    assert.equal(r.ok, false)
    assert.match(r.line, /^ERROR: w\.yml {2}line \d+, column \d+: /)
    assert.equal(r.line.split('\n').length, 1, 'one line, never the document')
    assert.ok(r.line.length < 200)
  }
})

test('workflow shape: a job without runs-on or steps, and a step with neither run nor uses', () => {
  assert.match(checkYaml(yaml, 'w.yml', lines('jobs:', '  a:', '    steps:', '      - run: x')).line, /job a has no runs-on/)
  assert.match(checkYaml(yaml, 'w.yml', lines('jobs:', '  a:', '    runs-on: x')).line, /job a has no steps/)
  assert.match(checkYaml(yaml, 'w.yml', lines('jobs:', '  a:', '    runs-on: x', '    steps:', '      - name: Only a name')).line, /step 1 \(Only a name\) has neither run nor uses/)
  assert.equal(checkYaml(yaml, 'w.yml', lines('jobs:', '  call:', '    uses: ./.github/workflows/x.yml')).ok, true)
})

test('a YAML file that is not a workflow is only parsed', () => {
  assert.equal(checkYaml(yaml, 'c.yml', lines('publish:', '  provider: github')).line, 'ok:    c.yml')
})

test('command line: exit 0 when all are fine, 1 with one line per bad file, 64 without arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yaml-check-'))
  try {
    writeFileSync(join(dir, 'good.yml'), lines('a: 1'))
    writeFileSync(join(dir, 'bad.yml'), lines('jobs:', '  a:', '    runs-on: x', '    steps:', '      - name: Verify: x', '        run: y'))
    const good = spawnSync(process.execPath, [SCRIPT, join(dir, 'good.yml')], { encoding: 'utf8' })
    assert.equal(good.status, 0)
    const both = spawnSync(process.execPath, [SCRIPT, join(dir, 'good.yml'), join(dir, 'bad.yml'), join(dir, 'missing.yml')], { encoding: 'utf8' })
    assert.equal(both.status, 1)
    const out = both.stdout.trim().split('\n')
    assert.equal(out.length, 3)
    assert.match(out[1], /^ERROR: .*bad\.yml {2}line 5/)
    assert.match(out[2], /cannot read the file/)
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 64)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
