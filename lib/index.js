/**
 * dsh-wallstreet —— host 半：把「华尔街之狼」的市场数据 API 挂到 DSH Web 的
 * `/wallstreet` 前缀下，并复用 DSH 自己的登录闸门。
 *
 * 设计要点：
 *  - 不做反向代理：数据由宿主进程直接抓取东财公开 JSON，经缓存与降级后以
 *    同源 JSON API 提供给浏览器面板；上游凭据/头只存在于宿主，不出浏览器。
 *  - 每个请求先过 `ctx.connection.requestRejection()`：403（Host/Origin 不在
 *    信任围栏内）/ 401（未登录）/ undefined（放行）。面板因此天然沿用 DSH 的
 *    token/cookie 会话，不另做一套认证。
 *  - 只注册 `/wallstreet/api/*`，其它路径一律 404 JSON，不对外暴露任何文件。
 */
import { getHealth, getHistory, getMoves, getNews, getOverview, getStock, getTrend, INDICES } from './market.js'
import {
  getHoldingsConcentration,
  getQuantOverview,
  getQuantResearch,
} from './quant.js'
import { searchResources } from './search.js'
import { ASK_TIMEOUT_MS, askMarket, normalizeAskInput } from './ask.js'
import {
  PROFILES,
  allocationTable,
  getProfile,
  gridPlan,
  stopLossAction,
} from './strategy.js'
import { hubRoute, createHubTools, startHub } from './hub/index.js'

const ROUTE_PATH = '/wallstreet'
const API_PREFIX = '/wallstreet/api'

