import { describe, expect, it } from 'vitest'
import { toolDisplayName, toolServerGroups } from '../src/client/tool-capabilities.js'
import { zh, type CompanySettingsLocaleKey } from '../src/client/locales.js'

const t = (key: CompanySettingsLocaleKey) => zh[key]

describe('company MCP service display', () => {
  it('groups several tools under one service and keeps services with the same display name separate', () => {
    const tools = [
      { name: 'mcp__p7__weknora__ask' },
      { name: 'mcp__p7__weknora__list_documents' },
      { name: 'mcp__p7__gildata__FinQuery' },
      { name: 'mcp__p7__legal_archive__lookup', title: '法务归档检索', server: { name: '公司知识库', namespace: 'legal_archive' } },
    ]
    const groups = toolServerGroups(tools, t)
    expect(groups.map(group => [group.id, group.name, group.tools.length])).toEqual([
      ['weknora', '公司知识库', 2], ['gildata', '聚源数据', 1], ['legal_archive', '公司知识库', 1],
    ])
    expect(groups[0]!.tools[0]).toBe(tools[0])
    expect(tools[0]!.name).toBe('mcp__p7__weknora__ask')
    expect(toolDisplayName(tools[3]!.name, t, tools[3]!.title)).toBe('法务归档检索')
  })
})
