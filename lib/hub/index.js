/**
 * dsh-wallstreet —— 信息资讯集散中心 · 装配层
 *
 * 把存储、入站、打标三块接起来，对外只暴露三样东西：
 *   1. hubRoute()：`/wallstreet/api/hub/*` 的路由体（由 lib/index.js 挂到 webServer）；
 *   2. createHubTools()：注册给模型的 `wallstreet_news` 工具；
 *   3. startHub()：宿主启动时拉起调度器。
 *
 * 设计约束：面板读、工具读、快照回填写都走同一个 store，不再各读各的 JSON。
 */
import { queryFeed, stats as storeStats, getEvent, metaGet, openStore, allEventsSince } from './store.js'
import { membersOf, membershipStats, pumpQueue } from './membership.js'
import { loadConfig, saveConfigUpdates, describeSources, configFilePath, loadLlmSelection, saveLlmSelection } from './config.js'
import { runSummaries, summaryStatus } from './summarize.js'
import { getFrontpage } from './frontpage.js'
import { runIngest, startScheduler, phaseNow, rescoreRecent } from './ingest.js'
import { formatStamp, beijingDayStart, KIND_LABELS, sectorVariants, normalizeSector, sectorMatches } from './schema.js'

const API_PREFIX = '/wallstreet/api'

/**
 * 事件是否属于某个板块：成分股命中优先，其次板块字段，最后标题核心词。
 * 成分股来自 membership.js 的缓存，没有缓存时只走后两条（即 P1 的关键词口径）。
 */
function eventMatchesSector(event, { name, codes }) {
  if (Array.isArray(codes) && codes.length > 0) {
    const set = new Set(codes)
    if ((event.tickers || []).some((code) => set.has(code))) return true
  }
  const variants = sectorVariants(name)
  if ((event.sectors || []).some((sector) => variants.some((variant) => sectorMatches(sector, variant)))) return true
  return variants.some((variant) => variant.length >= 2 && String(event.title || '').includes(variant))
}

/**
 * 读一小段 JSON 请求体（只给保存源配置用）。上限 16KB：这个接口只会传几十条开关，
 * 不是上传通道；超限直接报错，不无限读。
 */
