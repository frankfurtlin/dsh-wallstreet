/**
 * dsh-wallstreet —— 策略口径层（v0.2）
 *
 * 迁移自 openclaw:/root/vectra 的《个人投资策略方案》与《10 万本金 · 年化 20% 目标》，
 * 把其中「可计算、可判定」的部分抽成纯函数：资产配置、风控红线、止损分级、年度熔断、
 * 网格参数、可转债双低、行业轮动打分、收益归因。
 *
 * 设计约束：
 *  - 纯函数、无 I/O：输入都是调用方给的持仓/行情/债券快照，输出是结构化结论；
 *  - 只做「研究口径」，不下单、不接券商、不构成投资建议；
 *  - 口径参数集中在上方 PROFILES / GRID_DEFAULTS，与 vectra 文档一一对应，改口径只改这里。
 */

/** 网格默认参数：vectra → GRID_SPREAD=0.10、GRID_COUNT=10。 */
export const GRID_DEFAULTS = {
  spread: 0.1,
  count: 10,
  /** 券商佣金近似值（双向万 2.5）；ETF 免印花税，故不额外加税。 */
  feeRate: 0.00025,
}

const COMMON_STOP_LOSS = {
  stock: { review: -0.1, cut: -0.2 },
  sectorETF: { review: -0.15, cut: -0.25 },
  broadETF: { review: null, cut: null },
  convertible: { review: -0.08, cut: null },
}

const COMMON_CIRCUIT_BREAKER = { pause: -0.15, liquidateSatellite: -0.25 }

/**
 * 两套画像。50w 版来自 STRATEGY.md，10w 版来自 STRATEGY_10W.md；
 * 差异（单票上限、核心底仓下限、止损更严格）如实保留，不做统一。
 */
export const PROFILES = {
  '10w': {
    id: '10w',
    label: '10 万本金 · 目标年化 20%',
    capital: 100000,
    buckets: [
      { id: 'cash', label: '现金储备', weight: 0.1, role: '突发支出 + 暴跌抄底子弹', tools: '货基 / 国债逆回购', targetReturn: 0.025 },
      { id: 'core', label: '核心 ETF 底仓', weight: 0.3, role: '宽基底盘，定投摊薄成本', tools: '沪深300 / 中证500 / 创业板', targetReturn: 0.1 },
      { id: 'satellite', label: '卫星策略', weight: 0.45, role: '行业轮动 + 个股精选（主战场）', tools: '5-8 个行业 ETF + 3-10 只个股', targetReturn: 0.25 },
      { id: 'enhance', label: '增强策略', weight: 0.15, role: '震荡市赚差价 + 债底保护', tools: 'ETF 网格 / 可转债双低', targetReturn: 0.2 },
    ],
    rules: {
      singleStockMax: 0.08,
      singleSectorMax: 0.2,
      coreMin: 0.25,
      cashMin: 0.05,
      rebalanceDeviation: 0.15,
      stopLoss: COMMON_STOP_LOSS,
      circuitBreaker: COMMON_CIRCUIT_BREAKER,
      pyramid: [0.5, 0.3, 0.2],
      sources: 'STRATEGY_10W.md',
    },
  },
  '50w': {
    id: '50w',
    label: '50 万本金 · 3-5 年视角',
    capital: 500000,
    buckets: [
      { id: 'cash', label: '应急储备', weight: 0.1, role: '突发支出 + 抄底子弹', tools: '货基 + 国债逆回购', targetReturn: 0.025 },
      { id: 'core', label: '核心持仓', weight: 0.5, role: '宽基定投 + 动态再平衡', tools: '沪深300 15% / 中证500 15% / 创业板 10% / 科创50 10%', targetReturn: 0.1 },
      { id: 'satellite', label: '卫星策略', weight: 0.3, role: '行业轮动（10 万）+ 个股精选（5 万）', tools: '5-8 个景气行业 ETF + 3-10 只个股', targetReturn: 0.2 },
      { id: 'enhance', label: '增强策略', weight: 0.1, role: '网格 + 可转债', tools: '高波动 ETF / 可转债', targetReturn: 0.15 },
    ],
    rules: {
      singleStockMax: 0.05,
      singleSectorMax: 0.2,
      coreMin: 0.4,
      cashMin: 0.05,
      rebalanceDeviation: 0.1,
      /** 50w 版的估值开关：沪深300 PE < 11 加仓至 70%，> 15 减仓至 30%。 */
      valuation: { lowPe: 11, highPe: 15, lowPeCoreWeight: 0.7, highPeCoreWeight: 0.3 },
      stopLoss: {
        stock: { review: -0.15, cut: -0.25 },
        sectorETF: { review: -0.2, cut: null },
        broadETF: { review: null, cut: null },
        convertible: { review: null, cut: null },
      },
      circuitBreaker: COMMON_CIRCUIT_BREAKER,
      pyramid: [0.5, 0.3, 0.2],
      sources: 'STRATEGY.md',
    },
  },
}

