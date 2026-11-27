/**
 * lib/hub/config.js —— 源配置单测
 *
 * 全部读写落在 mkdtemp 的临时目录里（DSH_WALLSTREET_DATA / DSH_WALLSTREET_SETTINGS_FILE），
 * 不碰插件真实的 data/hub-settings.json。环境变量必须在 import 之前设好：
 * DATA_DIR 是模块级常量。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'dsh-wallstreet-config-'))
process.env.DSH_WALLSTREET_DATA = DIR

const {
  loadConfig,
  saveConfigUpdates,
  normalizeInterval,
  effectiveSources,
  describeSources,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
} = await import('../lib/hub/config.js')

after(() => {
  rmSync(DIR, { recursive: true, force: true })
})

let caseNo = 0
/** 给当前用例分配独立的配置文件，用例之间互不影响。 */
const useSettings = () => {
  const file = join(DIR, `settings-${++caseNo}.json`)
  process.env.DSH_WALLSTREET_SETTINGS_FILE = file
  return file
}

const KNOWN = [{ id: 'a', label: 'A源' }, { id: 'b', label: 'B源' }]

/* ------------------------------ loadConfig ------------------------------ */

test('loadConfig：文件不存在时返回空配置，且没有 _error', async () => {
  useSettings()
  assert.deepEqual(await loadConfig(), { version: 1, sources: {}, updatedAt: 0 })
})

test('loadConfig：合法文件原样读出（顶层字段覆盖默认值）', async () => {
  const file = useSettings()
  writeFileSync(file, JSON.stringify({ version: 7, sources: { a: { enabled: false } }, updatedAt: 12345 }))
  assert.deepEqual(await loadConfig(), { version: 7, sources: { a: { enabled: false } }, updatedAt: 12345 })
})

test('loadConfig：JSON 损坏时返回 _error，不抛错', async () => {
  const file = useSettings()
  writeFileSync(file, '{oops')
  const config = await loadConfig()
  assert.equal(config.version, 1)
  assert.deepEqual(config.sources, {})
  assert.match(config._error, /配置文件读不出来/)
})

test('loadConfig：缺少 sources 对象时返回格式错误，而不是静默接受', async () => {
  const file = useSettings()
  writeFileSync(file, JSON.stringify({ version: 1 }))
  const config = await loadConfig()
  assert.equal(config._error, '配置文件格式不对（缺少 sources 对象）')
  assert.deepEqual(config.sources, {})
})

test('loadConfig：sources 为 null / 顶层是数组时都报格式错误', async () => {
  const file = useSettings()
  writeFileSync(file, JSON.stringify({ sources: null }))
  assert.equal((await loadConfig())._error, '配置文件格式不对（缺少 sources 对象）')
  writeFileSync(file, JSON.stringify([1, 2, 3]))
  assert.match((await loadConfig())._error, /配置文件格式不对/)
})

test('loadConfig：坏文件不会被覆盖（留证据给用户）', async () => {
  const file = useSettings()
  writeFileSync(file, '{坏掉的 JSON')
  await loadConfig()
  assert.equal(readFileSync(file, 'utf8'), '{坏掉的 JSON')
})

/* ------------------------------ normalizeInterval ------------------------------ */

test('normalizeInterval：合法值取整后原样返回', () => {
  assert.equal(normalizeInterval(MIN_INTERVAL_MS), MIN_INTERVAL_MS)
  assert.equal(normalizeInterval(60_000), 60_000)
  assert.equal(normalizeInterval(60_000.6), 60_001)
  assert.equal(normalizeInterval('60000'), 60_000)
})

test('normalizeInterval：低于 30 秒夹到下限', () => {
  assert.equal(normalizeInterval(1_000), MIN_INTERVAL_MS)
  assert.equal(normalizeInterval(1), MIN_INTERVAL_MS)
  assert.equal(normalizeInterval(MIN_INTERVAL_MS - 1), MIN_INTERVAL_MS)
})

test('normalizeInterval：高于 6 小时夹到上限', () => {
  assert.equal(normalizeInterval(MAX_INTERVAL_MS + 1), MAX_INTERVAL_MS)
  assert.equal(normalizeInterval(7 * 60 * 60 * 1000), MAX_INTERVAL_MS)
})

