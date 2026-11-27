/**
 * 「今日头版」纯函数单测：`buildFrontpage()`。
 *
 * 只测编排逻辑（排序 / 去重 / 计数 / 关注股命中），不碰数据库与网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFrontpage, HIGHLIGHT_MIN_IMPORTANCE } from '../lib/hub/frontpage.js'

const NOW = Date.parse('2026-11-25T12:00:00+08:00')

let seq = 0
function event(overrides = {}) {
  seq += 1
  return {
    id: `ev-${seq}`,
    ts: NOW - seq * 60_000,
    lastTs: NOW - seq * 60_000,
    title: `事件 ${seq}`,
    summary: '',
    kind: 'flash',
    eventType: '',
    importance: 50,
    sourceCount: 1,
    tickers: [],
    sectors: [],
    url: `https://example.com/${seq}`,
    llm: null,
    ...overrides,
  }
}

test('要闻按重要度排序，低于门槛的不进（除非全都不够）', () => {
  const events = [
    event({ importance: 50, title: '低分' }),
    event({ importance: 80, title: '高分' }),
    event({ importance: 65, title: '中分' }),
  ]
  const page = buildFrontpage({ events, now: NOW })
  assert.deepEqual(page.highlights.map((item) => item.title), ['高分', '中分'])
  assert.ok(HIGHLIGHT_MIN_IMPORTANCE <= 65, '门槛应允许 65 分进入')
})

test('全都低于门槛时仍然给前几条（避免头版空白）', () => {
  const events = [event({ importance: 10, title: 'A' }), event({ importance: 20, title: 'B' })]
  const page = buildFrontpage({ events, now: NOW })
  assert.deepEqual(page.highlights.map((item) => item.title), ['B', 'A'])
})

test('同一只票只上头版一次（3 条同票公告不刷屏）', () => {
  const events = [
    event({ importance: 90, title: '航图付息', tickers: ['688066'] }),
    event({ importance: 89, title: '航图风险提示', tickers: ['688066'] }),
    event({ importance: 88, title: '航图解禁', tickers: ['688066'] }),
    event({ importance: 70, title: '别的事', tickers: ['600000'] }),
  ]
  const page = buildFrontpage({ events, now: NOW, highlightLimit: 3 })
  const titles = page.highlights.map((item) => item.title)
  assert.equal(titles.filter((title) => title.startsWith('航图')).length, 1, `同票应只留一条，实际 ${titles.join('/')}`)
  assert.ok(titles.includes('别的事'))
})

test('宁可少于 limit 也不拿同票的第二条凑数', () => {
  const events = [
    event({ importance: 90, title: 'A1', tickers: ['111111'] }),
    event({ importance: 89, title: 'A2', tickers: ['111111'] }),
    event({ importance: 88, title: 'A3', tickers: ['111111'] }),
  ]
  const page = buildFrontpage({ events, now: NOW, highlightLimit: 3 })
  assert.equal(page.highlights.length, 1, '同票只留一条，剩下的位置留空')
  assert.equal(page.highlights[0].title, 'A1')
})

test('板块热度：同名归一后合并，按事件数降序', () => {
  const events = [
    event({ sectors: ['半导体', '半导体设备'] }),
    event({ sectors: ['半导体'] }),
    event({ sectors: ['银行'] }),
    event({ sectors: ['行业板块'.replace('行业板块', '半导体')] }),
  ]
  const page = buildFrontpage({ events, now: NOW, sectorLimit: 2 })
  assert.equal(page.sectors[0].name, '半导体')
  assert.ok(page.sectors[0].events >= 3, `半导体应聚合，实际 ${page.sectors[0].events}`)
})

test('关注股：命中持仓才出现，同一只票只给最新一条', () => {
  const events = [
    event({ importance: 70, title: '紫金公告', tickers: ['601899'] }),
    event({ importance: 60, title: '紫金新闻', tickers: ['601899'] }),
    event({ importance: 80, title: '别人的事', tickers: ['600000'] }),
  ]
  const page = buildFrontpage({ events, now: NOW, watchlist: new Set(['601899']) })
  assert.equal(page.watch.length, 1, '同一只票只出一条')
  assert.equal(page.watch[0].watchedTicker, '601899')
  assert.equal(page.watch[0].title, '紫金公告')
  assert.equal(page.watchedCount, 1)
})

test('关注股为空时不出 watch 项，也不报错', () => {
  const page = buildFrontpage({ events: [event()], now: NOW, watchlist: new Set() })
  assert.deepEqual(page.watch, [])
  assert.equal(page.watchedCount, 0)
})

test('计数：事件数、多源数、AI 摘要数；store 统计优先', () => {
  const events = [
    event({ sourceCount: 3, llm: { summary: 'AI 摘要', sentiment: '利好' } }),
    event({ sourceCount: 1 }),
  ]
  const page = buildFrontpage({ events, now: NOW, stats: { items: 999, bySource: [{ id: 'a' }, { id: 'b' }] } })
  assert.equal(page.counts.events, 2)
  assert.equal(page.counts.multiSource, 1)
  assert.equal(page.counts.summarized, 1)
  assert.equal(page.counts.items, 999)
  assert.equal(page.counts.sources, 2)
})

test('日期用北京时间（UTC 16:30 仍算前一天）', () => {
  const utcLate = Date.parse('2026-11-24T16:30:00Z') // 北京时间 11-25 00:30
  const page = buildFrontpage({ events: [], now: utcLate })
  assert.equal(page.date, '2026-11-25')
})

test('外部内容截断 + 只放行 http(s)', () => {
  const page = buildFrontpage({
    events: [
      event({
        title: 'T'.repeat(300),
        url: 'javascript:alert(1)',
        summary: 'S'.repeat(300),
        llm: { summary: 'A'.repeat(300), sentiment: '利空' },
      }),
    ],
    now: NOW,
  })
  const top = page.highlights[0]
  assert.ok(top.title.length <= 140, `标题应截断，实际 ${top.title.length}`)
  assert.equal(top.url, '', 'javascript: 链接必须被丢掉')
  assert.ok(top.summary.length <= 120)
  assert.ok(top.ai.summary.length <= 120)
  assert.equal(top.ai.sentiment, '利空')
})

test('空数据也返回合法结构', () => {
  const page = buildFrontpage({ events: [], now: NOW })
  assert.deepEqual(page.highlights, [])
  assert.deepEqual(page.sectors, [])
  assert.deepEqual(page.watch, [])
  assert.equal(page.counts.events, 0)
  assert.equal(page.date, '2026-11-25')
})

test('没有 title 的事件被丢弃（不占头版位置）', () => {
  const page = buildFrontpage({ events: [event({ title: '' }), event({ title: '正经事' })], now: NOW })
  assert.equal(page.highlights.length, 1)
  assert.equal(page.counts.events, 1)
})
