import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizeMobileRoute, enginePortFromEnv, loopbackAuthorities } from '../lib/route-auth.js'

test('port fallback authorizes only the actual selected endpoint, including late env publication', () => {
  const previous = process.env.DSH_ENGINE_PORT
  const token = 'engine-port-test-token'
  const auth = (host, origin) => authorizeMobileRoute({ headers: { host, origin, 'x-dsh-control-token': token } }, { token: () => token })
  try {
    delete process.env.DSH_ENGINE_PORT
    assert.equal(enginePortFromEnv(), 4145)
    assert.equal(auth('127.0.0.1:4145'), undefined)
    assert.equal(auth('127.0.0.1:3080')?.code, 403)
    process.env.DSH_ENGINE_PORT = '55231'
    assert.deepEqual(loopbackAuthorities(), ['127.0.0.1:55231', 'localhost:55231'])
    assert.equal(auth('127.0.0.1:55231', 'http://127.0.0.1:55231'), undefined)
    assert.equal(auth('127.0.0.1:4145')?.code, 403)
    assert.equal(auth('127.0.0.1:55231', 'http://127.0.0.1:4145')?.code, 403)
    for (const raw of ['0', '', ' 55231', '+55231', '55231.5', '80', '65536', 'not-a-port']) {
      process.env.DSH_ENGINE_PORT = raw
      assert.deepEqual(loopbackAuthorities(), [], raw)
      assert.equal(auth('127.0.0.1:4145')?.code, 403, raw)
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_ENGINE_PORT
    else process.env.DSH_ENGINE_PORT = previous
  }
})
