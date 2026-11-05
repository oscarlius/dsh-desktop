import { describe, expect, it } from 'vitest'
import { ActivationStore, type CatalogTool } from '../src/activation-store.js'

const tool = (name: string, description = name, inputSchema: Record<string, unknown> = { type: 'object', properties: {} }): CatalogTool => ({ name, description, inputSchema })
const store = (limits: Partial<ConstructorParameters<typeof ActivationStore>[0]> = {}) => new ActivationStore({
  nameMapper: (name) => `p7_${name}`,
  ...limits,
})
const visible = () => true

describe('ActivationStore', () => {
  it('keeps parent, child, and sibling Agent identities isolated', () => {
    const subject = store()
    subject.publishCatalog([tool('finance_quote'), tool('macro_gdp')])
    const parent = {}; const child = {}; const sibling = {}
    expect(subject.load(parent, ['p7_finance_quote'], visible)).toMatchObject({ ok: true })
    expect(subject.load(child, ['p7_macro_gdp'], visible)).toMatchObject({ ok: true })
    expect(subject.active(parent, visible).map((entry) => entry.toolId)).toEqual(['p7_finance_quote'])
    expect(subject.active(child, visible).map((entry) => entry.toolId)).toEqual(['p7_macro_gdp'])
    expect(subject.active(sibling, visible)).toEqual([])
  })

  it('checks policy at load and active time without exposing forbidden candidates', () => {
    const subject = store()
    subject.publishCatalog([tool('finance_quote', '市场行情报价'), tool('macro_gdp', '宏观经济数据')])
    const agent = {}
    const quoteOnly = (entry: { toolId: string }) => entry.toolId === 'p7_finance_quote'
    expect(subject.load(agent, ['p7_macro_gdp'], quoteOnly)).toEqual({ ok: false, reason: 'forbidden' })
    expect(subject.load(agent, ['p7_finance_quote'], quoteOnly)).toMatchObject({ ok: true })
    expect(subject.active(agent, () => false)).toEqual([])
    expect(subject.search(agent, '宏观', undefined, undefined, quoteOnly)).toEqual({ ok: true, tools: [] })
  })

  it('rejects guessed names and preserves state on all budget failures, including repeated ids', () => {
    const subject = store({ maxLoadedTools: 1, maxSchemaBytes: 100 })
    subject.publishCatalog([
      tool('small', 'small', { type: 'object' }),
      tool('other', 'other', { type: 'object' }),
      tool('large', 'large', { type: 'object', properties: { payload: { type: 'string', description: 'x'.repeat(300) } } }),
    ])
    const agent = {}
    expect(subject.load(agent, ['p7_guessed'], visible)).toEqual({ ok: false, reason: 'unknown' })
    expect(subject.load(agent, ['p7_small', 'p7_small'], visible)).toMatchObject({ ok: true })
    expect(subject.load(agent, ['p7_small', 'p7_other'], visible)).toEqual({ ok: false, reason: 'tool-limit' })
    expect(subject.active(agent, visible).map((entry) => entry.toolId)).toEqual(['p7_small'])
    expect(subject.load(agent, ['p7_large'], visible)).toEqual({ ok: false, reason: 'tool-limit' })
    expect(subject.active(agent, visible).map((entry) => entry.toolId)).toEqual(['p7_small'])
    const schemaOnly = store({ maxSchemaBytes: 100 })
    const separateAgent = {}
    schemaOnly.publishCatalog([tool('large', 'large', { type: 'object', properties: { payload: { type: 'string', description: 'x'.repeat(300) } } })])
    expect(schemaOnly.load(separateAgent, ['p7_large'], visible)).toEqual({ ok: false, reason: 'schema-limit' })
    expect(schemaOnly.active(separateAgent, visible)).toEqual([])
  })

  it('retains unchanged definitions and drops changed or deleted ones', () => {
    const subject = store()
    const agent = {}
    subject.publishCatalog([tool('quote', 'first'), tool('macro', 'same')])
    expect(subject.load(agent, ['p7_quote', 'p7_macro'], visible)).toMatchObject({ ok: true })
    subject.publishCatalog([tool('quote', 'changed'), tool('macro', 'same')])
    expect(subject.active(agent, visible).map((entry) => entry.toolId)).toEqual(['p7_macro'])
    subject.publishCatalog([tool('quote', 'changed')])
    expect(subject.active(agent, visible)).toEqual([])
    expect(subject.owns('p7_macro')).toBe(true)
    subject.publishCatalog([tool('quote', 'changed'), tool('macro', 'same')])
    expect(subject.active(agent, visible)).toEqual([])
  })

  it('invalidates every identity on catalog invalidation and denies after close', () => {
    const subject = store()
    const parent = {}; const child = {}
    subject.publishCatalog([tool('quote')])
    subject.load(parent, ['p7_quote'], visible)
    subject.load(child, ['p7_quote'], visible)
    subject.invalidateCatalog()
    expect(subject.active(parent, visible)).toEqual([])
    expect(subject.active(child, visible)).toEqual([])
    expect(subject.load(parent, ['p7_quote'], visible)).toEqual({ ok: false, reason: 'unavailable' })
    subject.close()
    expect(subject.load(parent, ['p7_quote'], visible)).toEqual({ ok: false, reason: 'closed' })
    expect(subject.active(parent, visible)).toEqual([])
  })

  it('reclaims the load budget of capabilities removed by the current Agent policy', () => {
    const subject = store({ maxLoadedTools: 1 })
    const agent = {}
    subject.publishCatalog([tool('finance'), tool('macro')])
    subject.load(agent, ['p7_finance'], visible)
    const macroOnly = (entry: { toolId: string }) => entry.toolId === 'p7_macro'
    expect(subject.load(agent, ['p7_macro'], macroOnly)).toMatchObject({ ok: true })
    expect(subject.active(agent, visible).map(entry => entry.toolId)).toEqual(['p7_macro'])
    subject.forgetAgent(agent)
    expect(subject.active(agent, visible)).toEqual([])
  })

  it('counts the actual registered description bytes, including padding', () => {
    const subject = store({ maxSchemaBytes: 100 })
    subject.publishCatalog([tool('padded', ' '.repeat(200) + 'query' + ' '.repeat(200))])
    expect(subject.load({}, ['p7_padded'], visible)).toEqual({ ok: false, reason: 'schema-limit' })
  })

  it('searches Chinese metadata locally, respects namespace and bounds descriptions', () => {
    const subject = store()
    subject.publishCatalog([
      tool('finance__quote', '提供证券市场行情和报价。' + '长'.repeat(200)),
      tool('macro__gdp', '查询GDP宏观经济指标'),
      tool('security__audit', '安全审计工具'),
    ])
    const agent = {}
    const result = subject.search(agent, '行情', 'finance', 50, (entry) => entry.toolId !== 'p7_security__audit')
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.tools.map((candidate) => candidate.toolId)).toEqual(['p7_finance__quote'])
      expect(result.tools.at(0)?.description.length).toBe(160)
    }
    expect(subject.search(agent, '安全', undefined, undefined, () => false)).toEqual({ ok: true, tools: [] })
    expect(subject.search(agent, '查询GDP指标', 'macro', undefined, visible)).toMatchObject({ ok: true, tools: [{ toolId: 'p7_macro__gdp' }] })
  })

  it('matches natural Chinese closing-price and profit-forecast requests without bypassing policy', () => {
    const subject = store()
    subject.publishCatalog([
      tool('market__daily_quote', 'Daily market quote and close price'),
      tool('research__consensus_forecast', 'Analyst earnings and profit forecast consensus'),
      tool('research__internal', 'Internal research only'),
    ])
    const result = subject.search({}, '中国科传昨天收盘价格和盈利预测', undefined, 10,
      entry => entry.toolId !== 'p7_research__internal')
    expect(result.ok && result.tools.map(candidate => candidate.toolId)).toEqual(expect.arrayContaining([
      'p7_market__daily_quote',
      'p7_research__consensus_forecast',
    ]))
    expect(result.ok && result.tools.map(candidate => candidate.toolId)).not.toContain('p7_research__internal')
  })

  it.each(['p7_weknora__search_knowledge', 'weknora__search_knowledge'])('selects only a uniquely exact tool id: %s', (query) => {
    const subject = store()
    subject.publishCatalog([
      tool('weknora__search_knowledge', 'Search company knowledge'),
      tool('weknora__read_document', 'Read company knowledge'),
      tool('weknora__wiki_search', 'Search company wiki knowledge'),
    ])
    expect(subject.search({}, ` ${query} `, undefined, undefined, visible)).toMatchObject({
      ok: true, tools: [{ toolId: 'p7_weknora__search_knowledge' }],
    })
    const general = subject.search({}, 'company knowledge', undefined, undefined, visible)
    expect(general.ok && general.tools.length).toBe(3)
  })

  it('applies namespace and policy before exact matching', () => {
    const subject = store()
    subject.publishCatalog([tool('weknora__search_knowledge')])
    expect(subject.search({}, 'weknora__search_knowledge', 'wk', undefined, visible)).toEqual({ ok: true, tools: [] })
    expect(subject.search({}, 'p7_weknora__search_knowledge', undefined, undefined, () => false)).toEqual({ ok: true, tools: [] })
  })

  it('keeps normal ranking when a public name also matches another wire name', () => {
    const subject = store()
    subject.publishCatalog([tool('quote'), tool('p7_quote')])
    const result = subject.search({}, 'p7_quote', undefined, undefined, visible)
    expect(result.ok && result.tools.map(tool => tool.toolId).sort()).toEqual(['p7_p7_quote', 'p7_quote'])
  })
})
