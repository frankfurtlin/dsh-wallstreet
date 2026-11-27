/**
 * dsh-wallstreet —— 宿主 LLM 小工具（从 summarize.js 抽出来共用）。
 *
 * 资讯摘要（hub/summarize.js）和盘面问答（lib/ask.js）都要做三件事：
 *   1. 从宿主拿 `llm` 服务（与聊天同账号/配额，不引入第三方 key）；
 *   2. 决定用哪个 provider/model（用户显式选择 > 宿主默认 > 列表兜底）；
 *   3. 把流式输出收成一段文本，并留下结束原因。
 *
 * 单独放一个文件是为了让「用哪个模型」只有一处决策：摘要和问答不会各自漂移。
 */
import { loadLlmSelection } from './config.js'

/** 取宿主 LLM 服务；拿不到就返回 undefined，调用方安静降级。 */
export function resolveLlm(ctx) {
  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('llm', false) : ctx && ctx.llm
    if (service && typeof service.stream === 'function') return service
  } catch {
    /* 没有 llm 服务 */
  }
  return undefined
}

/**
 * 取模型路由：三级兜底（参照 rss-digest 的 dsh-llm.ts）。
 *   1. `agentDefaultModel` 的当前选择（用户显式选过就只认它）；
 *   2. 读不到就 `llm.listProviders()` 挑一个（优先 deepseek/official）；
 *   3. 再 `llm.listModels(provider)` 挑一个（优先 chat/flash/deepseek/v3/r1/pro）。
 *
 * 只读 `agentDefaultModel` 的问题是：宿主没有配置默认模型时，功能会静默失效，
 * 而那些 provider 其实可用。解析放在**每次调用时**做，不去缓存——HMR 或晚注册
 * 的适配器才能被尊重。
 */
export async function resolveModel(ctx) {
  // 用户显式选过就只认它：不在 DSH 模型列表里 → unavailable，不降级、不换模型。
  try {
    const saved = await loadLlmSelection()
    if (saved) {
      const llm = resolveLlm(ctx)
      let known = true
      try {
        const providers = llm && typeof llm.listProviders === 'function' ? (await llm.listProviders()) || [] : []
        const providerIds = providers.map((entry) => (typeof entry === 'string' ? entry : entry && entry.id)).filter(Boolean)
        if (providerIds.length > 0) {
          if (!providerIds.includes(saved.provider)) known = false
          else if (typeof llm.listModels === 'function') {
            const models = (await llm.listModels(saved.provider)) || []
            const ids = models.map((entry) => (typeof entry === 'string' ? entry : entry && (entry.id || entry.model))).filter(Boolean)
            if (ids.length > 0 && !ids.includes(saved.model)) known = false
          }
        }
      } catch {
        known = true // 列表拿不到就放行，交给上游判定
      }
      if (!known) {
        return { unavailable: true, reason: `模型不可用：${saved.provider}/${saved.model}`, provider: saved.provider, model: saved.model }
      }
      return { provider: saved.provider, model: saved.model, source: 'saved' }
    }
  } catch {
    /* 配置读不出来就继续走默认选择 */
  }
  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel', false) : ctx && ctx.agentDefaultModel
    const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : undefined
    if (selection && typeof selection.provider === 'string' && selection.provider && typeof selection.model === 'string' && selection.model) {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* 继续走兜底 */
  }
  const llm = resolveLlm(ctx)
  if (!llm || typeof llm.listProviders !== 'function') return undefined
  try {
    const providers = await llm.listProviders()
    const list = Array.isArray(providers)
      ? providers.map((entry) => (typeof entry === 'string' ? { id: entry } : entry)).filter((entry) => entry && entry.id)
      : []
    const provider = list.find((entry) => /deepseek|official/i.test(String(entry.id))) || list[0]
    if (!provider) return undefined
    let models = []
    if (typeof llm.listModels === 'function') {
      const listed = await llm.listModels(provider.id).catch(() => [])
      models = Array.isArray(listed)
        ? listed.map((entry) => (typeof entry === 'string' ? { id: entry } : entry)).filter((entry) => entry && entry.id)
        : []
    }
    if (models.length === 0) return undefined
    const model = models.find((entry) => /chat|flash|deepseek|v3|r1|pro/i.test(String(entry.id))) || models[0]
    return { provider: String(provider.id), model: String(model.id) }
  } catch {
    return undefined
  }
}

/**
 * 调一次模型，返回文本 + 用量 + 结束原因。
 * 结束原因要留出来：拿不到文本时，是「被截断」还是「上游报错」直接决定怎么修。
 */
export async function generate(llm, options, signal) {
  let text = ''
  let reasoning = ''
  let usage
  let finish
  const kinds = []
  for await (const chunk of llm.stream({ ...options, signal })) {
    if (!chunk || typeof chunk !== 'object') continue
    if (kinds.length < 6) kinds.push(chunk.type)
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  return { text, reasoning, usage, finish, kinds }
}

/** 把 finish 原因翻成一句人话（失败分布 / 问答错误提示里显示的就是它）。 */
export function describeFinish(finish, text) {
  const kind = finish && finish.kind ? finish.kind : ''
  if (kind === 'max-tokens') return '终止原因 max-tokens（推理把预算烧完了）'
  if (kind === 'aborted') return '请求被中止（超时或宿主关闭）'
  if (kind === 'error') {
    const code = finish && finish.failure && finish.failure.code ? finish.failure.code : ''
    return code ? `上游报错 ${code}` : '上游报错'
  }
  if (kind === 'tool-calls') return '模型回了工具调用而不是文本'
  if (!String(text || '').trim()) return '空输出'
  return ''
}
