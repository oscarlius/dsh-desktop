import { isAbsolute, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as filesystemSkills from '@deepseek-ai/dsh-skill-filesystem'
import { DESKTOP_SKILL_CREATOR_NAME } from '../skill-management-contract.ts'
import { atomicJson, readPrivateFile } from '../private-files.ts'
import type {
  DesktopSkillManagementResponse,
  DesktopSkillManagementSaveRequest,
  DesktopSkillMetadata,
  DesktopSkillSource,
} from '../skill-management-contract.ts'

export const DESKTOP_SKILLS_ROUTE = '/api/desktop-skills'
const SOURCES_FILE = 'desktop-skill-sources.json'
const MAX_REQUEST_BYTES = 64 * 1024

interface PersistedSources {
  readonly version: 1
  readonly revision: number
  readonly sources: readonly DesktopSkillSource[]
}

/** Owns only the Desktop's isolated filesystem provider, never official providers or skill files. */
export class DesktopSkillManager {
  private readonly file: string
  private revision = 0
  private sources: readonly DesktopSkillSource[] = []
  private provider: Fiber | undefined
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly ctx: Context, home: string, projectDir: string) {
    this.file = join(projectDir, SOURCES_FILE)
    this.home = home
  }

  private readonly home: string

  async start(): Promise<void> {
    const stored = readStoredSources(this.file)
    this.revision = stored.revision
    this.sources = stored.sources
    await this.replaceProvider(this.sources)
  }

  async dispose(): Promise<void> {
    const provider = this.provider
    this.provider = undefined
    await provider?.dispose()
  }

  async snapshot(): Promise<DesktopSkillManagementResponse> {
    const skills = await this.ctx.skills.list()
    return {
      revision: String(this.revision),
      sources: [...this.sources],
      userSkillDirectory: join(this.home, 'skills'),
      scope: 'global',
      skills: skills.map(toMetadata),
    }
  }

  save(request: DesktopSkillManagementSaveRequest): Promise<DesktopSkillManagementResponse> {
    const work = this.writes.then(() => this.saveCurrent(request))
    this.writes = work.catch(() => {})
    return work
  }

  private async saveCurrent(request: DesktopSkillManagementSaveRequest): Promise<DesktopSkillManagementResponse> {
    if (request.sessionId !== undefined) throw new UnsupportedSessionCatalogError()
    if (request.expectedRevision !== String(this.revision)) throw new RevisionConflictError()
    const next = normalizeSources(request.sources)
    const oldSources = this.sources
    try {
      await this.replaceProvider(next)
    } catch (error) {
      await this.restore(oldSources, error)
      throw error
    }
    try {
      atomicJson(this.file, { version: 1, revision: this.revision + 1, sources: next } satisfies PersistedSources)
    } catch (error) {
      await this.restore(oldSources, error)
      throw error
    }
    this.sources = next
    this.revision += 1
    return this.snapshot()
  }

  private async restore(sources: readonly DesktopSkillSource[], original: unknown): Promise<void> {
    try { await this.replaceProvider(sources) }
    catch (restoreError) {
      throw new Error('Could not restore the previous Desktop skill provider', { cause: new AggregateError([original, restoreError]) })
    }
  }

  private async replaceProvider(sources: readonly DesktopSkillSource[]): Promise<void> {
    await this.dispose()
    const customSkillDirs = sources.filter(source => source.enabled).map(source => source.path)
    if (customSkillDirs.length === 0) return
    this.provider = await this.ctx.plugin(filesystemSkills, {
      providerName: 'desktop-managed',
      includeDefaultRoots: false,
      customSkillDirs,
      watch: true,
    })
  }
}

/** Mount the authenticated Desktop skill-management API after the profile is ready. */
export async function installDesktopSkillManagement(ctx: Context, options: { home: string; projectDir: string }): Promise<DesktopSkillManager> {
  const manager = new DesktopSkillManager(ctx, options.home, options.projectDir)
  await manager.start()
  const unregisterCreator = registerPersonalSkillCreator(ctx, options.home)
  const unregister = ctx.webServer.register({ kind: 'exact', path: DESKTOP_SKILLS_ROUTE, handler: (request, response) => handleRequest(manager, request, response) })
  ctx.effect(() => async () => { unregister(); unregisterCreator(); await manager.dispose() }, 'desktop skill management')
  return manager
}

