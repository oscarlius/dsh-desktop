/** Desktop-owned management over the official Skill registry and filesystem provider. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { DesktopSkillManagementResponse, DesktopSkillSource } from '../skill-management-contract.ts'
import { DESKTOP_SKILL_CREATOR_NAME } from '../skill-management-contract.ts'
import { desktopDirectoryPicker } from './directory-picker.ts'
import { installDesktopSkillStyles } from './skills-styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'desktop.skills': 'title' | 'language' }
}

export function registerDesktopSkillSettings(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('desktop.skills', {
    zh: { title: 'Skill 管理', language: 'zh' }, en: { title: 'Skills', language: 'en' },
  }), 'Desktop Skill labels')
  ctx.effect(installDesktopSkillStyles, 'Desktop Skill management styles')
  ctx.inject(['sidebarRight', 'sessions', 'conversation'], scope => {
    const t = scope.locale.bind('desktop.skills')
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'desktop-skills', order: 55, locale: 'desktop.skills', label: () => t('title'),
      inject: () => ({ ctx: scope }),
    }, DesktopSkillSettings))
  })
}

export async function requestDesktopSkills(input?: { sources: DesktopSkillSource[]; expectedRevision: string }, signal?: AbortSignal): Promise<DesktopSkillManagementResponse> {
  const path = '/api/desktop-skills'
  const response = await fetch(path, {
    method: input ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error', signal,
    headers: { Accept: 'application/json', ...(input ? { 'Content-Type': 'application/json' } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}),
  })
  const result = await response.json().catch(() => ({})) as DesktopSkillManagementResponse & { error?: string; detail?: string }
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : typeof result.detail === 'string' ? result.detail : `Skill request failed (${response.status})`)
  return result
}

type Props = PropsLocale<'desktop.skills'> & PropsRuntime<'settings.section'> & { ctx: Context }
export function DesktopSkillSettings({ ctx, t, close }: Props) {
  const language = t('language')
  const text = (zh: string, en: string): string => language.startsWith('zh') ? zh : en
  const mounted = ctx.sidebarRight.mounted
  const sessionId = useSyncExternalStore(mounted.subscribe, mounted.getSnapshot)
  const [state, setState] = useState<DesktopSkillManagementResponse>()
  const [sources, setSources] = useState<DesktopSkillSource[]>([])
  const [path, setPath] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const dirty = state !== undefined && JSON.stringify(sources) !== JSON.stringify(state.sources)
  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy(true); setFailure('')
    try {
      const value = await requestDesktopSkills(undefined, signal)
      if (!signal?.aborted) { setState(value); setSources(value.sources) }
    } catch (error) { if (!signal?.aborted) setFailure(error instanceof Error ? error.message : String(error)) }
    finally { if (!signal?.aborted) setBusy(false) }
  }, [])
  useEffect(() => { const abort = new AbortController(); void load(abort.signal); return () => abort.abort() }, [load])
  const save = async () => {
    if (!state || busy) return
    setBusy(true); setFailure('')
    try { const value = await requestDesktopSkills({ sources, expectedRevision: state.revision }); setState(value); setSources(value.sources) }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const add = () => {
    const value = path.trim()
    if (!value || sources.some(source => source.path === value)) return
    setSources([...sources, { path: value, enabled: true }]); setPath('')
  }
  const chooseDirectory = async () => {
    try { const selected = await desktopDirectoryPicker()?.pick(); if (selected) setPath(selected) }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
  }
  const preview = (skillPath: string) => {
    if (!sessionId) return
    const sessions = ctx.get('sessions') as unknown as ISessions
    const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd
    ctx.sidebarRight.openResource(fileAddressFor(sessionId, cwd, skillPath)); close()
  }
  const createWithAgent = () => {
    if (!sessionId) return
    const sessions = ctx.get('sessions') as unknown as ISessions
    const binding = sessions.binding(sessionId)
    if (!binding) { setFailure(text('请先打开一个会话，再创建 Skill。', 'Open a conversation before creating a skill.')); return }
    const result = ctx.conversation.input.requestDraftInitialization(binding, {
      prompt: `/${DESKTOP_SKILL_CREATOR_NAME} ` + text('请帮我创建一个可复用的个人技能。用途：', 'Help me create a reusable personal skill. Purpose: '),
      whenDraftExists: 'keep',
    })
    if (result !== 'applied') { setFailure(result === 'preserved' ? text('输入框已有内容，请先发送或清空，再创建 Skill。', 'Send or clear the existing draft before creating a skill.') : text('当前输入框正忙，请稍后再试。', 'The composer is busy. Try again shortly.')); return }
    close()
  }
  const visible = state?.skills.filter(skill => `${skill.name} ${skill.description ?? ''} ${skill.provider}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? []
  const sourceLabel = (source: string) => ({ runtime: text('内置', 'Built-in'), bundled: text('随应用提供', 'Bundled'), custom: text('自定义', 'Custom'), 'user-dsh': text('个人技能', 'Personal'), 'user-agents': text('用户目录', 'User directory') }[source] ?? source)
  return <div className="dshSkillSettings" data-desktop-skills aria-busy={busy}>
    <div className="dshSkillHeading"><div><h2>{text('Skill 管理', 'Skills')}</h2><p>{text('查看可用技能，管理自己的技能目录。', 'Browse available skills and manage your skill directories.')}</p></div>
      <Button variant="outline" size="sm" disabled={busy || dirty} onClick={() => { void load() }}>{text('刷新列表', 'Refresh')}</Button>
    </div>
    {failure && <p role="alert" className="dshDesktopSettingsError">{failure}</p>}
    {!state && !failure && <p role="status">{text('正在读取技能…', 'Loading skills…')}</p>}
    {state && <>
      <section className="dshSkillSection dshSkillCreator"><div className="dshSkillHeading"><h3>{text('创建我的 Skill', 'Create my skill')}</h3><Button size="sm" disabled={!sessionId || busy} onClick={createWithAgent}>{text('让 Agent 帮我创建', 'Create with Agent')}</Button></div>
        <p className="dshSkillHint">{text('告诉 Agent 技能要做什么，它会整理步骤并保存为你的个人技能。', 'Describe what the skill should do. The Agent will write and save your personal skill.')}</p>
        <code>/{DESKTOP_SKILL_CREATOR_NAME}</code>{!sessionId && <p className="dshSkillHint">{text('先打开一个会话，或在对话中输入上面的指令。', 'Open a conversation, or enter the command above in chat.')}</p>}
      </section>
      <section className="dshSkillSection"><h3>{text('技能目录', 'Skill directories')}</h3>
        <p className="dshSkillHint">{text('内置技能保持可用。添加自定义目录后，保存即可生效，无需重启。', 'Built-in skills remain available. Save custom directories to apply without restarting.')}</p>
        <p className="dshSkillHint">{text('此页管理全局技能目录；项目和预设自带技能仍可通过输入 / 使用。', 'This page manages global skill directories. Project and preset skills remain available through /.')}</p>
        <p className="dshSkillHint">{text('目录示例：skills/技能名称/SKILL.md。', 'Example: skills/skill-name/SKILL.md.')}</p>
        <div className="dshSkillDefaultRoot"><span>{text('默认用户目录', 'Default user directory')}</span><code>{state.userSkillDirectory}</code></div>
        {sources.map((source, index) => <div className="dshSkillSource" key={source.path}>
          <label><input type="checkbox" checked={source.enabled} disabled={busy} aria-label={text('启用目录：', 'Enable directory: ') + source.path} onChange={event => setSources(sources.map((item, n) => n === index ? { ...item, enabled: event.target.checked } : item))} /><code>{source.path}</code></label>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSources(sources.filter((_, n) => n !== index))}>{text('移除', 'Remove')}</Button>
        </div>)}
        <div className="dshSkillAdd"><input className="dshSkillInput" aria-label={text('技能目录路径', 'Skill directory path')} placeholder={text('输入技能目录的完整路径', 'Full path to a skill directory')} value={path} disabled={busy} onChange={event => setPath(event.target.value)} />
          {desktopDirectoryPicker() && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void chooseDirectory() }}>{text('选择目录', 'Choose')}</Button>}
          <Button variant="outline" size="sm" disabled={busy || !path.trim()} onClick={add}>{text('添加', 'Add')}</Button>
        </div>
        {dirty && <div className="dshSkillSave"><span role="status">{text('目录配置尚未保存', 'Unsaved directory changes')}</span><Button variant="ghost" size="sm" disabled={busy} onClick={() => setSources(state.sources)}>{text('取消修改', 'Cancel')}</Button><Button size="sm" disabled={busy} onClick={() => { void save() }}>{text('保存目录配置', 'Save directories')}</Button></div>}
      </section>
      <section className="dshSkillSection"><div className="dshSkillHeading"><h3>{text('可用技能', 'Available skills')} · {state.skills.length}</h3><span className="dshSkillHint">{state.scope === 'session' ? text('当前会话与预设', 'Current session and preset') : text('全局技能', 'Global skills')}</span></div>
        <input className="dshSkillInput" type="search" aria-label={text('搜索技能', 'Search skills')} placeholder={text('搜索名称或描述', 'Search names or descriptions')} value={query} onChange={event => setQuery(event.target.value)} />
        {!visible.length && <p className="dshSkillHint">{text('没有匹配的技能。可添加包含 SKILL.md 的技能目录后刷新。', 'No matching skills. Add a directory containing SKILL.md bundles and refresh.')}</p>}
        {visible.map(skill => <article className="dshSkillCard" key={`${skill.provider}:${skill.name}`}>
          <div className="dshSkillHeading"><strong>{skill.name === DESKTOP_SKILL_CREATOR_NAME ? text('个人 Skill 创建助手', 'Personal skill creator') : skill.name}</strong><div className="dshSkillBadges"><span>{sourceLabel(skill.source)}</span>{skill.invocation.modelInvocable && <span>{text('模型可调用', 'Agent callable')}</span>}{skill.invocation.userInvocable && <span>/{skill.name}</span>}</div></div>
          <p>{skill.description}</p>{skill.path && <code className="dshSkillPath">{skill.path}</code>}
          {skill.path && sessionId && <Button variant="ghost" size="sm" onClick={() => preview(skill.path!)}>{text('查看 SKILL.md', 'View SKILL.md')}</Button>}
        </article>)}
      </section>
    </>}
  </div>
}
