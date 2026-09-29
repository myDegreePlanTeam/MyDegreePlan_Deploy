// Build the { "<image in docker-compose.yml>": "<name>@sha256:<digest>" } map that
// make-release.mjs pins the release compose with.
//
//   node image-map.mjs --compose ../docker-compose.yml --registry ghcr.io/myorg \
//        --ours web=sha256:...,setup=sha256:...,db=sha256:...,updater=sha256:... [--out images.json]
//
// Our own images (mydegreeplan/<name>:local in the dev compose) become
// <registry>/mdp-<name>@<digest>, using the digests the build step just pushed.
// Third-party images are looked up in their registry and pinned to that digest, so a
// re-tagged upstream image can never change what an already-published release runs.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { DIGEST_RE } from './lib.mjs'

export function composeImages(devText) {
  const doc = parse(devText, { merge: true })
  return [...new Set(Object.values(doc.services).map((s) => s.image))]
}

// Index (multi-arch) digest, so the pin works on both amd64 and arm64 machines.
export function registryDigest(image) {
  const out = execFileSync('docker', ['buildx', 'imagetools', 'inspect', image, '--format', '{{.Manifest.Digest}}'], { encoding: 'utf8' })
  return out.trim()
}

export function buildImageMap(devText, { registry, ours, resolveDigest = registryDigest }) {
  const map = {}
  for (const image of composeImages(devText)) {
    const local = /^mydegreeplan\/([a-z0-9-]+):local$/.exec(image)
    let digest, name
    if (local) {
      digest = ours[local[1]]
      name = `${registry}/mdp-${local[1]}`
      if (!digest) throw new Error(`no digest supplied for our image ${image}`)
    } else {
      if (/:local$|^mydegreeplan\//.test(image)) throw new Error(`unrecognised local image ${image}`)
      digest = resolveDigest(image)
      name = image.replace(/[:@][^/]*$/, '')          // drop the tag, keep registry/repo
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) throw new Error(`bad digest for ${image}: ${digest}`)
    map[image] = `${name}@${digest}`
    if (!DIGEST_RE.test(map[image])) throw new Error(`pin for ${image} is malformed`)
  }
  return map
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = {}
  for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
  const ours = Object.fromEntries((a.ours ?? '').split(',').filter(Boolean).map((kv) => kv.split('=')))
  const map = buildImageMap(readFileSync(a.compose, 'utf8'), { registry: a.registry, ours })
  const json = JSON.stringify(map, null, 2) + '\n'
  if (a.out) writeFileSync(a.out, json); else process.stdout.write(json)
}
