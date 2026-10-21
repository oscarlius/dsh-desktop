import { MessageChannel } from 'node:worker_threads'
import { expect, it, vi } from 'vitest'
import { HostRpc } from '../src/host-rpc.ts'
import { bindNativeRuntime, createHostRuntime, runtimeSnapshot } from '../src/host-runtime-bridge.ts'
import { desktopTrayLabel } from '../src/tray-locale.ts'
import type { DesktopLocale, DesktopRuntime, DesktopShellSpec, DesktopTrayItem } from '../src/runtime.ts'

it('forwards the company update lifecycle through Host IPC and disposes the native owner', async () => {
  const { port1, port2 } = new MessageChannel()
  const [parent, child] = [port1, port2].map(port => new HostRpc({
    send: value => port.postMessage(value),
    listen: receive => { port.on('message', receive); return () => { port.off('message', receive) } },
  })) as [HostRpc, HostRpc]
  const checkNow = vi.fn(async () => {})
  const dispose = vi.fn(async () => {})
  const startCompanyUpdates = vi.fn(() => ({ checkNow, dispose }))
  const native = {
    platform: 'win32', locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.18', statePath: '/tmp/update' },
    startCompanyUpdates,
  } as unknown as DesktopRuntime
  const release = bindNativeRuntime(parent, native)
  try {
    const host = createHostRuntime(child, runtimeSnapshot(native))
    const lifecycle = host.startCompanyUpdates?.({ enabled: true, initialDelayMs: 1, intervalMs: 1, requestTimeoutMs: 1 })
    expect(lifecycle).toBeDefined()
    await host.mountScheduled()
    expect(startCompanyUpdates).toHaveBeenCalledWith({ enabled: true, initialDelayMs: 1, intervalMs: 1, requestTimeoutMs: 1 })
    await lifecycle!.checkNow()
    expect(checkNow).toHaveBeenCalledOnce()
    await release()
    expect(dispose).toHaveBeenCalledOnce()
  } finally { await release(); parent.close(); child.close(); port1.close(); port2.close() }
})

