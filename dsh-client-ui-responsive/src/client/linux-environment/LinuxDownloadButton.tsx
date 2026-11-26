import {
  IconCodeOutlineMedium,
  IconCloseOutlineMedium,
  IconDownloadOutlineMedium,
  IconPauseOutlineMedium,
  useModalLayer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { tr } from '../i18n.ts'
import { acknowledgeInstallJob, changeInstallJob, downloadPercent, formatBytes, useLinuxInstallJob } from './install-job.ts'
import type { InstallJob } from './transport.ts'

export function downloadStatus(job: InstallJob): string {
  switch (job.state) {
    case 'done': return tr('查看 Linux 环境', 'View Linux environment')
    case 'failed': return tr('下载中断，点此继续', 'Download interrupted')
    case 'paused': return tr('下载已暂停', 'Download paused')
    case 'installing': return tr('正在准备 Linux 环境', 'Preparing Linux')
    default: {
      const stage = job.progress?.stage
      if (stage === 'extracting' || stage === 'verifying') {
        return tr('正在准备 Linux 环境', 'Preparing Linux')
      }
      const percent = downloadPercent(job)
      return percent === undefined
        ? tr('正在下载 Linux', 'Downloading Linux')
        : tr('正在下载 Linux · ', 'Downloading Linux · ') + percent + '%'
    }
  }
}

function DownloadRing({ job }: { job: InstallJob }) {
  const size = 28
  const percent = downloadPercent(job)
  const stage = job.progress?.stage
  const moving = job.state === 'installing' || (
    job.state === 'queued' && (percent === undefined || stage === 'extracting' || stage === 'verifying')
  )
  const arc = moving ? 28 : job.state === 'done' ? 100 : percent ?? 0
  return (
    <span className="dsh-resource-ring" data-state={job.state} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 28 28" fill="none" focusable="false">
        <circle cx="14" cy="14" r="12" className="dsh-resource-ring-track" />
        <circle cx="14" cy="14" r="12" pathLength="100" strokeDasharray={`${arc} 100`}
          className="dsh-resource-ring-progress" data-moving={moving || undefined} />
      </svg>
      {job.state === 'paused' ? <IconPauseOutlineMedium size={size * 0.48} /> :
        job.state === 'done' ? <IconCodeOutlineMedium size={size * 0.48} /> :
          <IconDownloadOutlineMedium size={size * 0.48} />}
    </span>
  )
}

export function LinuxDownloadProgress({ job }: { job: InstallJob }) {
  const percent = downloadPercent(job)
  const paused = job.state === 'paused'
  const failed = job.state === 'failed'
  const downloading = job.state === 'queued' && job.progress?.stage === 'downloading'
  const showPercent = percent !== undefined && (downloading || paused)
  const remaining = showPercent ? Math.max(0, (job.totalBytes ?? 0) - (job.availableBytes ?? 0)) : undefined
  const speed = downloading ? job.progress?.speed : undefined
  const status = downloading ? tr('下载中', 'Downloading') : downloadStatus(job)
  return (
    <div className="dsh-resource-transfer" data-dsh-resource-phase={job.state}>
      <div className="dsh-resource-transfer-status">
        <strong role="status">{status}</strong>
        {showPercent && <span>{percent}%</span>}
      </div>
      {!failed && <progress aria-label={tr('安装进度', 'Installation progress')} max={100}
        value={showPercent ? percent : undefined} />}
      <div className="dsh-resource-transfer-footer">
        {remaining !== undefined && <p>
          {tr('剩余 ', 'Remaining ') + formatBytes(remaining)}
          {speed ? ' · ' + formatBytes(speed) + '/s' : ''}
        </p>}
        {(downloading || paused || failed) && (
          <button type="button" className="dsh-resource-link-button"
            data-dsh-download-action={downloading ? 'pause' : 'retry'}
            onClick={() => changeInstallJob(downloading ? 'pause' : 'retry')}>
            {downloading ? tr('暂停', 'Pause') : tr('继续安装', 'Continue installation')}
          </button>
        )}
      </div>
    </div>
  )
}

const DETAIL_WIDTH = 350

export function LinuxDownloadButton({ open }: { open(): void }) {
  const job = useLinuxInstallJob()
  const button = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const [details, setDetails] = useState(false)
  const visible = details && Boolean(job?.state)
  const [position, setPosition] = useState({ left: 12, top: 12 })
  useModalLayer(dialog, visible, () => setDetails(false))
  useLayoutEffect(() => {
    if (!visible) return
    const place = () => {
      const bounds = button.current?.getBoundingClientRect()
      if (!bounds) return
      setPosition({
        left: Math.max(12, Math.min(bounds.left, window.innerWidth - DETAIL_WIDTH - 12)),
        top: bounds.bottom + 8,
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [visible])

  if (!job?.state) return null
  const label = downloadStatus(job)
  const viewEnvironment = () => {
    setDetails(false)
    acknowledgeInstallJob()
    open()
  }
  return <>
    <button ref={button} type="button" className="dsh-resource-download-button"
      data-dsh-resource-download={job.state} aria-label={label} title={label}
      aria-haspopup="dialog" aria-expanded={visible}
      onClick={() => job.state === 'done' ? viewEnvironment() : setDetails(previous => !previous)}>
      <DownloadRing job={job} />
    </button>
    {visible && createPortal(
      <div className="dsh-resource-popover-layer">
        <div className="dsh-resource-popover-outside" aria-hidden="true" onClick={() => setDetails(false)} />
        <div ref={dialog} className="dsh-resource-popover" style={position} role="dialog" aria-modal="true"
          aria-label={tr('Linux 下载详情', 'Linux download details')} tabIndex={-1} data-dsh-resource-details="">
          <header>
            <h2>{tr('Linux 工作环境', 'Linux workspace')}</h2>
            <button type="button" className="dsh-resource-link-button" data-dsh-resource-dismiss=""
              aria-label={tr('关闭', 'Close')} onClick={() => setDetails(false)}>
              <IconCloseOutlineMedium size={16} />
            </button>
          </header>
          {job.state === 'done'
            ? <button type="button" className="dsh-resource-link-button" onClick={viewEnvironment}>
              {tr('查看 Linux 环境', 'View Linux environment')}
            </button>
            : <LinuxDownloadProgress job={job} />}
        </div>
      </div>,
      document.body,
    )}
  </>
}
