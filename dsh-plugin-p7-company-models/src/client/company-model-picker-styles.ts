const STYLE_ID = 'p7-company-model-picker-styles'
export const COMPANY_MODEL_PICKER_CSS = `
.p7ModelPicker { display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;font-size:13px; }
.p7ModelPicker>span { min-width:0; }
.p7ReasoningPill>svg { flex-shrink:0; }
.p7ModelPicker button { font-family:inherit; }
.p7ModelButton,.p7ReasoningPill { display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;box-sizing:border-box;border:0;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;line-height:20px;white-space:nowrap;font-size:12px; }
.p7ModelButton { padding:0 4px;min-width:0;max-width:min(240px,30cqw);border-radius:8px; }
.p7ModelName { display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.p7ReasoningPill { padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1); }
.p7ReasoningValue { font-weight:500;color:var(--dsw-alias-label-primary); }
.p7ReasoningDivider { margin:0 5px;color:var(--dsw-alias-label-tertiary); }
.p7ModelButton:hover:not(:disabled),.p7ReasoningPill:hover:not(:disabled),.p7ReasoningPill[aria-expanded=true] { background:var(--dsw-alias-interactive-bg-hover); }
.p7ModelButton:focus-visible,.p7ReasoningPill:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px; }
.p7ModelButton:disabled,.p7ReasoningPill:disabled { opacity:.5;cursor:default; }
.p7ModelMenu,.p7ReasoningMenu { background:var(--dsw-alias-bg-layer-2)!important;border:1px solid var(--dsw-alias-border-l1)!important;box-shadow:var(--dsw-elevation-prominent,0 8px 28px #0000001a); }
.p7ModelMenu { width:280px;max-width:calc(100vw - 24px);max-height:min(420px,65vh);overflow-y:auto; }
.p7ReasoningMenu { width:244px;max-width:calc(100vw - 24px);padding:6px!important;border-radius:16px!important; }
.p7ReasoningMenu [role=menuitem] { min-height:60px;border-radius:10px; }
.p7ReasoningOption { display:flex;flex-direction:column;gap:3px;padding:3px 0;text-align:left; }
.p7ReasoningOptionTitle { font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary); }
.p7ReasoningOptionDetail { font-size:12px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-tertiary); }
.p7ModelGroup { padding:8px 12px 4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px; }
.p7ModelNotice { padding:10px 12px;color:var(--dsw-alias-label-secondary);font-size:12px; }
.p7ModelNotice button { margin-left:8px;color:var(--dsw-alias-brand-primary);border:0;background:transparent;cursor:pointer; }
.p7ModelSearch { padding:6px 8px; }
.p7ModelSearch input { width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;font:inherit;outline:none; }
.p7ModelSearch input:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary)); }
@media(max-width:520px) { .p7ModelPicker{gap:4px}.p7ModelButton{max-width:26vw}.p7ReasoningPill{padding:0 8px;gap:4px}.p7ReasoningPill>svg:first-child{display:none} }
`
/** Both renderer entry points load this company plugin and the same stylesheet. */
export function installCompanyModelPickerStyles(): () => void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-plugin-p7-company-models'
  style.dataset.pluginCss = 'dsh-plugin-p7-company-models/model-picker'
  style.textContent = COMPANY_MODEL_PICKER_CSS
  document.head.appendChild(style)
  return () => style.remove()
}
