/**
 * lib/hub/digest.js —— 每日 Markdown digest 单测
 *
 * 两层：
 *  - renderDigestMarkdown 是纯函数，直接喂数据断言 Markdown（不碰库、不碰盘）；
 *  - generateDigest / listDigests 会真的落盘，用 DSH_WALLSTREET_HUB_DB + DSH_WALLSTREET_DIGEST_DIR
 *    指到 mkdtemp 目录，每个用例一个独立的产出子目录，绝不碰插件真实的 data/。
 *
 * 时间全部注入固定值（北京时间 2026-11-25 / 26），不依赖 Date.now() 的真实读数。
 */
import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 环境变量必须在 import 之前设好：store.js 在模块加载时就读 DSH_WALLSTREET_HUB_DB。
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-wallstreet-digest-'))
process.env.DSH_WALLSTREET_DATA = ROOT
process.env.DSH_WALLSTREET_HUB_DB = join(ROOT, 'hub.db')
process.env.DSH_WALLSTREET_DIGEST_DIR = join(ROOT, 'digests', 'd0')

const {
  renderDigestMarkdown,
  generateDigest,
  listDigests,
} = await import('../lib/hub/digest.js')
const store = await import('../lib/hub/store.js')

const db = store.openStore()

const HOUR = 3_600_000
const SHANGHAI = 8 * HOUR
/** 北京时间 → epoch ms。 */
const bj = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - SHANGHAI

/** 固定参考时刻：2026-11-25 10:30（北京）。 */
const REF = bj(2026, 11, 25, 10, 30)
/** 日报「生成于」：2026-11-25 20:30（北京）。 */
const GEN_AT = bj(2026, 11, 25, 20, 30)

const DAY_TITLES = '今日要闻（重要度 ≥ 70）'

let seq = 0
let dirSeq = 0

/** 每个用例一个独立产出目录（顺带覆盖「目录不存在时自动 mkdir -p」）。 */
function useDigestDir(name) {
  const dir = join(ROOT, 'digests', name || `d${++dirSeq}`)
  process.env.DSH_WALLSTREET_DIGEST_DIR = dir
  return dir
}

/** 造一个事件（字段形状同 docs/info-hub.md §5）。 */
function makeEvent(over = {}) {
  seq += 1
  return {
    id: `ev-${seq}`,
    ts: REF,
    lastTs: REF,
    title: `测试事件 ${seq}`,
    summary: '',
    url: '',
    kind: 'flash',
    sourceCount: 1,
    sources: [{ source: 'sina', label: '新浪财经' }],
    tickers: [],
    sectors: [],
    eventType: '政策法规',
    importance: 50,
    ...over,
  }
}

/** 造一条条目（只用于测数据源表的「入库」计数）。 */
function makeItem(over = {}) {
  seq += 1
  return {
    id: `it-${seq}`,
    ts: REF,
    source: 'sina',
    sourceLabel: '新浪财经',
    kind: 'flash',
    title: `条目 ${seq}`,
    summary: '',
    url: '',
    tickers: [],
    sectors: [],
    eventType: '',
    importance: 10,
    degraded: false,
    ...over,
  }
}

function makeData(events, extra = {}) {
  return {
    events,
    stats: {
      bySource: [{ id: 'sina', label: '新浪财经', count: 3240, lastOk: bj(2026, 11, 25, 20, 5) }],
    },
    generatedAt: GEN_AT,
    ...extra,
  }
}

/** 取某个二级章节的正文（到下一个 `## ` 为止）。 */
function sectionOf(markdown, headingPrefix) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## ${headingPrefix}`))
  if (start < 0) return ''
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return (end < 0 ? lines.slice(start) : lines.slice(start, end)).join('\n')
}

/** 章节里的有序列表条目数。 */
const numberedCount = (text) => (text.match(/^\d+\. /gm) || []).length

function seed(events) {
  for (const event of events) store.upsertEvent(event)
}

