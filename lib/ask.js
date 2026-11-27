/**
 * dsh-wallstreet —— 面板 AI 问答（host 半）。
 *
 * 面板五个 tab（盘面/异动/资讯/研究/策略）共用右侧问答栏：问题要能结合**当前这一页**
 * 的内容回答，所以这里按 `page` 取对应数据源，压成一段紧凑上下文：
 *   market   → /overview（指数、宽度、涨跌停、成交额、板块、温度、均线）
 *   moves    → /moves（涨停池与连板、涨幅榜、行业资金、龙虎榜）
 *   news     → 资讯库最近 24h 高分事件
 *   research → 研究归档（宽度/估值/两融/涨停池/结论/策略样本/持仓集中度）
 *   strategy → 策略口径（配置表、风控阈值、熔断）
 *
 * 设计约束：
 *  - 数据一律服务端取，不接受客户端传上下文（防注入、防页面停在旧数据答非所问）；
 *  - 上下文有体积预算（每页几百到两千字），不把整页 JSON 塞进提示词；
 *  - 走宿主 `ctx.llm`，与聊天同账号/配额；
 *  - 输出 SSE 流式返回，由 lib/index.js 的 `/wallstreet/api/ask` 负责传输。
 */
import { randomUUID } from 'node:crypto'
import { getMoves, getOverview } from './market.js'
import { getHoldingsConcentration, getQuantOverview, getQuantResearch } from './quant.js'
import { queryFeed } from './hub/store.js'
import { allocationTable, getProfile } from './strategy.js'
import { describeFinish, resolveLlm, resolveModel } from './hub/llm.js'

/** 单次问答超时：模型答一页数据通常在 10–30 秒，留足推理时间。 */
export const ASK_TIMEOUT_MS = 70_000
/** 输出预算与 hub 摘要同口径：推理 token 和正文共享，给小了会被截断。 */
const MAX_TOKENS = 4096
/** 历史轮数上限（一问一答算两条），防止越聊越贵。 */
const MAX_HISTORY = 8
const MAX_QUESTION = 500
const MAX_HISTORY_ITEM = 3_000

/** 问答支持的页面：与前端 tab 一一对应。 */
export const ASK_PAGES = ['market', 'moves', 'news', 'research', 'strategy']
export const PAGE_LABELS = {
  market: '盘面',
  moves: '异动',
  news: '资讯',
  research: '研究',
  strategy: '策略',
}

export const SYSTEM_PROMPT = `你是 A 股投资研究助手，服务于「华尔街之狼」插件的页面问答。
用户正在看插件的某一个 tab，问题都围绕下面这份【当前页面数据】。

回答规则：
1. 只能依据给定的页面数据和你的常识；页面里没有的数字不要编，直接说「页面没有这项数据」。
2. 先给结论，再给 2–4 条依据，最后用一句话提示主要风险。中文、简洁、不说废话。
3. 被问到概率或历史规律时，明确说明依据是历史统计还是经验判断，不要包装成确定性预测。
4. 个股建议只谈板块与结构，不给具体买卖点；不构成投资建议。
5. 「上一轮对话」是此前的问答，用它保持追问连贯；里面的数字若与本次数据冲突，以本次数据为准。
6. 数据可能是盘中快照：涉及涨跌幅时带上数据时间，避免用户误以为是收盘数据。
7. 用纯文本回答，不要 Markdown 标记（不要 **、##、表格），编号用「1. 2. 3.」。`

/* ------------------------------------------------------------------ */
/* 通用格式化                                                          */
/* ------------------------------------------------------------------ */

