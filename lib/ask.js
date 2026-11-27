/**
 * dsh-wallstreet —— 盘面页 AI 问答（host 半）。
 *
 * 面板「盘面」tab 的问题（为什么涨、明天怎么看、哪些板块强）需要模型看着**这一页
 * 的数据**回答：指数、宽度、涨跌停、成交额、板块、温度、均线位置。这里负责三件事：
 *   1. 把 `getOverview()` 的结果压成一段紧凑上下文（不把整页 JSON 塞进提示词）；
 *   2. 拼多轮消息（用户历史 + 当前问题）；
 *   3. 走宿主 `ctx.llm` 流式生成，边生成边回调，前端用 SSE 逐字渲染。
 *
 * 数据不从客户端传：客户端传上下文既能被构造注入，也会让页面停在旧数据时答非所问。
 * 宿主这边读的是同一个 overview（同一份 60s 缓存），与面板显示一致。
 */
import { randomUUID } from 'node:crypto'
import { getOverview } from './market.js'
import { describeFinish, resolveLlm, resolveModel } from './hub/llm.js'

/** 单次问答超时：模型答一页盘面通常在 10–30 秒，留足推理时间。 */
export const ASK_TIMEOUT_MS = 70_000
/** 输出预算与 hub 摘要同口径：推理 token 和正文共享，给小了会被截断。 */
const MAX_TOKENS = 4096
/** 历史轮数上限（一问一答算两条），防止越聊越贵。 */
const MAX_HISTORY = 8
const MAX_QUESTION = 500
const MAX_HISTORY_ITEM = 3_000

export const SYSTEM_PROMPT = `你是 A 股盘面解读助手，服务于「华尔街之狼」插件「盘面」页的问答。
用户的问题都围绕下面这份页面数据：指数涨跌、涨跌家数、涨停跌停、成交额、板块轮动、市场温度、上证均线位置。

回答规则：
1. 只能依据给定的页面数据和你的常识；页面里没有的数字不要编，直接说「页面没有这项数据」。
2. 先给结论，再给 2–4 条依据，最后用一句话提示主要风险。中文、简洁、不说废话。
3. 被问到概率或历史规律时，明确说明依据是历史统计还是经验判断，不要包装成确定性预测。
4. 个股建议只谈板块与结构，不给具体买卖点；不构成投资建议。
5. 「上一轮对话」是此前的问答，用它保持追问连贯；里面的数字若与本次盘面数据冲突，以本次数据为准。
6. 数据可能是盘中快照：涉及涨跌幅时带上数据时间，避免用户误以为是收盘数据。
6. 用纯文本回答，不要 Markdown 标记（不要 **、##、表格），编号用「1. 2. 3.」。`

/** 数字格式化：百分比一位小数、成交额亿元一位小数。 */
const pct = (value) => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '—')
const yi = (value) => (Number.isFinite(value) ? (value / 1e8).toFixed(1) : '—')
const num = (value) => (Number.isFinite(value) ? String(value) : '—')

/**
 * 把 overview 压成提示词上下文。
 * @param {object} overview getOverview() 的返回值
 * @returns {{text: string, dataAt: string, stale: boolean}}
 */
