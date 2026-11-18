import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { P7AccountStatus } from '../account-broker.js'
import { createCompanyModelsApi, type CompanyModelsApi } from './api.js'

const POLL_MS = 1_000
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

declare global {
  var __DSH_COMPANY_POLICY__: { requirePersonalLogin?: boolean } | undefined
}

export type CompanyLoginGateProps = PropsRuntime<'shell.overlay'> & PropsLocale<'p7-company-models'> & { api?: CompanyModelsApi }

function policyRequiresLogin(): boolean { return globalThis.__DSH_COMPANY_POLICY__?.requirePersonalLogin === true }
function focusableWithin(element: HTMLElement): HTMLElement[] { return [...element.querySelectorAll<HTMLElement>(FOCUSABLE)] }

/**
 * A root-level guard for the company-only client. The policy flag blocks the
 * shell before Host status arrives; the Host's secret-free status is then the
 * authoritative source for the rest of the renderer lifetime.
 */
export function CompanyLoginGate({ api: suppliedApi, t }: CompanyLoginGateProps) {
  const apiRef = useRef<CompanyModelsApi | undefined>(undefined)
  if (apiRef.current === undefined) apiRef.current = suppliedApi ?? createCompanyModelsApi()
  const api = apiRef.current
  const [required, setRequired] = useState(policyRequiresLogin)
  const [account, setAccount] = useState<P7AccountStatus>()
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const active = useRef(true)
  const gateRef = useRef<HTMLDivElement>(null)
  // Catalog polls and token renewal are background work, not new sign-ins.
  // Only the identity broker can require authentication; catalog failures
  // remain visible in company settings without covering the conversation.
  const signedIn = account?.phase === 'signed-in' || (account?.phase === 'error' && account.profile !== null)
  const blocking = required && !signedIn

  const refresh = useCallback(async () => {
    try {
      const [status, nextAccount] = await Promise.allSettled([api.status(), api.accountStatus()])
      if (!active.current) return
      if (status.status === 'fulfilled') {
        const statusRequired = (status.value as { loginRequired?: unknown }).loginRequired
        setRequired(previous => policyRequiresLogin() || statusRequired === true || (statusRequired === undefined ? previous : false))
      }
      if (nextAccount.status === 'fulfilled') setAccount(nextAccount.value)
      setError(status.status === 'rejected' || nextAccount.status === 'rejected')
    } catch {
      if (active.current) setError(true)
    }
  }, [api])

  useEffect(() => {
    active.current = true
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, POLL_MS)
    return () => { active.current = false; window.clearInterval(timer) }
  }, [refresh])

  useEffect(() => {
    if (!blocking) return
    const gate = gateRef.current
    if (gate === null) return
    const focusFirst = () => { focusableWithin(gate)[0]?.focus() }
    if (!gate.contains(document.activeElement)) focusFirst()
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Node ? event.target : null
      if (target === null || !gate.contains(target)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        focusFirst()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (event.key !== 'Tab') return
      const controls = focusableWithin(gate)
      if (controls.length === 0) return
      const current = document.activeElement as HTMLElement | null
      const index = current === null ? -1 : controls.indexOf(current)
      const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index === controls.length - 1 ? 0 : index + 1)
      event.preventDefault()
      controls[next]?.focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [blocking])

  const signIn = async () => {
    if (busy) return
    setBusy(true)
    try { const next = await api.accountLogin(); if (active.current) { setAccount(next); setError(false) } }
    catch { if (active.current) setError(true) }
    finally { if (active.current) setBusy(false) }
  }

  if (!blocking) return null
  const pending = account?.phase === 'pending'
  const checking = account === undefined || account.phase === 'error'
  return <div ref={gateRef} className="dshP7CompanyLoginOverlay" role="dialog" aria-modal="true" aria-labelledby="p7-company-overlay-login-title">
    <section className="dshP7CompanyLoginOverlayCard">
      <h2 id="p7-company-overlay-login-title">{t(checking ? 'loginRestoringTitle' : 'loginRequiredTitle')}</h2>
      <p>{t(checking ? 'loginRestoringIntro' : 'loginRequiredIntro')}</p>
      <p className="dshP7CompanyLoginOverlayStatus" role="status">{account?.message ?? (checking ? t('loginRestoringIntro') : pending ? t('accountPending') : t('loginRequiredStatus'))}</p>
      {error && <p className="dshP7CompanySettingsAlert" role="alert">{t('unavailable')}</p>}
      <div className="dshP7CompanySettingsActions">{!checking && <button className="dshP7CompanySettingsButton" type="button" disabled={busy || pending} onClick={() => { void signIn() }}>{t(pending ? 'accountPending' : 'signIn')}</button>}<button className="dshP7CompanySettingsButton dshP7CompanySettingsButtonSecondary" type="button" disabled={busy} onClick={() => { void refresh() }}>{t('refreshLoginStatus')}</button></div>
    </section>
  </div>
}
