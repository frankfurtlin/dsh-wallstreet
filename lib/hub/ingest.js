/**
 * dsh-wallstreet —— 信息资讯集散中心 · 入站与聚簇
 *
 * 一轮 ingest 做五件事：
 *   1. 按源自己的 intervalMs + 当前时段倍率判断「到期」，串行抓（不并发打上游）；
 *   2. 抓回来的裸条目过 schema.makeItem 归一化，再交 tagging 打标；
 *   3. 批量落库（主键去重），只处理真正新插入的条目；
 *   4. 新条目在 ±90 分钟窗口内找事件簇：共享 ticker 或标题相似度 ≥0.58 就并入；
 *   5. 记源健康度、写 lastIngestAt、定期清理过期数据。
 *
 * 单个源失败只影响该源：错误写进 source_state 给 /hub/stats 和面板看。
 */
import { makeItem, beijingDayStart, titleSimilarity, trigrams, jaccard, sectorMatches } from './schema.js'
import { loadDictionary, tagItem, mergeTags } from './tagging.js'
import { reverseIndex, pumpQueue } from './membership.js'
import { loadConfig, effectiveSources } from './config.js'
import {
  openStore,
  insertItems,
  candidateEvents,
  upsertEvent,
  linkEventItems,
  getEvent,
  recentItems,
  updateItemTags,
  recentEvents,
  updateEventTags,
  recordSourceRun,
  metaSet,
  prune,
} from './store.js'

/** 聚簇窗口（毫秒）：同一事件的多家报道通常落在前后 90 分钟内。 */
const CLUSTER_WINDOW_MS = 90 * 60 * 1000
/**
 * 按 kind 分档的合并阈值。为什么不同档：
 *  - 公告/研报都是「一篇独立文档」，同一篇被巨潮与东财各抓一次时标题几乎逐字相同；
 *    而同一只票的两份不同公告（辞职 / 处罚 / 续聘）只共享公司名，绝不该并成一条。
 *    所以公告档要求标题高度相似，并**关闭「共享个股」这条通道**（阈值 >1 即禁用）。
 *  - 快讯是同事件多源改写，措辞差异大，允许共享个股 + 较低相似度。
 */
const CLUSTER_RULES = {
  flash: { sharedMin: 0.42, similarityMin: 0.5 },
  announcement: { sharedMin: 1.1, similarityMin: 0.85 },
  report: { sharedMin: 1.1, similarityMin: 0.72 },
  policy: { sharedMin: 0.4, similarityMin: 0.55 },
}
/** 事件类型不同时，要求更高的字面重合才允许合并。 */
const CROSS_TYPE_MIN = 0.7
/**
 * 摘要相似度阈值（跨源正文去重）：两家标题写法差异大，但正文首段几乎逐字相同时，
 * 靠标题会漏聚。只取摘要前 80 字做 3-gram 比较，避免长文两两比较把 CPU 打满。
 */
const SUMMARY_SIM_MIN = 0.55
const SUMMARY_CHARS = 80
/** 单源抓取的外部兜底超时：比源自己的 8s 再宽一点。 */
const SOURCE_TIMEOUT_MS = 20_000

const lastRunAt = new Map()
let inFlight = null
let lastPruneAt = 0

/** 北京时间粗分时段：影响抓取频率，不影响数据口径。 */
export function phaseNow(now = Date.now()) {
  const shifted = new Date(now + 8 * 60 * 60 * 1000)
  const weekday = shifted.getUTCDay() >= 1 && shifted.getUTCDay() <= 5
  if (!weekday) return 'weekend'
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  const morning = minutes >= 9 * 60 + 15 && minutes <= 11 * 60 + 30
  const afternoon = minutes >= 13 * 60 && minutes <= 15 * 60
  return morning || afternoon ? 'trading' : 'offhours'
}

/** 时段倍率：盘后 4 倍、周末 8 倍间隔，夜里不白抓上游。 */
export function phaseFactor(phase) {
  if (phase === 'trading') return 1
  if (phase === 'weekend') return 8
  return 4
}

/**
 * 读适配器清单 + 用户覆盖，得到**有效源清单**。
 * 每次入站都重新读配置：面板改了开关/间隔，下一轮就生效，不用重载插件。
 */
