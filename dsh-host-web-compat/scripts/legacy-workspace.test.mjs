import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { createLegacyWorkspace } from '../lib/legacy-workspace.js'

async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-legacy-workspace-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const root = join(scratch, 'public')
  const home = join(scratch, 'private')
  for (const dir of ['Download', 'Documents', 'Android', '.hidden', '项目 A']) {
    await mkdir(join(root, dir), { recursive: true })
  }
  await mkdir(home)
  await symlink(home, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(root, 'not-a-folder.txt'), 'keep')
  return { root, home, scratch, picker: createLegacyWorkspace(root, home) }
}

test('shows public folders and shortcuts, but never files, Android data or external links', async (t) => {
  const { root, picker } = await fixture(t)
  const rootLevel = await picker.list()
  assert.equal(rootLevel.parent, null)
  assert.deepEqual(rootLevel.entries.map(({ name }) => name), ['Documents', 'Download', '项目 A'])
  assert.equal((await picker.list(rootLevel.entries[2].path)).parent, root)
})

test('manual entry and confirmation reject traversal, a sibling prefix, and a symlink escape', async (t) => {
  const { root, scratch, picker } = await fixture(t)
  for (const path of ['content://tree/a', root + sep + '..', join(scratch, 'public2'),
    join(root, 'Android'), join(root, 'escape')]) {
    await assert.rejects(picker.list(path), { code: 'invalid-path' })
    await assert.rejects(picker.select(path), { code: 'invalid-path' })
  }
  await assert.rejects(picker.select(root), { code: 'invalid-path' })
  await assert.rejects(picker.select(join(root, 'missing')), { code: 'ENOENT' })
  const folder = join(root, '项目 A')
  assert.equal(await picker.select(folder), folder)
  assert.deepEqual(await readdir(folder), [], 'the write probe must leave no file behind')
})

test('private fallback works when public storage is unavailable and cannot follow a replaced directory', async (t) => {
  const { root, home, scratch } = await fixture(t)
  const picker = createLegacyWorkspace(join(scratch, 'not-mounted'), home)
  await assert.rejects(picker.list(), { code: 'ENOENT' })
  const selected = await picker.select(null, true)
  assert.equal(selected, join(home, '.dsh', 'workspaces', 'Temporary Workspace'))
  assert.equal(await picker.select(null, true), selected)
  assert.deepEqual(await readdir(selected), [])
  await rmdir(selected)
  await symlink(join(root, 'Download'), selected, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(picker.select(null, true), { code: 'invalid-path' })
})
