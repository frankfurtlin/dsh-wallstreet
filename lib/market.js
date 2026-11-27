/**
 * dsh-wallstreet —— 行情数据层（2026-11-12 重构：文件快照 + 腾讯实时）。
 *
 * 数据源分层（这是本次重构的核心）：
 *  1. 收盘快照（文件）：market-report 管线每交易日 15:10 产出的
 *     data/market_data.json（指数/宽度/板块/成交额）、data/flow_full.json
 *     （行业资金流）以及 data/market_daily_snapshot.jsonl（历史成交额，用来算量能比）。
 *     盘中读到的是「上一交易日收盘」，收盘后是当日；响应里用 marketDate/dataTime/stale 标明。
 *  2. 腾讯公开行情：实时指数报价（qt.gtimg.cn，GBK）、分时（web.ifzq.gtimg.cn minute）、
 *     日 K（web.ifzq.gtimg.cn fqkline）。本机实测稳定，补足盘中实时与图形数据。
 *
 * 为什么不再用东财 push2/push2his：这台机器会被间歇性 RST 限流
 * （undici 报 UND_ERR_SOCKET，curl 空响应），导致面板大面积「暂不可用」。
 *
 * 可靠性约定（2026-11-12 事故教训）：缓存里存的 promise 必须永远有人消费 rejection，
 * 上游失败一律收敛成普通 Error（不带 socket 句柄）。
 */
import { readFile } from 'node:fs/promises'
import { createPartsRunner } from './hub/parts.js'

// 2026-11-25: 快照改落在插件自己的 data/ 下（采集管线直接写这里），可用 DSH_WALLSTREET_DATA_DIR 覆盖。
const MR_DATA = process.env.DSH_WALLSTREET_DATA_DIR || '/root/workspace/plugins/dsh-wallstreet/data'
const MARKET_JSON = process.env.DSH_WALLSTREET_MARKET_JSON || `${MR_DATA}/market_data.json`
const FLOW_JSON = process.env.DSH_WALLSTREET_FLOW_JSON || `${MR_DATA}/flow_full.json`
const SNAPSHOT_JSONL =
  process.env.DSH_WALLSTREET_SNAPSHOT || `${MR_DATA}/market_daily_snapshot.jsonl`

const QUOTE_URL = 'https://qt.gtimg.cn/q='
const MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query'
const KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'

/* 盘中实时源：东财（涨跌家数 / 涨停池 / 行业板块 / 涨跌幅榜）+ 新闻（新浪、华尔街见闻、巨潮）。 */
const LIVE_REFERER = 'https://quote.eastmoney.com/'
const EM_UT = '7eea3edcaed734bea9cbfc24409ed989'
const LIVE_BREADTH_URL = `https://push2ex.eastmoney.com/getTopicZDFenBu?ut=${EM_UT}&dpt=wz.ztzt`
const LIVE_ZT_URL = `https://push2ex.eastmoney.com/getTopicZTPool?ut=${EM_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=60&sort=fbt%3Aasc`
const LIVE_DT_URL = `https://push2ex.eastmoney.com/getTopicDTPool?ut=${EM_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=60&sort=fund%3Aasc`
const EM_CLIST = 'https://push2.eastmoney.com/api/qt/clist/get'
const EM_SECTOR_QUERY = 'pn=1&pz=100&fs=m%3A90%2Bt%3A2&fields=f2%2Cf3%2Cf6%2Cf12%2Cf14%2Cf62%2Cf104%2Cf105'
const LIVE_SECTOR_UP_URL = `${EM_CLIST}?${EM_SECTOR_QUERY}&po=1&fid=f3`
const LIVE_SECTOR_DOWN_URL = `${EM_CLIST}?${EM_SECTOR_QUERY}&po=0&fid=f3`
const LIVE_SECTOR_FLOW_IN_URL = `${EM_CLIST}?${EM_SECTOR_QUERY}&po=1&fid=f62`
const LIVE_SECTOR_FLOW_OUT_URL = `${EM_CLIST}?${EM_SECTOR_QUERY}&po=0&fid=f62`
const LIVE_MOVER_URL =
  'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=10&po=1&fid=f3&fs=m%3A0%2Bt%3A6%2Cm%3A0%2Bt%3A80%2Cm%3A1%2Bt%3A2%2Cm%3A1%2Bt%3A23&fields=f2%2Cf3%2Cf12%2Cf14'
const NEWS_SINA_URL = 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=24&page=1'
const NEWS_WSCN_URL = 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=24'
const NEWS_CNINFO_URL = 'https://www.cninfo.com.cn/new/hisAnnouncement/query'

/**
 * 兜底源：新浪（东财 push2 clist 在这台机器上会被间歇性限流，行业板块/涨跌幅榜改用新浪顶替）。
 * 行业板块 GBK JS 变量、个股排行 JSON，两个接口盘中都在更新。
 */
const SINA_HY_URL = 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php'
const SINA_RANK_URL =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'
const SINA_REFERER = 'https://finance.sina.com.cn/'

/**
 * 指数清单：group 决定前端分组（cn 大 A / hk 港股 / us 美股）。
 * `tencent` 是腾讯行情代码（qt/minute/kline 通用）；secid 保留给 /indices 接口与前端 key。
 */
export const INDICES = [
  { secid: '1.000001', code: '000001', name: '上证指数', group: 'cn', tencent: 'sh000001', trend: true, kline: true },
  { secid: '0.399001', code: '399001', name: '深证成指', group: 'cn', tencent: 'sz399001' },
  { secid: '0.399006', code: '399006', name: '创业板指', group: 'cn', tencent: 'sz399006' },
  { secid: '1.000688', code: '000688', name: '科创50', group: 'cn', tencent: 'sh000688' },
  { secid: '1.000300', code: '000300', name: '沪深300', group: 'cn', tencent: 'sh000300' },
  { secid: '1.000905', code: '000905', name: '中证500', group: 'cn', tencent: 'sh000905' },
  { secid: '100.HSI', code: 'HSI', name: '恒生指数', group: 'hk', tencent: 'hkHSI' },
  { secid: '100.NDX', code: 'NDX', name: '纳斯达克100', group: 'us', tencent: 'usNDX' },
  { secid: '100.DJIA', code: 'DJIA', name: '道琼斯', group: 'us', tencent: 'usDJI' },
  { secid: '100.SPX', code: 'SPX', name: '标普500', group: 'us', tencent: 'usINX' },
]

/** 各缓存 TTL（毫秒）：实时报价 15s、分时 30s、K 线 5min、收盘快照 60s、成交额历史 5min。 */
const TTL = {
  quotes: 15_000,
  trend: 30_000,
  kline: 300_000,
  snapshot: 60_000,
  flow: 60_000,
  amountHistory: 300_000,
  liveBreadth: 60_000,
  liveSectors: 60_000,
  liveMovers: 60_000,
  news: 60_000,
}

const cache = new Map()

/** 带 TTL + 并发去重的缓存：同一个 key 在过期前只打一次上游。 */
/**
 * 每个 key 最近一次**成功**的值。`cached()` 的 promise 一旦失败就被替换成 3 秒负缓存，
 * 拿不到旧值了；「失败但有旧值就返回旧值」需要单独留一份，见 peekCached()。
 */
const lastGood = new Map()

/** 读最近一次成功值（不看过期）：给分区四态兜底用。 */
function peekCached(key) {
  const entry = lastGood.get(key)
  if (!entry) return undefined
  return { value: entry.value, staleMs: Math.max(0, Date.now() - entry.at) }
}

function cached(key, ttlMs, loader) {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.promise
  const promise = (async () => {
    try {
      const value = await loader()
      lastGood.set(key, { value, at: Date.now() })
      if (lastGood.size > 64) {
        for (const oldKey of lastGood.keys()) {
          if (lastGood.size <= 64) break
          if (oldKey !== key) lastGood.delete(oldKey)
        }
      }
      return value
    } catch (error) {
      // 失败也缓存一小会儿，避免前端轮询把故障上游刷爆。
      // 缓存里放的是已经挂过 catch 的 promise：绝不产生孤儿 unhandled rejection。
      const failed = Promise.reject(error)
      failed.catch(() => {})
      cache.set(key, { expires: Date.now() + 3_000, promise: failed, failed: true })
      throw error
    }
  })()
  cache.set(key, { expires: now + ttlMs, promise })
  if (cache.size > 64) {
    for (const [oldKey, entry] of cache) {
      if (entry.expires <= now) cache.delete(oldKey)
    }
  }
  return promise
}

