#!/usr/bin/env node
/**
 * lib/hub/sources.js 自测（2026-11-25，2026-11-25 追加 em-flash）
 * 用法：node verification/verify-sources.mjs [--only id1,id2] [--all]
 * 逐个源顺序跑（避免打爆上游），打印 id | ok/fail | 条数 | 首条标题 | 耗时 | 错误。
 * 同时做字段契约校验：必填字段、类型、长度、无 id/eventType/importance、同源去重。
 *
 * 另外两段不依赖网络的部分：
 *   ① 结构自检：适配器不许自己写 fetch（必须走 lib/hub/upstream.js）；
 *   ② em-flash 离线契约测试：无 title 回退到 summary、http→https、req_trace 错误信封。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { SOURCES } from '../lib/hub/sources.js'

const argv = process.argv.slice(2)
const onlyArg = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : ''
const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null
const includeDisabled = argv.includes('--all')

/** 不通过网络也能判死的结构问题累加到这里，最后一起算退出码。 */
const structuralFails = []
function structural(ok, message) {
  console.log(`${ok ? '✅' : '❌'} ${message}`)
  if (!ok) structuralFails.push(message)
}

/* ---- ① 结构自检：适配器必须统一走 upstream.js ---- */
const sourcesPath = fileURLToPath(new URL('../lib/hub/sources.js', import.meta.url))
const sourcesText = await readFile(sourcesPath, 'utf8')
console.log('结构自检：')
structural(/from '\.\/upstream\.js'/.test(sourcesText), 'sources.js 从 ./upstream.js 取 fetchJson/fetchText/UpstreamError')
structural(!/await\s+fetch\s*\(/.test(sourcesText), 'sources.js 里没有裸 fetch(（网络调用都在 upstream.js）')
structural(!/AbortSignal\.timeout/.test(sourcesText), 'sources.js 里没有自己实现超时（超时归 upstream.js）')
structural(/code: 'parse'/.test(sourcesText), '解析失败抛 code=parse（面板据此和网络抖动区分）')

/* ---- ② em-flash 源静态契约 ---- */
const emFlash = SOURCES.find((s) => s && s.id === 'em-flash')
structural(Boolean(emFlash), '存在 em-flash 源')
if (emFlash) {
  structural(emFlash.label === '东财快讯', `em-flash label 是「东财快讯」（实际 ${emFlash.label}）`)
  structural(emFlash.kind === 'flash', `em-flash kind 是 flash（实际 ${emFlash.kind}）`)
  structural(emFlash.intervalMs === 120_000, `em-flash intervalMs 是 120000（实际 ${emFlash.intervalMs}）`)
  structural(emFlash.enabled === true, 'em-flash 已启用')
}
console.log('')

const FIELDS = ['ts', 'source', 'sourceLabel', 'kind', 'title', 'summary', 'url', 'tickers', 'sectors', 'degraded']
const FORBIDDEN = ['id', 'eventType', 'importance']
const KINDS = new Set(['flash', 'announcement', 'report', 'policy'])

function validate(items, profile) {
  const problems = []
  const keys = new Set()
  for (const [i, item] of items.entries()) {
    const at = `#${i}`
    if (item === null || typeof item !== 'object') { problems.push(`${at} 不是对象`); continue }
    for (const field of FIELDS) {
      if (!(field in item)) problems.push(`${at} 缺字段 ${field}`)
    }
    for (const field of FORBIDDEN) {
      if (field in item) problems.push(`${at} 不该有 ${field}（由上层补）`)
    }
    if (item.source !== profile.id) problems.push(`${at} source=${item.source} 与 adapter ${profile.id} 不一致`)
    if (item.sourceLabel !== profile.label) problems.push(`${at} sourceLabel 不一致`)
    if (item.kind !== profile.kind) problems.push(`${at} kind=${item.kind} 与 adapter ${profile.kind} 不一致`)
    if (!KINDS.has(item.kind)) problems.push(`${at} kind 非法`)
    if (typeof item.ts !== 'number' || !Number.isFinite(item.ts) || item.ts < 1_000_000_000_000) problems.push(`${at} ts 非法: ${item.ts}`)
    if (item.ts > Date.now() + 86_400_000) problems.push(`${at} ts 在未来: ${new Date(item.ts).toISOString()}`)
    if (typeof item.title !== 'string' || !item.title.trim()) problems.push(`${at} title 空`)
    if (Array.from(item.title || '').length > 120) problems.push(`${at} title 超 120 字: ${Array.from(item.title).length}`)
    if (typeof item.summary !== 'string') problems.push(`${at} summary 不是字符串`)
    if (item.summary.length > 200) problems.push(`${at} summary 超 200 字`)
    if (typeof item.url !== 'string') problems.push(`${at} url 不是字符串`)
    if (item.url && !/^https?:\/\//.test(item.url)) problems.push(`${at} url 非 http(s): ${item.url}`)
    if (!Array.isArray(item.tickers)) problems.push(`${at} tickers 不是数组`)
    else if (item.tickers.some((t) => !/^\d{6}$/.test(t))) problems.push(`${at} tickers 含非 6 位码: ${item.tickers}`)
    if (!Array.isArray(item.sectors)) problems.push(`${at} sectors 不是数组`)
    if (typeof item.degraded !== 'boolean') problems.push(`${at} degraded 不是布尔`)
    const key = `${item.source}|${item.url || item.title}`
    if (keys.has(key)) problems.push(`${at} 同源重复（去重键 ${key.slice(0, 40)}…）`)
    keys.add(key)
  }
  return problems.slice(0, 4)
}

const pad = (s, n) => String(s).padEnd(n)
const rows = []
let okCount = 0
let failCount = 0
let skipCount = 0

console.log(`共 ${SOURCES.length} 个源；工作目录 ${process.cwd()}\n`)
const header = `${pad('id', 12)}| ${pad('结果', 6)}| ${pad('条数', 4)}| ${pad('耗时', 8)}| 首条标题`
console.log(header)
console.log('-'.repeat(104))

for (const profile of SOURCES) {
  const id = profile && profile.id
  if (only && !only.has(id)) continue
  if (!profile.enabled && !includeDisabled) {
    skipCount += 1
    console.log(`${pad(id, 12)}| ${pad('skip', 6)}| ${pad('-', 4)}| ${pad('-', 8)}| (enabled:false)`)
    rows.push({ id, status: 'skip', count: '-', ms: '-', title: '(enabled:false)' })
    continue
  }
  if (typeof profile.fetch !== 'function') {
    failCount += 1
    console.log(`${pad(id, 12)}| ${pad('fail', 6)}| ${pad(0, 4)}| ${pad('0ms', 8)}| fetch 不是函数`)
    continue
  }

  const started = Date.now()
  let items = null
  let error = ''
  try {
    items = await profile.fetch()
  } catch (err) {
    error = (err && err.message) || String(err)
  }
  const ms = Date.now() - started

  if (!Array.isArray(items)) {
    failCount += 1
    const reason = error || '没有返回数组'
    console.log(`${pad(id, 12)}| ${pad('fail', 6)}| ${pad('-', 4)}| ${pad(`${ms}ms`, 8)}| ${reason}`)
    rows.push({ id, status: 'fail', count: '-', ms: `${ms}ms`, title: reason })
    continue
  }

  const problems = validate(items, profile)
  const status = problems.length ? 'fail' : 'ok'
  if (status === 'ok') okCount += 1
  else failCount += 1
  const first = items[0] ? (items[0].title || '').slice(0, 34) : '(空)'
  const label = problems.length ? 'fail' : `ok(${items.length})`
  console.log(`${pad(id, 12)}| ${pad(label, 6)}| ${pad(items.length, 4)}| ${pad(`${ms}ms`, 8)}| ${first}`)
  if (problems.length) for (const p of problems) console.log(`${''.padEnd(12)}|       |     |         | ⚠ ${p}`)
  rows.push({ id, status, count: items.length, ms: `${ms}ms`, title: first, problems })
}

console.log('-'.repeat(104))
const nonEmpty = rows.filter((r) => typeof r.count === 'number' && r.count > 0).length
const enabledRuns = rows.filter((r) => r.status !== 'skip').length
console.log(`ok=${okCount} fail=${failCount} skipped(disabled)=${skipCount} | 返回>0 条的源：${nonEmpty} / ${enabledRuns} 个已启用`)

// 抽样打印一条完整 item，肉眼确认 §2 形状
const sampleProfile = SOURCES.find((s) => s.enabled && typeof s.fetch === 'function')
if (sampleProfile) {
  try {
    const items = await sampleProfile.fetch()
    if (items.length) {
      console.log(`\n样例 item（${sampleProfile.id}）：`)
      console.log(JSON.stringify(items[0], null, 2))
      console.log(`\n字段集合：${Object.keys(items[0]).join(',')}`)
      console.log(`degraded 条数：${items.filter((i) => i.degraded).length}/${items.length}`)
    }
  } catch (err) {
    console.log(`\n样例取样失败（${sampleProfile.id}）：${err.message}`)
  }
}

const target = 11
const emFlashRow = rows.find((r) => r.id === 'em-flash')

/* ---- ③ em-flash 离线契约测试（stub 掉 globalThis.fetch，不碰网络）---- */
async function runOfflineEmFlashChecks() {
  if (!emFlash) return
  const realFetch = globalThis.fetch
  const stub = (payload) => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    // 无 title → summary 首句/【】导语，≤46 字；http:// 升 https；空 summary 丢弃
    stub({
      code: '1',
      message: 'success',
      data: {
        list: [
          {
            code: 'A1',
            title: '',
            summary: '【降准落地】央行宣布下调存款准备金率0.5个百分点，释放长期资金约1万亿元，市场普遍认为有助于稳预期。',
            showTime: '2026-11-25 09:00:00',
            uniqueUrl: 'http://finance.eastmoney.com/a/1.html',
          },
          {
            code: 'A2',
            title: '正常标题',
            summary: '正文一段。',
            showTime: '2026-11-25 10:00:00',
            uniqueUrl: 'http://stock.eastmoney.com/a/2.html',
          },
          { code: 'A3', title: '', summary: '', showTime: '2026-11-25 11:00:00', uniqueUrl: 'http://x/a.html' },
        ],
      },
    })
    const items = await emFlash.fetch()
    const noTitle = items.find((i) => i.source === 'em-flash' && i.title.startsWith('降准'))
    structural(items.length === 2, `em-flash 丢弃无 title 且无 summary 的条目（拿到 ${items.length} 条）`)
    structural(Boolean(noTitle), 'em-flash 无 title 时用 summary 造标题')
    structural(noTitle ? Array.from(noTitle.title).length <= 46 : false, `em-flash 回退标题 ≤46 字（实际 ${noTitle ? Array.from(noTitle.title).length : '-'}）`)
    structural(items.every((i) => i.url.startsWith('https://')), 'em-flash 链接全部升级为 https')
    structural(items.every((i) => i.degraded === false), 'em-flash showTime 正常解析，无 degraded')

    // req_trace 缺失 → 上游 HTTP 200 + 错误信封，必须报 parse 而不是「0 条」
    stub({ code: 0, message: "Required String parameter 'req_trace' is not present", data: null })
    const envelope = await emFlash.fetch().then(
      () => ({ code: 'no-throw', message: '没有抛错' }),
      (err) => ({ code: err && err.code, message: err && err.message }),
    )
    structural(envelope.code === 'parse', `em-flash 错误信封报 code=parse（实际 ${envelope.code}）`)
    structural(/req_trace/.test(envelope.message || ''), `em-flash 错误信封带上游原因（${envelope.message}）`)

    // 结构变更 → parse
    stub({ code: '1', message: 'success', data: { page_index: 1 } })
    const shape = await emFlash.fetch().then(
      () => ({ code: 'no-throw' }),
      (err) => ({ code: err && err.code }),
    )
    structural(shape.code === 'parse', `em-flash data.list 缺失报 code=parse（实际 ${shape.code}）`)
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log('\n离线契约测试（em-flash，stub fetch）：')
await runOfflineEmFlashChecks()

const emFlashRan = !only || only.has('em-flash')
const emFlashOk = !emFlashRan
  ? true // --only 跑别的源时不判 em-flash 的实测条数
  : Boolean(emFlashRow && typeof emFlashRow.count === 'number' && emFlashRow.count > 0)
if (emFlashRan) structural(emFlashOk, `em-flash 实测返回 >0 条（实际 ${emFlashRow ? emFlashRow.count : '-'}）`)

// --only 是单源调试：只要求被选中的源都返回 >0，不套整轮阈值
const thresholdOk = only ? nonEmpty === enabledRuns : nonEmpty >= target
const thresholdText = only ? `选中的 ${enabledRuns} 个源都返回 >0 条` : `${nonEmpty} 个源返回 >0 条（要求 ≥ ${target}，含 em-flash 必须 >0）`

if (thresholdOk && emFlashOk && structuralFails.length === 0) {
  console.log(`\n✅ 通过：${thresholdText}`)
  process.exit(0)
} else {
  const reasons = []
  if (!thresholdOk) {
    reasons.push(
      only
        ? `选中的 ${enabledRuns} 个源里有 ${enabledRuns - nonEmpty} 个返回 0 条/失败`
        : `只有 ${nonEmpty} 个源返回 >0 条（要求 ≥ ${target}）`,
    )
  }
  if (!emFlashOk) reasons.push('em-flash 没有返回条目')
  if (structuralFails.length) reasons.push(`${structuralFails.length} 项结构/契约检查未过`)
  console.log(`\n❌ 未达标：${reasons.join('；')}`)
  process.exit(1)
}
