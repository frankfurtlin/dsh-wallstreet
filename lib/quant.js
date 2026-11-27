/**
 * dsh-wallstreet —— quant 研究工作区接入层（host 半专用）。
 *
 * 设计原则（与 lib/market.js 一致）：
 *  - 只读：2026-11-12 起 /root/workspace/quant 已整体删除；本文件读取市场数据管线
 *    （/root/scripts/market-report，cron 每交易日 15:10 产出到本插件 data/ 下 market_data.json、
 *    data/flow_full.json）以及随插件归档的研究快照（data/quant-archive/：结论文档、
 *    回测结果 JSON、持仓集中度快照）。不启动 Python、不写任何数据目录。
 *  - 容错：quant 的数据文件用 Python json.dump 写出，可能含 NaN/Infinity（如两融
 *    融券字段），Node 的 JSON.parse 会直接抛错，故先做字面量清洗再解析。
 *  - 降级：任一文件缺失只把对应分区标成 warnings，不拖垮整个量化研究视图。
 *  - 缓存：文件类数据 60s TTL + 并发去重。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** 归档快照根（原 quant 工作区已删除；可用环境变量覆盖，便于测试时指向夹具）。 */
export const QUANT_ROOT = process.env.DSH_WALLSTREET_QUANT_ROOT || '/root/workspace/plugins/dsh-wallstreet/data/quant-archive'
/** 市场数据管线（market-report）每日采集的数据（Python 写，含 NaN 字面量）。
 *  2026-11-25: 数据落在插件自己的 data/ 下（管线写入），可用 DSH_WALLSTREET_DATA_DIR 覆盖。 */
const MR_DATA = process.env.DSH_WALLSTREET_DATA_DIR || '/root/workspace/plugins/dsh-wallstreet/data'
const MARKET_JSON = process.env.DSH_WALLSTREET_MARKET_JSON || `${MR_DATA}/market_data.json`
/** 行业资金流（market-report/scripts/flow_full.py 产出）。 */
const FLOW_JSON = process.env.DSH_WALLSTREET_FLOW_JSON || `${MR_DATA}/flow_full.json`
const DOCS_CONCLUSION = join(QUANT_ROOT, 'docs', 'CONCLUSION.md')
const RESULTS_DIR = join(QUANT_ROOT, 'backtests', 'results')
const HOLDINGS_DIR = join(QUANT_ROOT, 'data')

const CACHE_TTL = {
  overview: 60_000,
  research: 60_000,
  holdings: 60_000,
}

const cache = new Map()

function cached(key, ttlMs, loader) {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < ttlMs) return hit.promise
  if (hit && hit.pending) return hit.promise
  const entry = { at: now, pending: true, promise: null }
  entry.promise = loader()
    .then((value) => {
      entry.pending = false
      entry.at = Date.now()
      entry.value = value
      return value
    })
    .catch((error) => {
      cache.delete(key)
      throw error
    })
  cache.set(key, entry)
  return entry.promise
}

function clearCache() {
  cache.clear()
}

/** 读取文本文件；不存在时返回 null（调用方据此降级）。 */
async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * quant 的 JSON 可能带 Python 风格的 NaN / Infinity 字面量，Node 解析不了。
 * 只替换裸字面量（字符串内的 "NaN" 不受影响）。
 */
