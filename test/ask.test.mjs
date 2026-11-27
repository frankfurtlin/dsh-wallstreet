/**
 * 盘面 AI 问答的纯函数测试：上下文压缩与入参裁剪。
 *
 * 这里不打模型、不读网络：模型调用（askMarket）需要宿主 ctx.llm，属于端到端验证，
 * 由 verification/verify-ask.mjs 覆盖；本文件只保证「发进提示词的内容」和
 * 「允许发进来的参数」这两件事的形状稳定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASK_PAGES,
  MAX_QUESTION,
  PAGE_LABELS,
  SYSTEM_PROMPT,
  buildMarketContext,
  buildMovesContext,
  buildNewsContext,
  buildResearchContext,
  buildStrategyContext,
  normalizeAskInput,
} from '../lib/ask.js'

function sampleOverview() {
  return {
    ok: true,
    dataMode: 'live',
    marketDate: '2026-11-27',
    dataTime: '13:29',
    stale: true,
    trading: { date: '2026-11-27', time: '13:29', session: 'trading' },
    indices: [
      { name: '上证指数', price: 3569.8, changePct: 2.67 },
      { name: '创业板指', price: 2384.7, changePct: 8.9 },
    ],
    breadth: { up: 5118, down: 246, flat: 20, total: 5384, limitUp: 202, limitDown: 0, upRatio: 0.951 },
    turnover: { total: 1.31087455e12, progress: 0.61, projectedTotal: 2.14897467e12, ratio5d: 1.456 },
    analysis: {
      temperature: 86,
      label: { text: '过热' },
      scores: { breadth: 95, limit: 100, volume: 100, momentum: 50 },
      signals: ['上涨 5118 家 / 下跌 246 家，上涨占比 95.1%', '涨停 202 家 / 跌停 0 家'],
    },
    sectors: {
      gainers: [{ name: '半导体设备', changePct: 16.72, mainInflow: 2.766e9 }],
      losers: [{ name: '银行', changePct: -1.17, mainInflow: -2.086e9 }],
    },
    kline: { ma5: 3522.09, ma10: 3549.69, ma20: 3603.18, ma60: 3755.25, recent: [{ close: 3569.8, ma5: 3522.09, ma10: 3549.69, ma20: 3603.18, ma60: 3755.25 }] },
    warnings: [],
  }
}

test('buildMarketContext：带上指数、宽度、成交、温度、板块、均线与数据时间', () => {
  const { text, dataAt, stale } = buildMarketContext(sampleOverview())
  assert.equal(dataAt, '2026-11-27 13:29')
  assert.equal(stale, true)
  assert.match(text, /上证指数 3569\.80（\+2\.67%）/)
  assert.match(text, /创业板指 2384\.70（\+8\.90%）/)
  assert.match(text, /上涨 5118 家、下跌 246 家/)
  assert.match(text, /涨停 202、跌停 0/)
  assert.match(text, /两市成交 13108\.7 亿元/)
  assert.match(text, /市场温度：86 「过热」/)
  assert.match(text, /半导体设备 \+16\.72%/)
  assert.match(text, /银行 -1\.17%/)
  assert.match(text, /MA20 3603\.18/)
  assert.match(text, /站上 MA5\/MA10/)
  assert.match(text, /低于 MA20\/MA60/)
})

test('buildMarketContext：快照模式与空数据都能给出人话', () => {
  const snapshot = buildMarketContext({
    dataMode: 'snapshot',
    marketDate: '2026-11-26',
    dataTime: '15:10',
    stale: false,
    trading: { date: '2026-11-27', time: '10:00' },
    indices: [{ name: '上证指数', price: 3476.88, changePct: 0.01 }],
    breadth: { up: 1766, down: 3641, flat: 173, total: 5580, limitUp: 88, limitDown: 21 },
  })
  assert.match(snapshot.text, /收盘快照/)
  assert.match(snapshot.text, /2026-11-26 15:10/)
  assert.equal(snapshot.stale, false)

  const empty = buildMarketContext(null)
  assert.match(empty.text, /盘面数据暂不可用/)
  assert.equal(empty.stale, true)
})

test('buildMarketContext：不把整页 JSON 塞进去（体积有上限）', () => {
  const overview = sampleOverview()
  overview.trend = { sh: { points: Array.from({ length: 240 }, (_, i) => ({ time: '09:30', price: i })) } }
  const { text } = buildMarketContext(overview)
  assert.ok(text.length < 2400, `上下文 ${text.length} 字，超过预算`)
})

test('normalizeAskInput：空问题/超长问题直接拒绝', () => {
  assert.equal(normalizeAskInput(null), null)
  assert.equal(normalizeAskInput({}), null)
  assert.equal(normalizeAskInput({ question: '   ' }), null)
  assert.equal(normalizeAskInput({ question: 'x'.repeat(MAX_QUESTION + 1) }), null)
})

test('normalizeAskInput：历史最多 8 条、单条截断、去掉开头 assistant', () => {
  const history = [{ role: 'assistant', content: '开场白' }]
  for (let index = 0; index < 20; index += 1) {
    history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: `第 ${index} 条` })
  }
  const input = normalizeAskInput({ question: '今天为什么涨？', history })
  assert.equal(input.question, '今天为什么涨？')
  assert.ok(input.history.length <= 8)
  assert.equal(input.history[0].role, 'user')
  assert.ok(input.history.every((item) => item.content && item.content.length <= 3000))
})

test('SYSTEM_PROMPT：约束了「不编数据」和「不构成投资建议」', () => {
  assert.match(SYSTEM_PROMPT, /不要编/)
  assert.match(SYSTEM_PROMPT, /不构成投资建议/)
})


/* ------------------------------ 其余四个页面 ------------------------------ */