export function getProfile(profileId = '10w') {
  const profile = PROFILES[profileId]
  if (!profile) throw new Error(`未知画像：${profileId}（可选 ${Object.keys(PROFILES).join(' / ')}）`)
  return profile
}

/** 资产配置表：权重 → 金额，按金额降序便于面板直接渲染。 */
export function allocationTable(profileId = '10w') {
  const profile = getProfile(profileId)
  const rows = profile.buckets.map((bucket) => ({
    id: bucket.id,
    label: bucket.label,
    weight: bucket.weight,
    weightPct: round(bucket.weight * 100, 1),
    amount: Math.round(profile.capital * bucket.weight),
    role: bucket.role,
    tools: bucket.tools,
    targetReturn: bucket.targetReturn,
  }))
  const weighted = rows.reduce((sum, row) => sum + row.weight * row.targetReturn, 0)
  return {
    profile: profile.id,
    label: profile.label,
    capital: profile.capital,
    rows,
    /** 文档口径的组合目标年化（各桶权重 × 目标收益之和）。 */
    blendedTarget: round(weighted * 100, 1),
  }
}

/**
 * 组合风控检查：输入当前持仓，输出违规项与关键占比。
 * positions: [{ code, name, kind: 'stock'|'sectorETF'|'broadETF'|'convertible'|'cash', sector, value }]
 */
export function riskCheck({ profileId = '10w', positions = [], totalAssets } = {}) {
  const profile = getProfile(profileId)
  const rules = profile.rules
  const total = Number(totalAssets) > 0
    ? Number(totalAssets)
    : positions.reduce((sum, item) => sum + (Number(item.value) || 0), 0)
  if (!(total > 0)) return { ok: false, error: '持仓市值合计为 0，无法计算占比', violations: [], metrics: {} }

  const byKind = (kind) => positions.filter((item) => item.kind === kind)
  const share = (items) => items.reduce((sum, item) => sum + (Number(item.value) || 0), 0) / total

  const violations = []
  const cashShare = share(byKind('cash'))
  const coreShare = share([...byKind('broadETF')])

  const stocks = byKind('stock')
  stocks.forEach((item) => {
    const weight = (Number(item.value) || 0) / total
    if (weight > rules.singleStockMax + 1e-9) {
      violations.push({
        code: 'single-stock',
        severity: 'high',
        target: item.name || item.code,
        actual: round(weight * 100, 2),
        limit: round(rules.singleStockMax * 100, 1),
        message: `单只个股 ${item.name || item.code} 占总资产 ${(weight * 100).toFixed(2)}%，超过 ${(rules.singleStockMax * 100).toFixed(0)}% 上限`,
      })
    }
  })

  const sectorTotals = new Map()
  positions
    /** 宽基 ETF 与现金不是「行业」，不参与单行业集中度判定。 */
    .filter((item) => item.kind !== 'cash' && item.kind !== 'broadETF')
    .forEach((item) => {
      const sector = item.sector || item.name || item.code || '未分类'
      sectorTotals.set(sector, (sectorTotals.get(sector) || 0) + (Number(item.value) || 0))
    })
  sectorTotals.forEach((value, sector) => {
    const weight = value / total
    if (weight > rules.singleSectorMax + 1e-9) {
      violations.push({
        code: 'single-sector',
        severity: 'high',
        target: sector,
        actual: round(weight * 100, 2),
        limit: round(rules.singleSectorMax * 100, 1),
        message: `行业 ${sector} 占总资产 ${(weight * 100).toFixed(2)}%，超过 ${(rules.singleSectorMax * 100).toFixed(0)}% 上限`,
      })
    }
  })

  if (coreShare + 1e-9 < rules.coreMin) {
    violations.push({
      code: 'core-min',
      severity: 'medium',
      target: '核心 ETF',
      actual: round(coreShare * 100, 2),
      limit: round(rules.coreMin * 100, 1),
      message: `核心 ETF 仅占 ${(coreShare * 100).toFixed(2)}%，低于漂移下限 ${(rules.coreMin * 100).toFixed(0)}%`,
    })
  }
  if (cashShare + 1e-9 < rules.cashMin) {
    violations.push({
      code: 'cash-min',
      severity: 'medium',
      target: '现金',
      actual: round(cashShare * 100, 2),
      limit: round(rules.cashMin * 100, 1),
      message: `现金仅占 ${(cashShare * 100).toFixed(2)}%，低于 ${(rules.cashMin * 100).toFixed(0)}% 保底线`,
    })
  }

  return {
    ok: violations.length === 0,
    violations,
    metrics: {
      total,
      singleStockMaxPct: round(Math.max(0, ...stocks.map((item) => (Number(item.value) || 0) / total)) * 100, 2),
      singleSectorMaxPct: round(Math.max(0, ...[...sectorTotals.values()].map((value) => value / total)) * 100, 2),
      corePct: round(coreShare * 100, 2),
      cashPct: round(cashShare * 100, 2),
    },
  }
}

