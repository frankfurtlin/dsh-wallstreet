/**
 * dsh-wallstreet —— 信息资讯集散中心 · 存储层
 *
 * 用 Node 24 内置的 `node:sqlite`（`DatabaseSync`），**零第三方依赖**，
 * 单文件 `data/hub.db`，WAL 模式。选 SQLite 而不是 JSONL 的原因：
 *  - 按事件时间 / ticker / 标签筛选要能走索引，不想每次全量读盘；
 *  - `INSERT OR IGNORE` 天然按主键去重，重复抓取不会撑大表；
 *  - 面板、agent tool、快照回填三个读者共享同一份数据，不各读各的 JSON。
 *
 * 契约见 docs/info-hub.md §2/§5/§6。路径可用环境变量覆盖，验收脚本指到临时库。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 数据目录：默认插件内 data/，可用 DSH_WALLSTREET_DATA 重定向。 */
export const DATA_DIR = process.env.DSH_WALLSTREET_DATA || join(PLUGIN_ROOT, 'data')

/** 库文件：验收脚本用 DSH_WALLSTREET_HUB_DB 指到临时文件，不污染正式库。 */
export const DB_PATH = process.env.DSH_WALLSTREET_HUB_DB || join(DATA_DIR, 'hub.db')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_label TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'flash',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  tickers TEXT NOT NULL DEFAULT '[]',
  sectors TEXT NOT NULL DEFAULT '[]',
  event_type TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  ingested_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_ts ON items(ts DESC);
CREATE INDEX IF NOT EXISTS items_source ON items(source, ts DESC);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'flash',
  source_count INTEGER NOT NULL DEFAULT 1,
  source_list TEXT NOT NULL DEFAULT '[]',
  tickers TEXT NOT NULL DEFAULT '[]',
  sectors TEXT NOT NULL DEFAULT '[]',
  event_type TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 0,
  importance_parts TEXT NOT NULL DEFAULT '{}',
  llm_summary TEXT NOT NULL DEFAULT '',
  llm_sentiment TEXT NOT NULL DEFAULT '',
  llm_model TEXT NOT NULL DEFAULT '',
  llm_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, last_ts);
