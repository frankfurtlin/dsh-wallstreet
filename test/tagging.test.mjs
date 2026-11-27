/**
 * lib/hub/tagging.js —— 规则打标单测
 *
 * 全部用手工构造的词典（`{ names: Map, sectors: [], watchlist: Set, hot: Set }`），
 * 不读真实快照文件：打标规则必须能在没有数据的环境里被单独验证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { tagItem, mergeTags, EVENT_RULES, SECTOR_ALIASES } from '../lib/hub/tagging.js'

/** 造一条待打标条目。 */
const item = (over = {}) => ({
  title: '',
  summary: '',
  kind: 'flash',
  tickers: [],
  sectors: [],
  eventType: '',
  importance: 0,
  degraded: false,
  ...over,
})

/** 造一份空词典。 */
const dict = (over = {}) => ({ names: new Map(), sectors: [], watchlist: new Set(), hot: new Set(), ...over })

const typeOf = (title, kind = 'flash', extra = {}) => tagItem(item({ title, kind }), null).eventType

/* ------------------------------ 事件类型命中顺序 ------------------------------ */

test('事件类型：多规则同时命中时取规则表靠前的（立案 先于 降准）', () => {
  const tagged = tagItem(item({ title: '某公司被立案调查，央行同日降准' }), null)
  assert.equal(tagged.eventType, '风险事件')
  // 风险事件权重 22 → 22*0.9 四舍五入 20
  assert.equal(tagged.importanceParts.type, 20)
})

test('事件类型：货币政策 / 宏观数据 / 政策法规', () => {
  assert.equal(typeOf('央行开展MLF操作'), '货币政策')
  assert.equal(typeOf('今日公布CPI与PPI数据'), '宏观数据')
  assert.equal(typeOf('国务院常务会议部署稳增长'), '政策法规')
})

test('事件类型：重组并购 / 业绩 / 中标合同', () => {
  assert.equal(typeOf('公司拟收购某标的资产'), '重组并购')
  assert.equal(typeOf('发布业绩预告：预增50%'), '业绩')
  assert.equal(typeOf('中标10亿元大单'), '中标合同')
})

test('事件类型：停复牌 / 融资 / 减持增持 / 分红送转', () => {
  assert.equal(typeOf('明日起停牌核查'), '停复牌')
  assert.equal(typeOf('推出定增预案'), '融资')
  assert.equal(typeOf('股东拟减持不超过2%'), '减持增持')
  assert.equal(typeOf('年度利润分配预案：每10股派10元'), '分红送转')
})

test('事件类型：涨价提价 / 海外市场', () => {
  assert.equal(typeOf('光伏组件价格上调'), '涨价提价')
  assert.equal(typeOf('美联储议息会议维持利率不变'), '海外市场')
})

test('事件类型：没有命中任何规则时为空串，且 type 分量为 0', () => {
  const tagged = tagItem(item({ title: '今天天气不错' }), null)
  assert.equal(tagged.eventType, '')
  assert.equal(tagged.importanceParts.type, 0)
})

test('EVENT_RULES：每条规则的 type/weight/words 都合法，顺序即优先级', () => {
  assert.ok(Array.isArray(EVENT_RULES) && EVENT_RULES.length >= 10)
  for (const rule of EVENT_RULES) {
    assert.equal(typeof rule.type, 'string')
    assert.ok(rule.type.length > 0)
    assert.ok(Number.isFinite(rule.weight) && rule.weight > 0, `${rule.type} 的权重应 > 0`)
    assert.ok(Array.isArray(rule.words) && rule.words.length > 0, `${rule.type} 应有词表`)
  }
  const types = EVENT_RULES.map((rule) => rule.type)
  assert.equal(types[0], '风险事件', '风险事件应排第一（最该被看见）')
  assert.ok(types.includes('货币政策'))
  assert.ok(types.includes('业绩'))
})

/* ------------------------------ importanceParts 分量 ------------------------------ */

test('importanceParts：九个分量齐全，无标签的普通快讯就是 kind 基准分 24', () => {
  const tagged = tagItem(item({ title: '今天天气不错', kind: 'flash' }), null)
  assert.deepEqual(tagged.importanceParts, {
    kind: 24,
    type: 0,
    ticker: 0,
    multi: 0,
    watch: 0,
    hot: 0,
    market: 0,
    demote: 0,
    degraded: 0,
  })
  assert.equal(tagged.importance, 24)
})

