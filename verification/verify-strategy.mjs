#!/usr/bin/env node
/**
 * dsh-wallstreet「策略口径」验收（纯函数，不需要 DSH 在跑、不需要 token）。
 *
 * 断言的是 vectra 文档里那些「可计算」的口径是否按原文落地：
 * 两套画像的资产配置与目标年化、单票/单行业/核心/现金红线、止损分级、
 * 年度熔断、网格参数与扣费后单格收益、可转债双低筛选、行业轮动排序、收益归因。
 *
 * 用法：npm run verify:strategy
 */
import {
  PROFILES,
  allocationTable,
  attribution,
  circuitBreaker,
  dualLowScreen,
  getProfile,
  gridPlan,
  riskCheck,
  rotationScore,
  stopLossAction,
} from '../lib/strategy.js'

const failures = []

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(name)
}

function near(actual, expected, tolerance = 0.05) {
  return Math.abs(actual - expected) <= tolerance
}

// —— 资产配置：权重和为 1、金额加总等于本金、目标年化与文档一致 ——
for (const [id, expectedTarget] of [['10w', 17.5], ['50w', 12.8]]) {
  const table = allocationTable(id)
  const weightSum = table.rows.reduce((sum, row) => sum + row.weight, 0)
  const amountSum = table.rows.reduce((sum, row) => sum + row.amount, 0)
  check(`${id} 权重加总为 100%`, near(weightSum, 1, 1e-9), `${(weightSum * 100).toFixed(2)}%`)
  check(`${id} 金额加总等于本金`, amountSum === table.capital, `${amountSum}/${table.capital}`)
  check(`${id} 组合目标年化 ${expectedTarget}%`, near(table.blendedTarget, expectedTarget, 0.2), `${table.blendedTarget}%`)
}
check('10w 现金/核心/卫星/增强 = 10/30/45/15', allocationTable('10w').rows.map((r) => r.weightPct).join(',') === '10,30,45,15')
check('50w 现金/核心/卫星/增强 = 10/50/30/10', allocationTable('50w').rows.map((r) => r.weightPct).join(',') === '10,50,30,10')

// —— 风控红线：10 万版单票 8%、单行业 20%、核心 25%、现金 5% ——
const breach = riskCheck({
  profileId: '10w',
  totalAssets: 100000,
  positions: [
    { code: '600519', name: '贵州茅台', kind: 'stock', sector: '食品饮料', value: 12000 },
    { code: '510300', name: '沪深300ETF', kind: 'broadETF', sector: '宽基', value: 10000 },
    { code: '512480', name: '半导体ETF', kind: 'sectorETF', sector: '半导体', value: 12000 },
    { code: '512760', name: '芯片ETF', kind: 'sectorETF', sector: '半导体', value: 11000 },
    { code: 'cash', name: '现金', kind: 'cash', sector: '现金', value: 2000 },
    { code: '159915', name: '创业板ETF', kind: 'broadETF', sector: '宽基', value: 10000 },
    { code: '113050', name: '南银转债', kind: 'convertible', sector: '银行', value: 8000 },
  ],
})
const codes = breach.violations.map((item) => item.code)
check('单票超限被识别', codes.includes('single-stock'), codes.join(','))
check('单行业超限被识别', codes.includes('single-sector'), codes.join(','))
check('核心占比不足被识别', codes.includes('core-min'), `${breach.metrics.corePct}% < 25%`)
check('现金不足被识别', codes.includes('cash-min'), `${breach.metrics.cashPct}% < 5%`)
check('违规结构含 actual/limit/message', breach.violations.every((v) => v.actual != null && v.limit != null && v.message))

const healthy = riskCheck({
  profileId: '10w',
  totalAssets: 100000,
  positions: [
    { code: '510300', name: '沪深300ETF', kind: 'broadETF', sector: '宽基', value: 30000 },
    { code: '600519', name: '贵州茅台', kind: 'stock', sector: '食品饮料', value: 5000 },
    { code: 'cash', name: '现金', kind: 'cash', sector: '现金', value: 8000 },
  ],
})
check('合规组合无违规（宽基不计入单行业）', healthy.ok && healthy.violations.length === 0, JSON.stringify(healthy.metrics))
check('空持仓返回 error 而非崩溃', riskCheck({ positions: [] }).ok === false)

