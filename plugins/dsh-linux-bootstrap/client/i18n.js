/**
 * Bilingual copy for the Linux environment section.
 *
 * The DSH host keeps `<html lang>` in sync with the active locale and reloads
 * the page on a language change, so reading the attribute at render time is the
 * existing channel for injected surfaces. Chinese stays the default: an empty
 * attribute must not flip the section to English.
 */

/** True when the active dsh locale is English. */
export function isEnglish() {
  try {
    return document.documentElement.lang.toLowerCase().startsWith('en')
  } catch {
    return false
  }
}

/** Pick Chinese or English copy for the active locale. */
export function tr(zh, en) {
  return isEnglish() ? en : zh
}

/** Human byte count for the download-size hint. */
export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? bytes : 0
  if (value >= 1024 * 1024 * 1024) return (value / 1024 / 1024 / 1024).toFixed(1) + ' GB'
  if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
  if (value >= 1024) return (value / 1024).toFixed(1) + ' KB'
  return value + ' B'
}

/** Label for one manifest asset field. */
export function assetLabel(field) {
  switch (field) {
    case 'runtime-plugin': return tr('运行时插件', 'runtime plugin')
    case 'backendAsset': return tr('Bionilux 启动器', 'Bionilux launcher')
    case 'rootfsAsset': return tr('Debian 根文件系统', 'Debian root filesystem')
    case 'nodeAsset': return tr('共享 Node.js', 'shared Node.js')
    default: return field
  }
}

/** Operation label used while the engine reports a busy operation. */
export function describeOperation(operation) {
  switch (operation) {
    case 'checking': return tr('正在检查更新…', 'Checking for updates…')
    case 'automatic-check': return tr('正在自动检查更新…', 'Checking for updates automatically…')
    case 'installing': return tr('正在安装 Linux 环境…', 'Installing the Linux environment…')
    case 'reinstalling': return tr('正在重新安装 Linux 环境…', 'Reinstalling the Linux environment…')
    case 'uninstalling': return tr('正在卸载 Linux 环境…', 'Removing the Linux environment…')
    default: return ''
  }
}

/**
 * One line describing the persisted state.
 *
 * @param {object|null|undefined} status - `status` route payload.
 * @returns {string} Localized summary.
 */
export function describeStatus(status) {
  if (!status) return tr('正在读取 Linux 环境状态…', 'Reading the Linux environment status…')
  if (!status.installed) {
    return status.updateBlocked
      ? tr('尚未安装 Linux 环境；发现较旧的版本，已阻止降级', 'Not installed yet; an older release was found, and downgrades are blocked')
      : tr('尚未安装 Linux 环境', 'The Linux environment is not installed yet')
  }
  const installed = tr('已安装 Linux 运行时 ' + (status.version ?? ''), 'Linux runtime ' + (status.version ?? '') + ' installed')
  const app = status.mobileVersion ? tr('；当前 DSH Mobile ' + status.mobileVersion, '; current DSH Mobile ' + status.mobileVersion) : ''
  const baseline = status.installedSystemMobileVersion
    ? tr('（安装时 DSH Mobile ' + status.installedSystemMobileVersion + '）', ' (installed with DSH Mobile ' + status.installedSystemMobileVersion + ')')
    : ''
  const inactive = status.injectionActivated === false
    ? tr('；运行时插件已被移除或停用，自动更新已停止', '; the runtime plugin was removed or disabled, so automatic updates stopped')
    : ''
  if (status.updateAvailable) {
    const update = tr('；可更新至 ' + (status.availableVersion ?? ''), '; update to ' + (status.availableVersion ?? '') + ' available')
    return installed + app + baseline + update + inactive
  }
  if (status.updateBlocked) return installed + app + baseline + tr('；已阻止降级', '; downgrades are blocked') + inactive
  if (status.error) return installed + app + baseline + '；' + status.error + inactive
  return installed + app + baseline + inactive
}