/** 统一的 JSON 响应：行情数据不缓存到浏览器（宿主层已有 TTL 缓存）。 */
function sendJson(res, status, body) {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** 鉴权闸门：没登录 / 主机不可信就直接挡掉，绝不把数据暴露给会话之外。 */
function rejectUnprivileged(ctx, req, res) {
  let rejection
  try {
    const connection = ctx.get('connection', false)
    rejection =
      connection && typeof connection.requestRejection === 'function'
        ? connection.requestRejection(req)
        : 401
  } catch {
    rejection = 401
  }
  if (!rejection) return false
  const message =
    rejection === 403
      ? 'dsh web: 该请求的主机/来源不在信任列表内。\n'
      : 'dsh web authentication required; reopen the URL printed by dsh web.\n'
  if (res.headersSent) {
    res.end()
    return true
  }
  res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
  return true
}

function splitUrl(url) {
  const raw = String(url || '')
  const index = raw.indexOf('?')
  if (index === -1) return { pathname: raw, query: new URLSearchParams() }
  return { pathname: raw.slice(0, index), query: new URLSearchParams(raw.slice(index + 1)) }
}

/**
 * 问答路由的请求体上限：一轮问题 + 最多 8 条历史，64KB 足够；超限直接拒绝，
 * 不做上传通道。
 */
async function readJsonBody(req, limit = 64 * 1024) {
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

/** 问答限流：全局每分钟 12 次。单用户面板足够，防止误触/脚本把模型额度刷爆。 */
const ASK_RATE_LIMIT = 12
const askHits = []
function allowAsk() {
  const now = Date.now()
  while (askHits.length > 0 && now - askHits[0] > 60_000) askHits.shift()
  if (askHits.length >= ASK_RATE_LIMIT) return false
  askHits.push(now)
  return true
}

/**
 * 盘面 AI 问答：POST /wallstreet/api/ask，SSE 流式返回。
 * 事件：delta（逐段文本）、done（完整回答 + 模型 + 数据时间）、error（人话原因）、ping（心跳）。
 * 参数错误 / 限流在开流之前用普通 JSON 返回，前端好区分。
 */
async function handleAsk(ctx, req, res) {
  const body = await readJsonBody(req)
  const input = normalizeAskInput(body)
  if (!input) {
    sendJson(res, 400, { ok: false, error: '问题不能为空，且不超过 500 字' })
    return
  }
  if (!allowAsk()) {
    sendJson(res, 429, { ok: false, error: `问答太频繁，请稍后再试（每分钟 ${ASK_RATE_LIMIT} 次）` })
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders?.()
  const send = (payload) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  // 模型推理阶段可能几十秒没有正文，15s 一次心跳防止中间代理提前断开。
  const heartbeat = setInterval(() => send({ type: 'ping' }), 15_000)
  const controller = new AbortController()
  let finished = false
  /**
   * 只结束一次：watchdog / askMarket / 客户端断开可能同时发生。
   * 底层 provider 偶尔不尊重 abort signal，光靠 askMarket 的超时可能永远不返回，
   * 所以这里再加一道看门狗，保证前端一定收到终帧。
   */
  const finish = (payload) => {
    if (finished) return
    finished = true
    clearInterval(heartbeat)
    clearTimeout(watchdog)
    if (payload) send(payload)
    if (!res.writableEnded) res.end()
  }
  const watchdog = setTimeout(
    () => finish({ type: 'error', message: `模型响应超时（>${Math.round((ASK_TIMEOUT_MS + 5_000) / 1000)} 秒），请重试` }),
    ASK_TIMEOUT_MS + 5_000,
  )
  res.on('close', () => {
    clearInterval(heartbeat)
    clearTimeout(watchdog)
    if (!res.writableEnded) controller.abort()
  })
  try {
    const result = await askMarket(ctx, {
      question: input.question,
      history: input.history,
      signal: controller.signal,
      onDelta: (text) => send({ type: 'delta', text }),
    })
    finish({ type: 'done', answer: result.answer, model: result.model, dataAt: result.dataAt, usage: result.usage })
  } catch (error) {
    finish({ type: 'error', message: error && error.message ? error.message : '问答失败' })
  }
}

function createHandler(ctx) {
  return function wallstreetHandler(req, res) {
    if (rejectUnprivileged(ctx, req, res)) return

    const { pathname, query } = splitUrl(req.url)
    if (pathname !== ROUTE_PATH && !pathname.startsWith(`${API_PREFIX}/`) && pathname !== API_PREFIX) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    // 盘面 AI 问答走 SSE，自己有 body 解析；必须在 405 / resume 之前拦掉。
    if (pathname === `${API_PREFIX}/ask`) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      handleAsk(ctx, req, res).catch((error) => {
        const reason = error && error.message ? error.message : '未知错误'
        console.warn(`[dsh-wallstreet] 问答失败: ${reason}`)
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: `问答暂不可用：${reason}` })
        else res.end()
      })
      return
    }
    // 允许 POST 的三个路由：/hub/sync（立即抓一轮）、/hub/summarize（跑一轮 AI 摘要）、
    // /hub/config（保存源开关与抓取间隔）；其余一律只读 GET。
    const isHubWrite =
      pathname === `${API_PREFIX}/hub/sync` ||
      pathname === `${API_PREFIX}/hub/summarize` ||
      pathname === `${API_PREFIX}/hub/config` ||
      pathname === `${API_PREFIX}/hub/model` ||
      pathname === `${API_PREFIX}/hub/digest`
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isHubWrite) {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    // sync / summarize 不需要请求体，直接排空；config 要读 body，所以不能先 resume。
    if (req.method === 'POST' && !pathname.endsWith('/hub/config') && !pathname.endsWith('/hub/model') && !pathname.endsWith('/hub/digest')) req.resume()

    const route = async () => {
      const hubBody = await hubRoute({ pathname, query, method: req.method, req })
      if (hubBody !== undefined) return hubBody
      if (pathname === `${API_PREFIX}/overview`) {
        return getOverview({ withTrend: query.get('trend') !== '0' })
      }
      if (pathname === `${API_PREFIX}/moves`) {
        return getMoves()
      }
      if (pathname === `${API_PREFIX}/history`) {
        return getHistory(query.get('days') || 40)
      }
      if (pathname === `${API_PREFIX}/news`) {
        return getNews(query.get('limit') || 40)
      }
      if (pathname === `${API_PREFIX}/stock`) {
        const code = query.get('code') || query.get('secid') || ''
        return getStock(code)
      }
      if (pathname === `${API_PREFIX}/trend`) {
        const secid = query.get('secid') || '1.000001'
        return getTrend(secid)
      }
      if (pathname === `${API_PREFIX}/indices`) {
        return { ok: true, indices: INDICES.map(({ secid, code, name, group }) => ({ secid, code, name, group })) }
      }
      if (pathname === `${API_PREFIX}/health`) {
        return getHealth()
      }
      if (pathname === `${API_PREFIX}/quant/overview`) {
        return getQuantOverview()
      }
      if (pathname === `${API_PREFIX}/quant/research`) {
        return getQuantResearch()
      }
      if (pathname === `${API_PREFIX}/quant/holdings`) {
        return getHoldingsConcentration()
      }
      if (pathname === `${API_PREFIX}/research/search`) {
        const q = query.get('q') || query.get('query') || ''
        if (!q.trim()) return { ok: false, error: '检索问句不能为空' }
        const engine = query.get('engine') || 'mx'
        const limit = query.get('limit') || 8
        const answer = query.get('answer') === '1' || query.get('answer') === 'true'
        return searchResources(q, { engine, limit, answer })
      }
      if (pathname === `${API_PREFIX}/strategy/profiles`) {
        return {
          ok: true,
          profiles: Object.values(PROFILES).map(({ id, label, capital, buckets, rules }) => ({
            id,
            label,
            capital,
            buckets,
            rules,
          })),
          gridDefaults: { spread: 0.1, count: 10 },
        }
      }
      if (pathname === `${API_PREFIX}/strategy/overview`) {
        const profileId = query.get('profile') || '10w'
        const table = allocationTable(profileId)
        const profile = getProfile(profileId)
        /** 把止损/熔断阈值折成面板可直接展示的行。 */
        const stopLoss = Object.entries(profile.rules.stopLoss).map(([kind, rule]) => ({
          kind,
          review: rule.review,
          cut: rule.cut,
        }))
        const samples = [
          { kind: 'stock', pnl: profile.rules.stopLoss.stock.cut ?? profile.rules.stopLoss.stock.review ?? -0.2 },
          { kind: 'sectorETF', pnl: profile.rules.stopLoss.sectorETF.review ?? -0.15 },
          { kind: 'broadETF', pnl: -0.3 },
          { kind: 'convertible', pnl: profile.rules.stopLoss.convertible.review ?? -0.08 },
        ].map((sample) => ({ ...sample, ...stopLossAction({ profileId, ...sample }) }))
        return {
          ok: true,
          ...table,
          rules: profile.rules,
          stopLoss,
          stopLossSamples: samples,
        }
      }
      if (pathname === `${API_PREFIX}/strategy/grid`) {
        const num = (key) => {
          const value = Number(query.get(key))
          return Number.isFinite(value) && value > 0 ? value : undefined
        }
        return {
          ok: true,
          ...gridPlan({
            low: num('low'),
            high: num('high'),
            last: num('last'),
            count: num('count'),
            capital: num('capital'),
          }),
        }
      }
      return null
    }

    route()
      .then((body) => {
        if (body == null) {
          sendJson(res, 404, { ok: false, error: 'unknown api' })
          return
        }
        sendJson(res, 200, body)
      })
      .catch((error) => {
        const reason = error && error.message ? error.message : '未知错误'
        console.warn(`[dsh-wallstreet] API 失败: ${req.method} ${req.url} — ${reason}`)
        const quantRoute = pathname.startsWith(`${API_PREFIX}/quant/`)
        const strategyRoute = pathname.startsWith(`${API_PREFIX}/strategy/`)
        const researchRoute = pathname === `${API_PREFIX}/research/search`
        const hubRouteFailed = pathname.startsWith(`${API_PREFIX}/hub/`)
        const stockRoute =
          pathname === `${API_PREFIX}/stock` || pathname === `${API_PREFIX}/news`
        sendJson(res, 500, {
          ok: false,
          error: quantRoute
            ? `quant 数据暂时不可用：${reason}`
            : researchRoute
              ? `资料检索暂不可用：${reason}`
              : strategyRoute
                ? `策略口径计算失败：${reason}`
                : hubRouteFailed
                  ? `资讯中心暂不可用：${reason}`
                  : stockRoute
                    ? reason
                    : '行情数据暂时不可用，请稍后重试。',
        })
      })
  }
}

