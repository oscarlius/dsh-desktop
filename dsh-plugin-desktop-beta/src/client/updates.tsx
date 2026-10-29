import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { desktopVersionLabel, type DesktopCommand, type DesktopState } from '../desktop-contract.ts'
import { updateAction, updateLabel } from '../update-state.ts'

export function NextUpdateSettings({ state, language, run, heading }: { state: DesktopState; language: string; run(command: DesktopCommand): void; heading?: string }) {
  const update = state.platform === 'darwin' || state.platform === 'win32' ? state.updates : undefined
  if (!update && state.platform !== 'linux') return null
  const t = (zh: string, en: string) => language.startsWith('zh') ? zh : en
  const action = update ? updateAction(update) : undefined
  return <section className="dshDesktopSettingsGroup" data-next-updates>
    <h3>{heading ?? (state.platform === 'linux' ? t('桌面版本', 'Desktop version') : t('应用更新', 'App updates'))}</h3>
    <p className="dshDesktopSettingsHint">DSH Desktop Beta · {desktopVersionLabel(state)}</p>
    {update && <>
      <p role={update.phase === 'error' ? 'alert' : 'status'}>{updateLabel(update, language)}</p>
      {update.phase === 'ready' && <p className="dshDesktopSettingsHint">{t('安装时会重启应用并中断正在运行的任务，Profile 和会话会保留。', 'Installation restarts the app and interrupts running tasks. Profiles and sessions are retained.')}</p>}
      {update.phase === 'downloading' && <progress style={{ width: '100%' }} aria-label={t('更新下载进度', 'Update download progress')} max={update.total ?? 1} value={update.total ? update.received ?? 0 : undefined} />}
      {!update.installable && <p className="dshDesktopSettingsHint">{t('应用内安装更新需要使用 macOS 或 Windows 安装版。', 'Install a packaged macOS or Windows build to use in-app updates.')}</p>}
      <div className="dshDesktopSettingsDialogActions">
        <Button variant="outline" size="sm" className="dshDesktopSettingsButton" disabled={state.busy || !action || action !== 'check-updates' && !update.installable} onClick={() => { if (action) run({ type: action }) }}>
          {action === 'install-update' ? t('安装并重启', 'Install and restart') : action === 'download-update' ? t('下载更新', 'Download update') : t('检查更新', 'Check for updates')}
        </Button>
      </div>
    </>}
  </section>
}

/** The browser has no native bridge, so update controls are intentionally unavailable there. */
export function NextVersionManagement({ state, language, run }: { state?: DesktopState; language: string; run?: (command: DesktopCommand) => void }) {
  const t = (zh: string, en: string) => language.startsWith('zh') ? zh : en
  if (!state || !run) return <section className="dshDesktopSettingsGroup" data-next-version-management>
    <h3>{t('版本管理', 'Version management')}</h3>
    <p className="dshDesktopSettingsHint">{t('应用内更新仅可在 DSH Desktop 中使用。', 'In-app updates are available only in DSH Desktop.')}</p>
  </section>
  return <div data-next-version-management><NextUpdateSettings state={state} language={language} run={run} heading={t('版本管理', 'Version management')} /></div>
}
