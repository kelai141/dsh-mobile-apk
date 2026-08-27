// snapshot-server.mjs — M2b test helper: serves the manifest + snapshot on host port 8899.
// The emulator reaches the host via 10.0.2.2. Usage: node scripts/snapshot-server.mjs
import { createServer } from 'node:http'
import { readFileSync, statSync, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const SNAP = join(root, 'dsh-mobile-apk/snapshot/snapshot.tar.xz')
const PORT = 8899

const size = statSync(SNAP).size
const sha256 = createHash('sha256').update(readFileSync(SNAP)).digest('hex')

createServer((req, res) => {
  if (req.url === '/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: 'http://10.0.2.2:8899/snapshot.tar.xz', size, sha256 }))
  } else if (req.url === '/snapshot.tar.xz') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size })
    createReadStream(SNAP).pipe(res)
  } else {
    res.writeHead(404)
    res.end()
  }
}).listen(PORT, () => console.log('snapshot server on :' + PORT, '(manifest sha ' + sha256.slice(0, 12) + '…)'))