const RETRY_DELAYS = [400, 900]

/** 连接类抖动（RST / 超时 / DNS）才重试；HTTP 4xx、解析错不重试。 */
function isRetryable(error) {
  if (!error) return false
  const code = error.code || (error.cause && error.cause.code)
  if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
    return true
  }
  if (error.name === 'TypeError' || error.name === 'AbortError') return true
  return /fetch failed|socket|network|timed? ?out|ECONNRESET/i.test(String(error.message || ''))
}

/**
 * 单次 HTTP 取文本（支持 GBK 编码的上游），失败收敛成普通 Error。
 * @param {string} url
 * @param {{ encoding?: string, label?: string }} options
 */
async function fetchTextOnce(url, options = {}) {
  const label = options.label || '行情上游'
  const response = await fetch(url, {
    headers: {
      accept: '*/*',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      referer: options.referer || 'https://gu.qq.com/',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw new Error(`${label}返回空响应`)
  return new TextDecoder(options.encoding || 'utf-8').decode(buffer)
}

async function fetchText(url, options = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    try {
      return await fetchTextOnce(url, options)
    } catch (error) {
      lastError = error
      if (!isRetryable(error) || attempt === RETRY_DELAYS.length) break
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]))
    }
  }
  const reason = lastError && lastError.message ? lastError.message : '未知错误'
  const wrapped = new Error(`${options.label || '行情上游'}不可用：${reason}`)
  wrapped.code = 'WALLSTREET_UPSTREAM_FAILED'
  throw wrapped
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${options.label || '行情上游'}返回非 JSON`)
  }
}

/** POST 表单取 JSON（巨潮公告查询用）。 */
async function fetchJsonPost(url, body, options = {}) {
  const label = options.label || '公告上游'
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        referer: options.referer || 'https://www.cninfo.com.cn/',
      },
      body,
      signal: AbortSignal.timeout(8_000),
    })
  } catch (error) {
    const wrapped = new Error(`${label}不可用：${error && error.message ? error.message : '网络错误'}`)
    wrapped.code = 'WALLSTREET_UPSTREAM_FAILED'
    throw wrapped
  }
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`)
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label}返回非 JSON`)
  }
}

function num(value) {
  if (value === '-' || value === '' || value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 管线产出的 JSON 里可能带裸 NaN / Infinity（Python json.dumps 允许），JSON.parse 会炸；先换 null。 */
function tolerantParse(text) {
  return JSON.parse(
    String(text)
      .replace(/([:[,]\s*)(?:NaN|-?Infinity)\b/g, '$1null'),
  )
}

async function readJsonFile(path, label) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`${label}不可用：读取 ${path} 失败（${error.code || error.message}）`)
  }
  if (!text.trim()) throw new Error(`${label}不可用：${path} 为空`)
  try {
    return tolerantParse(text)
  } catch (error) {
    throw new Error(`${label}不可用：${path} 解析失败（${error.message}）`)
  }
}

// 日内成交额分布锚点（分钟 → 累计占比），用于把盘中成交额折成全天预计值。
const VOLUME_ANCHORS = [
  [0, 0],
  [30, 0.22],
  [60, 0.33],
  [120, 0.52],
  [150, 0.62],
  [180, 0.75],
  [210, 0.85],
  [240, 1],
]

/** 当前时刻已走完的交易分钟占比（0–1）；午休按 11:30 计，盘前 0，收盘后 1。 */
export function elapsedTradingFraction(now = new Date()) {
  const b = beijingNow(now)
  if (b.isWeekend) return 0
  const t = b.hour * 60 + b.minute
  const amStart = 9 * 60 + 30
  const amEnd = 11 * 60 + 30
  const pmStart = 13 * 60
  const pmEnd = 15 * 60
  let elapsed
  if (t <= amStart) elapsed = 0
  else if (t <= amEnd) elapsed = t - amStart
  else if (t < pmStart) elapsed = 120
  else if (t <= pmEnd) elapsed = 120 + (t - pmStart)
  else elapsed = 240
  const progress = elapsed / 240
  for (let i = 1; i < VOLUME_ANCHORS.length; i += 1) {
    const [m0, p0] = VOLUME_ANCHORS[i - 1]
    const [m1, p1] = VOLUME_ANCHORS[i]
    if (elapsed <= m1) {
      const ratio = m1 === m0 ? 0 : (elapsed - m0) / (m1 - m0)
      return p0 + (p1 - p0) * ratio
    }
  }
  return progress
}

/** 北京时间分解，用于交易时段判断与「数据日期」兜底。 */
export function beijingNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now)
  const get = (type) => parts.find((part) => part.type === type)?.value || ''
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  const weekday = get('weekday')
  const minutes = hour * 60 + minute
  const isWeekend = weekday === '周六' || weekday === '周日'
  let session = 'closed'
  if (!isWeekend) {
    if (minutes >= 9 * 60 + 15 && minutes < 11 * 60 + 30) session = 'trading'
    else if (minutes >= 11 * 60 + 30 && minutes < 13 * 60) session = 'lunch'
    else if (minutes >= 13 * 60 && minutes < 15 * 60) session = 'trading'
    else if (minutes >= 15 * 60 && minutes < 15 * 60 + 30) session = 'closing'
    else if (minutes < 9 * 60 + 15) session = 'preopen'
  }
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    compactDate: `${get('year')}${get('month')}${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    hour,
    minute,
    weekday,
    isWeekend,
    session,
    iso: now.toISOString(),
  }
}


/* ------------------------------ 盘中实时层 ------------------------------ */
/**
 * 盘中实时数据：涨跌家数 / 涨停池 / 行业板块 / 涨跌幅榜 / 新闻。
 * 全部 60s 缓存（用户可接受 1 分钟延迟），盘后由收盘快照兜底。
 * 归一化成与快照一致的字段名，前端只按 dataMode / sources 标角标。
 */

/** 东财涨停池的首封时间是 92500 这种整数（HHMMSS）。 */
function formatSealTime(value) {
  const text = String(value == null ? '' : value)
  if (/^\d{5,6}$/.test(text)) {
    const padded = text.padStart(6, '0')
    return `${padded.slice(0, 2)}:${padded.slice(2, 4)}:${padded.slice(4, 6)}`
  }
  return text || null
}

function mapZtRow(row) {
  return {
    name: row.n || '',
    code: String(row.c || ''),
    pct: num(row.zdp),
    firstSeal: formatSealTime(row.fbt),
    industry: row.hybk || '',
    boardCount: num(row.lbc),
    breakCount: num(row.zbc),
  }
}

/** 东财 clist 的 diff 有时是数组、有时是 {"0":{...}} 的对象。 */
function diffRows(json) {
  const diff = json && json.data && json.data.diff
  if (Array.isArray(diff)) return diff
  if (diff && typeof diff === 'object') return Object.values(diff)
  return []
}

/** 盘中涨跌家数 + 涨跌停家数（东财 push2ex，60s 缓存）。 */
async function loadLiveBreadth() {
  const date = beijingNow().compactDate
  const [fenbuJson, ztJson, dtJson] = await Promise.all([
    fetchJson(LIVE_BREADTH_URL, { label: '涨跌家数', referer: LIVE_REFERER }),
    fetchJson(`${LIVE_ZT_URL}&date=${date}`, { label: '涨停池', referer: LIVE_REFERER }).catch(() => null),
    fetchJson(`${LIVE_DT_URL}&date=${date}`, { label: '跌停池', referer: LIVE_REFERER }).catch(() => null),
  ])
  const buckets = Array.isArray(fenbuJson && fenbuJson.data && fenbuJson.data.fenbu) ? fenbuJson.data.fenbu : []
  let up = 0
  let down = 0
  let flat = 0
  let bucketZt = 0
  let bucketDt = 0
  for (const bucket of buckets) {
    for (const [key, value] of Object.entries(bucket || {})) {
      const count = num(value) || 0
      const level = Number(key)
      if (!Number.isFinite(level)) continue
      if (level > 0) up += count
      else if (level < 0) down += count
      else flat += count
      if (level >= 10) bucketZt = Math.max(bucketZt, count)
      if (level <= -10) bucketDt = Math.max(bucketDt, count)
    }
  }
  if (up + down + flat === 0) throw new Error('涨跌家数为空')
  const ztRows = ((ztJson && ztJson.data && ztJson.data.pool) || []).map(mapZtRow)
  return {
    date,
    breadth: {
      up,
      down,
      flat,
      total: up + down + flat,
      up5: null,
      down5: null,
      limitUp: num(ztJson && ztJson.data && ztJson.data.tc) ?? bucketZt,
      limitDown: num(dtJson && dtJson.data && dtJson.data.tc) ?? bucketDt,
      totalAmount: null,
      upRatio: null,
    },
    ztRows,
  }
}

