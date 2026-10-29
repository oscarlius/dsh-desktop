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
.p7ReasoningMenu { width:255px;max-width:calc(100vw - 24px);padding:10px 12px!important;border-radius:18px!important;overflow:visible!important; }
.p7ReasoningSlider { --p7-reasoning-accent:var(--dsw-alias-brand-primary-new-colorprimary-new-color);--p7-reasoning-rail:var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:4px;min-width:0; }
.p7ReasoningSliderHeader { display:grid;grid-template-columns:1fr auto 1fr;align-items:center;min-height:20px; }
.p7ReasoningFastest,.p7ReasoningReset,.p7ReasoningModel { border:0;background:transparent;font:inherit;cursor:pointer; }
.p7ReasoningFastest { justify-self:start;display:grid;place-items:center;width:22px;height:22px;padding:0;border-radius:999px;color:var(--dsw-alias-label-secondary); }
.p7ReasoningSliderValue { color:var(--p7-reasoning-accent);font-size:13px;font-weight:600;line-height:20px; }
.p7ReasoningReset { justify-self:end;display:grid;place-items:center;width:22px;height:22px;padding:0;border-radius:999px;color:var(--dsw-alias-label-secondary); }
.p7ReasoningFastest:hover:not(:disabled),.p7ReasoningReset:hover:not(:disabled),.p7ReasoningModel:hover:not(:disabled) { color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover); }
.p7ReasoningFastest:disabled,.p7ReasoningReset:disabled,.p7ReasoningModel:disabled { cursor:default;opacity:.5; }
.p7ReasoningModel { align-self:center;display:inline-flex;align-items:center;gap:3px;max-width:100%;padding:0 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px; }
.p7ReasoningModel svg { flex:none; }
.p7ReasoningRangeWrap { position:relative;height:24px;display:grid;align-items:center;margin:2px 2px 0; }
.p7ReasoningRange { grid-area:1/1;width:100%;height:24px;margin:0;appearance:none;background:transparent;cursor:pointer;z-index:1; }
.p7ReasoningRail { grid-area:1/1;align-self:center;height:24px;border-radius:999px;background:var(--p7-reasoning-rail);overflow:hidden;z-index:0; }
.p7ReasoningRail i { display:block;height:100%;border-radius:inherit;background:var(--p7-reasoning-accent); }
.p7ReasoningRange::-webkit-slider-runnable-track { height:24px;border-radius:999px;background:transparent; }
.p7ReasoningRange::-moz-range-track { height:24px;border-radius:999px;background:transparent; }
.p7ReasoningRange::-webkit-slider-thumb { appearance:none;width:26px;height:26px;margin-top:-1px;border:2px solid var(--dsw-alias-bg-layer-2);border-radius:50%;background:var(--dsw-alias-bg-layer-2);box-shadow:0 1px 4px #00000033; }
.p7ReasoningRange::-moz-range-thumb { width:22px;height:22px;border:2px solid var(--dsw-alias-bg-layer-2);border-radius:50%;background:var(--dsw-alias-bg-layer-2);box-shadow:0 1px 4px #00000033; }
.p7ReasoningRange:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:3px;border-radius:999px; }
.p7ReasoningRange:disabled { cursor:default;opacity:.5; }
.p7ReasoningDots { pointer-events:none;grid-area:1/1;display:flex;justify-content:space-between;align-items:center;padding:0 13px;z-index:0; }
.p7ReasoningDots i { display:block;width:3px;height:3px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent); }
.p7ReasoningDots i.active { width:4px;height:4px;background:var(--dsw-alias-bg-layer-2); }
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
