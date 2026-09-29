import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { generateSigningKey, makeManifest, makeReleaseCompose, signBytes, verifyBytes } from '../lib.mjs'
// The updater's own verification code — the release artefacts must satisfy the real thing.
import { PASS_ENV } from '../../updater/src/config.js'
import { loadPublicKey, parseManifest, sha256Hex, updaterImageRef, validateCompose, verifySignature } from '../../updater/src/verify.js'

const devCompose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')
const d = (c) => `sha256:${c.repeat(64)}`

// Every image the real dev compose references.
const dev = parse(devCompose, { merge: true })
const devImages = [...new Set(Object.values(dev.services).map((s) => s.image))]
// Our own images become ghcr.io/org/mdp-<name>; third-party ones keep their name.
const pin = (img) => (img.startsWith('mydegreeplan/') ? `ghcr.io/org/mdp-${img.split('/')[1].split(':')[0]}` : img.split(':')[0])
const imageMap = Object.fromEntries(devImages.map((img, i) => [img, `${pin(img)}@${d('abcdef0123456789'[i % 16])}`]))
const opts = { imageMap, version: '1.4.0', sequence: 1700000000, updateUrl: 'https://example.test/download' }

test('the dev compose defines the updater and the images this test maps', () => {
  assert.ok(dev.services.updater)
  assert.ok(devImages.length >= 6, devImages.join())
})

test('release compose: no builds, every image digest-pinned, updater told what it is running', () => {
  const text = makeReleaseCompose(devCompose, opts)
  const out = parse(text)
  for (const [name, svc] of Object.entries(out.services)) {
    assert.equal(svc.build, undefined, `${name} still has a build section`)
    assert.match(svc.image, /@sha256:[0-9a-f]{64}$/, name)
  }
  assert.equal(out['x-setup'], undefined)
  assert.equal(out.services.updater.environment.MDP_VERSION, '1.4.0')
  assert.equal(out.services.updater.environment.MDP_SEQUENCE, '1700000000')
  assert.equal(out.services.updater.environment.MDP_UPDATE_URL, 'https://example.test/download')
  // migrate and seed share the setup image but must keep their own commands/dependencies
  assert.deepEqual(out.services.migrate.command, ['sql'])
  assert.deepEqual(out.services.seed.command, ['seed'])
  assert.equal(out.services.migrate.restart, 'no')
  assert.deepEqual(out.volumes['update-state'], { name: 'mdp_update_state' })
})

test('release compose passes the updater\'s own safety checks and names an updater image', () => {
  const text = makeReleaseCompose(devCompose, opts)
  assert.deepEqual(validateCompose(text), [])
  assert.ok(updaterImageRef(text))
})

test('the dev compose (floating local tags, build sections) is rejected by those same checks', () => {
  assert.notDeepEqual(validateCompose(devCompose), [])
})

test('release compose only bind-mounts the Docker socket from the host', () => {
  const out = parse(makeReleaseCompose(devCompose, opts))
  for (const [name, svc] of Object.entries(out.services)) {
    for (const v of svc.volumes ?? []) {
      const src = String(v).split(':')[0]
      if (src.startsWith('/') || src.startsWith('.')) {
        assert.equal(src, '/var/run/docker.sock', `${name} mounts host path ${src}`)
        assert.equal(name, 'updater')
      }
    }
  }
})

test('a missing or unpinned image is an error, never a silent floating tag', () => {
  const missing = { ...imageMap }; delete missing[devImages[0]]
  assert.throws(() => makeReleaseCompose(devCompose, { ...opts, imageMap: missing }), /no pinned image/)
  assert.throws(() => makeReleaseCompose(devCompose, { ...opts, imageMap: { ...imageMap, [devImages[0]]: 'ghcr.io/org/x:latest' } }), /not digest-pinned/)
})

test('signed manifest verifies with the updater\'s code; any tampering does not', () => {
  const { publicPem, privatePem } = generateSigningKey()
  const composeText = makeReleaseCompose(devCompose, opts)
  const manifest = makeManifest({ version: '1.4.0', sequence: 1700000000, minSequence: 5, notes: 'Fixes.', composeText, images: imageMap })
  const sig = signBytes(Buffer.from(manifest), privatePem)
  const key = loadPublicKey(publicPem)

  assert.equal(verifySignature(Buffer.from(manifest), sig, key), true)
  assert.equal(verifyBytes(Buffer.from(manifest), sig, publicPem), true)
  assert.equal(verifySignature(Buffer.from(manifest.replace('1.4.0', '1.4.1')), sig, key), false)
  assert.equal(verifySignature(Buffer.from(manifest), signBytes(Buffer.from(manifest), generateSigningKey().privatePem), key), false)

  const m = parseManifest(manifest)
  assert.equal(m.sequence, 1700000000)
  assert.equal(m.minSequence, 5)
  assert.equal(m.composeSha256, sha256Hex(Buffer.from(composeText)))
})

test('every ${VARIABLE} the release compose reads reaches the apply helper (PASS_ENV)', () => {
  // The helper re-creates the stack from inside a container. Variables it is not handed
  // silently fall back to their defaults, e.g. a student's MDP_UPDATES=off or their port.
  const text = makeReleaseCompose(devCompose, opts)
  const used = [...new Set([...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))]
  assert.ok(used.includes('POSTGRES_PASSWORD') && used.includes('MDP_PORT'), used.join())
  const missing = used.filter((v) => !PASS_ENV.includes(v))
  assert.deepEqual(missing, [], `compose reads ${missing.join(', ')} but the apply helper is not passed it`)
})
