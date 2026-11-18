import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as filesystemSkills from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'
import { DesktopSkillManager, registerPersonalSkillCreator } from '../src/host/skill-management.ts'

function writeSkill(root: string, name: string): void {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\n---\n${name} body\n`)
}

it('persists normalized sources, hot-reloads only its provider, and preserves state on rejected saves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-skills-'))
  const home = join(root, 'home')
  const profile = join(root, 'profile')
  const first = join(root, 'first')
  const second = join(root, 'second')
  const defaults = join(root, 'defaults')
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const manager = new DesktopSkillManager(ctx, home, profile)
  try {
    writeSkill(first, 'first-skill')
    writeSkill(second, 'second-skill')
    writeSkill(defaults, 'default-skill')
    await ctx.plugin(filesystemSkills, { providerName: 'filesystem', includeDefaultRoots: false, customSkillDirs: [defaults], watch: false })
    await manager.start()
    expect((await manager.snapshot()).skills.map(skill => skill.name)).toEqual(['default-skill'])

    const firstSaved = await manager.save({ expectedRevision: '0', sources: [{ path: first, enabled: true }] })
    expect(firstSaved.revision).toBe('1')
    expect(firstSaved.scope).toBe('global')
    expect(firstSaved.userSkillDirectory).toBe(join(home, 'skills'))
    expect(firstSaved.skills.find(skill => skill.name === 'first-skill')).toMatchObject({ provider: 'desktop-managed', invocation: { modelInvocable: true, userInvocable: true } })
    expect(firstSaved.skills.map(skill => skill.name)).toContain('default-skill')

    const secondSaved = await manager.save({ expectedRevision: '1', sources: [{ path: first, enabled: false }, { path: second, enabled: true }] })
    expect(secondSaved.sources).toEqual([{ path: first, enabled: false }, { path: second, enabled: true }])
    expect(secondSaved.skills.map(skill => skill.name)).toEqual(['default-skill', 'second-skill'])
    expect(JSON.parse(readFileSync(join(profile, 'desktop-skill-sources.json'), 'utf8'))).toMatchObject({ revision: 2, sources: secondSaved.sources })

    await expect(manager.save({ expectedRevision: '1', sources: [] })).rejects.toThrow('changed by another request')
    await expect(manager.save({ expectedRevision: '2', sources: [{ path: second, enabled: true }, { path: second, enabled: false }] })).rejects.toThrow('Duplicate skill directory')
    expect((await manager.snapshot()).sources).toEqual(secondSaved.sources)
    expect((await manager.snapshot()).skills.map(skill => skill.name)).toEqual(['default-skill', 'second-skill'])
    const simultaneous = await Promise.allSettled([
      manager.save({ expectedRevision: '2', sources: [{ path: first, enabled: true }] }),
      manager.save({ expectedRevision: '2', sources: [{ path: second, enabled: true }] }),
    ])
    expect(simultaneous.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((await manager.snapshot()).skills.map(skill => skill.name)).toEqual(['default-skill', 'first-skill'])
    const removeCreator = registerPersonalSkillCreator(ctx, home)
    const creator = await ctx.skills.get('create-personal-skill')
    expect(creator?.content).toContain(JSON.stringify(join(home, 'skills')))
    expect(creator?.content).toContain('SKILL.md')
    expect(creator?.content).toContain('\n')
    expect(creator?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    removeCreator()
    writeSkill(join(home, 'skills'), 'my-personal-skill')
    const personalOnly = await manager.save({ expectedRevision: '3', sources: [] })
    expect(personalOnly.skills.map(skill => skill.name)).toEqual(['default-skill', 'my-personal-skill'])
  } finally {
    await manager.dispose()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
