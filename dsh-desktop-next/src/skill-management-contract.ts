/** Public metadata contract for Desktop-managed extra skill directories. */
export const DESKTOP_SKILL_CREATOR_NAME = 'create-personal-skill'

export interface DesktopSkillSource {
  readonly path: string
  readonly enabled: boolean
}

/** A catalog entry only. Skill bodies are never returned by the management API. */
export interface DesktopSkillMetadata {
  readonly name: string
  readonly description: string
  readonly path?: string
  readonly source: string
  readonly provider: string
  readonly invocation: {
    readonly modelInvocable: boolean
    readonly userInvocable: boolean
  }
}

export interface DesktopSkillManagementResponse {
  readonly revision: string
  readonly sources: DesktopSkillSource[]
  readonly userSkillDirectory: string
  /** `session` is reserved for a future official preset-scoped catalog lookup. */
  readonly scope: 'global' | 'session'
  readonly skills: DesktopSkillMetadata[]
}

export interface DesktopSkillManagementSaveRequest {
  readonly sources: DesktopSkillSource[]
  readonly expectedRevision: string
  readonly sessionId?: string
}