const pct = (value) => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '—')
const yi = (value) => (Number.isFinite(value) ? (value / 1e8).toFixed(1) : '—')
const num = (value) => (Number.isFinite(value) ? String(value) : '—')
const text = (value, max = 80) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max)
const stamp = (ts) => {
  if (!Number.isFinite(ts)) return ''
  const date = new Date(ts)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 把一组「名称 + 数值」排成一行，最多取 limit 个。 */
function topLine(items, { limit = 6, render }) {
  return (items || [])
    .slice(0, limit)
    .map(render)
    .filter(Boolean)
    .join('；')
}

/* ------------------------------------------------------------------ */
/* 盘面页                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把 overview 压成提示词上下文。
 * @param {object} overview getOverview() 的返回值
 * @returns {{text: string, dataAt: string, stale: boolean}}
 */
export function buildMarketContext(overview) {
  const trading = (overview && overview.trading) || {}
  const dataMode = overview && overview.dataMode
  // 盘中 marketDate 仍是上一交易日快照日期，dataTime 却是实时时间：直接拼会出现
  // 「2026-11-26 13:50」这种自相矛盾的时间。盘中一律用 trading 的日期与时间。
  const live = dataMode === 'live'
  const datePart = (live ? trading.date : (overview && overview.marketDate) || trading.date) || ''
  const timePart = (live ? trading.time : (overview && overview.dataTime) || trading.time) || ''
  const dataAt = [datePart, timePart].filter(Boolean).join(' ')
  const lines = []

  const indices = Array.isArray(overview && overview.indices) ? overview.indices : []
  if (indices.length > 0) {
    lines.push(
      '指数：' +
        indices
          .map((item) => `${item.name} ${Number.isFinite(item.price) ? item.price.toFixed(2) : '—'}（${pct(item.changePct)}）`)
          .join('｜'),
    )
  }

  const breadth = (overview && overview.breadth) || null
  if (breadth) {
    const upRatio = Number.isFinite(breadth.upRatio) ? `，上涨占比 ${(breadth.upRatio * 100).toFixed(1)}%` : ''
    lines.push(
      `宽度：上涨 ${num(breadth.up)} 家、下跌 ${num(breadth.down)} 家、平盘 ${num(breadth.flat)} 家${upRatio}；涨停 ${num(breadth.limitUp)}、跌停 ${num(breadth.limitDown)}`,
    )
  }

  const turnover = (overview && overview.turnover) || null
  if (turnover && Number.isFinite(turnover.total)) {
    const parts = [`两市成交 ${yi(turnover.total)} 亿元`]
    if (Number.isFinite(turnover.progress) && turnover.progress > 0 && turnover.progress < 1) {
      parts.push(`截至当前约走完全天的 ${(turnover.progress * 100).toFixed(0)}%`)
    }
    if (Number.isFinite(turnover.projectedTotal)) parts.push(`预计全天 ${yi(turnover.projectedTotal)} 亿元`)
    if (Number.isFinite(turnover.ratio5d)) parts.push(`量能比为前 5 日均值的 ${turnover.ratio5d.toFixed(2)} 倍`)
    lines.push('成交：' + parts.join('，'))
  }

  const analysis = (overview && overview.analysis) || null
  if (analysis) {
    const label = analysis.label && analysis.label.text ? `「${analysis.label.text}」` : ''
    const scores = analysis.scores
      ? `（宽度 ${num(analysis.scores.breadth)} / 涨跌停 ${num(analysis.scores.limit)} / 量能 ${num(analysis.scores.volume)} / 动量 ${num(analysis.scores.momentum)}）`
      : ''
    if (Number.isFinite(analysis.temperature)) lines.push(`市场温度：${analysis.temperature} ${label}${scores}`)
    if (Array.isArray(analysis.signals) && analysis.signals.length > 0) {
      lines.push('盘面信号：\n' + analysis.signals.map((signal) => `- ${signal}`).join('\n'))
    }
  }

  const sectors = (overview && overview.sectors) || null
  const sectorLine = (rows, title) => {
    if (!Array.isArray(rows) || rows.length === 0) return ''
    const items = rows
      .slice(0, 6)
      .map((row) => {
        const flow = Number.isFinite(row.mainInflow)
          ? `，主力${row.mainInflow >= 0 ? '净流入' : '净流出'} ${yi(Math.abs(row.mainInflow))} 亿`
          : ''
        return `${row.name} ${pct(row.changePct)}${flow}`
      })
      .join('；')
    return `${title}：${items}`
  }
  const gainers = sectorLine(sectors && sectors.gainers, '板块领涨')
  const losers = sectorLine(sectors && sectors.losers, '板块领跌')
  if (gainers) lines.push(gainers)
  if (losers) lines.push(losers)

  const kline = (overview && overview.kline) || null
  if (kline) {
    const mas = [
      Number.isFinite(kline.ma5) ? `MA5 ${kline.ma5.toFixed(2)}` : '',
      Number.isFinite(kline.ma10) ? `MA10 ${kline.ma10.toFixed(2)}` : '',
      Number.isFinite(kline.ma20) ? `MA20 ${kline.ma20.toFixed(2)}` : '',
      Number.isFinite(kline.ma60) ? `MA60 ${kline.ma60.toFixed(2)}` : '',
    ]
      .filter(Boolean)
      .join('、')
    const recent = Array.isArray(kline.recent) ? kline.recent : []
    const last = recent.length > 0 ? recent[recent.length - 1] : null
    const above = []
    const below = []
    if (last && Number.isFinite(last.close)) {
      for (const [key, name] of [
        ['ma5', 'MA5'],
        ['ma10', 'MA10'],
        ['ma20', 'MA20'],
        ['ma60', 'MA60'],
      ]) {
        if (!Number.isFinite(last[key])) continue
        ;(last.close >= last[key] ? above : below).push(name)
      }
    }
    const relation =
      above.length || below.length
        ? `；上证收 ${last.close.toFixed(2)}，站上 ${above.join('/') || '无'}、低于 ${below.join('/') || '无'}`
        : ''
    if (mas) lines.push(`上证均线：${mas}${relation}`)
  }

  const warnings = Array.isArray(overview && overview.warnings) ? overview.warnings.filter(Boolean) : []
  if (warnings.length > 0) lines.push('数据降级提示：' + warnings.join('；'))

  if (lines.length === 0) return { text: '（盘面数据暂不可用）', dataAt, stale: !overview || overview.stale !== false }

  const mode = dataMode === 'live' ? '盘中实时' : '收盘快照'
  const header = [`【当前页面：盘面】${mode}${dataAt ? ` · ${dataAt}` : ''}`]
  return {
    text: header.concat(lines).join('\n'),
    dataAt,
    stale: !overview || overview.stale !== false,
  }
}

/* ------------------------------------------------------------------ */
/* 异动页                                                              */
/* ------------------------------------------------------------------ */

/** 把「涨停池 / 涨幅榜 / 行业资金 / 龙虎榜」压成一段上下文。 */
export function buildMovesContext(moves, { now = Date.now() } = {}) {
  const lines = []
  const pool = (moves && moves.limitPool) || null
  // 与盘面同理：盘中 marketDate 是上一交易日快照日期，dataTime 是实时时间，直接拼会错日期。
  const live = Boolean(moves && moves.dataMode === 'live')
  const datePart = live ? new Date(now).toISOString().slice(0, 10) : (moves && moves.marketDate) || ''
  const dataAt = [datePart, moves && moves.dataTime].filter(Boolean).join(' ')
  if (pool) {
    const rows = Array.isArray(pool.rows) ? pool.rows : []
    const boards = new Map()
    for (const row of rows) {
      const count = Number(row.boardCount)
      if (!Number.isFinite(count) || count <= 0) continue
      boards.set(count, (boards.get(count) || 0) + 1)
    }
    const boardText = [...boards.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([count, n]) => `${count} 板 ${n} 家`)
      .join('、')
    const industries = new Map()
    for (const row of rows) {
      const name = text(row.industry, 12)
      if (!name) continue
      industries.set(name, (industries.get(name) || 0) + 1)
    }
    const hotIndustries = [...industries.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, n]) => `${name} ${n} 家`)
      .join('、')
    lines.push(
      `涨停：今日 ${num(pool.today)} 家${Number.isFinite(pool.prev) ? `（前一交易日 ${pool.prev} 家）` : ''}` +
        (boardText ? `；连板分布：${boardText}` : '') +
        (hotIndustries ? `\n涨停集中行业：${hotIndustries}` : ''),
    )
  }

  const movers = (moves && moves.movers) || null
  if (movers) {
    const top = topLine(movers.top, { render: (row) => `${row.name} ${pct(row.pct)}` })
    const bottom = topLine(movers.bottom, { render: (row) => `${row.name} ${pct(row.pct)}` })
    if (top) lines.push('涨幅榜：' + top)
    if (bottom) lines.push('跌幅榜：' + bottom)
  }

  const sectorFlow = (moves && moves.sectorFlow) || null
  if (sectorFlow) {
    const inflow = topLine(sectorFlow.top, {
      render: (row) => `${row.industry || row.name} ${pct(row.changePct)}（净额 ${yi(row.net)} 亿）`,
    })
    const outflow = topLine(sectorFlow.bottom, {
      render: (row) => `${row.industry || row.name} ${pct(row.changePct)}（净额 ${yi(row.net)} 亿）`,
    })
    if (inflow) lines.push('行业资金净流入前 6：' + inflow)
    if (outflow) lines.push('行业资金净流出前 6：' + outflow)
  }

  const lhb = Array.isArray(moves && moves.lhb) ? moves.lhb : []
  const lhbText = topLine(lhb, {
    limit: 6,
    render: (row) => `${row.name} ${pct(row.pct)}（净额 ${yi(row.net)} 亿）`,
  })
  if (lhbText) lines.push('龙虎榜：' + lhbText)

  const warnings = Array.isArray(moves && moves.warnings) ? moves.warnings.filter(Boolean) : []
  if (warnings.length > 0) lines.push('数据降级提示：' + warnings.join('；'))

  const mode = moves && moves.dataMode === 'live' ? '盘中实时' : '收盘快照'
  const header = [`【当前页面：异动】${mode}${dataAt ? ` · ${dataAt}` : ''}`]
  if (lines.length === 0) lines.push('（异动数据暂不可用）')
  return {
    text: header.concat(lines).join('\n'),
    dataAt,
    stale: !moves || moves.stale !== false,
  }
}

