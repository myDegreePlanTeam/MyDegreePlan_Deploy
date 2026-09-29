import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { Updater } from '../src/updater.js'
import { createApiServer, createCliServer } from '../src/server.js'
import { cfg, fakeDocker, fakeFetch, jwt, keypair, publish, release, tmpState } from './helpers.js'

async function boot() {
  const keys = keypair()
  const config = cfg()
  const updater = new Updater({
    config, state: tmpState(), docker: fakeDocker(), publicKey: keys.publicKey,
    fetchImpl: fakeFetch(publish(release({ privateKey: keys.privateKey, sequence: 20 }))),
  })
  const api = createApiServer({ updater, config }).listen(0, '127.0.0.1')
  const cli = createCliServer({ updater }).listen(0, '127.0.0.1')
  await Promise.all([new Promise((r) => api.once('listening', r)), new Promise((r) => cli.once('listening', r))])
  const close = () => { api.close(); cli.close() }
  return { updater, api: api.address().port, cli: cli.address().port, close, config }
}

// http.request lets us set Host explicitly, which fetch forbids.
const call = (port, { method = 'GET', path = '/status', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    let text = ''
    res.on('data', (c) => (text += c))
    res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null, headers: res.headers }))
  })
  req.on('error', reject)
  req.end(body)
})
const login = () => `Bearer ${jwt({ role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 })}`
const good = { host: 'localhost:8080', authorization: login() }

test('api: no token, bad token, anon key → 401', async () => {
  const s = await boot()
  try {
    assert.equal((await call(s.api, { headers: { host: 'localhost:8080' } })).status, 401)
    assert.equal((await call(s.api, { headers: { host: 'localhost:8080', authorization: 'Bearer nope' } })).status, 401)
    const anon = `Bearer ${jwt({ role: 'anon', exp: Math.floor(Date.now() / 1000) + 600 })}`
    assert.equal((await call(s.api, { headers: { host: 'localhost:8080', authorization: anon } })).status, 401)
  } finally { s.close() }
})

test('api: wrong Host (DNS rebinding) or foreign Origin → 403 even with a valid token', async () => {
  const s = await boot()
  try {
    assert.equal((await call(s.api, { headers: { ...good, host: 'evil.example:8080' } })).status, 403)
    assert.equal((await call(s.api, { headers: { ...good, origin: 'https://evil.example' } })).status, 403)
    assert.equal((await call(s.api, { method: 'POST', path: '/apply', headers: { ...good, origin: 'https://evil.example' } })).status, 403)
  } finally { s.close() }
})

test('api: valid login gets status; check finds the update; responses are not cacheable', async () => {
  const s = await boot()
  try {
    const st = await call(s.api, { headers: good })
    assert.equal(st.status, 200)
    assert.equal(st.json.state, 'idle')
    assert.equal(st.headers['cache-control'], 'no-store')
    const ck = await call(s.api, { method: 'POST', path: '/check', headers: good })
    assert.equal(ck.status, 200)
    assert.equal(ck.json.state, 'available')
    assert.equal(ck.json.latest.sequence, 20)
  } finally { s.close() }
})

test('api: apply takes no parameters, unknown routes 404, wrong verbs 405, settings validated', async () => {
  const s = await boot()
  try {
    assert.equal((await call(s.api, { method: 'POST', path: '/apply', headers: good })).status, 409)   // nothing found yet
    await call(s.api, { method: 'POST', path: '/check', headers: good })
    assert.equal((await call(s.api, { method: 'GET', path: '/apply', headers: good })).status, 405)
    assert.equal((await call(s.api, { path: '/shell', headers: good })).status, 404)
    const bad = await call(s.api, { method: 'POST', path: '/settings', headers: { ...good, 'content-type': 'application/json' }, body: '{"auto":"yes"}' })
    assert.equal(bad.status, 400)
    const on = await call(s.api, { method: 'POST', path: '/settings', headers: good, body: '{"auto":true}' })
    assert.equal(on.json.auto, true)
    assert.equal((await call(s.api, { method: 'POST', path: '/settings', headers: good, body: 'x'.repeat(5000) })).status, 413)
  } finally { s.close() }
})

test('api: /healthz is open; the cli listener needs no token (it is loopback-in-container only)', async () => {
  const s = await boot()
  try {
    assert.equal((await call(s.api, { path: '/healthz' })).status, 200)
    assert.equal((await call(s.cli, { path: '/status' })).status, 200)
  } finally { s.close() }
})
