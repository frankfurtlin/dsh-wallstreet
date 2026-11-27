/**
 * lib/hub/ingest.js —— 不碰数据库的纯函数单测
 *
 * 覆盖时段判定、到期判定与聚簇判定。`runIngest` 那条端到端链路留给
 * verification/verify-hub.mjs（需要 SQLite + 假源），这里只测能独立成立的部分。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { phaseNow, phaseFactor, dueSources, findCluster } from '../lib/hub/ingest.js'

const SHANGHAI = 8 * 60 * 60 * 1000
/** 北京时间 → epoch ms。 */
const bj = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - SHANGHAI
const MINUTE = 60_000

/* ------------------------------ phaseNow ------------------------------ */

test('phaseNow：开盘前 09:14 是 offhours', () => {
  assert.equal(phaseNow(bj(2026, 11, 25, 9, 14)), 'offhours')
})

test('phaseNow：09:15 开盘瞬间进入 trading（边界取等号）', () => {
  assert.equal(phaseNow(bj(2026, 11, 25, 9, 15)), 'trading')
  assert.equal(phaseNow(bj(2026, 11, 25, 9, 16)), 'trading')
})

test('phaseNow：11:30 收盘 still trading，11:31 回到 offhours', () => {
  assert.equal(phaseNow(bj(2026, 11, 25, 11, 30)), 'trading')
  assert.equal(phaseNow(bj(2026, 11, 25, 11, 31)), 'offhours')
})

test('phaseNow：午休 12:00 是 offhours', () => {
  assert.equal(phaseNow(bj(2026, 11, 25, 12, 0)), 'offhours')
  assert.equal(phaseNow(bj(2026, 11, 25, 12, 59)), 'offhours')
})

test('phaseNow：13:00–15:00 是 trading，15:01 之后是 offhours', () => {
  assert.equal(phaseNow(bj(2026, 11, 25, 13, 0)), 'trading')
  assert.equal(phaseNow(bj(2026, 11, 25, 15, 0)), 'trading')
  assert.equal(phaseNow(bj(2026, 11, 25, 15, 1)), 'offhours')
  assert.equal(phaseNow(bj(2026, 11, 25, 20, 30)), 'offhours')
})

test('phaseNow：周六/周日一律 weekend（就算时间落在交易时段）', () => {
  assert.equal(phaseNow(bj(2026, 11, 28, 10, 0)), 'weekend') // 周六
  assert.equal(phaseNow(bj(2026, 11, 29, 10, 0)), 'weekend') // 周日
})

test('phaseNow：按北京时间分档，不是按 UTC（UTC 01:16 = 北京 09:16）', () => {
  assert.equal(phaseNow(Date.UTC(2026, 10, 25, 1, 16)), 'trading')
  // 同一时刻的 UTC 小时数是 01:16，若按 UTC 判会落成 offhours
  assert.equal(new Date(Date.UTC(2026, 10, 25, 1, 16)).getUTCHours(), 1)
})

test('phaseNow：不传 now 时用当前时间，只允许三种取值之一', () => {
  const phase = phaseNow()
  assert.ok(['trading', 'offhours', 'weekend'].includes(phase))
})

/* ------------------------------ phaseFactor ------------------------------ */

test('phaseFactor：盘中 1 倍、盘后 4 倍、周末 8 倍', () => {
  assert.equal(phaseFactor('trading'), 1)
  assert.equal(phaseFactor('offhours'), 4)
  assert.equal(phaseFactor('weekend'), 8)
})

test('phaseFactor：未知/空时段按 4 倍处理（保守，少打上游）', () => {
  assert.equal(phaseFactor(''), 4)
  assert.equal(phaseFactor(undefined), 4)
  assert.equal(phaseFactor('不知道'), 4)
})

/* ------------------------------ dueSources ------------------------------ */

const source = (over = {}) => ({ id: 'src', label: '源', intervalMs: MINUTE, enabled: true, ...over })

test('dueSources：间隔已到就抓（边界取等号）', () => {
  const list = [source()]
  assert.deepEqual(dueSources(list, 1, MINUTE, false).map((s) => s.id), ['src'])
  assert.deepEqual(dueSources(list, 1, MINUTE - 1, false), [])
})

test('dueSources：间隔小于 60 秒时按 60 秒抬升', () => {
  const list = [source({ intervalMs: 1_000 })]
  assert.deepEqual(dueSources(list, 1, MINUTE - 1, false), [])
  assert.deepEqual(dueSources(list, 1, MINUTE, false).map((s) => s.id), ['src'])
})

