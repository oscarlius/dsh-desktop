/** Company presentation over Harness's shared, durable model-selection service. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelDirectoryState, ModelSelectInjected } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutlineRegular, IconRefreshOutlineRegular, IconSparkleRegular, IconWarningOutlineRegular,
  Menu, MenuItemButton, StateDot, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CompanySettingsLocaleKey } from './locales.js'
import { installCompanyModelPickerStyles } from './company-model-picker-styles.js'

type Selection = Parameters<ModelSelectInjected['select']>[0]
type Model = ModelDirectoryState['groups'][number]['models'][number]
type Props = ModelSelectInjected & Pick<PropsRuntime<'conversation.input.model'>, 'locked'>
  & PropsLocale<'p7-company-models'>
interface EffortOption { key: string; effort: string; label: string }

const FRIENDLY_EFFORTS: Record<string, readonly [CompanySettingsLocaleKey, CompanySettingsLocaleKey]> = {
  off: ['reasoningOff', 'reasoningOffDetail'],
  none: ['reasoningOff', 'reasoningOffDetail'],
  minimal: ['reasoningMinimal', 'reasoningMinimalDetail'],
  low: ['reasoningFast', 'reasoningFastDetail'],
  medium: ['reasoningStandard', 'reasoningStandardDetail'],
  high: ['reasoningDeep', 'reasoningDeepDetail'],
  xhigh: ['reasoningExtraDeep', 'reasoningExtraDeepDetail'],
  max: ['reasoningMaximum', 'reasoningMaximumDetail'],
}

const P7_COMPANY_PROVIDER_IDS = new Set([
  'p7-company-chat', 'p7-company-responses', 'p7-company-messages',
])

function modelDefault(provider: string, model: Model): string | undefined {
  return provider.startsWith('p7-company-') && model.reasoning?.efforts.some(level => level.id === 'low')
    ? 'low' : model.reasoning?.defaultEffort
}

/** Register once for both Electron and this Host's ordinary browser entry. */
export function registerCompanyModelPicker(ctx: Context): void {
  ctx.effect(installCompanyModelPickerStyles, 'p7-company-models: model and reasoning controls')
  ctx.inject(['slots', 'modelDirectories', 'sessions', 'remote', 'remote.session'], scope => {
    scope.slots.inject('conversation.input.model', () => scope.slots.register({
      name: 'conversation.input.model', priority: -100, locale: 'p7-company-models',
      // Lowest priority wins; the upstream entry stays registered as fallback.
      // Its inline model-label child remains the sole declaration of that seat.
      inject: (sessionId): ModelSelectInjected => {
        const directory = scope.modelDirectories.directoryFor(sessionId)
        const available = scope.sessions.subagentAddress(sessionId) === undefined
        return { available, directory: directory.store,
          load: () => { if (available) void directory.load().catch(() => {}) },
          select: selection => available ? directory.select(selection) : Promise.resolve(undefined),
        }
      },
    }, CompanyModelPicker))
  })
}

