// Turn the dev compose file + pinned image digests into the release artefacts:
//   dist/docker-compose.yml   digest-pinned compose file students run
//   dist/release.json         signed manifest (hash of that compose file, version, notes)
//   dist/release.json.sig     signature over release.json (skipped without --sign)
//
//   node make-release.mjs --compose ../docker-compose.yml --images images.json \
//        --version 1.2.0 --update-url https://github.com/<org>/<repo>/releases/latest/download \
//        [--sequence N] [--required] [--prev-min-sequence N] [--notes-file f] \
//        [--sources sources.json] [--out dist] [--sign]      (private key: env MDP_SIGNING_KEY)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeManifest, makeReleaseCompose, signBytes, verifyBytes } from './lib.mjs'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
  const next = process.argv[i + 1]
  if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true
  else { args[a.slice(2)] = next; i++ }
}
const need = (k) => { if (!args[k] || args[k] === true) throw new Error(`--${k} is required`); return args[k] }

const version = need('version')
const sequence = args.sequence ? Number.parseInt(args.sequence, 10) : Math.floor(Date.now() / 1000)
if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('--sequence must be a positive integer')
const prevMin = args['prev-min-sequence'] ? Number.parseInt(args['prev-min-sequence'], 10) || 0 : 0
// A "required" release blocks every older install until it updates; the requirement is
// carried forward so a later optional release cannot quietly lift it.
const minSequence = args.required ? sequence : prevMin

const imageMap = JSON.parse(readFileSync(need('images'), 'utf8'))
const composeText = makeReleaseCompose(readFileSync(need('compose'), 'utf8'), {
  imageMap, version, sequence, updateUrl: need('update-url'),
})
const notes = args['notes-file'] ? readFileSync(args['notes-file'], 'utf8').trim() : ''
const sources = args.sources ? JSON.parse(readFileSync(args.sources, 'utf8')) : {}
const manifest = makeManifest({ version, sequence, minSequence, notes, composeText, images: imageMap, sources })

const out = args.out && args.out !== true ? args.out : 'dist'
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'docker-compose.yml'), composeText)
writeFileSync(join(out, 'release.json'), manifest)

if (args.sign) {
  const key = process.env.MDP_SIGNING_KEY
  if (!key) throw new Error('--sign needs the private key in the MDP_SIGNING_KEY environment variable')
  const sig = signBytes(Buffer.from(manifest), key)
  if (args.pub) {   // catch a wrong secret before publishing a release nobody can verify
    if (!verifyBytes(Buffer.from(manifest), sig, readFileSync(args.pub, 'utf8'))) {
      throw new Error('the signing key does not match updater/release-signing.pub.pem; refusing to publish')
    }
  }
  writeFileSync(join(out, 'release.json.sig'), sig)
}
console.log(`Wrote ${out}/ for ${version} (sequence ${sequence}, min_sequence ${minSequence})`)