/* ------------------------------------------------------------------ */
/* 资讯页                                                              */
/* ------------------------------------------------------------------ */

/** 把最近 24h 的高分事件压成上下文（标题 + 类型 + 时间 + 重要度）。 */
export function buildNewsContext(feed, { limit = 18 } = {}) {
  const events = (feed && Array.isArray(feed.events) ? feed.events : []).slice(0, limit)
  const total = (feed && feed.total) || events.length
  const lines = events.map((event) => {
    const meta = [stamp(event.ts || event.lastTs), event.eventType || event.kind, `重要度 ${event.importance || 0}`]
      .filter(Boolean)
      .join(' · ')
    const tickers = Array.isArray(event.tickers) && event.tickers.length ? `（${event.tickers.join('/')}）` : ''
    return `- ${meta}｜${text(event.title, 90)}${tickers}`
  })
  const header = [
    `【当前页面：资讯】最近 24 小时重要度 ≥60 的事件 · 按重要度取前 ${events.length} 条（共 ${total} 条）`,
  ]
  if (lines.length === 0) lines.push('（最近 24 小时没有高分事件）')
  return {
    text: header.concat(lines).join('\n'),
    dataAt: '',
    stale: false,
  }
}

/* ------------------------------------------------------------------ */
/* 研究页                                                              */
/* ------------------------------------------------------------------ */