after(() => {
  store.closeStore()
  rmSync(ROOT, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec(`
    DELETE FROM items;
    DELETE FROM events;
    DELETE FROM event_items;
    DELETE FROM source_state;
    DELETE FROM meta;
  `)
  useDigestDir()
})

/* ------------------------------ renderDigestMarkdown ------------------------------ */

test('renderDigestMarkdown：完整数据产出固定章节与头部统计', () => {
  const md = renderDigestMarkdown(
    '2026-11-25',
    makeData([
      makeEvent({
        title: '国务院常务会议部署稳增长',
        importance: 82,
        sourceCount: 3,
        sources: [{ source: 'sina' }, { source: 'wscn' }, { source: 'cls' }],
        tickers: ['600028'],
        sectors: ['石油石化'],
        url: 'https://example.com/a',
      }),
      makeEvent({ title: '某公司业绩预告', kind: 'announcement', eventType: '业绩', importance: 65 }),
      makeEvent({ title: '市场短评', kind: 'flash', eventType: '', importance: 40 }),
    ]),
  )

  assert.ok(md.startsWith('# 华尔街之狼 · 资讯日报 2026-11-25\n'))
  assert.match(md, /> 生成于 20:30｜事件 3 条｜来源 3 个｜多源事件 1 条/)
  for (const heading of [
    '## 今日要闻（重要度 ≥ 70）',
    '## 板块热度',
    '## 公告精选（重要度 ≥ 60 的公告，最多 15 条）',
    '## 其他事件（按类型计数）',
    '## 数据源',
  ]) {
    assert.ok(md.includes(heading), `缺少章节：${heading}`)
  }
  assert.ok(md.trimEnd().endsWith('> 本文件由 dsh-wallstreet 自动生成，仅供研究参考，不构成投资建议。'))
  assert.ok(md.endsWith('\n'))
  assert.ok(!md.includes('\r'))
})

test('renderDigestMarkdown：要闻按重要度倒序，条目带类型/家数/关联/原文', () => {
  const md = renderDigestMarkdown(
    '2026-11-25',
    makeData([
      makeEvent({ title: '低分事件', importance: 40 }),
      makeEvent({
        title: '七十五分事件',
        importance: 75,
        tickers: ['600028'],
        sectors: ['石油石化'],
      }),
      makeEvent({
        title: '八十二分事件',
        importance: 82,
        sourceCount: 3,
        eventType: '货币政策',
        url: 'https://example.com/top',
      }),
    ]),
  )

  const hot = sectionOf(md, DAY_TITLES)
  assert.ok(hot.indexOf('八十二分事件') < hot.indexOf('七十五分事件'))
  assert.ok(!hot.includes('低分事件'))
  assert.ok(hot.includes('1. **[货币政策]** 八十二分事件（重要度 82 · 3 家）'))
  assert.ok(hot.includes('2. **[政策法规]** 七十五分事件（重要度 75 · 1 家）'))
  assert.ok(hot.includes('    - 关联：600028 / 石油石化'))
  assert.ok(hot.includes('    - 原文：https://example.com/top'))
})

test('renderDigestMarkdown：重要度与家数按整数输出（四舍五入、越界夹到 100 / 下限 1）', () => {
  const md = renderDigestMarkdown(
    '2026-11-25',
    makeData([
      makeEvent({ title: '小数事件', importance: 82.4, sourceCount: 2.6 }),
      makeEvent({ title: '越界事件', importance: 999, sourceCount: 0 }),
    ]),
  )

  assert.ok(md.includes('（重要度 82 · 3 家）'))
  assert.ok(md.includes('（重要度 100 · 1 家）'))
  assert.ok(!md.includes('82.4'))
})

test('renderDigestMarkdown：有 AI 摘要时写 AI 行并带情绪，不再写原文摘要', () => {
  const md = renderDigestMarkdown(
    '2026-11-25',
    makeData([
      makeEvent({
        title: 'AI 摘要事件',
        importance: 80,
        summary: '原文摘要不应该出现',
        llm: { summary: '模型一句话总结', sentiment: '利好' },
      }),
    ]),
  )

  const hot = sectionOf(md, DAY_TITLES)
  assert.ok(hot.includes('    - AI：模型一句话总结（利好）'))
  assert.ok(!hot.includes('原文摘要不应该出现'))
  assert.ok(!hot.includes('摘要：'))
})

test('renderDigestMarkdown：没有 AI 摘要时回落到原文摘要（超过 200 字截断）', () => {
  const md = renderDigestMarkdown(
    '2026-11-25',
    makeData([makeEvent({ title: '回落事件', importance: 80, summary: '原'.repeat(300) })]),
  )

  const line = md.split('\n').find((row) => row.startsWith('    - 摘要：'))
  assert.ok(line, '应该有原文摘要行')
  const summary = line.slice('    - 摘要：'.length)
  assert.equal(summary.length, 200)
  assert.ok(summary.endsWith('…'))
})

test('renderDigestMarkdown：空数据也产出合法文档并写「今天没有抓到资讯」', () => {
  const md = renderDigestMarkdown('2026-11-25', { events: [], stats: {}, generatedAt: GEN_AT })

  assert.ok(md.includes('今天没有抓到资讯。'))
  assert.ok(md.includes('> 生成于 20:30｜事件 0 条｜来源 0 个｜多源事件 0 条'))
  for (const heading of [
    '## 今日要闻（重要度 ≥ 70）',
    '## 板块热度',
    '## 公告精选（重要度 ≥ 60 的公告，最多 15 条）',
    '## 其他事件（按类型计数）',
    '## 数据源',
  ]) {
    assert.ok(md.includes(heading), `缺少章节：${heading}`)
  }
  // 数据源为空时表格仍有占位行，外部解析方不会踩空。
  assert.ok(md.includes('| _无_ | — | — |'))
  assert.ok(md.endsWith('。\n'))
})

test('renderDigestMarkdown：缺 data / 字段类型全错时不抛错', () => {
  assert.doesNotThrow(() => renderDigestMarkdown('2026-11-25'))
  assert.ok(renderDigestMarkdown('2026-11-25').includes('今天没有抓到资讯。'))

  const md = renderDigestMarkdown('2026-11-25', {
    events: [
      null,
      'x',
      42,
      { title: null, importance: 100, sourceCount: 'x', tickers: '600028', sectors: 42, sources: 'bad', llm: 'bad' },
      { title: 12345, kind: 'unknown-kind', importance: 90, tickers: [600028, 'sh600028', '000001'], sectors: ['   ', '银行'] },
    ],
    stats: null,
    generatedAt: GEN_AT,
  })

  assert.ok(md.includes('资讯日报 2026-11-25'))
  assert.ok(md.includes('（无标题）'))
  assert.ok(md.includes('12345'))
  // unknown-kind 落到快讯；负数分数夹到 0；数字 600028 也要能当代码用。
  const kinds = sectionOf(md, '其他事件（按类型计数）')
  assert.ok(kinds.includes('快讯 2 条'))
  assert.ok(md.includes('关联：600028 / 000001 / 银行'))
})

test('renderDigestMarkdown：只有公告时公告精选有条目、要闻为空', () => {
  const md = renderDigestMarkdown(
    '2026-11-25',
    makeData([
      makeEvent({
        title: '某公司重大合同公告',
        kind: 'announcement',
        eventType: '中标合同',
        importance: 66,
        tickers: ['600028'],
        url: 'https://example.com/ann',
      }),
    ]),
  )

  const hot = sectionOf(md, DAY_TITLES)
  const ann = sectionOf(md, '公告精选')
  assert.ok(hot.includes('_无（今天没有重要度 ≥ 70 的事件）_'))
  assert.ok(ann.includes('1. **某公司重大合同公告**（重要度 66）'))
  assert.ok(ann.includes('    - 关联：600028'))
  assert.ok(ann.includes('    - 原文：https://example.com/ann'))
  assert.ok(sectionOf(md, '其他事件').includes('- 公告 1 条'))
})

test('renderDigestMarkdown：公告精选最多 15 条，并提示还有多少条', () => {
  const events = Array.from({ length: 20 }, (_, index) =>
    makeEvent({
      title: `公告 ${index + 1}`,
      kind: 'announcement',
      eventType: '业绩',
      importance: 60 + index,
    }),
  )
  const md = renderDigestMarkdown('2026-11-25', makeData(events))

  const ann = sectionOf(md, '公告精选')
  assert.equal(numberedCount(ann), 15)
  assert.ok(ann.includes('1. **公告 20**（重要度 79）'))
  assert.ok(ann.includes('另有 5 条公告未列出'))
  assert.ok(sectionOf(md, '其他事件').includes('- 公告 20 条'))
})

test('renderDigestMarkdown：超长标题截断到 120 字', () => {
  const title = '标'.repeat(200)
  const md = renderDigestMarkdown('2026-11-25', makeData([makeEvent({ title, importance: 90 })]))

  const line = md.split('\n').find((row) => row.startsWith('1. **[政策法规]** '))
  assert.ok(line, '应该有第一条要闻')
  const rendered = line.slice('1. **[政策法规]** '.length).replace(/（重要度.*$/, '')
  assert.equal(rendered.length, 120)
  assert.ok(rendered.endsWith('…'))
  assert.ok(!md.includes(title))
})

test('renderDigestMarkdown：超长 URL 截断到 300 字且不再是可用链接', () => {
  const longUrl = `https://example.com/${'a'.repeat(400)}`
  const md = renderDigestMarkdown(
    '2026-11-25',
    makeData([makeEvent({ title: '长链接事件', importance: 90, url: longUrl })]),
  )

  const line = md.split('\n').find((row) => row.startsWith('    - 原文：'))
  assert.ok(line, '应该有原文行')
  const rendered = line.slice('    - 原文：'.length).replace('（原链接过长，已截断）', '')
  assert.equal(rendered.length, 300)
  assert.ok(rendered.endsWith('…'))
  assert.ok(line.includes('原链接过长'))
  assert.ok(!md.includes(longUrl))
})

test('renderDigestMarkdown：非 http(s) 链接（javascript:/空/mailto:/ftp:/带空格）不渲染成链接', () => {
  const md = renderDigestMarkdown(
    '2026-11-25',
    makeData([
      makeEvent({ title: '脚本链接', importance: 90, url: 'javascript:alert(1)' }),
      makeEvent({ title: '空链接', importance: 90, url: '' }),
      makeEvent({ title: '邮件链接', importance: 90, url: 'mailto:a@b.com' }),
      makeEvent({ title: 'FTP 链接', importance: 90, url: 'ftp://example.com/x' }),
      makeEvent({ title: '带空格链接', importance: 90, url: 'https://example.com/a b' }),
    ]),
  )

  assert.ok(!md.includes('javascript'))
  assert.ok(!md.includes('mailto'))
  assert.ok(!md.includes('ftp://'))
  assert.equal((md.match(/原文：/g) || []).length, 0)
  // 链接被丢弃，但事件本身还在（只是没有可跳转的原文）。
  for (const title of ['脚本链接', '空链接', '邮件链接', 'FTP 链接', '带空格链接']) {
    assert.ok(md.includes(title))
  }
})

test('renderDigestMarkdown：标题里的 Markdown 标记被转义（*ST / 假链接）', () => {
  const md = renderDigestMarkdown(
    '2026-11-25',
    makeData([
      makeEvent({ title: '*ST英飞:关于重整的公告', importance: 90 }),
      makeEvent({ title: '[点我](https://evil.example)', importance: 85 }),
    ]),
  )

  const hot = sectionOf(md, DAY_TITLES)
  // *ST 这种真实高频标题不能把加粗吃掉；外部标题里的链接语法也不能凭空生效。
  assert.ok(hot.includes('1. **[政策法规]** \\*ST英飞:关于重整的公告（重要度 90 · 1 家）'))
  assert.ok(md.includes('\\[点我\\](https://evil.example)'))
})

test('renderDigestMarkdown：板块热度按事件数倒序，并保留最高重要度', () => {
  const md = renderDigestMarkdown(
    '2026-11-25',
    makeData([
      makeEvent({ title: 'A', sectors: ['半导体'], importance: 62, kind: 'flash' }),
      makeEvent({ title: 'B', sectors: ['半导体'], importance: 88, kind: 'flash' }),
      makeEvent({ title: 'C', sectors: ['银行'], importance: 40, kind: 'flash' }),
      makeEvent({ title: 'D', sectors: ['银行'], importance: 45, kind: 'flash' }),
    ]),
  )

  const rows = sectionOf(md, '板块热度')
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.includes('---') && !line.startsWith('| 板块'))
  assert.deepEqual(rows, ['| 半导体 | 2 | 88 |', '| 银行 | 2 | 45 |'])
})