test('importanceParts.kind：flash 24 / announcement 40 / report 30 / policy 52 / 未知 22', () => {
  const base = (kind) => tagItem(item({ title: '今天天气不错', kind }), null).importanceParts.kind
  assert.equal(base('flash'), 24)
  assert.equal(base('announcement'), 40)
  assert.equal(base('report'), 30)
  assert.equal(base('policy'), 52)
  assert.equal(base('unknown-kind'), 22)
})

test('importanceParts.type：权重乘 0.9 后四舍五入', () => {
  assert.equal(tagItem(item({ title: '业绩预增' }), null).importanceParts.type, 11) // 12*0.9=10.8
  assert.equal(tagItem(item({ title: '公司停牌' }), null).importanceParts.type, 13) // 14*0.9=12.6
  assert.equal(tagItem(item({ title: 'CPI 公布' }), null).importanceParts.type, 14) // 16*0.9=14.4
})

test('重要度：标题里的 6 位代码进 tickers，并加 ticker 分量 8', () => {
  const tagged = tagItem(item({ title: '600519 发布三季报', tickers: [] }), null)
  assert.deepEqual(tagged.tickers, ['600519'])
  assert.equal(tagged.importanceParts.ticker, 8)
  assert.equal(tagged.importance, 24 + 11 + 8) // 24 + 业绩 11 + ticker 8
})

test('重要度：已有 tickers 与标题里的代码合并去重', () => {
  const tagged = tagItem(item({ title: '600519 与 000001 对比', tickers: ['600519'] }), null)
  assert.deepEqual(tagged.tickers, ['600519', '000001'])
})

test('重要度：7 位数字不会被误抽成股票代码', () => {
  const tagged = tagItem(item({ title: '成交额 1600519 万元' }), null)
  assert.deepEqual(tagged.tickers, [])
})

test('重要度：词典里的股票名命中（名字不足 2 字忽略）', () => {
  const d = dict({ names: new Map([['紫金矿业', '601899'], ['茅台', '600519'], ['甲', '000001']]) })
  const tagged = tagItem(item({ title: '紫金矿业与茅台同日公告，甲不在其中' }), d)
  assert.deepEqual(tagged.tickers, ['601899', '600519'])
  assert.equal(tagged.importanceParts.ticker, 8)
  assert.equal(tagged.importanceParts.multi, 5) // 两个标的 → 多标的加权
})

test('重要度：tickers 最多保留 8 个', () => {
  const codes = ['600000', '600001', '600002', '600003', '600004', '600005', '600006', '600007', '600008', '600009']
  const tagged = tagItem(item({ title: '批量公告', tickers: codes }), null)
  assert.equal(tagged.tickers.length, 8)
  assert.deepEqual(tagged.tickers, codes.slice(0, 8))
})

test('重要度：持仓股 watch 分量 +8', () => {
  const d = dict({ watchlist: new Set(['601899']) })
  const tagged = tagItem(item({ title: '紫金矿业收到立案告知书', tickers: ['601899'] }), d)
  assert.equal(tagged.importanceParts.watch, 8)
  // 24(flash) + 20(风险) + 8(ticker) + 8(watch) + 5(market: 立案) = 65
  assert.equal(tagged.importance, 65)
})

test('重要度：热门股 hot 分量 +6，且市场词 market +5', () => {
  const d = dict({ hot: new Set(['600519']) })
  const tagged = tagItem(item({ title: '600519 业绩预告超预期', tickers: ['600519'] }), d)
  assert.equal(tagged.importanceParts.hot, 6)
  assert.equal(tagged.importanceParts.market, 0) // '超预期' 不在市场词表里
  assert.equal(tagged.importance, 24 + 11 + 8 + 6)
})

test('重要度：degraded 条目扣 4 分', () => {
  const normal = tagItem(item({ title: '今天天气不错' }), null)
  const degraded = tagItem(item({ title: '今天天气不错', degraded: true }), null)
  assert.equal(degraded.importanceParts.degraded, -4)
  assert.equal(degraded.importance, normal.importance - 4)
})

/* ------------------------------ 封顶与夹紧 ------------------------------ */