// —— 止损分级 ——
check('个股 -22% → 强平', stopLossAction({ profileId: '10w', kind: 'stock', pnl: -0.22 }).action === 'cut')
check('个股 -12% → 评估', stopLossAction({ profileId: '10w', kind: 'stock', pnl: -0.12 }).action === 'review')
check('50w 个股 -18% → 评估（口径更松）', stopLossAction({ profileId: '50w', kind: 'stock', pnl: -0.18 }).action === 'review')
check('行业 ETF -16% → 评估', stopLossAction({ profileId: '10w', kind: 'sectorETF', pnl: -0.16 }).action === 'review')
check('宽基 ETF 不止损', stopLossAction({ profileId: '10w', kind: 'broadETF', pnl: -0.5 }).action === 'hold')
check('可转债 -9% → 评估', stopLossAction({ profileId: '10w', kind: 'convertible', pnl: -0.09 }).action === 'review')

// —— 年度熔断 ——
check('-16% → 暂停主动交易', circuitBreaker({ profileId: '10w', ytdReturn: -0.16 }).state === 'pause')
check('-26% → 清仓卫星', circuitBreaker({ profileId: '10w', ytdReturn: -0.26 }).state === 'liquidate')
check('+8% → 正常', circuitBreaker({ profileId: '10w', ytdReturn: 0.08 }).state === 'normal')

// —— 网格：区间 10%、10 格、单格扣费后收益 ——
const grid = gridPlan({ last: 3, count: 10, capital: 10000 })
check('网格 11 个挂单价位', grid.levels.length === 11, `${grid.levels.length}`)
check('区间 = 现价 ±5%', near(grid.lower, 2.85, 0.001) && near(grid.upper, 3.15, 0.001), `${grid.lower}–${grid.upper}`)
check('单格涨幅约 1.05%', near(grid.stepPct, 1.05, 0.01), `${grid.stepPct}%`)
check('扣费后单格净收益约 1%', near(grid.roundTrip.netPct, 1, 0.01), `${grid.roundTrip.netPct}%`)
check('每格资金 = 本金/11', grid.perLevel === 909, `${grid.perLevel}`)
const explicit = gridPlan({ low: 2.5, high: 3.5, count: 5, capital: 6000 })
check('显式区间 5 格 6 档', explicit.levels.length === 6 && explicit.perLevel === 1000, `${explicit.levels.length}/${explicit.perLevel}`)

// —— 可转债双低 ——
const bonds = dualLowScreen([
  { code: '113050', name: '南银转债', price: 118.2, premiumRate: 12.5, ytm: 2.4 },
  { code: '123001', name: '高溢价债', price: 150, premiumRate: 35, ytm: 3 },
  { code: '113001', name: '低收益债', price: 105, premiumRate: 8, ytm: 1.1 },
  { code: '110043', name: '双低首选', price: 101.5, premiumRate: 6.2, ytm: 2.9 },
])
check('双低筛选按阈值过滤', bonds.total === 2, `${bonds.total}`)
check('双低按价格+溢价率升序', bonds.rows[0].code === '110043', bonds.rows.map((r) => r.code).join(','))
check('双低阈值回显', bonds.thresholds.premiumMax === 20 && bonds.thresholds.ytmMin === 2)

// —— 行业轮动：动量各占 50%/30%、估值 20%，强动量+低估值排前 ——
const rotation = rotationScore([
  { name: 'AI 算力', momentum3m: 18, momentum6m: 42, valuationPercentile: 85 },
  { name: '银行', momentum3m: 4, momentum6m: 9, valuationPercentile: 15 },
  { name: '有色', momentum3m: 12, momentum6m: 20, valuationPercentile: 55 },
])
check('轮动排序：高动量 AI 第一（动量权重 80%）', rotation.rows[0].name === 'AI 算力', rotation.rows.map((r) => `${r.name}:${r.score}`).join(' '))
check('轮动分数单调递减', rotation.rows.every((row, index) => index === 0 || rotation.rows[index - 1].score >= row.score))
check('轮动权重回显', rotation.weights.momentum3m === 0.5 && rotation.weights.valuation === 0.2)
check('空轮动输入不报错', rotationScore([]).rows.length === 0)

