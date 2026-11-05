// id 解析失败的提示不得把「形态用错」一律说成「页面已变化」（2026-10-28 自查）。
//
// 缓存键（byId）是剪枝后的重编号 n0/n1…，而壳侧原始 id 是 "0"、"0.1" 这种。模型若拿
// dump 结果里看不到的原始形态来引用（id:0.1），旧提示一律说「页面可能已变化——请重新取树」；
// 重新取树后 id:0.1 仍然找不到（缓存键永远是 nN）⇒ 死循环引导，而且掩盖了真正的修法
// （直接用本次取树返回的 nN 形态）。与 #763/#745 同族：文案与真实状态必须同口径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUiTreeXml, pruneNodes, resolveRef } from '../lib/ui-tree.js'

const ATTRS = 'checkable="false" checked="false" enabled="true" focusable="false" focused="false" ' +
  'long-clickable="false" password="false" selected="false" package="com.android.settings"'

function hierarchy(inner) {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy rotation="0">${inner}</hierarchy>`
}

const XML = hierarchy(
  `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ${ATTRS} ` +
    `clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
    `<node index="1" text="确定" resource-id="x:id/btn" class="android.widget.Button" ${ATTRS} ` +
      `clickable="true" scrollable="false" bounds="[100,200][300,400]" />` +
  `</node>`,
)

function make() {
  const { raw } = parseUiTreeXml(XML)
  return pruneNodes(raw)
}

test('id 形态用错时点名「两种可能」并给出本次取树的真实 id 形态', () => {
  const { nodes, byId } = make()
  const hit = resolveRef(byId, nodes, 'id:0.1')
  assert.equal(hit.ok, false)
  assert.match(hit.error, /id 形态用错/)
  assert.match(hit.error, /形如 n0/)
  assert.match(hit.error, /页面已变化/)
  // 两种成因都在，且不再把「重新取树」当成唯一指引。
  assert.match(hit.error, /android_ui_dump/)
})

test('正确形态仍照常命中（回归护栏）', () => {
  const { nodes, byId } = make()
  const hit = resolveRef(byId, nodes, 'id:n1')
  assert.equal(hit.ok, true)
  assert.equal(hit.node.text, '确定')
})

test('错误提示里的样例 id 取自真实缓存键（不是写死的）', () => {
  const { nodes, byId } = make()
  const hit = resolveRef(byId, nodes, 'id:bogus')
  assert.equal(hit.ok, false)
  // 缓存的第一个节点 id（预序首节点 n0）必须出现在提示里，证明样例来自本次取树。
  assert.ok(hit.error.includes(nodes[0].id), `提示应含真实 id 形态 ${nodes[0].id}`)
})