test('重要度：政务流水账 demote -26，总分封顶 42（不丢条目）', () => {
  const tagged = tagItem(item({ title: '国务院办公厅关于2027年部分节假日安排的通知', kind: 'policy' }), null)
  assert.equal(tagged.eventType, '政策法规')
  assert.equal(tagged.importanceParts.demote, -26)
  assert.equal(tagged.importance, 42)
  assert.ok(tagged.title.includes('节假日'), '降权只是压分，不改内容')
})

test('重要度：政策没有市场含义词时封顶 58', () => {
  const tagged = tagItem(item({ title: '国务院关于修改部分行政法规的决定', kind: 'policy' }), null)
  assert.equal(tagged.importanceParts.market, 0)
  assert.equal(tagged.importance, 58) // 52 + 16 会被压到 58
})

test('重要度：政策带市场词时不封顶', () => {
  const tagged = tagItem(item({ title: '央行宣布降准0.5个百分点', kind: 'policy' }), null)
  assert.equal(tagged.eventType, '货币政策')
  assert.equal(tagged.importance, 75) // 52 + 18 + 5
})

test('重要度：最终值夹在 0–100（102 分压到 100）', () => {
  const d = dict({
    names: new Map([['紫金矿业', '601899'], ['贵州茅台', '600519']]),
    watchlist: new Set(['601899']),
    hot: new Set(['600519']),
  })
  const tagged = tagItem(item({ title: '央行降准 紫金矿业 贵州茅台 双双涨停', kind: 'policy' }), d)
  assert.equal(tagged.eventType, '货币政策')
  assert.equal(tagged.tickers.length, 2)
  // 52 + 18 + 8 + 5 + 8 + 6 + 5 = 102 → 100
  assert.equal(tagged.importance, 100)
})

test('重要度：负分不会漏出负数（夹到 0）', () => {
  const tagged = tagItem(item({ title: '关于节假日安排的政策座谈会纪要', kind: 'unknown-kind', degraded: true }), null)
  // 22(kind) + 16(政策法规) - 26(demote) - 4(degraded) = 8
  assert.equal(tagged.importance, 8)
  assert.ok(tagged.importance >= 0)
})

/* ------------------------------ 板块 ------------------------------ */

test('板块：词典行业名命中（不足 2 字忽略）', () => {
  const d = dict({ sectors: ['半导体设备', '甲'] })
  const tagged = tagItem(item({ title: '半导体设备订单回暖，甲板块走强' }), d)
  assert.ok(tagged.sectors.includes('半导体设备'))
  assert.ok(!tagged.sectors.includes('甲'), '单字行业名不参与匹配')
})

test('板块：SECTOR_ALIASES 里的新闻用语也能命中', () => {
  const tagged = tagItem(item({ title: '芯片短缺与储能装机超预期' }), null)
  assert.ok(tagged.sectors.includes('芯片'))
  assert.ok(tagged.sectors.includes('储能'))
})

test('板块：最多保留 4 个', () => {
  const d = dict({ sectors: ['有色金属', '半导体', '光伏'] })
  const tagged = tagItem(item({ title: '有色金属、半导体、光伏、煤炭、钢铁、白酒齐涨' }), d)
  assert.equal(tagged.sectors.length, 4)
})

test('SECTOR_ALIASES：包含跨源常见别名', () => {
  for (const alias of ['半导体', '芯片', '光伏', '锂电', '券商', '白酒', '军工', '医药']) {
    assert.ok(SECTOR_ALIASES.includes(alias), `别名表应含 ${alias}`)
  }
})

/* ------------------------------ 不可变性与入参容错 ------------------------------ */

test('tagItem：返回新对象，不改动传入的 item', () => {
  const source = item({ title: '600519 业绩预告' })
  const tagged = tagItem(source, null)
  assert.notEqual(tagged, source)
  assert.deepEqual(source.tickers, [])
  assert.equal(source.importance, 0)
  assert.equal(source.eventType, '')
  assert.deepEqual(tagged.tickers, ['600519'])
})

test('tagItem：tickers/sectors 不是数组时按空处理，不抛错', () => {
  const tagged = tagItem({ title: '今天天气不错', summary: '', kind: 'flash', tickers: 'x', sectors: 'y' }, null)
  assert.deepEqual(tagged.tickers, [])
  assert.deepEqual(tagged.sectors, [])
})

/* ------------------------------ mergeTags ------------------------------ */