const toSectorView = (row) => ({
  code: row.code,
  name: row.name,
  changePct: row.changePct,
  mainInflow: row.mainInflow,
})
const toFlowView = (row) => ({
  industry: row.name,
  changePct: row.changePct,
  net: row.mainInflow,
  leadStock: null,
  leadPct: null,
})

/** 新浪行业板块（GBK JS 变量）：东财 push2 被限流时顶替涨跌幅榜，返回 [{code,name,changePct}]。 */
async function loadSinaSectors() {
  const text = await fetchText(SINA_HY_URL, { label: '新浪行业板块', encoding: 'gbk', referer: SINA_REFERER })
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('新浪行业板块返回格式异常')
  const raw = JSON.parse(text.slice(start, end + 1))
  const rows = []
  for (const value of Object.values(raw)) {
    const parts = String(value).split(',')
    if (parts.length < 6) continue
    const changePct = num(parts[5])
    if (!Number.isFinite(changePct)) continue
    rows.push({ code: parts[0], name: parts[1], changePct, mainInflow: null })
  }
  if (rows.length === 0) throw new Error('新浪行业板块为空')
  return rows
}

/** 新浪个股排行（沪深 A 股，changepercent 排序）：顶替东财涨跌幅榜。 */
async function loadSinaMovers(direction) {
  const asc = direction === 'bottom' ? 1 : 0
  const label = direction === 'bottom' ? '新浪跌幅榜' : '新浪涨幅榜'
  const url = `${SINA_RANK_URL}?page=1&num=10&sort=changepercent&asc=${asc}&node=hs_a&symbol=&_s_r_a=page`
  const raw = await fetchJson(url, { label, referer: SINA_REFERER })
  if (!Array.isArray(raw)) throw new Error(`${label}返回格式异常`)
  return raw
    .map((row) => ({
      code: String(row.code || '').trim(),
      name: String(row.name || '').trim(),
      price: num(row.trade),
      pct: num(row.changepercent),
    }))
    .filter((row) => row.code && row.name && Number.isFinite(row.pct))
}

/**
 * 盘中行业板块（涨跌幅前 8/后 8）+ 主力净流入前 6/后 6（东财 clist，60s 缓存）。
 * 东财 push2 被限流时：涨跌幅榜切新浪兜底，资金流无免费替代源，交给收盘快照降级。
 */
async function loadLiveSectors() {
  const [upResult, downResult, inResult, outResult] = await Promise.allSettled([
    fetchJson(LIVE_SECTOR_UP_URL, { label: '行业涨幅榜', referer: LIVE_REFERER }),
    fetchJson(LIVE_SECTOR_DOWN_URL, { label: '行业跌幅榜', referer: LIVE_REFERER }),
    fetchJson(LIVE_SECTOR_FLOW_IN_URL, { label: '行业净流入', referer: LIVE_REFERER }),
    fetchJson(LIVE_SECTOR_FLOW_OUT_URL, { label: '行业净流出', referer: LIVE_REFERER }),
  ])
  const toSector = (row) => ({
    code: String(row.f12 || ''),
    name: row.f14 || '',
    changePct: num(row.f3) != null ? num(row.f3) / 100 : null,
    mainInflow: num(row.f62),
  })
  const warnings = []
  const readRows = (result) => {
    if (result.status === 'fulfilled') {
      return diffRows(result.value).map(toSector).filter((row) => Number.isFinite(row.changePct))
    }
    return []
  }
  let upRows = readRows(upResult)
  let downRows = readRows(downResult)
  const inRows = readRows(inResult)
  const outRows = readRows(outResult)
  if (upRows.length === 0 || downRows.length === 0) {
    try {
      const sinaRows = await loadSinaSectors()
      const byDesc = sinaRows.slice().sort((a, b) => b.changePct - a.changePct)
      if (upRows.length === 0) upRows = byDesc
      if (downRows.length === 0) downRows = byDesc.slice().reverse()
      warnings.push('东财行业板块接口异常，涨跌幅榜已切换新浪源')
    } catch (error) {
      warnings.push(`行业板块兜底失败：${error && error.message ? error.message : '未知错误'}`)
    }
  }
  if (upRows.length === 0) throw new Error('行业板块为空')
  const sortByFlowDesc = (rows) => rows.filter((row) => Number.isFinite(row.mainInflow)).sort((a, b) => b.mainInflow - a.mainInflow)
  const inflow = sortByFlowDesc(inRows)
  const outflow = sortByFlowDesc(outRows)
  return {
    sectors: {
      gainers: upRows.slice(0, 8).map(toSectorView),
      losers: downRows.slice(0, 8).map(toSectorView),
    },
    // 资金流只有东财口径：拿不到就返回 null，调用方按收盘快照降级并标注来源
    sectorFlow:
      inflow.length || outflow.length
        ? { top: inflow.slice(0, 6).map(toFlowView), bottom: outflow.slice(0, 6).map(toFlowView) }
        : null,
    warnings,
  }
}

async function loadLiveMovers() {
  const date = beijingNow().compactDate
  // 三个请求彼此独立：涨/跌幅榜一个失败不应连带丢掉涨停池与另一个榜
  const [topResult, bottomResult, ztResult] = await Promise.allSettled([
    fetchJson(LIVE_MOVER_URL, { label: '涨幅榜', referer: LIVE_REFERER }),
    fetchJson(LIVE_MOVER_URL.replace('po=1', 'po=0'), { label: '跌幅榜', referer: LIVE_REFERER }),
    fetchJson(`${LIVE_ZT_URL}&date=${date}`, { label: '涨停池', referer: LIVE_REFERER }),
  ])
  const mapMover = (row) => ({
    code: String(row.f12 || ''),
    name: row.f14 || '',
    price: num(row.f2) != null ? num(row.f2) / 100 : null,
    pct: num(row.f3) != null ? num(row.f3) / 100 : null,
  })
  const ztJson = ztResult.status === 'fulfilled' ? ztResult.value : null
  let top = topResult.status === 'fulfilled' ? diffRows(topResult.value).slice(0, 8).map(mapMover) : []
  let bottom = bottomResult.status === 'fulfilled' ? diffRows(bottomResult.value).slice(0, 8).map(mapMover) : []
  const warnings = []
  if (ztResult.status === 'rejected') warnings.push('涨停池：' + (ztResult.reason && ztResult.reason.message))
  if (top.length === 0 || bottom.length === 0) {
    // 东财 push2 被限流时用新浪个股排行兜底；涨停池仍由 push2ex 提供，不受影响
    const [sinaTop, sinaBottom] = await Promise.allSettled([loadSinaMovers('top'), loadSinaMovers('bottom')])
    if (top.length === 0 && sinaTop.status === 'fulfilled' && sinaTop.value.length > 0) top = sinaTop.value.slice(0, 8)
    if (bottom.length === 0 && sinaBottom.status === 'fulfilled' && sinaBottom.value.length > 0) {
      bottom = sinaBottom.value.slice(0, 8)
    }
    const sinaOk = [sinaTop, sinaBottom].some((result) => result.status === 'fulfilled' && result.value.length > 0)
    if (sinaOk) {
      warnings.push('东财涨跌幅榜接口异常，已切换新浪源')
    } else {
      if (top.length === 0) warnings.push('涨幅榜：' + (topResult.reason && topResult.reason.message))
      if (bottom.length === 0) warnings.push('跌幅榜：' + (bottomResult.reason && bottomResult.reason.message))
    }
  }
  if (top.length === 0 && bottom.length === 0 && !ztJson) throw new Error('实时异动三个接口都不可用')
  return {
    top,
    bottom,
    ztRows: ((ztJson && ztJson.data && ztJson.data.pool) || []).map(mapZtRow),
    limitUp: num(ztJson && ztJson.data && ztJson.data.tc),
    warnings,
  }
}

