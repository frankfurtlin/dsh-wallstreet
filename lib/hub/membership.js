/**
 * dsh-wallstreet —— 信息资讯集散中心 · 板块成分股映射
 *
 * 目的：把「板块 → 资讯」从关键词匹配升级成成分股匹配。半导体设备板块的资讯，
 * 应该是「成分股被提到」的资讯，而不是「标题里出现半导体」的资讯。
 *
 * 数据来源：东方财富行业板块（`fs=m:90+t:2` 列表 + `fs=b:BKxxxx` 成分）。
 * 为什么是**按需懒取**而不是一次全量构建：
 *  - 这台机器到东财 push2 是间歇性 RST（README 有记录），300 个板块连着抓必然中途断；
 *  - 面板一次只展示 16 个板块，命中率极高的其实就那几个；
 *  - 抓到的结果落到 `data/sector-members.json`，之后一直用缓存。
 *
 * 本轮（2026-11-25）按真机踩到的问题改了抓法（参照同类插件 dsh-openfin 的 boards.js）：
 *  1. 板块列表从「涨跌幅 f3 + 翻 5 页」改成「**市值 f20** + pz=150 一页拿全」。
 *     原来 push2 一 RST 就只剩第一页 100 个板块（全量 ~300+），`半导体设备`、
 *     `电子化学品Ⅲ` 这些细分名永远在后几页，永远拿不到。一页给满才补第 2 页。
 *  2. 成分股从 `fid=f3` 改成 `fid=f6`（成交额降序）、pz=400；东财 clist 单页可能只回
 *     100 条，所以按页补齐（最多 4 页），页间仍保留 1.2s 间隔。
 *  3. 名单与成分股都走 cache.js：失败时用 `peek()` 读过期值顶上，返回里标 `stale: true`，
 *     **绝不因为一次 RST 把已有缓存清空**；过期数据继续供读，后台再补。
 *
 * 其它口径不变：按名字/代码查找、`basis` 语义（members / pending；keywords 由上层给）、
 * 后台队列每轮最多 3 个 + 1.2s 间隔、失败退避 30 分钟、`membershipStats()` 字段名
 * （boards / boardsWithMembers / memberCodes / pending / failures）——面板和 /hub/stats 在消费它们。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSector, sectorMatches } from './schema.js'
import { fetchJson, UpstreamError } from './upstream.js'
import { createCache } from './cache.js'

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const DATA_DIR = process.env.DSH_WALLSTREET_DATA || join(PLUGIN_ROOT, 'data')
/** 缓存文件路径在调用时读环境变量：验收脚本会在 import 之后再指到临时文件。 */
function cachePath() {
  return process.env.DSH_WALLSTREET_MEMBERS_FILE || join(DATA_DIR, 'sector-members.json')
}

/* ---------------------------------------------------------------- 上游地址 */

/**
 * push2 主域 + 两个子域。主域被 RST 时挨个换（三个域共用同一套 API）。
 * 可用 `DSH_WALLSTREET_PUSH_HOSTS=a,b`（只写域名、不带协议）或 `setPushHosts()` 覆盖（验收脚本用）。
 */
const DEFAULT_PUSH_HOSTS = ['push2.eastmoney.com', '82.push2.eastmoney.com', '48.push2.eastmoney.com']

/**
 * push2 的边缘节点对非浏览器 UA 更挑剔（历史上有 Node 默认 UA 直接 403 的记录），
 * 这里显式覆盖；upstream.js 的 `headers` 就是留给这种个例的。
 */
const EASTMONEY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** 板块列表：按市值（f20）排序，热榜稳定；pz=150 一页覆盖全部行业板块。 */
const BOARD_LIST_PAGE_SIZE = 150
/** 只有「这一页刚好给满」才补第 2 页。150×2 足够兜住 300+ 个行业板块。 */
const BOARD_MAX_PAGES = 2
/** 成分股：按成交额（f6）降序；做徽标计数要尽量全，所以 pz=400。 */
const MEMBERS_PAGE_SIZE = 400
/** 单页被压到 100 条时翻页补齐，最多 4 页。 */
const MEMBERS_MAX_PAGES = 4
/** 东财 clist 的单页上限：pz 给得再大也可能只回 100 条。 */
const CLIST_PAGE_CAP = 100