/** 把研究归档（宽度 / 估值 / 两融 / 结论 / 持仓集中度）压成上下文。 */
export function buildResearchContext(overview, research, holdings) {
  const lines = []
  const dataDate = (overview && overview.dataDate) || ''
  const breadth = (overview && overview.breadth) || null
  if (breadth) {
    lines.push(
      `市场宽度（${dataDate}）：上涨 ${num(breadth.up)} 家、下跌 ${num(breadth.down)} 家、涨停 ${num(breadth.limitUp)}、跌停 ${num(breadth.limitDown)}`,
    )
  }
  const valuation = Array.isArray(overview && overview.valuation) ? overview.valuation : []
  if (valuation.length > 0) {
    lines.push(
      '指数估值（PE-TTM / 历史分位）：' +
        valuation
          .slice(0, 6)
          .map((row) => `${row.name} ${num(row.peTtm)}${Number.isFinite(row.pctile) ? `（${row.pctile}%）` : ''}`)
          .join('；'),
    )
  }
  const margin = (overview && overview.margin) || null
  const marginText = [
    ['沪', margin && margin.sh],
    ['深', margin && margin.sz],
  ]
    .filter(([, row]) => row)
    .map(([side, row]) => `${side}市${row.date ? ' ' + row.date : ''} 融资余额 ${yi(row.financingBalance)} 亿`)
    .join('；')
  if (marginText) lines.push('两融：' + marginText)

  const limitPool = (overview && overview.limitPool) || null
  if (limitPool && Number.isFinite(limitPool.today)) {
    lines.push(`涨停池：${limitPool.today} 家${Number.isFinite(limitPool.prev) ? `（前一交易日 ${limitPool.prev} 家）` : ''}`)
  }

  if (research) {
    if (research.headline) lines.push(`研究结论：${text(research.headline, 160)}`)
    if (research.headlineDetail) lines.push(`结论展开：${text(research.headlineDetail, 200)}`)
    if (Array.isArray(research.premises) && research.premises.length > 0) {
      lines.push('前提：\n' + research.premises.slice(0, 3).map((item) => `- ${text(item, 120)}`).join('\n'))
    }
    const counts = research.counts || {}
    if (counts.total) {
      lines.push(`策略样本：${counts.total} 个（有效 ${counts.effective || 0} / 边缘 ${counts.edge || 0} / 无效 ${counts.invalid || 0}）`)
    }
    const strategies = Array.isArray(research.strategies) ? research.strategies.slice(0, 5) : []
    if (strategies.length > 0) {
      lines.push(
        '策略排名（按 act_t）：' +
          strategies
            .map(
              (item) =>
                `${item.displayName || item.name} α ${item.alpha == null ? '—' : (item.alpha * 100).toFixed(1) + '%'} act_t ${item.actT == null ? '—' : item.actT}`,
            )
            .join('；'),
      )
    }
  }

  const snapshot = holdings && holdings.snapshot
  if (snapshot) {
    const groups = snapshot.groupWeight || {}
    const topGroups = Object.entries(groups)
      .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
      .slice(0, 3)
      .map(([name, weight]) => `${name} ${(Number(weight) * 100).toFixed(1)}%`)
      .join('、')
    lines.push(
      `持仓集中度（${snapshot.date || '快照'}）：${num(snapshot.holdingsCount)} 只，组合权重 ${Number.isFinite(snapshot.portfolioPct) ? (snapshot.portfolioPct * 100).toFixed(1) + '%' : '—'}，HHI ${num(snapshot.hhi)}` +
        (topGroups ? `；前三大分组：${topGroups}` : '') +
        (Array.isArray(snapshot.alerts) && snapshot.alerts.length ? `\n集中度提示：${snapshot.alerts.slice(0, 3).join('；')}` : ''),
    )
  }

  const warnings = []
  for (const node of [overview, research, holdings]) {
    if (node && Array.isArray(node.warnings)) warnings.push(...node.warnings.filter(Boolean))
  }
  if (warnings.length > 0) lines.push('数据降级提示：' + warnings.slice(0, 4).join('；'))

  const header = [`【当前页面：研究】归档慢数据${dataDate ? ` · ${dataDate}` : ''}`]
  if (lines.length === 0) lines.push('（研究归档数据暂不可用）')
  return {
    text: header.concat(lines).join('\n'),
    dataAt: dataDate,
    stale: Boolean(overview && overview.stale),
  }
}