function formatNewsTime(value) {
  const stamp = Number(value)
  if (!Number.isFinite(stamp) || stamp <= 0) return ''
  const date = new Date(stamp)
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace(/\//g, '-')
}

function cleanText(text, maxLength) {
  const value = String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length > maxLength ? value.slice(0, maxLength) + '…' : value
}

/**
 * 消息源：新浪财经滚动、华尔街见闻快讯、巨潮沪深公告。全部带原文链接（可点击跳转）。
 * 任一源失败只少几条，不影响其它源；结果按时间倒序。
 */
async function loadLiveNews(limit = 40) {
  const now = beijingNow()
  const cninfoBody = (column, plate) =>
    `pageNum=1&pageSize=12&column=${column}&tabName=fulltext&plate=${plate}&seDate=${now.date}~${now.date}&sortName=time&sortType=desc&isHLtitle=true`
  const results = await Promise.allSettled([
    fetchJson(NEWS_SINA_URL, { label: '新浪财经', referer: 'https://finance.sina.com.cn/' }),
    fetchJson(NEWS_WSCN_URL, { label: '华尔街见闻', referer: 'https://wallstreetcn.com/' }),
    fetchJsonPost(NEWS_CNINFO_URL, cninfoBody('szse', 'sz'), { label: '巨潮公告' }),
    fetchJsonPost(NEWS_CNINFO_URL, cninfoBody('sse', 'sh'), { label: '巨潮公告' }),
  ])
  const items = []
  const warnings = []
  const [sinaResult, wscnResult, cninfoSz, cninfoSh] = results

  if (sinaResult.status === 'fulfilled') {
    const list = (sinaResult.value && sinaResult.value.result && sinaResult.value.result.data) || []
    for (const row of Array.isArray(list) ? list : []) {
      if (!row || !row.title) continue
      items.push({
        time: formatNewsTime(num(row.ctime) != null ? num(row.ctime) * 1000 : null),
        stamp: num(row.ctime) != null ? num(row.ctime) * 1000 : 0,
        title: cleanText(row.title, 80),
        summary: cleanText(row.intro, 110),
        source: row.media_name || '新浪财经',
        url: row.url || 'https://finance.sina.com.cn/',
      })
    }
  } else {
    warnings.push(`新浪财经：${sinaResult.reason && sinaResult.reason.message ? sinaResult.reason.message : '不可用'}`)
  }

  if (wscnResult.status === 'fulfilled') {
    const list = (wscnResult.value && wscnResult.value.data && wscnResult.value.data.items) || []
    for (const row of Array.isArray(list) ? list : []) {
      const content = cleanText(row.content_text || row.title, 160)
      if (!content) continue
      items.push({
        time: formatNewsTime(num(row.display_time) != null ? num(row.display_time) * 1000 : null),
        stamp: num(row.display_time) != null ? num(row.display_time) * 1000 : 0,
        title: cleanText(content.split(/[。！？]/)[0] || content, 60),
        summary: content,
        source: '华尔街见闻',
        url: row.uri || 'https://wallstreetcn.com/livenews',
      })
    }
  } else {
    warnings.push(`华尔街见闻：${wscnResult.reason && wscnResult.reason.message ? wscnResult.reason.message : '不可用'}`)
  }

  for (const [result, label] of [
    [cninfoSz, '巨潮深市公告'],
    [cninfoSh, '巨潮沪市公告'],
  ]) {
    if (result.status !== 'fulfilled') {
      warnings.push(`${label}：${result.reason && result.reason.message ? result.reason.message : '不可用'}`)
      continue
    }
    for (const row of (result.value && result.value.announcements) || []) {
      if (!row || !row.announcementTitle) continue
      const stamp = num(row.announcementTime)
      items.push({
        time: formatNewsTime(stamp),
        stamp: stamp || 0,
        title: cleanText(`${row.secName || ''}：${row.announcementTitle}`, 90),
        summary: '',
        source: '巨潮公告',
        url: row.adjunctUrl ? `https://static.cninfo.com.cn/${row.adjunctUrl}` : 'https://www.cninfo.com.cn/',
      })
    }
  }

  items.sort((a, b) => b.stamp - a.stamp)
  const size = Math.max(1, Math.min(80, Number(limit) || 40))
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    items: items.slice(0, size),
    total: items.length,
    warnings,
  }
}

/* ------------------------------ 收盘快照（文件） ------------------------------ */

/** 读 market_data.json：盘面要用的指数/宽度/板块/成交额都在这里。 */
async function loadSnapshot() {
  const json = await readJsonFile(MARKET_JSON, '收盘快照')
  if (!json || !Array.isArray(json.idx)) throw new Error('收盘快照不可用：缺少 idx')
  const fetchTime = String(json.fetch_time || '')
  return {
    date: fetchTime.slice(0, 10),
    time: fetchTime.slice(11, 19),
    indices: json.idx.map((row) => ({
      code: String(row.code || ''),
      name: row.name || '',
      price: num(row.price),
      change: num(row.chg),
      changePct: num(row.pct),
      turnover: num(row.amount_yi) != null ? num(row.amount_yi) * 1e8 : null,
    })),
    breadth: {
      up: num(json.breadth?.up),
      down: num(json.breadth?.dn),
      flat: num(json.breadth?.flat),
      total: num(json.breadth?.total),
      up5: num(json.breadth?.up5),
      down5: num(json.breadth?.dn5),
      limitUp: num(json.breadth?.zt),
      limitDown: num(json.breadth?.dt),
      totalAmount: num(json.breadth?.total_amt) != null ? num(json.breadth?.total_amt) * 1e8 : null,
      upRatio: null,
    },
    sectors: (json.sectors || []).map((row) => ({
      name: row.name || '',
      count: num(row.count),
      changePct: num(row.avg_pct),
      change: num(row.avg_chg),
    })),
    sectorFlow: (json.sector_flow || []).map((row) => ({
      industry: row['行业'] || row.industry || '',
      changePct: num(row['行业-涨跌幅']),
      net: num(row['净额']) != null ? num(row['净额']) * 1e8 : null,
      inflow: num(row['流入资金']) != null ? num(row['流入资金']) * 1e8 : null,
      outflow: num(row['流出资金']) != null ? num(row['流出资金']) * 1e8 : null,
      leadStock: row['领涨股'] || '',
      leadPct: num(row['领涨股-涨跌幅']),
      companies: num(row['公司家数']),
    })),
    ztPool: json.zt_pool || [],
    ztPoolPrev: json.zt_pool_prev || [],
    lhb: json.lhb || [],
    movers: { top: json.top10 || [], bottom: json.bot10 || [] },
    valuation: json.valuation || {},
    margin: json.margin_sh || json.margin_sz ? { sh: json.margin_sh || null, sz: json.margin_sz || null } : null,
    futures: json.futures || null,
    omo: json.omo || [],
    news: json.news || [],
    clsNews: json.cls_news || [],
    announcements: json.cninfo || [],
    commodities: {
      bc: json.bc_index || null,
      gold: json.sge_gold || null,
      silver: json.sge_silver || null,
      copper: json.cu_main || null,
      aluminum: json.al_main || null,
    },
  }
}

/** 读 flow_full.json：行业资金流向榜（净额单位换算成元）。 */
async function loadFlow() {
  const json = await readJsonFile(FLOW_JSON, '资金流向')
  const map = (rows) =>
    (Array.isArray(rows) ? rows : []).map((row) => ({
      industry: row['行业'] || row.industry || '',
      changePct: num(row['行业-涨跌幅']),
      net: num(row['净额']) != null ? num(row['净额']) * 1e8 : null,
      inflow: num(row['流入资金']) != null ? num(row['流入资金']) * 1e8 : null,
      outflow: num(row['流出资金']) != null ? num(row['流出资金']) * 1e8 : null,
      leadStock: row['领涨股'] || '',
      leadPct: num(row['领涨股-涨跌幅']),
    }))
  return { inflow: map(json.inflow), outflow: map(json.outflow), total: map(json.total) }
}

/** 读历史成交额（market_daily_snapshot.jsonl），用于「量能比 = 今日 / 前 5 日均值」。 */
async function loadAmountHistory() {
  let text
  try {
    text = await readFile(SNAPSHOT_JSONL, 'utf8')
  } catch (error) {
    throw new Error(`成交额历史不可用：读取 ${SNAPSHOT_JSONL} 失败（${error.code || error.message}）`)
  }
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const row = JSON.parse(trimmed)
      const amt = num(row.amt)
      if (row.date && amt != null) rows.push({ date: String(row.date), amount: amt })
    } catch {
      /* 最后一行可能写了一半，跳过 */
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1))
  return rows
}

