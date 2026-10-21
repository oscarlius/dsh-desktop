import { createHash } from 'node:crypto'
import type { ModelConfigV1, P7Snapshot } from './contracts.js'
import { createP7Client, validateP7Origin, type P7Fetch } from './p7-client.js'
import { mapConfigToProviders } from './map-providers.js'
import { createSyncController, type ManagedConnection, type RecoveryFailureContext, type SyncController } from './sync-controller.js'
import { ManagedProviderStore, type SettingsPort } from './managed-provider-store.js'
import { CompanyPersistence } from './persistence.js'
import type { CompanyStatus } from './public-status.js'
import type { CompanyBootstrap } from './bootstrap.js'

export interface CompanyHostOptions {
  profileId: string
  persistence: Pick<CompanyPersistence, 'load' | 'save'>
  settings: SettingsPort
  modelNamespace(): string
  credentials: { read(ref: string): Promise<string | undefined>; set(ref: string, key: string): Promise<void>; unset(ref: string): Promise<void> }
  readDefault(): { provider: string; model: string; reasoningEffort?: string }
  saveDefault(provider: string, model: string, reasoningEffort?: string): Promise<void>
  fetch?: P7Fetch
  bootstrap?(): Promise<CompanyBootstrap | undefined>
}
export class CompanyHost {
  private origin: string | null = null
  private snapshot: P7Snapshot | undefined
  private owned: ManagedProviderStore | undefined
  private controller: SyncController | undefined
  private message: string | null = null
  private authorizationFailed = false
  private closed = false
  private defaultAlias: string | null = null
  private bootstrapDisabled = false
  private command: Promise<void> = Promise.resolve()
  private application: Promise<void> = Promise.resolve()
  private connectionIntent = 0
  readonly credentialRef: string
  constructor(private readonly options: CompanyHostOptions) {
    this.credentialRef = 'P7_DSH_' + createHash('sha256').update(options.profileId).digest('hex').slice(0, 24).toUpperCase() + '_API_KEY'
  }
  private async persist(): Promise<void> {
    await this.options.persistence.save({ version: 1, origin: this.origin, ownedIds: this.owned?.ownedIds() ?? [], ...(this.snapshot ? { snapshot: this.snapshot } : {}), ...(this.bootstrapDisabled ? { bootstrapDisabled: true } : {}) })
  }
  async initialize(): Promise<void> {
    let ownedIds: string[] = []
    let corruptPersistence = false
    try {
      const saved = await this.options.persistence.load()
      this.origin = saved.origin
      this.snapshot = saved.snapshot
      ownedIds = saved.ownedIds
      this.bootstrapDisabled = saved.bootstrapDisabled === true
    } catch {
      corruptPersistence = true
      this.origin = null
      this.snapshot = undefined
    }
    this.owned = new ManagedProviderStore(this.options.settings, this.options.modelNamespace, ownedIds)
    this.controller = createSyncController({
      client: createP7Client({ fetch: this.options.fetch ?? globalThis.fetch }),
      onAuthorizationFailure: async () => {
        this.authorizationFailed = true
        await this.options.credentials.unset(this.credentialRef)
        this.snapshot = undefined
        await this.persist()
      },
      onRecoveryFailure: context => this.handleRecoveryFailure(context),
      store: {
        load: () => this.snapshot,
        save: async snapshot => {
          const previous = this.snapshot
          this.snapshot = snapshot
          try { await this.persist() } catch (error) { this.snapshot = previous; throw error }
        },
        clear: async () => { this.snapshot = undefined; await this.persist() },
      },
      apply: (config, connection, isCurrent) => this.apply(config, connection, isCurrent),
    })
    if (corruptPersistence) {
      await this.recoverCorruptPersistence()
      return
    }
    if (!this.origin && ownedIds.length === 0) await this.recoverOrphanedPersistence()
    if (!this.origin && !this.bootstrapDisabled && !this.message) {
      try {
        const bootstrap = await this.options.bootstrap?.()
        if (bootstrap) { await this.connect(bootstrap.origin, bootstrap.key); return }
      } catch {
        this.message = 'The packaged P7 connection is unavailable. Connect manually or reinstall the company client.'
      }
    }
    if (this.origin) {
      const key = await this.options.credentials.read(this.credentialRef)
      if (key) {
        this.controller.start()
        await this.controller.restore({ origin: this.origin, key, credentialRef: this.credentialRef })
      } else {
        this.authorizationFailed = true
        await this.owned.apply([])
        this.snapshot = undefined
        await this.persist()
      }
    }
  }
  private apply(config: ModelConfigV1 | undefined, connection: ManagedConnection, isCurrent: () => boolean): Promise<void> {
    // Background polls also mutate defaults; connection commands must wait for
    // their stale-write compensation before applying the next connection.
    const next = this.application.then(() => this.applyNow(config, connection, isCurrent))
    this.application = next.catch(() => {})
    return next
  }
  private async applyNow(config: ModelConfigV1 | undefined, connection: ManagedConnection, isCurrent: () => boolean): Promise<void> {
    const providers = config ? mapConfigToProviders(config, connection) : []
    const previous = this.snapshot?.config
    if (!isCurrent() || this.closed) return
    await this.owned!.apply(providers, isCurrent)
    if (!isCurrent() || this.closed) return
    if (config?.enabled && config.defaultModel !== null) {
      const selected = providers.find(provider => provider.models.some(model => model.id === config.defaultModel))
      const identity = selected ? selected.id + ':' + config.defaultModel : null
      if (selected && identity !== this.defaultAlias) {
        const previousDefault = this.options.readDefault()
        try { await this.options.saveDefault(selected.id, config.defaultModel) }
        catch {
          await this.owned!.apply(previous ? mapConfigToProviders(previous, connection) : [], isCurrent)
          throw new Error('The company default model could not be applied. Check profile configuration overrides.')
        }
        if (!isCurrent() || this.closed) {
          await this.options.saveDefault(previousDefault.provider, previousDefault.model, previousDefault.reasoningEffort)
          return
        }
        this.defaultAlias = identity
      }
    }
  }
  private serialize(action: () => Promise<void>): Promise<void> {
    const next = this.command.then(async () => { if (!this.closed) await action() })
    this.command = next.catch(() => {})
    return next
  }
  connect(origin: string, apiKey: string): Promise<void> {
    const normalized = validateP7Origin(origin)
    const key = apiKey.trim()
    if (!/^p7k_[\x21-\x7e]+$/.test(key) || key.length > 4096) throw new Error('Enter a valid dedicated P7 access key.')
    const intent = ++this.connectionIntent
    this.controller?.stop()
    return this.serialize(async () => {
      if (intent !== this.connectionIntent) return
      this.controller!.stop()
      await this.controller!.disconnect()
      this.origin = normalized
      this.message = null
      this.bootstrapDisabled = false
      this.authorizationFailed = false
      this.defaultAlias = null
      await this.options.credentials.set(this.credentialRef, key)
      await this.persist()
      this.controller!.start()
      await this.controller!.connect({ origin: normalized, key, credentialRef: this.credentialRef })
      if (intent !== this.connectionIntent) return
      await this.handleAuthorizationFailure()
    })
  }
  sync(): Promise<void> {
    return this.serialize(async () => { await this.controller!.sync(); await this.handleAuthorizationFailure() })
  }
  private async handleAuthorizationFailure(): Promise<void> {
    if (this.controller!.getState().status !== 'reauth-required') return
    this.authorizationFailed = true
    this.controller!.stop()
    await this.options.credentials.unset(this.credentialRef)
    this.snapshot = undefined
    await this.persist()
  }
  private async recoverCorruptPersistence(): Promise<void> {
    const failures: unknown[] = []
    try { await this.options.credentials.unset(this.credentialRef) } catch (error) { failures.push(error) }
    try { await this.owned!.recover(this.credentialRef) } catch (error) { failures.push(error) }
    try { await this.persist() } catch (error) { failures.push(error) }
    this.message = failures.length
      ? 'P7 recovery could not complete. P7 remains disabled; reconnect P7 after repairing the profile settings.'
      : 'Saved P7 settings were invalid. The P7 key and matching managed providers were removed; reconnect P7 to continue.'
  }
  private async recoverOrphanedPersistence(): Promise<void> {
    let key: string | undefined
    try { key = await this.options.credentials.read(this.credentialRef) }
    catch {
      this.message = 'P7 recovery could not inspect the saved key. P7 remains disabled; reconnect P7 after repairing the profile settings.'
      return
    }
    try {
      if (key) await this.options.credentials.unset(this.credentialRef)
      const removed = await this.owned!.recover(this.credentialRef)
      if (!key && removed.length === 0) return
      await this.persist()
      this.message = 'Orphaned P7 settings were removed. Reconnect P7 to continue.'
    } catch {
      this.message = 'P7 recovery could not complete. P7 remains disabled; reconnect P7 after repairing the profile settings.'
    }
  }
  private async handleRecoveryFailure(_context: RecoveryFailureContext): Promise<void> {
    this.authorizationFailed = true
    this.origin = null
    this.snapshot = undefined
    this.defaultAlias = null
    const failures: unknown[] = []
    try { await this.options.credentials.unset(this.credentialRef) } catch (error) { failures.push(error) }
    try { await this.owned!.recover(this.credentialRef) } catch (error) { failures.push(error) }
    try { await this.persist() } catch (error) { failures.push(error) }
    this.message = failures.length
      ? 'P7 recovery could not complete. P7 access remains disabled; reconnect P7 after repairing the profile settings.'
      : 'P7 synchronization could not recover safely. P7 access was revoked; reconnect P7 to continue.'
  }
  disconnect(): Promise<void> {
    const intent = ++this.connectionIntent
    this.controller?.stop()
    return this.serialize(async () => {
      if (intent !== this.connectionIntent) return
      this.controller!.stop()
      await this.controller!.disconnect()
      await this.options.credentials.unset(this.credentialRef)
      this.origin = null
      this.bootstrapDisabled = true
      this.snapshot = undefined
      this.authorizationFailed = false
      this.defaultAlias = null
      this.message = null
      await this.persist()
    })
  }
  status(): CompanyStatus {
    const state = this.controller?.getState()
    const phase = !this.controller ? 'syncing' : this.authorizationFailed || state?.status === 'reauth-required' ? 'unauthorized'
      : this.message ? 'error' : state?.status === 'syncing' ? 'syncing'
        : state?.status === 'ready' ? 'ready' : state?.status === 'stale' ? 'stale'
          : state?.error ? 'error' : 'disconnected'
    return {
      phase, origin: this.origin, revision: this.snapshot?.config.revision ?? null,
      lastSyncedAt: state?.lastSuccessAt ?? this.snapshot?.appliedAt ?? null,
      defaultModel: this.snapshot?.config.defaultModel ?? null,
      models: this.snapshot?.config.models.map(({ id, displayName, api, contextWindow, maxOutputTokens, inputModalities }) => ({ id, displayName, api, contextWindow, maxOutputTokens, inputModalities: [...inputModalities] })) ?? [],
      message: this.message ?? (phase === 'unauthorized' ? 'P7 access is no longer authorized. Reconnect with a valid key.' : state?.error ? 'P7 synchronization failed. The previous valid catalog is retained when available.' : null),
    }
  }
  async dispose(): Promise<void> { this.closed = true; this.controller?.stop(); await this.command; await this.application }
}