const BOARD_LIST_QUERY = (pn) =>
  `/api/qt/clist/get?pn=${pn}&pz=${BOARD_LIST_PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f20&fs=m:90+t:2&fields=f12,f14`

const MEMBERS_QUERY = (code, pn) =>
  `/api/qt/clist/get?pn=${pn}&pz=${MEMBERS_PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f6&fs=b:${code}&fields=f12,f14`

/* ---------------------------------------------------------------- 缓存口径 */

/** 板块名单 12 小时最多刷一次。 */
const BOARD_TTL_MS = 12 * 60 * 60 * 1000
/** 板块成分股 24 小时最多刷一次；成分变动很慢，过期了也照读。 */
const MEMBERS_TTL_MS = 24 * 60 * 60 * 1000
/** 单次抓取之间的最小间隔：给东财留余地，避免触发 RST。 */
const FETCH_GAP_MS = 1200
/** 一轮后台补数最多抓几个板块。 */
const QUEUE_BATCH = 3
/** 抓失败的板块/名单 30 分钟内不再重试。 */
const FAIL_BACKOFF_MS = 30 * 60 * 1000
/** 单请求超时与一次逻辑抓取的总预算（重试只在来得及且上次秒失败时发生）。 */
const FETCH_TIMEOUT_MS = 6000
const FETCH_DEADLINE_MS = FETCH_TIMEOUT_MS
/** 换域名前的间隔：刚被 RST 立刻打同一台边缘没意义。 */
const HOST_SWITCH_GAP_MS = 300

const BOARD_LIST_KEY = 'boards:list'
const membersKey = (code) => `members:${code}`

/* ---------------------------------------------------------------- 运行态 */

/** 进程内缓存：上游结果都先进这里，过期也读得到（stale 兜底）。 */
const memory = createCache({ maxEntries: 1024 })

/** 磁盘缓存对象（`sector-members.json`）：长期存储，跨重启。 */
let cache = null
let cacheLoadedAt = 0
let lastFetchAt = 0
let hostIndex = 0
/** @type {string[]|null} */
let hostOverride = null
let inFlight = null

/** 名称 → 已知板块代码（面板传来的 BKxxxx），pump 时优先用它，省一次名单请求。 */
const pendingCodes = new Map()
const queue = []
const queueSet = new Set()
const failures = new Map()
let reverseCache = { at: 0, index: new Map() }

/* ---------------------------------------------------------------- 磁盘缓存 */

function emptyCache() {
  return { version: 1, boards: {}, listFetchedAt: 0, updatedAt: 0 }
}

/** 读进来的东西一律先规整：坏条目丢掉，成员去重，缺字段补默认。 */
function normalizeCache(parsed) {
  const base = emptyCache()
  if (!parsed || typeof parsed !== 'object') return base
  base.version = Number(parsed.version) || 1
  base.listFetchedAt = Number(parsed.listFetchedAt) || 0
  base.updatedAt = Number(parsed.updatedAt) || 0
  const boards = parsed.boards && typeof parsed.boards === 'object' ? parsed.boards : {}
  for (const [name, entry] of Object.entries(boards)) {
    if (!name || !entry || typeof entry !== 'object') continue
    const code = /^BK\d+$/.test(String(entry.code || '').trim()) ? String(entry.code).trim() : ''
    if (!code) continue
    const members = Array.isArray(entry.members)
      ? [...new Set(entry.members.map((item) => String(item || '').trim()).filter((item) => /^\d{6}$/.test(item)))]
      : []
    base.boards[name] = {
      code,
      listedAt: Number(entry.listedAt) || 0,
      members,
      fetchedAt: Number(entry.fetchedAt) || 0,
    }
  }
  return base
}

