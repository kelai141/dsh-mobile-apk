/**
 * Client half: a "Delete conversation" item in the session row menu.
 *
 * The engine has no delete action (issue #493), so the item asks the host route
 * (`POST /api/session-delete`) to remove the stored session. The host unloads the
 * session from its live set first (so sidebar/search/history drop it through the
 * engine's own `api-session/removed`) and only then deletes the files. Deletion is
 * irreversible and always confirmed in a modal — never `window.confirm`, which the
 * Android shell auto-approves.
 */
;(function () {
  try {
    window.__ModuleLoader__.load({
      id: '@dsh-android/dsh-session-delete',
      factory: function (require) {
        var module = { exports: {} }
        var exports = module.exports
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

        var react = require('react')
        var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        var h = react.createElement

        var NS = 'session-delete'
        /** Same tag as the host half so device logs can be grepped by one string. */
        var TAG = '[dsh-session-delete]'
        /** 构建戳：build.mjs 用源码哈希替换；与宿主 /api/session-delete-version 比对。 */
        var BUILD_STAMP = '__BUILD_STAMP__'
        /**
         * Session currently rendered on screen.
         *
         * `[data-conversation-session]` is the conversation body's own id (present for
         * the main view and for panels); the `<html data-dsh-session-id>` marker is the
         * shell's hint and is only a fallback.
         * @returns {string|null} mounted session id.
         */
        function mountedSessionId() {
          var body = document.querySelector('[data-conversation-session]')
          if (body !== null) {
            var fromBody = body.getAttribute('data-conversation-session')
            if (fromBody !== null && fromBody !== '') return fromBody
          }
          return document.documentElement.getAttribute('data-dsh-session-id')
        }

        /**
         * Per-attempt timeout. A local delete answers in ~20ms; anything slower than
         * this is a dead keep-alive socket left over from an engine restart, and
         * aborting it makes the browser drop that socket. 2s keeps the dialog honest
         * without making the user wait for the OS TCP timeout.
         */
        var REQUEST_TIMEOUT_MS = 2000
        /** Attempts per click: first try plus two fresh-connection retries. */
        var MAX_ATTEMPTS = 3

        /**
         * POST the delete request with a hard timeout.
         *
         * The WebView can hold a keep-alive connection to an engine process that
         * just restarted; the request then never reaches the new process and the
         * dialog would sit on「正在删除…」forever (measured: zero route hits in
         * engine.log while curl answered in 13 ms).
         * @param {string} sessionId - session to delete.
         * @returns {Promise<{ok: boolean, status: number, json: () => Promise<object>}>} XHR result.
         */
        function postDelete(sessionId, action) {
          // 用 XHR 而不是 fetch：XHR 的 timeout 由浏览器网络栈保证触发，fetch 的
          // AbortSignal 在部分 WebView 上对已入队/半开连接不生效（现场：弹窗无限转）。
          return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/session-delete', true)
            xhr.setRequestHeader('content-type', 'application/json')
            // issue #912：action 缺省即 delete（服务端同样缺省），隔离显式传 'quarantine'。
            xhr.timeout = REQUEST_TIMEOUT_MS
            xhr.onload = function () {
              resolve({
                ok: xhr.status >= 200 && xhr.status < 300,
                status: xhr.status,
                json: function () {
                  try {
                    return Promise.resolve(JSON.parse(xhr.responseText || '{}'))
                  } catch (_) {
                    return Promise.resolve({})
                  }
                },
              })
            }
            xhr.onerror = function () {
              var error = new Error('network error')
              error.name = 'NetworkError'
              reject(error)
            }
            xhr.ontimeout = function () {
              var error = new Error('request timed out after ' + REQUEST_TIMEOUT_MS + 'ms')
              error.name = 'TimeoutError'
              reject(error)
            }
            xhr.onabort = function () {
              var error = new Error('request aborted')
              error.name = 'AbortError'
              reject(error)
            }
            xhr.send(JSON.stringify(action === undefined ? { sessionId: sessionId } : { sessionId: sessionId, action: action }))
          })
        }

        /**
         * #510：续做失败的可见反馈。apply 作用域拿不到确认框的 props.t，用本文件
         * 自己的 zh/en 词典按页面语言取词（与 ctx.locale.register 同一份源）。
         */
        function resumeText(code, fallback) {
          var english = (navigator.language || 'zh').toLowerCase().indexOf('zh') !== 0
          var dict = english ? en : zh
          var key = code === 'session-active' ? 'error.active'
            : code === 'activity-unknown' ? 'error.unknown'
              : code === 'unload-failed' ? 'error.unload'
                : code === 'not-found' ? 'error.gone'
                  : null
          return (key !== null ? dict[key] : '') || (dict['error'].replace('{message}', fallback))
        }

        /** 固定 toast（黑底白字 5s 自消；form 与上游错误条一致，无 window.alert——壳会自动放行 alert）。 */
        function showResumeNotice(message) {
          try {
            var id = 'dsh-session-delete-resume-notice'
            var el = document.getElementById(id)
            if (!el) {
              el = document.createElement('div')
              el.id = id
              el.setAttribute('role', 'alert')
              el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:16px;z-index:2147483000;padding:10px 12px;border-radius:8px;background:rgba(20,20,20,.92);color:#fff;font-size:13px;line-height:1.4;box-shadow:0 4px 16px rgba(0,0,0,.3)'
              document.body.appendChild(el)
            }
            el.textContent = message
            setTimeout(function () { try { el.remove() } catch (e) {} }, 5000)
          } catch (e) { /* 反馈失败不影响已完成的放弃待办 */ }
        }

        /**
         * Report the post-delete navigation decision to the host log.
         * @param {object} payload - decision details.
         */
        function reportTrace(payload) {
          try {
            var init = {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }
            // 诊断请求也带超时：一条挂死的 trace 会占住浏览器连接池的槽位，
            // 反而拖慢真正的删除请求。
            if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
              init.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            }
            fetch('/api/session-delete-trace', init).catch(function () {})
          } catch (_) {
            /* diagnostics only */
          }
        }

        /**
         * 把服务端错误码翻成界面文案；未知码原样显示。
         * @param {Function} t - locale-bound translator.
         * @param {string|undefined} code - server error code.
         * @param {string} fallback - server message.
         * @returns {string} user-facing text.
         */
        function errorText(t, code, fallback) {
          var key = code === 'session-active' ? 'error.active'
            : code === 'activity-unknown' ? 'error.unknown'
              : code === 'unload-failed' ? 'error.unload'
                : code === 'not-found' ? 'error.gone'
                  : null
          if (key === null) return fallback
          return typeof t === 'function' ? t(key) : fallback
        }

        /**
         * Client-side trace (browser console; visible over CDP).
         * @param {'info'|'warn'|'error'} level - severity.
         * @param {string} message - step description.
         * @param {object} [extra] - structured fields.
         */
        function trace(level, message, extra) {
          var line = TAG + ' ' + message
          if (level === 'error') console.error(line, extra === undefined ? '' : extra)
          else if (level === 'warn') console.warn(line, extra === undefined ? '' : extra)
          else console.info(line, extra === undefined ? '' : extra)
        }
        var zh = {
          'menu.delete': '删除对话',
          'confirm.title': '删除对话',
          'confirm.desc': '「{title}」将从磁盘永久删除，无法恢复。',
          'cancel': '取消',
          'delete': '删除',
          'deleting': '正在删除…',
          'error': '删除失败：{message}',
          'error.active': '这条对话正在运行，请先停止再删除。',
          'error.unknown': '无法确认这条对话是否空闲，已拒绝删除。',
          'error.unload': '无法从内存卸载这条对话，未删除任何文件。请稍后重试。',
          'error.gone': '这条对话已经不在了。',
          'close': '关闭',
          // issue #912：隔离不是删除 —— 文案必须让人一眼看出文件还在。
          'menu.quarantine': '隔离（不删除，可恢复）',
          'confirm.quarantineTitle': '隔离这条对话',
          'confirm.quarantineDesc': '「{title}」会移到同目录的 .corrupt/ 下：它从列表里消失，但文件仍在、随时可恢复。',
          'quarantining': '正在隔离…',
          'quarantine.ok': '已隔离到：{path}（文件仍在，可恢复）',
          'error.alreadyQuarantined': '这条对话已经隔离过了，文件仍在：{path}',
        }
        var en = {
          'menu.delete': 'Delete conversation',
          'confirm.title': 'Delete conversation',
          'confirm.desc': '"{title}" will be permanently deleted from disk. This cannot be undone.',
          'cancel': 'Cancel',
          'delete': 'Delete',
          'deleting': 'Deleting…',
          'error': 'Delete failed: {message}',
          'error.active': 'This conversation is running. Stop it before deleting.',
          'error.unknown': 'Could not confirm the conversation is idle, so it was not deleted.',
          'error.unload': 'Could not unload this conversation from memory, so nothing was deleted. Try again later.',
          'error.gone': 'This conversation no longer exists.',
          'close': 'Close',
          'menu.quarantine': 'Quarantine (keeps files, restorable)',
          'confirm.quarantineTitle': 'Quarantine this conversation',
          'confirm.quarantineDesc': '"{title}" moves into .corrupt/ next to it: it leaves the list, but the files stay and can be restored.',
          'quarantining': 'Quarantining…',
          'quarantine.ok': 'Quarantined to: {path} (files kept, restorable)',
          'error.alreadyQuarantined': 'This conversation is already quarantined; the files are kept at: {path}',
        }

        var cancelStyle = {
          minHeight: '34px',
          padding: '0 14px',
          borderRadius: 'var(--dsw-radius-md)',
          border: '1px solid var(--dsw-alias-border-l3)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          font: 'inherit',
          fontSize: '13px',
          cursor: 'pointer',
        }
        var deleteStyle = {
          minHeight: '34px',
          padding: '0 14px',
          borderRadius: 'var(--dsw-radius-md)',
          border: '1px solid transparent',
          background: 'var(--dsw-alias-state-error-primary)',
          color: 'var(--dsw-alias-label-primary-foreground)',
          font: 'inherit',
          fontSize: '13px',
          cursor: 'pointer',
        }

        /** 待办删除：请求卡死时先重载页面，重载后自动续做（幂等）。 */
        var PENDING_KEY = 'dsh.session-delete.pending'
        /** 客户端步骤留痕（localStorage，断网也能读；诊断用）。 */
        var TRACE_KEY = 'dsh.session-delete.trace'
        /** 请求看门狗：超过这个时间还没结果就重载页面重建连接。 */
        var WATCHDOG_MS = 4000

        /**
         * 本地留痕：不依赖网络，写入 WebView 的 localStorage（可被现场取证）。
         * @param {string} step - 步骤名。
         * @param {object} [extra] - 附加字段。
         */
        function localTrace(step, extra) {
          try {
            var raw = window.localStorage.getItem(TRACE_KEY)
            var list = raw === null ? [] : JSON.parse(raw)
            if (!Array.isArray(list)) list = []
            list.push({ at: Date.now(), step: step, extra: extra === undefined ? null : extra })
            window.localStorage.setItem(TRACE_KEY, JSON.stringify(list.slice(-60)))
          } catch (_) {
            /* 诊断用，失败不影响功能 */
          }
        }

        /**
         * Resource Timing for our own API calls.
         *
         * Answers the question the server log cannot: was the request ever
         * *initiated* by the page? A pending entry has a growing duration; a
         * missing entry means fetch never left the renderer.
         * @returns {Array<object>} timing rows.
         */
        function apiResourceTiming() {
          try {
            return performance.getEntriesByType('resource')
              .filter(function (entry) { return entry.name.indexOf('/api/session-delete') !== -1 })
              .map(function (entry) {
                return {
                  path: entry.name.slice(entry.name.indexOf('/api/')),
                  startMs: Math.round(entry.startTime),
                  durationMs: Math.round(entry.duration),
                  transferSize: entry.transferSize,
                  initiator: entry.initiatorType,
                }
              })
          } catch (_) {
            return []
          }
        }

        /** @param {string} sessionId - 待办会话。 */
        function savePending(sessionId) {
          try {
            window.localStorage.setItem(PENDING_KEY, JSON.stringify({ sessionId: sessionId, at: Date.now() }))
          } catch (_) { /* ignore */ }
        }

        /** @returns {{sessionId: string, at: number}|null} 120 秒内的待办删除。 */
        function readPending() {
          try {
            var raw = window.localStorage.getItem(PENDING_KEY)
            if (raw === null) return null
            var value = JSON.parse(raw)
            if (value === null || typeof value !== 'object' || typeof value.sessionId !== 'string') return null
            if (!Number.isFinite(Number(value.at)) || Date.now() - Number(value.at) > 120000) {
              window.localStorage.removeItem(PENDING_KEY)
              return null
            }
            return value
          } catch (_) {
            return null
          }
        }

        function clearPending() {
          try { window.localStorage.removeItem(PENDING_KEY) } catch (_) { /* ignore */ }
        }
        /**
         * Pending deletion shared by the menu item and the overlay dialog.
         *
         * The menu item cannot own the dialog: selecting an item closes the menu,
         * which unmounts the item — a dialog rendered there would never appear.
         * The item only records the target; `shell.overlay` renders the confirm.
         */
        var pending = null
        var listeners = new Set()
        function setPending(next) {
          pending = next
          listeners.forEach(function (listener) { listener() })
        }
        function subscribe(listener) {
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        }
        function usePending() {
          return react.useSyncExternalStore(subscribe, function () { return pending })
        }

        /**
         * One delete attempt; retries on a timeout with a fresh connection.
         * @param {number} n - zero-based attempt index.
         * @returns {Promise<object>} server payload.
         */
        function attemptDelete(sessionId, n) {
          localTrace('attempt', { sessionId: sessionId, attempt: n })
          return postDelete(sessionId)
            .then(function (res) {
              return res.json().catch(function () { return {} }).then(function (data) {
                if (!res.ok || data.ok !== true) {
                  // 404 只有带着本路由的 error 码才算「已经删掉」；否则可能是宿主插件
                  // 没加载（路由不存在），不能把「没删」当成成功。
                  if (res.status === 404 && data.error === 'not-found') {
                    trace('warn', 'session already gone; treating as deleted', { sessionId: sessionId })
                    return { ok: true, sessionId: sessionId, alreadyGone: true }
                  }
                  var failure = new Error(data.message || data.error || ('HTTP ' + res.status))
                  failure.code = typeof data.error === 'string' ? data.error : 'http-' + res.status
                  throw failure
                }
                return data
              })
            })
            .catch(function (reason) {
              var retryable = reason && (reason.name === 'TimeoutError' || reason.name === 'AbortError' || reason.name === 'NetworkError')
              if (retryable && n + 1 < MAX_ATTEMPTS) {
                localTrace('attempt-timeout', { sessionId: sessionId, attempt: n })
                trace('warn', 'delete attempt timed out; retrying on a fresh connection', {
                  sessionId: sessionId,
                  attempt: n + 1,
                })
                reportTrace({ event: 'delete-retry', sessionId: sessionId, attempt: n + 1 })
                return attemptDelete(sessionId, n + 1)
              }
              throw reason
            })
        }

        /**
         * Post-delete bookkeeping: hide the row, then leave the deleted conversation.
         * @param {object} data - server payload.
         */
        function afterDeleted(sessionId, data) {
          // 删掉的是屏幕上的会话 → 主视图已无会话可显示，重载一次落到新对话。
          // 删掉的是「没加载过」的会话 → 引擎不会派发 api-session/removed（只有
          // session/disposed 才发），侧栏那一行会留在原地；这里再查一次 DOM，还在就重载。
          var mounted = mountedSessionId()
          var wasMounted = mounted === sessionId
          var report = {
            sessionId: sessionId,
            mountedBefore: mounted,
            alreadyGone: data !== undefined && data.alreadyGone === true,
            url: window.location.href,
          }
          if (wasMounted) {
            report.decision = 'reload-because-mounted'
            reportTrace(report)
            window.location.reload()
            return
          }
          // 给引擎的 api-session/removed 一点时间把行移除；仍在就重载（幂等、无副作用）。
          setTimeout(function () {
            var row = document.querySelector('[data-row-key="session:' + sessionId + '"]')
            report.rowStillPresent = row !== null
            report.decision = row === null ? 'row-removed-by-engine' : 'reload-because-row-remains'
            reportTrace(report)
            if (row !== null) window.location.reload()
          }, 400)
        }

        /**
         * Run the delete for one session and finish the UI transition.
         * @param {string} sessionId - target session.
         * @returns {Promise<void>} resolves after the post-delete transition started.
         */
        /**
         * issue #912：发起隔离。**不复用** [runDelete] 的重试与续做逻辑：
         * 删除有「404 视为已删」的幂等语义，隔离没有 —— 隔离的 409 `already-quarantined` 必须原样回给用户。
         * @param {string} sessionId - 会话 id。
         * @returns {Promise<object>} 服务端响应体（含 quarantinedTo）。
         */
        function runQuarantine(sessionId) {
          return postDelete(sessionId, 'quarantine').then(function (res) {
            return res.json().then(function (body) {
              if (!res.ok || body.ok === false) {
                var error = new Error(body.message || ('HTTP ' + res.status))
                error.code = body.error
                error.paths = body.paths
                throw error
              }
              return body
            })
          })
        }

        function runDelete(sessionId) {
          return attemptDelete(sessionId, 0).then(function (data) {
            localTrace('deleted', { sessionId: sessionId, alreadyGone: data.alreadyGone === true })
            clearPending()
            try {
              afterDeleted(sessionId, data)
            } catch (error) {
              localTrace('after-failed', { sessionId: sessionId, message: String(error && error.message ? error.message : error) })
            }
            return data
          })
        }

        /**
         * Menu item: opens the confirmation for this session.
         * @param {object} props - slot props (`sessionId`, `displayTitle`, `useMenuOpenState`, `t`).
         * @returns {object} React element.
         */
        function DeleteSessionMenuItem(props) {
          var setMenuOpen = props.useMenuOpenState()[1]
          var t = props.t
          return h(primitives.MenuItemButton, {
            danger: true,
            icon: h(primitives.IconTrashOutlineRegular, { size: 14 }),
            onSelect: function () {
              trace('info', 'menu item selected', { sessionId: props.sessionId })
              localTrace('menu-selected', { sessionId: props.sessionId })
              setMenuOpen(false)
              setPending({ sessionId: props.sessionId, title: props.displayTitle || props.sessionId })
            },
          }, t('menu.delete'))
        }

        /**
         * issue #912：隔离入口。文案刻意不含「删除」二字（除了「不删除」这句说明）——
         * 用户看到 `删除` 会以为历史没了，实际文件仍在。
         * @param {object} props - slot props（同 [DeleteSessionMenuItem]）。
         * @returns {object} React element.
         */
        function QuarantineSessionMenuItem(props) {
          var setMenuOpen = props.useMenuOpenState()[1]
          var t = props.t
          return h(primitives.MenuItemButton, {
            onSelect: function () {
              trace('info', 'quarantine item selected', { sessionId: props.sessionId })
              localTrace('quarantine-selected', { sessionId: props.sessionId })
              setMenuOpen(false)
              setPending({
                sessionId: props.sessionId,
                title: props.displayTitle || props.sessionId,
                kind: 'quarantine',
              })
            },
          }, t('menu.quarantine'))
        }

        /**
         * Overlay dialog: confirms and performs the deletion.
         * @param {object} props - slot props (`t`).
         * @returns {object|null} React element or null while idle.
         */
        function DeleteConfirmDialog(props) {
          var target = usePending()
          if (target === null) return null
          // key 换成会话 id：换一条对话时组件重新挂载，busy/error 不会从上一次
          // 删除残留过来（否则删完 A 再点 B，会直接看到 A 的错误）。
          return h(ConfirmSessionDelete, { key: target.sessionId, target: target, t: props.t })
        }

        /**
         * One session's confirmation dialog; remounted per session id.
         * @param {object} props - `target` (session + title) and `t`.
         * @returns {object} React element.
         */
        function ConfirmSessionDelete(props) {
          var t = props.t
          var target = props.target
          var busyPair = react.useState(false)
          var busy = busyPair[0]
          var setBusy = busyPair[1]
          var errorPair = react.useState(null)
          var error = errorPair[0]
          var setError = errorPair[1]
          // issue #912：隔离成功后要把**绝对路径**显示成可复制文本（用户要能自行备份/提 issue）。
          var donePair = react.useState(null)
          var done = donePair[0]
          var setDone = donePair[1]
          var quarantine = target.kind === 'quarantine'

          function close() {
            if (busy) return
            setError(null)
            setPending(null)
          }

          function confirmDelete() {
            var sessionId = target.sessionId
            trace('info', 'confirm accepted, sending request', { sessionId: sessionId })
            localTrace('confirm', {
              sessionId: sessionId,
              visibility: document.visibilityState,
              online: navigator.onLine,
              resourcesBefore: apiResourceTiming().length,
            })
            setBusy(true)
            setError(null)
            if (quarantine) {
              // 隔离不写待办、不挂看门狗、不重载页面：它不会留下「半完成」的文件状态，
              // 也不需要跨重载续做（服务端要么搬走了要么没动）。
              runQuarantine(sessionId)
                .then(function (body) { setBusy(false); setDone(body.quarantinedTo || '') })
                .catch(function (reason) {
                  setBusy(false)
                  var code = reason && reason.code
                  var path = reason && Array.isArray(reason.paths) && reason.paths.length > 0 ? reason.paths[reason.paths.length - 1] : ''
                  if (code === 'already-quarantined') { setDone(path); return }
                  setError(String(reason && reason.message ? reason.message : reason))
                })
              return
            }
            // 请求卡死时不再让弹窗无限转：落待办 + 看门狗，超时就重载页面，
            // 重载后插件自动续做这条删除（幂等：404 视为已删）。
            savePending(sessionId)
            var watchdog = setTimeout(function () {
              localTrace('watchdog-reload', {
                sessionId: sessionId,
                visibility: document.visibilityState,
                online: navigator.onLine,
                resources: apiResourceTiming(),
              })
              reportTrace({ event: 'watchdog-reload', sessionId: sessionId })
              window.location.reload()
            }, WATCHDOG_MS)
            runDelete(sessionId)
              .then(function (data) {
                clearTimeout(watchdog)
                localTrace('done', { sessionId: sessionId, resources: apiResourceTiming() })
                setPending(null)
              })
              .catch(function (reason) {
                clearTimeout(watchdog)
                clearPending()
                var raw = String(reason && reason.message ? reason.message : reason)
                var message = errorText(t, reason && reason.code, raw)
                localTrace('failed', { sessionId: sessionId, message: raw, code: reason && reason.code, resources: apiResourceTiming() })
                trace('error', 'delete failed', { sessionId: sessionId, message: message })
                reportTrace({ event: 'delete-failed', sessionId: sessionId, message: message })
                setError(message)
                setBusy(false)
              })
          }

          return h(primitives.Modal, {
            open: true,
            onClose: close,
            title: quarantine ? t('confirm.quarantineTitle') : t('confirm.title'),
            closeLabel: t('close'),
            description: quarantine ? t('confirm.quarantineDesc', { title: target.title }) : t('confirm.desc', { title: target.title }),
            footer: h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
              h('button', { type: 'button', style: cancelStyle, disabled: busy, onClick: close }, t('cancel')),
              h('button', { type: 'button', style: deleteStyle, disabled: busy, onClick: confirmDelete },
                busy ? (quarantine ? t('quarantining') : t('deleting')) : (quarantine ? t('menu.quarantine') : t('delete')))),
          }, done === null ? null : h('div', { role: 'status', style: { margin: '8px 0 0' } },
            h('p', { style: { margin: '0 0 6px', fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' } },
              t('quarantine.ok', { path: done })),
            h('input', {
              type: 'text',
              readOnly: true,
              value: done,
              onFocus: function (event) { try { event.target.select() } catch (_) { /* ignore */ } },
              style: { width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: '12px', padding: '4px 6px' },
            })),
          error === null ? null : h('p', {
            role: 'alert',
            style: { margin: '8px 0 0', color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', lineHeight: '18px' },
          }, t('error', { message: error })))
        }

        /** @param {object} ctx - cordis client context. */
        function apply(ctx) {
          // 自证：页面里的这份代码能否连通 host。engine.log 里看到这条，说明
          // 浏览器→引擎这条路是通的；看不到就说明页面还是旧连接/旧 bundle。
          setTimeout(function () {
            reportTrace({ event: 'plugin-loaded', url: window.location.href, hasAbort: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' })
          }, 1200)
          // 页面可能比引擎活得久：只重启引擎不会重载 WebView，页面里的 JS 一直是旧的。
          // 与宿主比对构建戳，不一致就重载一次（sessionStorage 防循环）。
          try {
            var updateInit = { method: 'GET' }
            if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
              updateInit.signal = AbortSignal.timeout(2000)
            }
            fetch('/api/session-delete-version', updateInit)
              .then(function (res) { return res.ok ? res.json() : null })
              .then(function (data) {
                if (data === null || typeof data.stamp !== 'string') return
                // 宿主拿不到自己的构建戳（build.json 缺失）：不据此重载，避免每次启动白刷一次。
                if (data.stamp === 'unknown' || data.stamp === '') return
                if (data.stamp === BUILD_STAMP) {
                  window.sessionStorage.removeItem('dsh.session-delete.reloaded')
                  return
                }
                if (window.sessionStorage.getItem('dsh.session-delete.reloaded') === '1') return
                window.sessionStorage.setItem('dsh.session-delete.reloaded', '1')
                localTrace('self-update-reload', { page: BUILD_STAMP, host: data.stamp })
                window.location.reload()
              })
              .catch(function () { /* 版本探测失败不影响删除功能 */ })
          } catch (_) {
            /* 老 WebView 没有 AbortSignal.timeout 时同样不影响主流程 */
          }
          ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }) }, 'session-delete: dictionaries')
          // 重载后续做上次卡住的删除（用户在确认框里已经同意过，不再二次确认）。
          var pendingDelete = readPending()
          if (pendingDelete !== null) {
            localTrace('resume', { sessionId: pendingDelete.sessionId })
            setTimeout(function () {
              runDelete(pendingDelete.sessionId).catch(function (reason) {
                localTrace('resume-failed', { sessionId: pendingDelete.sessionId, message: String(reason && reason.message ? reason.message : reason) })
                // 续做失败就放弃这条待办：否则每次页面加载都会重试同一条。
                clearPending()
                // #510：重载前用户已在确认框里同意过删除，续做失败必须说清楚——
                // 旧实现只留 localStorage 痕迹，用户看到的是「页面闪一下、会话还在、零提示」。
                showResumeNotice(resumeText(reason && reason.code, String(reason && reason.message ? reason.message : reason)))
              })
            }, 600)
          }
          ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
            return ctx.slots.register({
              name: 'sidebar.workspaces.session.menu.item',
              id: 'delete',
              order: 500,
              locale: NS,
            }, DeleteSessionMenuItem)
          })
          // issue #912：**单独**注册隔离入口（不塞进 DeleteSessionMenuItem 返回两个节点 ——
          // 那个返回值被 slot 当单个节点渲染，返回数组在旧内核上可能整块不显示）。
          // 两个入口并存是有意的：既要能「隔离保留」，也要能「彻底删除」。
          ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
            return ctx.slots.register({
              name: 'sidebar.workspaces.session.menu.item',
              id: 'quarantine',
              order: 490,
              locale: NS,
            }, QuarantineSessionMenuItem)
          })
          ctx.slots.inject('shell.overlay', function () {
            return ctx.slots.register({
              name: 'shell.overlay',
              id: 'session-delete-confirm',
              locale: NS,
            }, DeleteConfirmDialog)
          })
        }

        exports.name = 'dsh-session-delete'
        exports.inject = ['slots', 'locale']
        exports.apply = apply
        return module.exports
      },
    })
  } catch (err) {
    console.warn('[dsh-session-delete] client runtime error:', err)
  }
})()
