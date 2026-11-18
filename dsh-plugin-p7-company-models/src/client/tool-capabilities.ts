import type { CompanySettingsLocaleKey } from './locales.js'
import type { P7McpToolInfo } from '../mcp-tool-status.js'

export type ToolCapability = 'finance' | 'knowledge' | 'legal' | 'search'

export interface ToolGroup {
  id: ToolCapability
  title: CompanySettingsLocaleKey
  description: CompanySettingsLocaleKey
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
  { id: 'finance', title: 'toolsFinance', description: 'toolsFinanceIntro' },
  { id: 'knowledge', title: 'toolsKnowledge', description: 'toolsKnowledgeIntro' },
  { id: 'legal', title: 'toolsLegal', description: 'toolsLegalIntro' },
  { id: 'search', title: 'toolsSearch', description: 'toolsSearchIntro' },
]

const KNOWN_TOOL_COPY: Readonly<Record<string, { label: CompanySettingsLocaleKey; purpose: CompanySettingsLocaleKey }>> = {
  mcp__p7__gildata__FinQuery: { label: 'toolGildata', purpose: 'toolGildataPurpose' },
  mcp__p7__search__web_search: { label: 'toolWebSearch', purpose: 'toolWebSearchPurpose' },
  mcp__p7__weknora__search_knowledge: { label: 'toolKnowledgeSearch', purpose: 'toolKnowledgeSearchPurpose' },
  mcp__p7__weknora__read_document: { label: 'toolKnowledgeRead', purpose: 'toolKnowledgeReadPurpose' },
  mcp__p7__weknora__wiki_search: { label: 'toolWikiSearch', purpose: 'toolWikiSearchPurpose' },
  mcp__p7__weknora__ask: { label: 'toolKnowledgeAsk', purpose: 'toolKnowledgeAskPurpose' },
  mcp__p7__weknora__grep_chunks: { label: 'toolKnowledgeGrep', purpose: 'toolKnowledgeGrepPurpose' },
  mcp__p7__weknora__list_documents: { label: 'toolKnowledgeDocuments', purpose: 'toolKnowledgeDocumentsPurpose' },
  mcp__p7__weknora__list_knowledge_bases: { label: 'toolKnowledgeBases', purpose: 'toolKnowledgeBasesPurpose' },
  mcp__p7__weknora__wiki_index: { label: 'toolWikiIndex', purpose: 'toolWikiIndexPurpose' },
  mcp__p7__weknora__wiki_read_page: { label: 'toolWikiRead', purpose: 'toolWikiReadPurpose' },
  mcp__p7__wk__search_law: { label: 'toolLegalSearch', purpose: 'toolLegalSearchPurpose' },
  mcp__p7__wk__search_law_keyword: { label: 'toolLegalKeyword', purpose: 'toolLegalKeywordPurpose' },
  mcp__p7__wk__search_law_article: { label: 'toolLegalArticle', purpose: 'toolLegalArticlePurpose' },
  mcp__p7__wk__search_case: { label: 'toolCaseSearch', purpose: 'toolCaseSearchPurpose' },
  mcp__p7__wk__search_case_keyword: { label: 'toolCaseKeyword', purpose: 'toolCaseKeywordPurpose' },
  mcp__p7__wk__legal_citation: { label: 'toolLegalCitation', purpose: 'toolLegalCitationPurpose' },
  mcp__p7__jydb__find_security: { label: 'toolJydbSecurity', purpose: 'toolJydbSecurityPurpose' },
  mcp__p7__jydb__get_daily_quotes: { label: 'toolJydbQuotes', purpose: 'toolJydbQuotesPurpose' },
  mcp__p7__jydb__get_income: { label: 'toolJydbIncome', purpose: 'toolJydbIncomePurpose' },
  mcp__p7__jydb__get_balance_sheet: { label: 'toolJydbBalance', purpose: 'toolJydbBalancePurpose' },
  mcp__p7__jydb__get_cashflow: { label: 'toolJydbCashflow', purpose: 'toolJydbCashflowPurpose' },
  mcp__p7__jydb__get_valuation: { label: 'toolJydbValuation', purpose: 'toolJydbValuationPurpose' },
  mcp__p7__jydb__get_consensus: { label: 'toolJydbConsensus', purpose: 'toolJydbConsensusPurpose' },
  mcp__p7__jydb__get_macro_series: { label: 'toolJydbMacro', purpose: 'toolJydbMacroPurpose' },
}

const GROUP_BY_NAMESPACE: Readonly<Record<string, ToolCapability>> = {
  gildata: 'finance',
  jydb: 'finance',
  weknora: 'knowledge',
  wk: 'legal',
  search: 'search',
}

function parts(name: string): { namespace: string; operation: string } | undefined {
  const match = /^mcp__p7__([^_]+)__(.+)$/.exec(name)
  return match === null ? undefined : { namespace: match[1]!, operation: match[2]! }
}

const SERVER_LABELS: Readonly<Record<string, CompanySettingsLocaleKey>> = {
  gildata: 'serverGildata', jydb: 'serverJydb', weknora: 'serverKnowledge', wk: 'serverLegal', search: 'serverSearch', research: 'serverResearch',
}

export function toolServerGroups(tools: readonly P7McpToolInfo[], t: (key: CompanySettingsLocaleKey) => string): { id: string; name: string; tools: P7McpToolInfo[] }[] {
  const groups = new Map<string, { id: string; name: string; tools: P7McpToolInfo[] }>()
  for (const tool of tools) {
    const id = tool.server?.namespace ?? parts(tool.name)?.namespace ?? 'other'
    const label = SERVER_LABELS[id]
    const name = tool.server?.name ?? t(label ?? 'toolsOtherServer')
    let group = groups.get(id)
    if (group === undefined) { group = { id, name, tools: [] }; groups.set(id, group) }
    group.tools.push(tool)
  }
  return [...groups.values()]
}

export function toolCapability(name: string): ToolCapability | undefined {
  const parsed = parts(name)
  return parsed === undefined ? undefined : GROUP_BY_NAMESPACE[parsed.namespace]
}

/** Protocol identities stay in data; normal UI uses declared or localized titles. */
export function toolDisplayName(name: string, t: (key: CompanySettingsLocaleKey) => string, title?: string): string {
  if (title) return title
  const known = KNOWN_TOOL_COPY[name]
  return known === undefined ? (name.startsWith('mcp__p7__') ? t('toolCompany') : name) : t(known.label)
}

export function toolCopy(name: string, t: (key: CompanySettingsLocaleKey) => string): { label: string; purpose: string } {
  const known = KNOWN_TOOL_COPY[name]
  if (known !== undefined) return { label: t(known.label), purpose: t(known.purpose) }
  const group = toolCapability(name)
  const parsed = parts(name)
  const operation = parsed?.operation.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ') ?? name
  const label = group === undefined ? operation : `${t(`tools${group[0]!.toUpperCase()}${group.slice(1)}` as CompanySettingsLocaleKey)} · ${operation}`
  const purpose = group === undefined ? t('toolUncategorizedPurpose') : t(`tool${group[0]!.toUpperCase()}${group.slice(1)}Purpose` as CompanySettingsLocaleKey)
  return { label, purpose }
}
