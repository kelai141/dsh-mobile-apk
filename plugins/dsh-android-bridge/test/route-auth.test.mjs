import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  authorizeMobileRoute,
  sendMobileRouteRejection,
} from '../lib/route-auth.js'

const token = 'mobile-route-token-123'
const localHeaders = { host: '127.0.0.1:4145' }
const request = (headers) => ({ headers })

function response() {
  return {
    code: 0,
    headers: {},
    body: undefined,
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(body) { this.body = body },
  }
}

test('connection owns configured authorities and browser-session acceptance', () => {
  const dynamicAuthority = request({ host: 'dsh.example.test:9443' })
  const accepted = authorizeMobileRoute(dynamicAuthority, {
    token: () => undefined,
    connection: { requestRejection: () => undefined },
  })
  assert.equal(accepted, undefined)
})

test('connection 403 cannot be bypassed by a valid control token', () => {
  const rejected = authorizeMobileRoute(
    request({ host: 'attacker.invalid', 'x-dsh-control-token': token }),
    { token: () => token, connection: { requestRejection: () => 403 } },
  )
  assert.deepEqual(rejected, { code: 403, body: '' })
})

test('connection 401 accepts the current control token but rejects a bad token', () => {
  const options = { token: () => token, connection: { requestRejection: () => 401 } }
  assert.equal(authorizeMobileRoute(request({ ...localHeaders, 'x-dsh-control-token': token }), options), undefined)
  assert.deepEqual(authorizeMobileRoute(request({ ...localHeaders, 'x-dsh-control-token': 'wrong-token' }), options), {
    code: 401,
    body: JSON.stringify({ ok: false, error: 'unauthorized' }),
  })
})

test('connection-free fallback is loopback-only and requires a token', () => {
  const options = { token: () => token }
  assert.equal(authorizeMobileRoute(request({ ...localHeaders, 'x-dsh-control-token': token }), options), undefined)
  assert.deepEqual(authorizeMobileRoute(request({ ...localHeaders }), options)?.code, 401)
  assert.deepEqual(authorizeMobileRoute(request({ host: 'attacker.invalid', 'x-dsh-control-token': token }), options), { code: 403, body: '' })
  assert.deepEqual(authorizeMobileRoute(request({ ...localHeaders, origin: 'https://attacker.invalid', 'x-dsh-control-token': token }), options), { code: 403, body: '' })
})

test('rejection writer produces no-store 401 JSON and empty 403 responses', () => {
  const unauthorized = response()
  sendMobileRouteRejection(unauthorized, { code: 401, body: JSON.stringify({ ok: false, error: 'unauthorized' }) })
  assert.equal(unauthorized.code, 401)
  assert.equal(unauthorized.headers['cache-control'], 'no-store')
  assert.equal(unauthorized.headers['content-type'], 'application/json; charset=utf-8')
  assert.match(unauthorized.body, /unauthorized/)

  const forbidden = response()
  sendMobileRouteRejection(forbidden, { code: 403, body: '' })
  assert.equal(forbidden.code, 403)
  assert.equal(forbidden.headers['cache-control'], 'no-store')
  assert.equal(forbidden.body, undefined)
})