async function readCache() {
  try {
    const text = await readFile(cachePath(), 'utf8')
    return normalizeCache(JSON.parse(text))
  } catch {
    /* 首次运行或文件损坏都按空缓存处理 */
    return emptyCache()
  }
}

/** 用磁盘里的名单/成分股把内存缓存热起来：TTL 按「已经过了多久」扣，过期的也留一份给 peek。 */
function seedMemory(membership) {
  const now = Date.now()
  const snapshot = {}
  for (const [name, entry] of Object.entries(membership.boards || {})) {
    if (entry && /^BK\d+$/.test(String(entry.code || ''))) snapshot[name] = String(entry.code)
  }
  if (Object.keys(snapshot).length > 0) {
    const listAge = membership.listFetchedAt > 0 ? now - membership.listFetchedAt : null
    memory.set(BOARD_LIST_KEY, snapshot, listAge === null ? 0 : Math.max(0, BOARD_TTL_MS - listAge))
  }
  for (const entry of Object.values(membership.boards || {})) {
    if (!usable(entry)) continue
    const fetchedAt = Number(entry.fetchedAt) || 0
    const ttl = fetchedAt > 0 ? Math.max(0, MEMBERS_TTL_MS - (now - fetchedAt)) : 0
    memory.set(membersKey(entry.code), entry.members.slice(), ttl)
  }
}

/** 读缓存（进程内 5 分钟）。 */
export async function loadMembership(force = false) {
  if (!force && cache && Date.now() - cacheLoadedAt < 5 * 60 * 1000) return cache
  cache = await readCache()
  cacheLoadedAt = Date.now()
  seedMemory(cache)
  reverseCache = { at: 0, index: new Map() }
  return cache
}

async function saveCache() {
  if (!cache) return false
  cache.updatedAt = Date.now()
  try {
    const target = cachePath()
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(cache, null, 1))
    await rename(tmp, target)
    return true
  } catch {
    // 落盘失败不影响内存里已经拿到的数据（不抛，避免把一次成功抓取记成失败）
    return false
  }
}

/* ---------------------------------------------------------------- 上游抓取 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function errorText(error) {
  return error && error.message ? error.message : String(error)
}

/** 两个请求之间至少隔 FETCH_GAP_MS（翻页、换板块都走这里）。 */
async function respectGap() {
  const gap = FETCH_GAP_MS - (Date.now() - lastFetchAt)
  if (gap > 0) await sleep(gap)
  lastFetchAt = Date.now()
}

function hostList() {
  if (hostOverride && hostOverride.length > 0) return hostOverride
  const env = String(process.env.DSH_WALLSTREET_PUSH_HOSTS || '').trim()
  if (env) {
    const parsed = env
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean)
    if (parsed.length > 0) return parsed
  }
  return DEFAULT_PUSH_HOSTS
}

/** 验收/调试用：临时替换 push2 域名（传空数组恢复默认，环境变量优先于默认值）。 */
export function setPushHosts(hosts) {
  hostOverride =
    Array.isArray(hosts) && hosts.length > 0 ? hosts.map((host) => String(host).trim()).filter(Boolean) : null
  hostIndex = 0
}

/** 按域后备：主域失败换子域，各域之间轮转起点，全失败才抛最后一次的错。 */
async function fetchJsonWithHosts(pathAndQuery, label) {
  const hosts = hostList()
  let lastError = null
  for (let attempt = 0; attempt < hosts.length; attempt += 1) {
    const host = hosts[hostIndex % hosts.length]
    hostIndex += 1
    const url = `https://${host}${pathAndQuery}`
    try {
      return await fetchJson(url, {
        label,
        headers: { 'user-agent': EASTMONEY_UA },
        timeoutMs: FETCH_TIMEOUT_MS,
        deadlineMs: FETCH_DEADLINE_MS,
        retries: 1,
      })
    } catch (error) {
      lastError = error
      if (attempt + 1 < hosts.length) await sleep(HOST_SWITCH_GAP_MS)
    }
  }
  throw lastError || new UpstreamError(`${label}不可用（没有可用域名）`, { code: 'network' })
}

