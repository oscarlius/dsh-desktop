import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DesktopCommand, DesktopState } from '../desktop-contract.ts'
import { updateAction, updateLabel } from '../update-state.ts'

export function NextUpdateSettings({ state, language, run, heading }: { state: DesktopState; language: string; run(command: DesktopCommand): void; heading?: string }) {
  const update = state.platform === 'darwin' || state.platform === 'win32' ? state.updates : undefined
  if (!update && state.platform !== 'linux') return null
  const t = (zh: string, en: string) => language.startsWith('zh') ? zh : en
  const action = update ? updateAction(update) : undefined
  return <section className="dshDesktopSettingsGroup" data-next-updates>
    <h3>{heading ?? (state.platform === 'linux' ? t('桌面版本', 'Desktop version') : t('应用更新', 'App updates'))}</h3>
    <p className="dshDesktopSettingsHint">DSH NEXT · {state.version}</p>
    {update && <>
      <p role={update.phase === 'error' ? 'alert' : 'status'}>{updateLabel(update, language)}</p>
      {update.phase === 'ready' && <p className="dshDesktopSettingsHint">{t('安装时会重启应用并中断正在运行的任务，Profile 和会话会保留。', 'Installation restarts the app and interrupts running tasks. Profiles and sessions are retained.')}</p>}
      {update.phase === 'downloading' && <progress style={{ width: '100%' }} aria-label={t('更新下载进度', 'Update download progress')} max={update.total ?? 1} value={update.total ? update.received ?? 0 : undefined} />}
      {!update.installable && update.error !== 'unsupported' && <p className="dshDesktopSettingsHint">{t('应用内安装更新需要使用 macOS 或 Windows 安装版。', 'Install a packaged macOS or Windows build to use in-app updates.')}</p>}
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
  const acknowledgements = <p className="dshDesktopSettingsHint" data-desktop-acknowledgements style={{ marginTop: 24 }}>
    {t('感谢每一位参与 AI Agent 测试、分享建议的同事。你们的反馈，让它在日常工作中变得更好。', 'Thank you to every colleague who has tested AI Agent and shared suggestions. Your feedback makes it more useful in our daily work.')}
    <br />
    {t('特别感谢刘雪迪发现并反馈 Windows 11 数字签名问题。', 'Special thanks to 刘雪迪 for identifying and reporting the Windows 11 digital signature issue.')}
  </p>
  if (!state || !run) return <section className="dshDesktopSettingsGroup" data-next-version-management>
    <h3>{t('版本管理', 'Version management')}</h3>
    <p className="dshDesktopSettingsHint">{t('应用内更新仅可在 DSH Desktop 中使用。', 'In-app updates are available only in DSH Desktop.')}</p>
    {acknowledgements}
  </section>
  return <div data-next-version-management><NextUpdateSettings state={state} language={language} run={run} heading={t('版本管理', 'Version management')} />{acknowledgements}</div>
}