/* ------------------------------ 腾讯实时行情 ------------------------------ */

/** 实时指数报价（GBK 编码，一次拉全部）。 */
async function loadQuotes() {
  const text = await fetchText(QUOTE_URL + INDICES.map((item) => item.tencent).join(','), {
    encoding: 'gbk',
    label: '腾讯指数报价',
  })
  const parsed = new Map()
  for (const chunk of text.split(';')) {
    const match = /v_(\w+)="([^"]*)"/.exec(chunk.trim())
    if (!match) continue
    const fields = match[2].split('~')
    parsed.set(match[1], {
      name: fields[1] || '',
      price: num(fields[3]),
      prevClose: num(fields[4]),
      change: num(fields[31]),
      changePct: num(fields[32]),
      high: num(fields[33]),
      low: num(fields[34]),
      turnover: num(fields[37]) != null ? num(fields[37]) * 1e4 : null,
    })
  }
  if (parsed.size === 0) throw new Error('腾讯指数报价不可用：响应为空')
  return INDICES.map((meta) => {
    const quote = parsed.get(meta.tencent) || {}
    // 腾讯的成交额字段只有 A 股口径可信（人民币），港股/美股留空，避免卡片显示荒谬数字。
    const turnover = meta.group === 'cn' ? (quote.turnover ?? null) : null
    return {
      secid: meta.secid,
      code: meta.code,
      name: meta.name,
      group: meta.group,
      price: quote.price ?? null,
      prevClose: quote.prevClose ?? null,
      change: quote.change ?? null,
      changePct: quote.changePct ?? null,
      high: quote.high ?? null,
      low: quote.low ?? null,
      turnover,
    }
  })
}

/** 分时：腾讯 minute 返回累计量额，均价按逐分钟增量做成交量加权。 */
async function loadTrend(tencentCode) {
  const json = await fetchJson(`${MINUTE_URL}?code=${encodeURIComponent(tencentCode)}`, {
    label: '腾讯分时',
  })
  const node = json?.data?.[tencentCode]
  const rows = node?.data?.data
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('腾讯分时不可用：数据为空')
  const qt = node?.qt?.[tencentCode]
  const preClose = Array.isArray(qt) ? num(qt[4]) : null
  const points = []
  let lastVolume = 0
  let weightedSum = 0
  let volumeSum = 0
  for (const row of rows) {
    const parts = String(row).trim().split(/\s+/)
    if (parts.length < 4) continue
    const clock = parts[0]
    const price = num(parts[1])
    const volume = num(parts[2]) ?? 0
    if (price == null || clock.length < 4) continue
    const increment = Math.max(volume - lastVolume, 0)
    lastVolume = Math.max(volume, lastVolume)
    volumeSum += increment
    weightedSum += price * increment
    points.push({
      time: `${clock.slice(0, 2)}:${clock.slice(2, 4)}`,
      price,
      average: volumeSum > 0 ? Math.round((weightedSum / volumeSum) * 100) / 100 : price,
      volume: increment,
    })
  }
  if (points.length === 0) throw new Error('腾讯分时不可用：解析结果为空')
  const last = points[points.length - 1]
  if (preClose != null) {
    for (const point of points) {
      point.changePct = Math.round(((point.price - preClose) / preClose) * 10000) / 100
    }
  }
  return { code: tencentCode, date: String(node?.data?.date || ''), preClose, points, lastPrice: last.price }
}

/** 日 K：腾讯 fqkline，行格式 [date, open, close, high, low, volume]。 */
async function loadKline(tencentCode, limit = 140) {
  const json = await fetchJson(
    `${KLINE_URL}?param=${encodeURIComponent(tencentCode)},day,,,${limit},qfq`,
    { label: '腾讯日K' },
  )
  const node = json?.data?.[tencentCode]
  const rows = node?.day || node?.qfqday
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('腾讯日K不可用：数据为空')
  const klines = []
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue
    klines.push({
      date: String(row[0]),
      open: num(row[1]),
      close: num(row[2]),
      high: num(row[3]),
      low: num(row[4]),
      volume: num(row[5]),
    })
  }
  if (klines.length === 0) throw new Error('腾讯日K不可用：解析结果为空')
  return klines
}

/* ------------------------------ 个股下钻 ------------------------------ */

/** 把用户/快照里的股票代码解析成腾讯代码：600519 → sh600519，00700 → hk00700，AAPL → usAAPL。 */
function resolveTencentCode(input) {
  const raw = String(input == null ? '' : input).trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  if (/^(sh|sz|bj|hk)\d+$/.test(lower)) return lower
  // 美股代码大小写敏感（v_usAAPL），统一转成 us + 大写，避免被 toLowerCase 破坏。
  if (/^us[a-z0-9.]+$/i.test(raw)) return `us${raw.slice(2).toUpperCase()}`
  if (/^\d{6}$/.test(raw)) {
    if (/^[69]/.test(raw)) return `sh${raw}`
    if (/^[48]/.test(raw)) return `bj${raw}`
    return `sz${raw}`
  }
  if (/^\d{5}$/.test(raw)) return `hk${raw}`
  if (/^[a-z][a-z0-9.-]{0,9}$/i.test(raw)) return `us${raw.toUpperCase()}`
  return null
}

/** 单只股票报价：与指数共用腾讯 qt 接口，字段下标一致。 */
async function loadStockQuote(tencentCode) {
  const text = await fetchText(`${QUOTE_URL}${tencentCode}`, { label: '腾讯个股报价', encoding: 'gbk' })
  const match = /v_(\w+)="([^"]*)"/.exec(text)
  if (!match) throw new Error('腾讯个股报价不可用：响应为空')
  const fields = match[2].split('~')
  if (!fields[1]) throw new Error('腾讯个股报价不可用：未找到该代码')
  return {
    code: tencentCode,
    name: fields[1] || '',
    price: num(fields[3]),
    prevClose: num(fields[4]),
    open: num(fields[5]),
    volume: num(fields[6]),
    time: fields[30] || '',
    change: num(fields[31]),
    changePct: num(fields[32]),
    high: num(fields[33]),
    low: num(fields[34]),
    turnover: num(fields[37]) != null ? num(fields[37]) * 1e4 : null,
    turnoverRate: num(fields[38]),
    pe: num(fields[39]),
  }
}

/**
 * 个股下钻：报价 + 分时 + 60 日日K。三个分区独立降级，报价缺失才整体失败。
 * @param {string} input 股票代码（600519 / sh600519 / 00700 / AAPL）
 */
export async function getStock(input) {
  const tencent = resolveTencentCode(input)
  if (!tencent) throw new Error(`股票代码无法识别：${String(input == null ? '' : input)}`)
  const warnings = []
  const settle = async (label, promise) => {
    try {
      return await promise
    } catch (error) {
      warnings.push(`${label}：${error && error.message ? error.message : '未知错误'}`)
      return null
    }
  }
  const [quote, trend, kline] = await Promise.all([
    settle('个股报价', cached(`quote:${tencent}`, TTL.quotes, () => loadStockQuote(tencent))),
    settle('个股分时', cached(`trend:${tencent}`, TTL.trend, () => loadTrend(tencent))),
    settle('个股日K', cached(`kline:${tencent}:60`, TTL.kline, () => loadKline(tencent, 60))),
  ])
  if (!quote) {
    const reason = warnings[0] || '上游未返回报价'
    throw new Error(`个股 ${String(input)} 行情不可用：${reason}`)
  }
  const analysis = kline ? analyzeKline(kline) : null
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    tencent,
    code: quote.code,
    name: quote.name,
    quote,
    trend: trend || null,
    kline: analysis
      ? { recent: analysis.recent, maSeries: analysis.maSeries, lastDate: analysis.lastDate }
      : null,
    warnings,
  }
}

/* ------------------------------ 分析 ------------------------------ */

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value))
  if (valid.length === 0) return null
  let sum = 0
  for (const value of valid) sum += value
  return sum / valid.length
}