test('renderDigestMarkdown：数据源名截断到 40 字并转义管道符', () => {
  const label = `超长源名|${'名'.repeat(60)}`
  const md = renderDigestMarkdown('2026-11-25', {
    events: [],
    stats: { bySource: [{ id: 'x', label, count: 12, lastOk: bj(2026, 11, 25, 9, 5) }] },
    generatedAt: GEN_AT,
  })

  const row = md.split('\n').find((line) => line.startsWith('| 超长源名'))
  assert.ok(row, '应该有数据源行')
  assert.ok(row.includes('\\|'), '管道符必须转义，否则表格会断')
  assert.ok(row.includes('| 12 |'))
  assert.ok(row.includes('11-25 09:05'))
  const nameCell = row.slice(2, row.indexOf(' | 12 |')).replace(/\\\|/g, '|')
  assert.equal(nameCell.length, 40)
  assert.ok(nameCell.endsWith('…'))
})

test('renderDigestMarkdown：非法 date 回落到 generatedAt 的北京日期（也接受时间戳与 Date）', () => {
  assert.ok(
    renderDigestMarkdown('不是日期', { events: [], stats: {}, generatedAt: GEN_AT }).startsWith(
      '# 华尔街之狼 · 资讯日报 2026-11-25',
    ),
  )
  assert.ok(renderDigestMarkdown(GEN_AT).includes('资讯日报 2026-11-25'))
  assert.ok(renderDigestMarkdown(new Date(GEN_AT)).includes('资讯日报 2026-11-25'))
})