CREATE TABLE IF NOT EXISTS event_items (
  event_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (event_id, item_id)
);
CREATE INDEX IF NOT EXISTS event_items_item ON event_items(item_id);
CREATE TABLE IF NOT EXISTS source_state (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  last_ok INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  last_error_at INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`

let db = null

/** 打开（或复用）单例数据库。首次调用建表。 */
export function openStore() {
  if (db) return db
  mkdirSync(DATA_DIR, { recursive: true })
  db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 3000')
  // WAL 自动回收上限：批量入库后不设上限会一路涨到几十 MB（实测一轮 4 MB）。
  db.exec('PRAGMA journal_size_limit = 8388608')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/**
 * 轻量迁移：早期版本把事件的 created_at 写成了发布时间，导致「按入库时间清理/回填」
 * 看不到政策类旧文档。schemaVersion 提升到 2 时把历史行回填成簇内最早的条目入库时间。
 */
function migrate(store) {
  const row = store.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()
  const current = row && row.value ? Number(row.value) : 0
  if (current >= 3) return
  // v3：重要度拆解 + LLM 摘要（老库需要补列）
  const columns = new Set(
    store.prepare('PRAGMA table_info(events)').all().map((column) => String(column.name)),
  )
  for (const [name, ddl] of [
    ['importance_parts', "ALTER TABLE events ADD COLUMN importance_parts TEXT NOT NULL DEFAULT '{}'"],
    ['llm_summary', "ALTER TABLE events ADD COLUMN llm_summary TEXT NOT NULL DEFAULT ''"],
    ['llm_sentiment', "ALTER TABLE events ADD COLUMN llm_sentiment TEXT NOT NULL DEFAULT ''"],
    ['llm_model', "ALTER TABLE events ADD COLUMN llm_model TEXT NOT NULL DEFAULT ''"],
    ['llm_at', 'ALTER TABLE events ADD COLUMN llm_at INTEGER'],
  ]) {
    if (!columns.has(name)) store.exec(ddl)
  }
  if (current >= 2) {
    store
      .prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', '3') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run()
    return
  }
  store.exec(`UPDATE events SET created_at = COALESCE(
      (SELECT MAX(i.ingested_at) FROM event_items ei JOIN items i ON i.id = ei.item_id WHERE ei.event_id = events.id),
      created_at)`)
  store
    .prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', '3') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run()
}

/** 关闭库（测试与进程退出用）。 */
export function closeStore() {
  if (!db) return
  try {
    db.close()
  } finally {
    db = null
  }
}

export function isOpen() {
  return db !== null
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
/** 北京时间 00:00 整 → epoch 取模（ms）。用来识别「只有日期」的事件。 */
const BEIJING_MIDNIGHT_MOD = (86400000 - BEIJING_OFFSET_MS + 86400000) % 86400000

const json = (value) => JSON.stringify(value || [])
const parseJson = (text, fallback = []) => {
  try {
    const parsed = JSON.parse(text || '[]')
    return parsed == null ? fallback : parsed
  } catch {
    return fallback
  }
}

/**
 * 批量写入条目。按主键去重，只返回**真正新插入**的 id 列表
 * （聚簇只需要处理新条目）。
 */
export function insertItems(items, now = Date.now()) {
  const rows = Array.isArray(items) ? items : []
  const ids = []
  if (rows.length === 0) return { inserted: 0, ids }
  const store = openStore()
  const stmt = store.prepare(
    `INSERT OR IGNORE INTO items
      (id, ts, source, source_label, kind, title, summary, url, tickers, sectors, event_type, importance, degraded, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  store.exec('BEGIN')
  try {
    for (const item of rows) {
      if (!item || !item.id) continue
      const result = stmt.run(
        String(item.id),
        Number(item.ts) || now,
        String(item.source || ''),
        String(item.sourceLabel || ''),
        String(item.kind || 'flash'),
        String(item.title || ''),
        String(item.summary || ''),
        String(item.url || ''),
        json(item.tickers),
        json(item.sectors),
        String(item.eventType || ''),
        Math.max(0, Math.min(100, Math.round(Number(item.importance) || 0))),
        item.degraded ? 1 : 0,
        now,
      )
      if (result.changes > 0) ids.push(String(item.id))
    }
    store.exec('COMMIT')
  } catch (error) {
    store.exec('ROLLBACK')
    throw error
  }
  try {
    // 先 TRUNCATE 收缩 WAL；有读者占用时退化成 PASSIVE，不让入库失败。
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    try {
      db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    } catch {
      /* 忽略：下一轮还会尝试 */
    }
  }
  return { inserted: ids.length, ids }
}

/** 读一批条目（按 id）。聚簇时用来回看条目详情。 */
export function getItems(ids) {
  const list = Array.isArray(ids) ? ids : []
  if (list.length === 0) return []
  const store = openStore()
  const stmt = store.prepare(
    `SELECT id, ts, source, source_label AS sourceLabel, kind, title, summary, url,
            tickers, sectors, event_type AS eventType, importance, degraded
       FROM items WHERE id = ?`,
  )
  const out = []
  for (const id of list) {
    const row = stmt.get(String(id))
    if (row) out.push(decodeItem(row))
  }
  return out
}

function decodeItem(row) {
  return {
    id: row.id,
    ts: Number(row.ts),
    source: row.source,
    sourceLabel: row.sourceLabel,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    url: row.url,
    tickers: parseJson(row.tickers),
    sectors: parseJson(row.sectors),
    eventType: row.eventType || '',
    importance: Number(row.importance) || 0,
    degraded: Number(row.degraded) === 1,
  }
}

function decodeEvent(row) {
  return {
    id: row.id,
    ts: Number(row.ts),
    lastTs: Number(row.last_ts),
    title: row.title,
    summary: row.summary || '',
    url: row.url || '',
    kind: row.kind || 'flash',
    sourceCount: Number(row.source_count) || 1,
    sources: parseJson(row.source_list),
    tickers: parseJson(row.tickers),
    sectors: parseJson(row.sectors),
    eventType: row.event_type || '',
    importance: Number(row.importance) || 0,
    // 上游只给日期（巨潮沪市）的事件：面板显示「当日」而不是 00:00。
    timeUnknown: Number(row.last_ts) % 86400000 === BEIJING_MIDNIGHT_MOD,
    // 首次收进来的时间：日报归日要用它给「次日披露日」的盘后公告归到当天。
    createdAt: Number(row.created_at) || Number(row.last_ts) || 0,
    importanceParts: (() => {
      try {
        return JSON.parse(row.importance_parts || '{}')
      } catch {
        return {}
      }
    })(),
    llm: row.llm_summary
      ? { summary: row.llm_summary, sentiment: row.llm_sentiment || '', model: row.llm_model || '', at: Number(row.llm_at) || 0 }
      : null,
  }
}

const EVENT_COLUMNS = `id, ts, last_ts, title, summary, url, kind, source_count, source_list,
                       tickers, sectors, event_type, importance, importance_parts,
                       llm_summary, llm_sentiment, llm_model, llm_at, created_at`

/** 写入一个事件（覆盖式：聚簇结果以最后一次计算为准）。 */
export function upsertEvent(event) {
  if (!event || !event.id) return
  const store = openStore()
  store
    .prepare(
      `INSERT INTO events (${EVENT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_ts = excluded.last_ts,
         title = excluded.title,
         summary = excluded.summary,
         url = excluded.url,
         kind = excluded.kind,
         source_count = excluded.source_count,
         source_list = excluded.source_list,
         tickers = excluded.tickers,
         sectors = excluded.sectors,
         event_type = excluded.event_type,
         importance = excluded.importance,
         importance_parts = excluded.importance_parts,
         llm_summary = CASE WHEN excluded.llm_summary <> '' THEN excluded.llm_summary ELSE events.llm_summary END,
         llm_sentiment = CASE WHEN excluded.llm_summary <> '' THEN excluded.llm_sentiment ELSE events.llm_sentiment END,
         llm_model = CASE WHEN excluded.llm_summary <> '' THEN excluded.llm_model ELSE events.llm_model END,
         llm_at = CASE WHEN excluded.llm_summary <> '' THEN excluded.llm_at ELSE events.llm_at END`,
    )
    .run(
      String(event.id),
      Number(event.ts) || Date.now(),
      Number(event.lastTs) || Number(event.ts) || Date.now(),
      String(event.title || ''),
      String(event.summary || ''),
      String(event.url || ''),
      String(event.kind || 'flash'),
      Math.max(1, Number(event.sourceCount) || 1),
      json(event.sources),
      json(event.tickers),
      json(event.sectors),
      String(event.eventType || ''),
      Math.max(0, Math.min(100, Math.round(Number(event.importance) || 0))),
      json(event.importanceParts || {}),
      String((event.llm && event.llm.summary) || ''),
      String((event.llm && event.llm.sentiment) || ''),
      String((event.llm && event.llm.model) || ''),
      event.llm && event.llm.at ? Number(event.llm.at) : null,
      // created_at 是「这条事件什么时候被收进来」，不是发布时间：清理与规则回填都按它算。
      Date.now(),
    )
}

/** 把条目挂到事件下（幂等）。 */
export function linkEventItems(eventIdValue, itemIds) {
  const store = openStore()
  const stmt = store.prepare('INSERT OR IGNORE INTO event_items (event_id, item_id) VALUES (?, ?)')
  for (const itemId of itemIds) stmt.run(String(eventIdValue), String(itemId))
}

/** 时间窗内、同 kind 的候选事件（聚簇比较用）。 */
export function candidateEvents(kind, fromTs, toTs) {
  const store = openStore()
  return store
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM events
        WHERE kind = ? AND last_ts >= ? AND last_ts <= ?
        ORDER BY last_ts DESC LIMIT 400`,
    )
    .all(String(kind), Number(fromTs), Number(toTs))
    .map(decodeEvent)
}

/** 事件详情（含簇内条目），tool 与面板展开用。 */
export function getEvent(id) {
  const store = openStore()
  const row = store.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`).get(String(id))
  if (!row) return null
  const event = decodeEvent(row)
  event.items = store
    .prepare(
      `SELECT i.id, i.ts, i.source, i.source_label AS sourceLabel, i.kind, i.title, i.summary, i.url,
              i.tickers, i.sectors, i.event_type AS eventType, i.importance, i.degraded
         FROM event_items ei JOIN items i ON i.id = ei.item_id
        WHERE ei.event_id = ? ORDER BY i.ts ASC LIMIT 40`,
    )
    .all(String(id))
    .map(decodeItem)
  return event
}

