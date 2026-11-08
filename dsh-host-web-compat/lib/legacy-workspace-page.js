// Loaded as an inline classic script. Keep syntax compatible with Chromium 87.
export function openLegacyWorkspacePicker(request, send, requestPermission) {
  var previous = document.activeElement
  var zh = /^zh\b/i.test(document.documentElement.lang || navigator.language || '')
  function tr(zhText, enText) { return zh ? zhText : enText }
  function el(tag, text, className) {
    var node = document.createElement(tag)
    if (text) node.textContent = text
    if (className) node.className = className
    return node
  }
  function button(label, action) {
    var item = el('button', label)
    item.type = 'button'
    item.onclick = action
    return item
  }
  var overlay = el('div', null, 'dsh-legacy-workspace-mask')
  var dialog = el('section', null, 'dsh-legacy-workspace')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'dsh-legacy-workspace-title')
  var heading = el('h2', tr('选择工作区文件夹', 'Choose a workspace folder'))
  heading.id = 'dsh-legacy-workspace-title'
  var pathLabel = el('p', null, 'dsh-legacy-workspace-path')
  var form = el('form', null, 'dsh-legacy-workspace-form')
  var pathInput = el('input')
  pathInput.type = 'text'
  pathInput.autocapitalize = 'off'
  pathInput.spellcheck = false
  pathInput.maxLength = 4096
  pathInput.placeholder = tr('输入文件夹的完整路径', 'Enter the full folder path')
  pathInput.setAttribute('aria-label', pathInput.placeholder)
  var go = el('button', tr('前往', 'Go'))
  go.type = 'submit'
  form.append(pathInput, go)
  form.hidden = true
  form.onsubmit = function(event) {
    event.preventDefault()
    if (pathInput.value.trim()) load(pathInput.value.trim(), true)
  }
  var toolbar = el('div', null, 'dsh-legacy-workspace-actions')
  var parent = button(tr('上一级', 'Parent folder'), function() { if (level && level.parent) load(level.parent) })
  var manual = button(tr('手动输入路径', 'Enter path manually'), function() {
    form.hidden = !form.hidden
    manual.setAttribute('aria-expanded', String(!form.hidden))
    if (!form.hidden) {
      pathInput.value = level ? level.path + '/' : ''
      pathInput.focus()
    }
  })
  manual.setAttribute('aria-expanded', 'false')
  toolbar.append(parent, manual)
  var status = el('p', null, 'dsh-legacy-workspace-status')
  status.setAttribute('role', 'status')
  var grant = button(tr('允许访问公共存储', 'Allow storage access'), function() {
    if (permissionInFlight) return
    permissionInFlight = true
    grant.disabled = true
    try { requestPermission() } catch (_) { refreshAfterGrant(); return }
    grantTimer = setTimeout(refreshAfterGrant, 30000)
  })
  grant.hidden = true
  var folders = el('ul', null, 'dsh-legacy-workspace-list')
  folders.setAttribute('aria-label', tr('文件夹', 'Folders'))
  var footer = el('div', null, 'dsh-legacy-workspace-actions')
  var cancel = button(tr('取消', 'Cancel'), function() { settle(null, false) })
  cancel.className = 'closeButton'
  var temporary = button(tr('先用临时工作区', 'Use a temporary workspace'), function() { settle(null, true) })
  var confirm = button(tr('使用此文件夹', 'Use this folder'), function() { if (level) settle(level.path, false) })
  confirm.className = 'dsh-legacy-workspace-primary'
  footer.append(cancel, temporary, confirm)
  dialog.append(heading, pathLabel, toolbar, form, status, grant, folders, footer)
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  var level = null
  var closed = false
  var busy = false
  var loading = false
  var generation = 0
  var permissionInFlight = false
  var grantTimer
  var expiry = setTimeout(function() { settle(null, false) }, 5 * 60 * 1000)
  var loadAbort

  function controls() {
    parent.disabled = busy || loading || !level || !level.parent
    confirm.disabled = busy || loading || !level || !level.parent
    temporary.disabled = busy
    cancel.disabled = busy
  }
  function message(code) {
    switch (code) {
      case 'permission': return tr('无法访问这个文件夹。请允许存储权限、换一个文件夹，或先用临时工作区。',
        'This folder cannot be accessed. Allow storage access, choose another folder, or use a temporary workspace.')
      case 'read-only': return tr('此文件夹只读，请选择可写的文件夹。', 'This folder is read-only. Choose a writable folder.')
      case 'invalid-path': return tr('请选择当前用户公共存储里的子文件夹。', 'Choose a folder inside the current user’s public storage.')
      case 'missing': return tr('找不到这个文件夹，请检查路径。', 'Folder not found. Check the path and try again.')
      default: return tr('暂时无法访问工作区，请重试。', 'Could not access the workspace. Try again.')
    }
  }
  function failed(code) {
    status.textContent = message(code)
    grant.hidden = code !== 'permission'
  }
  function draw() {
    pathLabel.textContent = level.parent ? level.path : tr('公共存储', 'Public storage')
    folders.textContent = ''
    level.entries.forEach(function(entry) {
      var row = el('li')
      row.appendChild(button(entry.name, function() { load(entry.path) }))
      folders.appendChild(row)
    })
    status.textContent = level.truncated ? tr('文件夹太多，试试直接输入路径。', 'Too many folders to show. Try entering the path directly.')
      : level.entries.length === 0 ? tr('没有子文件夹。', 'No subfolders.') : ''
    grant.hidden = true
  }
  function load(path, submitted) {
    if (closed || busy) return
    var ticket = ++generation
    if (loadAbort) loadAbort.abort()
    loadAbort = new AbortController()
    loading = true
    status.textContent = tr('正在读取文件夹…', 'Loading folders…')
    controls()
    send('list', request, { path: path }, loadAbort.signal).then(function(result) {
      if (closed || ticket !== generation) return
      if (!result.ok) { failed(result.error); return }
      level = result.listing
      if (submitted) {
        form.hidden = true
        manual.setAttribute('aria-expanded', 'false')
        manual.focus()
      }
      draw()
    }, function() {
      if (!closed && ticket === generation) failed('unavailable')
    }).then(function() {
      if (closed || ticket !== generation) return
      loading = false
      controls()
    })
  }
  function close() {
    if (closed) return
    closed = true
    clearTimeout(grantTimer)
    clearTimeout(expiry)
    if (loadAbort) loadAbort.abort()
    window.removeEventListener('dsh-legacy-storage-result', refreshAfterGrant)
    overlay.remove()
    if (previous && previous.isConnected) previous.focus()
  }
  function settle(path, useTemporary) {
    if (closed || busy) return
    busy = true
    controls()
    send('result', request, { path: path, temporary: useTemporary }).then(function(result) {
      if (result.ok || result.error === 'expired') { close(); return }
      failed(result.error)
    }, function() { failed('unavailable') }).then(function() { busy = false; if (!closed) controls() })
  }
  function refreshAfterGrant() {
    if (!permissionInFlight) return
    clearTimeout(grantTimer)
    permissionInFlight = false
    grant.disabled = false
    load(level ? level.path : undefined)
  }
  window.addEventListener('dsh-legacy-storage-result', refreshAfterGrant)
  overlay.onclick = function(event) { if (event.target === overlay) settle(null, false) }
  dialog.onkeydown = function(event) {
    if (event.key === 'Escape') { event.stopPropagation(); settle(null, false) }
    if (event.key === 'Tab') {
      var enabled = Array.from(dialog.querySelectorAll('button,input')).filter(function(item) {
        return !item.disabled && item.getClientRects().length > 0
      })
      var next = event.shiftKey ? enabled[enabled.length - 1] : enabled[0]
      if (document.activeElement === (event.shiftKey ? enabled[0] : enabled[enabled.length - 1])) {
        event.preventDefault()
        if (next) next.focus()
      }
    }
  }
  load()
  cancel.focus()
  return close
}