/** 止损分级：按标的类型与浮动盈亏给出 hold / review / cut。 */
export function stopLossAction({ profileId = '10w', kind = 'stock', pnl = 0 } = {}) {
  const rule = getProfile(profileId).rules.stopLoss[kind]
  if (!rule) return { action: 'unknown', reason: `未知标的类型：${kind}` }
  if (rule.review == null && rule.cut == null) {
    return { action: 'hold', reason: kind === 'broadETF' ? '宽基 ETF 不止损，越跌越买（前提基本面未恶化）' : '该类型无止损线，持有到期或按策略处理' }
  }
  const pnlPct = Number(pnl) * 100
  if (rule.cut != null && pnl <= rule.cut) {
    return { action: 'cut', reason: `浮亏 ${pnlPct.toFixed(1)}% 触发强制止损线 ${(rule.cut * 100).toFixed(0)}%` }
  }
  if (rule.review != null && pnl <= rule.review) {
    return { action: 'review', reason: `浮亏 ${pnlPct.toFixed(1)}% 触发评估线 ${(rule.review * 100).toFixed(0)}%，复核基本面与趋势` }
  }
  return { action: 'hold', reason: `浮亏 ${pnlPct.toFixed(1)}%，未触及 ${rule.review != null ? (rule.review * 100).toFixed(0) + '% 评估线' : '止损线'}` }
}

/** 年度熔断：全年收益触发 -15% 暂停主动交易，-25% 清仓卫星策略。 */
export function circuitBreaker({ profileId = '10w', ytdReturn = 0 } = {}) {
  const breaker = getProfile(profileId).rules.circuitBreaker
  if (ytdReturn <= breaker.liquidateSatellite) {
    return { state: 'liquidate', message: `全年收益 ${(ytdReturn * 100).toFixed(1)}%，触发清仓卫星策略，只保留核心 ETF + 现金` }
  }
  if (ytdReturn <= breaker.pause) {
    return { state: 'pause', message: `全年收益 ${(ytdReturn * 100).toFixed(1)}%，暂停主动交易 1 个月并复盘` }
  }
  return { state: 'normal', message: `全年收益 ${(ytdReturn * 100).toFixed(1)}%，未触发熔断` }
}

/**
 * 网格计划：把「价格区间 10%、10 格」展开成每格价位与每格资金，并算出扣费后的单格利润。
 * 区间给 low/high 时按该区间；否则按当前价 ±spread/2 生成。
 */
export function gridPlan({ low, high, count = GRID_DEFAULTS.count, capital = 0, feeRate = GRID_DEFAULTS.feeRate, last } = {}) {
  const price = Number(last) > 0 ? Number(last) : null
  const lower = Number(low) > 0 ? Number(low) : price ? price * (1 - GRID_DEFAULTS.spread / 2) : 0
  const upper = Number(high) > 0 ? Number(high) : price ? price * (1 + GRID_DEFAULTS.spread / 2) : 0
  if (!(lower > 0 && upper > lower)) throw new Error('网格区间无效：需要 low < high 且均为正数')

  const steps = Math.max(1, Math.round(Number(count) || GRID_DEFAULTS.count))
  const stepPrice = (upper - lower) / steps
  const perLevel = Math.max(0, Number(capital) || 0) / (steps + 1)
  const levels = Array.from({ length: steps + 1 }, (_, index) => ({
    index,
    price: round(lower + stepPrice * index, 3),
    amount: Math.round(perLevel),
  }))
  const gainPct = upper > 0 ? stepPrice / lower : 0
  const feePct = feeRate * 2
  return {
    lower: round(lower, 3),
    upper: round(upper, 3),
    steps,
    stepPrice: round(stepPrice, 3),
    stepPct: round((stepPrice / lower) * 100, 2),
    perLevel: Math.round(perLevel),
    levels,
    roundTrip: {
      gainPct: round(gainPct * 100, 2),
      feePct: round(feePct * 100, 3),
      netPct: round((gainPct - feePct) * 100, 2),
      /** 单格利润（按每格资金算） */
      netAmount: Math.round(perLevel * (gainPct - feePct)),
    },
    note: `区间 ${round(lower, 3)}–${round(upper, 3)}，${steps} 格，单格 ${round((stepPrice / lower) * 100, 2)}%；扣双向佣金后单格净收益 ${round((gainPct - feePct) * 100, 2)}%`,
  }
}