/* ------------------------------------------------------------------ */
/* 策略页                                                              */
/* ------------------------------------------------------------------ */

/** 把配置表 + 风控阈值压成上下文。 */
export function buildStrategyContext(table, profile) {
  const lines = []
  const rows = (table && Array.isArray(table.rows) ? table.rows : []).map(
    (row) =>
      `${row.label} ${row.weightPct}%（${Math.round(row.amount / 1000) / 10} 万，角色：${text(row.role, 30)}，目标年化 ${(row.targetReturn * 100).toFixed(1)}%）`,
  )
  if (rows.length > 0) lines.push('配置：' + rows.join('；'))
  if (table && Number.isFinite(table.blendedTarget)) lines.push(`组合目标年化：${table.blendedTarget}%`)

  const rules = profile && profile.rules
  if (rules) {
    const stop = rules.stopLoss || {}
    const labels = { stock: '个股', sectorETF: '行业 ETF', broadETF: '宽基 ETF', convertible: '可转债' }
    const stopLine = Object.entries(stop)
      .filter(([, rule]) => rule && (rule.review != null || rule.cut != null))
      .map(([kind, rule]) => {
        const parts = []
        if (rule.review != null) parts.push(`${(rule.review * 100).toFixed(0)}% 复核`)
        if (rule.cut != null) parts.push(`${(rule.cut * 100).toFixed(0)}% 砍`)
        return `${labels[kind] || kind} ${parts.join(' / ')}`
      })
      .join('；')
    const breaker = rules.circuitBreaker || {}
    lines.push(
      `风控：单票上限 ${(rules.singleStockMax * 100).toFixed(0)}%、单行业 ${(rules.singleSectorMax * 100).toFixed(0)}%、核心底仓 ≥${(rules.coreMin * 100).toFixed(0)}%、现金 ≥${(rules.cashMin * 100).toFixed(0)}%` +
        (stopLine ? `\n止损：${stopLine}` : '') +
        (Number.isFinite(breaker.pause) || Number.isFinite(breaker.liquidateSatellite)
          ? `\n熔断：组合 ${(breaker.pause * 100).toFixed(0)}% 暂停加仓、${(breaker.liquidateSatellite * 100).toFixed(0)}% 清卫星仓`
          : ''),
    )
  }

  const header = [`【当前页面：策略】${profile ? profile.label : '配置口径'}`]
  if (lines.length === 0) lines.push('（策略口径暂不可用）')
  return {
    text: header.concat(lines).join('\n'),
    dataAt: '',
    stale: false,
  }
}

