#!/usr/bin/env node
/**
 * dsh-wallstreet quant API 验收（只读）。
 *
 * 走 DSH 自己的 token 登录拿 cookie，然后逐个断言 /wallstreet/api/quant/*：
 * 概览数据、研究结论计数、持仓集中度，以及已下线的历史日报接口（应 404）。
 *
 * 用法：
 *   node verification/verify-quant-api.mjs --token='<dsh web token>'
 *   DSH_WEB_TOKEN=... node verification/verify-quant-api.mjs
 */
const argv = process.argv.slice(2)
const tokenArg = argv.find((arg) => arg.startsWith('--token='))
const token = (tokenArg ? tokenArg.slice('--token='.length) : '') || process.env.DSH_WEB_TOKEN || ''
const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'

if (!token) {
  console.error('缺少 DSH Web token：用 --token=<token> 或环境变量 DSH_WEB_TOKEN 传入。')
  process.exit(2)
}

const failures = []

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(name)
}

/** 用 token 换登录 cookie（dsh web 回 303 + Set-Cookie）。 */
async function loginCookie() {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  if (!setCookies.length) throw new Error(`登录未返回 Set-Cookie（HTTP ${response.status}）`)
  return setCookies[0].split(';')[0]
}

const cookie = await loginCookie()

async function get(path) {
  const response = await fetch(`${base}${path}`, { headers: { cookie } })
  const text = await response.text()
  return { status: response.status, contentType: response.headers.get('content-type') || '', text }
}

async function getJson(path) {
  const result = await get(path)
  let body = null
  try {
    body = JSON.parse(result.text)
  } catch {
    body = null
  }
  return { ...result, body }
}

try {
  const health = await getJson('/wallstreet/api/health')
  check('quant 服务健康 200', health.status === 200 && health.body && health.body.ok === true)

  const overview = await getJson('/wallstreet/api/quant/overview')
  const ov = overview.body || {}
  check('quant/overview 200', overview.status === 200)
  check(
    'overview 带数据日期',
    typeof ov.dataDate === 'string' && /^(\d{8}|\d{4}-\d{2}-\d{2})$/.test(ov.dataDate),
    String(ov.dataDate),
  )
  check('overview 含估值分位', ov.valuation && Object.keys(ov.valuation).length >= 3, Object.keys(ov.valuation || {}).join(','))
  check('overview 含两融/期货/涨停池', Boolean(ov.margin && ov.futures && ov.limitPool))
  check('overview 含龙虎榜与板块资金流', Array.isArray(ov.lhb) && ov.lhb.length > 0 && Array.isArray(ov.sectorFlow) && ov.sectorFlow.length > 0)
  check('overview 金额字段为「元」量级', typeof ov.breadth?.totalAmount === 'number' && ov.breadth.totalAmount > 1e10)

  const research = await getJson('/wallstreet/api/quant/research')
  const re = research.body || {}
  check('quant/research 200', research.status === 200)
  check('研究结论含一句话结论', typeof re.headline === 'string' && re.headline.includes('没有可实盘的策略'), String(re.headline || '').slice(0, 40))
  check(
    '回测计数 = 有效+边缘+无效',
    re.counts && re.counts.total === re.counts.effective + re.counts.edge + re.counts.invalid,
    JSON.stringify(re.counts || {}),
  )
  check('策略条目 34 份且按 act_t 降序', Array.isArray(research.body?.strategies) && re.strategies.length === 34 && re.strategies[0].actT >= re.strategies.at(-1).actT)

  /* 历史日报模块已按需求移除：旧接口必须 404，数据仍由 cron 写入 dsh-kb。 */
  const goneReports = await getJson('/wallstreet/api/quant/reports')
  check('旧 /quant/reports 已下线 404', goneReports.status === 404, String(goneReports.status))
  const goneReport = await getJson('/wallstreet/api/quant/report/20261111')
  check('旧 /quant/report 已下线 404', goneReport.status === 404, String(goneReport.status))
  const goneAsset = await getJson('/wallstreet/api/quant/assets/shell.css')
  check('旧 /quant/assets 已下线 404', goneAsset.status === 404, String(goneAsset.status))

  const holdings = await getJson('/wallstreet/api/quant/holdings')
  const ho = (holdings.body && holdings.body.snapshot) || {}
  check('quant/holdings 200 且含 HHI', holdings.status === 200 && typeof ho.hhi === 'number', `date=${ho.date} hhi=${ho.hhi}`)
  check('持仓集中度带年龄提示', typeof ho.ageDays === 'number' && ho.ageDays >= 0, `${ho.ageDays} 天`)

} catch (error) {
  failures.push(`异常：${error.message}`)
}

console.log('')
if (failures.length === 0) {
  console.log('quant API 验收通过。')
  process.exit(0)
}
console.error(`验收失败 ${failures.length} 项：${failures.join('；')}`)
process.exit(1)