/** Teach the existing Agent how to author personal skills through its normal file tools. */
export function registerPersonalSkillCreator(ctx: Context, home: string): () => void {
  const root = join(home, 'skills')
  return ctx.skills.register({
    name: DESKTOP_SKILL_CREATOR_NAME,
    description: '帮助用户创建或完善自己的可复用 Skill：整理用途、输入输出与步骤，生成个人 SKILL.md。Create reusable personal skills from the user’s workflow.',
    source: 'runtime', provider: 'desktop-skill-management',
    invocation: { modelInvocable: true, userInvocable: true },
    content: `# Create a personal skill\n\nUse the user's language. The personal skill root for this installation is ${JSON.stringify(root)}.\n\n1. Understand the user's intended workflow, when to use it, inputs and expected outputs. Ask only for information needed to write useful instructions.\n2. Pick a short kebab-case name. Check for an existing skill of that name before creating or updating it.\n3. Use the normal file tools to write <root>/<name>/SKILL.md. Start with YAML frontmatter containing name and a concise description of when to use the skill. Put reusable instructions after the frontmatter. Keep examples and any necessary scripts, references or assets inside that skill folder.\n4. Read the saved file back and check the frontmatter and paths. Keep it separate from bundled/company skills, and follow the existing file-tool permissions.\n5. Report the actual saved path and show /<name> with one example invocation. The filesystem provider discovers saved personal skills; the user can refresh Skill management to see the new entry. Do not claim the workflow was executed unless it was actually run.\n`,
  })
}

async function handleRequest(manager: DesktopSkillManager, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'GET') {
    if (new URL(request.url ?? '/', 'http://dsh.invalid').searchParams.has('sessionId')) return sendError(response, 400, 'Session-scoped skill catalogs are not available')
    return sendJson(response, 200, await manager.snapshot())
  }
  if (request.method !== 'POST') return sendError(response, 405, 'Method not allowed')
  try {
    const saved = await manager.save(parseSaveRequest(await readJson(request)))
    sendJson(response, 200, saved)
  } catch (error) {
    if (error instanceof RevisionConflictError) return sendError(response, 409, error.message)
    if (error instanceof UnsupportedSessionCatalogError || error instanceof TypeError || error instanceof SyntaxError) return sendError(response, 400, error.message)
    throw error
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new TypeError('Desktop skill request body is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function parseSaveRequest(value: unknown): DesktopSkillManagementSaveRequest {
  if (!isRecord(value) || !Array.isArray(value.sources) || typeof value.expectedRevision !== 'string') throw new TypeError('Expected sources and expectedRevision')
  if (value.sessionId !== undefined && typeof value.sessionId !== 'string') throw new TypeError('sessionId must be a string')
  return { sources: value.sources.map(parseSource), expectedRevision: value.expectedRevision, ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }) }
}

function readStoredSources(file: string): PersistedSources {
  const raw = readPrivateFile(file)
  if (raw === undefined) return { version: 1, revision: 0, sources: [] }
  try {
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || typeof value.revision !== 'number' || value.revision < 0 || !Array.isArray(value.sources)) throw new TypeError('Invalid Desktop skill source configuration')
    return { version: 1, revision: value.revision, sources: normalizeSources(value.sources) }
  } catch (error) {
    throw new Error(`Could not load Desktop skill source configuration: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

function normalizeSources(value: readonly unknown[]): readonly DesktopSkillSource[] {
  const seen = new Set<string>()
  return value.map(parseSource).map(source => {
    if (!isAbsolute(source.path)) throw new TypeError(`Skill directory must be an absolute path: ${source.path}`)
    const path = resolve(source.path)
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) throw new TypeError(`Duplicate skill directory: ${source.path}`)
    seen.add(key)
    return { path, enabled: source.enabled }
  })
}

function parseSource(value: unknown): DesktopSkillSource {
  if (!isRecord(value) || typeof value.path !== 'string' || value.path.trim() === '' || typeof value.enabled !== 'boolean') throw new TypeError('Each skill source needs a non-empty path and enabled boolean')
  return { path: value.path, enabled: value.enabled }
}

function toMetadata(skill: { name: string; description: string; path?: string; source: string; provider: string; invocation: { modelInvocable: boolean; userInvocable: boolean } }): DesktopSkillMetadata {
  return { name: skill.name, description: skill.description, ...(skill.path === undefined ? {} : { path: skill.path }), source: skill.source, provider: skill.provider, invocation: skill.invocation }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function sendJson(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
function sendError(response: ServerResponse, status: number, message: string): void { sendJson(response, status, { error: message }) }

class RevisionConflictError extends Error { constructor() { super('Desktop skill sources were changed by another request') } }
class UnsupportedSessionCatalogError extends Error { constructor() { super('Session-scoped skill catalogs are not available') } }