/** `data.diff` 正常是数组，东财偶尔给「下标 → 行」的对象，两种都收。 */
function diffRows(json) {
  const diff = json && json.data ? json.data.diff : null
  if (Array.isArray(diff)) return diff
  if (diff && typeof diff === 'object') return Object.values(diff)
  return []
}

function totalOf(json) {
  const total = json && json.data ? Number(json.data.total) : 0
  return Number.isFinite(total) && total > 0 ? total : 0
}

/**
 * 这一页之后还有没有下一页。
 * `data.total` 最准；没有 total 时看「这一页给满了吗」——给满按还有下一页算，
 * 另外把已知的单页上限（100）也当成「可能还有」，防止 pz 被压到 100 时漏掉后半截。
 */
function pageHasMore(rows, pageSize, fetchedRows, total) {
  if (rows.length === 0) return false
  if (total > 0) return fetchedRows < total
  return rows.length >= pageSize || rows.length === CLIST_PAGE_CAP
}

/* ---------------------------------------------------------------- 板块名单 */

/**
 * 抓板块名单（市值排序一页拿全，只在首屏给满时补第 2 页）。
 * `snapshot` 是调用方持有的对象：**逐页增量写入**，第 2 页失败时已拿到的页不会丢。
 * @returns {Promise<Record<string, string>>} 名称 → BK 代码
 */
async function fetchBoardPages(snapshot) {
  let fetched = 0
  for (let page = 1; page <= BOARD_MAX_PAGES; page += 1) {
    await respectGap()
    const json = await fetchJsonWithHosts(BOARD_LIST_QUERY(page), `板块列表(第${page}页)`)
    const rows = diffRows(json)
    if (rows.length === 0) break
    for (const row of rows) {
      const name = String(row.f14 || '').trim()
      const code = String(row.f12 || '').trim()
      if (!name || !/^BK\d+$/.test(code)) continue
      snapshot[name] = code
      fetched += 1
    }
    if (!pageHasMore(rows, BOARD_LIST_PAGE_SIZE, fetched, totalOf(json))) break
  }
  if (fetched === 0) throw new UpstreamError('板块列表为空', { code: 'parse' })
  return snapshot
}

/** 把一份名单快照并进磁盘缓存；代码变了才清成分股（换代码就不是同一回事了）。 */
function mergeBoardSnapshot(membership, snapshot) {
  let merged = 0
  for (const [name, code] of Object.entries(snapshot || {})) {
    if (!name || !code) continue
    const previous = membership.boards[name]
    const sameCode = Boolean(previous && previous.code === code)
    membership.boards[name] = {
      code,
      listedAt: sameCode ? previous.listedAt : Date.now(),
      members: sameCode ? previous.members || [] : [],
      fetchedAt: sameCode ? previous.fetchedAt || 0 : 0,
    }
    merged += 1
  }
  return merged
}

/** 名单是不是还新鲜（TTL 内且不是空名单）。 */
function boardListFresh(membership) {
  if (Object.keys(membership.boards).length === 0) return false
  if (!membership.listFetchedAt) return false
  return Date.now() - membership.listFetchedAt < BOARD_TTL_MS
}

/**
 * 刷板块名单。失败时按「已拿到的页 → peek 过期名单 → 磁盘旧名单」三级兜底，
 * 全部没有才返回 null；**任何情况下都不清空已有板块**。
 * @returns {Promise<{ boards: Record<string, any>, stale: boolean }|null>}
 */
