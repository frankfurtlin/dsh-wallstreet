/**
 * 盘面 AI 问答的纯函数测试：上下文压缩与入参裁剪。
 *
 * 这里不打模型、不读网络：模型调用（askMarket）需要宿主 ctx.llm，属于端到端验证，
 * 由 verification/verify-ask.mjs 覆盖；本文件只保证「发进提示词的内容」和
 * 「允许发进来的参数」这两件事的形状稳定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMarketContext, normalizeAskInput, SYSTEM_PROMPT, MAX_QUESTION } from '../lib/ask.js'

function sampleOverview() {
  return {
    ok: true,
    dataMode: 'live',
    marketDate: '2026-11-27',
    dataTime: '13:29',
    stale: true,
    trading: { date: '2026-11-27', time: '13:29', session: 'trading' },
    indices: [
      { name: '上证指数', price: 3569.8, changePct: 2.67 },
      { name: '创业板指', price: 2384.7, changePct: 8.9 },
    ],
    breadth: { up: 5118, down: 246, flat: 20, total: 5384, limitUp: 202, limitDown: 0, upRatio: 0.951 },
    turnover: { total: 1.31087455e12, progress: 0.61, projectedTotal: 2.14897467e12, ratio5d: 1.456 },
    analysis: {
      temperature: 86,
      label: { text: '过热' },
      scores: { breadth: 95, limit: 100, volume: 100, momentum: 50 },
      signals: ['上涨 5118 家 / 下跌 246 家，上涨占比 95.1%', '涨停 202 家 / 跌停 0 家'],
    },
    sectors: {
      gainers: [{ name: '半导体设备', changePct: 16.72, mainInflow: 2.766e9 }],
      losers: [{ name: '银行', changePct: -1.17, mainInflow: -2.086e9 }],
    },
    kline: { ma5: 3522.09, ma10: 3549.69, ma20: 3603.18, ma60: 3755.25, recent: [{ close: 3569.8, ma5: 3522.09, ma10: 3549.69, ma20: 3603.18, ma60: 3755.25 }] },
    warnings: [],
  }
}

test('buildMarketContext：带上指数、宽度、成交、温度、板块、均线与数据时间', () => {
  const { text, dataAt, stale } = buildMarketContext(sampleOverview())
  assert.equal(dataAt, '2026-11-27 13:29')
  assert.equal(stale, true)
  assert.match(text, /上证指数 3569\.80（\+2\.67%）/)
  assert.match(text, /创业板指 2384\.70（\+8\.90%）/)
  assert.match(text, /上涨 5118 家、下跌 246 家/)
  assert.match(text, /涨停 202、跌停 0/)
  assert.match(text, /两市成交 13108\.7 亿元/)
  assert.match(text, /市场温度：86 「过热」/)
  assert.match(text, /半导体设备 \+16\.72%/)
  assert.match(text, /银行 -1\.17%/)
  assert.match(text, /MA20 3603\.18/)
  assert.match(text, /站上 MA5\/MA10/)
  assert.match(text, /低于 MA20\/MA60/)
})

test('buildMarketContext：快照模式与空数据都能给出人话', () => {
  const snapshot = buildMarketContext({
    dataMode: 'snapshot',
    marketDate: '2026-11-26',
    dataTime: '15:10',
    stale: false,
    trading: { date: '2026-11-27', time: '10:00' },
    indices: [{ name: '上证指数', price: 3476.88, changePct: 0.01 }],
    breadth: { up: 1766, down: 3641, flat: 173, total: 5580, limitUp: 88, limitDown: 21 },
  })
  assert.match(snapshot.text, /收盘快照/)
  assert.match(snapshot.text, /2026-11-26 15:10/)
  assert.equal(snapshot.stale, false)

  const empty = buildMarketContext(null)
  assert.match(empty.text, /盘面数据暂不可用/)
  assert.equal(empty.stale, true)
})

test('buildMarketContext：不把整页 JSON 塞进去（体积有上限）', () => {
  const overview = sampleOverview()
  overview.trend = { sh: { points: Array.from({ length: 240 }, (_, i) => ({ time: '09:30', price: i })) } }
  const { text } = buildMarketContext(overview)
  assert.ok(text.length < 2400, `上下文 ${text.length} 字，超过预算`)
})

test('normalizeAskInput：空问题/超长问题直接拒绝', () => {
  assert.equal(normalizeAskInput(null), null)
  assert.equal(normalizeAskInput({}), null)
  assert.equal(normalizeAskInput({ question: '   ' }), null)
  assert.equal(normalizeAskInput({ question: 'x'.repeat(MAX_QUESTION + 1) }), null)
})

test('normalizeAskInput：历史最多 8 条、单条截断、去掉开头 assistant', () => {
  const history = [{ role: 'assistant', content: '开场白' }]
  for (let index = 0; index < 20; index += 1) {
    history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: `第 ${index} 条` })
  }
  const input = normalizeAskInput({ question: '今天为什么涨？', history })
  assert.equal(input.question, '今天为什么涨？')
  assert.ok(input.history.length <= 8)
  assert.equal(input.history[0].role, 'user')
  assert.ok(input.history.every((item) => item.content && item.content.length <= 3000))
})

test('SYSTEM_PROMPT：约束了「不编数据」和「不构成投资建议」', () => {
  assert.match(SYSTEM_PROMPT, /不要编/)
  assert.match(SYSTEM_PROMPT, /不构成投资建议/)
})
