// Guards mdp.ps1 against lost backslashes in its Windows paths. A tool call that collapsed doubled backslashes once
// turned "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe" into "$env:ProgramFilesDockerDockerDocker Desktop.exe",
// so the launcher could not find Docker Desktop to start it. Run: node --test local-deploy/tools/test_mdp_ps1_paths.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ps1 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'mdp.ps1'), 'utf8')

test('Find-DockerDesktop looks in the real Docker Desktop install folders', () => {
  assert.ok(ps1.includes('"$env:ProgramFiles\\Docker\\Docker\\Docker Desktop.exe"'), 'Program Files path')
  assert.ok(ps1.includes('"$env:LOCALAPPDATA\\Programs\\Docker\\Docker\\Docker Desktop.exe"'), 'per-user path')
})

test('no $env: variable runs straight into a path segment without a separator', () => {
  const bad = ps1.split(/\r?\n/).filter(l => /\$env:(ProgramFiles|LOCALAPPDATA|APPDATA|USERPROFILE|SystemRoot)[A-Z]/.test(l))
  assert.deepEqual(bad, [])
})