export function CompanyModelPicker({ available, locked, directory, load, select, t }: Props) {
  const state = useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot())
  const [open, setOpen] = useState<'model' | 'reasoning' | null>(null)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewEffort, setPreviewEffort] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const migrationAttempt = useRef<string | null>(null)
  const busy = saving || state.pending !== null
  const choices = useMemo(() => state.groups.flatMap(group => group.models.map(model => ({ group, model }))), [state.groups])
  const current = choices.find(({ group, model }) => group.id === state.current?.provider && model.id === state.current.model)
  const effectiveEffort = state.current?.reasoningEffort ?? (current && modelDefault(current.group.id, current.model))
  const efforts = useMemo<EffortOption[]>(() => {
    if (!current?.model.reasoning?.efforts.length) return []
    return current.model.reasoning.efforts.map(level => {
      const friendly = FRIENDLY_EFFORTS[level.id]
      return { key: `effort:${level.id}`, effort: level.id,
        label: friendly ? t(friendly[0]) : level.name,
      }
    })
  }, [current, t])
  const selectedEffort = efforts.find(option => option.effort === effectiveEffort)
  const previewIndex = Math.max(0, efforts.findIndex(option => option.effort === (previewEffort ?? effectiveEffort)))
  const previewOption = efforts[previewIndex]
  const previewLabel = previewEffort === null && effectiveEffort === undefined ? t('reasoningProviderDefault') : previewOption?.label
  const progress = efforts.length < 2 ? 0 : previewIndex / (efforts.length - 1) * 100
  const submit = useCallback(async (selection: Selection, close = true): Promise<boolean> => {
    if (locked || busy) return false
    setSaving(true); setError(null)
    try {
      const result = await select(selection)
      if (!result?.ok) {
        setError(t(result?.error.code === 'session/writer-held' ? 'pickerSessionInUse' : 'pickerSelectionFailed'))
        return false
      }
      if (close) setOpen(null)
      return true
    } catch { setError(t('pickerSelectionFailed')); return false }
    finally { setSaving(false) }
  }, [busy, locked, select, t])
  useEffect(() => { if (available) load() }, [available, load])
  // A changed model must not leave the previous model's effort menu on screen.
  useEffect(() => { setOpen(null); setQuery(''); setError(null); setPreviewEffort(null) }, [state.current?.provider, state.current?.model])
  useEffect(() => { setPreviewEffort(null) }, [state.current?.reasoningEffort])
  useEffect(() => {
    const current = state.current
    if (!available || locked || busy || state.pending !== null || state.status !== 'ready' || state.routable !== false
      || current === null || !P7_COMPANY_PROVIDER_IDS.has(current.provider)) return
    const targets = choices.filter(({ group, model }) => group.id !== current.provider
      && P7_COMPANY_PROVIDER_IDS.has(group.id) && model.id === current.model)
    if (targets.length !== 1) return
    const target = targets[0]!
    const key = `${current.provider}:${current.model}->${target.group.id}`
    if (migrationAttempt.current === key) return
    migrationAttempt.current = key
    const effort = current.reasoningEffort !== undefined && target.model.reasoning?.efforts.some(level => level.id === current.reasoningEffort)
      ? current.reasoningEffort : modelDefault(target.group.id, target.model)
    void submit({ provider: target.group.id, model: target.model.id, ...(effort === undefined ? {} : { reasoningEffort: effort }) }, false)
  }, [available, busy, choices, locked, state.current, state.pending, state.routable, state.status, submit])

  if (!available) return null
  const chooseModel = (provider: string, model: Model): void => {
    if (state.current?.provider === provider && state.current.model === model.id) { setOpen(null); return }
    const effort = modelDefault(provider, model)
    void submit({ provider, model: model.id, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
  }
  const chooseEffort = async (effort: string): Promise<void> => {
    const option = efforts.find(item => item.effort === effort)
    if (!option || !state.current) return
    if (option.effort === effectiveEffort) { setPreviewEffort(null); return }
    await submit({ provider: state.current.provider, model: state.current.model, reasoningEffort: option.effort }, false)
    setPreviewEffort(null)
  }
  const resetEffort = (): void => {
    if (!current || !state.current) return
    const effort = modelDefault(current.group.id, current.model)
    setPreviewEffort(effort ?? null)
    if (effort === effectiveEffort) return
    if (effort !== undefined) { void chooseEffort(effort); return }
    void submit({ provider: state.current.provider, model: state.current.model }, false).then(committed => {
      if (!committed) setPreviewEffort(null)
    })
  }
  const filtered = query.trim().toLocaleLowerCase()
  const visibleGroups = state.groups.map(group => ({ ...group, models: group.models.filter(model =>
    !filtered || `${model.name} ${group.name}`.toLocaleLowerCase().includes(filtered)) })).filter(group => group.models.length)
  const label = current?.model.name ?? state.current?.model ?? t('pickerChooseModel')

  return <div className="p7ModelPicker" ref={root} data-p7-model-picker="">
    <Menu open={open === 'model'} onClose={() => setOpen(null)} side="top" align="end" portal autoFocus
      listClassName="p7ModelMenu" anchor={<button type="button" className="p7ModelButton" disabled={locked || busy}
        aria-label={`${t('pickerChooseModel')}：${label}`} aria-haspopup="menu" aria-expanded={open === 'model'} aria-busy={busy}
        title={label} onClick={() => { setOpen(open === 'model' ? null : 'model'); setQuery('') }}>
        <span className="p7ModelName" data-provider-id={current?.group.id} data-model-id={current?.model.id}>{label}</span>
        {busy ? <StateDot state="ongoing" /> : <IconChevronDownOutlineRegular size={12} />}
      </button>}>
      {choices.length > 4 && <div className="p7ModelSearch"><input type="search" value={query}
        aria-label={t('pickerSearch')} placeholder={t('pickerSearch')} onChange={event => setQuery(event.target.value)} /></div>}
      {state.status === 'loading' && <div className="p7ModelNotice" role="status">{t('pickerLoading')}</div>}
      {state.error && <div className="p7ModelNotice" role="alert">{t('pickerLoadFailed')}
        <button type="button" disabled={busy} onClick={load}>{t('pickerRetry')}</button></div>}
      {visibleGroups.map(group => <div key={group.id}>
        <div className="p7ModelGroup">{group.name}</div>
        {group.models.map(model => <MenuItemButton key={model.id} current={state.current?.provider === group.id && state.current.model === model.id}
          disabled={busy} onSelect={() => chooseModel(group.id, model)}>
          {model.name}
        </MenuItemButton>)}
      </div>)}
      {state.status !== 'loading' && !visibleGroups.length && <div className="p7ModelNotice" role="status">{t('pickerNoModels')}</div>}
      {state.failures.map(failure => <div key={failure.id} className="p7ModelNotice" role="status">{failure.name} · {t('pickerLoadFailed')}</div>)}
    </Menu>
    {efforts.length > 0 && <Menu open={open === 'reasoning'} onClose={() => { setOpen(null); setPreviewEffort(null) }} side="top" align="end" portal
      listClassName="p7ReasoningMenu"
      anchor={<button type="button" className="p7ReasoningPill" disabled={locked || busy}
        aria-label={`${t('reasoningLabel')}：${selectedEffort?.label ?? t('reasoningProviderDefault')}`}
        aria-haspopup="dialog" aria-expanded={open === 'reasoning'}
        onClick={() => { setPreviewEffort(null); setOpen(open === 'reasoning' ? null : 'reasoning') }}>
        <IconSparkleRegular size={14} /><span>{t('reasoningLabel')}<span className="p7ReasoningDivider">·</span>
          <span className="p7ReasoningValue">{selectedEffort?.label ?? t('reasoningProviderDefault')}</span></span>
        <IconChevronDownOutlineRegular size={12} />
      </button>}>
      <div className="p7ReasoningSlider" role="dialog" aria-label={t('reasoningLabel')}>
        <div className="p7ReasoningSliderHeader">
          <button type="button" className="p7ReasoningFastest" disabled={locked || busy} aria-label={t('reasoningFast')} onClick={() => { setPreviewEffort(efforts[0]?.effort ?? null); void chooseEffort(efforts[0]?.effort ?? '') }}>
            <IconSparkleRegular size={14} />
          </button>
          <span className="p7ReasoningSliderValue" aria-live="polite">{previewLabel}</span>
          <button type="button" className="p7ReasoningReset" disabled={locked || busy} aria-label={t('reasoningReset')} onClick={resetEffort}><IconRefreshOutlineRegular size={14} /></button>
        </div>
        <button type="button" className="p7ReasoningModel" disabled={locked || busy} onClick={() => { setOpen('model'); setQuery('') }}>{label}<IconChevronDownOutlineRegular size={12} /></button>
        <div className="p7ReasoningRangeWrap">
          <span className="p7ReasoningRail" aria-hidden="true"><i style={{ width: `calc(${progress}% + ${13 - 26 * progress / 100}px)` }} /></span>
          <input className="p7ReasoningRange" type="range" min="0" max={Math.max(0, efforts.length - 1)} step="1" value={previewIndex}
            disabled={locked || busy} aria-label={t('reasoningLabel')} aria-valuetext={previewLabel}
            onChange={event => setPreviewEffort(efforts[Number(event.target.value)]?.effort ?? null)}
            onPointerUp={event => { const option = efforts[Number(event.currentTarget.value)]; if (option) void chooseEffort(option.effort) }}
            onPointerCancel={() => setPreviewEffort(null)}
            onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) event.stopPropagation() }}
            onKeyUp={event => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key)) return; event.stopPropagation(); const option = efforts[Number(event.currentTarget.value)]; if (option) void chooseEffort(option.effort) }} />
          <span className="p7ReasoningDots" aria-hidden="true">{efforts.map(option => <i key={option.key} className={option.effort === previewOption?.effort ? 'active' : undefined} />)}</span>
        </div>
      </div>
    </Menu>}
    {error && <Toast text={error} icon={<IconWarningOutlineRegular />} anchor={root.current?.closest<HTMLElement>('[data-composer-card]') ?? root.current}
      onDone={() => setError(null)} />}
  </div>
}