/**
 * 可转债双低筛选（vectra 口径：转股溢价率 < 20% 且纯债到期收益率 > 2%）。
 * bonds: [{ code, name, price, premiumRate（%）, ytm（%）, rating }]
 * 双低值 = 价格 + 转股溢价率，越小越好。
 */
export function dualLowScreen(bonds = [], { premiumMax = 20, ytmMin = 2, limit = 20 } = {}) {
  const rows = bonds
    .map((bond) => {
      const price = Number(bond.price)
      const premium = Number(bond.premiumRate)
      const ytm = Number(bond.ytm)
      return { ...bond, price, premiumRate: premium, ytm, dualLowValue: round(price + premium, 2) }
    })
    .filter((bond) => Number.isFinite(bond.price) && Number.isFinite(bond.premiumRate) && Number.isFinite(bond.ytm))
    .filter((bond) => bond.premiumRate < premiumMax && bond.ytm > ytmMin)
    .sort((a, b) => a.dualLowValue - b.dualLowValue)
  return {
    total: rows.length,
    thresholds: { premiumMax, ytmMin },
    rows: rows.slice(0, Math.max(1, limit)).map((bond) => ({
      code: bond.code,
      name: bond.name,
      price: bond.price,
      premiumRate: bond.premiumRate,
      ytm: bond.ytm,
      dualLowValue: bond.dualLowValue,
      rating: bond.rating || '',
    })),
  }
}

/**
 * 行业轮动打分（vectra 口径：动量 3/6 月 + 基本面/估值）。
 * 各项先做截面排名（0-100，越大越好），再按 0.5 / 0.3 / 0.2 加权。
 * rows: [{ name, momentum3m（%）, momentum6m（%）, valuationPercentile（0-100，越低越便宜） }]
 */
export function rotationScore(rows = [], weights = { momentum3m: 0.5, momentum6m: 0.3, valuation: 0.2 }) {
  const items = rows.filter((row) => row && row.name)
  if (items.length === 0) return { rows: [] }
  const rank = (values, predict) => {
    const sorted = [...values].sort((a, b) => a - b)
    return (value) => (sorted.length === 1 ? 100 : (sorted.indexOf(value) / (sorted.length - 1)) * 100)
  }
  const m3 = items.map((item) => Number(item.momentum3m) || 0)
  const m6 = items.map((item) => Number(item.momentum6m) || 0)
  const val = items.map((item) => (Number.isFinite(Number(item.valuationPercentile)) ? Number(item.valuationPercentile) : 50))
  const rank3 = rank(m3)
  const rank6 = rank(m6)
  const rankVal = rank(val)
  const scored = items.map((item, index) => {
    const s3 = rank3(m3[index])
    const s6 = rank6(m6[index])
    /** 估值分位越低越便宜，故取反。 */
    const sv = 100 - rankVal(val[index])
    const score = s3 * weights.momentum3m + s6 * weights.momentum6m + sv * weights.valuation
    return {
      name: item.name,
      momentum3m: round(m3[index], 2),
      momentum6m: round(m6[index], 2),
      valuationPercentile: round(val[index], 1),
      score: round(score, 1),
      parts: { momentum3m: round(s3, 1), momentum6m: round(s6, 1), valuation: round(sv, 1) },
    }
  })
  return {
    weights,
    rows: scored.sort((a, b) => b.score - a.score),
  }
}

/**
 * 收益归因：各模块按权重 × 目标收益合并，输出贡献与合计（文档里那张表的算法化）。
 * modules: [{ name, weight, expectedReturn }]
 */
export function attribution(modules = []) {
  const rows = modules.map((item) => ({
    name: item.name,
    weight: Number(item.weight) || 0,
    expectedReturn: Number(item.expectedReturn) || 0,
    contribution: round((Number(item.weight) || 0) * (Number(item.expectedReturn) || 0) * 100, 2),
  }))
  const total = round(rows.reduce((sum, row) => sum + row.contribution, 0), 2)
  return { rows, total }
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round((Number(value) || 0) * factor) / factor
}

export default {
  PROFILES,
  GRID_DEFAULTS,
  getProfile,
  allocationTable,
  riskCheck,
  stopLossAction,
  circuitBreaker,
  gridPlan,
  dualLowScreen,
  rotationScore,
  attribution,
}
