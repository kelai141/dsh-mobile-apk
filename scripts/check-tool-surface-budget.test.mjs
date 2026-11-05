import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PLUGINS, NO_LIB_ARTIFACT } from '../scripts/lib/tool-surface-plugins.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('清单等于 plugins/* 下带 package.json 的目录集合减去带理由的豁免', () => {
  const actual = readdirSync(join(ROOT, 'plugins'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'plugins', e.name, 'package.json')))
    .map((e) => e.name)
    .filter((name) => NO_LIB_ARTIFACT[name] === undefined)
    .sort()
  assert.deepEqual([...PLUGINS].sort(), actual)
})

test('不再遗漏 session-delete', () => {
  assert.ok(PLUGINS.includes('dsh-session-delete'), '实际: ' + PLUGINS.join(', '))
})

test('大于旧的 6 个', () => {
  assert.ok(PLUGINS.length > 6, '实际 ' + PLUGINS.length)
})