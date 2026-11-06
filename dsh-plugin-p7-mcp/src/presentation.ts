import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'

const KNOWN_TOOL_TITLES: Readonly<Record<string, string>> = {
  gildata__FinQuery: '聚源数据查询',
  jydb__find_security: '聚源本地证券查询',
  jydb__get_daily_quotes: '日行情查询',
  jydb__get_income: '利润表查询',
  jydb__get_balance_sheet: '资产负债表查询',
  jydb__get_cashflow: '现金流量表查询',
  jydb__get_valuation: '估值查询',
  jydb__get_consensus: '一致预期查询',
  jydb__get_macro_series: '宏观数据查询',
  search__web_search: '互联网搜索',
  wk__search_law: '威科法规检索',
  wk__search_law_keyword: '法规关键词检索',
  wk__search_law_article: '法条检索',
  wk__search_case: '案例检索',
  wk__search_case_keyword: '案例关键词检索',
  wk__legal_citation: '法律引用',
  weknora__ask: '公司知识库问答',
  weknora__grep_chunks: '片段检索',
  weknora__list_documents: '文档列表',
  weknora__list_knowledge_bases: '知识库列表',
  weknora__read_document: '文档读取',
  weknora__search_knowledge: '知识检索',
  weknora__wiki_index: 'Wiki目录',
  weknora__wiki_read_page: 'Wiki页面读取',
  weknora__wiki_search: 'Wiki检索',
}

export function mcpToolTitle(wireName: string, title?: string): string {
  return title ?? KNOWN_TOOL_TITLES[wireName] ?? '公司工具调用'
}

/**
 * Add a Chinese label without changing the bridge's raw result projection.
 * Existing presenters retain their card shape and content; an absent presenter
 * keeps the runtime's normal argument/result fallback.
 */
export function presentMcpToolDefinition(definition: ToolDefinition, wireName: string, displayTitle?: string): ToolDefinition {
  const title = mcpToolTitle(wireName, displayTitle)
  const presentCall = definition.presentCall
  const presentResult = definition.presentResult
  return {
    ...definition,
    presentCall: args => withCallTitle(presentCall?.(args), title),
    presentResult: (args, result) => withResultTitle(presentResult?.(args, result), title),
  }
}

function withCallTitle(view: ToolCallView | undefined, title: string): ToolCallView {
  return view === undefined ? { card: 'generic', title } : { ...view, title } as ToolCallView
}

function withResultTitle(view: ToolResultView | undefined, title: string): ToolResultView {
  return view === undefined ? { card: 'generic', title } : { ...view, title } as ToolResultView
}
