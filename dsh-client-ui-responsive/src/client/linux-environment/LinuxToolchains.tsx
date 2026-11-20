import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { tr } from '../i18n.ts'
import { linuxTools, type ToolchainStatus } from './transport.ts'

export function LinuxToolchains({ onBack }: { onBack?(): void }) {
  const [status, setStatus] = useState<ToolchainStatus>()
  const [selection, setSelection] = useState('git')
  const [busy, setBusy] = useState(true)
  const [problem, setProblem] = useState('')
  const [storage, setStorage] = useState<{ bytes: number; cacheBytes: number }>()
  const [showPackages, setShowPackages] = useState(false)
  const refresh = async () => {
    setBusy(true)
    setProblem('')
    try { setStatus(await linuxTools({ action: 'status' })) }
    catch (failure) { setProblem(String(failure)) }
    finally { setBusy(false) }
  }
  useEffect(() => { void refresh() }, [])

  const change = async (action: 'install' | 'remove' | 'mirror' | 'clean' | 'storage', value?: string) => {
    setBusy(true)
    setProblem('')
    try {
      if (action === 'storage') {
        setStorage(await linuxTools({ action, confirmed: true }))
      } else {
        if (action === 'clean') {
          await linuxTools({ action, confirmed: true })
          setStorage(await linuxTools({ action: 'storage', confirmed: true }))
        } else setStatus(await linuxTools({ action, confirmed: true, name: value, source: value }))
      }
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }

  const packages = status?.packages ?? []
  return (
    <section className="dsh-linux-tools" data-dsh-settings-sublayer=""
      data-dsh-settings-sublayer-title={tr('工具链', 'Toolchains')}>
      {onBack && <button type="button" className="dsh-linux-back" data-dsh-settings-sublayer-back="" onClick={onBack}>
        {tr('返回', 'Back')}
      </button>}
      <label className="dsh-linux-env-row">
        <span>{tr('Debian APT 软件源', 'Debian APT source')}</span>
        <select value={status?.source ?? 'official'} disabled={busy || !status}
          onChange={e => { void change('mirror', e.currentTarget.value) }}>
          <option value="official">{tr('Debian 官方源', 'Debian official')}</option>
          <option value="tuna">{tr('清华 TUNA', 'Tsinghua TUNA')}</option>
          <option value="ustc">{tr('中科大 USTC', 'USTC')}</option>
        </select>
      </label>
      <div className="dsh-linux-env-row">
        <label htmlFor="dsh-linux-tool-selection">{tr('安装工具', 'Install a tool')}</label>
        <select id="dsh-linux-tool-selection" value={selection} disabled={busy}
          onChange={e => setSelection(e.currentTarget.value)}>
          {(status?.suggested ?? ['git']).map(name => <option value={name} key={name}>{name}</option>)}
        </select>
        <Button size="sm" disabled={busy || !status || packages.includes(selection)}
          onClick={() => { void change('install', selection) }}>{tr('安装', 'Install')}</Button>
      </div>
      <button type="button" className="dsh-linux-env-row dsh-linux-env-link" aria-expanded={showPackages}
        onClick={() => setShowPackages(value => !value)}>
        <span>{tr('手动安装的软件包', 'Manually installed packages')}</span>
        <span>{status ? packages.length : '…'}</span>
      </button>
      {showPackages && <ul className="dsh-linux-tool-packages">
        {packages.map(name => <li key={name} className="dsh-linux-env-row">
          <span translate="no">{name}</span>
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => {
              if (window.confirm(tr('卸载 ', 'Remove ') + name + '?')) void change('remove', name)
            }}>{tr('卸载', 'Remove')}</Button>
        </li>)}
      </ul>}
      <div className="dsh-linux-env-row">
        <span>{tr('Linux 存储', 'Linux storage')}</span>
        {storage && <span>{(storage.bytes / 1048576).toFixed(0)} MB</span>}
        <Button size="sm" variant="outline" disabled={busy}
          onClick={() => { void change('storage') }}>{tr('扫描', 'Scan')}</Button>
      </div>
      {storage && <div className="dsh-linux-env-row">
        <span>{tr('APT 缓存', 'APT cache')} · {(storage.cacheBytes / 1048576).toFixed(1)} MB</span>
        <Button size="sm" variant="outline" disabled={busy || storage.cacheBytes === 0}
          onClick={() => { void change('clean') }}>{tr('清理', 'Clear')}</Button>
      </div>}
      {busy && <p className="dsh-linux-env-hint" role="status">{tr('正在处理…', 'Working…')}</p>}
      {problem && <div className="dsh-linux-env-error" role="alert">
        <p>{problem}</p>
        <Button size="sm" variant="outline" onClick={() => { void refresh() }}>{tr('刷新', 'Refresh')}</Button>
      </div>}
    </section>
  )
}
