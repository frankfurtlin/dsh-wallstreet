/**
 * dsh-wallstreet —— 信息资讯集散中心 · 每日 Markdown digest
 *
 * 为什么落成文件而不是只开接口：日报是「外部消费」的产物（知识库管线、其它 agent、
 * 人肉阅读），需要一份稳定、可 diff、不依赖进程在线的快照。本文件只做三件事：
 *
 *  1. renderDigestMarkdown(date, data)：纯函数，事件数组 → Markdown 字符串。不读库、不读盘。
 *  2. generateDigest({ date, now })：按北京时间切一天，从 store 取数据 → 写
 *     `<date>.md` + `latest.md`（原子写：`.tmp` + rename），返回文件路径与条数。
 *  3. listDigests({ limit })：列出已有日报（只认 `YYYY-MM-DD.md`），按日期倒序。
 *
 * 两条硬边界：
 *  - **外部内容一律当不可信输入**：标题/摘要/来源名/URL 的显示长度由对方决定，必须截断
 *    （标题 ≤120、URL ≤300、来源名 ≤40）；只有 `http(s)` 才渲染成链接，其它协议直接丢弃。
 *  - **日期口径统一北京时间**：不引时区库，复用 schema.js 的 `beijingDayStart` / `formatStamp`。
 *
 * 数据字段见 docs/info-hub.md §5；事件来源只用 store.js 的公开查询（allEventsSince / stats），
 * 不直接读表。
 */
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KIND_LABELS, KINDS, beijingDayStart, cleanText, formatStamp } from './schema.js'
import { allEventsSince, stats } from './store.js'

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 默认产出目录：插件内 data/digest；可用 DSH_WALLSTREET_DIGEST_DIR 覆盖（每次调用现读）。 */
const DEFAULT_DIGEST_DIR = join(PLUGIN_ROOT, 'data', 'digest')
/** latest.md 的文件名（始终是「最近一次生成」的那份，不一定是日期最新的）。 */
const LATEST_NAME = 'latest.md'

const DAY_MS = 24 * 60 * 60 * 1000
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/* 外部内容的显示上限：长度由上游决定，不截断会把整份日报撑爆。 */
const MAX_TITLE = 120
const MAX_URL = 300
const MAX_SOURCE = 40
const MAX_SUMMARY = 200
const MAX_TICKERS = 4
const MAX_SECTORS = 4

/* 日报口径。 */
const IMPORTANT_THRESHOLD = 70
const ANNOUNCEMENT_THRESHOLD = 60
const TOP_IMPORTANT = 30
const TOP_ANNOUNCEMENTS = 15
const TOP_SECTORS = 20
const MAX_SOURCE_ROWS = 40
/** 单日扫描上限：一次取够当天事件，超过就截断（正常一天远低于这个量级）。 */
const EVENT_SCAN_LIMIT = 20000

const DEFAULT_LIST_LIMIT = 30
const MAX_LIST_LIMIT = 365

/** 列表项下的子行缩进：4 空格对 `1. ` 与 `10. ` 的序号宽度都成立。 */
const SUB = '    - '

/* ------------------------------ 小工具 ------------------------------ */

const pad2 = (value) => String(value).padStart(2, '0')