export function buildMarketContext(overview) {
  const trading = (overview && overview.trading) || {}
  const dataMode = overview && overview.dataMode
  // 盘中 marketDate 仍是上一交易日快照日期，dataTime 却是实时时间：直接拼会出现
  // 「2026-11-26 13:50」这种自相矛盾的时间。盘中一律用 trading 的日期与时间。
  const live = dataMode === 'live'
  const datePart = (live ? trading.date : (overview && overview.marketDate) || trading.date) || ''
  const timePart = (live ? trading.time : (overview && overview.dataTime) || trading.time) || ''
  const dataAt = [datePart, timePart].filter(Boolean).join(' ')
  const lines = []

  const indices = Array.isArray(overview && overview.indices) ? overview.indices : []
  if (indices.length > 0) {
    lines.push(
      '指数：' +
        indices
          .map((item) => `${item.name} ${Number.isFinite(item.price) ? item.price.toFixed(2) : '—'}（${pct(item.changePct)}）`)
          .join('｜'),
    )
  }

  const breadth = (overview && overview.breadth) || null
  if (breadth) {
    const upRatio = Number.isFinite(breadth.upRatio) ? `，上涨占比 ${(breadth.upRatio * 100).toFixed(1)}%` : ''
    lines.push(
      `宽度：上涨 ${num(breadth.up)} 家、下跌 ${num(breadth.down)} 家、平盘 ${num(breadth.flat)} 家${upRatio}；涨停 ${num(breadth.limitUp)}、跌停 ${num(breadth.limitDown)}`,
    )
  }

  const turnover = (overview && overview.turnover) || null
  if (turnover && Number.isFinite(turnover.total)) {
    const parts = [`两市成交 ${yi(turnover.total)} 亿元`]
    if (Number.isFinite(turnover.progress) && turnover.progress > 0 && turnover.progress < 1) {
      parts.push(`截至当前约走完全天的 ${(turnover.progress * 100).toFixed(0)}%`)
    }
    if (Number.isFinite(turnover.projectedTotal)) parts.push(`预计全天 ${yi(turnover.projectedTotal)} 亿元`)
    if (Number.isFinite(turnover.ratio5d)) parts.push(`量能比为前 5 日均值的 ${turnover.ratio5d.toFixed(2)} 倍`)
    lines.push('成交：' + parts.join('，'))
  }

  const analysis = (overview && overview.analysis) || null
  if (analysis) {
    const label = analysis.label && analysis.label.text ? `「${analysis.label.text}」` : ''
    const scores = analysis.scores
      ? `（宽度 ${num(analysis.scores.breadth)} / 涨跌停 ${num(analysis.scores.limit)} / 量能 ${num(analysis.scores.volume)} / 动量 ${num(analysis.scores.momentum)}）`
      : ''
    if (Number.isFinite(analysis.temperature)) lines.push(`市场温度：${analysis.temperature} ${label}${scores}`)
    if (Array.isArray(analysis.signals) && analysis.signals.length > 0) {
      lines.push('盘面信号：\n' + analysis.signals.map((signal) => `- ${signal}`).join('\n'))
    }
  }

  const sectors = (overview && overview.sectors) || null
  const sectorLine = (rows, title) => {
    if (!Array.isArray(rows) || rows.length === 0) return ''
    const items = rows
      .slice(0, 6)
      .map((row) => {
        const flow = Number.isFinite(row.mainInflow)
          ? `，主力${row.mainInflow >= 0 ? '净流入' : '净流出'} ${yi(Math.abs(row.mainInflow))} 亿`
          : ''
        return `${row.name} ${pct(row.changePct)}${flow}`
      })
      .join('；')
    return `${title}：${items}`
  }
  const gainers = sectorLine(sectors && sectors.gainers, '板块领涨')
  const losers = sectorLine(sectors && sectors.losers, '板块领跌')
  if (gainers) lines.push(gainers)
  if (losers) lines.push(losers)

  const kline = (overview && overview.kline) || null
  if (kline) {
    const mas = [
      Number.isFinite(kline.ma5) ? `MA5 ${kline.ma5.toFixed(2)}` : '',
      Number.isFinite(kline.ma10) ? `MA10 ${kline.ma10.toFixed(2)}` : '',
      Number.isFinite(kline.ma20) ? `MA20 ${kline.ma20.toFixed(2)}` : '',
      Number.isFinite(kline.ma60) ? `MA60 ${kline.ma60.toFixed(2)}` : '',
    ]
      .filter(Boolean)
      .join('、')
    const recent = Array.isArray(kline.recent) ? kline.recent : []
    const last = recent.length > 0 ? recent[recent.length - 1] : null
    const above = []
    const below = []
    if (last && Number.isFinite(last.close)) {
      for (const [key, name] of [
        ['ma5', 'MA5'],
        ['ma10', 'MA10'],
        ['ma20', 'MA20'],
        ['ma60', 'MA60'],
      ]) {
        if (!Number.isFinite(last[key])) continue
        ;(last.close >= last[key] ? above : below).push(name)
      }
    }
    const relation =
      above.length || below.length
        ? `；上证收 ${last.close.toFixed(2)}，站上 ${above.join('/') || '无'}、低于 ${below.join('/') || '无'}`
        : ''
    if (mas) lines.push(`上证均线：${mas}${relation}`)
  }

  const warnings = Array.isArray(overview && overview.warnings) ? overview.warnings.filter(Boolean) : []
  if (warnings.length > 0) lines.push('数据降级提示：' + warnings.join('；'))

  if (lines.length === 0) return { text: '（盘面数据暂不可用）', dataAt, stale: !overview || overview.stale !== false }

  const mode = dataMode === 'live' ? '盘中实时' : '收盘快照'
  const header = [`【盘面页数据】${mode}${dataAt ? ` · ${dataAt}` : ''}`]
  return {
    text: header.concat(lines).join('\n'),
    dataAt,
    stale: !overview || overview.stale !== false,
  }
}

