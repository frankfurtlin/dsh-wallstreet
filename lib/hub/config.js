/**
 * dsh-wallstreet —— 信息资讯集散中心 · 源配置
 *
 * 为什么要有这一层：13 个适配器原先全写死在 `sources.js` 里——想关掉一条噪音大的源、
 * 或者把某个慢站从 2 分钟改成 10 分钟，都得改代码重载插件。这里把「哪条源开、多久抓一次」
 * 抽成可在面板里改的配置，落 `data/hub-settings.json`，`sources.js` 只提供默认值。
 *
 * 设计约束：
 *  - **单一事实来源**：有效值 = 适配器默认值 + 配置文件覆盖，不在内存里另存一份；
 *  - 校验写在这里（不是面板）：间隔夹在 30s–6h，未知 source id 直接报错，不做静默丢弃；
 *  - 文件损坏/缺失一律回退默认值，且**不覆盖**坏文件（留证据给用户看）；
 *  - 路径可用 `DSH_WALLSTREET_SETTINGS_FILE` 覆盖（验收脚本指到临时文件）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const DATA_DIR = process.env.DSH_WALLSTREET_DATA || join(PLUGIN_ROOT, 'data')

/** 抓取间隔的允许区间：30 秒（别把上游打爆）到 6 小时（别让数据太旧）。 */
export const MIN_INTERVAL_MS = 30_000
export const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000

function settingsPath() {
  return process.env.DSH_WALLSTREET_SETTINGS_FILE || join(DATA_DIR, 'hub-settings.json')
}

/** 空配置：全部走适配器默认值。 */
function emptyConfig() {
  return { version: 1, sources: {}, updatedAt: 0 }
}

/** 读配置。文件不存在/损坏都返回空配置，并把错误挂在 `_error` 上（只用于展示）。 */
export async function loadConfig() {
  try {
    const text = await readFile(settingsPath(), 'utf8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sources !== 'object' || parsed.sources === null) {
      return { ...emptyConfig(), _error: '配置文件格式不对（缺少 sources 对象）' }
    }
    return { ...emptyConfig(), ...parsed, sources: parsed.sources }
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyConfig()
    return { ...emptyConfig(), _error: `配置文件读不出来：${error && error.message ? error.message : error}` }
  }
}

/** 把任意值折成合法间隔；非法值返回 null（表示「不覆盖」）。 */
export function normalizeInterval(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(number)))
}

/**
 * 校验并保存一批改动。整批失败就不写盘（不做「一半成功一半失败」）。
 *
 * @param {Array<{id:string, enabled?:boolean, intervalMs?:number}>} updates
 * @param {Array<{id:string}>} knownSources 适配器清单（用于拒绝未知 id）
 * @returns {Promise<{ok:boolean, error?:string, config?:object}>}
 */
export async function saveConfigUpdates(updates, knownSources) {
  if (!Array.isArray(updates)) return { ok: false, error: 'updates 必须是数组' }
  const known = new Set((Array.isArray(knownSources) ? knownSources : []).map((source) => String(source && source.id)))
  const config = await loadConfig()
  const next = { ...config.sources }
  for (const update of updates) {
    if (!update || typeof update !== 'object') return { ok: false, error: 'updates 里有一条不是对象' }
    const id = String(update.id || '').trim()
    if (!id) return { ok: false, error: '有一条改动缺 id' }
    if (!known.has(id)) return { ok: false, error: `未知数据源：${id}` }
    const entry = { ...(next[id] || {}) }
    if (typeof update.enabled === 'boolean') entry.enabled = update.enabled
    if (update.intervalMs !== undefined) {
      const normalized = normalizeInterval(update.intervalMs)
      if (normalized === null) return { ok: false, error: `${id} 的抓取间隔不合法：${update.intervalMs}` }
      entry.intervalMs = normalized
    }
    next[id] = entry
  }
  const merged = { version: 1, sources: next, updatedAt: Date.now() }
  try {
    const target = settingsPath()
    // 环境变量可以把配置指到任意子目录（验收/单测），所以要建的是**目标文件**的父目录。
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(merged, null, 1))
    await rename(tmp, target)
  } catch (error) {
    return { ok: false, error: `配置写不进去：${error && error.message ? error.message : error}` }
  }
  return { ok: true, config: merged }
}

/** 读取用户选定的摘要模型（{provider, model}）；没选过返回 null。 */
export async function loadLlmSelection() {
  const config = await loadConfig()
  const llm = config && config.llm
  if (!llm || typeof llm.provider !== 'string' || typeof llm.model !== 'string') return null
  if (!llm.provider || !llm.model) return null
  return { provider: llm.provider, model: llm.model }
}

/** 记住用户选定的摘要模型；provider/model 传空表示回到跟随 DSH 默认。 */
export async function saveLlmSelection(provider, model) {
  const config = await loadConfig()
  const next = {
    version: 1,
    sources: config.sources || {},
    llm: { provider: String(provider || ''), model: String(model || '') },
    updatedAt: Date.now(),
  }
  try {
    const target = settingsPath()
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 1))
    await rename(tmp, target)
  } catch (error) {
    return { ok: false, error: `配置写不进去：${error && error.message ? error.message : error}` }
  }
  return { ok: true, config: next }
}

/**
 * 把适配器默认值与用户覆盖合并成**有效源清单**。ingest 只认这个函数的结果。
 * @param {Array<object>} adapters SOURCES
 * @param {object} [config] loadConfig() 的返回值
 */
export function effectiveSources(adapters, config) {
  const overrides = (config && config.sources) || {}
  return (Array.isArray(adapters) ? adapters : []).map((adapter) => {
    const override = overrides[adapter.id] || {}
    const defaultEnabled = adapter.enabled !== false
    const enabled = typeof override.enabled === 'boolean' ? override.enabled : defaultEnabled
    const intervalMs = normalizeInterval(override.intervalMs) || Math.max(MIN_INTERVAL_MS, Number(adapter.intervalMs) || 180_000)
    return { ...adapter, enabled, intervalMs }
  })
}

/**
 * 给面板/接口用的描述：每条源的默认值与当前有效值并排，面板据此渲染开关与间隔。
 * @param {Array<object>} adapters SOURCES
 * @param {object} [config] loadConfig() 的返回值
 */
export function describeSources(adapters, config) {
  const list = Array.isArray(adapters) ? adapters : []
  const effective = effectiveSources(list, config)
  const overrides = (config && config.sources) || {}
  return effective.map((adapter, index) => {
    // 默认值必须取**原始适配器**：从合并后的结果反推会把用户的覆盖值当成默认值，
    // 面板上「默认 xx」会跟着漂，用户既看不出改过什么、也回不到默认。
    const raw = list[index] || {}
    return {
      id: adapter.id,
      label: adapter.label || adapter.id,
      kind: adapter.kind || 'flash',
      enabled: adapter.enabled,
      intervalMs: adapter.intervalMs,
      defaultEnabled: raw.enabled !== false,
      defaultIntervalMs: Math.max(MIN_INTERVAL_MS, Number(raw.intervalMs) || 180_000),
      overridden: Boolean(overrides[adapter.id] && Object.keys(overrides[adapter.id]).length > 0),
    }
  })
}

/** 当前配置文件的路径（面板「配置写在哪」的提示用）。 */
export function configFilePath() {
  return settingsPath()
}
