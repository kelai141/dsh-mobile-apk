import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import '@xterm/xterm/css/xterm.css'
import { tr } from '../i18n.ts'
import { RouteError, terminalRequest, type TerminalUpdate } from './transport.ts'

function terminalError(error: unknown): string {
  if (error instanceof RouteError) {
    switch (error.message) {
      case 'linux-terminal-runtime-unavailable':
        return tr('请先启动 Linux 环境。', 'Start the Linux environment first.')
      case 'linux-terminal-runtime-busy':
        return tr('Linux 正在更新或安装，请稍后重试。', 'Linux is being updated or installed. Try again shortly.')
      case 'linux-terminal-runtime-incompatible':
        return tr('当前 Linux 版本需要更新。', 'Update Linux to use the terminal.')
      case 'linux-terminal-pty-unavailable':
        return tr('终端服务尚未启动。', 'The terminal service is unavailable.')
    }
  }
  return tr('终端连接中断，请重试。', 'The terminal connection was interrupted. Try again.')
}

export function LinuxTerminal({ onBack }: { onBack?(): void }) {
  const host = useRef<HTMLDivElement>(null)
  const stop = useRef<() => void>(() => {})
  const sendKey = useRef<((value: string) => void)>(() => {})
  const [attempt, setAttempt] = useState({ revision: 0, restart: false })
  const [state, setState] = useState<'connecting' | 'running' | 'exited' | 'failed'>('connecting')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const element = host.current
    if (!element) return
    let active = true
    let id: string | undefined
    let cursor = 0
    let running = false
    let more = false
    let reading = false
    let pollDelay = 120
    let timer: ReturnType<typeof setTimeout> | undefined
    let input = Promise.resolve()
    const terminal = new Terminal({
      cursorBlink: !window.matchMedia('(prefers-reduced-motion: reduce)').matches, fontSize: 13, scrollback: 1500,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    terminal.textarea?.setAttribute('aria-label', tr('Linux 终端输入', 'Linux terminal input'))
    const syncTheme = () => {
      const style = getComputedStyle(element)
      terminal.options.theme = {
        background: style.backgroundColor, foreground: style.color, cursor: style.color,
        selectionBackground: style.getPropertyValue('--dsh-terminal-selection').trim() || '#4d6bfe55',
      }
    }
    syncTheme()
    const themeObserver = new MutationObserver(syncTheme)
    const themeAttributes = { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-ds-theme-source', 'style', 'class'] }
    themeObserver.observe(document.documentElement, themeAttributes)
    themeObserver.observe(document.body, themeAttributes)
    fit.fit()
    setState('connecting')
    setMessage('')
    const dimensions = () => ({ rows: Math.max(2, terminal.rows), cols: Math.max(2, terminal.cols) })
    const fail = (error: unknown) => {
      if (!active) return
      setState('failed')
      setMessage(terminalError(error))
    }
    const consume = async (update: TerminalUpdate) => {
      if (update.reset) terminal.reset()
      if (update.output) await new Promise<void>(resolve => terminal.write(update.output, resolve))
      cursor = update.next
      running = update.running
      more = update.more === true
      pollDelay = update.output ? 120 : Math.min(pollDelay * 2, 800)
      if (!active) return
      setState(running ? 'running' : 'exited')
      if (!running && update.outcome?.exitCode != null) {
        setMessage(tr('退出码 ', 'Exit code ') + update.outcome.exitCode)
      }
    }
    const schedulePoll = (delay: number) => {
      clearTimeout(timer)
      if (active && id && !reading && (running || more) && document.visibilityState === 'visible') {
        timer = setTimeout(() => { void poll() }, delay)
      }
    }
    const poll = async () => {
      if (!active || !id || reading || document.visibilityState !== 'visible') return
      reading = true
      try {
        const update = await terminalRequest({ action: 'read', id, after: cursor })
        if (active) await consume(update)
      } catch (error) {
        running = false
        more = false
        fail(error)
      } finally {
        reading = false
        schedulePoll(more ? 0 : pollDelay)
      }
    }
    const onVisibility = () => { schedulePoll(0) }
    document.addEventListener('visibilitychange', onVisibility)
    const sendInput = (data: string) => {
      const session = id
      if (!session || !running) return
      input = input.then(async () => {
        for (let offset = 0; active && offset < data.length;) {
          let end = Math.min(offset + 4000, data.length)
          if (/^[\uDC00-\uDFFF]/u.test(data.slice(end))) end--
          await terminalRequest({ action: 'write', id: session, data: data.slice(offset, end) })
          offset = end
        }
        pollDelay = 120
        schedulePoll(0)
      }).catch(error => { if (running) fail(error) })
    }
    const onInput = terminal.onData(sendInput)
    sendKey.current = sendInput
    const size = terminal.onResize(({ rows, cols }) => {
      if (id && running && rows >= 2 && cols >= 2) void terminalRequest({ action: 'resize', id, rows, cols }).catch(fail)
    })
    const observer = new ResizeObserver(() => { if (active && element.offsetHeight) fit.fit() })
    observer.observe(element)
    void terminalRequest({ action: attempt.restart ? 'restart' : 'open', ...dimensions() }).then(async update => {
      if (!active) return
      id = update.id
      if (update.running) await terminalRequest({ action: 'resize', id, ...dimensions() })
      if (active) {
        await consume(update)
        schedulePoll(more ? 0 : pollDelay)
      }
    }).catch(fail)
    stop.current = () => {
      if (id && running) void terminalRequest({ action: 'stop', id }).catch(fail)
    }
    return () => {
      active = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      stop.current = () => {}
      sendKey.current = () => {}
      observer.disconnect()
      themeObserver.disconnect()
      size.dispose()
      onInput.dispose()
      terminal.dispose()
    }
  }, [attempt])

  return (
    <section className="dsh-linux-terminal" data-dsh-settings-sublayer=""
      data-dsh-settings-sublayer-title={tr('终端', 'Terminal')} data-linux-terminal={state}>
      <header className="dsh-linux-terminal-tools">
        {onBack && <button type="button" className="dsh-linux-back" data-dsh-settings-sublayer-back="" onClick={onBack}>
          {tr('返回', 'Back')}
        </button>}
        <span role="status">{message || {
          connecting: tr('连接中', 'Connecting'), running: tr('运行中', 'Running'),
          exited: tr('会话已结束', 'Session ended'), failed: tr('连接失败', 'Connection failed'),
        }[state]}</span>
        {state === 'running' && <Button size="sm" variant="outline" onClick={() => {
          if (window.confirm(tr('结束终端会话及其中的任务？', 'End this terminal session and its running jobs?'))) stop.current()
        }}>
          {tr('结束会话', 'End session')}
        </Button>}
        {(state === 'exited' || state === 'failed') && <Button size="sm" variant="outline"
          onClick={() => setAttempt(({ revision }) => ({ revision: revision + 1, restart: state === 'exited' }))}>
          {state === 'exited' ? tr('新建会话', 'New session') : tr('重新连接', 'Reconnect')}
        </Button>}
      </header>
      <div className="dsh-linux-terminal-screen" ref={host} />
      {state === 'running' && <div className="dsh-linux-terminal-keys" aria-label={tr('终端快捷键', 'Terminal keys')}>
        {[
          ['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl+C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B'],
          ['←', '\x1b[D'], ['→', '\x1b[C'],
        ].map(([label, value]) => (
          <button type="button" key={label} onMouseDown={event => event.preventDefault()}
            onClick={() => sendKey.current(value)}>{label}</button>
        ))}
      </div>}
    </section>
  )
}