/* ------------------------------ generateDigest ------------------------------ */

test('generateDigest：写盘成功，latest.md 与当天文件内容一致、只收当天事件', async () => {
  seed([
    makeEvent({
      title: '今天的政策事件',
      importance: 82,
      ts: bj(2026, 11, 25, 9, 30),
      lastTs: bj(2026, 11, 25, 9, 30),
      tickers: ['600028'],
      sectors: ['石油石化'],
      url: 'https://example.com/today',
    }),
    makeEvent({
      title: '昨天的旧事件',
      importance: 90,
      ts: bj(2026, 11, 24, 22, 0),
      lastTs: bj(2026, 11, 24, 22, 0),
    }),
  ])

  const result = await generateDigest({ date: '2026-11-25', now: GEN_AT })
  const dir = process.env.DSH_WALLSTREET_DIGEST_DIR

  assert.equal(result.ok, true)
  assert.equal(result.date, '2026-11-25')
  assert.equal(result.path, join(dir, '2026-11-25.md'))
  assert.equal(result.latestPath, join(dir, 'latest.md'))
  assert.equal(result.events, 1)
  assert.equal(result.generatedAt, GEN_AT)
  assert.ok(existsSync(result.path))
  assert.ok(existsSync(result.latestPath))

  const content = readFileSync(result.path, 'utf8')
  const latest = readFileSync(result.latestPath, 'utf8')
  assert.equal(latest, content)
  assert.equal(result.bytes, Buffer.byteLength(content, 'utf8'))
  assert.equal(readFileSync(result.path).length, Buffer.byteLength(content, 'utf8'))
  assert.ok(content.includes('今天的政策事件'))
  assert.ok(!content.includes('昨天的旧事件'))
  assert.ok(content.includes('> 生成于 20:30｜事件 1 条'))
})