test('dueSources：没配间隔时默认 180 秒', () => {
  const list = [source({ intervalMs: undefined })]
  assert.deepEqual(dueSources(list, 1, 3 * MINUTE - 1, false), [])
  assert.deepEqual(dueSources(list, 1, 3 * MINUTE, false).map((s) => s.id), ['src'])
})

test('dueSources：盘后倍率 4、周末倍率 8 会把间隔拉长', () => {
  const list = [source()]
  assert.deepEqual(dueSources(list, 4, 4 * MINUTE - 1, false), [])
  assert.deepEqual(dueSources(list, 4, 4 * MINUTE, false).map((s) => s.id), ['src'])
  assert.deepEqual(dueSources(list, 8, 8 * MINUTE - 1, false), [])
  assert.deepEqual(dueSources(list, 8, 8 * MINUTE, false).map((s) => s.id), ['src'])
})

test('dueSources：force=true 时不看间隔，全部返回', () => {
  const list = [source({ id: 'a' }), source({ id: 'b' })]
  assert.deepEqual(dueSources(list, 8, 0, true).map((s) => s.id), ['a', 'b'])
})

test('dueSources：disabled 的源即使 force 也不抓', () => {
  const list = [source({ id: 'off', enabled: false }), source({ id: 'on' })]
  assert.deepEqual(dueSources(list, 1, 10 * MINUTE, true).map((s) => s.id), ['on'])
  assert.deepEqual(dueSources(list, 1, 10 * MINUTE, false).map((s) => s.id), ['on'])
})

test('dueSources：没有 id 或条目为 null 时跳过，不抛错', () => {
  const list = [source({ id: '' }), source({ id: undefined }), null, source({ id: 'ok' })]
  assert.deepEqual(dueSources(list, 1, 10 * MINUTE, false).map((s) => s.id), ['ok'])
})

test('dueSources：空清单返回空数组，且保留原对象引用', () => {
  assert.deepEqual(dueSources([], 1, 10 * MINUTE, false), [])
  const one = source()
  assert.equal(dueSources([one], 1, MINUTE, false)[0], one)
})

/* ------------------------------ findCluster ------------------------------ */

const item = (over = {}) => ({
  kind: 'flash',
  ts: bj(2026, 11, 25, 10, 0),
  title: '',
  summary: '',
  tickers: [],
  sectors: [],
  eventType: '',
  ...over,
})

const event = (over = {}) => ({
  id: 'ev-1',
  kind: 'flash',
  lastTs: bj(2026, 11, 25, 10, 0),
  title: '',
  summary: '',
  tickers: [],
  sectors: [],
  eventType: '',
  ...over,
})

const MLF_TITLE_A = '央行开展1万亿元MLF操作，保持流动性'
const MLF_TITLE_B = '央行开展1万亿元MLF操作 保持流动性合理充裕'
const DIGEST =
  '国家发展改革委等部门联合印发通知，明确加快推进集成电路产业链自主可控，支持先进封装与设备材料国产化。'

test('findCluster：空事件池返回 null', () => {
  assert.equal(findCluster(item({ title: MLF_TITLE_A }), []), null)
})

test('findCluster：共享个股 + 相似标题 → 合并', () => {
  const target = event({ id: 'ev-mlf', title: MLF_TITLE_B, tickers: ['600519'] })
  const hit = findCluster(item({ title: MLF_TITLE_A, tickers: ['600519'] }), [target])
  assert.equal(hit, target)
})

test('findCluster：不共享个股但标题高度相似（>=0.5）也合并', () => {
  const target = event({ id: 'ev-mlf', title: MLF_TITLE_B, tickers: ['000001'] })
  const hit = findCluster(item({ title: MLF_TITLE_A, tickers: ['600519'] }), [target])
  assert.equal(hit, target)
})

test('findCluster：同票但标题完全不同（flash，相似度 <0.42）不合并', () => {
  const target = event({ id: 'ev-a', title: '公司收到立案告知书', tickers: ['601600'] })
  const hit = findCluster(item({ title: '公司发布中标公告', tickers: ['601600'] }), [target])
  assert.equal(hit, null)
})

test('findCluster：公告类要求更高相似度（0.69 不合并，与快讯不同）', () => {
  const ann = { kind: 'announcement', title: '紫金矿业关于高管辞职的公告', tickers: ['601899'] }
  const itemAnn = item({ kind: 'announcement', title: '紫金矿业关于控股股东减持股份的公告', tickers: ['601899'] })
  assert.equal(findCluster(itemAnn, [event({ id: 'ev-ann', ...ann })]), null)
  // 同一对标题放到快讯档就会合并（共享票 + >=0.42）
  const itemFlash = item({ kind: 'flash', title: '紫金矿业关于控股股东减持股份的公告', tickers: ['601899'] })
  const flashEvent = event({ id: 'ev-flash', ...ann, kind: 'flash' })
  assert.equal(findCluster(itemFlash, [flashEvent]), flashEvent)
})