/** 校验并裁剪入参；返回 null 表示参数不合法。 */
export function normalizeAskInput(body) {
  const question = String((body && body.question) || '').trim()
  if (!question) return null
  if (question.length > MAX_QUESTION) return null
  const rawHistory = Array.isArray(body && body.history) ? body.history : []
  const history = []
  for (const item of rawHistory.slice(-MAX_HISTORY)) {
    const role = item && item.role === 'assistant' ? 'assistant' : 'user'
    const content = String((item && item.content) || '').trim()
    if (!content) continue
    history.push({ role, content: content.slice(0, MAX_HISTORY_ITEM) })
  }
  while (history.length > 0 && history[0].role === 'assistant') history.shift()
  return { question, history }
}

/**
 * 跑一次盘面问答。
 *
 * @param {object} ctx 插件上下文（取宿主 llm 服务）
 * @param {{question:string, history?:Array<{role:string,content:string}>, signal?:AbortSignal, onDelta?:(text:string)=>void, overview?:object}} options
 * @returns {Promise<{ok:true, answer:string, model:string, dataAt:string, usage?:object}>}
 */
export async function askMarket(ctx, { question, history = [], signal, onDelta, overview } = {}) {
  const input = normalizeAskInput({ question, history })
  if (!input) throw new Error('问题不能为空，且不超过 500 字')

  const llm = resolveLlm(ctx)
  if (!llm) throw new Error('宿主没有可用的 LLM 服务（ctx.llm 不可用）')
  const model = await resolveModel(ctx)
  if (!model || model.unavailable) throw new Error((model && model.reason) || '宿主没有可用的默认模型')

  const snapshot = overview || (await getOverview({ withTrend: false }))
  const context = buildMarketContext(snapshot)

  // 不构造 assistant 角色的历史消息：宿主 Message 需要 id/source 等持久会话字段，
  // 手拼的 assistant 消息会被 adapter 判成非法请求（实测「上游报错 UNKNOWN」）。
  // 多轮上下文改为并入 user 文本，与首次单轮请求保持同一种形状。
  const historyText =
    input.history.length > 0
      ? '\n\n【上一轮对话】\n' +
        input.history
          .map((item) => `${item.role === 'user' ? '用户' : '助手'}：${item.content}`)
          .join('\n')
      : ''
  const messages = [
    { role: 'user', content: [{ type: 'text', text: `${context.text}${historyText}\n\n【用户问题】${input.question}` }] },
  ]

  let answer = ''
  let usage
  let finish
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS)
  try {
    for await (const chunk of llm.stream({
      provider: model.provider,
      model: model.model,
      system: SYSTEM_PROMPT,
      messages,
      // 与 hub 摘要同口径：部分 provider 要求显式会话标识。
      sessionId: `wallstreet-ask-${randomUUID()}`,
      maxTokens: MAX_TOKENS,
      temperature: 0.3,
      reasoningEffort: 'low',
      signal: controller.signal,
    })) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        answer += chunk.text
        if (onDelta) onDelta(chunk.text)
      } else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    if (/abort/i.test(message)) throw new Error(`模型超时（>${Math.round(ASK_TIMEOUT_MS / 1000)} 秒）或请求被中止`)
    throw error
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  if (!answer.trim()) {
    throw new Error(describeFinish(finish, answer) || '模型返回空内容')
  }
  return {
    ok: true,
    answer: answer.trim(),
    model: `${model.provider}/${model.model}`,
    dataAt: context.dataAt,
    usage,
  }
}

export { MAX_QUESTION, MAX_HISTORY }