export const legacyWorkspaceStyle = `<style>
.dsh-legacy-workspace-mask{position:fixed;inset:0;display:grid;place-items:center;padding:12px;background:#0007;z-index:2147483000}
.dsh-legacy-workspace{box-sizing:border-box;width:min(100%,480px);max-height:calc(100vh - 24px);overflow:auto;display:flex;flex-direction:column;gap:8px;padding:16px;border-radius:8px;background:var(--surface,white);color:var(--text,#202124);box-shadow:0 8px 35px #0005}
:root[data-theme=dark] .dsh-legacy-workspace{background:#232426;color:#f4f4f5}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]) .dsh-legacy-workspace{background:#232426;color:#f4f4f5}}
.dsh-legacy-workspace [hidden]{display:none!important}
.dsh-legacy-workspace h2,.dsh-legacy-workspace p{margin:0}
.dsh-legacy-workspace h2{font-size:18px}
.dsh-legacy-workspace-path,.dsh-legacy-workspace-status{font-size:14px;overflow-wrap:anywhere}
.dsh-legacy-workspace-actions,.dsh-legacy-workspace-form{display:flex;gap:6px;flex-wrap:wrap}
.dsh-legacy-workspace button,.dsh-legacy-workspace input{font:inherit;color:inherit;min-height:44px;box-sizing:border-box;border:1px solid #8885;border-radius:8px;padding:6px 10px;background:transparent}
.dsh-legacy-workspace button{cursor:pointer}
.dsh-legacy-workspace button:disabled{opacity:.48;cursor:default}
.dsh-legacy-workspace input{flex:1;min-width:0}
.dsh-legacy-workspace .dsh-legacy-workspace-primary{background:#315cca;color:white}
.dsh-legacy-workspace-list{min-height:0;max-height:40vh;overflow:auto;margin:0;padding:0;list-style:none}
.dsh-legacy-workspace-list button{width:100%;text-align:start;margin:2px 0;overflow-wrap:anywhere}
</style>`