/** epoch ms → 北京时间 'YYYY-MM-DD'（直接 +08:00 偏移，不依赖时区库）。 */
function beijingDayLabel(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value + BEIJING_OFFSET_MS)
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/** epoch ms → 北京时间 'HH:mm'。 */
function beijingClock(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '—'
  const date = new Date(value + BEIJING_OFFSET_MS)
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`
}

/**
 * 'YYYY-MM-DD' / 'YYYY-M-D' → { label, start }；非法返回 null。
 * start 是该日北京时间 00:00 的 epoch ms。
 */
function parseDayLabel(text) {
  const match = String(text == null ? '' : text).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const utc = Date.UTC(year, month - 1, day)
  const probe = new Date(utc)
  // 回读校验：2026-02-30 会被 Date.UTC 滚到 3 月 2 日，必须判为非法而不是静默改期。
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null
  }
  return { label: `${year}-${pad2(month)}-${pad2(day)}`, start: utc - BEIJING_OFFSET_MS }
}

/** 日报日期标签：优先用调用方给的 date，否则用 generatedAt 的北京日期。 */
function dayLabelOf(date, generatedAt) {
  if (date instanceof Date) return beijingDayLabel(date.getTime()) || beijingDayLabel(generatedAt)
  if (typeof date === 'number') return beijingDayLabel(date) || beijingDayLabel(generatedAt)
  const parsed = parseDayLabel(date)
  if (parsed) return parsed.label
  return beijingDayLabel(generatedAt)
}

/** 正数（时间戳/计数用）；非法一律归 0，避免 NaN 漏进输出。 */
function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

/** 重要度夹到 0–100 的整数。 */
function clampImportance(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(100, Math.round(number)))
}

/** 清洗一段外部文本并截断（去标签、压空白、超长加省略号）。 */
function safeText(value, max) {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  return cleanText(text, max)
}

/**
 * 行内 Markdown 转义：外部标题里的 `*ST英飞` 不能把加粗/斜体吃坏，`[x](url)` 也不能
 * 凭空造出一个链接。只在截断之后加反斜杠，显示字数仍是 max。
 */
function escapeInline(text) {
  return String(text == null ? '' : text).replace(/[\\`*_[\]<>]/g, '\\$&')
}

/** 行内文本 = 清洗截断 + Markdown 转义（标题/摘要/板块名等一切来自上游的文字）。 */
function inlineText(value, max) {
  return escapeInline(safeText(value, max))
}

/**
 * 只放行 http(s) URL；空串、`javascript:`、`mailto:`、含空白/尖括号的一律返回 ''。
 * 返回值仍是完整 URL（未截断），长度约束统一由 `urlLine` 处理。
 */