test('mergeTags：空数组得到空结果', () => {
  const merged = mergeTags([])
  assert.deepEqual(merged, {
    eventType: '',
    tickers: [],
    sectors: [],
    importance: 0,
    importanceParts: { sources: 0, diffusion: 0 },
  })
})

test('mergeTags：重要度取最大，两个源扩散 +4', () => {
  const merged = mergeTags([
    { id: 'a', source: 'src-a', importance: 40, eventType: '业绩', tickers: ['600519'], sectors: ['白酒'] },
    { id: 'b', source: 'src-b', importance: 70, eventType: '业绩', tickers: ['000001'], sectors: ['银行'] },
  ])
  assert.equal(merged.importance, 74) // 70 + (2-1)*4
  assert.equal(merged.importanceParts.sources, 2)
  assert.equal(merged.importanceParts.diffusion, 4)
  assert.deepEqual(merged.tickers, ['600519', '000001'])
  assert.deepEqual(merged.sectors, ['白酒', '银行'])
})

test('mergeTags：扩散度随源数增加，但上限 10', () => {
  const event = (source, importance) => ({ source, importance, eventType: '', tickers: [], sectors: [] })
  assert.equal(mergeTags([event('a', 50)]).importanceParts.diffusion, 0)
  assert.equal(mergeTags([event('a', 50), event('b', 50), event('c', 50)]).importance, 58) // +8
  assert.equal(mergeTags([event('a', 50), event('b', 50), event('c', 50), event('d', 50)]).importance, 60) // +10 封顶
  assert.equal(
    mergeTags([event('a', 50), event('b', 50), event('c', 50), event('d', 50), event('e', 50)]).importanceParts.diffusion,
    10,
  )
})

test('mergeTags：叠加扩散度后仍不超过 100', () => {
  const merged = mergeTags([
    { source: 'a', importance: 95 },
    { source: 'b', importance: 80 },
    { source: 'c', importance: 60 },
  ])
  assert.equal(merged.importance, 100)
})

test('mergeTags：事件类型取最高频', () => {
  const merged = mergeTags([
    { source: 'a', importance: 10, eventType: '业绩' },
    { source: 'b', importance: 10, eventType: '业绩' },
    { source: 'c', importance: 10, eventType: '风险事件' },
  ])
  assert.equal(merged.eventType, '业绩')
})

test('mergeTags：平票时取权重更高的事件类型', () => {
  const merged = mergeTags([
    { source: 'a', importance: 10, eventType: '业绩' }, // weight 12
    { source: 'b', importance: 10, eventType: '风险事件' }, // weight 22
  ])
  assert.equal(merged.eventType, '风险事件')
})

test('mergeTags：没有任何事件类型时返回空串', () => {
  assert.equal(mergeTags([{ source: 'a', importance: 10, eventType: '' }]).eventType, '')
})

test('mergeTags：tickers 最多 8 个、sectors 最多 4 个', () => {
  const merged = mergeTags([
    { source: 'a', importance: 10, tickers: ['600000', '600001', '600002', '600003', '600004'], sectors: ['一板', '二板', '三板'] },
    { source: 'b', importance: 10, tickers: ['600005', '600006', '600007', '600008'], sectors: ['四板', '五板'] },
  ])
  assert.equal(merged.tickers.length, 8)
  assert.equal(merged.sectors.length, 4)
})

test('mergeTags：importanceParts 逐键取最大，并补 sources/diffusion', () => {
  const merged = mergeTags([
    { source: 'a', importance: 30, importanceParts: { kind: 24, type: 18, ticker: 0, demote: -26 } },
    { source: 'b', importance: 20, importanceParts: { kind: 52, type: 0, ticker: 8, demote: 0 } },
  ])
  assert.deepEqual(merged.importanceParts, {
    kind: 52,
    type: 18,
    ticker: 8,
    demote: 0,
    sources: 2,
    diffusion: 4,
  })
})

test('mergeTags：条目没有 importanceParts / 缺来源/非法分数时不抛错', () => {
  const merged = mergeTags([{ importance: 12 }, { source: '', importance: 'x' }, { eventType: '业绩' }])
  assert.equal(merged.importance, 12)
  assert.equal(merged.eventType, '业绩')
  assert.deepEqual(merged.importanceParts, { sources: 0, diffusion: 0 })
})
