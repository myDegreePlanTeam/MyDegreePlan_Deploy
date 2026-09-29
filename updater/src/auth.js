// Request authentication for the update API. The API is only reachable through the
// web container's nginx on 127.0.0.1, and every call must:
//   1. carry a valid access token minted by this install's own auth service
//      (a page on another site cannot read it, so it cannot forge the header), and
//   2. arrive with a Host/Origin that is this install's own local address, which
//      also defeats DNS-rebinding.
import { createHmac, timingSafeEqual } from 'node:crypto'

const b64url = (buf) => Buffer.from(buf).toString('base64url')

export function verifyJwt(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || !secret) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, p, s] = parts
  let header, payload
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
  } catch { return null }
  if (header.alg !== 'HS256') return null   // never accept "none" or asymmetric downgrades
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest()
  const given = Buffer.from(s, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) return null
  if (payload.role !== 'authenticated') return null   // the anon key is not a login
  return payload
}

export function allowedHosts(port) {
  const p = String(port)
  const hosts = new Set()
  for (const h of ['localhost', '127.0.0.1', '[::1]']) {
    hosts.add(`${h}:${p}`)
    if (p === '80') hosts.add(h)
  }
  return hosts
}

export function isAllowedHost(hostHeader, port) {
  return typeof hostHeader === 'string' && allowedHosts(port).has(hostHeader.toLowerCase())
}

export function isAllowedOrigin(originHeader, port) {
  if (originHeader === undefined) return true   // same-origin GETs and non-browser clients send none
  if (typeof originHeader !== 'string') return false
  const m = /^http:\/\/(.+)$/.exec(originHeader.toLowerCase())
  return !!m && allowedHosts(port).has(m[1])
}

export function bearer(headers) {
  const m = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')
  return m ? m[1] : null
}

// exported for tests
export const _b64url = b64url
