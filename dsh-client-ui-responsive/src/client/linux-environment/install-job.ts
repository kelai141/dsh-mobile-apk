import { useSyncExternalStore } from 'react'
import { installJobStatus, type InstallJob } from './transport.ts'

const listeners = new Set<() => void>()
let snapshot: InstallJob | undefined
let serialized: string | undefined
let timer: number | undefined
let notifyCompletion = false

export function refreshInstallJob(): void {
  const job = installJobStatus()
  if (job?.state && job.state !== 'done') notifyCompletion = true
  const next = job?.state === 'done' && !notifyCompletion ? undefined : job
  const value = JSON.stringify(next)
  if (value === serialized) return
  serialized = value
  snapshot = next
  listeners.forEach(listener => listener())
}

export function acknowledgeInstallJob(): void {
  const job = installJobStatus()
  if (job?.state !== 'done') return
  notifyCompletion = false
  refreshInstallJob()
}

function poll(): void {
  window.clearTimeout(timer)
  if (!listeners.size || document.visibilityState === 'hidden') return
  refreshInstallJob()
  if (!window.androidBridge?.linuxInstallJob) return
  const active = snapshot?.state === 'queued' || snapshot?.state === 'installing'
  timer = window.setTimeout(poll, active ? 750 : 2_500)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', poll)
    poll()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      document.removeEventListener('visibilitychange', poll)
      window.clearTimeout(timer)
    }
  }
}

export function useLinuxInstallJob(): InstallJob | undefined {
  return useSyncExternalStore(subscribe, () => snapshot)
}

export function downloadPercent(job: InstallJob): number | undefined {
  const { availableBytes, totalBytes } = job
  if (availableBytes === undefined || totalBytes === undefined ||
    !Number.isSafeInteger(availableBytes) || !Number.isSafeInteger(totalBytes) ||
    availableBytes < 0 || totalBytes <= 0) return undefined
  return Math.min(100, Math.floor(availableBytes / totalBytes * 100))
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return (bytes / 1_000_000_000).toFixed(1) + ' GB'
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + ' MB'
  if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + ' KB'
  return bytes + ' B'
}

export function changeInstallJob(action: 'pause' | 'retry'): void {
  window.androidBridge?.linuxInstallJob?.(action, null)
  refreshInstallJob()
}
