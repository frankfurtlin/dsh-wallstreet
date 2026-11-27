/**
 * dsh-wallstreet —— 信息资讯集散中心 · LLM 事件摘要
 *
 * 只做一件事：给**重要度够高**的事件写一句话摘要 + 多空倾向 + 影响标的。
 * 为什么限制得这么死：
 *  - 模型调用要花钱，一天几百条资讯全送进去既贵又没必要；
 *  - 摘要的价值在「一眼看懂」，重要度低的条目本来就不该占用注意力；
 *  - 事件去重后条数不多（今天 300 个事件里 ≥70 分的大约个位数）。
 *
 * 成本控制（四道闸）：minImportance 阈值、每轮最多 N 条、同一事件只总结一次、
 * 只取 24 小时内新收进来的；失败不重试得太勤。
 *
 * 模型走宿主自己的 `ctx.llm`（和聊天同一个账号/配额），不引入第三方 key。
 * 拿不到 llm 服务、没有默认模型、返回不是 JSON —— 全部安静降级，面板不显示 AI 行。
 */
import { randomUUID } from 'node:crypto'
import { pendingSummaryEvents, saveEventSummary, summaryCoverage, openStore } from './store.js'
import { describeFinish, generate, resolveLlm, resolveModel } from './llm.js'

/**
 * 默认阈值 62：重要度 v2 收紧之后，70 分以上一天只有个位数，全量摘要等于没摘要；
 * 62 分大约覆盖每天前 5–10%，单条 300 字内输入、80 字输出的成本可以忽略。
 * 用 DSH_WALLSTREET_LLM_MIN 覆盖。
 */
const DEFAULT_MIN_IMPORTANCE = 62
/** 每轮最多总结几条（调度 5 分钟一轮 → 上限约 36 条/小时）。 */
const DEFAULT_MAX_PER_RUN = 3
/** 只总结最近这么久收进来的事件。 */
const WINDOW_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 45_000
/**
 * 输出预算 4096。同类插件在 deepseek-v4.1-flash 上实测：maxTokens=200 → 20 条里只成 7 条、
 * 1024 → 12 条、4096 → 20 条全成。原因是为推理 token 与正文**共享**这个预算，
 * 给小了模型会在推理阶段就烧完，finish 变 max-tokens、正文为空。
 */
const MAX_TOKENS = 4096

/**
 * 失败退避：上游偶发 TRANSPORT/abort 时，如果不记住失败，每轮都从最高分的几条重试，
 * 会把「每轮 3 条」的额度全烧在同一批事件上，低分事件永远轮不到。
 * 失败事件 30 分钟内不再进入候选。
 */
const failedUntil = new Map()

/**
 * 失败原因分布（会话级，重启清零）。面板 / `/hub/stats` 用它解释
 * 「为什么有些高分事件没有 AI 摘要」，而不是让人去翻 journal。
 */
const failureCounts = new Map()
let lastFailureAt = 0

/** 把一次失败按「人话原因」归类；最多保留 3 类给外面看。 */
function recordFailure(eventId, reason) {
  const key = String(reason || '未知原因').slice(0, 40)
  failureCounts.set(key, (failureCounts.get(key) || 0) + 1)
  lastFailureAt = Date.now()
  if (eventId) failedUntil.set(eventId, Date.now() + 30 * 60 * 1000)
}

/** 摘要整体状态：覆盖率 + 失败原因分布。 */
let lastModel = null
let unavailableLoggedFor = ''

function recordUnavailableOnce(reason) {
  if (unavailableLoggedFor === reason) return
  unavailableLoggedFor = reason
  console.log(`[dsh-wallstreet] hub 摘要跳过：${reason}（不再重复提示）`)
}