function safeHttpUrl(value) {
  if (typeof value !== 'string') return ''
  const url = value.trim()
  if (!/^https?:\/\//i.test(url)) return ''
  // URL 里的空格/换行会把 Markdown 行拆开；尖括号是 autolink 语法。这类直接拒绝。
  if (/[\s<>"`]/.test(url)) return ''
  return url
}

/** 表格单元格：管道符转义，换行压平（否则表格结构会断）。 */
function cell(value) {
  return String(value == null ? '' : value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

const byImportance = (a, b) => b.importance - a.importance || b.lastTs - a.lastTs

/* ------------------------------ 事件视图 ------------------------------ */

/**
 * 把 store 里的事件压成渲染用的安全视图：所有外部字段清洗 + 截断 + 类型收敛。
 * 非对象（null / 字符串 / 数组）返回 null，由调用方过滤。
 */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const kind = KINDS.includes(raw.kind) ? raw.kind : 'flash'
  const llm = raw.llm && typeof raw.llm === 'object' && !Array.isArray(raw.llm) ? raw.llm : null
  const llmSummary = llm ? inlineText(llm.summary, MAX_SUMMARY) : ''
  const llmSentiment = llm ? inlineText(llm.sentiment, 20) : ''

  return {
    title: inlineText(raw.title, MAX_TITLE) || '（无标题）',
    summary: inlineText(raw.summary, MAX_SUMMARY),
    url: safeHttpUrl(raw.url),
    kind,
    // 类型标签自己会被塞进 `**[…]**`，方括号先去掉再转义。
    eventType: escapeInline(safeText(raw.eventType, MAX_SOURCE).replace(/[[\]]/g, '')),
    importance: clampImportance(raw.importance),
    sourceCount: Math.max(1, Math.round(Number(raw.sourceCount) || 1)),
    lastTs: positiveNumber(raw.lastTs) || positiveNumber(raw.ts),
    tickers: tickerList(raw.tickers),
    sectors: sectorList(raw.sectors),
    sources: sourceList(raw.sources),
    llm: llmSummary ? { summary: llmSummary, sentiment: llmSentiment } : null,
  }
}

/** 6 位代码，去重、限条数（docs §2：tickers 是纯数字代码，脏值不渲染）。 */
function tickerList(value) {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value]
  const out = []
  for (const entry of raw) {
    const code = String(entry == null ? '' : entry).trim()
    if (!/^\d{6}$/.test(code) || out.includes(code)) continue
    out.push(code)
    if (out.length >= MAX_TICKERS) break
  }
  return out
}

/** 板块名清洗，去重、限条数。 */
function sectorList(value) {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value]
  const out = []
  for (const entry of raw) {
    const name = inlineText(entry, 20)
    if (!name || out.includes(name)) continue
    out.push(name)
    if (out.length >= MAX_SECTORS) break
  }
  return out
}

/** 从事件 sources 里取源 id（跨源数统计用）。 */
function sourceList(value) {
  const raw = Array.isArray(value) ? value : []
  const out = []
  for (const entry of raw) {
    const id = safeText(entry && typeof entry === 'object' ? entry.source : entry, MAX_SOURCE)
    if (!id || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/* ------------------------------ 各段渲染 ------------------------------ */

/** 头部统计行：事件数 / 涉及源数 / 多源事件数都按「当天」算。 */
function headerLine(events, generatedAt) {
  const sources = new Set()
  let multi = 0
  for (const event of events) {
    for (const id of event.sources) sources.add(id)
    if (event.sourceCount >= 2) multi += 1
  }
  return `> 生成于 ${beijingClock(generatedAt)}｜事件 ${events.length} 条｜来源 ${sources.size} 个｜多源事件 ${multi} 条`
}

/** 要闻/公告条目的标题行：`1. **[政策法规]** 标题（重要度 82 · 3 家）`。 */
function entryHeadline(event, index) {
  const tag = event.eventType || KIND_LABELS[event.kind] || '资讯'
  return `${index}. **[${tag}]** ${event.title}（重要度 ${event.importance} · ${event.sourceCount} 家）`
}

/**
 * 摘要行：有 AI 摘要就用它（带情绪），否则按需回落到原文摘要。
 * mode='any'：AI 优先、原文兜底；mode='ai'：只写 AI 摘要（公告条目保持紧凑）。
 */
function summaryLine(event, mode) {
  if (event.llm) {
    const sentiment = event.llm.sentiment ? `（${event.llm.sentiment}）` : ''
    return `${SUB}AI：${event.llm.summary}${sentiment}`
  }
  if (mode === 'any' && event.summary) return `${SUB}摘要：${event.summary}`
  return ''
}

/** 关联行：`关联：600028 / 石油石化`（标的在前、板块在后）。 */
function relatedLine(event) {
  const related = [...event.tickers, ...event.sectors]
  return related.length > 0 ? `${SUB}关联：${related.join(' / ')}` : ''
}

/** 原文行：只喂 http(s)；超过 300 字的 URL 截断且不再当链接用。 */
function urlLine(url) {
  if (!url) return ''
  if (url.length <= MAX_URL) return `${SUB}原文：${url}`
  return `${SUB}原文：${url.slice(0, MAX_URL - 1)}…（原链接过长，已截断）`
}

/** 要闻条目：标题 + 摘要 + 关联 + 原文。 */
function importantLines(event, index) {
  const lines = [entryHeadline(event, index)]
  const summary = summaryLine(event, 'any')
  if (summary) lines.push(summary)
  const related = relatedLine(event)
  if (related) lines.push(related)
  const url = urlLine(event.url)
  if (url) lines.push(url)
  return lines
}

/** 公告条目：标题 + AI 摘要（有才写）+ 关联 + 原文，比要闻紧凑。 */
function announcementLines(event, index) {
  const lines = [`${index}. **${event.title}**（重要度 ${event.importance}）`]
  const summary = summaryLine(event, 'ai')
  if (summary) lines.push(summary)
  const related = relatedLine(event)
  if (related) lines.push(related)
  const url = urlLine(event.url)
  if (url) lines.push(url)
  return lines
}

/** 板块热度：按事件数倒序，平票看最高重要度。 */
function sectorHeat(events) {
  const heat = new Map()
  for (const event of events) {
    for (const name of event.sectors) {
      const row = heat.get(name) || { name, count: 0, importance: 0 }
      row.count += 1
      row.importance = Math.max(row.importance, event.importance)
      heat.set(name, row)
    }
  }
  return [...heat.values()].sort(
    (a, b) => b.count - a.count || b.importance - a.importance || a.name.localeCompare(b.name, 'zh'),
  )
}

/** 按 kind 计数（事件数多的在前，平票按 KINDS 声明顺序）。 */
function kindCounts(events) {
  const counts = new Map()
  for (const event of events) counts.set(event.kind, (counts.get(event.kind) || 0) + 1)
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind))
}

/** 组装一个二级章节：标题 + 空行 + 正文 + 空行。 */
function section(title, bodyLines) {
  return [`## ${title}`, '', ...bodyLines, '']
}

/**
 * 渲染一份日报 Markdown（纯函数，不读库、不读盘、不依赖 Date.now）。
 *
 * @param {string|number|Date} date 日报日期（北京时间）；'YYYY-MM-DD'。非法时回落到
 *   data.generatedAt 的北京日期，保证输出仍是一份合法日报。
 * @param {{events?:object[], stats?:object, generatedAt?:number}} [data]
 * @returns {string} 以单个换行结尾的 Markdown；空数据也返回合法文档。
 */
export function renderDigestMarkdown(date, data) {
  const payload = data && typeof data === 'object' ? data : {}
  const generatedAt = positiveNumber(payload.generatedAt)
  const label = dayLabelOf(date, generatedAt) || '未知日期'
  const events = (Array.isArray(payload.events) ? payload.events : [])
    .map(normalizeEvent)
    .filter((event) => event !== null)
  const statsData = payload.stats && typeof payload.stats === 'object' ? payload.stats : {}

  const important = events.filter((event) => event.importance >= IMPORTANT_THRESHOLD).sort(byImportance)
  const announcements = events
    .filter((event) => event.kind === 'announcement' && event.importance >= ANNOUNCEMENT_THRESHOLD)
    .sort(byImportance)
  const heat = sectorHeat(events)
  const kinds = kindCounts(events)

  const out = []
  out.push(`# 华尔街之狼 · 资讯日报 ${label}`, '')
  out.push(headerLine(events, generatedAt))
  out.push(`> 口径：北京时间 ${label} 00:00–24:00 的事件，按最后一次刷新时间归日`, '')
  // 空数据不抛错：给一句人话，后面各段照样输出结构（消费方不用改解析）。
  if (events.length === 0) out.push('今天没有抓到资讯。', '')

  /* 今日要闻 */
  const hotLines = []
  if (important.length === 0) {
    hotLines.push(`_无（今天没有重要度 ≥ ${IMPORTANT_THRESHOLD} 的事件）_`)
  } else {
    important
      .slice(0, TOP_IMPORTANT)
      .forEach((event, index) => hotLines.push(...importantLines(event, index + 1)))
    if (important.length > TOP_IMPORTANT) {
      hotLines.push(
        '',
        `> 另有 ${important.length - TOP_IMPORTANT} 条重要度 ≥ ${IMPORTANT_THRESHOLD} 的事件未列出（当天共 ${important.length} 条）。`,
      )
    }
  }
  out.push(...section(`今日要闻（重要度 ≥ ${IMPORTANT_THRESHOLD}）`, hotLines))

  /* 板块热度 */
  const heatLines = []
  if (heat.length === 0) {
    heatLines.push('_无_')
  } else {
    heatLines.push('| 板块 | 事件数 | 最高重要度 |', '| --- | ---: | ---: |')
    for (const row of heat.slice(0, TOP_SECTORS)) {
      heatLines.push(`| ${cell(row.name)} | ${row.count} | ${row.importance} |`)
    }
    if (heat.length > TOP_SECTORS) {
      heatLines.push('', `> 仅列出事件数最多的 ${TOP_SECTORS} 个板块（当天共 ${heat.length} 个）。`)
    }
  }
  out.push(...section('板块热度', heatLines))

  /* 公告精选 */
  const announcementBody = []
  if (announcements.length === 0) {
    announcementBody.push(`_无（今天没有重要度 ≥ ${ANNOUNCEMENT_THRESHOLD} 的公告）_`)
  } else {
    announcements
      .slice(0, TOP_ANNOUNCEMENTS)
      .forEach((event, index) => announcementBody.push(...announcementLines(event, index + 1)))
    if (announcements.length > TOP_ANNOUNCEMENTS) {
      announcementBody.push(
        '',
        `> 另有 ${announcements.length - TOP_ANNOUNCEMENTS} 条公告未列出（重要度 ≥ ${ANNOUNCEMENT_THRESHOLD} 的公告共 ${announcements.length} 条）。`,
      )
    }
  }
  out.push(...section(`公告精选（重要度 ≥ ${ANNOUNCEMENT_THRESHOLD} 的公告，最多 ${TOP_ANNOUNCEMENTS} 条）`, announcementBody))

  /* 其他事件：按类型计数 */
  const kindLines =
    kinds.length === 0
      ? ['_无_']
      : [`- ${kinds.map((row) => `${KIND_LABELS[row.kind] || row.kind} ${row.count} 条`).join(' / ')}`]
  out.push(...section('其他事件（按类型计数）', kindLines))

  /* 数据源：全部配置过的源都列出来（0 条也列，方便看哪条源挂了） */
  const sourceRows = (Array.isArray(statsData.bySource) ? statsData.bySource : []).filter(
    (row) => row && typeof row === 'object' && !Array.isArray(row),
  )
  const sourceLines = ['| 源 | 入库 | 最近成功 |', '| --- | ---: | --- |']
  if (sourceRows.length === 0) {
    sourceLines.push('| _无_ | — | — |')
  } else {
    for (const row of sourceRows.slice(0, MAX_SOURCE_ROWS)) {
      const name = safeText(row.label, MAX_SOURCE) || safeText(row.id, MAX_SOURCE) || '（未知源）'
      const count = positiveNumber(row.count)
      const lastOk = safeText(formatStamp(positiveNumber(row.lastOk)), 20)
      sourceLines.push(`| ${cell(name)} | ${count} | ${lastOk} |`)
    }
    sourceLines.push('', '> 「入库」为该源累计条目数（非当日）；「最近成功」为北京时间。')
  }
  out.push(...section('数据源', sourceLines))

  out.push('> 本文件由 dsh-wallstreet 自动生成，仅供研究参考，不构成投资建议。', '')

  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

/* ------------------------------ 落盘 ------------------------------ */

/** 日报目录：每次调用现读环境变量（测试/验收可以随时改到临时目录）。 */
function digestDir() {
  const override = process.env.DSH_WALLSTREET_DIGEST_DIR
  if (override && String(override).trim()) return String(override).trim()
  return DEFAULT_DIGEST_DIR
}

/**
 * 原子写：同目录 `.tmp` → rename。读方（知识库管线、cron）不会读到写了一半的文件。
 * @returns {number} 写入字节数
 */
function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, filePath)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件可能都没建成，忽略 */
    }
    throw error
  }
  return Buffer.byteLength(content, 'utf8')
}