async function readJsonBody(req, limit = 16 * 1024) {
  if (!req || typeof req.on !== 'function') return null
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(null)
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return finish({})
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

/** 解析查询参数里的布尔/数字，容忍前端传字符串。 */
const numArg = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clampLimit(value, fallback = 50, max = 200) {
  return Math.max(1, Math.min(max, Math.round(numArg(value, fallback))))
}

/** `since` 接受 epoch ms 或 ISO；也支持 `24h` 这种简写。 */
function parseSince(value) {
  if (value == null || value === '') return 0
  const text = String(value).trim()
  const relative = text.match(/^(\d+(?:\.\d+)?)([hm])$/i)
  if (relative) {
    const amount = Number(relative[1])
    const ms = relative[2].toLowerCase() === 'h' ? amount * 3_600_000 : amount * 60_000
    return Date.now() - ms
  }
  if (/^\d{10,13}$/.test(text)) return numArg(text, 0)
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 今日事件数：按北京时间零点切，面板顶部统计用。 */
function todayCounts(now = Date.now()) {
  const start = beijingDayStart(now)
  const { total: events } = queryFeed({ since: start, limit: 1 })
  return { events, since: start }
}

/**
 * 处理一条 `/hub/*` 请求。
 * @returns {Promise<object|undefined>} undefined 表示「不是 hub 路由」，交给上层 404。
 */
let ctxRef = null

/** 由 startHub 注入宿主 ctx：摘要要调 llm/agentDefaultModel 两个服务。 */
export function bindHubContext(ctx) {
  ctxRef = ctx || null
}

/** 从宿主的 llm 服务列出可用 provider/model（拿不到就空列表）。 */
async function modelCatalog(ctx) {
  const providers = []
  try {
    const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm', false) : null
    if (llm && typeof llm.listProviders === 'function') {
      const raw = (await llm.listProviders()) || []
      for (const entry of raw) {
        const id = typeof entry === 'string' ? entry : entry && entry.id
        if (!id) continue
        let models = []
        if (typeof llm.listModels === 'function') {
          try {
            const listed = (await llm.listModels(id)) || []
            models = listed
              .map((item) => {
                const mid = typeof item === 'string' ? item : item && (item.id || item.model)
                if (!mid) return null
                const name = item && typeof item === 'object' ? item.name || item.label || mid : mid
                return { id: String(mid), name: String(name) }
              })
              .filter(Boolean)
          } catch {
            models = []
          }
        }
        providers.push({ id: String(id), name: String((entry && (entry.name || entry.label)) || id), models })
      }
    }
  } catch {
    /* 列表拿不到就返回空 */
  }
  return { providers }
}

/** 当前选择 + 可用性（不可用时不降级，直接标记）。 */
async function modelStatus(ctx, selected) {
  const catalog = await modelCatalog(ctx)
  if (!selected) {
    return { providers: catalog.providers, selected: null, available: catalog.providers.length > 0, reason: catalog.providers.length ? '' : '宿主没有可用的模型' }
  }
  const entry = catalog.providers.find((item) => item.id === selected.provider)
  const known = entry && ((entry.models || []).length === 0 || entry.models.some((item) => item.id === selected.model))
  return {
    providers: catalog.providers,
    selected,
    available: Boolean(known),
    reason: known ? '' : `模型不可用：${selected.provider}/${selected.model}`,
  }
}

export async function hubRoute({ pathname, query, method = 'GET', req = null }) {
  if (pathname === `${API_PREFIX}/hub/feed`) {
    const filters = {
      since: parseSince(query.get('since')),
      limit: clampLimit(query.get('limit'), 50, 200),
      kind: query.get('kind') || '',
      source: query.get('source') || '',
      ticker: query.get('ticker') || '',
      sector: query.get('sector') || '',
      sectorVariants: sectorVariants(query.get('sector') || ''),
      titleHints: sectorVariants(query.get('sector') || ''),
      eventType: query.get('eventType') || '',
      minImportance: numArg(query.get('minImportance'), 0),
      q: query.get('q') || '',
    }
    // 板块筛选：拿到了成分股就按成分股精确过滤（在内存里过一遍），否则退回 SQL 关键词。
    let events
    let total
    if (filters.sector) {
      const members = await membersOf(filters.sector, { code: query.get('sectorCode') || '' })
      if (members && members.basis === 'members' && members.codes.length > 0) {
        const wide = queryFeed({ ...filters, sector: '', sectorVariants: [], titleHints: [], limit: 500 })
        const matched = wide.events.filter((event) => eventMatchesSector(event, { name: filters.sector, codes: members.codes }))
        total = matched.length
        events = matched.slice(0, filters.limit)
        filters.sectorBasis = 'members'
        filters.sectorMembers = members.codes.length
      } else {
        const keyword = queryFeed(filters)
        events = keyword.events
        total = keyword.total
        filters.sectorBasis = 'keywords'
      }
    } else {
      const plain = queryFeed(filters)
      events = plain.events
      total = plain.total
    }
    const base = storeStats()
    const today = todayCounts()
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      total,
      filters,
      stats: {
        items: base.items,
        events: base.events,
        // 面板读 todayEvents（约定字段名）；today 是同一口径的旧名，保留兼容。
        todayEvents: today.events,
        today: today.events,
        todaySince: today.since,
        lastIngestAt: base.lastIngestAt,
        sources: base.bySource.length,
        phase: phaseNow(),
      },
      events,
    }
  }

  if (pathname === `${API_PREFIX}/hub/sectors`) {
    const since = parseSince(query.get('since')) || Date.now() - 24 * 3_600_000
    const limit = clampLimit(query.get('limit'), 60, 200)
    const events = allEventsSince(since)
    // names 模式：给定一批板块名（盘面当前展示的 16 个），逐个返回关联事件数。
    // 名字可以带板块代码（`半导体设备:BK1326`）：面板从 /overview 直接拿得到 code，
    // 有 code 就不必翻板块名单，点一次就能开始抓成分股。
    const names = String(query.get('names') || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 40)
      .map((entry) => {
        const [name, code] = entry.split(':')
        return { name: (name || '').trim(), code: /^BK\d+$/.test((code || '').trim()) ? code.trim() : '' }
      })
      .filter((entry) => entry.name)
    if (names.length > 0) {
      const sectors = []
      for (const entry of names) {
        const name = entry.name
        const members = await membersOf(name, { code: entry.code })
        const hasMembers = members && members.basis === 'members' && members.codes.length > 0
        let count = 0
        let lastTs = 0
        for (const event of events) {
          if (eventMatchesSector(event, { name, codes: hasMembers ? members.codes : [] })) {
            count += 1
            lastTs = Math.max(lastTs, event.lastTs)
          }
        }
        sectors.push({
          name,
          events: count,
          lastTs,
          basis: hasMembers ? 'members' : 'keywords',
          members: hasMembers ? members.codes.length : 0,
        })
      }
      // 有板块缺成分股就顺手排进后台队列，下一轮刷新自动变精确。
      if (sectors.some((sector) => sector.basis !== 'members')) pumpQueue().catch(() => {})
      return { ok: true, since, total: events.length, mode: 'names', sectors }
    }
    const buckets = new Map()
    for (const event of events) {
      for (const raw of event.sectors || []) {
        const name = normalizeSector(raw) || raw
        if (!name) continue
        const bucket = buckets.get(name) || { name, events: 0, lastTs: 0, importance: 0, tickers: new Set() }
        bucket.events += 1
        bucket.lastTs = Math.max(bucket.lastTs, event.lastTs)
        bucket.importance = Math.max(bucket.importance, event.importance)
        for (const code of event.tickers || []) bucket.tickers.add(code)
        buckets.set(name, bucket)
      }
    }
    const sectors = [...buckets.values()]
      .map((bucket) => ({ ...bucket, tickers: [...bucket.tickers].slice(0, 6) }))
      .sort((a, b) => b.events - a.events || b.lastTs - a.lastTs)
      .slice(0, limit)
    return { ok: true, since, total: events.length, sectors }
  }

  if (pathname === `${API_PREFIX}/hub/stats`) {
    const base = storeStats()
    const today = todayCounts()
    const membership = await membershipStats()
    const summary = summaryStatus()
    return {
      ok: true,
      ...base,
      todayEvents: today.events,
      today: today.events,
      todaySince: today.since,
      phase: phaseNow(),
      membership,
      summary,
    }
  }

  if (pathname === `${API_PREFIX}/hub/event`) {
    const id = query.get('id') || ''
    if (!id) return { ok: false, error: '缺少事件 id' }
    const event = getEvent(id)
    if (!event) return { ok: false, error: '事件不存在或已过期' }
    return { ok: true, event }
  }

  if (pathname === `${API_PREFIX}/hub/digest`) {
    const digest = await import('./digest.js')
    if (method === 'POST') {
      const body = await readJsonBody(req)
      const date = body && body.date ? String(body.date) : undefined
      const result = await digest.generateDigest({ date })
      if (!result.ok) return { ok: false, ...result }
      // publish:true 时顺手投喂知识库（同一个 html 文件）；发布失败不影响文件已生成的事实。
      if (body && body.publish === true) {
        const published = await digest.publishDigest({ date: result.date })
        return { ok: true, ...result, published }
      }
      return { ok: true, ...result }
    }
    const limit = Math.max(1, Math.min(120, numArg(query.get('limit'), 30)))
    const list = await digest.listDigests({ limit })
    return { ok: true, digests: list }
  }

  if (pathname === `${API_PREFIX}/hub/frontpage`) {
    const hours = numArg(query.get('hours'), 24)
    const frontpage = await getFrontpage({ sinceHours: hours })
    return { ok: true, frontpage }
  }

  if (pathname === `${API_PREFIX}/hub/config`) {
    const module = await import('./sources.js')
    const adapters = Array.isArray(module.SOURCES) ? module.SOURCES : []
    if (method === 'POST') {
      const body = await readJsonBody(req)
      if (!body || !Array.isArray(body.sources)) return { ok: false, error: '请求体需要形如 {"sources":[{id,enabled,intervalMs}]}' }
      const saved = await saveConfigUpdates(body.sources, adapters)
      if (!saved.ok) return { ok: false, error: saved.error }
      return {
        ok: true,
        updatedAt: saved.config.updatedAt,
        sources: describeSources(adapters, saved.config),
        configPath: configFilePath(),
      }
    }
    const config = await loadConfig()
    return {
      ok: true,
      error: config._error || '',
      updatedAt: config.updatedAt || 0,
      sources: describeSources(adapters, config),
      configPath: configFilePath(),
    }
  }

  if (pathname === `${API_PREFIX}/hub/model`) {
    const catalog = await modelCatalog(ctxRef)
    if (method === 'POST') {
      const body = await readJsonBody(req)
      if (!body || typeof body !== 'object') return { ok: false, error: '请求体需要 {"provider","model"}' }
      const provider = String(body.provider || '').trim()
      const model = String(body.model || '').trim()
      if (!provider || !model) {
        const saved = await saveLlmSelection('', '')
        if (!saved.ok) return { ok: false, error: saved.error }
        return { ok: true, selected: null, ...(await modelStatus(ctxRef, null)) }
      }
      const entry = (catalog.providers || []).find((item) => item.id === provider)
      const known = entry && (entry.models || []).some((item) => item.id === model)
      if (!known) return { ok: false, error: `模型不可用：${provider}/${model}` }
      const saved = await saveLlmSelection(provider, model)
      if (!saved.ok) return { ok: false, error: saved.error }
      return { ok: true, selected: { provider, model }, ...(await modelStatus(ctxRef, { provider, model })) }
    }
    return { ok: true, ...(await modelStatus(ctxRef, await loadLlmSelection())) }
  }

  if (pathname === `${API_PREFIX}/hub/summarize`) {
    if (method !== 'POST') return { ok: false, error: 'summarize 只接受 POST' }
    if (!ctxRef) return { ok: false, error: '宿主上下文不可用' }
    const result = await runSummaries(ctxRef, { maxPerRun: 3, log: (line) => console.log(`[dsh-wallstreet] hub ${line}`) })
    return { ok: true, ...result }
  }

  if (pathname === `${API_PREFIX}/hub/sync`) {
    if (method !== 'POST') return { ok: false, error: 'sync 只接受 POST' }
    const result = await runIngest({ force: true, log: (line) => console.log(`[dsh-wallstreet] hub ${line}`) })
    return { ok: true, ...result }
  }

  return undefined
}

/**
 * 工具输出里来自外部的内容必须截断（参照 rss 插件的 PROMPT_* 常量）。
 * 理由：标题/链接/来源名的长度由上游决定，一个把 <title> 写成 1MB 的源
 * 就能把工具结果撑爆；而模型侧没有任何一层会替我们截。
 */
const TOOL_TITLE_LIMIT = 120
const TOOL_LINK_LIMIT = 300
const TOOL_LABEL_LIMIT = 40
const TOOL_SUMMARY_LIMIT = 100
/** 整个工具输出的字符上限：超过就停止追加条目并注明「还有 N 条未列出」。 */
const TOOL_OUTPUT_LIMIT = 8000

/** 按字符截断并加省略号。 */
function clipText(value, limit) {
  const text = String(value == null ? '' : value)
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** 只放行 http(s) 链接：外部喂进来的 `javascript:` / `data:` 不该出现在模型上下文里。 */
function safeLink(url) {
  const text = String(url || '').trim()
  if (!text) return ''
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return clipText(parsed.toString(), TOOL_LINK_LIMIT)
  } catch {
    return ''
  }
}

/** 工具里的一行：时间 [类型] 标题 · N家 · 代码 · 链接。 */
function formatEventLine(event) {
  const parts = [formatStamp(event.ts)]
  const type = event.eventType ? `[${event.eventType}]` : `[${KIND_LABELS[event.kind] || event.kind}]`
  parts.push(type, clipText(event.title, TOOL_TITLE_LIMIT))
  if (event.sourceCount > 1) parts.push(`(${event.sourceCount} 家)`)
  if (event.tickers && event.tickers.length > 0) parts.push(event.tickers.slice(0, 3).join('/'))
  const head = parts.join(' ')
  const ai = event.llm && event.llm.summary
    ? `\n    AI：${clipText(event.llm.summary, TOOL_SUMMARY_LIMIT)}（${event.llm.sentiment || '中性'}）`
    : ''
  const link = safeLink(event.url)
  return `${head}${ai}${link ? `\n    ${link}` : ''}`
}

/** 给模型看的正文：纯文本，最多 limit 条，末尾一行统计。 */
export function formatNewsResult(args = {}) {
  const sinceHours = Math.max(1, Math.min(24 * 14, numArg(args.sinceHours, 24)))
  const limit = clampLimit(args.limit, 20, 50)
  const since = Date.now() - sinceHours * 3_600_000
  const { events, total } = queryFeed({
    since,
    limit,
    q: args.query || '',
    ticker: args.ticker || '',
    sector: args.sector || '',
    sectorVariants: sectorVariants(args.sector || ''),
    kind: args.kind || '',
    minImportance: numArg(args.minImportance, 0),
  })
  const scope = [
    args.ticker ? `个股 ${args.ticker}` : '',
    args.sector ? `板块 ${args.sector}` : '',
    args.query ? `关键词「${args.query}」` : '',
    args.kind ? KIND_LABELS[args.kind] || args.kind : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const header = `近 ${sinceHours} 小时资讯${scope ? `（${scope}）` : ''}：` + (events.length === 0 ? '无匹配' : `共 ${total} 个事件，列 ${events.length} 条`)
  if (events.length === 0) {
    return `${header}\n\n没有匹配的资讯。可以放宽 sinceHours（最长 336 小时）或去掉筛选条件再查一次。`
  }
  const lines = []
  let used = header.length
  let shown = 0
  for (const [index, event] of events.entries()) {
    const line = `${index + 1}. ${formatEventLine(event)}`
    if (used + line.length > TOOL_OUTPUT_LIMIT) {
      lines.push(`…（还有 ${events.length - index} 条未列出，缩小 sinceHours 或加筛选条件）`)
      break
    }
    lines.push(line)
    used += line.length + 1
    shown += 1
  }
  const bySource = new Map()
  for (const event of events) {
    for (const entry of event.sources || []) bySource.set(entry.label || entry.source, (bySource.get(entry.label || entry.source) || 0) + 1)
  }
  const sourceLine = [...bySource.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${clipText(label, TOOL_LABEL_LIMIT)}${n}`)
    .join(' ')
  const aiNote = (() => {
    const status = summaryStatus()
    if (!status.summarized) return ''
    const failed = (status.failures || []).reduce((sum, item) => sum + item.count, 0)
    if (failed === 0) return `｜AI 摘要 ${status.summarized} 条`
    const top = (status.failures || []).slice(0, 2).map((item) => `${item.reason}×${item.count}`).join('、')
    return `｜AI 摘要 ${status.summarized} 条（另有 ${failed} 条失败：${top}）`
  })()
  const phase = phaseNow()
  const phaseLabel = phase === 'trading' ? '盘中实时同步' : phase === 'weekend' ? '周末同步' : '非交易时段同步'
  const shownNote = shown < events.length ? `（已列 ${shown} / ${events.length}）` : ''
  return `${header}${shownNote}\n\n${lines.join('\n')}\n\n—— 来源分布：${sourceLine || '—'}｜数据口径：${phaseLabel}${aiNote}`
}

/** 模型侧的资讯查询工具。只读，不触发上游抓取（抓取由宿主调度器负责）。 */
export function createHubTools() {
  return [
    {
      name: 'wallstreet_news',
      description:
        '查询「华尔街之狼」资讯集散中心已入库的 A 股/宏观资讯事件（快讯、公告、研报、政策四类，多源已聚簇去重）。用中文关键词、个股代码、板块或事件类型筛选，返回带时间、事件类型、来源数与原文链接的纯文本清单。适合回答「今天某某板块有什么消息」「这只票最近有什么公告」这类问题；数据是本地已抓取的，不发起外部搜索。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '标题/摘要模糊关键词，例如「降准」「光伏」「业绩预告」。' },
          ticker: { type: 'string', description: '6 位个股代码，例如 601600；用于筛出关联该股的资讯。' },
          sector: { type: 'string', description: '板块/行业名，例如「有色金属」「半导体」。' },
          kind: {
            type: 'string',
            enum: ['flash', 'announcement', 'report', 'policy'],
            description: '限定资讯类型：flash=快讯、announcement=公告、report=研报、policy=政策。',
          },
          sinceHours: { type: 'number', description: '回溯小时数，默认 24，最长 336。' },
          limit: { type: 'number', description: '返回条数，默认 20，上限 50。' },
          minImportance: { type: 'number', description: '最低重要度 0–100，默认 0；70 以上约等于「值得看一眼」。' },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      },
      timeoutMs: 20_000,
      execute: async (args) => formatNewsResult(args || {}),
    },
  ]
}

/**
 * 宿主启动钩子：建库、拉调度器、按当前规则回填已入库条目的打标。
 * 返回清理函数。失败不冒泡——资讯中心挂了不能影响宿主加载。
 */
export function startHub({ ctx = null, log = console.log } = {}) {
  bindHubContext(ctx)
  try {
    openStore()
    log(`[dsh-wallstreet] 资讯库就绪：${metaGet('lastIngestAt', '尚未同步')}`)
  } catch (error) {
    log(`[dsh-wallstreet] 资讯库打开失败：${error && error.message ? error.message : error}`)
    return () => {}
  }
  const stopScheduler = startScheduler({ log: (line) => log(`[dsh-wallstreet] hub ${line}`) })
  // 首轮抓取跑完再回填，避免和入站抢同一个库；失败只记日志。
  const rescoreTimer = setTimeout(() => {
    rescoreRecent(3, Date.now(), (line) => log(`[dsh-wallstreet] hub ${line}`)).catch((error) =>
      log(`[dsh-wallstreet] 规则回填失败：${error && error.message ? error.message : error}`),
    )
  }, 20_000)
  if (typeof rescoreTimer.unref === 'function') rescoreTimer.unref()

  // 每天 23:30（北京时间）自动导出一份 Markdown 日报，供知识库/外部消费。
  // 为什么不是收盘后 15:35：A 股公告集中在 16:00–22:00 发布，15:35 出的日报会把当天
  // 最重要的一批公告全部漏到第二天。23:30 既覆盖了公告高峰，又留出半小时给抓取收尾。
  // 用 setTimeout 递推而不是 setInterval：跨天/重启都能算出下一次正确时刻。
  let digestTimer = null
  const planDigest = () => {
    const now = Date.now()
    const shifted = new Date(now + 8 * 3600_000)
    const nextUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 23, 30) - 8 * 3600_000
    const delay = nextUtc > now ? nextUtc - now : nextUtc + 24 * 3600_000 - now
    digestTimer = setTimeout(async () => {
      try {
        const module = await import('./digest.js')
        const result = await module.generateDigest()
        log(`[dsh-wallstreet] 日报${result.ok ? '已生成' : '生成失败'}：${result.ok ? result.path : result.error}`)
      } catch (error) {
        log(`[dsh-wallstreet] 日报生成异常：${error && error.message ? error.message : error}`)
      }
      planDigest()
    }, Math.max(60_000, delay))
    if (typeof digestTimer.unref === 'function') digestTimer.unref()
  }
  planDigest()

  // AI 摘要：只给高分事件写，5 分钟一轮、每轮最多 3 条；没有模型就安静跳过。
  let summaryRunning = false
  const summaryTimer = ctx
    ? setInterval(() => {
        if (summaryRunning) return
        summaryRunning = true
        runSummaries(ctx, { log: (line) => log(`[dsh-wallstreet] hub ${line}`) })
          .then((result) => {
            if (result && result.done > 0) log(`[dsh-wallstreet] hub AI 摘要 ${result.done} 条（${result.model}）`)
          })
          .catch((error) => log(`[dsh-wallstreet] AI 摘要失败：${error && error.message ? error.message : error}`))
          .finally(() => {
            summaryRunning = false
          })
      }, 5 * 60_000)
    : null
  if (summaryTimer && typeof summaryTimer.unref === 'function') summaryTimer.unref()

  return () => {
    clearTimeout(rescoreTimer)
    if (summaryTimer) clearInterval(summaryTimer)
    if (digestTimer) clearTimeout(digestTimer)
    stopScheduler()
  }
}