async function refreshBoardList(membership) {
  if (boardListFresh(membership)) return { boards: membership.boards, stale: false }

  const partial = {}
  let fresh = null
  let failure = null
  try {
    fresh = await memory.memo(BOARD_LIST_KEY, BOARD_TTL_MS, () => fetchBoardPages(partial))
  } catch (error) {
    failure = error
    failures.set('board-list', { at: Date.now(), error: errorText(error) })
  }

  let merged = mergeBoardSnapshot(membership, fresh || partial)
  if (!fresh) {
    // 上游失败：过期名单也读出来（peek 不看过期），磁盘里已有的板块在 membership 里没动。
    const stale = memory.peek(BOARD_LIST_KEY)
    if (stale && stale.value) merged += mergeBoardSnapshot(membership, stale.value)
    if (merged > 0) await saveCache()
    if (Object.keys(membership.boards).length === 0) return null
    return { boards: membership.boards, stale: true, error: failure }
  }

  membership.listFetchedAt = Date.now()
  if (merged > 0) await saveCache()
  failures.delete('board-list')
  return { boards: membership.boards, stale: false }
}

/* ---------------------------------------------------------------- 成分股 */

/**
 * 抓一个板块的成分股（成交额降序；单页被压到 100 条时翻页补齐，最多 4 页）。
 * @returns {Promise<string[]>} 6 位代码，已去重
 */
async function fetchMemberPages(board) {
  const codes = []
  const seen = new Set()
  let fetched = 0
  for (let page = 1; page <= MEMBERS_MAX_PAGES; page += 1) {
    await respectGap()
    const json = await fetchJsonWithHosts(MEMBERS_QUERY(board.code, page), `${board.name}成分股(第${page}页)`)
    const rows = diffRows(json)
    if (rows.length === 0) break
    for (const row of rows) {
      const code = String(row.f12 || '').trim()
      if (!/^\d{6}$/.test(code) || seen.has(code)) continue
      seen.add(code)
      codes.push(code)
    }
    fetched += rows.length
    if (!pageHasMore(rows, MEMBERS_PAGE_SIZE, fetched, totalOf(json))) break
  }
  if (codes.length === 0) throw new UpstreamError(`${board.name}成分股为空`, { code: 'parse' })
  return codes
}

/**
 * 拿一个板块的成分股：先走 memory.memo（并发去重），失败再用 peek 的过期值顶上。
 * @returns {Promise<{ codes: string[], stale: boolean, error: Error|null }>}
 */
async function refreshMembers(board) {
  const key = membersKey(board.code)
  try {
    const codes = await memory.memo(key, MEMBERS_TTL_MS, () => fetchMemberPages(board))
    return { codes, stale: false, error: null }
  } catch (error) {
    const stale = memory.peek(key)
    if (stale && Array.isArray(stale.value) && stale.value.length > 0) {
      // 上游挂了，但过期值是能用的：标 stale 返回，调用方不覆盖 fetchedAt。
      return { codes: stale.value, stale: true, error }
    }
    throw error
  }
}

/** 名称 → 板块条目（精确优先，其次归一化包含）。 */
function findBoard(boardList, name) {
  if (!boardList) return null
  const raw = String(name || '').trim()
  if (!raw) return null
  if (boardList[raw]) return { name: raw, ...boardList[raw] }
  const target = normalizeSector(raw)
  if (!target) return null
  for (const [key, value] of Object.entries(boardList)) {
    if (normalizeSector(key) === target) return { name: key, ...value }
  }
  for (const [key, value] of Object.entries(boardList)) {
    if (sectorMatches(key, raw)) return { name: key, ...value }
  }
  return null
}

/** 缓存里是否有可用的成分股（不看 TTL：过期也照读，只是标 stale）。 */
function usable(entry) {
  return Boolean(entry && Array.isArray(entry.members) && entry.members.length > 0)
}

/** 成分股是否已经过了 24h（过期但可读，后台会补）。 */
function isStaleMembers(entry) {
  if (!entry) return true
  const fetchedAt = Number(entry.fetchedAt) || 0
  return fetchedAt <= 0 || Date.now() - fetchedAt >= MEMBERS_TTL_MS
}

