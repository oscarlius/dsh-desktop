import type { CredentialProvider, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { AccountBroker } from './account-broker.js'

/**
 * Overlay one credential reference without persisting or exposing personal
 * tokens. It composes with wrappers installed before or after it: disposal
 * either restores our exact replacement or turns it into a transparent
 * delegate when a later wrapper still points at it.
 */
export function installPersonalCredentialOverlay(credentials: CredentialProvider, ref: CredentialRef, account: AccountBroker): () => void {
  const previous = credentials.resolve.bind(credentials)
  const previousDescribe = credentials.describe.bind(credentials)
  let active = true
  const resolve = async (candidate: CredentialRef): Promise<ResolvedCredential | undefined> => {
    if (active && candidate === ref && account.usesPersonalToken()) {
      try { const value = await account.getValidAccessToken(); return { value, source: 'p7-session' } } catch { return undefined }
    }
    return await previous(candidate)
  }
  const describe = async (candidate: CredentialRef): Promise<CredentialInfo> => {
    if (active && candidate === ref && account.usesPersonalToken()) {
      try {
        await account.getValidAccessToken()
        return { configured: true, source: 'p7-session', writable: false }
      } catch { return { configured: false, writable: false } }
    }
    return await previousDescribe(candidate)
  }
  Object.defineProperty(credentials, 'resolve', { configurable: true, writable: true, value: resolve })
  Object.defineProperty(credentials, 'describe', { configurable: true, writable: true, value: describe })
  return () => {
    active = false
    if (credentials.resolve === resolve) Object.defineProperty(credentials, 'resolve', { configurable: true, writable: true, value: previous })
    if (credentials.describe === describe) Object.defineProperty(credentials, 'describe', { configurable: true, writable: true, value: previousDescribe })
  }
}