test('buildMovesContext：涨停结构、连板、行业与资金、龙虎榜', () => {
  const moves = {
    dataMode: 'live',
    marketDate: '2026-11-27',
    dataTime: '14:10',
    stale: true,
    limitPool: {
      today: 285,
      prev: 51,
      rows: [
        { name: '常山北明', industry: 'IT服务Ⅱ', boardCount: 2 },
        { name: '证通电子', industry: 'IT服务Ⅱ', boardCount: 3 },
        { name: '镇洋发展', industry: '化学原料', boardCount: 1 },
      ],
    },
    movers: { top: [{ name: '艾融软件', pct: 30 }], bottom: [{ name: '青岛食品', pct: -8.7 }] },
    sectorFlow: {
      top: [{ industry: '半导体', changePct: 12.7, net: 1.6e10 }],
      bottom: [{ industry: '银行', changePct: -1.2, net: -2.1e9 }],
    },
    lhb: [{ name: '康芝药业', pct: 20, net: 3.3e7 }],
    warnings: [],
  }
  const { text, dataAt } = buildMovesContext(moves)
  assert.equal(dataAt, '2026-11-27 14:10')
  assert.match(text, /当前页面：异动/)
  assert.match(text, /涨停：今日 285 家（前一交易日 51 家）/)
  assert.match(text, /2 板 1 家、3 板 1 家/)
  assert.match(text, /IT服务Ⅱ 2 家/)
  assert.match(text, /半导体 \+12\.70%/)
  assert.match(text, /龙虎榜：康芝药业/)
})

test('buildMovesContext：空数据给出人话而不是崩溃', () => {
  const { text } = buildMovesContext(null)
  assert.match(text, /异动数据暂不可用/)
})

test('buildNewsContext：按时间/类型/重要度列出事件，并保留条数', () => {
  const feed = {
    total: 42,
    events: [
      { ts: new Date('2026-11-27T05:24:00Z').getTime(), title: '国常会一个月内两提资本市场', eventType: '政策法规', importance: 70, tickers: ['600030'] },
      { ts: new Date('2026-11-27T05:12:00Z').getTime(), title: '算力芯片概念再度拉升', kind: 'flash', importance: 62 },
    ],
  }
  const { text } = buildNewsContext(feed)
  assert.match(text, /最近 24 小时重要度 ≥60 的事件 · 按重要度取前 2 条（共 42 条）/)
  assert.match(text, /重要度 70｜国常会一个月内两提资本市场（600030）/)
  assert.match(text, /重要度 62｜算力芯片概念再度拉升/)
})

