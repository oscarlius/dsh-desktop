import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CompanyStatus } from '../public-status.js'
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
  const [origin, setOrigin] = useState('')
  const [apiKey, setApiKey] = useState('')
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
            originRef.current = ''
            setOrigin('')
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
    const currentOrigin = status?.origin ?? ''
    setOrigin(currentOrigin)
    originRef.current = currentOrigin
    setApiKey('')
    apiKeyRef.current = ''
    setReconnecting(true)
    setPending(undefined)
    setError(undefined)
  }

  return <section aria-labelledby="p7-company-models-title">
    <h2 id="p7-company-models-title">{t('title')}</h2>
    <p>{t('intro')}</p>
    {error !== undefined && <p role="alert">{error}</p>}
    {status?.message && <p role="status">{status.message}</p>}
    {!connected ? <form onSubmit={event => { event.preventDefault(); void run('connect') }}>
      <label>{t('origin')}<input aria-label={t('origin')} value={origin} placeholder={t('originPlaceholder')} disabled={busy} onChange={event => { const value = event.currentTarget.value; originRef.current = value; setOrigin(value) }} /></label>
      <label>{t('apiKey')}<input aria-label={t('apiKey')} type="password" value={apiKey} placeholder={t('apiKeyPlaceholder')} disabled={busy} onChange={event => { const value = event.currentTarget.value; apiKeyRef.current = value; setApiKey(value) }} /></label>
      <button type="submit" disabled={busy || !origin.trim() || !apiKey}>{t(pending === 'connect' ? 'connecting' : connected ? 'reconnect' : 'connect')}</button>
      <button type="button" disabled={busy || !apiKey} onClick={() => { apiKeyRef.current = ''; setApiKey('') }}>{t('cancel')}</button>
    </form> : <div>
      <button type="button" disabled={busy} onClick={() => { void run('sync') }}>{t(pending === 'sync' ? 'syncing' : 'sync')}</button>
      <button type="button" disabled={busy} onClick={() => { void run('disconnect') }}>{t(pending === 'disconnect' ? 'disconnecting' : 'disconnect')}</button>
      <button type="button" disabled={busy} onClick={beginReconnect}>{t('reconnect')}</button>
    </div>}
    <dl>
      <dt>{t('status')}</dt><dd>{status === undefined ? t('syncing') : t(statusKey(status.phase))}</dd>
      <dt>{t('originValue')}</dt><dd>{status?.origin ?? '—'}</dd>
      <dt>{t('revision')}</dt><dd>{status?.revision ?? '—'}</dd>
      <dt>{t('lastSuccess')}</dt><dd>{dateValue(status?.lastSyncedAt ?? null, t)}</dd>
      <dt>{t('defaultModel')}</dt><dd>{status?.defaultModel ?? '—'}</dd>
    </dl>
    <h3>{t('models')}</h3>
    {status?.models.length ? <ul>{status.models.map(model => <li key={model.id}>
      {model.displayName} <code>{model.id}</code>
      {model.api && <span> · {model.api}</span>}
      {model.contextWindow !== undefined && <span> · {t('contextWindow')}: {model.contextWindow.toLocaleString()}</span>}
      {model.maxOutputTokens !== undefined && <span> · {t('maxOutputTokens')}: {model.maxOutputTokens.toLocaleString()}</span>}
      {model.inputModalities && <span> · {model.inputModalities.join(', ')}</span>}
    </li>)}</ul> : <p>{t('noModels')}</p>}
  </section>
}
