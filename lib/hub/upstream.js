/**
 * dsh-wallstreet —— 信息资讯集散中心 · 统一上游调用
 *
 * 为什么单独一层（参照同类插件的做法，见 docs/prior-art-2026-11-25.md §2④）：
 *  - 每个适配器各写一遍 fetch 的结果是「UA 不一致 / 超时口径不一样 / 错误只有一句字符串」，
 *    面板上只能看到一句 `fetch failed`，分不清是超时、限流还是对方 4xx；
 *  - 这里统一成：自报 UA、单请求超时、**总预算内才重试**、错误带稳定 code。
 *
 * 规则：
 *  - UA 必须自报插件名（东财部分边缘节点对 Node 默认 UA 直接 403）；
 *  - 单请求超时 `DEFAULT_TIMEOUT_MS`，一次重试；但重试必须在调用方预算内——
 *    4s 超时 + 重试永远赶不上 6s 的整轮预算，所以「来不及就不发起」；
 *  - 只重试可重试错误（timeout / network / 5xx / 429），4xx 不重试；
 *  - 抛 `UpstreamError`，带 `code`（timeout | network | http | parse | aborted），
 *    上层把它转成中文原因写进 source_state。
 */

export const USER_AGENT =
  'dsh-wallstreet/0.7 (+https://github.com/frankfurtlin; DSH info hub)'

/** 单请求超时。资讯源普遍 1–2s 能回，8s 是给慢站留的余量。 */
export const DEFAULT_TIMEOUT_MS = 8000

/** 一次逻辑抓取（含重试）的总预算：必须小于调用方整轮预算，否则重试没意义。 */
export const DEFAULT_DEADLINE_MS = 12000

/** 默认重试一次。 */
export const DEFAULT_RETRIES = 1

const RETRYABLE_CODES = new Set(['timeout', 'network'])

/** 上游错误：`code` 稳定，`message` 是可以直接给人看的中文。 */
export class UpstreamError extends Error {
  /**
   * @param {string} message 中文原因（会进面板「最近失败」）
   * @param {{ code?: string, url?: string, status?: number, cause?: unknown }} [details]
   */
  constructor(message, { code = 'network', url = '', status, cause, timeoutMs } = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    this.url = url
    if (status !== undefined) this.status = status
    if (cause !== undefined) this.cause = cause
    // 保留本次预算：describeUpstreamError 二次渲染时要用它算「超时（Ns）」。
    if (Number.isFinite(timeoutMs)) this.timeoutMs = Number(timeoutMs)
  }
}

/** 把一条上游链接裁短用于报错（不要把整条 query 打进日志）。 */
function shortUrl(url) {
  const text = String(url || '')
  return text.length > 90 ? `${text.slice(0, 87)}…` : text
}

/**
 * 中文错误文案：面板「最近失败」那一列直接显示它。
 * 超时秒数取**本次实际预算**，不写死——否则某个源改成 3s 时会谎报「超时（8s）」。
 */
export function describeUpstreamError(error, label) {
  const code = error && error.code ? error.code : 'network'
  if (code === 'timeout') {
    const seconds = error && Number.isFinite(error.timeoutMs) ? Math.max(1, Math.round(error.timeoutMs / 1000)) : null
    return seconds ? `${label}超时（${seconds}s）` : `${label}超时`
  }
  if (code === 'aborted') return `${label}请求被取消`
  if (code === 'http') return `${label}上游 HTTP ${error.status || '?'}`
  if (code === 'parse') return `${label}返回的不是 JSON`
  if (code === 'rejected') return `${label}拒绝了请求（上游返回业务错误）`
  return `${label}连不上`
}