/**
 * 读一个板块的成分股。**只读缓存**，不发起网络请求；缺的排进后台队列。
 * `stale: true` = 数据在、但已经过了 24h TTL（上游没刷新成功），可以继续用。
 * `allowFetch: true` 时，缺数据或数据已过期会同步补一次（验收/点开抽屉时用）。
 * @returns {Promise<{ name: string, codes: string[], basis: 'members'|'keywords'|'pending', stale: boolean }|null>}
 */
export async function membersOf(name, { allowFetch = false, code = '' } = {}) {
  let membership = await loadMembership()
  const label = String(name || '').trim()
  const explicit = /^BK\d+$/.test(String(code || '').trim()) ? String(code).trim() : ''
  const lookup = label || explicit

  // 面板从 /overview 直接拿到了板块代码时，名字对不上代码就不算命中（代码才是准的）。
  const cached = findBoard(membership.boards, label)
  const found = cached && (!explicit || cached.code === explicit) ? cached : null

  if (found && usable(found)) {
    const stale = isStaleMembers(found)
    if (stale) {
      // 过期可读 + 后台补：读路径照常出数，队列里排一次刷新。
      enqueue(found.name, explicit)
      if (allowFetch) {
        await pumpQueue()
        membership = await loadMembership()
        const refreshed = findBoard(membership.boards, lookup)
        if (refreshed && usable(refreshed) && (!explicit || refreshed.code === explicit)) {
          return {
            name: refreshed.name,
            codes: refreshed.members.slice(),
            basis: 'members',
            stale: isStaleMembers(refreshed),
          }
        }
      }
    }
    return { name: found.name, codes: found.members.slice(), basis: 'members', stale }
  }

  if (explicit) {
    // 代码才是准的：按代码登记一条空条目，等后台补；同名旧条目的成员不动。
    const key = lookup
    const previous = membership.boards[key]
    if (!previous || previous.code !== explicit) {
      membership.boards[key] = { code: explicit, listedAt: Date.now(), members: [], fetchedAt: 0 }
    }
    enqueue(key, explicit)
  } else {
    enqueue(found ? found.name : label)
  }

  if (allowFetch) {
    await pumpQueue()
    membership = await loadMembership()
    const refreshed = findBoard(membership.boards, lookup)
    if (refreshed && usable(refreshed) && (!explicit || refreshed.code === explicit)) {
      return {
        name: refreshed.name,
        codes: refreshed.members.slice(),
        basis: 'members',
        stale: isStaleMembers(refreshed),
      }
    }
  }
  return { name: found ? found.name : lookup, codes: [], basis: 'pending', stale: false }
}

/** 个股 → 板块名（只覆盖已抓到的板块，缺失的返回空数组）。 */
export async function sectorsOfTicker(code) {
  const membership = await loadMembership()
  const target = String(code || '').trim()
  if (!target) return []
  const out = []
  for (const [name, entry] of Object.entries(membership.boards)) {
    if (usable(entry) && entry.members.includes(target)) out.push(name)
  }
  return out
}

/* ---------------------------------------------------------------- 后台补数 */

/**
 * 排队补一个板块。失败过的名字 30 分钟内不重试（避免每 30 秒打一次必然失败的上游）。
 * `code` 是面板给的 BKxxxx，记下来可以省一次名单请求。
 */
function enqueue(name, code = '') {
  const key = String(name || '').trim()
  if (!key) return
  const explicit = /^BK\d+$/.test(String(code || '').trim()) ? String(code).trim() : ''
  if (explicit) pendingCodes.set(key, explicit)
  if (queueSet.has(key)) return
  const failure = failures.get(key)
  if (failure && Date.now() - failure.at < FAIL_BACKOFF_MS) return
  queue.push(key)
  queueSet.add(key)
}

/**
 * 后台补数：一次最多尝试 QUEUE_BATCH 个（失败也算一次，避免上游全挂时把整条队列扫光），
 * 串行、请求间隔 1.2s。名单里没有的先刷一次板块名单。
 */
