import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { State } from '../src/state.js'
import { loadPublicKey, sha256Hex } from '../src/verify.js'
import { loadConfig } from '../src/config.js'

export const UPDATER_IMG = `ghcr.io/x/mdp-updater@sha256:${'a'.repeat(64)}`

export function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { publicKey: loadPublicKey(publicKey.export({ type: 'spki', format: 'pem' })), privateKey }
}

export const tmpState = () => new State(mkdtempSync(join(tmpdir(), 'mdp-upd-')))

export function composeText({ pinned = true } = {}) {
  const d = (c) => `sha256:${c.repeat(64)}`
  const ref = (n, c) => pinned ? `ghcr.io/x/${n}@${d(c)}` : `ghcr.io/x/${n}:latest`
  return [
    'name: mydegreeplan', 'services:',
    '  web:', `    image: ${ref('mdp-web', 'b')}`,
    '  updater:', `    image: ${UPDATER_IMG}`,
    '    volumes:', '      - /var/run/docker.sock:/var/run/docker.sock', '',
  ].join('\n')
}

// A signed release as the server would publish it.
export function release({ privateKey, version = '1.1.0', sequence = 20, minSequence = 0, compose = composeText(), badSig = false, notes = 'Fixes.' }) {
  const manifest = JSON.stringify({
    schema: 1, version, sequence, min_sequence: minSequence, released_at: '2026-10-01T00:00:00Z', notes,
    compose: { file: 'docker-compose.yml', sha256: sha256Hex(Buffer.from(compose)) },
  })
  const bytes = Buffer.from(manifest)
  const sig = sign('sha256', bytes, privateKey).toString('base64')
  return { manifest, sig: badSig ? corrupt(sig) : sig, compose }
}

// Flip a bit in the middle of the decoded signature (the last base64 char can be padding).
function corrupt(sigB64) {
  const b = Buffer.from(sigB64, 'base64')
  b[Math.floor(b.length / 2)] ^= 0x01
  return b.toString('base64')
}

export function fakeFetch(files) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    const name = new URL(url).pathname.split('/').pop()
    if (!(name in files)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    const buf = Buffer.from(files[name])
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }
  }
  impl.calls = calls
  return impl
}

export function publish(rel) {
  return { 'release.json': rel.manifest, 'release.json.sig': rel.sig, 'docker-compose.yml': rel.compose }
}

// Records every docker call; `plan(args)` may override the result for a given call.
export function fakeDocker(plan = () => null) {
  const calls = []
  return {
    calls,
    async run(args) {
      calls.push(args)
      return plan(args) ?? { code: 0, out: '' }
    },
  }
}

export const cfg = (over = {}) => ({
  ...loadConfig({ MDP_UPDATE_URL: 'https://example.test/rel', MDP_VERSION: '1.0.0', MDP_SEQUENCE: '10', JWT_SECRET: 'secret', MDP_PORT: '8080', STATE_DIR: '/state', MDP_HELPER_IMAGE: UPDATER_IMG }),
  ...over,
})

export function jwt(payload, secret = 'secret', header = { alg: 'HS256', typ: 'JWT' }) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${enc(header)}.${enc(payload)}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

// Tests run on Windows too, where State.path() yields backslashes; production is POSIX.
export const norm = (s) => String(s).split('\\').join('/')