/** 把入参 date 解析成「北京时间某一天的 00:00」；无 date 时取 now 的北京日期。 */
function resolveDay(date, now) {
  let value = date
  if (value instanceof Date) value = value.getTime()
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    const start = beijingDayStart(value)
    return { label: beijingDayLabel(start), start }
  }
  if (value != null && String(value).trim() !== '') return parseDayLabel(value)
  const start = beijingDayStart(now)
  return { label: beijingDayLabel(start), start }
}

/**
 * 生成某一天（默认今天）的日报并落盘。
 *
 * 口径：北京时间 [当天 00:00, 次日 00:00) 内、`lastTs` 落在窗口里的事件——即
 * 「这一天最后一次被刷新」的事件。跨零点写的事件严格归到它所在的北京日期。
 *
 * @param {{date?:string|number|Date, now?:number|Date}} [options]
 * @returns {Promise<{ok:boolean, date:string, path:string, latestPath:string, bytes:number,
 *   events:number, generatedAt:number, error?:string}>}
 *   失败不抛错：`ok:false` + `error`（中文原因），方便定时器直接记日志。
 */
export async function generateDigest({ date, now } = {}) {
  const generatedAt = positiveNumber(now) || Date.now()
  const day = resolveDay(date, generatedAt)
  if (!day) {
    return {
      ok: false,
      date: '',
      path: '',
      latestPath: '',
      bytes: 0,
      events: 0,
      generatedAt,
      error: `date 需要 YYYY-MM-DD 格式（北京时间），收到：${safeText(String(date), 40) || '空'}`,
    }
  }

  const dir = digestDir()
  const path = join(dir, `${day.label}.md`)
  const latestPath = join(dir, LATEST_NAME)

  try {
    mkdirSync(dir, { recursive: true })
    // allEventsSince 只有「起点」没有「终点」：先按起点取够，再在内存里夹上界。
    const dayEnd = day.start + DAY_MS
    // 归日口径 = 事件的**披露/发布时间**（lastTs），不是抓到它的时间。
    // 巨潮盘后公告的披露日写的是次日（11-25 晚上发的，标 11-26），它们进 11-26 的日报——
    // 这是「按披露日归日」的直接结果，也是诚实口径：面板同样把它们标成「次日」。
    // 为了让当天傍晚集中发布的公告进当天日报，定时器放在 23:30 而不是收盘后（见 hub/index.js）。
    const events = allEventsSince(day.start, EVENT_SCAN_LIMIT).filter((event) => {
      const lastTs = Number(event && event.lastTs)
      return Number.isFinite(lastTs) && lastTs >= day.start && lastTs < dayEnd
    })
    const payload = { events, stats: stats(), generatedAt }
    const markdown = renderDigestMarkdown(day.label, payload)
    const bytes = writeFileAtomic(path, markdown)
    writeFileAtomic(latestPath, markdown)
    // 知识库管线收 HTML，所以同时落一份（同样的 data，渲染成自包含页面）。
    const htmlPath = path.replace(/\.md$/, '.html')
    writeFileAtomic(htmlPath, renderDigestHtml(day.label, payload))
    writeFileAtomic(join(dir, 'latest.html'), renderDigestHtml(day.label, payload))
    return { ok: true, date: day.label, path, latestPath, bytes, events: events.length, generatedAt }
  } catch (error) {
    return {
      ok: false,
      date: day.label,
      path,
      latestPath,
      bytes: 0,
      events: 0,
      generatedAt,
      error: `生成 ${day.label} 日报失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 列出已有日报（只认 `YYYY-MM-DD.md`，`latest.md` 与临时文件不算），按日期倒序。
 *
 * @param {{limit?:number}} [options] 默认 30 份，最多 365 份
 * @returns {Promise<Array<{date:string, path:string, bytes:number, modifiedAt:number}>>}
 *   目录不存在时返回空数组（第一次跑定时器前的正常状态）。
 */
export async function listDigests({ limit } = {}) {
  const dir = digestDir()
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  const rows = []
  for (const name of names) {
    const match = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name)
    if (!match) continue
    const parsed = parseDayLabel(match[1])
    // 2026-13-40.md 这种名字虽然像日期，但不是真实日期，一并忽略。
    if (!parsed) continue
    let info
    try {
      info = statSync(join(dir, name))
    } catch {
      continue
    }
    if (!info.isFile()) continue
    rows.push({
      date: parsed.label,
      path: join(dir, name),
      bytes: Number(info.size) || 0,
      modifiedAt: Math.round(Number(info.mtimeMs) || 0),
    })
  }

  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const max = Number(limit)
  const cap = Number.isFinite(max) && max > 0 ? Math.min(Math.floor(max), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT
  return rows.slice(0, cap)
}

/**
 * 日报的 HTML 版：知识库管线（`scripts/kb/kb_publish.py`）收的是 HTML，不收 Markdown。
 * 内容与 Markdown 同源（同一个 `data`），只是渲染成自包含页面。
 *
 * @param {string} date `YYYY-MM-DD`
 * @param {{events:Array<object>, stats?:object, generatedAt?:number}} data
 * @returns {string}
 */
export function renderDigestHtml(date, data) {
  const esc = (value) =>
    String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  const events = Array.isArray(data && data.events) ? data.events : []
  const stats = (data && data.stats) || {}
  const bySource = Array.isArray(stats.bySource) ? stats.bySource : []
  const rank = (list) => list.slice().sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))
  const headlines = rank(events.filter((event) => (Number(event.importance) || 0) >= 70)).slice(0, 30)
  const notices = rank(events.filter((event) => event.kind === 'announcement' && (Number(event.importance) || 0) >= 60)).slice(0, 15)
  const sectorCount = new Map()
  for (const event of events) {
    for (const raw of Array.isArray(event.sectors) ? event.sectors : []) {
      const name = String(raw || '').trim()
      if (!name) continue
      const entry = sectorCount.get(name) || { name, count: 0, max: 0 }
      entry.count += 1
      entry.max = Math.max(entry.max, Number(event.importance) || 0)
      sectorCount.set(name, entry)
    }
  }
  const sectors = [...sectorCount.values()].sort((a, b) => b.count - a.count).slice(0, 20)
  const link = (url) => {
    const text = String(url || '').trim()
    if (!/^https?:\/\//i.test(text) || text.length > 300) return ''
    return `<a href="${esc(text)}" rel="noopener noreferrer">原文</a>`
  }
  const when = Number((data && data.generatedAt) || Date.now())
  const stamp = new Date(when + 8 * 3600_000).toISOString().slice(11, 16)

  const headHtml = headlines
    .map(
      (event, index) => `<li><p class="t"><b>${esc(String(event.title || '').slice(0, 120))}</b>
<span class="m">重要度 ${Number(event.importance) || 0}${Number(event.sourceCount) > 1 ? ` · ${Number(event.sourceCount)} 家` : ''}</span></p>
${event.llm && event.llm.summary ? `<p class="ai">AI：${esc(String(event.llm.summary).slice(0, 160))}（${esc(event.llm.sentiment || '中性')}）</p>` : ''}
<p class="m">${(Array.isArray(event.tickers) ? event.tickers : []).slice(0, 4).map((code) => `<span class="tag">${esc(code)}</span>`).join(' ')} ${link(event.url)}</p></li>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>资讯日报 ${esc(date)}</title>
<style>
body{font:15px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1b1b1b;background:#fdfcf9;margin:0;padding:32px 20px}
main{max-width:780px;margin:0 auto}
h1{font-size:26px;margin:0 0 4px} .sub{color:#8a8a86;font-size:13px;margin-bottom:24px}
h2{font-size:17px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid #e5e2da}
ol,ul{padding-left:20px} li{margin-bottom:10px}
.t{margin:0} .ai{color:#6b6b66;font-size:13.5px;margin:2px 0}
.m{color:#8a8a86;font-size:12.5px;margin:2px 0}
.tag{display:inline-block;border:1px solid #e0ddd4;border-radius:99px;padding:0 7px;margin-right:4px;font-size:11.5px;color:#6b6b66}
table{border-collapse:collapse;width:100%;font-size:13.5px} td,th{border-bottom:1px solid #eae7df;padding:5px 8px;text-align:left}
td.n{text-align:right;font-variant-numeric:tabular-nums}
footer{margin-top:32px;color:#a4a099;font-size:12px;border-top:1px solid #e5e2da;padding-top:10px}
</style></head><body><main>
<h1>华尔街之狼 · 资讯日报</h1>
<div class="sub">${esc(date)}｜生成于 ${esc(stamp)}｜事件 ${events.length} 条${bySource.length ? `｜来源 ${bySource.length} 个` : ''}</div>
<h2>今日要闻（重要度 ≥ 70）</h2>
${headlines.length ? `<ol>${headHtml}</ol>` : '<p class="m">今天没有达到门槛的要闻。</p>'}
<h2>板块热度</h2>
${sectors.length ? `<table><tr><th>板块</th><th class="n">事件数</th><th class="n">最高重要度</th></tr>${sectors.map((row) => `<tr><td>${esc(row.name)}</td><td class="n">${row.count}</td><td class="n">${row.max}</td></tr>`).join('')}</table>` : '<p class="m">今天没有板块统计。</p>'}
<h2>公告精选（重要度 ≥ 60）</h2>
${notices.length ? `<ul>${notices.map((event) => `<li><b>${esc(String(event.title || '').slice(0, 120))}</b> <span class="m">${Number(event.importance) || 0} 分</span> ${link(event.url)}</li>`).join('')}</ul>` : '<p class="m">今天没有够格的公告。</p>'}
<h2>数据源</h2>
${bySource.length ? `<table><tr><th>源</th><th class="n">入库</th></tr>${bySource.map((row) => `<tr><td>${esc(String(row.label || row.id || '').slice(0, 40))}</td><td class="n">${Number(row.count) || 0}</td></tr>`).join('')}</table>` : '<p class="m">暂无数据源统计。</p>'}
<footer>本文件由 dsh-wallstreet 自动生成，仅供研究参考，不构成投资建议。</footer>
</main></body></html>`
}

/** kb 发布脚本路径（可用环境变量覆盖，测试时指到桩脚本）。 */
function kbPublishScript() {
  return process.env.DSH_WALLSTREET_KB_PUBLISH || join(homedir(), 'scripts', 'kb', 'kb_publish.py')
}

/**
 * 把某一天的 HTML 日报投喂进知识库（调用共享脚本 `scripts/kb/kb_publish.py`）。
 * 失败不抛错，返回 `{ ok:false, error }`——日报文件本身已经落盘，不该因为上传失败丢掉。
 *
 * @param {{ date?: string, dryRun?: boolean }} [options]
 */
export async function publishDigest({ date } = {}) {
  const { spawn } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const day = resolveDay(date, Date.now())
  if (!day) return { ok: false, error: `日期不合法：${date}` }
  const htmlPath = join(digestDir(), `${day.label}.html`)
  if (!existsSync(htmlPath)) return { ok: false, error: `找不到 HTML 日报：${htmlPath}` }
  const script = kbPublishScript()
  if (!existsSync(script)) return { ok: false, error: `发布脚本不存在：${script}` }
  const args = [
    script,
    htmlPath,
    '--date',
    day.label.replace(/-/g, ''),
    '--title',
    `华尔街之狼 · 资讯日报 | ${day.label}`,
    '--category',
    '资讯日报',
    '--series',
    '资讯日报',
    '--tags',
    '资讯日报,A股,公告',
    '--if-exists',
    'replace',
  ]
  return new Promise((resolve) => {
    const child = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (error) => resolve({ ok: false, error: `调不起发布脚本：${error.message}` }))
    child.on('close', (code) => {
      let parsed = null
      try {
        parsed = JSON.parse(String(out).trim().split('\n').filter(Boolean).pop() || 'null')
      } catch {
        parsed = null
      }
      if (parsed && parsed.ok) return resolve({ ok: true, uid: parsed.uid || '', url: parsed.url || '', skipped: !!parsed.skipped })
      const reason = (parsed && parsed.error) || err.trim().slice(0, 300) || out.trim().slice(0, 300) || `退出码 ${code}`
      resolve({ ok: false, error: reason })
    })
  })
}