it.each(['zh', undefined] as const)('synchronizes tray language at boot and on changes (preference: %s)', async initialPreference => {
  const { port1, port2 } = new MessageChannel()
  const [parent, child] = [port1, port2].map(port => new HostRpc({
    send: value => port.postMessage(value),
    listen: receive => { port.on('message', receive); return () => { port.off('message', receive) } },
  })) as [HostRpc, HostRpc]
  let shell!: DesktopShellSpec
  let tray!: DesktopTrayItem
  const disposeShell = vi.fn(async () => {})
  const disposeTray = vi.fn()
  let nativeLocale: DesktopLocale = 'en'
  const native = {
    platform: 'win32', get locale() { return nativeLocale },
    setLocalePreference: (preference: DesktopLocale | undefined) => { nativeLocale = preference ?? 'zh' },
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.7-beta.1', statePath: '/tmp/update',
      request: vi.fn(async () => new Response('{"version":"2.0.8-beta.1"}', { headers: { 'x-test': 'yes' } })),
    },
    schedule: (value: DesktopShellSpec) => { shell = value; return disposeShell },
    registerTrayItem: (value: DesktopTrayItem) => { tray = value; return { refresh() {}, dispose: disposeTray } },
  } as unknown as DesktopRuntime
  const release = bindNativeRuntime(parent, native)
  try {
    const runtime = createHostRuntime(child, runtimeSnapshot(native))
    let language: 'zh' | undefined
    const mode = vi.fn(async () => {})
    const invoke = vi.fn(async () => {})
    const spec = { url: 'http://127.0.0.1:1234/?dsh-desktop-mode=advanced',
      authenticationUrl: 'http://127.0.0.1:1234/?token=fixture',
      rendererAccessHeader: { name: 'x-dsh-desktop-renderer', value: 'fixture' },
      readLocalePreference: () => language, readThemeSource: () => 'dark',
      requestQuit() {}, requestModeChange: mode,
    } as unknown as DesktopShellSpec
    spec.readRemoteControl = vi.fn(async () => false)
    spec.enableRemoteControl = vi.fn(async () => {})
    spec.applySetupSettings = vi.fn(async () => {})
    const stopShell = runtime.schedule(spec)
    runtime.registerTrayItem({ group: 'tools', order: 1, label: () => desktopTrayLabel(runtime.locale, 'openTerminal'), invoke,
      submenu: () => [{ label: () => desktopTrayLabel(runtime.locale, 'checkForUpdates'), invoke }] })
    language = initialPreference
    await runtime.mountScheduled()
    expect(await shell.readRemoteControl?.()).toBe(false)
    await shell.enableRemoteControl?.()
    expect(spec.enableRemoteControl).toHaveBeenCalledTimes(1)
    expect(shell.url).toBe(spec.url)
    expect(shell.authenticationUrl).toBe(spec.authenticationUrl)
    expect(shell.rendererAccessHeader).toEqual(spec.rendererAccessHeader)
    expect(shell.readLocalePreference()).toBe(initialPreference)
    await shell.requestModeChange('extended')
    expect(mode).toHaveBeenCalledWith('extended')
    const setup = { mode: 'extended', macosMaterial: 'transparent', windowsMaterial: 'off', openBrowser: false,
      networkExposure: 'loopback', notifications: { enabled: true, notifyOnTurnCompletion: true,
        notifyOnTurnFailure: true, notifyOnJobCompletion: true, notifyOnJobFailure: true,
        notifyOnScheduleCompletion: true, notifyOnScheduleFailure: true } } as const
    await shell.applySetupSettings?.(setup)
    expect(spec.applySetupSettings).toHaveBeenCalledWith(setup)
    expect(runtime.locale).toBe('zh')
    expect(native.locale).toBe('zh')
    expect(tray.label()).toBe('打开 DSH 终端')
    expect(tray.submenu?.()[0]?.label()).toBe('检查更新…')
    runtime.setLocalePreference('en')
    await vi.waitFor(() => expect(tray.label()).toBe('Open DSH Terminal'))
    expect(native.locale).toBe('en')
    expect(tray.submenu?.()[0]?.label()).toBe('Check for Updates…')
    runtime.setLocalePreference(undefined)
    await vi.waitFor(() => expect(tray.label()).toBe('打开 DSH 终端'))
    expect(runtime.locale).toBe('zh')
    expect(native.locale).toBe('zh')
    await tray.submenu?.()[0]?.invoke()
    expect(invoke).toHaveBeenCalledOnce()
    const response = await runtime.updates.request('https://example.invalid', { headers: { accept: 'application/json' } })
    expect(response.headers.get('x-test')).toBe('yes')
    expect(await response.json()).toEqual({ version: '2.0.8-beta.1' })
    await stopShell()
    expect(disposeShell).toHaveBeenCalledOnce()
  } finally { await release(); parent.close(); child.close(); port1.close(); port2.close() }
})


it('keeps refresh storage on the native side of Host IPC and advertises its availability', async () => {
  const { port1, port2 } = new MessageChannel()
  const [parent, child] = [port1, port2].map(port => new HostRpc({
    send: value => port.postMessage(value),
    listen: receive => { port.on('message', receive); return () => { port.off('message', receive) } },
  })) as [HostRpc, HostRpc]
  const vault = vi.fn(async (request: { action: string }) => request.action === 'load' ? { refreshToken: 'p7r_synthetic-only' } : {})
  const native = { platform: 'win32', locale: 'en', updates: { isPackaged: false, canDownload: false, currentVersion: '2.0.18-beta.15.build.2026102101', statePath: '/fixture' }, p7SessionVault: vault } as unknown as DesktopRuntime
  const release = bindNativeRuntime(parent, native)
  try {
    const runtime = createHostRuntime(child, runtimeSnapshot(native))
    expect(await runtime.p7SessionVault?.({ action: 'load', origin: 'https://p7.example' })).toEqual({ refreshToken: 'p7r_synthetic-only' })
    expect(vault).toHaveBeenCalledWith({ action: 'load', origin: 'https://p7.example' })
    const { p7AccountStore } = await import('../src/p7-account-browser.ts')
    expect(p7AccountStore(runtime)?.clientVersion).toBe('2.0.18-beta.15.build.2026102101')
    const unsupported = { ...native, p7SessionVault: undefined } as unknown as DesktopRuntime
    expect(createHostRuntime(child, runtimeSnapshot(unsupported)).p7SessionVault).toBeUndefined()
  } finally { await release(); parent.close(); child.close(); port1.close(); port2.close() }
})
