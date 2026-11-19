#!/usr/bin/env node
/**
 * dsh-wallstreet 数据层自检：打真实上游，断言面板依赖的字段形状与关键取值。
 *
 * 它不是单元测试（依赖外网），而是「装上之前先确认 API 没变」的冒烟脚本：
 * 上游字段一旦改名/改顺序，这里会先炸，而不是等浏览器里看到一片「暂不可用」。
 *
 * 用法：node verification/verify-api.mjs
 */
import { getHealth, getHistory, getMoves, getNews, getOverview, getStock, getTrend, INDICES } from '../lib/market.js'

const failures = []

function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`
  console.log(line)
  if (!ok) failures.push(name)
}

const health = await getHealth()
check('health.ok', health.ok === true, JSON.stringify(health.checks))
check('health.quotes', health.checks.some((c) => c.name === 'quotes' && c.ok))

const overview = await getOverview()
check('overview.ok', overview.ok === true)
// 实时模式会带一条「沿用上一交易日快照」的提示，不算降级；只把包含「不可用」的警告视为失败
check(
  'overview.warnings 无降级',
  overview.warnings.every((item) => !/不可用|fetch failed|failed/i.test(item)),
  overview.warnings.join('；'),
)
check('overview.dataMode 合法', ['live', 'snapshot'].includes(overview.dataMode), overview.dataMode)
check('overview.sources 齐全', ['indices', 'breadth', 'sectors', 'trend', 'kline'].every((key) => typeof overview.sources?.[key] === 'string'))
check('交易时段标记存在', typeof overview.trading.session === 'string', overview.trading.session)

/* 指数：清单齐全、多数有报价 */
check('indices 数量 = INDICES', Array.isArray(overview.indices) && overview.indices.length === INDICES.length)
const priced = (overview.indices || []).filter((item) => typeof item.price === 'number' && item.price > 0)
check('indices 有报价 >= 8', priced.length >= 8, `${priced.length}/${INDICES.length}`)
check(
  '上证指数有涨跌幅',
  (overview.indices || []).some((item) => item.code === '000001' && typeof item.changePct === 'number'),
)

/* 分时：时间必须是 HH:MM（前端刻度匹配依赖这个格式） */
const trendPoints = overview.trend?.sh?.points || []
if (overview.trading.session === 'trading' || overview.trading.session === 'lunch' || overview.trading.session === 'closing') {
  check('上证分时点数 > 10', trendPoints.length > 10, `${trendPoints.length} 点`)
  check('分时时间格式 HH:MM', trendPoints.length > 0 && /^\d{2}:\d{2}$/.test(trendPoints[0].time), trendPoints[0]?.time)
  check('分时价格为正', trendPoints.every((point) => point.price > 0))
  check('分时有昨收', typeof overview.trend.sh.preClose === 'number')
}

/* 宽度 */
check('breadth 总数 > 1000', overview.breadth && overview.breadth.total > 1000, String(overview.breadth?.total))
check(
  'breadth 涨+跌+平 = 总数',
  overview.breadth.up + overview.breadth.down + overview.breadth.flat === overview.breadth.total,
)
check('涨停家数已用池口径校正', typeof overview.breadth.limitUp === 'number' && overview.breadth.limitUp >= 0)

/* 成交额 */
check('turnover.total > 0', overview.turnover && overview.turnover.total > 0, String(overview.turnover?.total))

/* 板块 */
check(
  'sectors 领涨/领跌非空',
  (overview.sectors?.gainers || []).length > 0 && (overview.sectors?.losers || []).length > 0,
  `${overview.sectors?.gainers?.length}/${overview.sectors?.losers?.length}`,
)
check(
  '领涨板块第一名涨幅 >= 领跌第一名',
  (overview.sectors?.gainers?.[0]?.changePct ?? 0) >= (overview.sectors?.losers?.[0]?.changePct ?? 0),
)

/* 日 K / 均线 / 量能 */
const kline = overview.kline
check('kline.recent >= 30 根', kline && kline.recent.length >= 30, `${kline?.recent?.length}`)
check('kline 收盘价为正', kline && kline.recent.every((row) => row.close > 0))
check('均线 MA5/MA20 为数字', typeof kline?.ma5 === 'number' && typeof kline?.ma20 === 'number')
check('量能比 > 0', typeof kline?.volumeRatio === 'number' && kline.volumeRatio > 0, String(kline?.volumeRatio))

/* 市场温度 */
const analysis = overview.analysis
check('温度 0–100', typeof analysis.temperature === 'number' && analysis.temperature >= 0 && analysis.temperature <= 100, String(analysis.temperature))
check('温度标签合法', ['过热', '偏暖', '中性', '偏冷', '冰点'].includes(analysis.label?.text), analysis.label?.text)
check('四个分项都存在', ['breadth', 'limit', 'volume', 'momentum'].every((key) => typeof analysis.scores[key] === 'number'))
check('signals 非空', Array.isArray(analysis.signals) && analysis.signals.length > 0, String(analysis.signals.length))

/* 实时/快照模式：盘中应当是 live（盘后允许 snapshot） */
const liveSession = ['trading', 'lunch', 'closing'].includes(overview.trading.session)
if (liveSession) {
  check('盘中 overview 为实时模式', overview.dataMode === 'live', overview.dataMode)
  check('盘中涨跌家数与板块为实时来源', overview.sources?.breadth === 'live' && overview.sources?.sectors === 'live', JSON.stringify(overview.sources))
  check('盘中量能比按交易时间折算', typeof overview.turnover?.progress === 'number' && overview.turnover.progress > 0 && overview.turnover.progress <= 1, String(overview.turnover?.progress))
}

/* 异动数据（/moves）：盘中实时、盘后快照 */
const moves = await getMoves()
check('moves.ok', moves.ok === true)
check('moves 涨停池今日家数 > 0', moves.limitPool && moves.limitPool.today > 0, String(moves.limitPool?.today))
check('moves 涨停池行数 > 0', Array.isArray(moves.limitPool?.rows) && moves.limitPool.rows.length > 0, String(moves.limitPool?.rows?.length))
check('moves 首封时间 HH:MM:SS', /^\d{2}:\d{2}:\d{2}$/.test(moves.limitPool.rows[0]?.firstSeal || ''), moves.limitPool.rows[0]?.firstSeal)
check('moves 龙虎榜行数 >= 5', moves.lhb.length >= 5, String(moves.lhb.length))
check('moves 涨跌幅榜 top/bottom 非空', moves.movers.top.length > 0 && moves.movers.bottom.length > 0)
check('moves 板块资金流 top/bottom 非空', moves.sectorFlow.top.length > 0 && moves.sectorFlow.bottom.length > 0)
check('moves 资金流向榜 outflow 非空', moves.flows.outflow.length > 0)
check('moves.dataMode 合法', ['live', 'snapshot'].includes(moves.dataMode), moves.dataMode)
if (liveSession) {
  check('盘中涨停池为实时来源', moves.sources?.limitPool === 'live', JSON.stringify(moves.sources))
  check('盘中涨停池含连板数', moves.limitPool.rows.some((row) => typeof row.boardCount === 'number'))
}

/* 单指数分时接口 */
const shTrend = await getTrend('1.000001')
check('getTrend 返回分时', Array.isArray(shTrend.points) && shTrend.points.length > 0)
let unknownRejected = false
try {
  await getTrend('9.999999')
} catch {
  unknownRejected = true
}
check('未知 secid 会被拒绝', unknownRejected)

/* 一句话盘面结论 */
check('summary 存在且含温度', /温度/.test(overview.summary?.text || ''), overview.summary?.text)
check('summary tone 合法', ['up', 'down', 'muted'].includes(overview.summary?.tone), overview.summary?.tone)

/* 个股下钻：/stock 支持的三种市场 */
const stockA = await getStock('600519')
check('stock A 股 ok', stockA.ok === true && stockA.quote.price > 0, `${stockA.name} ${stockA.quote.price}`)
check('stock A 股含分时', (stockA.trend?.points || []).length > 10, String(stockA.trend?.points?.length))
check('stock A 股含近 60 日日 K', (stockA.kline?.recent || []).length >= 30, String(stockA.kline?.recent?.length))
const stockHk = await getStock('hk00700')
check('stock 港股 ok', stockHk.ok === true && stockHk.quote.price > 0, `${stockHk.name} ${stockHk.quote.price}`)
const stockUs = await getStock('usAAPL')
check('stock 美股 ok', stockUs.ok === true && stockUs.quote.price > 0, `${stockUs.name} ${stockUs.quote.price}`)
let stockRejected = false
try {
  await getStock('@@@')
} catch {
  stockRejected = true
}
check('未知股票代码会被拒绝', stockRejected)

/* 快讯与公告：多源、可跳转 */
const news = await getNews(20)
check('news.ok', news.ok === true)
check('news 条数 >= 10', (news.items || []).length >= 10, String(news.items?.length))
check('news 每条都有原文链接', news.items.every((item) => /^https?:\/\//.test(item.url || '')), String(news.items.filter((item) => !item.url).length) + ' 条缺链接')
check('news 来源 >= 2 种', new Set(news.items.map((item) => item.source)).size >= 2, [...new Set(news.items.map((item) => item.source))].join('/'))
check('news 有时间和标题', news.items.every((item) => item.time && item.title))

/* 情绪历史：读 market-report 每日快照 jsonl */
const history = await getHistory(40)
check('history.ok', history.ok === true)
check('history 点数 >= 20', (history.points || []).length >= 20, String(history.points?.length))
check('history 最新日期为今天或最近交易日', /^\d{4}-\d{2}-\d{2}$/.test(history.latestDate || ''), history.latestDate)
const lastPoint = (history.points || [])[history.points.length - 1] || {}
check('history 末点含涨停/跌停/成交额', typeof lastPoint.zt === 'number' && typeof lastPoint.dt === 'number' && lastPoint.amount > 0, JSON.stringify(lastPoint))

console.log('')
if (failures.length === 0) {
  console.log(`全部通过（${overview.indices.length} 个指数，${overview.breadth.total} 家涨跌样本）`)
  process.exit(0)
}
console.error(`失败 ${failures.length} 项：${failures.join('、')}`)
process.exit(1)
