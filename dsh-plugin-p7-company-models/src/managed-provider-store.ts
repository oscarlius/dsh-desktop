import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { ManagedProvider } from './map-providers.js'
import { P7_PROVIDER_IDS } from './map-providers.js'

export interface SettingsPort {
  describe(): { ns: string; revision: number; value: unknown }[]
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}
const reserved = new Set(Object.values(P7_PROVIDER_IDS))
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Company model settings are unavailable.')
  return value as Record<string, unknown>
}
function belongsToCredential(value: unknown, credentialRef: string): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).apiKeyEnv === credentialRef
}
/** Serialize only the provider paths this plugin owns; never replace other providers. */
export class ManagedProviderStore {
  private tail: Promise<void> = Promise.resolve()
  private owned: Set<string>
  constructor(private readonly settings: SettingsPort, private readonly namespace: () => string, owned: readonly string[] = []) {
    if (owned.some(id => !reserved.has(id))) throw new Error('Invalid company model ownership record.')
    this.owned = new Set(owned)
  }
  ownedIds(): string[] { return [...this.owned] }
  /** Remove only reserved routes that demonstrably use this profile's credential. */
  recover(credentialRef: string): Promise<string[]> {
    const work = this.tail.then(async () => {
      const ns = this.namespace()
      const descriptor = this.settings.describe().find(item => item.ns === ns)
      if (!descriptor) throw new Error('Enable the standard model adapter before reconnecting P7.')
      const current = record(record(descriptor.value).providers ?? {})
      const ids = [...reserved].filter(id => Object.hasOwn(current, id) && belongsToCredential(current[id], credentialRef))
      if (ids.length) await this.settings.mutate(ns, ids.map(id => ({ op: 'unset' as const, path: ['providers', id] })), descriptor.revision)
      for (const id of ids) this.owned.delete(id)
      return ids
    })
    this.tail = work.then(() => {}, () => {})
    return work
  }
  apply(providers: readonly ManagedProvider[], isCurrent: () => boolean = () => true): Promise<void> {
    const work = this.tail.then(async () => {
      if (!isCurrent()) return
      const ns = this.namespace()
      const descriptor = this.settings.describe().find(item => item.ns === ns)
      if (!descriptor) throw new Error('Enable the standard model adapter before connecting P7.')
      const current = record(record(descriptor.value).providers ?? {})
      for (const id of reserved) {
        if (Object.hasOwn(current, id) && !this.owned.has(id)) throw new Error('A company provider name is already in use. Rename that local provider before connecting P7.')
      }
      const desired = new Map(providers.map(provider => [provider.id, provider]))
      const ops: SettingsPathOp[] = []
      for (const id of this.owned) if (Object.hasOwn(current, id) && !desired.has(id)) ops.push({ op: 'unset', path: ['providers', id] })
      for (const provider of providers) {
        const value = { displayName: 'P7 公司模型', api: provider.api, baseURL: provider.baseURL, apiKeyEnv: provider.credentialRef, rejectRedirects: provider.rejectRedirects, transport: provider.transport, models: provider.models }
        if (JSON.stringify(current[provider.id]) !== JSON.stringify(value)) ops.push({ op: 'set', path: ['providers', provider.id], value })
      }
      if (!isCurrent()) return
      if (ops.length) await this.settings.mutate(ns, ops, descriptor.revision)
      this.owned = new Set(desired.keys())
    })
    this.tail = work.catch(() => {})
    return work
  }
}
