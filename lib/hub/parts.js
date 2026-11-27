/**
 * dsh-wallstreet —— 聚合接口的「分区四态」执行器
 *
 * 参照同类插件 `5777-wq/dsh-openfin` 的 `lib/snapshot.js`。一个聚合响应由若干 part 组成，
 * 每个 part 只有四种归宿：
 *
 *   1. 缓存命中且新鲜        → 直接用，`ok: true`（不碰上游）
 *   2. loader 成功           → 用手里的值，`ok: true`
 *   3. loader 失败但有过期值 → **照样返回旧值**，`stale: true`、`ok: true`
 *   4. 连旧值都没有          → `value: undefined`、`ok: false` + 错误码
 *
 * 另外两个刻意的设计：
 *  - 每个 part 有独立 deadline；**超时不是取消**——loader 继续跑，结果仍然会写进缓存
 *    （缓存由调用方的 memo 负责落盘），下一轮刷新直接用上。注释见 withDeadline。
 *  - 错误码收敛成固定枚举（timeout / network / http / parse / empty / unknown），
 *    面板只显示人话文案，代码只比较错误码。
 */

/** 允许出现的错误码。 */
export const PART_ERROR_CODES = ['timeout', 'network', 'http', 'parse', 'empty', 'unknown']

/**
 * 把任意异常收敛成错误码。
 * @param {unknown} error
 * @returns {string}
 */
export function partErrorCode(error) {
  if (!error) return 'unknown'
  const code = typeof error === 'object' && error !== null ? String(error.code || '') : ''
  if (PART_ERROR_CODES.includes(code)) return code
  const status = typeof error === 'object' && error !== null ? error.status : undefined
  if (Number.isFinite(status)) return 'http'
  const message = String((error && error.message) || error || '')
  if (/timeout|超时|timed out|abort/i.test(message)) return 'timeout'
  if (/network|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|连不上|socket/i.test(message)) return 'network'
  if (/http|status|HTTP \d/i.test(message)) return 'http'
  if (/json|parse|格式|结构/i.test(message)) return 'parse'
  if (/空|empty/i.test(message)) return 'empty'
  return 'unknown'
}

/** 中文文案：给 warnings 用。 */
export function partErrorText(id, error) {
  const code = partErrorCode(error)
  const map = {
    timeout: '超时',
    network: '连不上',
    http: '上游报错',
    parse: '返回格式不对',
    empty: '返回空数据',
    unknown: '未知错误',
  }
  return `${id}${map[code] || '不可用'}（${code}）`
}

function withDeadline(promise, ms, PartTimeout) {
  if (!(ms > 0)) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PartTimeout(ms)), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  }).finally(() => {
    // 超时后原 promise 仍在跑，把它挂住避免 unhandled rejection；结果由 memo 自行落缓存。
    Promise.resolve(promise).catch(() => {})
  })
}

/** 超时专用错误：code 固定为 timeout。 */
class PartTimeout extends Error {
  constructor(ms) {
    super(`part timeout after ${ms}ms`)
    this.name = 'PartTimeoutError'
    this.code = 'timeout'
    this.timeoutMs = ms
  }
}

/**
 * @param {{
 *   cache: { memo: (key: string, ttlMs: number, loader: () => Promise<any>) => Promise<any>,
 *            peek: (key: string) => { value: any } | undefined },
 *   now?: () => number,
 *   deadlineMs?: number,
 * }} options
 */
export function createPartsRunner({ cache, now = Date.now, deadlineMs = 6000 } = {}) {
  if (!cache || typeof cache.memo !== 'function' || typeof cache.peek !== 'function') {
    throw new TypeError('createPartsRunner: cache 需要 memo 与 peek')
  }

  /**
   * @param {string} id 分区名（也是默认缓存键的一部分）
   * @param {() => Promise<any>} loader
   * @param {{ key?: string, ttlMs?: number }} [options]
   * @returns {Promise<{ id: string, ok: boolean, ms: number, stale: boolean, value: any, error?: string }>}
   */
  async function run(id, loader, { key = id, ttlMs = 60_000 } = {}) {
    const startedAt = now()
    if (typeof loader !== 'function') {
      return { id, ok: false, ms: 0, stale: false, value: undefined, error: 'unknown' }
    }
    try {
      const value = await withDeadline(cache.memo(key, ttlMs, loader), deadlineMs, PartTimeout)
      return { id, ok: true, ms: Math.max(0, now() - startedAt), stale: false, value }
    } catch (error) {
      // 失败就用上一份成功值顶上——少一块数据比整页空白好。
      const cached = cache.peek(key)
      if (cached && cached.value !== undefined && cached.value !== null) {
        return {
          id,
          ok: true,
          ms: Math.max(0, now() - startedAt),
          stale: true,
          value: cached.value,
          error: partErrorCode(error),
        }
      }
      return { id, ok: false, ms: Math.max(0, now() - startedAt), stale: false, value: undefined, error: partErrorCode(error) }
    }
  }

  /** 汇总成响应里的 `parts`（不带 value，避免把 payload 翻倍）。 */
  function summarize(results) {
    return (Array.isArray(results) ? results : []).map((result) => ({
      id: result.id,
      ok: result.ok === true,
      ms: Number(result.ms) || 0,
      ...(result.stale ? { stale: true } : {}),
      ...(result.ok === false && result.error ? { error: result.error } : {}),
    }))
  }

  return { run, summarize, deadlineMs }
}
