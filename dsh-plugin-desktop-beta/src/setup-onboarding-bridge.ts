/** Native persistence adapter consumed by the official onboarding continuation. */
export interface DesktopSetupWizardInput { platform: string }
export type DesktopSetupWizardSelection = Record<string, unknown>
export type DesktopSetupWizardSettings = Record<string, unknown>

export const SETUP_ONBOARDING_CHANNEL = 'dsh-desktop:setup-onboarding'
export interface DesktopOnboardingSnapshot {
  required: boolean
  accountPending?: boolean
  accountOnboardingEnabled?: boolean
  restartPending?: boolean
  profile: string
  edition: 'desktop' | 'next'
  input: DesktopSetupWizardInput
  computerUse?: boolean
}
export interface DesktopOnboardingBridge {
  read(): Promise<DesktopOnboardingSnapshot | null>
  finish(profile: string, selection?: DesktopSetupWizardSelection & { computerUse?: boolean }, applySettings?: (settings: DesktopSetupWizardSettings) => Promise<void>): Promise<void>
  dismissAccount(profile: string): Promise<void>
  applyPending?(profile: string): Promise<void>
}
