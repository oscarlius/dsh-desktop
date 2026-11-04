import { createHash } from 'node:crypto'

/** The small, dependency-free subset of a P7 MCP catalog used for activation. */
export interface CatalogTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface CatalogEntry {
  /** Name sent to the MCP server. */
  wireName: string
  /** Name registered in the local ToolRuntime; this is also the load tool id. */
  publicName: string
  toolId: string
  namespace: string
  description: string
  inputSchema: Record<string, unknown>
  fingerprint: string
  schemaBytes: number
  /** New whenever this name is changed, removed, then reintroduced. */
  incarnation: number
}

export type PolicyVisibility = (tool: CatalogEntry) => boolean

export interface ActivationStoreOptions {
  /** Maps a server-provided wire name to the public ToolRuntime name. */
  nameMapper: (wireName: string) => string
  maxLoadedTools?: number
  maxSchemaBytes?: number
  searchLimit?: number
}

export type ActivationFailure = 'closed' | 'unavailable' | 'unknown' | 'forbidden' | 'tool-limit' | 'schema-limit'

export type LoadResult =
  | { ok: true; tools: readonly CatalogEntry[] }
  | { ok: false; reason: ActivationFailure }

export type SearchResult =
  | { ok: true; tools: readonly SearchCandidate[] }
  | { ok: false; reason: 'closed' | 'unavailable' }

export interface SearchCandidate {
  toolId: string
  publicName: string
  namespace: string
  description: string
}

interface AgentState {
  generation: number
  loaded: Map<string, LoadedTool>
}

interface LoadedTool { fingerprint: string; incarnation: number }

const DEFAULT_MAX_LOADED_TOOLS = 12
const DEFAULT_MAX_SCHEMA_BYTES = 32_768
const DEFAULT_SEARCH_LIMIT = 5

/**
 * Per-Agent, policy-aware activation state. It intentionally knows nothing
 * about Cordis, ToolRuntime, or network clients so callers can compose it at
 * their own lifecycle boundary.
 */
export class ActivationStore<Agent extends object = object> {
  private readonly maxLoadedTools: number
  private readonly maxSchemaBytes: number
  private readonly searchLimit: number
  private readonly states = new WeakMap<Agent, AgentState>()
  private readonly ownedNames = new Set<string>()
  private catalog: ReadonlyMap<string, CatalogEntry> | undefined
  private generation = 0
  private nextIncarnation = 0
  private closed = false

  constructor(private readonly options: ActivationStoreOptions) {
    if (typeof options.nameMapper !== 'function') throw new TypeError('nameMapper must be a function')
    this.maxLoadedTools = validPositiveInteger(options.maxLoadedTools, DEFAULT_MAX_LOADED_TOOLS, 'maxLoadedTools')
    this.maxSchemaBytes = validPositiveInteger(options.maxSchemaBytes, DEFAULT_MAX_SCHEMA_BYTES, 'maxSchemaBytes')
    this.searchLimit = validPositiveInteger(options.searchLimit, DEFAULT_SEARCH_LIMIT, 'searchLimit')
  }

  get available(): boolean { return !this.closed && this.catalog !== undefined }
  get catalogSize(): number { return this.catalog?.size ?? 0 }
  /** Changes whenever all Agent-local activation state becomes invalid. */
  get epoch(): number { return this.generation }

  publishCatalog(tools: readonly CatalogTool[]): readonly CatalogEntry[] {
    if (this.closed) return []
    const next = new Map<string, CatalogEntry>()
    for (const tool of tools) {
      const entry = this.makeEntry(tool)
      if (next.has(entry.publicName)) throw new TypeError(`duplicate public MCP tool name: ${entry.publicName}`)
      const previous = this.catalog?.get(entry.publicName)
      entry.incarnation = previous && previous.fingerprint === entry.fingerprint ? previous.incarnation : ++this.nextIncarnation
      next.set(entry.publicName, entry)
      this.ownedNames.add(entry.publicName)
    }
    this.catalog = next
    return [...next.values()]
  }

  /** Makes all existing per-Agent activation snapshots stale and unavailable. */
  invalidateCatalog(): void {
    this.generation += 1
    this.catalog = undefined
  }

  close(): void {
    this.closed = true
    this.invalidateCatalog()
  }

