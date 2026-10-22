import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CompanyStatus } from '../public-status.js'
import type { P7AccountStatus, P7Usage } from '../account-broker.js'
import { DEFAULT_P7_PUBLIC_ORIGIN } from '../defaults.js'
import { createCompanyModelsApi, type CompanyModelsApi } from './api.js'
import type { CompanySettingsLocaleKey } from './locales.js'

const POLL_MS = 5_000
const ACCOUNT_PENDING_POLL_MS = 1_000
const MAX_ACCOUNT_PENDING_POLLS = 60

export type CompanySettingsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'p7-company-models'> & {
  api?: CompanyModelsApi
}

function statusKey(phase: CompanyStatus['phase']): CompanySettingsLocaleKey {
  return phase === 'syncing' ? 'syncing' : phase
}
function toolStatusKey(phase: CompanyStatus['tools']['phase']): CompanySettingsLocaleKey {
  return phase === 'registered' ? 'toolsRegistered' : phase === 'syncing' ? 'toolsSyncing' : 'toolsUnavailable'
}
function toolLabel(name: string, t: CompanySettingsSectionProps['t']): string | undefined {
  if (name === 'mcp__p7__gildata__FinQuery') return t('toolGildata')
  if (name === 'mcp__p7__search__web_search') return t('toolWebSearch')
  return undefined
}

function dateValue(value: number | null, t: CompanySettingsSectionProps['t']): string {
  return value === null ? t('never') : new Date(value).toLocaleString()
}
function accountBadge(status: P7AccountStatus | undefined, t: CompanySettingsSectionProps['t']): string {
  switch (status?.phase) {
    case 'signed-in': return t('signedIn')
    case 'pending': return t('accountPending')
    case 'approval-required': return t('accountApprovalRequired')
    case 'upgrade-required': return t('accountUpgradeRequired')
    case 'expired': return t('accountExpired')
    case 'error': return t('accountError')
    default: return t('signedOut')
  }
}
function shanghaiMonthStart(now: Date): string {
  const values = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(now)
  const year = values.find(part => part.type === 'year')?.value
  const month = values.find(part => part.type === 'month')?.value
  if (!year || !month) throw new Error('Unable to determine the Shanghai usage month.')
  return `${year}-${month}-01T00:00:00+08:00`
}

