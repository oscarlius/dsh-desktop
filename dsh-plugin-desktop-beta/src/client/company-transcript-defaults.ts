/** Company-only first-run defaults for the optional StreamFold transcript plugin. */
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

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

/** Seeds company defaults once without changing any existing user preference. */
export function installCompanyTranscriptDefaults(storage: StorageLike | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): boolean {
  if (storage === undefined || storage.getItem(COMPANY_TRANSCRIPT_SETTINGS_KEY) !== null) return false
  storage.setItem(COMPANY_TRANSCRIPT_SETTINGS_KEY, JSON.stringify(COMPANY_TRANSCRIPT_DEFAULTS))
  return true
}