/* ------------------------------------------------------------------ */
/* 组装                                                                */
/* ------------------------------------------------------------------ */

/**
 * 按页面取数据并构造上下文。任一数据源失败只让该页上下文缺一块，不抛错——
 * 问答本身仍有价值（「页面没有这项数据」也是模型能说的答案）。
 */
export async function loadPageContext(page = 'market', { profileId = '10w', now = Date.now() } = {}) {
  const pageId = ASK_PAGES.includes(page) ? page : 'market'
  const warnings = []
  const settle = async (label, loader) => {
    try {
      return await loader()
    } catch (error) {
      warnings.push(`${label}：${error && error.message ? error.message : '未知错误'}`)
      return null
    }
  }
  let result
  if (pageId === 'moves') {
    result = buildMovesContext(await settle('异动数据', () => getMoves()), { now })
  } else if (pageId === 'news') {
    result = buildNewsContext(queryFeed({ since: now - 24 * 60 * 60 * 1000, minImportance: 60, limit: 60 }))
  } else if (pageId === 'research') {
    const [overview, research, holdings] = await Promise.all([
      settle('市场概览', () => getQuantOverview()),
      settle('研究结论', () => getQuantResearch()),
      settle('持仓集中度', () => getHoldingsConcentration()),
    ])
    result = buildResearchContext(overview, research, holdings)
  } else if (pageId === 'strategy') {
    const profile = getProfile(profileId)
    result = buildStrategyContext(allocationTable(profileId), profile)
  } else {
    result = buildMarketContext(await settle('盘面数据', () => getOverview({ withTrend: false })))
  }
  if (warnings.length > 0) {
    result = { ...result, text: `${result.text}\n数据获取提示：${warnings.slice(0, 3).join('；')}` }
  }
  return { ...result, page: pageId }
}