export function CompanySettingsSection({ api: suppliedApi, t }: CompanySettingsSectionProps) {
  const apiRef = useRef<CompanyModelsApi | undefined>(undefined)
  if (apiRef.current === undefined) apiRef.current = suppliedApi ?? createCompanyModelsApi()
  const api = apiRef.current
  const [status, setStatus] = useState<CompanyStatus>()
  const [origin, setOrigin] = useState(DEFAULT_P7_PUBLIC_ORIGIN)
  const [apiKey, setApiKey] = useState('')
  const [editingOrigin, setEditingOrigin] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [pending, setPending] = useState<'connect' | 'sync' | 'disconnect'>()
  const [error, setError] = useState<string>()
  const [account, setAccount] = useState<P7AccountStatus>()
  const [usage, setUsage] = useState<P7Usage>()
  const [accountBusy, setAccountBusy] = useState(false)
  const request = useRef<AbortController>()
  const accountRequest = useRef<AbortController>()
  const sequence = useRef(0)
  const accountSequence = useRef(0)
  const accountRef = useRef<P7AccountStatus>()
  const refreshAccountRef = useRef<(loadUsage?: boolean) => Promise<void>>()
  const originRef = useRef(origin)
  const apiKeyRef = useRef(apiKey)

  const run = useCallback(async (operation: 'status' | 'connect' | 'sync' | 'disconnect') => {
    if (request.current !== undefined) return
    const connectInput = operation === 'connect' ? {
      origin: originRef.current.trim(),
      apiKey: apiKeyRef.current,
    } : undefined
    if (connectInput !== undefined && (!connectInput.origin || !connectInput.apiKey)) return
    if (connectInput !== undefined) {
      apiKeyRef.current = ''
      setApiKey('')
    }
    const controller = new AbortController()
    const current = ++sequence.current
    request.current = controller
    if (operation !== 'status') setPending(operation)
    setError(undefined)
    try {
      const next = operation === 'status' ? await api.status(controller.signal)
        : operation === 'connect' ? await api.connect(connectInput!, controller.signal)
          : operation === 'sync' ? await api.sync(controller.signal)
            : await api.disconnect(controller.signal)
      if (!controller.signal.aborted && sequence.current === current) {
        setStatus(next)
        void refreshAccountRef.current?.(false)
        if (operation === 'connect' || operation === 'disconnect') {
          if (operation === 'connect') setReconnecting(false)
          if (operation === 'disconnect') {
            originRef.current = DEFAULT_P7_PUBLIC_ORIGIN
            setOrigin(DEFAULT_P7_PUBLIC_ORIGIN)
          }
        }
        if (operation === 'status' && (next.phase === 'disconnected' || next.phase === 'unauthorized' || next.phase === 'error') && next.origin !== null) {
          originRef.current = next.origin
          setOrigin(next.origin)
        }
      }
    } catch {
      if (!controller.signal.aborted && sequence.current === current) setError(operation === 'status' ? t('unavailable') : t('requestFailed'))
    } finally {
      if (request.current === controller) {
        request.current = undefined
        setPending(undefined)
      }
    }
  }, [api, t])

  useEffect(() => {
    void run('status')
    const timer = window.setInterval(() => { void run('status') }, POLL_MS)
    return () => {
      window.clearInterval(timer)
      sequence.current++
      request.current?.abort()
      request.current = undefined
    }
  }, [run])

  const refreshAccount = useCallback(async (loadUsage = true) => {
    if (accountRequest.current !== undefined) return
    const controller = new AbortController()
    const current = ++accountSequence.current
    accountRequest.current = controller
    try {
      const next = await api.accountStatus(controller.signal)
      if (controller.signal.aborted || accountSequence.current !== current) return
      const transitionedToSignedIn = accountRef.current?.phase !== 'signed-in' && next.phase === 'signed-in'
      accountRef.current = next
      setAccount(next)
      if (next.phase !== 'signed-in') { setUsage(undefined); return }
      if (!loadUsage && !transitionedToSignedIn) return
      const now = new Date()
      const nextUsage = await api.accountUsage({ from: shanghaiMonthStart(now), to: now.toISOString(), groupBy: 'service' }, controller.signal)
      if (!controller.signal.aborted && accountSequence.current === current) setUsage(nextUsage)
    } catch {
      // A temporary local HTTP failure must not replace a pending or signed-in
      // status with a misleading signed-out badge.
    } finally {
      if (accountRequest.current === controller) accountRequest.current = undefined
    }
  }, [api])
  refreshAccountRef.current = refreshAccount
  useEffect(() => { void refreshAccount() }, [refreshAccount])
  useEffect(() => {
    if (account?.phase !== 'pending') return
    let polls = 0
    const timer = window.setInterval(() => {
      if (++polls > MAX_ACCOUNT_PENDING_POLLS) { window.clearInterval(timer); return }
      void refreshAccount(false)
    }, ACCOUNT_PENDING_POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [account?.phase, refreshAccount])
  useEffect(() => () => {
    accountSequence.current++
    accountRequest.current?.abort()
    accountRequest.current = undefined
  }, [])
  const signIn = async () => {
    if (accountBusy) return; setAccountBusy(true)
    try { const next = await api.accountLogin(); accountRef.current = next; setAccount(next) } catch { setError(t('requestFailed')) } finally { setAccountBusy(false) }
  }
  const signOut = async () => {
    if (accountBusy) return
    accountSequence.current++
    accountRequest.current?.abort()
    accountRequest.current = undefined
    setAccountBusy(true)
    try { const next = await api.accountLogout(); accountRef.current = next; setAccount(next); setUsage(undefined) } catch { setError(t('requestFailed')) } finally { setAccountBusy(false) }
  }

  const connected = status !== undefined
    && (status.phase === 'syncing' || status.phase === 'ready' || status.phase === 'stale')
    && !reconnecting
  const busy = pending !== undefined
  const beginReconnect = () => {
    request.current?.abort()
    request.current = undefined
    sequence.current++
    const currentOrigin = status?.origin ?? DEFAULT_P7_PUBLIC_ORIGIN
    setOrigin(currentOrigin)
    originRef.current = currentOrigin
    setApiKey('')
    apiKeyRef.current = ''
    setReconnecting(true)
    setPending(undefined)
    setError(undefined)
  }

  const phase = status?.phase ?? 'syncing'
  const loginGate = status?.loginRequired === true && account?.phase !== 'signed-in'
  if (loginGate) return <section className="dshP7CompanySettings dshP7CompanyLoginGate" aria-labelledby="p7-company-login-title">
    <header className="dshP7CompanySettingsHeader"><h2 id="p7-company-login-title">{t('loginRequiredTitle')}</h2><p className="dshP7CompanySettingsIntro">{t('loginRequiredIntro')}</p></header>
    {error !== undefined && <p className="dshP7CompanySettingsAlert" role="alert">{error}</p>}
    <section className="dshP7CompanySettingsCard" aria-label={t('accountTitle')}>
      <div className="dshP7CompanySettingsStatusHeader"><h3>{t('accountTitle')}</h3><span className="dshP7CompanySettingsBadge" data-phase={account?.phase ?? 'signed-out'}>{accountBadge(account, t)}</span></div>
      <p>{account?.message ?? t('loginRequiredStatus')}</p>
      {account?.phase === 'upgrade-required' && account.upgradeUrl && <p><a href={account.upgradeUrl} target="_blank" rel="noreferrer">{t('downloadUpdate')}</a></p>}
      <div className="dshP7CompanySettingsActions"><button className="dshP7CompanySettingsButton" type="button" disabled={accountBusy || account?.phase === 'pending'} onClick={() => { void signIn() }}>{t(account?.phase === 'pending' ? 'accountPending' : 'signIn')}</button><button className="dshP7CompanySettingsButton dshP7CompanySettingsButtonSecondary" type="button" disabled={accountBusy} onClick={() => { void refreshAccount(false) }}>{t('refreshLoginStatus')}</button></div>
    </section>
  </section>
  return <section className="dshP7CompanySettings" aria-labelledby="p7-company-models-title">
    <header className="dshP7CompanySettingsHeader">
      <h2 id="p7-company-models-title">{t('title')}</h2>
      <p className="dshP7CompanySettingsIntro">{t('intro')}</p>
    </header>
    {error !== undefined && <p className="dshP7CompanySettingsAlert" role="alert">{error}</p>}
    {status?.message && <p className="dshP7CompanySettingsNotice" role="status">{status.message}</p>}
    <section className="dshP7CompanySettingsCard" aria-label={t('accountTitle')}>
      <div className="dshP7CompanySettingsStatusHeader"><h3>{t('accountTitle')}</h3><span className="dshP7CompanySettingsBadge" data-phase={account?.phase ?? 'signed-out'}>{accountBadge(account, t)}</span></div>
      {account?.phase === 'signed-in' && account.profile ? <><p>{account.profile.displayName}</p>{usage && <dl className="dshP7CompanySettingsDefinitionGrid"><div><dt>{t('monthRequests')}</dt><dd>{usage.totals.requests}</dd></div><div><dt>{t('monthSearches')}</dt><dd>{usage.totals.searchCalls}</dd></div><div><dt>{t('monthInput')}</dt><dd>{usage.totals.inputTokens ?? '—'}</dd></div><div><dt>{t('monthOutput')}</dt><dd>{usage.totals.outputTokens ?? '—'}</dd></div></dl>}</> : <p>{account?.message ?? t('accountIntro')}</p>}
      {account?.phase === 'upgrade-required' && account.upgradeUrl && <p><a href={account.upgradeUrl} target="_blank" rel="noreferrer">{t('downloadUpdate')}</a></p>}
      <div className="dshP7CompanySettingsActions"><button className="dshP7CompanySettingsButton" type="button" disabled={accountBusy || account?.phase === 'pending' || status?.origin === null} onClick={() => { void (account?.phase === 'signed-in' ? signOut() : signIn()) }}>{account?.phase === 'signed-in' ? t('signOut') : t('signIn')}</button><button className="dshP7CompanySettingsButton dshP7CompanySettingsButtonSecondary" type="button" disabled={accountBusy} onClick={() => { void refreshAccount() }}>{t('refreshUsage')}</button></div>
    </section>
    {!connected ? <section className="dshP7CompanySettingsCard" aria-label={t('title')}>
      <div className="dshP7CompanySettingsCardHeader"><h3>{t('connect')}</h3></div>
      <form className="dshP7CompanySettingsForm" onSubmit={event => { event.preventDefault(); void run('connect') }}>
        {!editingOrigin ? <div className="dshP7CompanySettingsAddress"><span>{t('origin')}</span><code>{origin}</code><button className="dshP7CompanySettingsTextButton" type="button" disabled={busy} onClick={() => { setEditingOrigin(true) }}>{t('changeAddress')}</button></div>
          : <><label className="dshP7CompanySettingsField">{t('origin')}<input className="dshP7CompanySettingsInput" aria-label={t('origin')} value={origin} placeholder={t('originPlaceholder')} disabled={busy} onChange={event => { const value = event.currentTarget.value; originRef.current = value; setOrigin(value) }} /></label><button className="dshP7CompanySettingsTextButton" type="button" disabled={busy} onClick={() => { originRef.current = DEFAULT_P7_PUBLIC_ORIGIN; setOrigin(DEFAULT_P7_PUBLIC_ORIGIN); setEditingOrigin(false) }}>{t('useDefaultAddress')}</button></>}
        <label className="dshP7CompanySettingsField">{t('apiKey')}<input className="dshP7CompanySettingsInput" aria-label={t('apiKey')} type="password" value={apiKey} placeholder={t('apiKeyPlaceholder')} disabled={busy} onChange={event => { const value = event.currentTarget.value; apiKeyRef.current = value; setApiKey(value) }} /></label>
        <div className="dshP7CompanySettingsActions"><button className="dshP7CompanySettingsButton" type="submit" disabled={busy || !origin.trim() || !apiKey}>{t(pending === 'connect' ? 'connecting' : 'connect')}</button><button className="dshP7CompanySettingsButton dshP7CompanySettingsButtonSecondary" type="button" disabled={busy || !apiKey} onClick={() => { apiKeyRef.current = ''; setApiKey('') }}>{t('cancel')}</button></div>
      </form>
    </section> : null}
    <section className="dshP7CompanySettingsCard" aria-label={t('status')}>
      <div className="dshP7CompanySettingsStatusHeader"><h3>{t('status')}</h3><span className="dshP7CompanySettingsBadge" data-phase={phase}>{t(statusKey(phase))}</span></div>
      <dl className="dshP7CompanySettingsDefinitionGrid">
        <div><dt>{t('originValue')}</dt><dd>{status?.origin ?? '—'}</dd></div>
        <div><dt>{t('revision')}</dt><dd>{status?.revision ?? '—'}</dd></div>
        <div><dt>{t('lastSuccess')}</dt><dd>{dateValue(status?.lastSyncedAt ?? null, t)}</dd></div>
        <div><dt>{t('defaultModel')}</dt><dd>{status?.defaultModel ?? '—'}</dd></div>
      </dl>
      {connected && <div className="dshP7CompanySettingsActions"><button className="dshP7CompanySettingsButton" type="button" disabled={busy} onClick={() => { void run('sync') }}>{t(pending === 'sync' ? 'syncing' : 'sync')}</button><button className="dshP7CompanySettingsButton dshP7CompanySettingsButtonSecondary" type="button" disabled={busy} onClick={beginReconnect}>{t('reconnect')}</button><button className="dshP7CompanySettingsButton dshP7CompanySettingsButtonSecondary" type="button" disabled={busy} onClick={() => { void run('disconnect') }}>{t(pending === 'disconnect' ? 'disconnecting' : 'disconnect')}</button></div>}
    </section>
    <section className="dshP7CompanySettingsCatalog" aria-labelledby="p7-company-models-catalog-title">
      <h3 id="p7-company-models-catalog-title">{t('models')}</h3>
      {status?.models.length ? <ul className="dshP7CompanySettingsModelList">{status.models.map(model => <li className="dshP7CompanySettingsModel" key={model.id}>
        <div className="dshP7CompanySettingsModelHeader"><span className="dshP7CompanySettingsModelName">{model.displayName}</span><code>{model.id}</code></div>
        {(model.api || model.contextWindow !== undefined || model.maxOutputTokens !== undefined || model.inputModalities?.length) && <div className="dshP7CompanySettingsModelMeta">
          {model.api && <span className="dshP7CompanySettingsBadge">{model.api}</span>}
          {model.contextWindow !== undefined && <span className="dshP7CompanySettingsBadge">{t('contextWindow')}: {model.contextWindow.toLocaleString()}</span>}
          {model.maxOutputTokens !== undefined && <span className="dshP7CompanySettingsBadge">{t('maxOutputTokens')}: {model.maxOutputTokens.toLocaleString()}</span>}
          {model.inputModalities?.map(modality => <span className="dshP7CompanySettingsBadge" key={modality}>{modality}</span>)}
        </div>}
      </li>)}</ul> : <p className="dshP7CompanySettingsEmpty">{t('noModels')}</p>}
    </section>
    <section className="dshP7CompanySettingsCatalog" aria-labelledby="p7-company-models-tools-title">
      <div className="dshP7CompanySettingsStatusHeader"><h3 id="p7-company-models-tools-title">{t('tools')}</h3><span className="dshP7CompanySettingsBadge" data-phase={status?.tools.phase ?? 'syncing'}>{t(toolStatusKey(status?.tools.phase ?? 'syncing'))}</span></div>
      <p className="dshP7CompanySettingsIntro">{t('toolsIntro')}</p>
      {status?.tools.tools.length ? <ul className="dshP7CompanySettingsToolList">{status.tools.tools.map(tool => <li className="dshP7CompanySettingsTool" key={tool.name}>{toolLabel(tool.name, t) && <span>{toolLabel(tool.name, t)}</span>}<code>{tool.name}</code></li>)}</ul> : <p className="dshP7CompanySettingsEmpty">{t('noTools')}</p>}
      <p className="dshP7CompanySettingsNotice">{t('toolUsageNotice')}</p>
    </section>
  </section>
}