test('generateDigest：北京时间跨零点的事件各自归日', async () => {
  seed([
    makeEvent({ title: '二十五日深夜事件', importance: 80, ts: bj(2026, 11, 25, 23, 30), lastTs: bj(2026, 11, 25, 23, 30) }),
    makeEvent({ title: '二十六日凌晨事件', importance: 80, ts: bj(2026, 11, 26, 0, 30), lastTs: bj(2026, 11, 26, 0, 30) }),
  ])

  const day25 = await generateDigest({ date: '2026-11-25', now: GEN_AT })
  const day26 = await generateDigest({ date: '2026-11-26', now: GEN_AT })
  const content25 = readFileSync(day25.path, 'utf8')
  const content26 = readFileSync(day26.path, 'utf8')

  assert.equal(day25.events, 1)
  assert.equal(day26.events, 1)
  assert.ok(content25.includes('二十五日深夜事件'))
  assert.ok(!content25.includes('二十六日凌晨事件'))
  assert.ok(content26.includes('二十六日凌晨事件'))
  assert.ok(!content26.includes('二十五日深夜事件'))
  assert.ok(day25.path.endsWith('2026-11-25.md'))
  assert.ok(day26.path.endsWith('2026-11-26.md'))
})

test('generateDigest：不传 date 时用 now 的北京日期（00:30 已属于新的一天）', async () => {
  seed([
    makeEvent({ title: '凌晨事件', ts: bj(2026, 11, 26, 0, 10), lastTs: bj(2026, 11, 26, 0, 10) }),
  ])

  const result = await generateDigest({ now: bj(2026, 11, 26, 0, 30) })
  assert.equal(result.ok, true)
  assert.equal(result.date, '2026-11-26')
  assert.ok(result.path.endsWith('2026-11-26.md'))
  assert.equal(result.events, 1)
  assert.ok(readFileSync(result.path, 'utf8').includes('资讯日报 2026-11-26'))
})