  forgetAgent(agent: Agent): void {
    this.states.delete(agent)
  }

  /** True also for names retired by a catalog transition, so guards fail closed. */
  owns(name: string): boolean {
    return this.ownedNames.has(name)
  }

  eligible(agent: Agent, isPolicyVisible: PolicyVisibility): readonly CatalogEntry[] {
    this.requireAgent(agent)
    const catalog = this.availableCatalog()
    if (!catalog) return []
    return [...catalog.values()].filter((tool) => isPolicyVisible(tool))
  }

  active(agent: Agent, isPolicyVisible: PolicyVisibility): readonly CatalogEntry[] {
    this.requireAgent(agent)
    const catalog = this.availableCatalog()
    if (!catalog) return []
    const state = this.currentState(agent)
    if (!state) return []
    const active: CatalogEntry[] = []
    for (const [toolId, loaded] of state.loaded) {
      const tool = catalog.get(toolId)
      if (tool && matchesLoaded(tool, loaded) && isPolicyVisible(tool)) active.push(tool)
    }
    return stableEntries(active)
  }

  load(agent: Agent, toolIds: readonly string[], isPolicyVisible: PolicyVisibility): LoadResult {
    this.requireAgent(agent)
    const catalog = this.availableCatalog()
    if (!catalog) return { ok: false, reason: this.closed ? 'closed' : 'unavailable' }
    const requested = uniqueToolIds(toolIds)
    const requestedTools: CatalogEntry[] = []
    for (const toolId of requested) {
      const tool = catalog.get(toolId)
      if (!tool) return { ok: false, reason: 'unknown' }
      if (!isPolicyVisible(tool)) return { ok: false, reason: 'forbidden' }
      requestedTools.push(tool)
    }

    const current = this.currentState(agent)?.loaded ?? new Map<string, LoadedTool>()
    const retained = new Map<string, LoadedTool>()
    for (const [toolId, loaded] of current) {
      const tool = catalog.get(toolId)
      if (tool && matchesLoaded(tool, loaded) && isPolicyVisible(tool)) retained.set(toolId, loaded)
    }
    for (const tool of requestedTools) retained.set(tool.publicName, { fingerprint: tool.fingerprint, incarnation: tool.incarnation })

    if (retained.size > this.maxLoadedTools) return { ok: false, reason: 'tool-limit' }
    let schemaBytes = 0
    for (const [toolId, loaded] of retained) {
      const tool = catalog.get(toolId)
      if (tool && matchesLoaded(tool, loaded)) schemaBytes += tool.schemaBytes
    }
    if (schemaBytes > this.maxSchemaBytes) return { ok: false, reason: 'schema-limit' }

    this.states.set(agent, { generation: this.generation, loaded: retained })
    return { ok: true, tools: this.active(agent, isPolicyVisible) }
  }

