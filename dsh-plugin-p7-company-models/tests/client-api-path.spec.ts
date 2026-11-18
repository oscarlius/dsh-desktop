// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { resolveClientApiPath } from '../src/client/api-path.js'

describe('resolveClientApiPath', () => {
  it('keeps Desktop requests at the root', () => {
    expect(resolveClientApiPath('/p7-company-models/status', 'app://dsh/')).toBe('/p7-company-models/status')
  })

  it('keeps company, model, and memory calls under a mounted workspace including a query base URI', () => {
    const base = 'https://p7.invalid/dsh/instances/aa5fed12-aa18-4d76-9acd-a6732d65b7c4/?view=settings'
    expect(resolveClientApiPath('/p7-company-models/status', base)).toBe('/dsh/instances/aa5fed12-aa18-4d76-9acd-a6732d65b7c4/p7-company-models/status')
    expect(resolveClientApiPath('/p7-company-models/account/usage?from=2026-01-01', base)).toBe('/dsh/instances/aa5fed12-aa18-4d76-9acd-a6732d65b7c4/p7-company-models/account/usage?from=2026-01-01')
    expect(resolveClientApiPath('/p7-company-models/memory/list?after=0', base)).toBe('/dsh/instances/aa5fed12-aa18-4d76-9acd-a6732d65b7c4/p7-company-models/memory/list?after=0')
  })

  it('never derives an external target from a base query', () => {
    const base = 'https://p7.invalid/dsh/instances/aa5fed12-aa18-4d76-9acd-a6732d65b7c4/?next=https://outside.invalid/steal'
    expect(resolveClientApiPath('/p7-company-models/status', base)).toBe('/dsh/instances/aa5fed12-aa18-4d76-9acd-a6732d65b7c4/p7-company-models/status')
  })
})