// —— 收益归因 ——
const attr = attribution([
  { name: '核心', weight: 0.3, expectedReturn: 0.1 },
  { name: '卫星', weight: 0.45, expectedReturn: 0.25 },
  { name: '增强', weight: 0.15, expectedReturn: 0.2 },
  { name: '现金', weight: 0.1, expectedReturn: 0.025 },
])
check('归因合计 ≈17.5%', near(attr.total, 17.5, 0.05), `${attr.total}%`)
check('归因逐项贡献', attr.rows.map((r) => r.contribution).join(',') === '3,11.25,3,0.25', attr.rows.map((r) => r.contribution).join(','))

// —— 画像边界 ——
let threw = false
try {
  getProfile('5w')
} catch {
  threw = true
}
check('未知画像抛错', threw)
check('两套画像都在', Object.keys(PROFILES).join(',') === '10w,50w')

// —— API 路由（用假 ctx 直接驱动 handler，不需要起 DSH、不需要 token）——
const { apply } = await import('../lib/index.js')

function buildHandler() {
  let handler = null
  const ctx = {
    get: (key) => (key === 'connection' ? { requestRejection: () => undefined } : undefined),
    effect: (fn) => fn(),
    webServer: {
      register: (options) => {
        handler = options.handler
        return () => {}
      },
    },
  }
  apply(ctx)
  return handler
}

function callApi(handler, url) {
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      status: 0,
      writeHead(status) {
        this.status = status
        this.headersSent = true
      },
      end(payload) {
        let body = null
        try {
          body = JSON.parse(payload || '{}')
        } catch {
          body = { raw: payload }
        }
        resolve({ status: this.status, body })
      },
    }
    handler({ url, method: 'GET' }, res)
  })
}

const handler = buildHandler()
check('handler 已注册', typeof handler === 'function')

const profiles = await callApi(handler, '/wallstreet/api/strategy/profiles')
check('GET /strategy/profiles 200', profiles.status === 200, String(profiles.status))
check('profiles 返回两套画像', profiles.body.ok && profiles.body.profiles.length === 2, profiles.body.profiles?.map((p) => p.id).join(','))
check('profiles 带网格默认值', profiles.body.gridDefaults?.count === 10)

const overview = await callApi(handler, '/wallstreet/api/strategy/overview?profile=50w')
check('GET /strategy/overview?profile=50w 200', overview.status === 200, String(overview.status))
check('overview 按画像给配置表', overview.body.rows?.length === 4 && overview.body.blendedTarget === 12.8, `${overview.body.blendedTarget}%`)
check('overview 带风控阈值', overview.body.rules?.singleStockMax === 0.05)
check('overview 带止损样例', Array.isArray(overview.body.stopLossSamples) && overview.body.stopLossSamples.length === 4, overview.body.stopLossSamples?.map((s) => `${s.kind}:${s.action}`).join(','))
check('止损样例：个股强平/宽基持有', overview.body.stopLossSamples.find((s) => s.kind === 'stock').action === 'cut' && overview.body.stopLossSamples.find((s) => s.kind === 'broadETF').action === 'hold')

const gridApi = await callApi(handler, '/wallstreet/api/strategy/grid?last=3&count=10&capital=10000')
check('GET /strategy/grid 200', gridApi.status === 200, String(gridApi.status))
check('grid 返回 11 档', gridApi.body.levels?.length === 11)
check('grid 缺参时按默认区间', gridApi.body.lower === 2.85 && gridApi.body.upper === 3.15, `${gridApi.body.lower}-${gridApi.body.upper}`)

const badProfile = await callApi(handler, '/wallstreet/api/strategy/overview?profile=99w')
check('未知画像回 500 且提示策略口径', badProfile.status === 500 && String(badProfile.body.error).includes('策略口径'), badProfile.body.error)

const unknown = await callApi(handler, '/wallstreet/api/nope')
check('未知路由 404', unknown.status === 404)

console.log(failures.length === 0 ? '\n全部通过' : `\n失败 ${failures.length} 项：${failures.join(' / ')}`)
process.exit(failures.length === 0 ? 0 : 1)
