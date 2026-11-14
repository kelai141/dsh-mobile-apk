import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PLUGINS, NO_LIB_ARTIFACT, retiredPluginNames } from '../scripts/lib/tool-surface-plugins.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('清单等于 plugins/* 下带 package.json 的目录集合减去带理由的豁免与退役目录', () => {
  const retired = retiredPluginNames(ROOT)
  const actual = readdirSync(join(ROOT, 'plugins'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'plugins', e.name, 'package.json')))
    .map((e) => e.name)
    .filter((name) => NO_LIB_ARTIFACT[name] === undefined && !retired.has(name))
    .sort()
  assert.deepEqual([...PLUGINS].sort(), actual)
})

test('不再遗漏 session-delete', () => {
  assert.ok(PLUGINS.includes('dsh-session-delete'), '实际: ' + PLUGINS.join(', '))
})

test('退役的旧手机插件不得进预算集（旧 manage/vdisplay 已从装配集移除）', () => {
  for (const name of ['dsh-android-manage', 'dsh-android-vdisplay']) {
    assert.ok(!PLUGINS.includes(name), name + ' 仍被算进模型面预算；实际: ' + PLUGINS.join(', '))
    assert.ok(retiredPluginNames(ROOT).has(name), name + ' 必须登记在 plugin-dirs.json 的 retiredDirs')
  }
})

test('新手机工具面插件在场（切流后的唯一手机工具注册者）', () => {
  assert.ok(PLUGINS.includes('dsh-android-phone-control'), '实际: ' + PLUGINS.join(', '))
})

test('退役目录从 plugin-dirs.json 读，不在门禁里另写一份名单', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts', 'plugin-dirs.json'), 'utf8'))
  const expected = new Set((manifest.retiredDirs ?? []).map((dir) => dir.split(/[\\/]/).pop()))
  assert.deepEqual([...retiredPluginNames(ROOT)].sort(), [...expected].sort())
  // 单边写死：门禁文件里不得再出现退役包名的字面清单。
  const gate = readFileSync(join(ROOT, 'scripts', 'check-tool-surface-budget.mjs'), 'utf8')
  assert.ok(!/dsh-android-manage/.test(gate), '预算门禁不得再硬编码退役插件名')
})

test('预算基线保留历史锚点，且当前值不高于历史峰值', () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, 'scripts', 'tool-surface-budget.json'), 'utf8'))
  assert.ok(Array.isArray(baseline.history) && baseline.history.length > 0,
    '基线必须留 history：退役带来的下降要能看出「历史更贵过」，否则等于抹掉审计痕迹')
  const peak = Math.max(...baseline.history.map((h) => Number(h.baseline) || 0))
  assert.ok(baseline.baseline <= peak, '当前基线 ' + baseline.baseline + ' B 高于历史峰值 ' + peak + ' B')
  assert.ok(typeof baseline.conditionalTools !== 'undefined', '基线必须登记条件注册工具名')
  assert.ok(Array.isArray(baseline.visibleTools) && baseline.visibleTools.length > 0, '基线必须登记常驻工具名')
})

test('手机工具面逐名登记，且与实跑 lib 一致（数量相同换了工具也会判红）', () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, 'scripts', 'tool-surface-budget.json'), 'utf8'))
  assert.ok(Array.isArray(baseline.phoneTools) && baseline.phoneTools.length > 0,
    '基线必须登记 phoneTools 清单：只守数量会放过「IME 输入换成原生 keyEvent」这类同数量变更')
  const perPlugin = baseline.perPlugin?.['dsh-android-phone-control']
  assert.ok(perPlugin !== undefined, '基线必须留 phone-control 分量')
  assert.equal(baseline.phoneTools.length, perPlugin.count,
    'phoneTools 条数必须等于 perPlugin 计数（'+ baseline.phoneTools.length + ' vs ' + perPlugin.count + '）')
  const conditional = new Set(baseline.conditionalTools ?? [])
  const visible = new Set(baseline.visibleTools ?? [])
  for (const name of baseline.phoneTools) {
    assert.ok(conditional.has(name) || visible.has(name), name + ' 必须落在条件注册或常驻清单之一')
  }
  // 旧执行器的工具名不得出现在任何清单里。
  for (const legacy of ['android_ui_tree', 'android_act_input', 'android_click', 'android_ime_switch']) {
    assert.ok(!baseline.phoneTools.includes(legacy), legacy + ' 已退役，不得进基线')
  }
  // 工具总数不写死（主构建的清单为准）：只钉「文本输入这个入口还在」，
  // 它同时承载文字与 Input.key，是手机工具面不可缺的那一项。
  assert.ok(baseline.phoneTools.includes('android_ui_input'), 'android_ui_input 必须登记（文本与按键共用入口）')
  assert.ok(baseline.phoneTools.length >= 15, 'phoneTools 明显偏少（' + baseline.phoneTools.length + '），疑似基线被裁剪')
})
