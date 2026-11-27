/**
 * dsh-wallstreet —— 资料检索（host 半）：东方财富妙想「金融资讯搜索」+ Tavily 全网搜索。
 *
 * 为什么单独一层：
 *  - 面板原有资讯是「华尔街见闻 + 财联社快讯」的时间流，只能看最近几小时，
 *    查不到某个题材/个股的历史报道；这里补的是**按问题检索**。
 *  - 妙想（MX）适合金融场景（新闻/公告/研报，带来源与权威等级），Tavily 适合
 *    查全网（政策原文、海外报道、公司官网）。两个 key 都从 .env.local 读，
 *    不落到客户端。
 *  - 上游都可能慢或挂：统一 20s 超时，失败收敛成普通 Error（带中文说明），
 *    由宿主转成 500 + 中文原因，面板显示「检索暂不可用」而不是白屏。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const ENV_LOCAL = process.env.DSH_WALLSTREET_ENV || join(PLUGIN_ROOT, '.env.local')
const MX_URL = 'https://mkapi2.dfcfs.com/finskillshub/api/claw/news-search'
const TAVILY_URL = 'https://api.tavily.com/search'
const KEY_TTL_MS = 60_000

let _cache = { at: 0, tavily: '', mx: '' }

/** 读 .env.local（KEY=VALUE，忽略注释与空行）；进程环境变量优先。 */
async function loadKeys() {
  if (Date.now() - _cache.at < KEY_TTL_MS) return _cache
  let tavily = process.env.TAVILY_API_KEY || ''
  let mx = process.env.MX_APIKEY || ''
  if (!tavily || !mx) {
    try {
      const text = await readFile(ENV_LOCAL, 'utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq < 0) continue
        const key = trimmed.slice(0, eq).trim()
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
        if (key === 'TAVILY_API_KEY' && !tavily) tavily = value
        if (key === 'MX_APIKEY' && !mx) mx = value
      }
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error
    }
  }
  _cache = { at: Date.now(), tavily, mx }
  return _cache
}

async function postJson(url, body, { headers = {}, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
    if (!response.ok) {
      const detail = payload ? payload.message || payload.detail || payload.error : text.slice(0, 200)
      throw new Error(`上游 HTTP ${response.status}${detail ? `：${String(detail).slice(0, 160)}` : ''}`)
    }
    if (payload === null) throw new Error('上游返回的不是 JSON')
    return payload
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error(`上游超时（>${Math.round(timeoutMs / 1000)}s）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function clampLimit(limit) {
  const value = Number.parseInt(limit, 10)
  if (!Number.isFinite(value)) return 8
  return Math.max(1, Math.min(15, value))
}

/** 东方财富妙想：金融资讯检索（新闻/公告/研报）。 */
export async function searchFinance(query, { limit = 8 } = {}) {
  const q = String(query || '').trim()
  if (!q) throw new Error('检索问句为空')
  const { mx } = await loadKeys()
  if (!mx) throw new Error('MX_APIKEY 未配置（写入 .env.local 后重试）')

  const payload = await postJson(MX_URL, { query: q }, { headers: { apikey: mx } })
  if (payload && payload.status !== 0 && payload.status !== undefined) {
    throw new Error(`妙想检索失败：${payload.message || `status ${payload.status}`}`)
  }
  const items = ((((payload || {}).data || {}).data || {}).llmSearchResponse || {}).data || []
  const n = clampLimit(limit)
  const results = items.slice(0, n).map((item) => ({
    title: String(item.title || '').trim(),
    url: String(item.jumpUrl || '').trim(),
    source: String(item.source || '').trim(),
    published: String(item.date || '').trim(),
    snippet: String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 320),
    authority: String(item.authorityLevel || '').trim(),
    kind: String(item.informationType || '').trim(),
  }))
  return { engine: 'mx', query: q, total: items.length, results }
}

/** Tavily：全网检索，带可选 answer 摘要。 */
export async function searchWeb(query, { limit = 8, answer = false } = {}) {
  const q = String(query || '').trim()
  if (!q) throw new Error('检索问句为空')
  const { tavily } = await loadKeys()
  if (!tavily) throw new Error('TAVILY_API_KEY 未配置（写入 .env.local 后重试）')

  const payload = await postJson(
    TAVILY_URL,
    {
      api_key: tavily,
      query: q,
      search_depth: 'basic',
      include_answer: Boolean(answer),
      max_results: clampLimit(limit),
    },
    { timeoutMs: 25_000 },
  )
  const results = (payload.results || []).map((item) => ({
    title: String(item.title || '').trim(),
    url: String(item.url || '').trim(),
    source: (() => {
      try {
        return new URL(item.url).hostname.replace(/^www\./, '')
      } catch {
        return ''
      }
    })(),
    published: String(item.published_date || '').trim(),
    snippet: String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 320),
    authority: '',
    kind: 'web',
  }))
  return {
    engine: 'tavily',
    query: q,
    answer: answer && payload.answer ? String(payload.answer) : '',
    total: results.length,
    results,
  }
}

/** 统一入口：engine=mx|tavily（默认 mx，金融场景更贴切）。 */
export async function searchResources(query, { engine = 'mx', limit = 8, answer = false } = {}) {
  const kind = String(engine || 'mx').toLowerCase()
  if (kind === 'tavily' || kind === 'web') return searchWeb(query, { limit, answer })
  return searchFinance(query, { limit })
}
