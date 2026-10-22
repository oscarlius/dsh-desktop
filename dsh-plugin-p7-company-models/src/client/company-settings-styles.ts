const STYLE_ID = 'dsh-p7-company-models-settings-styles'

// The Cordis CJS client loader evaluates the JavaScript bundle directly and does
// not load CSS imports. Keep this style payload in the client bundle instead.
const STYLES = `
.dshP7CompanySettings { box-sizing: border-box; width: 100%; max-width: 960px; min-width: 0; display: grid; gap: 24px; color: var(--dsw-alias-label-primary, #1f2329); }
.dshP7CompanySettings *, .dshP7CompanySettings *::before, .dshP7CompanySettings *::after { box-sizing: border-box; }
.dshP7CompanySettingsHeader { display: grid; gap: 6px; }
.dshP7CompanyLoginGate { min-height: min(560px, 100%); align-content: center; }
.dshP7CompanyLoginGate > .dshP7CompanySettingsHeader, .dshP7CompanyLoginGate > .dshP7CompanySettingsCard { max-width: 560px; width: 100%; justify-self: center; }
.dshP7CompanySettings h2, .dshP7CompanySettings h3, .dshP7CompanySettings p { margin: 0; }
.dshP7CompanySettings h2 { font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -.01em; }
.dshP7CompanySettings h3 { font-size: 14px; line-height: 20px; font-weight: 600; }
.dshP7CompanySettingsIntro, .dshP7CompanySettingsNotice, .dshP7CompanySettingsEmpty { color: var(--dsw-alias-label-secondary, #5d6470); font-size: 13px; line-height: 20px; }
.dshP7CompanySettingsAlert { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d14343) 35%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d14343) 8%, transparent); color: var(--dsw-alias-state-error-primary, #b42318); font-size: 13px; line-height: 20px; }
.dshP7CompanyLoginOverlay { position: fixed; z-index: 1000; inset: 0; display: grid; place-items: center; padding: 24px; overflow: auto; pointer-events: auto; background: color-mix(in srgb, var(--dsw-alias-bg-page, #f7f8fa) 94%, #000); color: var(--dsw-alias-label-primary, #1f2329); }
.dshP7CompanyLoginOverlayCard { display: grid; gap: 16px; width: min(100%, 480px); padding: 28px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 14px; background: var(--dsw-alias-bg-module-platform, #fff); box-shadow: 0 12px 32px rgb(15 23 42 / 16%); }
.dshP7CompanyLoginOverlayCard h2, .dshP7CompanyLoginOverlayCard p { margin: 0; }
.dshP7CompanyLoginOverlayCard h2 { font-size: 20px; line-height: 28px; }
.dshP7CompanyLoginOverlayCard p { color: var(--dsw-alias-label-secondary, #5d6470); font-size: 14px; line-height: 21px; }
.dshP7CompanyLoginOverlayStatus { padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover, #f3f4f6); }
.dshP7CompanySettingsCard { display: grid; gap: 16px; padding: 18px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 12px; background: var(--dsw-alias-bg-module-platform, #fff); box-shadow: 0 1px 2px rgb(15 23 42 / 4%); }
.dshP7CompanySettingsCardHeader { display: grid; gap: 4px; }
.dshP7CompanySettingsForm { display: grid; gap: 14px; }
.dshP7CompanySettingsAddress { display: grid; gap: 5px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-bg-module-platform, #fff) 92%, var(--dsw-alias-interactive-bg-hover, #f3f4f6)); color: var(--dsw-alias-label-secondary, #5d6470); font-size: 12px; line-height: 16px; }
.dshP7CompanySettingsAddress code { overflow-wrap: anywhere; color: var(--dsw-alias-label-primary, #1f2329); font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace); font-size: 12px; line-height: 18px; }
.dshP7CompanySettingsField { display: grid; gap: 6px; min-width: 0; color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; line-height: 18px; font-weight: 500; }
.dshP7CompanySettingsInput { width: 100%; min-width: 0; height: 38px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); border-radius: 8px; outline: none; background: var(--dsw-alias-bg-module-platform, #fff); color: inherit; font: inherit; font-weight: 400; box-shadow: inset 0 1px 1px rgb(15 23 42 / 3%); transition: border-color .15s ease, box-shadow .15s ease; }
.dshP7CompanySettingsInput::placeholder { color: var(--dsw-alias-label-tertiary, #8b929d); }
.dshP7CompanySettingsInput:focus-visible { border-color: var(--dsw-alias-brand-primary, #4f46e5); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #4f46e5) 18%, transparent); }
.dshP7CompanySettingsInput:disabled { cursor: not-allowed; opacity: .58; }
.dshP7CompanySettingsActions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dshP7CompanySettingsButton { min-height: 34px; padding: 7px 12px; border: 1px solid transparent; border-radius: 8px; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4f46e5)); color: var(--dsw-alias-button-primary-label, #fff); font: inherit; font-size: 13px; line-height: 18px; font-weight: 500; cursor: pointer; transition: background .15s ease, border-color .15s ease, opacity .15s ease; }
.dshP7CompanySettingsButton:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #4338ca); }
.dshP7CompanySettingsButton:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4f46e5); outline-offset: 2px; }
.dshP7CompanySettingsButton:disabled { cursor: not-allowed; opacity: .52; }
.dshP7CompanySettingsButtonSecondary { border-color: var(--dsw-alias-border-l2, #d1d5db); background: transparent; color: var(--dsw-alias-label-primary, #1f2329); }
.dshP7CompanySettingsButtonSecondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #f3f4f6); }
.dshP7CompanySettingsTextButton { width: fit-content; margin: 1px 0 0; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-brand-primary, #4f46e5); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.dshP7CompanySettingsTextButton:hover:not(:disabled) { text-decoration: underline; }
.dshP7CompanySettingsTextButton:focus-visible { border-radius: 3px; outline: 2px solid var(--dsw-alias-brand-primary, #4f46e5); outline-offset: 2px; }
.dshP7CompanySettingsTextButton:disabled { cursor: not-allowed; opacity: .52; }
.dshP7CompanySettingsStatusHeader { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.dshP7CompanySettingsBadge { display: inline-flex; align-items: center; width: fit-content; max-width: 100%; padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); border-radius: 999px; background: var(--dsw-alias-bg-module-platform, #fff); color: var(--dsw-alias-label-secondary, #5d6470); font-size: 12px; line-height: 16px; font-weight: 500; }
.dshP7CompanySettingsBadge[data-phase="ready"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #1a9b68) 38%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #1a9b68) 10%, transparent); color: var(--dsw-alias-state-success-primary, #178057); }
.dshP7CompanySettingsBadge[data-phase="error"], .dshP7CompanySettingsBadge[data-phase="unauthorized"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d14343) 38%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d14343) 9%, transparent); color: var(--dsw-alias-state-error-primary, #b42318); }
.dshP7CompanySettingsBadge[data-phase="syncing"], .dshP7CompanySettingsBadge[data-phase="stale"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b7791f) 38%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b7791f) 9%, transparent); color: var(--dsw-alias-state-warn-primary, #946114); }
.dshP7CompanySettingsDefinitionGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; margin: 0; }
.dshP7CompanySettingsDefinitionGrid > div { min-width: 0; padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l1, #e5e7eb); }
.dshP7CompanySettingsDefinitionGrid dt { margin: 0 0 4px; color: var(--dsw-alias-label-tertiary, #7a828e); font-size: 12px; line-height: 16px; }
.dshP7CompanySettingsDefinitionGrid dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; line-height: 20px; }
.dshP7CompanySettingsCatalog { display: grid; gap: 12px; }
.dshP7CompanySettingsModelList { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.dshP7CompanySettingsModel { display: grid; gap: 10px; min-width: 0; padding: 14px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 10px; background: color-mix(in srgb, var(--dsw-alias-bg-module-platform, #fff) 92%, var(--dsw-alias-interactive-bg-hover, #f3f4f6)); }
.dshP7CompanySettingsModelHeader { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; min-width: 0; }
.dshP7CompanySettingsModelName { min-width: 0; overflow-wrap: anywhere; font-size: 14px; line-height: 20px; font-weight: 600; }
.dshP7CompanySettingsModel code { min-width: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary, #5d6470); font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace); font-size: 12px; line-height: 18px; }
.dshP7CompanySettingsModelMeta { display: flex; flex-wrap: wrap; gap: 6px; }
.dshP7CompanySettingsModelMeta .dshP7CompanySettingsBadge { overflow-wrap: anywhere; }
.dshP7CompanySettingsToolList { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.dshP7CompanySettingsTool { display: grid; gap: 4px; min-width: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-bg-module-platform, #fff) 92%, var(--dsw-alias-interactive-bg-hover, #f3f4f6)); }
.dshP7CompanySettingsTool > span { color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; line-height: 20px; font-weight: 500; }
.dshP7CompanySettingsTool code { overflow-wrap: anywhere; color: var(--dsw-alias-label-primary, #1f2329); font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace); font-size: 12px; line-height: 18px; }
.dshP7CompanySettingsEmpty { padding: 14px; border: 1px dashed var(--dsw-alias-border-l2, #d1d5db); border-radius: 10px; background: color-mix(in srgb, var(--dsw-alias-bg-module-platform, #fff) 92%, var(--dsw-alias-interactive-bg-hover, #f3f4f6)); }
@media (max-width: 640px) { .dshP7CompanySettings { gap: 18px; } .dshP7CompanySettingsCard { padding: 14px; } .dshP7CompanySettingsDefinitionGrid { grid-template-columns: 1fr; gap: 0; } .dshP7CompanySettingsActions > .dshP7CompanySettingsButton { flex: 1 1 auto; } }
@media (prefers-color-scheme: dark) { .dshP7CompanySettingsCard { box-shadow: none; } .dshP7CompanySettingsInput { background: var(--dsw-alias-bg-module-platform, #1b1d22); } }
`

export function installCompanySettingsStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-plugin-p7-company-models'
  style.dataset.pluginCss = 'dsh-plugin-p7-company-models/settings'
  style.textContent = STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}