function tolerantParse(text) {
  const cleaned = text
    .replace(/(?<![A-Za-z0-9_"'])NaN(?![A-Za-z0-9_"'])/g, 'null')
    .replace(/(?<![A-Za-z0-9_"'])-?Infinity(?![A-Za-z0-9_"'])/g, 'null')
  return JSON.parse(cleaned)
}

async function readJsonTolerant(path) {
  const text = await readText(path)
  if (text == null) return null
  return tolerantParse(text)
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function round(value, digits = 2) {
  const n = num(value)
  if (n == null) return null
  const factor = 10 ** digits
  return Math.round(n * factor) / factor
}

function text(value, limit = 200) {
  if (typeof value !== 'string') return ''
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** 'YYYY-MM-DD HH:MM:SS' → { date: 'YYYY-MM-DD', ageDays } */
function parseFetchTime(fetchTime) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(fetchTime || ''))
  if (!match) return { date: '', time: '', ageDays: null }
  const stamp = Date.parse(`${match[1]}T${match[2]}+08:00`)
  const ageDays = Number.isFinite(stamp) ? Math.max(0, Math.floor((Date.now() - stamp) / 86_400_000)) : null
  return { date: match[1], time: match[2], ageDays }
}

async function loadMarket() {
  return cached('market', CACHE_TTL.overview, async () => readJsonTolerant(MARKET_JSON))
}

async function loadFlow() {
  return cached('flow', CACHE_TTL.overview, async () => readJsonTolerant(FLOW_JSON))
}

/* ------------------------------------------------------------------ */
/* 每日市场数据（market-report/scripts/data/market_fetch.py → 项目 data/market_data.json） */
/* ------------------------------------------------------------------ */

const VALUATION_ORDER = ['上证50', '沪深300', '中证500', '中证1000', '创业板指']

function buildValuation(valuation) {
  if (!valuation || typeof valuation !== 'object') return []
  const names = Object.keys(valuation)
  names.sort((a, b) => {
    const ai = VALUATION_ORDER.indexOf(a)
    const bi = VALUATION_ORDER.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b, 'zh-CN')
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
  return names.map((name) => ({
    name,
    peTtm: round(valuation[name].pe_ttm),
    peStatic: round(valuation[name].pe_static),
    pctile: round(valuation[name].pctile, 1),
    histLow: round(valuation[name].hist_low),
    histHigh: round(valuation[name].hist_high),
  }))
}

function buildMargin(market) {
  const sh = market.margin_sh || null
  const sz = market.margin_sz || null
  const pick = (node) =>
    node
      ? {
          date: String(node['日期'] || ''),
          financingBuy: num(node['融资买入额']),
          financingBalance: num(node['融资余额']),
          shortBalance: num(node['融券余额']),
          totalBalance: num(node['融资融券余额']),
        }
      : null
  return { sh: pick(sh), sz: pick(sz) }
}

function buildFutures(futures) {
  if (!futures || typeof futures !== 'object') return []
  return Object.values(futures)
    .map((item) => ({ name: text(item && item.name, 40), price: round(item && item.price), pct: round(item && item.pct) }))
    .filter((item) => item.name)
}

function buildLimitPool(market) {
  const pool = Array.isArray(market.zt_pool) ? market.zt_pool : []
  return {
    today: pool.length,
    prev: num(market.zt_pool_prev),
    top: pool.slice(0, 12).map((item) => ({
      name: text(item.name, 20),
      code: String(item.code || ''),
      pct: round(item.pct),
      boards: num(item.lbt),
      firstSeal: String(item.fbt || '').replace(/^(\d{2})(\d{2})(\d{2}).*/, '$1:$2:$3'),
      industry: text(item.hy, 20),
    })),
  }
}

function buildLhb(lhb) {
  if (!Array.isArray(lhb)) return []
  return lhb
    .filter((item) => num(item.net) != null)
    .sort((a, b) => b.net - a.net)
    .slice(0, 10)
    .map((item) => ({
      name: text(item.name, 20),
      code: String(item.code || ''),
      pct: round(item.pct),
      reason: text(item.reason, 40),
      buy: num(item.buy),
      sell: num(item.sell),
      net: num(item.net),
    }))
}

function buildMovers(list, limit = 8) {
  if (!Array.isArray(list)) return []
  return list.slice(0, limit).map((item) => ({
    name: text(item.name, 20),
    code: String(item.code || ''),
    pct: round(item.pct),
    price: round(item.price),
  }))
}

function buildSectorStrength(sectors) {
  if (!Array.isArray(sectors)) return { top: [], bottom: [] }
  const items = sectors
    .filter((item) => item && typeof item.name === 'string' && num(item.avg_pct) != null)
    .map((item) => ({ name: text(item.name, 20), count: num(item.count), avgPct: round(item.avg_pct) }))
    .sort((a, b) => b.avgPct - a.avgPct)
  return { top: items.slice(0, 8), bottom: items.slice(-8).reverse() }
}

function buildSectorFlow(sectorFlow) {
  if (!Array.isArray(sectorFlow)) return []
  return sectorFlow
    .filter((item) => item && num(item['净额']) != null)
    .sort((a, b) => b['净额'] - a['净额'])
    .slice(0, 10)
    .map((item) => ({
      industry: text(item['行业'], 20),
      pct: round(item['行业-涨跌幅']),
      net: round(item['净额'] * 1e8), // 接口单位是「亿元」，统一成元
      leadStock: text(item['领涨股'], 20),
      leadPct: round(item['领涨股-涨跌幅']),
    }))
}

function buildIndustryFlow(flow, key, limit = 8) {
  const list = flow && Array.isArray(flow[key]) ? flow[key] : []
  return list.slice(0, limit).map((item) => ({
    industry: text(item['行业'], 20),
    pct: round(item['行业-涨跌幅']),
    net: round(item['净额'] * 1e8), // flow_full.json 的单位同样是亿元
    leadStock: text(item['领涨股'], 20),
    leadPct: round(item['领涨股-涨跌幅']),
  }))
}

function buildCommodities(market) {
  const wrap = (node, priceKey) => {
    if (!node) return null
    const price = num(node[priceKey])
    return price == null
      ? null
      : { date: String(node.date || ''), price: round(price), pct: round(node.chg_pct) }
  }
  return {
    bc: market.bc_index ? { date: String(market.bc_index.date || ''), value: round(market.bc_index.value), pct: round(market.bc_index.chg_pct) } : null,
    gold: wrap(market.sge_gold, 'price'),
    silver: wrap(market.sge_silver, 'price'),
    copper: wrap(market.cu_main, 'close'),
    aluminum: wrap(market.al_main, 'close'),
  }
}

function buildNews(market, limit = 12) {
  const cls = (Array.isArray(market.cls_news) ? market.cls_news : []).slice(0, limit).map((item) => ({
    time: text(item.time, 8),
    title: text(item.title, 120),
    digest: text(item.digest, 160),
  }))
  const news = (Array.isArray(market.news) ? market.news : []).slice(0, limit).map((item) => ({
    time: text(item.time, 20),
    title: text(item.title, 120),
    digest: text(item.digest, 160),
  }))
  return { cls, news }
}

function buildAnnouncements(market, limit = 8) {
  const cninfo = Array.isArray(market.cninfo) ? market.cninfo : []
  return cninfo.slice(0, limit).map((item) => ({
    code: String(item.code || ''),
    title: text(item.title, 80),
    time: text(item.time, 20),
    url: text(item.url, 300),
  }))
}

function buildOmo(market, limit = 4) {
  const omo = Array.isArray(market.omo) ? market.omo : []
  return omo.slice(0, limit).map((item) => ({ time: text(item.date, 20), title: text(item.title, 120) }))
}

export async function getQuantOverview() {
  return cached('quant-overview', CACHE_TTL.overview, async () => {
    const warnings = []
    const market = await loadMarket()
    if (!market) {
      throw new Error(`quant 每日数据缺失：${MARKET_JSON} 不存在`)
    }
    const flow = await loadFlow()
    if (!flow) warnings.push(`行业资金流缺失（${FLOW_JSON} 不存在）`)

    const fetchTime = parseFetchTime(market.fetch_time)
    if (fetchTime.ageDays != null && fetchTime.ageDays > 1) {
      warnings.push(`每日数据是 ${fetchTime.date} 的（距今 ${fetchTime.ageDays} 天），可能不是最新交易日`)
    }

    const breadth = market.breadth || {}
    return {
      ok: true,
      fetchedAt: market.fetch_time ? String(market.fetch_time) : '',
      dataDate: fetchTime.date,
      dataTime: fetchTime.time,
      stockCount: num(market.stock_count) ?? num(breadth.total),
      stale: fetchTime.ageDays != null && fetchTime.ageDays > 1,
      breadth: {
        up: num(breadth.up),
        down: num(breadth.dn),
        flat: num(breadth.flat),
        total: num(breadth.total),
        up5: num(breadth.up5),
        down5: num(breadth.dn5),
        limitUp: num(breadth.zt),
        limitDown: num(breadth.dt),
        totalAmount: num(breadth.total_amt) == null ? null : round(breadth.total_amt * 1e8),
        topAmountRatio: round(breadth.top_amt_ratio, 3),
        medianTurnover: round(breadth.tur_median),
      },
      valuation: buildValuation(market.valuation),
      margin: buildMargin(market),
      futures: buildFutures(market.futures),
      limitPool: buildLimitPool(market),
      lhb: buildLhb(market.lhb),
      movers: { top: buildMovers(market.top10), bottom: buildMovers(market.bot10) },
      sectors: buildSectorStrength(market.sectors),
      sectorFlow: buildSectorFlow(market.sector_flow),
      industryFlow: {
        inflow: buildIndustryFlow(flow, 'inflow'),
        outflow: buildIndustryFlow(flow, 'outflow'),
      },
      commodities: buildCommodities(market),
      omo: buildOmo(market),
      announcements: buildAnnouncements(market),
      news: buildNews(market),
      warnings,
    }
  })
}

/* ------------------------------------------------------------------ */
/* 策略研究结论（归档快照：backtests/results/*.json + docs/CONCLUSION.md） */
/* ------------------------------------------------------------------ */

/** 从 CONCLUSION.md 抽取一句话结论与两条前提（文档是权威口径，不在这里重写结论）。 */
function extractConclusion(markdown) {
  if (!markdown) return { headline: '', premises: [], window: '', updatedAt: '' }
  const lines = markdown.split('\n')
  let headline = ''
  let headlineDetail = ''
  let window = ''
  const premises = []
  const windowMatch = /窗口\s*([0-9]{4}-[0-9]{2})\s*~\s*([0-9]{4}-[0-9]{2})/.exec(markdown)
  if (windowMatch) window = `${windowMatch[1]} ~ ${windowMatch[2]}`

  for (let i = 0; i < lines.length; i += 1) {
    if (!headline && /^##+\s*一句话结论/.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const candidate = lines[j].replace(/^[>\s*]+/, '').trim()
        if (candidate && !candidate.startsWith('---')) {
          const plain = candidate.replace(/\*\*/g, '')
          const splitAt = plain.indexOf('。')
          headline = splitAt === -1 ? plain : plain.slice(0, splitAt + 1)
          headlineDetail = splitAt === -1 ? '' : plain.slice(splitAt + 1).trim()
          break
        }
      }
    }
    if (/^>\s*\*\*[12]\./.test(lines[i]) || /^>\s*[12]\./.test(lines[i])) {
      premises.push(lines[i].replace(/^>\s*/, '').replace(/\*\*/g, '').trim())
    }
  }
  return { headline, headlineDetail, premises, window, updatedAt: '' }
}

async function readStrategyResults() {
  let entries
  try {
    entries = await readdir(RESULTS_DIR, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name)
  const strategies = []
  for (const file of files) {
    const node = await readJsonTolerant(join(RESULTS_DIR, file))
    if (!node || typeof node !== 'object') continue
    const metrics = node.metrics || {}
    const conclusion = node.conclusion || {}
    strategies.push({
      name: node.name || basename(file, '.json'),
      displayName: text(node.display_name || node.name, 30),
      category: text(node.category, 20),
      alpha: round(metrics.alpha, 4),
      total: round(metrics.total, 4),
      bench: round(metrics.bench, 4),
      mdd: round(metrics.mdd, 4),
      winrate: round(metrics.winrate, 3),
      actT: round(metrics.act_t, 2),
      exBetaT: round(metrics.ex_beta_t, 2),
      grade: text(conclusion.grade, 10),
      verdict: text(conclusion.verdict, 60),
      scenario: text(conclusion.scenario, 120),
      ts: text(node.ts, 24),
    })
  }
  strategies.sort((a, b) => (b.actT ?? -99) - (a.actT ?? -99))
  return strategies
}

export async function getQuantResearch() {
  return cached('quant-research', CACHE_TTL.research, async () => {
    const warnings = []
    const markdown = await readText(DOCS_CONCLUSION)
    if (markdown == null) warnings.push('研究结论文档缺失（归档快照 docs/CONCLUSION.md）')
    const conclusion = extractConclusion(markdown || '')
    let docsUpdatedAt = ''
    try {
      docsUpdatedAt = (await stat(DOCS_CONCLUSION)).mtime.toISOString()
    } catch {
      /* 文档缺失时留空 */
    }

    const strategies = await readStrategyResults()
    if (strategies.length === 0) warnings.push('回测结果缺失（归档快照 backtests/results/*.json）')
    const counts = { effective: 0, edge: 0, invalid: 0, unknown: 0 }
    for (const item of strategies) {
      if (item.grade === '有效') counts.effective += 1
      else if (item.grade === '边缘') counts.edge += 1
      else if (item.grade === '无效') counts.invalid += 1
      else counts.unknown += 1
    }

    return {
      ok: true,
      headline: conclusion.headline,
      headlineDetail: conclusion.headlineDetail,
      premises: conclusion.premises,
      window: conclusion.window,
      docsUpdatedAt,
      counts: { ...counts, total: strategies.length },
      strategies,
      warnings,
    }
  })
}

/* ------------------------------------------------------------------ */
/* 持仓集中度（归档快照：data/holdings_concentration_<date>.json） */
/* ------------------------------------------------------------------ */

export async function getHoldingsConcentration() {
  return cached('holdings', CACHE_TTL.holdings, async () => {
    let files
    try {
      const entries = await readdir(HOLDINGS_DIR, { withFileTypes: true })
      files = entries
        .filter((entry) => entry.isFile() && /^holdings_concentration_\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse()
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, snapshot: null, warnings: ['持仓集中度目录缺失'] }
      throw error
    }
    if (files.length === 0) {
      return { ok: true, snapshot: null, warnings: ['还没有持仓集中度快照（运行 scripts/holdings_concentration_alert.py 生成）'] }
    }
    const latest = files[0]
    const node = await readJsonTolerant(join(HOLDINGS_DIR, latest))
    if (!node) return { ok: true, snapshot: null, warnings: [`${latest} 解析失败`] }
    const generated = parseFetchTime(node.generated_at)
    return {
      ok: true,
      snapshot: {
        date: String(node.date || ''),
        generatedAt: String(node.generated_at || ''),
        ageDays: generated.ageDays,
        holdingsCount: num(node.holdings_count),
        portfolioPct: round(node.port_pct_equal_weight, 4),
        groupWeight: node.group_weight || {},
        groupMembers: node.group_members || {},
        maxGroup: text(node.max_group, 20),
        maxGroupWeight: round(node.max_group_weight, 4),
        riskClusterWeight: round(node.risk_cluster_weight, 4),
        hhi: round(node.hhi, 4),
        alerts: Array.isArray(node.alerts) ? node.alerts.map((item) => text(item, 160)) : [],
      },
      warnings: [],
    }
  })
}

export { clearCache }