  search(agent: Agent, query: string, namespace: string | undefined, limit: number | undefined, isPolicyVisible: PolicyVisibility): SearchResult {
    this.requireAgent(agent)
    const catalog = this.availableCatalog()
    if (!catalog) return { ok: false, reason: this.closed ? 'closed' : 'unavailable' }
    if (typeof query !== 'string') throw new TypeError('query must be a string')
    if (namespace !== undefined && typeof namespace !== 'string') throw new TypeError('namespace must be a string')
    const requestedLimit = limit === undefined ? this.searchLimit : validPositiveInteger(limit, this.searchLimit, 'limit')
    const boundedLimit = Math.min(requestedLimit, this.searchLimit)
    const normalizedNamespace = normalize(namespace ?? '')
    const terms = expandTerms(normalize(query))
    if (terms.length === 0) return { ok: true, tools: [] }
    const tools = [...catalog.values()]
      .filter((tool) => !normalizedNamespace || normalize(tool.namespace) === normalizedNamespace)
      .filter(isPolicyVisible)
      .map((tool) => ({ tool, score: searchScore(tool, terms) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.tool.publicName.localeCompare(right.tool.publicName))
      .slice(0, boundedLimit)
      .map(({ tool }) => ({ toolId: tool.toolId, publicName: tool.publicName, namespace: tool.namespace, description: shortDescription(tool.description) }))
    return { ok: true, tools }
  }

  private makeEntry(tool: CatalogTool): CatalogEntry {
    if (!tool || typeof tool.name !== 'string' || typeof tool.description !== 'string' || !isRecord(tool.inputSchema)) {
      throw new TypeError('invalid MCP catalog tool')
    }
    const publicName = this.options.nameMapper(tool.name)
    if (typeof publicName !== 'string' || publicName.length === 0) throw new TypeError(`invalid public MCP tool name for ${tool.name}`)
    const description = tool.description
    const inputSchema = tool.inputSchema
    const definition = { name: publicName, description, parameters: inputSchema }
    const serialized = stableJson(definition)
    return {
      wireName: tool.name,
      publicName,
      toolId: publicName,
      namespace: namespaceOf(tool.name, publicName),
      description,
      inputSchema,
      fingerprint: createHash('sha256').update(serialized).digest('hex'),
      schemaBytes: Buffer.byteLength(serialized, 'utf8'),
      incarnation: 0,
    }
  }

  private availableCatalog(): ReadonlyMap<string, CatalogEntry> | undefined {
    return this.closed ? undefined : this.catalog
  }

  private currentState(agent: Agent): AgentState | undefined {
    const state = this.states.get(agent)
    return state?.generation === this.generation ? state : undefined
  }

  private requireAgent(agent: Agent): void {
    if (agent === null || typeof agent !== 'object') throw new TypeError('agent must be a non-null object')
  }
}

function validPositiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`)
  return value
}

function uniqueToolIds(toolIds: readonly string[]): string[] {
  if (!Array.isArray(toolIds)) throw new TypeError('toolIds must be an array')
  const unique = new Set<string>()
  for (const toolId of toolIds) {
    if (typeof toolId !== 'string' || toolId.length === 0) throw new TypeError('toolIds must contain non-empty strings')
    unique.add(toolId)
  }
  return [...unique]
}

function stableEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return entries.sort((left, right) => left.publicName.localeCompare(right.publicName))
}

function matchesLoaded(tool: CatalogEntry, loaded: LoadedTool): boolean {
  return tool.fingerprint === loaded.fingerprint && tool.incarnation === loaded.incarnation
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[_./:-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function namespaceOf(wireName: string, publicName: string): string {
  const separator = wireName.indexOf('__')
  if (separator > 0) return wireName.slice(0, separator)
  return publicName
}

const RELATED_TERMS: Record<string, readonly string[]> = {
  '安全': ['security', '安全', '风险', '风控'],
  '证券': ['security', 'stock', '证券', '股票', '代码'],
  '股票': ['security', 'stock', '证券', '股票'],
  quote: ['quote', 'quotation', '行情', '报价', '价格'],
  '行情': ['quote', 'quotation', '行情', '报价', '价格'],
  finance: ['finance', 'financial', '财务', '财经', '金融'],
  '财务': ['finance', 'financial', '财务', '财经', '金融'],
  '财报': ['income', 'balance', 'cashflow', 'financial', '财务', '财报', '利润表', '资产负债表', '现金流量表'],
  '估值': ['valuation', 'pe', 'pb', '市值', '估值'],
  macro: ['macro', 'macroeconomic', '宏观', '经济'],
  '宏观': ['macro', 'macroeconomic', '宏观', '经济'],
}

function expandTerms(query: string): string[] {
  const terms = new Set(query.split(' ').filter(Boolean))
  for (const match of query.matchAll(/[a-z0-9]+|[\u3400-\u9fff]+/gu)) terms.add(match[0])
  for (const [term, related] of Object.entries(RELATED_TERMS)) {
    if (terms.has(term) || (/[\u3400-\u9fff]/u.test(term) && query.includes(term))) for (const word of related) terms.add(word)
  }
  for (const match of query.matchAll(/[\u3400-\u9fff]+/gu)) {
    for (let index = 0; index < match[0].length - 1; index += 1) terms.add(match[0].slice(index, index + 2))
  }
  return [...terms]
}

function searchScore(tool: CatalogEntry, terms: readonly string[]): number {
  const name = normalize(`${tool.publicName} ${tool.wireName}`)
  const description = normalize(tool.description)
  let score = 0
  for (const term of terms) {
    if (name.includes(term)) score += 10
    if (description.includes(term)) score += 3
  }
  return score
}

function shortDescription(description: string): string {
  return [...description].slice(0, 160).join('')
}
