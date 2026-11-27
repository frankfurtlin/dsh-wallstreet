/**
 * dsh-wallstreet —— 信息资讯集散中心 · 进程内缓存（三档）
 *
 * 参照同类插件的 cache 设计（docs/prior-art-2026-11-25.md §2⑤）：
 *  - `memo(key, ttlMs, loader)`：命中就返回；**并发调用共用同一个 Promise**，
 *    防一页刷新打出 N 个相同上游请求；
 *  - `peek(key)`：过期也读得到——上游挂了用它顶上，面板不至于直接少一块；
 *  - `set(key, value, ttlMs)`：预热/测试用。
 *
 * 额外两件事：时间可注入（`now`）方便验收脚本拨表；条目上限到达后按最旧淘汰，
 * 防止长期驻留的宿主进程把带用户输入的 key 攒成内存泄漏。
 */

/**
 * @param {{ now?: () => number, maxEntries?: number }} [options]
 */
export function createCache({ now = Date.now, maxEntries = 512 } = {}) {
  /** @type {Map<string, { value: unknown, storedAt: number, expiresAt: number }>} */
  const entries = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const pending = new Map()

  function sweep() {
    if (entries.size <= maxEntries) return
    const at = now()
    for (const [key, entry] of entries) {
      if (at >= entry.expiresAt) entries.delete(key)
    }
    if (entries.size > maxEntries) {
      const oldest = [...entries.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)
      for (const [key] of oldest.slice(0, entries.size - maxEntries)) entries.delete(key)
    }
  }

  /** 读未过期的值；没有返回 undefined。 */
  function get(key) {
    const entry = entries.get(key)
    if (!entry) return undefined
    if (now() >= entry.expiresAt) return undefined
    return entry.value
  }

  /** 过期也读：返回 `{ value, staleMs }`，没有返回 undefined。 */
  function peek(key) {
    const entry = entries.get(key)
    if (!entry) return undefined
    return { value: entry.value, staleMs: Math.max(0, now() - entry.expiresAt) }
  }

  /**
   * 走缓存：新鲜就返回；否则调 loader，成功后写入。
   * @param {string} key
   * @param {number} ttlMs
   * @param {() => Promise<any>} loader
   */
  async function memo(key, ttlMs, loader) {
    const hit = get(key)
    if (hit !== undefined) return hit
    const inflight = pending.get(key)
    if (inflight) return inflight
    const task = (async () => {
      const value = await loader()
      entries.set(key, { value, storedAt: now(), expiresAt: now() + Math.max(0, ttlMs) })
      sweep()
      return value
    })()
    pending.set(key, task)
    try {
      return await task
    } finally {
      pending.delete(key)
    }
  }

  /**
   * 写入一条值。
   * @param {string} key
   * @param {any} value
   * @param {number} ttlMs 从**现在**起算的存活时间
   * @param {{ storedAt?: number }} [options] 允许指定「这条数据其实是何时拿到的」，
   *   用于把磁盘里已经放了两天的缓存灌回内存（此时按剩余 TTL 算，可能已经是过期值，
   *   只能被 peek 读到——这正是 stale 兜底想要的语义）。
   */
  function set(key, value, ttlMs, options = {}) {
    const storedAt = Number.isFinite(options.storedAt) ? Number(options.storedAt) : now()
    entries.set(key, { value, storedAt, expiresAt: storedAt + Math.max(0, ttlMs) })
    sweep()
  }

  /** 显式写入「已过期」的值：只给 peek 兜底用，get 不会命中。 */
  function setStale(key, value, storedAt = now()) {
    entries.set(key, { value, storedAt: Number(storedAt) || now(), expiresAt: 0 })
    sweep()
  }

  function deleteKey(key) {
    entries.delete(key)
  }

  function clear() {
    entries.clear()
    pending.clear()
  }

  function size() {
    return entries.size
  }

  return { get, peek, memo, set, setStale, delete: deleteKey, clear, size }
}
