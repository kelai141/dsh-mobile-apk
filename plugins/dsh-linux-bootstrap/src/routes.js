export const LINUX_ENVIRONMENT_ROUTES = Object.freeze({
  status: { method: 'GET', path: '/api/android/linux-environment/status' },
  check: { method: 'POST', path: '/api/android/linux-environment/check' },
  autoCheck: { method: 'POST', path: '/api/android/linux-environment/auto-check' },
  install: { method: 'POST', path: '/api/android/linux-environment/install' },
  reinstall: { method: 'POST', path: '/api/android/linux-environment/reinstall' },
  uninstall: { method: 'POST', path: '/api/android/linux-environment/uninstall' },
  autoUpdateOn: { method: 'POST', path: '/api/android/linux-environment/auto-update-on' },
  autoUpdateOff: { method: 'POST', path: '/api/android/linux-environment/auto-update-off' },
})

export function createRouteHandlers(bootstrap) {
  if (!bootstrap) throw new TypeError('bootstrap service is required')
  const write = (action) => async (request = {}) => {
    let body = request.body ?? {}
    if (typeof body === 'function') body = await body.call(request)
    if (body?.confirmed !== true) throw Object.assign(new Error('confirmed:true is required'), { statusCode: 400 })
    return action(body)
  }
  return {
    status: () => bootstrap.status(),
    check: write(() => bootstrap.checkForUpdates({ source: 'manual' })),
    // Host-triggered automatic check: not a user action, so no confirmation
    // prompt. Dedup and the app-version gate live inside the service.
    autoCheck: () => bootstrap.checkForUpdates({ source: 'automatic' }),
    syncInjection: () => bootstrap.syncInjectionState(),
    install: write((body) => bootstrap.install({ runtimeId: body.runtimeId, confirmed: true, activate: true })),
    reinstall: write(() => bootstrap.reinstall({ confirmed: true, activate: true })),
    uninstall: write(() => bootstrap.uninstall({ confirmed: true })),
    autoUpdateOn: write(() => bootstrap.setAutoUpdateEnabled(true)),
    autoUpdateOff: write(() => bootstrap.setAutoUpdateEnabled(false)),
  }
}
