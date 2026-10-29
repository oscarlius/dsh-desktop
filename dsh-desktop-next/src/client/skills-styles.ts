const ID = 'dsh-desktop-skill-settings'
export const DESKTOP_SKILL_CSS = `
.dshSkillSettings { display:flex;flex-direction:column;gap:24px;max-width:760px;color:var(--dsw-alias-label-primary);font-size:13px; }
.dshSkillSettings h2,.dshSkillSettings h3,.dshSkillSettings p { margin:0; }
.dshSkillSettings h2 { font-size:20px;line-height:28px; }.dshSkillSettings h3 { font-size:15px;line-height:22px; }
.dshSkillHeading { display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap; }
.dshSkillHeading p,.dshSkillHint { color:var(--dsw-alias-label-tertiary);line-height:20px; }.dshSkillHeading p { margin-top:4px; }
.dshSkillSection { display:flex;flex-direction:column;gap:12px; }
.dshSkillCreator { padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1); }
.dshSkillInput { min-width:0;width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit; }
.dshSkillInput:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px; }
.dshSkillDefaultRoot,.dshSkillCard { padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1); }
.dshSkillDefaultRoot { display:flex;flex-direction:column;gap:6px; }.dshSkillDefaultRoot>span { color:var(--dsw-alias-label-tertiary); }
.dshSkillSettings code { font-family:var(--ds-font-family-code,monospace);font-size:11px;overflow-wrap:anywhere; }
.dshSkillSource { display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px; }
.dshSkillSource label { display:flex;align-items:center;gap:10px;min-width:0; }.dshSkillSource input { flex:none;accent-color:var(--dsw-alias-brand-primary); }
.dshSkillAdd { display:flex;align-items:center;gap:8px; }.dshSkillAdd>.dshSkillInput { flex:1; }
.dshSkillSave { display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap; }.dshSkillSave>span { margin-right:auto;color:var(--dsw-alias-label-tertiary); }
.dshSkillCard { display:flex;flex-direction:column;align-items:flex-start;gap:8px; }.dshSkillCard>.dshSkillHeading { width:100%; }.dshSkillCard p { line-height:20px; }
.dshSkillBadges { display:flex;gap:6px;flex-wrap:wrap; }.dshSkillBadges span { border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 6px;font-size:11px;color:var(--dsw-alias-label-secondary); }
.dshSkillPath { color:var(--dsw-alias-label-tertiary); }
@media(max-width:540px) { .dshSkillAdd { flex-wrap:wrap; }.dshSkillAdd>.dshSkillInput { flex-basis:100%; } }
`
export function installDesktopSkillStyles(): () => void {
  if (typeof document === 'undefined' || document.getElementById(ID)) return () => {}
  const style = document.createElement('style'); style.id = ID; style.textContent = DESKTOP_SKILL_CSS; document.head.append(style)
  return () => style.remove()
}
