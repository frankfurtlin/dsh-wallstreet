/**
 * lib/hub/store.js —— 存储层单测（真的开 SQLite，但只开临时库）
 *
 * 路径在 import 之前用 DSH_WALLSTREET_DATA / DSH_WALLSTREET_HUB_DB 指到 mkdtemp 目录，
 * 绝不碰插件真实的 data/hub.db。每个用例前清空数据表，用例之间互不影响。
 */
import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'dsh-wallstreet-store-'))
process.env.DSH_WALLSTREET_DATA = DIR
process.env.DSH_WALLSTREET_HUB_DB = join(DIR, 'hub.db')

const store = await import('../lib/hub/store.js')

const db = store.openStore()
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** 固定参考时刻：2025-05-12 12:00 北京时间（远早于真实 now，排序不受时钟影响）。 */
const REF = Date.UTC(2025, 4, 12, 4, 0, 0)
const BEIJING_MIDNIGHT = Date.UTC(2025, 4, 11, 16, 0, 0)

after(() => {
  store.closeStore()
  rmSync(DIR, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec(`
    DELETE FROM items;
    DELETE FROM events;
    DELETE FROM event_items;
    DELETE FROM source_state;
    DELETE FROM meta;
  `)
})

let seq = 0
const mkEvent = (over = {}) => ({
  id: `ev-${++seq}`,
  ts: REF,
  lastTs: REF,
  title: `事件${seq}`,
  summary: '',
  url: '',
  kind: 'flash',
  sourceCount: 1,
  sources: [],
  tickers: [],
  sectors: [],
  eventType: '',
  importance: 50,
  ...over,
})

const mkItem = (over = {}) => ({
  id: `it-${++seq}`,
  ts: REF,
  source: 'src-a',
  sourceLabel: '源A',
  kind: 'flash',
  title: `条目${seq}`,
  summary: '',
  url: 'https://example.com/item',
  tickers: [],
  sectors: [],
  eventType: '',
  importance: 10,
  degraded: false,
  ...over,
})

const setCreatedAt = (id, at) => {
  db.prepare('UPDATE events SET created_at = ? WHERE id = ?').run(Number(at), String(id))
}

/* ------------------------------ insertItems ------------------------------ */

test('insertItems：插入新条目并返回 id，stats 计数跟着涨', () => {
  const result = store.insertItems([mkItem({ id: 'i1' }), mkItem({ id: 'i2' })], REF)
  assert.equal(result.inserted, 2)
  assert.deepEqual(result.ids, ['i1', 'i2'])
  assert.equal(store.stats().items, 2)
})

test('insertItems：同一条重复插入按主键去重，第二次不再计新', () => {
  const item = mkItem({ id: 'dup', title: '同一条' })
  assert.equal(store.insertItems([item], REF).inserted, 1)
  const second = store.insertItems([{ ...item, title: '改了标题' }], REF)
  assert.equal(second.inserted, 0)
  assert.deepEqual(second.ids, [])
  assert.equal(store.stats().items, 1)
})

test('insertItems：一批里部分重复时只返回真正新插入的 id', () => {
  store.insertItems([mkItem({ id: 'old' })], REF)
  const result = store.insertItems([mkItem({ id: 'old' }), mkItem({ id: 'new' })], REF)
  assert.deepEqual(result.ids, ['new'])
  assert.equal(result.inserted, 1)
})

test('insertItems：空数组与缺 id 的条目直接跳过', () => {
  assert.deepEqual(store.insertItems([], REF), { inserted: 0, ids: [] })
  const result = store.insertItems([null, { title: '没有 id' }], REF)
  assert.deepEqual(result, { inserted: 0, ids: [] })
  assert.equal(store.stats().items, 0)
})

test('insertItems：字段归一（分数夹紧、ts 缺省用 now、degraded 布尔、ts/数组往返）', () => {
  store.insertItems([
    mkItem({ id: 'norm', importance: 250, ts: 0, degraded: true, tickers: ['600519'], sectors: ['半导体'] }),
  ], REF)
  const [row] = store.getItems(['norm'])
  assert.equal(row.importance, 100, 'importance 应夹到 100')
  assert.equal(row.ts, REF, 'ts 缺失时用传入的 now')
  assert.equal(row.degraded, true)
  assert.deepEqual(row.tickers, ['600519'])
  assert.deepEqual(row.sectors, ['半导体'])
  assert.equal(row.sourceLabel, '源A')
})

/* ------------------------------ queryFeed ------------------------------ */

const seedFeed = () => {
  store.upsertEvent(mkEvent({
    id: 'flash-late',
    title: '央行开展MLF操作',
    summary: '保持流动性合理充裕',
    lastTs: REF,
    ts: REF,
    tickers: ['600519'],
    sectors: ['半导体'],
    eventType: '货币政策',
    importance: 60,
    sources: [{ source: 'src-a', label: '源A', title: 'x', url: 'u', ts: REF }],
  }))
  store.upsertEvent(mkEvent({
    id: 'flash-mid',
    title: '某公司发布中标公告',
    lastTs: REF - HOUR,
    ts: REF - HOUR,
    tickers: ['000001'],
    sectors: ['银行'],
    eventType: '中标合同',
    importance: 30,
    kind: 'flash',
  }))
  store.upsertEvent(mkEvent({
    id: 'ann-early',
    title: '年度利润分配预案',
    lastTs: REF - 2 * HOUR,
    ts: REF - 2 * HOUR,
    tickers: ['600519'],
    sectors: ['白酒'],
    eventType: '分红送转',
    importance: 80,
    kind: 'announcement',
  }))
}

test('queryFeed：无过滤返回全部，按 MIN(last_ts, created_at) 倒序，total 与条数一致', () => {
  seedFeed()
  const { events, total } = store.queryFeed()
  assert.equal(total, 3)
  assert.deepEqual(events.map((event) => event.id), ['flash-late', 'flash-mid', 'ann-early'])
})

test('queryFeed：kind 过滤', () => {
  seedFeed()
  assert.deepEqual(store.queryFeed({ kind: 'announcement' }).events.map((e) => e.id), ['ann-early'])
  assert.equal(store.queryFeed({ kind: 'policy' }).total, 0)
})

test('queryFeed：eventType 过滤', () => {
  seedFeed()
  assert.deepEqual(store.queryFeed({ eventType: '货币政策' }).events.map((e) => e.id), ['flash-late'])
})

test('queryFeed：ticker 过滤是精确匹配（60051 不会命中 600519）', () => {
  seedFeed()
  assert.deepEqual(store.queryFeed({ ticker: '600519' }).events.map((e) => e.id).sort(), ['ann-early', 'flash-late'])
  assert.equal(store.queryFeed({ ticker: '60051' }).total, 0)
})

test('queryFeed：sector 按板块字段匹配', () => {
  seedFeed()
  assert.deepEqual(store.queryFeed({ sector: '半导体' }).events.map((e) => e.id), ['flash-late'])
  assert.equal(store.queryFeed({ sector: '水产养殖' }).total, 0)
})

test('queryFeed：sector + sectorVariants 能用跨源写法命中（芯片 → 半导体）', () => {
  seedFeed()
  const result = store.queryFeed({ sector: '芯片', sectorVariants: ['半导体', '芯片'] })
  assert.deepEqual(result.events.map((e) => e.id), ['flash-late'])
})

test('queryFeed：titleHints 命中标题；单字 hint 也生效（板块名可能只有一个字）', () => {
  seedFeed()
  assert.deepEqual(store.queryFeed({ titleHints: ['中标'] }).events.map((e) => e.id), ['flash-mid'])
  // 修之前单字 hint 会被长度过滤吞掉，导致这次筛选静默失效、返回全部事件。
  assert.equal(store.queryFeed({ titleHints: ['中'] }).total, 1)
  assert.equal(store.queryFeed({ titleHints: ['中'] }).events[0].id, 'flash-mid')
})

test('queryFeed：q 同时搜标题与摘要', () => {
  seedFeed()
  assert.deepEqual(store.queryFeed({ q: '中标' }).events.map((e) => e.id), ['flash-mid'])
  assert.deepEqual(store.queryFeed({ q: '流动性' }).events.map((e) => e.id), ['flash-late'])
  assert.equal(store.queryFeed({ q: '不存在的关键词xyz' }).total, 0)
})

test('queryFeed：minImportance 过滤', () => {
  seedFeed()
  assert.deepEqual(store.queryFeed({ minImportance: 65 }).events.map((e) => e.id), ['ann-early'])
  assert.equal(store.queryFeed({ minImportance: 81 }).total, 0)
})

test('queryFeed：since 排除窗口之前的普通事件，但纳入「同日日期级事件」', () => {
  store.upsertEvent(mkEvent({ id: 'after', title: '窗口后', lastTs: REF + HOUR, ts: REF + HOUR }))
  store.upsertEvent(mkEvent({ id: 'before', title: '窗口前', lastTs: REF - 3 * HOUR, ts: REF - 3 * HOUR }))
  // 巨潮沪市公告只有日期：落在北京时间 00:00 整
  store.upsertEvent(mkEvent({ id: 'date-level', title: '当日公告', lastTs: BEIJING_MIDNIGHT, ts: BEIJING_MIDNIGHT }))
  // 前一天的日期级事件不该被「同日兜底」捞进来
  store.upsertEvent(mkEvent({
    id: 'date-level-yesterday',
    title: '昨日公告',
    lastTs: BEIJING_MIDNIGHT - DAY,
    ts: BEIJING_MIDNIGHT - DAY,
  }))
  const { events } = store.queryFeed({ since: REF })
  assert.deepEqual(events.map((e) => e.id), ['after', 'date-level'])
})

test('queryFeed：日期级事件带 timeUnknown 标记，普通事件没有', () => {
  store.upsertEvent(mkEvent({ id: 'date-level', lastTs: BEIJING_MIDNIGHT, ts: BEIJING_MIDNIGHT }))
  store.upsertEvent(mkEvent({ id: 'timed', lastTs: REF, ts: REF }))
  const byId = Object.fromEntries(store.queryFeed().events.map((event) => [event.id, event]))
  assert.equal(byId['date-level'].timeUnknown, true)
  assert.equal(byId.timed.timeUnknown, false)
})

test('queryFeed：limit 生效，且 0/非法值回落到默认 50', () => {
  seedFeed()
  assert.equal(store.queryFeed({ limit: 2 }).events.length, 2)
  assert.equal(store.queryFeed({ limit: 0 }).events.length, 3)
  assert.equal(store.queryFeed({ limit: 'abc' }).events.length, 3)
})

test('queryFeed：source 过滤按 source_list 里的来源', () => {
  seedFeed()
  assert.deepEqual(store.queryFeed({ source: 'src-a' }).events.map((e) => e.id), ['flash-late'])
  assert.equal(store.queryFeed({ source: 'src-unknown' }).total, 0)
})

test('queryFeed：多个条件是 AND 关系', () => {
  seedFeed()
  const hit = store.queryFeed({ kind: 'flash', ticker: '600519', minImportance: 50, q: 'MLF' })
  assert.deepEqual(hit.events.map((e) => e.id), ['flash-late'])
  // 任一条件不满足就整体不成立
  assert.equal(store.queryFeed({ kind: 'announcement', ticker: '600519', q: 'MLF' }).total, 0)
})

/* ------------------------------ allEventsSince ------------------------------ */

test('allEventsSince：只取 last_ts >= since 的事件，并按时间倒序', () => {
  seedFeed()
  const events = store.allEventsSince(REF - HOUR)
  assert.deepEqual(events.map((e) => e.id), ['flash-late', 'flash-mid'])
  assert.equal(store.allEventsSince(REF + HOUR).length, 0)
})

/* ------------------------------ stats ------------------------------ */

test('stats：条目/事件计数、时间跨度、kind 与 eventType 分布', () => {
  seedFeed()
  store.insertItems([mkItem({ id: 'i1' }), mkItem({ id: 'i2', source: 'src-b' })], REF)
  const stats = store.stats()
  assert.equal(stats.items, 2)
  assert.equal(stats.events, 3)
  assert.deepEqual(stats.span, { first: REF - 2 * HOUR, last: REF })
  assert.deepEqual(stats.byKind, [
    { kind: 'flash', count: 2 },
    { kind: 'announcement', count: 1 },
  ])
  // event_type 为空的事件不进分布
  assert.deepEqual(
    new Set(stats.byEventType.map((row) => row.eventType)),
    new Set(['货币政策', '中标合同', '分红送转']),
  )
})

test('stats：bySource 反映源健康度（成功/失败次数与最近错误）', () => {
  store.insertItems([mkItem({ id: 'i1' }), mkItem({ id: 'i2' })], REF)
  store.insertItems([mkItem({ id: 'i3', source: 'src-b' })], REF)
  store.recordSourceRun('src-a', '源A', { ok: true, count: 2, at: REF })
  store.recordSourceRun('src-b', '源B', { ok: false, error: '上游 403', at: REF + 1 })

  const byId = Object.fromEntries(store.stats().bySource.map((row) => [row.id, row]))
  assert.equal(byId['src-a'].count, 2)
  assert.equal(byId['src-a'].lastOk, REF)
  assert.equal(byId['src-a'].lastError, '')
  assert.equal(byId['src-b'].lastError, '上游 403')
  assert.equal(byId['src-b'].lastErrorAt, REF + 1)
  assert.equal(byId['src-b'].lastOk, null)
  assert.equal(byId['src-b'].count, 1)
})

test('stats：lastIngestAt 来自 meta', () => {
  store.metaSet('lastIngestAt', '2026-11-25T00:00:00.000Z')
  assert.equal(store.stats().lastIngestAt, '2026-11-25T00:00:00.000Z')
  assert.equal(store.metaGet('lastIngestAt'), '2026-11-25T00:00:00.000Z')
})

/* ------------------------------ prune ------------------------------ */

test('prune：事件按 created_at 清理、条目按 ingested_at 清理', () => {
  store.upsertEvent(mkEvent({ id: 'old-event' }))
  store.upsertEvent(mkEvent({ id: 'fresh-event' }))
  setCreatedAt('old-event', REF - 40 * DAY)
  setCreatedAt('fresh-event', REF)

  store.insertItems([mkItem({ id: 'old-item' })], REF - 40 * DAY)
  store.insertItems([mkItem({ id: 'fresh-item' })], REF)

  const result = store.prune(30, REF)
  assert.deepEqual(result, { events: 1, items: 1 })
  const stats = store.stats()
  assert.equal(stats.events, 1)
  assert.equal(stats.items, 1)
  assert.deepEqual(store.queryFeed().events.map((e) => e.id), ['fresh-event'])
  assert.deepEqual(store.getItems(['fresh-item']).map((item) => item.id), ['fresh-item'])
})

test('prune：删除事件时连带清掉 event_items 关联', () => {
  store.upsertEvent(mkEvent({ id: 'old-event' }))
  setCreatedAt('old-event', REF - 40 * DAY)
  store.insertItems([mkItem({ id: 'old-item' })], REF)
  store.linkEventItems('old-event', ['old-item'])

  store.prune(30, REF)
  const links = db.prepare('SELECT * FROM event_items').all()
  assert.deepEqual(links, [])
})

test('prune：days 小于 1 时按 1 天算（不传 0 就清空全库）', () => {
  store.upsertEvent(mkEvent({ id: 'h12', lastTs: REF - 12 * HOUR }))
  store.upsertEvent(mkEvent({ id: 'd2', lastTs: REF - 2 * DAY }))
  setCreatedAt('h12', REF - 12 * HOUR)
  setCreatedAt('d2', REF - 2 * DAY)
  const result = store.prune(0, REF)
  assert.deepEqual(result, { events: 1, items: 0 })
  assert.deepEqual(store.queryFeed().events.map((e) => e.id), ['h12'])
})

/* ------------------------------ LLM 摘要 ------------------------------ */

test('pendingSummaryEvents：只挑分数够高、还没有摘要的事件，按重要度倒序', () => {
  store.upsertEvent(mkEvent({ id: 'low', importance: 20 }))
  store.upsertEvent(mkEvent({ id: 'mid', importance: 70 }))
  store.upsertEvent(mkEvent({ id: 'high', importance: 90 }))
  const ids = store.pendingSummaryEvents({ minImportance: 1, sinceTs: 0, limit: 10 }).map((e) => e.id)
  assert.deepEqual(ids, ['high', 'mid', 'low'])
})

test('pendingSummaryEvents：已有摘要的事件不再入选', () => {
  store.upsertEvent(mkEvent({ id: 'done', importance: 90 }))
  store.upsertEvent(mkEvent({ id: 'todo', importance: 80 }))
  store.saveEventSummary('done', { summary: '已经总结过了', sentiment: '利好', model: 'm/m', at: REF })
  assert.deepEqual(store.pendingSummaryEvents({ minImportance: 1, sinceTs: 0, limit: 10 }).map((e) => e.id), ['todo'])
})

test('pendingSummaryEvents：默认阈值 70、默认条数 3、limit 上限 20', () => {
  const ids = new Set()
  for (let i = 0; i < 25; i += 1) {
    const id = `e${i}`
    ids.add(id)
    store.upsertEvent(mkEvent({ id, importance: 95 - i % 5 }))
  }
  store.upsertEvent(mkEvent({ id: 'below', importance: 69 }))
  assert.equal(store.pendingSummaryEvents({ sinceTs: 0 }).length, 3, '默认每轮 3 条')
  assert.equal(store.pendingSummaryEvents({ sinceTs: 0, limit: 0 }).length, 3)
  assert.equal(store.pendingSummaryEvents({ sinceTs: 0, limit: 100 }).length, 20, 'limit 上限 20')
  const picked = store.pendingSummaryEvents({ sinceTs: 0, limit: 20 })
  assert.ok(picked.every((event) => ids.has(event.id)), '69 分的事件低于默认阈值，不该入选')
  assert.ok(!picked.some((event) => event.id === 'below'))
})

test('pendingSummaryEvents：sinceTs 按 created_at 限窗口（太老的不再花 token）', () => {
  store.upsertEvent(mkEvent({ id: 'e', importance: 90 }))
  assert.equal(store.pendingSummaryEvents({ minImportance: 1, sinceTs: 0 }).length, 1)
  assert.equal(store.pendingSummaryEvents({ minImportance: 1, sinceTs: Date.now() + 60_000 }).length, 0)
})

test('saveEventSummary：幂等覆盖，字段按长度截断', () => {
  store.upsertEvent(mkEvent({ id: 'e', importance: 90 }))
  store.saveEventSummary('e', { summary: '第一版摘要', sentiment: '利好', model: 'p/m', at: REF })
  const first = store.getEvent('e').llm
  assert.equal(first.summary, '第一版摘要')
  assert.equal(first.sentiment, '利好')
  assert.equal(first.at, REF)

  store.saveEventSummary('e', {
    summary: '第'.repeat(500),
    sentiment: '利空'.repeat(30),
    model: 'm'.repeat(200),
    at: REF + 1,
  })
  const second = store.getEvent('e').llm
  assert.equal(second.summary.length, 400)
  assert.equal(second.sentiment.length, 20)
  assert.equal(second.model.length, 80)
  assert.equal(second.at, REF + 1)
})

test('saveEventSummary：事件不存在时不抛错也不新增行', () => {
  assert.doesNotThrow(() => store.saveEventSummary('missing', { summary: 'x' }))
  assert.equal(store.stats().events, 0)
})

test('summaryCoverage：统计总事件数与已摘要数', () => {
  store.upsertEvent(mkEvent({ id: 'a', importance: 90 }))
  store.upsertEvent(mkEvent({ id: 'b', importance: 80 }))
  store.upsertEvent(mkEvent({ id: 'c', importance: 70 }))
  assert.deepEqual(store.summaryCoverage(), { total: 3, summarized: 0 })
  store.saveEventSummary('a', { summary: '甲', at: REF })
  store.saveEventSummary('c', { summary: '丙', at: REF })
  assert.deepEqual(store.summaryCoverage(), { total: 3, summarized: 2 })
})

/* ------------------------------ events 读写 ------------------------------ */

test('getEvent：返回事件本体 + 簇内条目（按条目时间升序），不存在返回 null', () => {
  store.upsertEvent(mkEvent({ id: 'ev', title: '聚合事件', sourceCount: 2, importance: 66 }))
  store.insertItems([
    mkItem({ id: 'late', ts: REF + HOUR, title: '晚到的' }),
    mkItem({ id: 'early', ts: REF - HOUR, title: '早到的' }),
  ], REF)
  store.linkEventItems('ev', ['late', 'early'])

  const event = store.getEvent('ev')
  assert.equal(event.title, '聚合事件')
  assert.equal(event.importance, 66)
  assert.equal(event.sourceCount, 2)
  assert.deepEqual(event.items.map((item) => item.id), ['early', 'late'])
  assert.equal(store.getEvent('nope'), null)
})

test('upsertEvent：同一 id 覆盖式更新，但不会丢掉已经写好的 llm 摘要', () => {
  store.upsertEvent(mkEvent({ id: 'ev', title: '旧标题', importance: 40 }))
  store.saveEventSummary('ev', { summary: '已经生成的摘要', sentiment: '利好', model: 'p/m', at: REF })
  store.upsertEvent(mkEvent({ id: 'ev', title: '新标题', importance: 88 }))

  const event = store.getEvent('ev')
  assert.equal(event.title, '新标题')
  assert.equal(event.importance, 88)
  assert.equal(event.llm.summary, '已经生成的摘要')
  assert.equal(store.stats().events, 1)
})

test('upsertEvent：importance 夹到 0–100、sourceCount 下限 1', () => {
  store.upsertEvent(mkEvent({ id: 'hi', importance: 150 }))
  store.upsertEvent(mkEvent({ id: 'lo', importance: -20, sourceCount: 0 }))
  const byId = Object.fromEntries(store.queryFeed().events.map((event) => [event.id, event]))
  assert.equal(byId.hi.importance, 100)
  assert.equal(byId.lo.importance, 0)
  assert.equal(byId.lo.sourceCount, 1)
})
