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

function createHandler(ctx) {
  return function wallstreetHandler(req, res) {
    if (rejectUnprivileged(ctx, req, res)) return

    const { pathname, query } = splitUrl(req.url)
    if (pathname !== ROUTE_PATH && !pathname.startsWith(`${API_PREFIX}/`) && pathname !== API_PREFIX) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    const route = async () => {
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
        const stockRoute =
          pathname === `${API_PREFIX}/stock` || pathname === `${API_PREFIX}/news`
        sendJson(res, 500, {
          ok: false,
          error: quantRoute
            ? `quant 数据暂时不可用：${reason}`
            : stockRoute
              ? reason
              : '行情数据暂时不可用，请稍后重试。',
        })
      })
  }
}

export const name = 'dsh-wallstreet'
export const inject = ['webServer']

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
}
