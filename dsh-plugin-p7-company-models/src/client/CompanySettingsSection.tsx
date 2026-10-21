import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CompanyStatus } from '../public-status.js'
import { DEFAULT_P7_PUBLIC_ORIGIN } from '../defaults.js'
import { createCompanyModelsApi, type CompanyModelsApi } from './api.js'
import type { CompanySettingsLocaleKey } from './locales.js'

const POLL_MS = 5_000

export type CompanySettingsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'p7-company-models'> & {
  api?: CompanyModelsApi
}

function statusKey(phase: CompanyStatus['phase']): CompanySettingsLocaleKey {
  return phase === 'syncing' ? 'syncing' : phase
}

function dateValue(value: number | null, t: CompanySettingsSectionProps['t']): string {
  return value === null ? t('never') : new Date(value).toLocaleString()
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
  const request = useRef<AbortController>()
  const sequence = useRef(0)
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
  return <section className="dshP7CompanySettings" aria-labelledby="p7-company-models-title">
    <header className="dshP7CompanySettingsHeader">
      <h2 id="p7-company-models-title">{t('title')}</h2>
      <p className="dshP7CompanySettingsIntro">{t('intro')}</p>
    </header>
    {error !== undefined && <p className="dshP7CompanySettingsAlert" role="alert">{error}</p>}
    {status?.message && <p className="dshP7CompanySettingsNotice" role="status">{status.message}</p>}
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
  </section>
}