async function loadSourceList() {
  const module = await import('./sources.js')
  const adapters = Array.isArray(module.SOURCES) ? module.SOURCES : []
  const config = await loadConfig().catch(() => null)
  return effectiveSources(adapters, config)
}

export function dueSources(sources, factor, now, force) {
  return sources.filter((source) => {
    if (!source || !source.id || source.enabled === false) return false
    if (force) return true
    const base = Math.max(60_000, Number(source.intervalMs) || 180_000)
    const last = lastRunAt.get(source.id) || 0
    return now - last >= base * factor
  })
}

/** 找到条目应并入的事件；找不到返回 null。touched 里的新簇也参与比较。 */
export function findCluster(item, pool) {
  const rule = CLUSTER_RULES[item.kind] || CLUSTER_RULES.flash
  let best = null
  let bestScore = 0
  for (const event of pool) {
    if (event.kind !== item.kind) continue
    if (Math.abs(event.lastTs - item.ts) > CLUSTER_WINDOW_MS) continue
    const sharedTicker = (item.tickers || []).some((code) => (event.tickers || []).includes(code))
    const sharedSector = (item.sectors || []).some((name) => (event.sectors || []).some((other) => sectorMatches(name, other)))
    const similarity = titleSimilarity(item.title, event.title)
    let qualifies =
      (sharedTicker && similarity >= rule.sharedMin) || similarity >= rule.similarityMin
    let summarySimilarity = 0
    if (!qualifies) {
      // 标题对不上时再看正文首段：同一事件不同写法的兜底（公告类 summary 多为空，自然是 0）。
      const left = String(item.summary || '').slice(0, SUMMARY_CHARS)
      const right = String(event.summary || '').slice(0, SUMMARY_CHARS)
      if (left.length >= 20 && right.length >= 20) {
        summarySimilarity = jaccard(trigrams(left), trigrams(right))
        qualifies =
          summarySimilarity >= SUMMARY_SIM_MIN &&
          (sharedTicker || sharedSector || similarity >= 0.3)
      }
    }
    if (!qualifies) continue
    // 事件类型不同（例如「涨停」与「被处罚」）时只在字面高度重合时才合并。
    if (
      item.eventType &&
      event.eventType &&
      item.eventType !== event.eventType &&
      similarity < CROSS_TYPE_MIN
    ) {
      continue
    }
    const score = (sharedTicker ? 1 + similarity : similarity) + summarySimilarity * 0.5
    if (score > bestScore) {
      bestScore = score
      best = event
    }
  }
  return best
}

/** 用簇内条目重算事件的可展示字段。 */
function rebuildEvent(event, items) {
  const ordered = items.slice().sort((a, b) => a.ts - b.ts)
  const head = ordered[0]
  const seen = new Set()
  const sources = []
  for (const item of ordered) {
    const key = `${item.source}|${item.url}`
    if (seen.has(key)) continue
    seen.add(key)
    sources.push({
      source: item.source,
      label: item.sourceLabel,
      title: item.title,
      url: item.url,
      ts: item.ts,
    })
    if (sources.length >= 8) break
  }
  const merged = mergeTags(ordered)
  return {
    ...event,
    ts: head.ts,
    lastTs: ordered[ordered.length - 1].ts,
    title: head.title,
    summary: head.summary || (ordered[1] ? ordered[1].summary : '') || '',
    url: head.url || '',
    kind: head.kind,
    sourceCount: new Set(ordered.map((item) => item.source)).size,
    sources,
    tickers: merged.tickers,
    sectors: merged.sectors,
    eventType: merged.eventType,
    importance: Math.max(merged.importance, Number(event.importance) || 0),
  }
}

/**
 * 跑一轮入站。并发调用会复用同一轮（single-flight）。
 * @returns {Promise<{ok:boolean, ingested:number, elapsedMs:number, phase:string,
 *   sources:Array<{id:string,ok:boolean,count:number,error:string}>}>}
 */