test('findCluster：公告标题逐字相同 → 合并', () => {
  const title = '紫金矿业关于收购铜矿项目的公告'
  const target = event({ id: 'ev-same', kind: 'announcement', title })
  assert.equal(findCluster(item({ kind: 'announcement', title }), [target]), target)
})

test('findCluster：公告类「同票不同事件」不因共享个股而合并', () => {
  const target = event({ id: 'ev-ann', kind: 'announcement', title: '紫金矿业关于股东减持的公告', tickers: ['601899'] })
  const hit = findCluster(
    item({ kind: 'announcement', title: '紫金矿业关于高管辞职的公告', tickers: ['601899'] }),
    [target],
  )
  assert.equal(hit, null)
})

test('findCluster：事件类型不同时要求 >=0.7 的字面重合（0.636 不合并）', () => {
  const target = event({
    id: 'ev-cross',
    title: '紫金矿业拟新建铜矿产能',
    tickers: ['601899'],
    eventType: '风险事件',
  })
  const base = { title: '紫金矿业拟收购铜矿项目', tickers: ['601899'] }
  assert.equal(findCluster(item({ ...base, eventType: '重组并购' }), [target]), null)
  // 同事件类型时同样的标题就会合并
  const same = event({ ...target, eventType: '重组并购' })
  assert.equal(findCluster(item({ ...base, eventType: '重组并购' }), [same]), same)
})

test('findCluster：恰好 90 分钟内合并，超出 1ms 就不合并', () => {
  const t = bj(2026, 11, 25, 10, 0)
  const target = (lastTs) => event({ id: 'ev-w', title: MLF_TITLE_B, lastTs })
  assert.equal(findCluster(item({ title: MLF_TITLE_A, ts: t }), [target(t - 90 * MINUTE)]).id, 'ev-w')
  assert.equal(findCluster(item({ title: MLF_TITLE_A, ts: t }), [target(t - 90 * MINUTE - 1)]), null)
})

test('findCluster：kind 不同的候选直接跳过（快讯不并进公告）', () => {
  const target = event({ id: 'ev-ann', kind: 'announcement', title: MLF_TITLE_B })
  assert.equal(findCluster(item({ kind: 'flash', title: MLF_TITLE_A }), [target]), null)
})

test('findCluster：标题对不上但正文首段相同 + 共享个股 → 合并', () => {
  const target = event({
    id: 'ev-sum',
    title: '芯片国产化再提速 四部门联合发文',
    summary: DIGEST,
    tickers: ['600584'],
  })
  const hit = findCluster(
    item({ title: '四部门发文支持集成电路产业链', summary: DIGEST, tickers: ['600584'] }),
    [target],
  )
  assert.equal(hit, target)
})

test('findCluster：正文兜底要求共享个股/板块或标题相似度 >=0.3，三者都不满足不合并', () => {
  const target = event({ id: 'ev-sum', title: '光伏组件价格再度上调', summary: DIGEST })
  const hit = findCluster(item({ title: '四部门发文支持集成电路产业链', summary: DIGEST }), [target])
  assert.equal(hit, null)
})

test('findCluster：正文兜底需要两边都在 20 字以上（短摘要不算数）', () => {
  const target = event({ id: 'ev-short', title: '光伏组件价格再度上调', summary: '短摘要' })
  const hit = findCluster(item({ title: '四部门发文支持集成电路产业链', summary: '短摘要' }), [target])
  assert.equal(hit, null)
})

test('findCluster：板块变体算共享板块（半导体 vs 半导体设备）', () => {
  const target = event({
    id: 'ev-sector',
    title: '光伏组件价格再度上调',
    summary: DIGEST,
    sectors: ['半导体设备'],
  })
  const hit = findCluster(
    item({ title: '四部门发文支持集成电路产业链', summary: DIGEST, sectors: ['半导体'] }),
    [target],
  )
  assert.equal(hit, target)
})

test('findCluster：多个候选都在窗口内时取分数最高的（共享个股优先）', () => {
  const noTicker = event({ id: 'ev-no-ticker', title: MLF_TITLE_B })
  const withTicker = event({ id: 'ev-with-ticker', title: MLF_TITLE_B, tickers: ['600519'] })
  const hit = findCluster(item({ title: MLF_TITLE_A, tickers: ['600519'] }), [noTicker, withTicker])
  assert.equal(hit, withTicker)
})