test('normalizeInterval：非法值返回 null（表示「不覆盖」）', () => {
  for (const value of [null, undefined, '', 0, -1, NaN, 'abc', Infinity, -Infinity]) {
    assert.equal(normalizeInterval(value), null, `${String(value)} 应判非法`)
  }
})

/* ------------------------------ saveConfigUpdates ------------------------------ */

test('saveConfigUpdates：updates 不是数组直接拒绝', async () => {
  useSettings()
  assert.deepEqual(await saveConfigUpdates('x', KNOWN), { ok: false, error: 'updates 必须是数组' })
  assert.deepEqual(await saveConfigUpdates(null, KNOWN), { ok: false, error: 'updates 必须是数组' })
})

test('saveConfigUpdates：未知 source id 拒绝整批（不静默丢弃）', async () => {
  useSettings()
  const result = await saveConfigUpdates([{ id: 'zzz', enabled: true }], KNOWN)
  assert.equal(result.ok, false)
  assert.equal(result.error, '未知数据源：zzz')
})

test('saveConfigUpdates：缺 id 的改动拒绝', async () => {
  useSettings()
  assert.deepEqual(await saveConfigUpdates([{ enabled: true }], KNOWN), { ok: false, error: '有一条改动缺 id' })
})

test('saveConfigUpdates：条目不是对象时拒绝', async () => {
  useSettings()
  assert.deepEqual(await saveConfigUpdates([12], KNOWN), { ok: false, error: 'updates 里有一条不是对象' })
})

test('saveConfigUpdates：非法间隔拒绝，错误里带 id 与原值', async () => {
  useSettings()
  const result = await saveConfigUpdates([{ id: 'a', intervalMs: 'abc' }], KNOWN)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'a 的抓取间隔不合法：abc')
})

test('saveConfigUpdates：整批里有一条不合法就不落盘（不做一半成功）', async () => {
  const file = useSettings()
  const first = await saveConfigUpdates([{ id: 'a', enabled: false, intervalMs: 600_000 }], KNOWN)
  assert.equal(first.ok, true)
  const before = readFileSync(file, 'utf8')

  const failed = await saveConfigUpdates([{ id: 'a', enabled: true }, { id: 'b', intervalMs: -5 }], KNOWN)
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'b 的抓取间隔不合法：-5')
  assert.equal(readFileSync(file, 'utf8'), before, '失败的整批不应改动已有配置')
})

test('saveConfigUpdates：成功写盘，间隔被夹到允许区间', async () => {
  const file = useSettings()
  const result = await saveConfigUpdates([{ id: 'a', enabled: false, intervalMs: 1_000 }], KNOWN)
  assert.equal(result.ok, true)
  assert.deepEqual(result.config.sources.a, { enabled: false, intervalMs: MIN_INTERVAL_MS })
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(onDisk.sources.a, { enabled: false, intervalMs: MIN_INTERVAL_MS })
  assert.equal(onDisk.version, 1)
  assert.ok(onDisk.updatedAt > 0)
})

test('saveConfigUpdates：只改一个字段时保留同源已有覆盖', async () => {
  useSettings()
  await saveConfigUpdates([{ id: 'a', enabled: false, intervalMs: 600_000 }], KNOWN)
  const second = await saveConfigUpdates([{ id: 'a', intervalMs: 7_200_000 }], KNOWN)
  assert.deepEqual(second.config.sources.a, { enabled: false, intervalMs: 7_200_000 })
})

test('saveConfigUpdates：落盘是「临时文件 + rename」，不留 .tmp 残留', async () => {
  useSettings()
  await saveConfigUpdates([{ id: 'a', enabled: true }], KNOWN)
  const leftovers = readdirSync(DIR).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('saveConfigUpdates：空数组也落一份配置（ok），但不动任何源', async () => {
  const file = useSettings()
  const result = await saveConfigUpdates([], KNOWN)
  assert.equal(result.ok, true)
  assert.deepEqual(result.config.sources, {})
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).sources, {})
})

/* ------------------------------ effectiveSources ------------------------------ */

const ADAPTERS = [
  { id: 'a', label: 'A源', kind: 'flash', intervalMs: 120_000 },
  { id: 'b', label: 'B源', enabled: false },
  { id: 'c', label: 'C源', intervalMs: 10_000 },
]