/** 校验并裁剪入参；返回 null 表示参数不合法。 */
export function normalizeAskInput(body) {
  const question = String((body && body.question) || '').trim()
  if (!question) return null
  if (question.length > MAX_QUESTION) return null
  const rawHistory = Array.isArray(body && body.history) ? body.history : []
  const history = []
  for (const item of rawHistory.slice(-MAX_HISTORY)) {
    const role = item && item.role === 'assistant' ? 'assistant' : 'user'
    const content = String((item && item.content) || '').trim()
    if (!content) continue
    history.push({ role, content: content.slice(0, MAX_HISTORY_ITEM) })
  }
  while (history.length > 0 && history[0].role === 'assistant') history.shift()
  const page = body && ASK_PAGES.includes(body.page) ? body.page : 'market'
  const profileId = body && ['10w', '50w'].includes(body.profile) ? body.profile : '10w'
  return { question, history, page, profileId }
}

/**
 * 跑一次页面问答。
 *
 * @param {object} ctx 插件上下文（取宿主 llm 服务）
 * @param {{question:string, history?:Array<{role:string,content:string}>, page?:string, profileId?:string, signal?:AbortSignal, onDelta?:(text:string)=>void, context?:object}} options
 * @returns {Promise<{ok:true, answer:string, model:string, dataAt:string, page:string, usage?:object}>}
 */
export async function askMarket(ctx, { question, history = [], page = 'market', profileId = '10w', signal, onDelta, context } = {}) {
  const input = normalizeAskInput({ question, history, page, profile: profileId })
  if (!input) throw new Error('问题不能为空，且不超过 500 字')

  const llm = resolveLlm(ctx)
  if (!llm) throw new Error('宿主没有可用的 LLM 服务（ctx.llm 不可用）')
  const model = await resolveModel(ctx)
  if (!model || model.unavailable) throw new Error((model && model.reason) || '宿主没有可用的默认模型')

  const pageContext = context || (await loadPageContext(input.page, { profileId: input.profileId }))

  // 不构造 assistant 角色的历史消息：宿主 Message 需要 id/source 等持久会话字段，
  // 手拼的 assistant 消息会被 adapter 判成非法请求（实测「上游报错 UNKNOWN」）。
  // 多轮上下文改为并入 user 文本，与首次单轮请求保持同一种形状。
  const historyText =
    input.history.length > 0
      ? '\n\n【上一轮对话】\n' +
        input.history.map((item) => `${item.role === 'user' ? '用户' : '助手'}：${item.content}`).join('\n')
      : ''
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: `${pageContext.text}${historyText}\n\n【用户问题】${input.question}` }],
    },
  ]

  let answer = ''
  let usage
  let finish
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS)
  try {
    for await (const chunk of llm.stream({
      provider: model.provider,
      model: model.model,
      system: SYSTEM_PROMPT,
      messages,
      // 与 hub 摘要同口径：部分 provider 要求显式会话标识。
      sessionId: `wallstreet-ask-${randomUUID()}`,
      maxTokens: MAX_TOKENS,
      temperature: 0.3,
      reasoningEffort: 'low',
      signal: controller.signal,
    })) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        answer += chunk.text
        if (onDelta) onDelta(chunk.text)
      } else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    if (/abort/i.test(message)) throw new Error(`模型超时（>${Math.round(ASK_TIMEOUT_MS / 1000)} 秒）或请求被中止`)
    throw error
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  if (!answer.trim()) {
    throw new Error(describeFinish(finish, answer) || '模型返回空内容')
  }
  return {
    ok: true,
    answer: answer.trim(),
    model: `${model.provider}/${model.model}`,
    dataAt: pageContext.dataAt,
    page: input.page,
    usage,
  }
}

export { MAX_QUESTION, MAX_HISTORY }