function movingAverage(closes, window) {
  return closes.map((_, index) => {
    if (index + 1 < window) return null
    return average(closes.slice(index + 1 - window, index + 1))
  })
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

/** 收盘快照里的量能比：今日成交额 / 前 5 个交易日均值。 */
function computeVolumeRatio(history, date, todayAmount) {
  if (!Array.isArray(history) || history.length < 2) return null
  const index = history.findIndex((row) => row.date === date)
  const past = index === -1 ? history.slice(-5) : history.slice(Math.max(index - 5, 0), index)
  const reference = average(past.map((row) => row.amount))
  const today = todayAmount != null ? todayAmount : index !== -1 ? history[index].amount : null
  if (!reference || today == null) return null
  return Math.round((today / reference) * 1000) / 1000
}

function analyzeKline(klines) {
  const closes = klines.map((row) => row.close)
  const ma5 = movingAverage(closes, 5)
  const ma10 = movingAverage(closes, 10)
  const ma20 = movingAverage(closes, 20)
  const ma60 = movingAverage(closes, 60)
  const last = closes.length - 1
  const recentCount = Math.min(60, closes.length)
  const start = closes.length - recentCount
  const recent = []
  for (let index = start; index < closes.length; index += 1) {
    recent.push({
      date: klines[index].date,
      open: klines[index].open,
      close: klines[index].close,
      high: klines[index].high,
      low: klines[index].low,
      volume: klines[index].volume,
      ma5: ma5[index],
      ma10: ma10[index],
      ma20: ma20[index],
      ma60: ma60[index],
    })
  }
  return {
    recent,
    maSeries: { ma5: ma5.slice(start), ma10: ma10.slice(start), ma20: ma20.slice(start) },
    ma5: ma5[last],
    ma10: ma10[last],
    ma20: ma20[last],
    ma60: ma60[last],
    aboveMa5: ma5[last] != null && closes[last] >= ma5[last],
    aboveMa20: ma20[last] != null && closes[last] >= ma20[last],
    aboveMa60: ma60[last] != null && closes[last] >= ma60[last],
    lastClose: closes[last],
    lastDate: klines[last].date,
  }
}

function breadthScore(breadth) {
  if (!breadth) return 50
  if (breadth.upRatio != null) return clamp(breadth.upRatio * 100, 0, 100)
  if (!breadth.up || !breadth.down) return 50
  return clamp((breadth.up / (breadth.up + breadth.down)) * 100, 0, 100)
}

function limitScore(breadth) {
  if (!breadth) return 50
  const up = breadth.limitUp ?? 0
  const down = breadth.limitDown ?? 0
  if (up + down === 0) return 50
  return clamp((up / (up + down)) * 100, 0, 100)
}

function volumeScore(ratio) {
  if (!Number.isFinite(ratio)) return 50
  return clamp(((ratio - 0.6) / (1.4 - 0.6)) * 100, 0, 100)
}

function momentumScore(index, analysis) {
  let score = 50
  if (!index) return score
  if (Number.isFinite(index.changePct)) score += clamp(index.changePct, -4, 4) * 6
  if (analysis) {
    if (analysis.aboveMa5 === false) score -= 6
    if (analysis.aboveMa20 === false) score -= 10
    if (analysis.aboveMa60 === false) score -= 6
  }
  return clamp(score, 0, 100)
}

function temperatureLabel(score) {
  if (score >= 80) return { text: '过热', tone: 'hot' }
  if (score >= 60) return { text: '偏暖', tone: 'warm' }
  if (score >= 40) return { text: '中性', tone: 'muted' }
  if (score >= 20) return { text: '偏冷', tone: 'cool' }
  return { text: '冰点', tone: 'cold' }
}

function formatYi(value) {
  if (value == null) return null
  return Math.round((value / 1e8) * 10) / 10
}

/** 由各分区数据合成市场温度与文字信号（宿主算好，前端直接展示）。 */
function buildAnalysis({ indices, breadth, turnover, analysisSh, volumeRatio }) {
  const sh = (indices || []).find((item) => item.code === '000001')
  const scores = {
    breadth: breadthScore(breadth),
    limit: limitScore(breadth),
    volume: volumeScore(volumeRatio),
    momentum: momentumScore(sh, analysisSh),
  }
  const temperature = Math.round(
    scores.breadth * 0.35 + scores.limit * 0.2 + scores.volume * 0.2 + scores.momentum * 0.25,
  )
  const signals = []
  if (breadth && breadth.up != null && breadth.down != null) {
    // 与宽度卡/一句话结论统一口径：优先用含平盘的总家数，避免 15.9% / 15.7% 两种说法并存。
    const total = breadth.total || breadth.up + breadth.down
    if (total > 0) {
      signals.push(
        `上涨 ${breadth.up} 家 / 下跌 ${breadth.down} 家，上涨占比 ${((breadth.up / total) * 100).toFixed(1)}%`,
      )
    }
  }
  if (breadth && (breadth.limitUp || breadth.limitDown)) {
    signals.push(`涨停 ${breadth.limitUp ?? 0} 家 / 跌停 ${breadth.limitDown ?? 0} 家`)
  }
  if (turnover?.total) signals.push(`两市成交 ${formatYi(turnover.total)} 亿元`)
  if (Number.isFinite(volumeRatio)) {
    const direction = volumeRatio >= 1 ? '放量' : '缩量'
    signals.push(`成交额较前 5 日均值${direction} ${Math.abs((volumeRatio - 1) * 100).toFixed(1)}%`)
  }
  if (analysisSh) {
    const parts = []
    if (analysisSh.aboveMa5 != null) parts.push(analysisSh.aboveMa5 ? '站上 MA5' : '跌破 MA5')
    if (analysisSh.aboveMa20 != null) parts.push(analysisSh.aboveMa20 ? '站上 MA20' : '低于 MA20')
    if (analysisSh.aboveMa60 != null) parts.push(analysisSh.aboveMa60 ? '站上 MA60' : '低于 MA60')
    if (parts.length) signals.push(`上证指数${parts.join('、')}`)
  }
  if (sh && sh.changePct != null) {
    signals.push(`上证指数 ${sh.changePct >= 0 ? '+' : ''}${sh.changePct.toFixed(2)}%`)
  }
  return {
    temperature,
    label: temperatureLabel(temperature),
    scores: {
      breadth: Math.round(scores.breadth),
      limit: Math.round(scores.limit),
      volume: Math.round(scores.volume),
      momentum: Math.round(scores.momentum),
    },
    signals,
    volumeRatio: Number.isFinite(volumeRatio) ? volumeRatio : null,
  }
}

/** 板块轮动：收盘快照行业涨跌幅，拼上同名行业的资金净额（元）。 */
function buildSectors(snapshot) {
  if (!snapshot || !snapshot.sectors || snapshot.sectors.length === 0) return null
  const flowByIndustry = new Map()
  for (const row of snapshot.sectorFlow || []) {
    if (row.industry) flowByIndustry.set(row.industry, row)
  }
  const withFlow = snapshot.sectors.map((row) => {
    const flow = flowByIndustry.get(row.name)
    return {
      code: row.name,
      name: row.name,
      changePct: row.changePct,
      mainInflow: flow ? flow.net : null,
    }
  })
  const valid = withFlow.filter((row) => Number.isFinite(row.changePct))
  if (valid.length === 0) return null
  const sorted = valid.slice().sort((a, b) => b.changePct - a.changePct)
  return { gainers: sorted.slice(0, 8), losers: sorted.slice(-8).reverse() }
}

function buildTurnover(indices, snapshot, history) {
  const sh = (indices || []).find((item) => item.code === '000001')
  const sz = (indices || []).find((item) => item.code === '399001')
  const liveTotal = (sh?.turnover || 0) + (sz?.turnover || 0)
  const total = liveTotal || snapshot?.breadth?.totalAmount || null
  if (!total) return null
  const ratio5d = computeVolumeRatio(
    history,
    snapshot?.date,
    snapshot?.breadth?.totalAmount != null ? snapshot.breadth.totalAmount / 1e8 : null,
  )
  return {
    total,
    sh: sh?.turnover || null,
    sz: sz?.turnover || null,
    ratio5d,
  }
}

/**
 * 一句话盘面结论：把「量能 × 涨跌 × 情绪」压成一句人话，放在盘面顶部。
 * 只依赖已算好的 snapshot/analysis，不引入新数据源。
 */
function buildSummary({ indices, breadth, turnover, analysis }) {
  const sh = (indices || []).find((item) => item.code === '000001')
  const shPct = sh && Number.isFinite(sh.changePct) ? sh.changePct : null
  const upRatio =
    breadth && breadth.up != null
      ? (breadth.up / Math.max(breadth.total || breadth.up + (breadth.down || 0), 1)) * 100
      : null
  const zt = breadth && Number.isFinite(breadth.limitUp) ? breadth.limitUp : null
  const dt = breadth && Number.isFinite(breadth.limitDown) ? breadth.limitDown : null
  const ratio = turnover && Number.isFinite(turnover.ratio5d) ? turnover.ratio5d : null

  let volumeWord = null
  if (ratio != null) volumeWord = ratio >= 1.15 ? '放量' : ratio <= 0.85 ? '缩量' : '平量'
  let moveWord = null
  if (shPct != null) moveWord = shPct >= 0.4 ? '上涨' : shPct <= -0.4 ? '下跌' : '震荡'
  const headline = [volumeWord, moveWord].filter(Boolean).join('') || '盘面概况'
  const detail = [
    shPct != null ? `上证 ${shPct >= 0 ? '+' : ''}${shPct.toFixed(2)}%` : null,
    upRatio != null ? `上涨占比 ${upRatio.toFixed(1)}%` : null,
    zt != null && dt != null ? `涨停 ${zt} / 跌停 ${dt}` : null,
    analysis ? `温度 ${analysis.temperature}（${analysis.label ? analysis.label.text : '—'}）` : null,
  ]
    .filter(Boolean)
    .join('，')

  // tone 跟一句话结论保持一致：写「震荡」就不要给上涨/下跌的底色
  const tone = moveWord === '上涨' ? 'up' : moveWord === '下跌' ? 'down' : 'muted'
  return { text: detail ? `${headline}：${detail}。` : headline, tone }
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 市场概览聚合。各分区独立降级：任何一个分区失败只返回 warning 与 null 分区。
 * @param {{ withTrend?: boolean }} options
 */
export async function getOverview(options = {}) {
  const trading = beijingNow()
  const warnings = []
  // 盘中（含午休、尾盘）走实时接口：涨跌家数/行业板块 60s 缓存；盘前/盘后用收盘快照。
  const liveMode = ['trading', 'lunch', 'closing'].includes(trading.session)

  // 分区四态：每个上游分区独立计时、独立降级；失败但有旧值时返回旧值并标 stale。
  // 缓存键沿用之前的写法（trend:/kline: 带代码后缀），不要让已有缓存失效。
  const runner = createPartsRunner({
    cache: { memo: (key, ttlMs, loader) => cached(key, ttlMs, loader), peek: peekCached },
    deadlineMs: 6000,
  })
  const requests = [
    ['quotes', '指数报价', 'quotes', TTL.quotes, () => loadQuotes()],
    ['snapshot', '收盘快照', 'snapshot', TTL.snapshot, () => loadSnapshot()],
    ['kline', '上证日K', 'kline:sh000001', TTL.kline, () => loadKline('sh000001', 140)],
    ['amountHistory', '成交额历史', 'amountHistory', TTL.amountHistory, () => loadAmountHistory()],
  ]
  if (options.withTrend !== false) {
    requests.splice(2, 0, ['trend', '上证分时', 'trend:sh000001', TTL.trend, () => loadTrend('sh000001')])
  }
  if (liveMode) {
    requests.push(
      ['breadth', '实时涨跌家数', 'liveBreadth', TTL.liveBreadth, () => loadLiveBreadth()],
      ['sectors', '实时行业板块', 'liveSectors', TTL.liveSectors, () => loadLiveSectors()],
    )
  }
  const partResults = await Promise.all(
    requests.map(([id, label, key, ttlMs, loader]) => runner.run(id, loader, { key, ttlMs }).then((result) => ({ ...result, label }))),
  )
  /** 取某个分区的值；失败（且没有旧值）返回 null，与旧的 settle() 语义一致。 */
  const partValue = (id) => {
    const result = partResults.find((entry) => entry.id === id)
    return result && result.ok ? result.value : null
  }
  for (const result of partResults) {
    if (!result.ok) warnings.push(`${result.label}不可用（${result.error || 'unknown'}）`)
    else if (result.stale) warnings.push(`${result.label}：上游暂时不可用，显示上一份缓存（${result.error || 'unknown'}）`)
  }
  const quotes = partValue('quotes')
  const snapshot = partValue('snapshot')
  const trendSh = partValue('trend')
  const klineSh = partValue('kline')
  const amountHistory = partValue('amountHistory')
  const liveBreadth = partValue('breadth')
  const liveSectors = partValue('sectors')
  const parts = runner.summarize(partResults)
  const partsStale = partResults.some((result) => result.stale === true)

  if (snapshot && snapshot.date && snapshot.date !== trading.date) {
    warnings.push(`收盘快照为上一交易日（${snapshot.date}），盘中实时数字以行情源为准`)
  } else if (!snapshot && !liveBreadth) {
    warnings.push('收盘快照不可用：宽度/板块/涨跌停等改为缺失')
  }
  // 实时板块的降级细节（东财被限流、切新浪兜底等）原样透出给面板
  if (liveSectors && Array.isArray(liveSectors.warnings)) warnings.push(...liveSectors.warnings)

  const analysisSh = klineSh ? analyzeKline(klineSh) : null
  const turnover = buildTurnover(quotes, snapshot, amountHistory)
  const todayAmountYi =
    turnover && turnover.total != null
      ? turnover.total / 1e8
      : snapshot && snapshot.breadth && snapshot.breadth.totalAmount != null
        ? snapshot.breadth.totalAmount / 1e8
        : null
  const fraction = liveMode ? Math.max(elapsedTradingFraction(), 0.05) : 1
  const projectedAmountYi = todayAmountYi != null ? todayAmountYi / fraction : null
  const volumeRatio =
    analysisSh && projectedAmountYi != null ? computeVolumeRatio(amountHistory, trading.date, projectedAmountYi) : null
  if (turnover) {
    turnover.ratio5d = volumeRatio
    turnover.projectedTotal = projectedAmountYi != null ? projectedAmountYi * 1e8 : null
    turnover.progress = liveMode ? fraction : 1
  }

  const baseBreadth = liveBreadth && liveBreadth.breadth
    ? {
        ...liveBreadth.breadth,
        // 5 日累计是慢数据，实时接口不提供：沿用最新收盘快照的统计（截至上一交易日）
        up5: snapshot && snapshot.breadth ? snapshot.breadth.up5 : null,
        down5: snapshot && snapshot.breadth ? snapshot.breadth.down5 : null,
      }
    : snapshot
      ? { ...snapshot.breadth }
      : null
  const breadth = baseBreadth
    ? {
        ...baseBreadth,
        totalAmount:
          baseBreadth.totalAmount != null ? baseBreadth.totalAmount : turnover && turnover.total != null ? turnover.total : null,
        upRatio:
          baseBreadth.up != null && baseBreadth.down != null
            ? baseBreadth.up / Math.max(baseBreadth.up + baseBreadth.down, 1)
            : null,
      }
    : null

  const indices = quotes || (snapshot ? snapshot.indices : []) || []
  const analysis = buildAnalysis({ indices, breadth, turnover, analysisSh, volumeRatio })
  const sectors = (liveSectors && liveSectors.sectors) || buildSectors(snapshot)
  const summary = buildSummary({ indices, breadth, turnover, analysis })
  const sources = {
    indices: quotes ? 'live' : 'snapshot',
    breadth: liveBreadth ? 'live' : snapshot ? 'snapshot' : 'missing',
    sectors: liveSectors ? 'live' : snapshot ? 'snapshot' : 'missing',
    trend: trendSh ? 'live' : 'missing',
    kline: analysisSh ? 'snapshot' : 'missing',
  }
  const dataMode =
    liveMode && (sources.breadth === 'live' || sources.sectors === 'live' || sources.indices === 'live')
      ? 'live'
      : 'snapshot'

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    trading,
    dataMode,
    sources,
    marketDate: (snapshot && snapshot.date) || trading.date,
    dataTime: dataMode === 'live' ? trading.time : (snapshot && snapshot.time) || null,
    stale: snapshot ? snapshot.date !== trading.date : true,
    parts,
    partsStale,
    summary,
    indices,
    trend: trendSh ? { sh: trendSh } : null,
    breadth,
    turnover,
    sectors,
    analysis,
    kline: analysisSh
      ? {
          recent: analysisSh.recent,
          maSeries: analysisSh.maSeries,
          ma5: analysisSh.ma5,
          ma10: analysisSh.ma10,
          ma20: analysisSh.ma20,
          ma60: analysisSh.ma60,
          volumeRatio,
          lastDate: analysisSh.lastDate,
        }
      : null,
    warnings,
  }
}

/**
 * 市场情绪历史：读 market-report 每日落盘的 market_daily_snapshot.jsonl（{date, zt, dt, amt}），
 * 给「研究」tab 画涨停/跌停与成交额趋势。只读本地文件，不依赖任何外部接口。
 * @param {number} limit 返回最近多少个交易日（默认 40，最多 250）
 */
export async function getHistory(limit = 40) {
  const days = Math.max(3, Math.min(250, Number(limit) || 40))
  let text
  try {
    text = await readFile(SNAPSHOT_JSONL, 'utf8')
  } catch (error) {
    throw new Error(`历史快照不可用：读取 ${SNAPSHOT_JSONL} 失败（${error.code || error.message}）`)
  }
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const json = JSON.parse(trimmed)
      if (!json || !json.date) continue
      rows.push({
        date: String(json.date),
        zt: num(json.zt),
        dt: num(json.dt),
        amount: num(json.amt) != null ? num(json.amt) * 1e8 : null,
      })
    } catch {
      /* 单行坏了跳过，不因一条脏数据让整块历史失败 */
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const points = rows.slice(-days)
  const last = points[points.length - 1] || null
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    source: SNAPSHOT_JSONL,
    count: points.length,
    latestDate: last ? last.date : null,
    points,
    warnings: points.length < days ? [`历史快照仅 ${points.length} 个交易日（请求 ${days}）`] : [],
  }
}