export async function runIngest({ force = false, sources: injected = null, now = Date.now(), log = () => {} } = {}) {
  if (inFlight) {
    log('已有同步在跑，复用本轮结果')
    return inFlight
  }
  inFlight = (async () => {
    const startedAt = Date.now()
    const phase = phaseNow(now)
    const factor = phaseFactor(phase)
    openStore()
    const sources = Array.isArray(injected) && injected.length > 0 ? injected : await loadSourceList()
    const due = dueSources(sources, factor, now, force)
    const dict = await loadDictionary()
    const members = await reverseIndex().catch(() => new Map())
    const report = []
    const fresh = []

    for (const source of due) {
      const sourceStart = Date.now()
      try {
        const raw = await Promise.race([
          Promise.resolve().then(() => source.fetch()),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`抓取超时 ${SOURCE_TIMEOUT_MS / 1000}s`)), SOURCE_TIMEOUT_MS),
          ),
        ])
        const list = Array.isArray(raw) ? raw : []
        let accepted = 0
        for (const entry of list) {
          const item = makeItem(entry, source)
          if (!item) continue
          const tagged = tagItem(item, dict)
          // 成分股映射：只补已缓存板块，补不到不影响任何东西（P2 前就是关键词口径）。
          if (members.size > 0) {
            for (const code of tagged.tickers.slice(0, 4)) {
              for (const name of members.get(code) || []) {
                if (!tagged.sectors.includes(name)) tagged.sectors.push(name)
              }
            }
            tagged.sectors = tagged.sectors.slice(0, 6)
          }
          fresh.push(tagged)
          accepted += 1
        }
        lastRunAt.set(source.id, Date.now())
        recordSourceRun(source.id, source.label, { ok: true, count: accepted, at: Date.now() })
        report.push({ id: source.id, ok: true, count: accepted, error: '', elapsedMs: Date.now() - sourceStart })
        // 只在真有新内容时留痕：盘后每轮 11 个源都打一行会把宿主日志刷满。
        if (accepted > 0) log(`${source.label || source.id}: ${accepted} 条`)
      } catch (error) {
        const reason = error && error.message ? error.message : String(error)
        lastRunAt.set(source.id, Date.now())
        recordSourceRun(source.id, source.label, { ok: false, error: reason, at: Date.now() })
        report.push({ id: source.id, ok: false, count: 0, error: reason, elapsedMs: Date.now() - sourceStart })
        log(`${source.label || source.id} 失败：${reason}`)
      }
    }

    const { inserted, ids } = insertItems(fresh, Date.now())
    const newItems = fresh.filter((item) => ids.includes(item.id))

    // 聚簇：先按 kind 取候选事件池，新簇就地入库参与后续比较。
    const pools = new Map()
    const touched = new Map()
    const span = (kind) => {
      const list = fresh.filter((item) => item.kind === kind).map((item) => item.ts)
      if (list.length === 0) return null
      return { from: Math.min(...list) - CLUSTER_WINDOW_MS, to: Math.max(...list) + CLUSTER_WINDOW_MS }
    }
    const poolOf = (kind) => {
      if (!pools.has(kind)) {
        const range = span(kind) || { from: now - 24 * 60 * 60 * 1000, to: now }
        pools.set(kind, candidateEvents(kind, range.from, range.to))
      }
      return pools.get(kind)
    }
    for (const item of newItems.sort((a, b) => a.ts - b.ts)) {
      const pool = poolOf(item.kind)
      const hit = findCluster(item, pool)
      if (hit) {
        // 首次命中时把簇内已有条目读回来，否则 rebuild 只看到本轮新条目，会丢旧来源。
        const bag = touched.get(hit.id) || { event: hit, items: (getEvent(hit.id) || {}).items || [] }
        bag.items.push(item)
        touched.set(hit.id, bag)
        hit.lastTs = Math.max(hit.lastTs, item.ts)
      } else {
        const event = {
          id: `ev-${item.id}`,
          ts: item.ts,
          lastTs: item.ts,
          title: item.title,
          summary: item.summary,
          url: item.url,
          kind: item.kind,
          sourceCount: 1,
          sources: [{ source: item.source, label: item.sourceLabel, title: item.title, url: item.url, ts: item.ts }],
          tickers: item.tickers,
          sectors: item.sectors,
          eventType: item.eventType,
          importance: item.importance,
        }
        pool.push(event)
        touched.set(event.id, { event, items: [item] })
      }
    }

    for (const [eventId, bag] of touched) {
      const merged = rebuildEvent(bag.event, bag.items)
      upsertEvent(merged)
      linkEventItems(eventId, bag.items.map((item) => item.id))
      bag.event = merged
    }

    const dayStart = beijingDayStart(now)
    metaSet('lastIngestAt', new Date().toISOString())
    metaSet('lastIngestNew', String(inserted))
    metaSet('dayStart', String(dayStart))
    if (now - lastPruneAt > 60 * 60 * 1000) {
      lastPruneAt = now
      try {
        prune(30, now)
      } catch (error) {
        log(`清理过期数据失败：${error && error.message ? error.message : error}`)
      }
    }

    return {
      ok: true,
      ingested: inserted,
      elapsedMs: Date.now() - startedAt,
      phase,
      sources: report,
    }
  })()
  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

