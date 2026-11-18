import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { registerDesktopSkillSettings, requestDesktopSkills } from '../src/client/skills.tsx'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: ({ children, ...props }: Record<string, unknown>) => createElement('button', props, children as never) }))
afterEach(() => vi.unstubAllGlobals())

it('uses the shared authenticated Host route for inventory and revisioned directory saves', async () => {
  const state = { revision: '2', sources: [], userSkillDirectory: '/home/skills', scope: 'global', skills: [] }
  const fetcher = vi.fn(async () => Response.json(state)); vi.stubGlobal('fetch', fetcher)
  expect(await requestDesktopSkills()).toEqual(state)
  expect(fetcher.mock.calls[0]).toMatchObject(['/api/desktop-skills', { method: 'GET', credentials: 'same-origin' }])
  const input = { expectedRevision: '2', sources: [{ path: '/custom/skills', enabled: true }] }
  await requestDesktopSkills(input)
  expect(JSON.parse((fetcher.mock.calls as unknown as [string, RequestInit][])[1]![1].body as string)).toEqual(input)
  fetcher.mockImplementationOnce(async () => Response.json({ error: 'Directory configuration changed' }, { status: 409 }))
  await expect(requestDesktopSkills(input)).rejects.toThrow('Directory configuration changed')
})

it('registers a separate Skill management settings page through the existing client services', () => {
  const register = vi.fn(); const inject = vi.fn((_services, mount) => mount(scope))
  const scope = { locale: { bind: () => (key: string) => key === 'title' ? 'Skill 管理' : 'zh' }, slots: { inject: (_name: string, mount: () => unknown) => mount(), register } }
  const ctx = { effect: vi.fn(), inject }
  registerDesktopSkillSettings(ctx as never)
  expect(inject.mock.calls[0]?.[0]).toEqual(['sidebarRight', 'sessions', 'conversation'])
  const registration = register.mock.calls[0]?.[0]
  expect(registration).toMatchObject({ name: 'settings.section', id: 'desktop-skills' })
  expect(registration.label()).toBe('Skill 管理')
})
