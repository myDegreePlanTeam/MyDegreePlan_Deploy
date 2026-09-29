import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { parseManifest, updaterImageRef, validateCompose, verifySignature, loadPublicKey } from '../src/verify.js'
import { isAllowedHost, isAllowedOrigin, verifyJwt } from '../src/auth.js'
import { composeText, jwt, keypair, release, UPDATER_IMG } from './helpers.js'

test('signature: accepts the signed bytes, rejects tampering and other keys', () => {
  const { publicKey, privateKey } = keypair()
  const r = release({ privateKey })
  assert.equal(verifySignature(Buffer.from(r.manifest), r.sig, publicKey), true)
  assert.equal(verifySignature(Buffer.from(r.manifest.replace('1.1.0', '9.9.9')), r.sig, publicKey), false)
  assert.equal(verifySignature(Buffer.from(r.manifest), release({ privateKey, badSig: true }).sig, publicKey), false)
  assert.equal(verifySignature(Buffer.from(r.manifest), r.sig, keypair().publicKey), false)
  assert.equal(verifySignature(Buffer.from(r.manifest), '', publicKey), false)
  assert.equal(verifySignature(Buffer.from(r.manifest), 'not base64 !!', publicKey), false)
})

test('loadPublicKey only takes ECDSA P-256', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' })
  assert.throws(() => loadPublicKey(rsa), /P-256/)
})

test('parseManifest validates and normalises', () => {
  const ok = { schema: 1, version: '1.2.3', sequence: 5, compose: { sha256: 'a'.repeat(64) }, notes: 'hi' }
  assert.deepEqual(parseManifest(JSON.stringify(ok)), { version: '1.2.3', sequence: 5, minSequence: 0, releasedAt: null, notes: 'hi', composeSha256: 'a'.repeat(64) })
  for (const bad of [
    { ...ok, schema: 2 }, { ...ok, version: '../x' }, { ...ok, version: 'a b' }, { ...ok, sequence: 0 },
    { ...ok, sequence: 1.5 }, { ...ok, min_sequence: -1 }, { ...ok, compose: { sha256: 'xyz' } }, { ...ok, compose: undefined },
  ]) assert.throws(() => parseManifest(JSON.stringify(bad)), /rejected/)
  assert.throws(() => parseManifest('nope'), /not valid JSON/)
})

test('validateCompose: pinned images pass; unpinned, build, privileged and host mounts fail', () => {
  assert.deepEqual(validateCompose(composeText()), [])
  assert.match(validateCompose(composeText({ pinned: false })).join(), /not digest-pinned/)
  const t = composeText()
  assert.match(validateCompose(`${t}    build:\n`).join(), /must not build/)
  assert.match(validateCompose(`${t}    privileged: true\n`).join(), /forbidden/)
  assert.match(validateCompose(`${t}    network_mode: host\n`).join(), /forbidden/)
  assert.match(validateCompose(`${t}      - /etc:/host-etc\n`).join(), /host path mount/)
  assert.match(validateCompose(`${t}      - ./db:/x\n`).join(), /host path mount/)
  assert.match(validateCompose('services: {}').join(), /no images/)
})

test('updaterImageRef finds the updater service\'s pinned image, whatever the repo is called', () => {
  assert.equal(updaterImageRef(composeText()), UPDATER_IMG)
  const other = `ghcr.io/anyone/some-name@sha256:${'d'.repeat(64)}`
  const text = `services:\n  web:\n    image: ghcr.io/x/web@sha256:${'e'.repeat(64)}\n  updater:\n    container_name: u\n    image: ${other}\n  seed:\n    image: ghcr.io/x/s@sha256:${'f'.repeat(64)}\n`
  assert.equal(updaterImageRef(text), other)
  assert.equal(updaterImageRef('image: nginx@sha256:' + 'c'.repeat(64)), null)           // no updater service
  assert.equal(updaterImageRef(`services:\n  updater:\n    image: x:latest\n`), null)     // unpinned
  assert.equal(updaterImageRef(`services:\n  updater:\n  web:\n    image: ghcr.io/x/web@sha256:${'e'.repeat(64)}\n`), null) // must not borrow the next service's image
})

test('jwt: only a live HS256 login token from this install passes', () => {
  const now = 1_000_000
  const ok = { role: 'authenticated', exp: now + 60 }
  assert.ok(verifyJwt(jwt(ok), 'secret', now))
  assert.equal(verifyJwt(jwt(ok, 'other'), 'secret', now), null)              // wrong key
  assert.equal(verifyJwt(jwt({ ...ok, exp: now - 1 }), 'secret', now), null)  // expired
  assert.equal(verifyJwt(jwt({ role: 'anon', exp: now + 60 }), 'secret', now), null) // anon key is not a login
  assert.equal(verifyJwt(jwt({ role: 'service_role', exp: now + 60 }), 'secret', now), null)
  assert.equal(verifyJwt(jwt({ role: 'authenticated' }), 'secret', now), null) // no exp
  assert.equal(verifyJwt(jwt(ok, 'secret', { alg: 'none' }), 'secret', now), null)
  assert.equal(verifyJwt('a.b', 'secret', now), null)
  assert.equal(verifyJwt(jwt(ok), '', now), null)
  assert.equal(verifyJwt(undefined, 'secret', now), null)
})

test('host and origin must be this install\'s own local address', () => {
  assert.equal(isAllowedHost('localhost:8080', 8080), true)
  assert.equal(isAllowedHost('127.0.0.1:8080', 8080), true)
  assert.equal(isAllowedHost('LOCALHOST:8080', 8080), true)
  assert.equal(isAllowedHost('evil.example:8080', 8080), false)   // DNS rebinding
  assert.equal(isAllowedHost('localhost:9999', 8080), false)
  assert.equal(isAllowedHost('localhost', 8080), false)
  assert.equal(isAllowedHost(undefined, 8080), false)
  assert.equal(isAllowedHost('localhost', 80), true)
  assert.equal(isAllowedOrigin(undefined, 8080), true)
  assert.equal(isAllowedOrigin('http://localhost:8080', 8080), true)
  assert.equal(isAllowedOrigin('https://evil.example', 8080), false)
  assert.equal(isAllowedOrigin('http://localhost:8080.evil.example', 8080), false)
  assert.equal(isAllowedOrigin('null', 8080), false)
})