test('effectiveSources：缺省 enabled=true，缺省间隔 180 秒，过小间隔抬到 30 秒', () => {
  const [a, b, c] = effectiveSources(ADAPTERS, null)
  assert.equal(a.enabled, true)
  assert.equal(a.intervalMs, 120_000)
  assert.equal(b.enabled, false)
  assert.equal(b.intervalMs, 180_000)
  assert.equal(c.enabled, true)
  assert.equal(c.intervalMs, MIN_INTERVAL_MS)
})

test('effectiveSources：配置覆盖 enabled 与 intervalMs', () => {
  const [a, b] = effectiveSources(ADAPTERS, {
    sources: { a: { enabled: false, intervalMs: 3_600_000 }, b: { enabled: true, intervalMs: 60_000 } },
  })
  assert.equal(a.enabled, false)
  assert.equal(a.intervalMs, 3_600_000)
  assert.equal(b.enabled, true)
  assert.equal(b.intervalMs, 60_000)
})

test('effectiveSources：配置里过小的间隔同样被夹紧', () => {
  const [a] = effectiveSources(ADAPTERS, { sources: { a: { intervalMs: 5_000 } } })
  assert.equal(a.intervalMs, MIN_INTERVAL_MS)
})

test('effectiveSources：非数组入参返回空数组', () => {
  assert.deepEqual(effectiveSources(null, null), [])
  assert.deepEqual(effectiveSources(undefined, {}), [])
  assert.deepEqual(effectiveSources('x', null), [])
})

test('effectiveSources：未知 id 的覆盖被忽略，不影响其它源', () => {
  const list = effectiveSources(ADAPTERS, { sources: { zzz: { enabled: false } } })
  assert.deepEqual(list.map((source) => source.id), ['a', 'b', 'c'])
  assert.equal(list.find((source) => source.id === 'a').enabled, true)
})

/* ------------------------------ describeSources ------------------------------ */

test('describeSources：无覆盖时默认值与有效值一致，overridden=false', () => {
  const [a, b, c] = describeSources(ADAPTERS, null)
  assert.deepEqual(
    { id: a.id, label: a.label, kind: a.kind, enabled: a.enabled, intervalMs: a.intervalMs, defaultEnabled: a.defaultEnabled, defaultIntervalMs: a.defaultIntervalMs, overridden: a.overridden },
    { id: 'a', label: 'A源', kind: 'flash', enabled: true, intervalMs: 120_000, defaultEnabled: true, defaultIntervalMs: 120_000, overridden: false },
  )
  assert.equal(b.defaultEnabled, false, '适配器默认关闭的源，默认值应为 false')
  assert.equal(b.defaultIntervalMs, 180_000)
  assert.equal(c.defaultIntervalMs, MIN_INTERVAL_MS)
})

test('describeSources：有覆盖时 overridden=true，有效值反映覆盖结果', () => {
  const [a] = describeSources(ADAPTERS, { sources: { a: { enabled: false, intervalMs: 3_600_000 } } })
  assert.equal(a.enabled, false)
  assert.equal(a.intervalMs, 3_600_000)
  assert.equal(a.overridden, true)
})

test('describeSources：空覆盖对象不算「被覆盖过」', () => {
  const [b] = describeSources(ADAPTERS, { sources: { b: {} } })
  assert.equal(b.overridden, false)
})

test('describeSources：label/kind 缺省时回退 id 与 flash', () => {
  const [d] = describeSources([{ id: 'd' }], null)
  assert.equal(d.label, 'd')
  assert.equal(d.kind, 'flash')
  assert.equal(d.enabled, true)
  assert.equal(d.intervalMs, 180_000)
  assert.equal(d.overridden, false)
})

test('describeSources：默认值取原始适配器，不被用户覆盖带偏（修 D1）', async () => {
  const adapters = [{ id: 'a', label: 'A', intervalMs: 120000 }]
  const config = { sources: { a: { enabled: false, intervalMs: 600000 } } }
  const [item] = describeSources(adapters, config)
  assert.equal(item.enabled, false, '有效值应是覆盖后的 false')
  assert.equal(item.intervalMs, 600000, '有效间隔应是覆盖后的 10 分钟')
  assert.equal(item.defaultEnabled, true, '默认启用状态必须来自适配器')
  assert.equal(item.defaultIntervalMs, 120000, '默认间隔必须来自适配器')
  assert.equal(item.overridden, true)
})