export function summaryStatus() {
  const coverage = summaryCoverage()
  const failures = [...failureCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
  return { ...coverage, failures, lastFailureAt, model: lastModel || undefined }
}

const SYSTEM_PROMPT = `你是 A 股资讯编辑。给一条资讯事件写摘要，只输出 JSON，不要任何解释或代码块。
格式：{"summary":"不超过 45 字的中文摘要","sentiment":"利好|利空|中性","impact":["最多3个6位股票代码"]}
要求：
1. summary 讲清「发生了什么 + 影响谁」，不要复述标题，不要加「据悉」「值得关注」这类废话；
2. sentiment 只按对相关标的股价的短期倾向判断，判断不了就写「中性」；
3. impact 只写文本里明确出现的股票代码，没有就给空数组。`

/**
 * 纯文本兜底清洗（模型没按 JSON 回的时候用）：
 * 去代码块围栏、去首尾引号/书名号、去 markdown 标题/列表/加粗前缀、压空白。
 * 只接受 8 字以上，太短的多半是「好的」这类废话。
 */
export function cleanSummaryText(text) {
  let value = String(text || '')
  const fenced = value.match(/```(?:json|text)?\s*([\s\S]*?)```/i)
  if (fenced) value = fenced[1]
  value = value
    .replace(/^\s*[#>*-]+\s*/gm, '')
    .replace(/^\s*\d+[.、)]\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[「『“"'《]+/, '')
    .replace(/[」』”"'》]+$/, '')
    .trim()
  // 6 字起才算一句话（「宁德时代扩产」这种 6 字是有效摘要，「好的」不是）。
  if (value.length < 6) return ''
  return value.length > 60 ? `${value.slice(0, 59)}…` : value
}

/** 从可能带 ```json 包裹的文本里抠出 JSON。 */
function parseJsonLoose(text) {
  const raw = String(text || '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

export function buildMessages(event) {
  const sources = (event.sources || [])
    .slice(0, 3)
    .map((entry, index) => `${index + 1}. [${entry.label || entry.source}] ${entry.title}`)
    .join('\n')
  const content = [
    `事件：${event.title}`,
    event.summary ? `摘要：${String(event.summary).slice(0, 200)}` : '',
    event.tickers && event.tickers.length ? `涉及代码：${event.tickers.join(',')}` : '',
    event.sectors && event.sectors.length ? `涉及板块：${event.sectors.join('、')}` : '',
    sources ? `其他报道：\n${sources}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  // DSH 的 RequestMessage.content 是内容块数组，不是字符串；传字符串上游会报
  // `content.some is not a function`。
  return { system: SYSTEM_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text: content }] }] }
}

/**
 * 解析模型输出：先按 JSON 解，失败退回纯文本清洗。
 * @returns {{ summary: string, sentiment: string, degraded: boolean } | null}
 */
export function parseSummaryOutput(text) {
  const parsed = parseJsonLoose(text)
  if (parsed && typeof parsed.summary === 'string' && parsed.summary.trim().length >= 4) {
    const sentiment = ['利好', '利空', '中性'].includes(parsed.sentiment) ? parsed.sentiment : '中性'
    return { summary: parsed.summary.trim().slice(0, 200), sentiment, degraded: false }
  }
  // 解析出了 JSON 但 summary 不合格：直接把整段丢掉，**不要**退回纯文本清洗——
  // 否则会把 `{"summary":"好"}` 原样当成摘要显示在面板上。
  if (parsed) return null
  const cleaned = cleanSummaryText(text)
  if (cleaned) return { summary: cleaned, sentiment: '中性', degraded: true }
  return null
}

/** describeFinish 等 LLM 小工具已搬到 ./llm.js；这里 re-export，旧调用点与测试不用改。 */
export { describeFinish }

/**
 * 跑一轮摘要。并发调用会排队（单飞）。
 * @returns {Promise<{ok:boolean, reason?:string, done:number, pending:number, usage?:object}>}
 */
export async function runSummaries(ctx, {
  minImportance = Number(process.env.DSH_WALLSTREET_LLM_MIN || DEFAULT_MIN_IMPORTANCE),
  maxPerRun = Number(process.env.DSH_WALLSTREET_LLM_MAX || DEFAULT_MAX_PER_RUN),
  windowMs = WINDOW_MS,
  now = Date.now(),
  log = () => {},
} = {}) {
  if (process.env.DSH_WALLSTREET_LLM === '0') return { ok: false, reason: '已通过 DSH_WALLSTREET_LLM=0 关闭', done: 0, pending: 0 }
  const llm = resolveLlm(ctx)
  const model = await resolveModel(ctx)
  if (model && model.unavailable) {
    lastModel = { provider: model.provider, model: model.model, available: false, reason: model.reason }
    recordUnavailableOnce(model.reason)
    return { ok: true, skipped: true, unavailable: true, reason: model.reason, done: 0, pending: 0 }
  }
  if (!llm || !model) return { ok: false, reason: '宿主没有可用的模型（默认模型与 provider 列表都取不到）', done: 0, pending: 0 }
  lastModel = { provider: model.provider, model: model.model, available: true, reason: '' }

  openStore()
  const candidates = pendingSummaryEvents({
    minImportance,
    sinceTs: now - windowMs,
    limit: Math.max(1, Math.min(10, maxPerRun)),
  }).filter((event) => {
    const until = failedUntil.get(event.id) || 0
    if (until > now) return false
    if (until > 0) failedUntil.delete(event.id)
    return true
  })
  if (candidates.length === 0) return { ok: true, done: 0, pending: 0, reason: '没有待总结的高分事件' }

  let done = 0
  let tokens = 0
  for (const event of candidates) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const prompt = buildMessages(event)
      const options = {
        provider: model.provider,
        model: model.model,
        system: prompt.system,
        messages: prompt.messages,
        // opencode-go 之类 provider 要求会话标识，缺了会拿不到内容。
        sessionId: `wallstreet-hub-${randomUUID()}`,
        maxTokens: MAX_TOKENS,
        temperature: 0.2,
        reasoningEffort: 'low',
      }
      // 2026-11-26：上游并发时偶发 0.5s 级的 TRANSPORT 瞬断，立即重试一次即可成功；
      // 不要把它算进 30 分钟的失败退避窗口。
      let attempt = await generate(llm, options, controller.signal)
      let parsed = parseSummaryOutput(attempt.text)
      if (!parsed) {
        attempt = await generate(llm, options, controller.signal)
        parsed = parseSummaryOutput(attempt.text)
      }
      const { text, usage, finish, kinds, reasoning } = attempt
      if (!parsed) {
        const reason = describeFinish(finish, text) || '空输出'
        recordFailure(event.id, reason)
        log(
          `摘要失败（${reason}）：text=${String(text).length} reasoning=${String(reasoning).length} finish=${JSON.stringify(finish || null)} chunks=${kinds.join(',')}`,
        )
        continue
      }
      saveEventSummary(event.id, {
        summary: parsed.summary,
        sentiment: parsed.sentiment,
        model: `${model.provider}/${model.model}`,
        at: Date.now(),
      })
      done += 1
      // 走了纯文本兜底也要留痕：说明模型这次没按 JSON 回。
      if (parsed.degraded) log(`摘要走了纯文本兜底：${parsed.summary.slice(0, 40)}`)
      if (usage && Number.isFinite(usage.inputTokens)) tokens += usage.inputTokens + (usage.outputTokens || 0)
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      recordFailure(event.id, /abort/i.test(message) ? '请求超时' : '调用失败')
      log(`摘要失败：${message}`)
    } finally {
      clearTimeout(timer)
    }
  }
  const status = summaryStatus()
  return {
    ok: true,
    done,
    pending: Math.max(0, candidates.length - done),
    tokens,
    model: `${model.provider}/${model.model}`,
    coverage: { total: status.total, summarized: status.summarized },
    failures: status.failures,
  }
}

/** 验收脚本用：给指定事件强制生成一次摘要（不走「待总结」筛选）。 */
export async function summarizeEventNow(ctx, event, log = () => {}) {
  const llm = resolveLlm(ctx)
  const model = await resolveModel(ctx)
  if (!llm || !model) throw new Error('宿主没有可用的模型（默认模型与 provider 列表都取不到）')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const prompt = buildMessages(event)
    const { text } = await generate(
      llm,
      {
        provider: model.provider,
        model: model.model,
        system: prompt.system,
        messages: prompt.messages,
        sessionId: `wallstreet-hub-${randomUUID()}`,
        maxTokens: MAX_TOKENS,
        temperature: 0.2,
        reasoningEffort: 'low',
      },
      controller.signal,
    )
    const parsed = parseJsonLoose(text) || {}
    return {
      summary: String(parsed.summary || '').trim(),
      sentiment: ['利好', '利空', '中性'].includes(parsed.sentiment) ? parsed.sentiment : '中性',
      impact: Array.isArray(parsed.impact) ? parsed.impact.slice(0, 3) : [],
      model: `${model.provider}/${model.model}`,
      raw: text.slice(0, 300),
    }
  } finally {
    clearTimeout(timer)
  }
}
