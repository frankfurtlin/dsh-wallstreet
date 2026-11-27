/**
 * dsh-wallstreet —— 资讯中心「今日头版」
 *
 * 参照 dsh-morning-paper 的思路（docs/prior-art-2026-11-25.md §5.5）：资讯列表按时间排到
 * 上千条时，用户要自己从里面挑重点。头版只回答四个问题，全部规则可算、不烧 token：
 *
 *   1. 今天最值得看的几条是什么？（按重要度，多源报道额外的加权已经在重要度里）
 *   2. 哪个板块今天最热闹？（今天的事件按板块计数）
 *   3. 我关注的票有没有消息？（持仓快照里的代码命中）
 *   4. 今天一共多少量？（事件 / 条目 / 源 / 多源事件）
 *
 * `buildFrontpage()` 是纯函数，方便单测；`getFrontpage()` 负责取数。
 */
import { beijingDayStart, normalizeSector } from './schema.js'
import { allEventsSince, stats as storeStats } from './store.js'
import { loadDictionary } from './tagging.js'

/** 头版最多展示几条要闻 / 关注股消息。 */
export const HIGHLIGHT_LIMIT = 5
export const WATCH_LIMIT = 5
/** 板块热度展示前几名。 */
export const SECTOR_LIMIT = 3
/** 要闻的最低门槛：低于它不进头版，宁缺毋滥。 */
export const HIGHLIGHT_MIN_IMPORTANCE = 60

function text(value, max = 160) {
  const raw = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw
}

/** 只保留 http(s) 链接；其它（javascript: / data: / 空）一律给空串。 */
function safeLink(url) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : ''
  } catch {
    return ''
  }
}

/** 事件压成头版需要的最小字段（不把整个 event 塞给前端）。 */
function brief(event) {
  return {
    id: event.id,
    ts: event.ts,
    lastTs: event.lastTs,
    title: text(event.title, 140),
    summary: text(event.summary, 120),
    eventType: event.eventType || '',
    kind: event.kind,
    importance: Number(event.importance) || 0,
    sourceCount: Number(event.sourceCount) || 1,
    tickers: (event.tickers || []).slice(0, 4),
    sectors: (event.sectors || []).slice(0, 3).map((name) => normalizeSector(name) || name),
    url: safeLink(event.url),
    ai: event.llm && event.llm.summary
      ? { summary: text(event.llm.summary, 120), sentiment: event.llm.sentiment || '中性' }
      : null,
  }
}

/**
 * 纯函数：把当天的数据编成头版。
 *
 * @param {{
 *   events: Array<object>,        // 今天的全部事件（已按重要度无关的顺序给出也行）
 *   stats?: object,               // store.stats() 的结果（可选）
 *   watchlist?: Set<string>,      // 持仓代码
 *   now?: number,
 *   highlightLimit?: number,
 *   watchLimit?: number,
 *   sectorLimit?: number,
 *   minImportance?: number,
 * }} input
 */