/** 按条件查事件流。字段都走索引或 LIKE，limit 上限 200。 */
export function queryFeed(options = {}) {
  const store = openStore()
  const where = []
  const params = []
  const since = Number(options.since)
  if (Number.isFinite(since) && since > 0) {
    // 巨潮沪市公告只有日期没有时分（落到北京时间 00:00 整）。这类事件按时刻比较会
    // 被「近 3 小时」之类的窗口漏掉，所以同日（或之后）的日期级事件一并纳入。
    const beijingMidnightOfSince = Math.floor((since + BEIJING_OFFSET_MS) / 86400000) * 86400000 - BEIJING_OFFSET_MS
    where.push('(last_ts >= ? OR (last_ts % 86400000 = ? AND last_ts >= ?))')
    params.push(since, BEIJING_MIDNIGHT_MOD, beijingMidnightOfSince)
  }
  if (options.kind) {
    where.push('kind = ?')
    params.push(String(options.kind))
  }
  if (options.eventType) {
    where.push('event_type = ?')
    params.push(String(options.eventType))
  }
  if (options.minImportance) {
    where.push('importance >= ?')
    params.push(Number(options.minImportance))
  }
  if (options.ticker) {
    where.push('tickers LIKE ?')
    params.push(`%"${String(options.ticker).trim()}"%`)
  }
  // 板块筛选：板块名跨源写法不一致（「酒店旅游」vs「旅游」、东财细分行业名 vs 我们打标的
  // 板块词表），所以这里把「板块字段命中」和「标题出现核心词」放进同一个 OR 组，
  // 而不是两条独立的 AND 条件——否则两者几乎永远同时不成立。
  if (options.sector || (Array.isArray(options.titleHints) && options.titleHints.length > 0)) {
    const variants = Array.isArray(options.sectorVariants) && options.sectorVariants.length > 0
      ? options.sectorVariants
      : options.sector
        ? [options.sector]
        : []
    const hints = Array.isArray(options.titleHints)
      // 不按长度过滤：板块名可能就是一个字（「铝」「铜」「煤」），过滤掉会让这次筛选静默失效、
      // 返回全部事件。这里信任调用方给的提示词，只限条数。
      ? options.titleHints.filter((hint) => String(hint || '').trim().length >= 1).slice(0, 10)
      : []
    const clauses = []
    const values = []
    for (const variant of variants) {
      clauses.push('sectors LIKE ?')
      values.push(`%${String(variant).trim()}%`)
    }
    for (const hint of hints) {
      clauses.push('title LIKE ?')
      values.push(`%${String(hint).trim()}%`)
    }
    if (clauses.length > 0) {
      where.push(`(${clauses.join(' OR ')})`)
      params.push(...values)
    }
  }
  if (options.q) {
    where.push('(title LIKE ? OR summary LIKE ?)')
    const needle = `%${String(options.q).trim()}%`
    params.push(needle, needle)
  }
  if (options.source) {
    where.push('source_list LIKE ?')
    params.push(`%"source":"${String(options.source).trim()}"%`)
  }
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 50))
  // 排序键取 min(last_ts, created_at)：正常资讯 last_ts 是发布时间，created_at 是收进来的时间
  // （更晚），min 就是发布时间；巨潮盘后发的公告披露日写的是**次日**，min 落到「什么时候收到的」，
  // 于是它们跟今晚的实时资讯按到达顺序交错，而不是永远压在顶上。
  // 显示仍然用真实披露日（ts / lastTs 不动）。
  const sql = `SELECT ${EVENT_COLUMNS} FROM events
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY MIN(last_ts, created_at) DESC LIMIT ?`
  const events = store
    .prepare(sql)
    .all(...params, limit)
    .map(decodeEvent)
  const totalRow = store
    .prepare(`SELECT COUNT(*) AS n FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
    .get(...params)
  return { events, total: Number(totalRow && totalRow.n) || 0 }
}

/** 首页统计：条目/事件总数、时间跨度、各源健康度、各 kind / eventType 分布。 */
export function stats() {
  const store = openStore()
  const one = (sql, ...params) => store.prepare(sql).get(...params) || {}
  const items = Number(one('SELECT COUNT(*) AS n FROM items').n) || 0
  const events = Number(one('SELECT COUNT(*) AS n FROM events').n) || 0
  const span = one('SELECT MIN(ts) AS first, MAX(ts) AS last FROM events')
  const lastIngest = one("SELECT value FROM meta WHERE key = 'lastIngestAt'")
  const bySource = store
    .prepare(
      `SELECT s.id, s.label, s.last_ok AS lastOk, s.last_error AS lastError,
              s.last_error_at AS lastErrorAt, s.item_count AS itemCount,
              (SELECT COUNT(*) FROM items i WHERE i.source = s.id) AS count
         FROM source_state s ORDER BY s.id`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      label: row.label,
      count: Number(row.count) || 0,
      itemCount: Number(row.itemCount) || 0,
      lastOk: row.lastOk == null ? null : Number(row.lastOk),
      lastError: row.lastError || '',
      lastErrorAt: row.lastErrorAt == null ? null : Number(row.lastErrorAt),
    }))
  const byKind = store
    .prepare('SELECT kind, COUNT(*) AS count FROM events GROUP BY kind ORDER BY count DESC')
    .all()
    .map((row) => ({ kind: row.kind, count: Number(row.count) }))
  const byEventType = store
    .prepare(
      `SELECT event_type AS eventType, COUNT(*) AS count FROM events
        WHERE event_type <> '' GROUP BY event_type ORDER BY count DESC LIMIT 20`,
    )
    .all()
    .map((row) => ({ eventType: row.eventType, count: Number(row.count) }))
  return {
    items,
    events,
    span: { first: Number(span.first) || 0, last: Number(span.last) || 0 },
    lastIngestAt: lastIngest && lastIngest.value ? lastIngest.value : '',
    bySource,
    byKind,
    byEventType,
  }
}

/** 记录一次源运行结果（面板与 /hub/stats 据此显示哪条源挂了）。 */
export function recordSourceRun(id, label, { ok, error, count, at = Date.now() }) {
  const store = openStore()
  if (ok) {
    store
      .prepare(
        `INSERT INTO source_state (id, label, last_ok, last_error, run_count, item_count)
         VALUES (?, ?, ?, '', 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label, last_ok = excluded.last_ok,
           last_error = '', run_count = source_state.run_count + 1,
           item_count = item_count + excluded.item_count`,
      )
      .run(String(id), String(label || id), Number(at), Number(count) || 0)
    return
  }
  store
    .prepare(
      `INSERT INTO source_state (id, label, last_ok, last_error, last_error_at, run_count, item_count)
       VALUES (?, ?, NULL, ?, ?, 1, 0)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label, last_error = excluded.last_error,
         last_error_at = excluded.last_error_at, run_count = source_state.run_count + 1`,
    )
    .run(String(id), String(label || id), String(error || '未知错误').slice(0, 300), Number(at))
}

export function metaSet(key, value) {
  openStore()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(String(key), String(value))
}

export function metaGet(key, fallback = '') {
  const row = openStore().prepare('SELECT value FROM meta WHERE key = ?').get(String(key))
  return row && row.value != null ? row.value : fallback
}

/**
 * 保留最近 N 天**抓到的**数据，超期条目/事件/关联一并删掉（P0 默认 30 天）。
 *
 * 口径按「入库时间」而不是「发布时间」：政策库、央行规章这类源给的是两个月前的
 * 文档，按发布时间清理会让它们入库即被删（实测 gov-policy 40 条只剩 9 条、
 * pbc 20 条剩 0 条）。资讯中心要的是「我抓到的最近 30 天」，不是「最近 30 天发生的」。
 */
export function prune(days = 30, now = Date.now()) {
  const cutoff = now - Math.max(1, days) * 24 * 60 * 60 * 1000
  const store = openStore()
  const stale = store.prepare('SELECT id FROM events WHERE created_at < ?').all(cutoff).map((row) => row.id)
  if (stale.length > 0) {
    const delLinks = store.prepare('DELETE FROM event_items WHERE event_id = ?')
    const delEvent = store.prepare('DELETE FROM events WHERE id = ?')
    for (const id of stale) {
      delLinks.run(id)
      delEvent.run(id)
    }
  }
  const items = store.prepare('DELETE FROM items WHERE ingested_at < ?').run(cutoff)
  return { events: stale.length, items: Number(items.changes) || 0 }
}

/* ------------------------------ 规则回填 ------------------------------ */

/** 读最近 N 天入库的条目（重算打标用）。 */
export function recentItems(sinceTs, limit = 4000) {
  const store = openStore()
  return store
    .prepare(
      `SELECT id, ts, source, source_label AS sourceLabel, kind, title, summary, url,
              tickers, sectors, event_type AS eventType, importance, degraded
         FROM items WHERE ingested_at >= ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(Number(sinceTs) || 0, Math.max(1, Number(limit) || 4000))
    .map(decodeItem)
}

/** 批量回写条目打标结果（只动标签与分数，不动正文）。 */
export function updateItemTags(items) {
  if (!Array.isArray(items) || items.length === 0) return 0
  const store = openStore()
  const stmt = store.prepare(
    `UPDATE items SET tickers = ?, sectors = ?, event_type = ?, importance = ? WHERE id = ?`,
  )
  let changed = 0
  store.exec('BEGIN')
  try {
    for (const item of items) {
      changed += Number(stmt.run(json(item.tickers), json(item.sectors), String(item.eventType || ''), Math.max(0, Math.min(100, Math.round(Number(item.importance) || 0))), String(item.id)).changes) || 0
    }
    store.exec('COMMIT')
  } catch (error) {
    store.exec('ROLLBACK')
    throw error
  }
  return changed
}

/** 读最近 N 天的事件（连同簇内条目），重算打标用。 */
export function recentEvents(sinceTs, limit = 2000) {
  const store = openStore()
  const ids = store
    .prepare('SELECT id FROM events WHERE created_at >= ? ORDER BY last_ts DESC LIMIT ?')
    .all(Number(sinceTs) || 0, Math.max(1, Number(limit) || 2000))
    .map((row) => row.id)
  const out = []
  for (const id of ids) {
    const event = getEvent(id)
    if (event) out.push(event)
  }
  return out
}

/** 回写事件的打标结果（类型/分数/标的并集/重要度拆解）。 */
export function updateEventTags(event) {
  openStore()
    .prepare('UPDATE events SET event_type = ?, importance = ?, tickers = ?, sectors = ?, importance_parts = ? WHERE id = ?')
    .run(
      String(event.eventType || ''),
      Math.max(0, Math.min(100, Math.round(Number(event.importance) || 0))),
      json(event.tickers),
      json(event.sectors),
      json(event.importanceParts || {}),
      String(event.id),
    )
}

/** 读时间窗内全部事件（聚合用，不走分页上限）。 */
export function allEventsSince(sinceTs, limit = 5000) {
  const store = openStore()
  return store
    .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE last_ts >= ? ORDER BY MIN(last_ts, created_at) DESC LIMIT ?`)
    .all(Number(sinceTs) || 0, Math.max(1, Number(limit) || 5000))
    .map(decodeEvent)
}

/* ------------------------------ LLM 摘要 ------------------------------ */

/**
 * 挑出「分数够高、还没总结过」的事件。
 * 用 created_at 限窗口：新说明的旧政策没必要再花 token 重讲一遍。
 */
export function pendingSummaryEvents({ minImportance = 70, sinceTs = 0, limit = 3 } = {}) {
  const store = openStore()
  return store
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM events
        WHERE importance >= ? AND created_at >= ? AND (llm_summary IS NULL OR llm_summary = '')
        ORDER BY importance DESC, last_ts DESC LIMIT ?`,
    )
    .all(
      // minImportance 传 0 要能表示「全部」，不能用 `|| 70` 把 0 吞掉。
      Number.isFinite(Number(minImportance)) ? Number(minImportance) : 70,
      Number(sinceTs) || 0,
      Math.max(1, Math.min(20, Number(limit) || 3)),
    )
    .map(decodeEvent)
}

/** 写入一条事件的一句话摘要（幂等：已有摘要时覆盖）。 */
export function saveEventSummary(id, { summary, sentiment = '', model = '', at = Date.now() }) {
  openStore()
    .prepare('UPDATE events SET llm_summary = ?, llm_sentiment = ?, llm_model = ?, llm_at = ? WHERE id = ?')
    .run(String(summary || '').slice(0, 400), String(sentiment || '').slice(0, 20), String(model || '').slice(0, 80), Number(at), String(id))
}

/** 摘要覆盖率（面板「AI」角标与验收看）。 */
export function summaryCoverage() {
  const store = openStore()
  const row = store.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN llm_summary <> \'\' THEN 1 ELSE 0 END) AS done FROM events').get()
  return { total: Number(row.total) || 0, summarized: Number(row.done) || 0 }
}
