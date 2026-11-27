import type {} from '../android-bridge.ts'

interface HostBootGraph {
  release?: { version?: unknown }
}

/** Read the running Host's release identity from the boot graph it publishes. */
export function getEngineVersion(): string {
  const graph = (window as Window & { __DSH_BOOT__?: HostBootGraph }).__DSH_BOOT__
  const version = graph?.release?.version
  return typeof version === 'string' ? version.trim() : ''
}

/** Read the installed Android application's version from the shell bridge. */
export function getShellVersion(): string {
  try {
    return window.androidBridge?.version?.()?.trim() ?? ''
  } catch {
    return ''
  }
}