test('buildResearchContext：宽度、估值、结论、持仓集中度都在', () => {
  const overview = {
    dataDate: '2026-11-26',
    breadth: { up: 1766, down: 3641, limitUp: 88, limitDown: 21 },
    valuation: [{ name: '沪深300', peTtm: 12.3, pctile: 45 }],
    margin: { sh: { date: '2026-11-26', financingBalance: 1.2e12 } },
    limitPool: { today: 66, prev: 54 },
    warnings: [],
    stale: false,
  }
  const research = {
    headline: '量化策略样本外普遍无效。',
    headlineDetail: '唯一稳健结论是高换手后续跑输。',
    premises: ['前提一', '前提二'],
    counts: { total: 23, effective: 0, edge: 2, invalid: 21 },
    strategies: [{ displayName: '低波动红利', alpha: 0.03, actT: 2.1 }],
    warnings: [],
  }
  const holdings = {
    snapshot: { date: '2026-09-11', holdingsCount: 11, portfolioPct: 0.62, hhi: 0.11, groupWeight: { 资源: 0.4 }, alerts: ['资源组 40% 超限'] },
    warnings: [],
  }
  const { text, dataAt } = buildResearchContext(overview, research, holdings)
  assert.equal(dataAt, '2026-11-26')
  assert.match(text, /市场宽度（2026-11-26）/)
  assert.match(text, /沪深300 12.3（45%）/)
  assert.match(text, /研究结论：量化策略样本外普遍无效。/)
  assert.match(text, /策略样本：23 个（有效 0 \/ 边缘 2 \/ 无效 21）/)
  assert.match(text, /持仓集中度（2026-09-11）/)
  assert.match(text, /资源 40\.0%/)
})

test('buildStrategyContext：配置、目标年化与止损熔断阈值', () => {
  const table = {
    rows: [
      { label: '现金储备', weightPct: 10, amount: 10000, role: '抄底子弹', targetReturn: 0.025 },
      { label: '核心 ETF 底仓', weightPct: 30, amount: 30000, role: '宽基底盘', targetReturn: 0.1 },
    ],
    blendedTarget: 14.8,
  }
  const profile = {
    label: '10 万本金 · 目标年化 20%',
    rules: {
      singleStockMax: 0.08,
      singleSectorMax: 0.2,
      coreMin: 0.25,
      cashMin: 0.05,
      stopLoss: { stock: { review: -0.1, cut: -0.2 }, sectorETF: { review: -0.15, cut: -0.25 } },
      circuitBreaker: { pause: -0.15, liquidateSatellite: -0.25 },
    },
  }
  const { text } = buildStrategyContext(table, profile)
  assert.match(text, /当前页面：策略/)
  assert.match(text, /现金储备 10%（1 万/)
  assert.match(text, /组合目标年化：14\.8%/)
  assert.match(text, /单票上限 8%、单行业 20%/)
  assert.match(text, /个股 -10% 复核 \/ -20% 砍/)
  assert.match(text, /熔断：组合 -15% 暂停加仓、-25% 清卫星仓/)
})

test('normalizeAskInput：page 只认白名单，profile 只认 10w/50w', () => {
  assert.deepEqual(
    ASK_PAGES.map((page) => PAGE_LABELS[page]),
    ['盘面', '异动', '资讯', '研究', '策略'],
  )
  assert.equal(normalizeAskInput({ question: '怎么看？', page: 'moves' }).page, 'moves')
  assert.equal(normalizeAskInput({ question: '怎么看？', page: 'hack' }).page, 'market')
  assert.equal(normalizeAskInput({ question: '怎么看？', profile: '50w' }).profileId, '50w')
  assert.equal(normalizeAskInput({ question: '怎么看？', profile: '999w' }).profileId, '10w')
})