export async function pumpQueue() {
  if (inFlight) return inFlight
  inFlight = (async () => {
    let membership = await loadMembership()
    const needsList = queue.some((name) => !pendingCodes.has(name) && !findBoard(membership.boards, name))
    let listStale = false
    if (needsList) {
      const result = await refreshBoardList(membership)
      listStale = !result || result.stale
    }

    let done = 0
    let stale = 0
    let attempts = 0
    while (queue.length > 0 && attempts < QUEUE_BATCH) {
      const name = queue.shift()
      queueSet.delete(name)
      attempts += 1
      membership = await loadMembership()
      const knownCode = pendingCodes.get(name)
      const board = knownCode
        ? { name, code: knownCode, members: [], fetchedAt: 0, listedAt: 0 }
        : findBoard(membership.boards, name)
      if (!board) {
        // 名单本身没抓到时是**暂时**找不到：不记这个板块的 30 分钟退避，
        // 下一次 membersOf() 还会重新排队，等名单恢复就能补上。
        if (!listStale) failures.set(name, { at: Date.now(), error: '板块列表里没有这个板块' })
        continue
      }
      try {
        const result = await refreshMembers(board)
        if (result.stale) {
          stale += 1
          // 过期值顶上：成员保持不动、fetchedAt 不覆盖，等退避结束后再补。
          failures.set(name, {
            at: Date.now(),
            error: `上游失败，沿用过期缓存（${result.codes.length} 只）：${errorText(result.error)}`,
          })
          continue
        }
        const current = (await loadMembership()).boards
        const previous = current[board.name] || {}
        current[board.name] = {
          code: board.code,
          listedAt: previous.listedAt || board.listedAt || Date.now(),
          members: result.codes.slice(),
          fetchedAt: Date.now(),
        }
        await saveCache()
        failures.delete(board.name)
        failures.delete(name)
        pendingCodes.delete(name)
        done += 1
      } catch (error) {
        failures.set(name, { at: Date.now(), error: errorText(error) })
      }
    }
    return { done, stale, pending: queue.length }
  })()
  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

/** 健康度快照（面板/验收看：缓存了多少板块、多少成分、最近失败原因）。 */
export async function membershipStats() {
  const membership = await loadMembership()
  const boards = Object.entries(membership.boards || {})
  const withMembers = boards.filter(([, entry]) => usable(entry))
  const codes = new Set()
  for (const [, entry] of withMembers) for (const code of entry.members) codes.add(code)
  return {
    boards: boards.length,
    boardsWithMembers: withMembers.length,
    memberCodes: codes.size,
    pending: queue.length,
    updatedAt: membership.updatedAt || 0,
    // 过期但还能读的板块数（上游抽风时的观察指标；不影响上面几个字段的口径）
    staleBoards: withMembers.filter(([, entry]) => isStaleMembers(entry)).length,
    failures: [...failures.entries()].map(([name, info]) => ({ name, ...info })).slice(0, 10),
  }
}

/** 验收/调试用：清空内存缓存（不动磁盘文件）。 */
export function resetMembershipCache() {
  cache = null
  cacheLoadedAt = 0
  memory.clear()
  failures.clear()
  pendingCodes.clear()
  queue.length = 0
  queueSet.clear()
  reverseCache = { at: 0, index: new Map() }
  hostIndex = 0
  lastFetchAt = 0
}

/* ---------------------------------------------------------------- 反向索引 */

/** 个股 → 板块名 的反向索引（进程内缓存 5 分钟，串一次 ingest 用一次）。 */
export async function reverseIndex() {
  if (Date.now() - reverseCache.at < 5 * 60 * 1000) return reverseCache.index
  const membership = await loadMembership()
  const index = new Map()
  for (const [name, entry] of Object.entries(membership.boards || {})) {
    if (!usable(entry)) continue
    for (const code of entry.members) {
      const list = index.get(code)
      if (list) list.push(name)
      else index.set(code, [name])
    }
  }
  reverseCache = { at: Date.now(), index }
  return index
}