test('generateDigest：同一天重复生成会覆盖，不产生额外文件', async () => {
  const dir = useDigestDir('overwrite')
  seed([
    makeEvent({ title: '第一次生成的事件', importance: 80, ts: bj(2026, 11, 25, 9, 0), lastTs: bj(2026, 11, 25, 9, 0) }),
  ])

  const first = await generateDigest({ date: '2026-11-25', now: GEN_AT })
  seed([
    makeEvent({ title: '补抓进来的事件', importance: 75, ts: bj(2026, 11, 25, 19, 0), lastTs: bj(2026, 11, 25, 19, 0) }),
  ])
  const second = await generateDigest({ date: '2026-11-25', now: bj(2026, 11, 25, 21, 0) })

  const content = readFileSync(second.path, 'utf8')
  assert.equal(first.path, second.path)
  assert.ok(content.includes('第一次生成的事件'))
  assert.ok(content.includes('补抓进来的事件'))
  assert.equal(second.events, 2)
  // md 是给人看的，html 是给知识库管线（kb_publish.py 收 HTML）——两份同日各一份，外加 latest。
  assert.deepEqual(readdirSync(dir).sort(), ['2026-11-25.html', '2026-11-25.md', 'latest.html', 'latest.md'])
  assert.equal(readFileSync(second.latestPath, 'utf8'), content)
})

test('generateDigest：DSH_WALLSTREET_DIGEST_DIR 覆盖目录并自动 mkdir -p', async () => {
  const dir = join(ROOT, 'nested', 'deep', 'digest')
  process.env.DSH_WALLSTREET_DIGEST_DIR = dir
  seed([makeEvent({ ts: bj(2026, 11, 25, 8, 0), lastTs: bj(2026, 11, 25, 8, 0) })])

  const result = await generateDigest({ date: '2026-11-25', now: GEN_AT })
  assert.equal(result.ok, true)
  assert.equal(result.path, join(dir, '2026-11-25.md'))
  assert.ok(existsSync(result.path))
})

test('generateDigest：非法 date 返回 ok:false 而不是抛错', async () => {
  const dir = process.env.DSH_WALLSTREET_DIGEST_DIR

  const bad = await generateDigest({ date: '2026-02-30', now: GEN_AT })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /YYYY-MM-DD/)
  assert.equal(bad.events, 0)
  assert.equal(bad.bytes, 0)

  const slash = await generateDigest({ date: '2026/11/25', now: GEN_AT })
  assert.equal(slash.ok, false)

  // 解析失败时连目录都不该创建（不落垃圾文件）。
  assert.equal(existsSync(dir), false)
})

