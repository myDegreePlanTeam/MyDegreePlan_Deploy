// HTTP surface. Two listeners:
//   :8090  reached only via the web container's nginx (/_mdp/update/*). Every route
//          except /healthz needs a login token from this install and a local Host.
//   127.0.0.1:8091  inside this container only, for `mdp update` via `docker exec`.
//          Not reachable from any other container or the host.
import { createServer } from 'node:http'
import { bearer, isAllowedHost, isAllowedOrigin, verifyJwt } from './auth.js'
import { HttpError } from './updater.js'

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readBody(req, max = 1024) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > max) throw new HttpError(413, 'body too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function route(updater, req, res) {
  const { method } = req
  const path = new URL(req.url, 'http://x').pathname
  if (method === 'GET' && path === '/status') return send(res, 200, updater.status())
  if (method === 'POST' && path === '/check') return send(res, 200, await updater.check({ force: true }))
  if (method === 'POST' && path === '/apply') return send(res, 202, await updater.apply())
  if (method === 'POST' && path === '/settings') {
    let body
    try { body = JSON.parse((await readBody(req)) || '{}') } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, 'invalid JSON') }
    if (typeof body.auto !== 'boolean') throw new HttpError(400, 'auto must be true or false')
    updater.setAuto(body.auto)
    return send(res, 200, updater.status())
  }
  throw new HttpError(path === '/status' || path === '/check' || path === '/apply' || path === '/settings' ? 405 : 404, 'not found')
}

function guard(fn) {
  return async (req, res) => {
    try { await fn(req, res) } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      send(res, status, { error: status === 500 ? 'internal error' : e.message })
    }
  }
}

export function createApiServer({ updater, config }) {
  return createServer(guard(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true })
    if (!isAllowedHost(req.headers.host, config.port)) throw new HttpError(403, 'forbidden')
    if (!isAllowedOrigin(req.headers.origin, config.port)) throw new HttpError(403, 'forbidden')
    const claims = verifyJwt(bearer(req.headers), config.jwtSecret)
    if (!claims) throw new HttpError(401, 'sign in first')
    await route(updater, req, res)
  }))
}

export function createCliServer({ updater }) {
  return createServer(guard((req, res) => route(updater, req, res)))
}
