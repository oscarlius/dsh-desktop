/** Company-only first-run defaults for the optional StreamFold transcript plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
export const COMPANY_TRANSCRIPT_SETTINGS_KEY = 'dsh-streamfold'

export const COMPANY_TRANSCRIPT_DEFAULTS = Object.freeze({
  mode: 'fold',
  windowHeight: 180,
  sparks: false,
  forgeSparks: false,
  settleToPrompt: false,
  keepUserQuestions: true,
})

/** Parser-blocking Host bootstrap for the first document, before client modules load. */
export function companyTranscriptDefaultsScript(): string {
  const value = JSON.stringify(COMPANY_TRANSCRIPT_DEFAULTS)
  return `try{const k=${JSON.stringify(COMPANY_TRANSCRIPT_SETTINGS_KEY)};if(localStorage.getItem(k)===null)localStorage.setItem(k,${JSON.stringify(value)})}catch{}`
}

/** Shared by the native Host and isolated real-Agent renderer acceptance. */
export function installCompanyTranscriptBoot(ctx: Pick<Context, 'on'>): void {
  ctx.on('webserver/index-inject', table => {
    // The upstream module registry emits a classic head script that evaluates
    // plugin factories immediately. Prepend ahead of that script, not merely
    // ahead of the deferred application entry.
    table.unshift({ kind: 'script', placement: 'head', text: companyTranscriptDefaultsScript() })
  })
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

/** Seeds company defaults once without changing any existing user preference. */
export function installCompanyTranscriptDefaults(storage: StorageLike | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): boolean {
  if (storage === undefined || storage.getItem(COMPANY_TRANSCRIPT_SETTINGS_KEY) !== null) return false
  storage.setItem(COMPANY_TRANSCRIPT_SETTINGS_KEY, JSON.stringify(COMPANY_TRANSCRIPT_DEFAULTS))
  return true
}