test('generateDigest：目录建不出来时返回 ok:false + 原因，不抛错', async () => {
  const blocker = join(ROOT, 'blocker-file')
  writeFileSync(blocker, 'x')
  process.env.DSH_WALLSTREET_DIGEST_DIR = join(blocker, 'digest')

  const result = await generateDigest({ date: '2026-11-25', now: GEN_AT })
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('失败'))
  assert.equal(result.path, join(blocker, 'digest', '2026-11-25.md'))
})

test('generateDigest：当天没有事件也写出一份合法日报', async () => {
  const result = await generateDigest({ date: '2020-01-01', now: GEN_AT })

  assert.equal(result.ok, true)
  assert.equal(result.events, 0)
  const content = readFileSync(result.path, 'utf8')
  assert.ok(content.startsWith('# 华尔街之狼 · 资讯日报 2020-01-01'))
  assert.ok(content.includes('今天没有抓到资讯。'))
})

test('generateDigest：数据源健康度来自 store.stats，空事件日也照常输出', async () => {
  store.recordSourceRun('sina', '新浪财经', { ok: true, count: 120, at: bj(2026, 11, 25, 20, 5) })
  store.insertItems([makeItem()], GEN_AT)

  const result = await generateDigest({ date: '2026-11-25', now: GEN_AT })
  assert.equal(result.ok, true)
  assert.equal(result.events, 0)

  const content = readFileSync(result.path, 'utf8')
  assert.ok(content.includes('| 新浪财经 | 1 | 11-25 20:05 |'))
})

/* ------------------------------ listDigests ------------------------------ */

test('listDigests：按日期倒序，忽略 latest.md / 非日期文件 / 非法日期', async () => {
  const dir = useDigestDir('list')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '2026-11-23.md'), '# 23\n')
  writeFileSync(join(dir, '2026-11-25.md'), '# 25\n')
  writeFileSync(join(dir, '2026-11-24.md'), '# 24\n')
  writeFileSync(join(dir, 'latest.md'), '# latest\n')
  writeFileSync(join(dir, 'notes.md'), 'x')
  writeFileSync(join(dir, '2026-13-40.md'), 'x')
  writeFileSync(join(dir, '2026-11-22.md.tmp'), 'x')

  const rows = await listDigests()
  assert.deepEqual(rows.map((row) => row.date), ['2026-11-25', '2026-11-24', '2026-11-23'])
  assert.equal(rows[0].path, join(dir, '2026-11-25.md'))
  assert.equal(rows[0].bytes, Buffer.byteLength('# 25\n'))
  assert.ok(Number.isFinite(rows[0].modifiedAt))
  assert.ok(rows[0].modifiedAt > 0)
})

test('listDigests：limit 只取最新 N 份', async () => {
  const dir = useDigestDir('limit')
  mkdirSync(dir, { recursive: true })
  for (const day of ['20', '21', '22', '23']) {
    writeFileSync(join(dir, `2026-11-${day}.md`), 'x')
  }

  const rows = await listDigests({ limit: 2 })
  assert.deepEqual(rows.map((row) => row.date), ['2026-11-23', '2026-11-22'])
})

test('listDigests：目录不存在时返回空数组', async () => {
  process.env.DSH_WALLSTREET_DIGEST_DIR = join(ROOT, 'no-such-dir', 'digest')
  assert.deepEqual(await listDigests(), [])
})

test('listDigests：生成后的日报能被列出（含 latest.md 不算一份）', async () => {
  seed([
    makeEvent({ title: '25 日事件', ts: bj(2026, 11, 25, 9, 0), lastTs: bj(2026, 11, 25, 9, 0) }),
    makeEvent({ title: '26 日事件', ts: bj(2026, 11, 26, 9, 0), lastTs: bj(2026, 11, 26, 9, 0) }),
  ])
  await generateDigest({ date: '2026-11-25', now: GEN_AT })
  await generateDigest({ date: '2026-11-26', now: bj(2026, 11, 26, 20, 30) })

  const rows = await listDigests()
  assert.deepEqual(rows.map((row) => row.date), ['2026-11-26', '2026-11-25'])
  assert.ok(rows.every((row) => row.bytes > 0))
  assert.ok(rows.every((row) => row.path.endsWith(`${row.date}.md`)))
})