export function buildFrontpage({
  events,
  stats = null,
  watchlist = null,
  now = Date.now(),
  highlightLimit = HIGHLIGHT_LIMIT,
  watchLimit = WATCH_LIMIT,
  sectorLimit = SECTOR_LIMIT,
  minImportance = HIGHLIGHT_MIN_IMPORTANCE,
} = {}) {
  const list = Array.isArray(events) ? events.filter((event) => event && event.title) : []
  const watch = watchlist instanceof Set ? watchlist : new Set(Array.isArray(watchlist) ? watchlist : [])

  // 1) 要闻：重要度优先，其次时间新。多源事件本身已经在重要度里加过分。
  const ranked = list
    .slice()
    .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0) || (Number(b.lastTs) || 0) - (Number(a.lastTs) || 0))
  const qualified = ranked.filter((event) => (Number(event.importance) || 0) >= minImportance)
  const pool = qualified.length > 0 ? qualified : ranked
  // 同一只票只上头版一次：3 条「*ST航图 发行/付息/风险提示」并列第一不是「今日要闻」，
  // 是同一件事刷屏。先按票去重取，凑不满再放宽。
  const picked = []
  const seenTicker = new Set()
  for (const event of pool) {
    const key = (event.tickers || [])[0] || ''
    if (key && seenTicker.has(key)) continue
    if (key) seenTicker.add(key)
    picked.push(event)
    if (picked.length >= Math.max(1, highlightLimit)) break
  }
  // 宁可少于 limit 也不拿同一只票的第二条凑数：头版少一条不亏，重复一条是噪音。
  const highlights = picked.map(brief)

  // 2) 板块热度：今天事件里出现最多的板块（同名归一后合并）。
  const buckets = new Map()
  for (const event of list) {
    for (const raw of event.sectors || []) {
      const name = normalizeSector(raw) || raw
      if (!name) continue
      const bucket = buckets.get(name) || { name, events: 0, importance: 0, lastTs: 0, tickers: new Set() }
      bucket.events += 1
      bucket.importance = Math.max(bucket.importance, Number(event.importance) || 0)
      bucket.lastTs = Math.max(bucket.lastTs, Number(event.lastTs) || 0)
      for (const code of event.tickers || []) bucket.tickers.add(code)
      buckets.set(name, bucket)
    }
  }
  const sectors = [...buckets.values()]
    .sort((a, b) => b.events - a.events || b.importance - a.importance)
    .slice(0, Math.max(1, sectorLimit))
    .map((bucket) => ({
      name: bucket.name,
      events: bucket.events,
      importance: bucket.importance,
      lastTs: bucket.lastTs,
      tickers: [...bucket.tickers].slice(0, 4),
    }))

  // 3) 我关注的票：今天有消息的（按重要度取前 N 只票，同一只票只出最新一条）。
  const watchItems = []
  if (watch.size > 0) {
    const seen = new Set()
    for (const event of ranked) {
      const hit = (event.tickers || []).find((code) => watch.has(code) && !seen.has(code))
      if (!hit) continue
      seen.add(hit)
      watchItems.push({ ...brief(event), watchedTicker: hit })
      if (watchItems.length >= Math.max(1, watchLimit)) break
    }
  }

  // 4) 数量：优先用 store 的统计（全库口径），没有就用当天事件自己数。
  const counts = {
    events: list.length,
    multiSource: list.filter((event) => (Number(event.sourceCount) || 1) > 1).length,
    items: stats && Number.isFinite(stats.items) ? stats.items : null,
    sources: stats && Array.isArray(stats.bySource) ? stats.bySource.length : null,
    summarized: list.filter((event) => event.llm && event.llm.summary).length,
  }

  const kindCounts = new Map()
  for (const event of list) kindCounts.set(event.kind || 'flash', (kindCounts.get(event.kind || 'flash') || 0) + 1)

  return {
    date: new Date(now + 8 * 3600_000).toISOString().slice(0, 10),
    generatedAt: new Date(now).toISOString(),
    counts,
    byKind: [...kindCounts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    highlights,
    sectors,
    watch: watchItems,
    watchedCount: watch.size,
  }
}

/**
 * 取数 + 编头版。
 * @param {{ now?: number, sinceHours?: number }} [options]
 */
export async function getFrontpage({ now = Date.now(), sinceHours = 24 } = {}) {
  const since = beijingDayStart(now)
  // 头版看「今天」，跨零点前几小时也算进来——直接用 24h 窗口会让上午 9 点前的头版很空。
  const from = Math.min(since, now - Math.min(24, Math.max(1, sinceHours)) * 3600_000)
  const events = allEventsSince(from, 3000).filter((event) => {
    const stamp = Number(event.lastTs) || Number(event.ts) || 0
    return stamp >= from
  })
  const stats = storeStats()
  let watchlist = new Set()
  try {
    const dict = await loadDictionary()
    watchlist = (dict && dict.watchlist) || new Set()
  } catch {
    /* 没有持仓快照也照常出头版，只是「我关注的票」为空 */
  }
  const frontpage = buildFrontpage({ events, stats, watchlist, now })
  return { ...frontpage, lastIngestAt: stats.lastIngestAt || '', windowFrom: from }
}