/** 调度器：每 30 秒 tick 一次，实际抓取由各源到期时间决定。 */
export function startScheduler({ log = () => {}, onRound = null } = {}) {
  const tick = async () => {
    try {
      const result = await runIngest({ log })
      if (result.ingested > 0) log(`本轮新增 ${result.ingested} 条（${result.phase}）`)
      if (onRound) onRound(result)
    } catch (error) {
      log(`同步失败：${error && error.message ? error.message : error}`)
    }
  }
  const timer = setInterval(tick, 30_000)
  // 顺带把面板请求过、但还没抓到成分股的板块补上（每 30 秒最多 3 个，串行 1.2s 间隔）。
  const pump = setInterval(() => {
    pumpQueue().catch(() => {})
  }, 30_000)
  if (typeof pump.unref === 'function') pump.unref()
  if (typeof timer.unref === 'function') timer.unref()
  const kickoff = setTimeout(tick, 4_000)
  if (typeof kickoff.unref === 'function') kickoff.unref()
  return () => {
    clearInterval(timer)
    clearInterval(pump)
    clearTimeout(kickoff)
  }
}

/**
 * 按当前规则回填最近 N 天的打标结果。
 *
 * 为什么需要：打标规则（事件类型表、重要度权重、降权词）会随使用迭代，而条目只在
 * 入库那一刻打过一次标。没有回填的话，改完规则只有新条目生效，面板上旧事件的分数
 * 仍是老口径，用户会以为规则没生效。
 *
 * 只重算标签与分数，不改正文、不改聚簇归属（聚簇是历史事实，重跑反而会让事件 id 漂移）。
 */
export async function rescoreRecent(days = 3, now = Date.now(), log = () => {}) {
  const since = now - Math.max(1, days) * 24 * 60 * 60 * 1000
  const dict = await loadDictionary(true)
  const items = recentItems(since)
  if (items.length === 0) return { items: 0, events: 0 }
  const retagged = items.map((item) => tagItem(item, dict))
  updateItemTags(retagged)

  const events = recentEvents(since)
  // 用**刚重算过的**条目参与合并，否则从库里读出来的条目没有 importanceParts，
  // 事件的重要度拆解会被覆盖成空对象。
  const retaggedById = new Map(retagged.map((item) => [item.id, item]))
  let touched = 0
  for (const event of events) {
    const members = Array.isArray(event.items) && event.items.length > 0
      ? event.items.map((item) => retaggedById.get(item.id) || item)
      : [event]
    const merged = mergeTags(members)
    // 无条件回写：即使分数没变，也要把 importanceParts（重要度拆解）补齐，
    // 否则老事件面板上只能显示一个总分、看不到「为什么高」。
    const changed =
      merged.eventType !== event.eventType ||
      merged.importance !== event.importance ||
      merged.tickers.length !== (event.tickers || []).length ||
      JSON.stringify(merged.importanceParts) !== JSON.stringify(event.importanceParts || {})
    updateEventTags({ ...event, ...merged })
    if (changed) touched += 1
  }
  log(`规则回填：${retagged.length} 条条目、${touched} 个事件重算`)
  return { items: retagged.length, events: touched }
}