/**
 * 异动数据：涨停池 / 龙虎榜 / 涨跌幅榜 / 板块资金流 / 资金流向榜。
 * 全部来自收盘快照文件（market_data.json + flow_full.json），不依赖实时行情。
 */
export async function getMoves() {
  const trading = beijingNow()
  const liveMode = ['trading', 'lunch', 'closing'].includes(trading.session)
  const warnings = []
  const settle = async (label, promise) => {
    try {
      return await promise
    } catch (error) {
      warnings.push(`${label}：${error && error.message ? error.message : '未知错误'}`)
      return null
    }
  }
  const [snapshot, flow, liveMovers, liveSectors] = await Promise.all([
    settle('收盘快照', cached('snapshot', TTL.snapshot, loadSnapshot)),
    settle('资金流向', cached('flow', TTL.flow, loadFlow)),
    liveMode ? settle('实时异动', cached('liveMovers', TTL.liveMovers, loadLiveMovers)) : Promise.resolve(null),
    liveMode ? settle('实时行业资金', cached('liveSectors', TTL.liveSectors, loadLiveSectors)) : Promise.resolve(null),
  ])

  const formatSeal = (value) => {
    const text = String(value == null ? '' : value)
    if (/^\d{6}$/.test(text)) return `${text.slice(0, 2)}:${text.slice(2, 4)}:${text.slice(4, 6)}`
    return text || null
  }
  const snapshotPool = (snapshot && snapshot.ztPool ? snapshot.ztPool : []).map((row) => ({
    name: row.name,
    code: String(row.code || ''),
    pct: num(row.pct),
    firstSeal: formatSeal(row.fbt),
    industry: row.hy || '',
  }))
  const livePool = (liveMovers && liveMovers.ztRows ? liveMovers.ztRows : []).map((row) => ({
    name: row.name,
    code: String(row.code || ''),
    pct: num(row.pct),
    firstSeal: row.firstSeal || null,
    industry: row.industry || '',
    boardCount: num(row.boardCount),
    breakCount: num(row.breakCount),
  }))
  const poolRows = livePool.length ? livePool : snapshotPool
  const lhbRows = (snapshot && snapshot.lhb ? snapshot.lhb : []).map((row) => ({
    name: row.name,
    code: String(row.code || ''),
    pct: num(row.pct),
    net: num(row.net),
    reason: row.reason || '',
  }))
  const sortByNet = (rows) =>
    (rows || [])
      .filter((row) => Number.isFinite(row.net))
      .slice()
      .sort((a, b) => b.net - a.net)

  if (liveMovers && Array.isArray(liveMovers.warnings)) warnings.push(...liveMovers.warnings)
  if (liveSectors && Array.isArray(liveSectors.warnings)) warnings.push(...liveSectors.warnings)
  const liveTop = liveMovers && liveMovers.top ? liveMovers.top : null
  const liveBottom = liveMovers && liveMovers.bottom ? liveMovers.bottom : null
  const sources = {
    limitPool: livePool.length ? 'live' : snapshot ? 'snapshot' : 'missing',
    movers: (liveTop && liveTop.length) || (liveBottom && liveBottom.length) ? 'live' : snapshot && snapshot.movers ? 'snapshot' : 'missing',
    sectorFlow: liveSectors && liveSectors.sectorFlow ? 'live' : snapshot ? 'snapshot' : 'missing',
    lhb: snapshot ? 'snapshot' : 'missing',
    flows: flow ? 'snapshot' : 'missing',
  }
  const dataMode = liveMode && (sources.limitPool === 'live' || sources.movers === 'live' || sources.sectorFlow === 'live') ? 'live' : 'snapshot'

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    dataMode,
    sources,
    marketDate: (snapshot && snapshot.date) || trading.date,
    dataTime: dataMode === 'live' ? trading.time : (snapshot && snapshot.time) || null,
    stale: snapshot ? snapshot.date !== trading.date : true,
    limitPool: {
      today:
        (liveMovers && liveMovers.limitUp) != null
          ? liveMovers.limitUp
          : snapshot && snapshot.breadth && snapshot.breadth.limitUp != null
            ? snapshot.breadth.limitUp
            : poolRows.length,
      prev: (snapshot && snapshot.ztPoolPrev) != null ? snapshot.ztPoolPrev : null,
      rows: poolRows,
    },
    lhb: lhbRows.slice(0, 10),
    movers: {
      top: (liveTop && liveTop.length ? liveTop : (snapshot && snapshot.movers && snapshot.movers.top) || []).slice(0, 8),
      bottom: (liveBottom && liveBottom.length ? liveBottom : (snapshot && snapshot.movers && snapshot.movers.bottom) || []).slice(0, 8),
    },
    sectorFlow: liveSectors && liveSectors.sectorFlow
      ? liveSectors.sectorFlow
      : {
          top: sortByNet(snapshot && snapshot.sectorFlow).slice(0, 6),
          bottom: sortByNet(snapshot && snapshot.sectorFlow).slice(-6).reverse(),
        },
    flows: {
      inflow: (flow && flow.inflow ? flow.inflow : []).slice(0, 6),
      outflow: (flow && flow.outflow ? flow.outflow : []).slice(0, 6),
    },
    warnings,
  }
}

