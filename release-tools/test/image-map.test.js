import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildImageMap, composeImages } from '../image-map.mjs'

const devCompose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')
const dg = (c) => `sha256:${c.repeat(64)}`
const ours = { web: dg('1'), setup: dg('2'), db: dg('3'), updater: dg('4') }
const resolveDigest = (img) => (img.startsWith('supabase/gotrue') ? dg('a') : dg('b'))

test('our images map to <registry>/mdp-<name>@digest; third-party images are pinned by resolved digest', () => {
  const map = buildImageMap(devCompose, { registry: 'ghcr.io/org', ours, resolveDigest })
  assert.equal(map['mydegreeplan/web:local'], `ghcr.io/org/mdp-web@${dg('1')}`)
  assert.equal(map['mydegreeplan/updater:local'], `ghcr.io/org/mdp-updater@${dg('4')}`)
  assert.equal(map['supabase/gotrue:v2.196.0'], `supabase/gotrue@${dg('a')}`)
  assert.equal(map['postgrest/postgrest:v14.17'], `postgrest/postgrest@${dg('b')}`)
  assert.deepEqual(Object.keys(map).sort(), composeImages(devCompose).sort())
})

test('a missing digest for one of our images is an error', () => {
  const { updater, ...rest } = ours
  assert.throws(() => buildImageMap(devCompose, { registry: 'ghcr.io/org', ours: rest, resolveDigest }), /no digest supplied/)
})

test('a malformed resolved digest is an error, never written into a release', () => {
  assert.throws(() => buildImageMap(devCompose, { registry: 'ghcr.io/org', ours, resolveDigest: () => 'latest' }), /bad digest/)
})