export const name = 'dsh-wallstreet'
export const inject = ['webServer', 'tools']

export function apply(ctx) {
  const handler = createHandler(ctx)
  // 2026-11-12：兜底包装。任何同步异常都不许冒泡到 DSH 的加载/请求链路，
  // 只让本面板 500，不影响宿主。异步分支里的 route() 已有 .catch。
  const safeHandler = (req, res) => {
    try {
      handler(req, res)
    } catch (error) {
      const reason = error && error.message ? error.message : String(error)
      console.warn(`[dsh-wallstreet] handler 同步异常: ${reason}`)
      try {
        sendJson(res, 500, { ok: false, error: '面板暂时不可用，请稍后重试。' })
      } catch {
        /* res 已结束则忽略 */
      }
    }
  }
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: safeHandler,
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-wallstreet: /wallstreet market api')

  // 资讯中心：调度器与工具都各自挂 effect，卸载时精确回收，互不影响。
  // 抓取失败只在日志里留痕，绝不让宿主加载失败（startHub 内部已兜住打开库的异常）。
  ctx.effect(() => startHub({ ctx, log: console.log }), 'dsh-wallstreet: info hub scheduler')

  ctx.effect(() => {
    const disposers = createHubTools().map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose()
      }
    }
  }, 'dsh-wallstreet: wallstreet_news tool')
}