/** 财经快讯与公告：新浪 7×24 + 华尔街见闻 + 巨潮公告，60s 缓存，前端可点击跳原文。 */
export async function getNews(limit = 40) {
  const news = await cached('news', TTL.news, () => loadLiveNews(40))
  const size = Math.max(1, Math.min(80, Number(limit) || 40))
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    items: news.items.slice(0, size),
    total: news.total,
    warnings: news.warnings,
  }
}

/** 单只指数分时（前端切换指数时按需拉取）。 */
export async function getTrend(secid) {
  const meta = INDICES.find((item) => item.secid === secid)
  if (!meta) throw new Error(`未知指数：${secid}`)
  return cached(`trend:${meta.tencent}`, TTL.trend, () => loadTrend(meta.tencent))
}

/** 供 /health 与测试脚本用的数据源自检。 */
export async function getHealth() {
  const started = Date.now()
  const result = { ok: true, checks: [] }
  const check = async (name, loader) => {
    try {
      const value = await loader()
      result.checks.push({ name, ok: Boolean(value) })
    } catch (error) {
      result.ok = false
      result.checks.push({ name, ok: false, error: String(error && error.message) })
    }
  }
  await check('snapshot', () => cached('snapshot', TTL.snapshot, loadSnapshot))
  await check('quotes', () => cached('quotes', TTL.quotes, loadQuotes))
  await check('kline', () => cached('kline:health', TTL.kline, () => loadKline('sh000001', 30)))
  result.elapsedMs = Date.now() - started
  result.cacheSize = cache.size
  return result
}

/** 测试/诊断用：清空缓存。 */
export function clearCache() {
  cache.clear()
  lastGood.clear()
}