/**
 * 抓一次 JSON（带一次重试与总预算）。
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.label] 中文源名，用于错误文案
 * @param {Record<string,string>} [options.headers]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.deadlineMs] 总预算，重试来得及才重试
 * @param {number} [options.retries]
 * @param {'GET'|'POST'} [options.method]
 * @param {string} [options.body]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options = {}) {
  const {
    label = '上游',
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    deadlineMs = DEFAULT_DEADLINE_MS,
    retries = DEFAULT_RETRIES,
    method = 'GET',
    body,
  } = options
  const startedAt = Date.now()
  let lastError = null

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const elapsed = Date.now() - startedAt
    // 预算不够再走一次（至少留 300ms 余量）就别发起了，直接报上一次的错。
    if (attempt > 0 && elapsed + 600 >= deadlineMs) break
    const controller = new AbortController()
    const budget = Math.min(timeoutMs, Math.max(500, deadlineMs - elapsed))
    const timer = setTimeout(() => controller.abort(), budget)
    try {
      const response = await fetch(url, {
        method,
        headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
        body,
        signal: controller.signal,
      })
      if (!response.ok) {
        const error = new UpstreamError(describeUpstreamError({ code: 'http', status: response.status }, label), {
          code: 'http',
          status: response.status,
          url: shortUrl(url),
        })
        // 5xx / 429 是「对方暂时不行」，可以再试一次；4xx 是「请求本身不对」，不重试。
        const retryable = response.status >= 500 || response.status === 429
        if (!retryable) throw Object.assign(error, { fatal: true })
        throw Object.assign(error, { retryable })
      }
      try {
        return await response.json()
      } catch (parseError) {
        throw Object.assign(
          new UpstreamError(describeUpstreamError({ code: 'parse' }, label), { code: 'parse', url: shortUrl(url), cause: parseError }),
          { fatal: true },
        )
      }
    } catch (error) {
      const normalized =
        error instanceof UpstreamError
          ? error
          : new UpstreamError(
              controller.signal.aborted
                ? describeUpstreamError({ code: 'timeout', timeoutMs: budget }, label)
                : describeUpstreamError({ code: 'network' }, label),
              {
                code: controller.signal.aborted ? 'timeout' : 'network',
                url: shortUrl(url),
                cause: error,
                timeoutMs: budget,
              },
            )
      lastError = normalized
      if (normalized.fatal) throw normalized
      if (!normalized.retryable && !RETRYABLE_CODES.has(normalized.code)) throw normalized
      if (attempt === retries) throw normalized
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError || new UpstreamError(`${label}连不上`, { code: 'network', url: shortUrl(url) })
}

/**
 * 抓一次文本。规则与 fetchJson 一致：超时、预算内一次重试、错误带 code。
 *
 * `encoding`：
 *  - `'utf-8'`（默认）/ `'gbk'` 等：按指定编码解；
 *  - `'auto'`：先用**严格** UTF-8 解，解码失败（真 GBK 页）再按 GBK 取一次。
 *    为什么不用非严格解码后看有没有 U+FFFD：那样只会在正文里留下乱码，不报错，
 *    等于把「编码判断」推给每个调用方。
 *
 * @param {string} url
 * @param {object} [options] 同 fetchJson，另加 `encoding`
 * @returns {Promise<string>}
 */
export async function fetchText(url, options = {}) {
  const {
    label = '上游',
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    deadlineMs = DEFAULT_DEADLINE_MS,
    retries = DEFAULT_RETRIES,
    method = 'GET',
    body,
    encoding = 'utf-8',
  } = options

  async function once() {
    const controller = new AbortController()
    const budget = Math.max(500, Math.min(timeoutMs, deadlineMs))
    const timer = setTimeout(() => controller.abort(), budget)
    try {
      const response = await fetch(url, {
        method,
        headers: { 'user-agent': USER_AGENT, ...headers },
        body,
        signal: controller.signal,
      })
      if (!response.ok) {
        throw Object.assign(
          new UpstreamError(describeUpstreamError({ code: 'http', status: response.status }, label), {
            code: 'http',
            status: response.status,
            url: shortUrl(url),
          }),
          { retryable: response.status >= 500 || response.status === 429, fatal: response.status < 500 && response.status !== 429 },
        )
      }
      const buffer = await response.arrayBuffer()
      if (encoding === 'auto') {
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
        } catch {
          return new TextDecoder('gbk').decode(buffer)
        }
      }
      try {
        return new TextDecoder(encoding).decode(buffer)
      } catch {
        return new TextDecoder('utf-8').decode(buffer)
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error
      throw new UpstreamError(
        controller.signal.aborted
          ? describeUpstreamError({ code: 'timeout', timeoutMs: budget }, label)
          : describeUpstreamError({ code: 'network' }, label),
        { code: controller.signal.aborted ? 'timeout' : 'network', url: shortUrl(url), cause: error, timeoutMs: budget },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  const startedAt = Date.now()
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0 && Date.now() - startedAt + 600 >= deadlineMs) break
    try {
      return await once()
    } catch (error) {
      lastError = error
      if (error.fatal) throw error
      if (!error.retryable && !RETRYABLE_CODES.has(error.code)) throw error
      if (attempt === retries) throw error
    }
  }
  throw lastError || new UpstreamError(`${label}连不上`, { code: 'network', url: shortUrl(url) })
}
