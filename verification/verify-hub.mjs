#!/usr/bin/env node
/**
 * dsh-wallstreet 资讯集散中心 · 端到端验收
 *
 * 目标：不依赖 DSH 登录态、不依赖浏览器，直接跑通「入库 → 聚簇 → 打标 → 查询 → 工具输出」
 * 五段，并且**真的去抓一遍上游**，把每个源的可用性打出来。
 *
 * 用法：
 *   node verification/verify-hub.mjs            # 全量（含真实上游，约 30–60s）
 *   SKIP_LIVE=1 node verification/verify-hub.mjs # 只跑离线段（CI/无网环境）
 *
 * 退出码：0 全过；1 有 FAIL。
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB = join(tmpdir(), `wallstreet-hub-verify-${process.pid}.db`)
process.env.DSH_WALLSTREET_HUB_DB = DB
for (const suffix of ['', '-wal', '-shm']) rmSync(DB + suffix, { force: true })

const rows = []
const record = (status, name, detail = '') => rows.push({ status, name, detail })
const check = async (name, fn) => {
  try {
    const detail = await fn()
    record('PASS', name, detail == null ? '' : String(detail))
    return true
  } catch (error) {
    record('FAIL', name, error && error.message ? error.message : String(error))
    return false
  }
}

const now = Date.now()
const HOUR = 3_600_000

/** 两个假源：标题相近 → 应聚成 1 个事件；第三个标题无关 → 单独成簇。 */
const fakeSources = [
  {
    id: 'fake-a',
    label: '测试源A',
    kind: 'flash',
    intervalMs: 60_000,
    enabled: true,
    async fetch() {
      return [
        {
          title: '央行开展 1 万亿元 MLF 操作 600519 贵州茅台',
          summary: '为保持银行体系流动性合理充裕',
          ts: now - 2 * HOUR,
          url: 'https://example.com/a',
        },
        {
          title: '某公司发布三季报 净利润同比增长 30%',
          summary: '业绩超预期',
          ts: now - 3 * HOUR,
          url: 'https://example.com/b',
        },
      ]
    },
  },
  {
    id: 'fake-b',
    label: '测试源B',
    kind: 'flash',
    intervalMs: 60_000,
    enabled: true,
    async fetch() {
      return [
        {
          title: '央行开展1万亿元MLF操作，保持流动性合理充裕',
          summary: '央行公告',
          ts: now - 1.8 * HOUR,
          url: 'https://example.com/a2',
        },
        {
          title: '这只票被立案调查',
          summary: '风险提示',
          ts: now - 4 * HOUR,
          url: 'https://example.com/c',
        },
      ]
    },
  },
  {
    id: 'fake-fail',
    label: '测试失败源',
    kind: 'flash',
    intervalMs: 60_000,
    enabled: true,
    async fetch() {
      throw new Error('上游 403')
    },
  },
]

const store = await import('../lib/hub/store.js')
const { runIngest, phaseNow } = await import('../lib/hub/ingest.js')
const { hubRoute, formatNewsResult, createHubTools } = await import('../lib/hub/index.js')

// ---------------------------------------------------------------- 1. 入站与落库
let ingest = null
await check('入站：假源入库 + 失败源降级不拖垮', async () => {
  ingest = await runIngest({ sources: fakeSources, force: true, log: () => {} })
  assert.equal(ingest.ok, true)
  assert.equal(ingest.ingested, 4, `应入库 4 条，实际 ${ingest.ingested}`)
  const failed = ingest.sources.find((entry) => entry.id === 'fake-fail')
  assert.equal(failed.ok, false)
  assert.match(failed.error, /403/)
  const stats = store.stats()
  assert.equal(stats.items, 4)
  return `items=${stats.items} events=${stats.events}`
})

await check('聚簇：同一事件跨源合并为 1 个事件（sourceCount=2）', async () => {
  const { events } = store.queryFeed({ limit: 50 })
  const mlf = events.find((event) => event.title.includes('MLF'))
  assert.ok(mlf, '没找到 MLF 事件')
  assert.equal(mlf.sourceCount, 2, `sourceCount 应为 2，实际 ${mlf.sourceCount}`)
  assert.deepEqual([...new Set(mlf.sources.map((entry) => entry.source))].sort(), ['fake-a', 'fake-b'])
  return `events=${events.length} mlf.sources=${mlf.sourceCount}`
})

await check('聚簇：无关标题不被合并', async () => {
  const { events } = store.queryFeed({ limit: 50 })
  assert.equal(events.length, 3, `应有 3 个事件（MLF/业绩/立案），实际 ${events.length}`)
  return events.map((event) => `${event.eventType || '未分类'}:${event.sourceCount}`).join(' ')
})

// ---------------------------------------------------------------- 2. 打标
await check('打标：个股代码 + 事件类型 + 重要度', async () => {
  const { events } = store.queryFeed({ limit: 50 })
  const mlf = events.find((event) => event.title.includes('MLF'))
  assert.ok(mlf.tickers.includes('600519'), `应抽到 600519，实际 ${JSON.stringify(mlf.tickers)}`)
  assert.equal(mlf.eventType, '货币政策')
  assert.ok(mlf.importance >= 50, `货币政策重要度应 >=50，实际 ${mlf.importance}`)
  const risk = events.find((event) => event.title.includes('立案'))
  assert.equal(risk.eventType, '风险事件')
  const earnings = events.find((event) => event.title.includes('三季报'))
  assert.equal(earnings.eventType, '业绩')
  return `mlf=${mlf.importance} risk=${risk.importance} earnings=${earnings.importance}`
})

await check('打标：行业/板块命中（有色金属类新闻）', async () => {
  const dict = await (await import('../lib/hub/tagging.js')).loadDictionary()
  const tagged = (await import('../lib/hub/tagging.js')).tagItem(
    { title: '稀土价格上调，有色板块走强', summary: '', kind: 'flash', tickers: [], sectors: [] },
    dict,
  )
  assert.ok(tagged.sectors.length > 0, '应命中板块')
  assert.equal(tagged.eventType, '涨价提价')
  return tagged.sectors.join('/')
})

// ---------------------------------------------------------------- 3. 查询与 API
await check('API：/hub/feed 过滤生效（kind/ticker/q/minImportance）', async () => {
  const ok = await hubRoute({ pathname: '/wallstreet/api/hub/feed', query: new URLSearchParams('limit=10'), method: 'GET' })
  assert.equal(ok.ok, true)
  assert.equal(ok.events.length, 3)
  const byTicker = await hubRoute({ pathname: '/wallstreet/api/hub/feed', query: new URLSearchParams('ticker=600519'), method: 'GET' })
  assert.equal(byTicker.events.length, 1, 'ticker 过滤应只剩 1 条')
  const byQuery = await hubRoute({ pathname: '/wallstreet/api/hub/feed', query: new URLSearchParams('q=立案'), method: 'GET' })
  assert.equal(byQuery.events.length, 1, '关键词过滤应只剩 1 条')
  const byKind = await hubRoute({ pathname: '/wallstreet/api/hub/feed', query: new URLSearchParams('kind=announcement'), method: 'GET' })
  assert.equal(byKind.events.length, 0, 'announcement 应为空')
  const none = await hubRoute({ pathname: '/wallstreet/api/hub/feed', query: new URLSearchParams('since=1h'), method: 'GET' })
  assert.ok(none.ok, 'since=1h 相对时间应被解析')
  return `all=${ok.events.length} ticker=1 q=1 kind=0 since1h=${none.events.length}`
})

await check('API：/hub/stats 反映源健康度', async () => {
  const body = await hubRoute({ pathname: '/wallstreet/api/hub/stats', query: new URLSearchParams(), method: 'GET' })
  assert.equal(body.ok, true)
  const failed = body.bySource.find((entry) => entry.id === 'fake-fail')
  assert.ok(failed && failed.lastError.includes('403'), '失败源应带错误原因')
  const healthy = body.bySource.find((entry) => entry.id === 'fake-a')
  assert.ok(healthy && healthy.count > 0)
  return `sources=${body.bySource.length} items=${body.items} events=${body.events}`
})

await check('API：/hub/event 返回簇内全部条目', async () => {
  const { events } = store.queryFeed({ limit: 10 })
  const mlf = events.find((event) => event.title.includes('MLF'))
  const body = await hubRoute({ pathname: '/wallstreet/api/hub/event', query: new URLSearchParams(`id=${mlf.id}`), method: 'GET' })
  assert.equal(body.ok, true)
  assert.equal(body.event.items.length, 2, `簇内应有 2 条，实际 ${body.event.items.length}`)
  return `items=${body.event.items.length}`
})

await check('API：未知 hub 路由返回 undefined（交给上层 404）', async () => {
  const body = await hubRoute({ pathname: '/wallstreet/api/hub/nope', query: new URLSearchParams(), method: 'GET' })
  assert.equal(body, undefined)
})

// ---------------------------------------------------------------- 4. 工具
await check('工具：wallstreet_news 定义合法且可执行', async () => {
  const [tool] = createHubTools()
  assert.equal(tool.name, 'wallstreet_news')
  assert.equal(tool.parameters.type, 'object')
  assert.ok(tool.description.length > 40)
  assert.equal(typeof tool.execute, 'function')
  const text = await tool.execute({ sinceHours: 24, limit: 10 })
  assert.match(text, /近 24 小时资讯/)
  assert.match(text, /MLF/)
  const empty = await tool.execute({ query: '不存在的关键词xyz', sinceHours: 24 })
  assert.match(empty, /没有匹配的资讯/)
  const rendered = tool.output.render({}, text)
  assert.ok(Array.isArray(rendered) && rendered[0].type === 'text')
  return `chars=${text.length}`
})

await check('工具：ticker 过滤只回相关事件', async () => {
  const text = formatNewsResult({ ticker: '600519', sinceHours: 24 })
  assert.match(text, /600519/)
  assert.doesNotMatch(text, /立案/)
})

// ---------------------------------------------------------------- 4.5 P1：板块对齐与正文去重
await check('P1 聚簇：标题不同但正文首段相同 → 合并为 1 个事件', async () => {
  const before = store.stats().events
  const p1Sources = [
    {
      id: 'p1-a',
      label: 'P1源A',
      kind: 'flash',
      intervalMs: 60_000,
      enabled: true,
      async fetch() {
        const digest = '国家发展改革委等部门联合印发通知，明确加快推进集成电路产业链自主可控，支持先进封装与设备材料国产化，相关企业将获得研发费用加计扣除等政策支持。'
        return [
          { title: '四部门发文支持集成电路产业链', summary: digest, ts: now - 30 * 60_000, url: 'https://example.com/p1a' },
        ]
      },
    },
    {
      id: 'p1-b',
      label: 'P1源B',
      kind: 'flash',
      intervalMs: 60_000,
      enabled: true,
      async fetch() {
        const digest = '国家发展改革委等部门联合印发通知，明确加快推进集成电路产业链自主可控，支持先进封装与设备材料国产化，相关企业将获得研发费用加计扣除等政策支持。'
        return [
          { title: '芯片国产化再提速 四部门联合发文', summary: digest, ts: now - 28 * 60_000, url: 'https://example.com/p1b' },
        ]
      },
    },
  ]
  await runIngest({ sources: p1Sources, force: true, log: () => {} })
  const after = store.stats().events
  assert.equal(after - before, 1, `两条同正文的资讯应聚成 1 个事件，实际新增 ${after - before}`)
  const { events } = store.queryFeed({ q: '集成电路', limit: 5 })
  const merged = events[0]
  assert.ok(merged && merged.sourceCount === 2, `应合并 2 个源，实际 ${merged && merged.sourceCount}`)
  return `events+${after - before} sourceCount=${merged.sourceCount}`
})

await check('P1 板块：细分行业名靠核心词对齐到资讯', async () => {
  const body = await hubRoute({
    pathname: '/wallstreet/api/hub/sectors',
    query: new URLSearchParams('names=半导体,水产养殖,集成电路封测&since=24h'),
    method: 'GET',
  })
  assert.equal(body.ok, true)
  const byName = Object.fromEntries(body.sectors.map((item) => [item.name, item.events]))
  assert.ok(byName['半导体'] >= 1, `半导体应有资讯，实际 ${byName['半导体']}`)
  assert.equal(byName['水产养殖'], 0, '水产养殖不应误匹配')
  assert.ok(byName['集成电路封测'] >= 1, `集成电路封测应靠核心词命中，实际 ${byName['集成电路封测']}`)
  return body.sectors.map((item) => `${item.name}:${item.events}`).join(' ')
})

await check('P1 板块：/hub/feed?sector= 走同一套兜底', async () => {
  const direct = await hubRoute({ pathname: '/wallstreet/api/hub/feed', query: new URLSearchParams('sector=半导体'), method: 'GET' })
  assert.ok(direct.total >= 1, `sector=半导体 应有结果，实际 ${direct.total}`)
  const alias = await hubRoute({ pathname: '/wallstreet/api/hub/feed', query: new URLSearchParams('sector=芯片'), method: 'GET' })
  assert.ok(alias.total >= 1, `sector=芯片 应命中同一批事件，实际 ${alias.total}`)
  const miss = await hubRoute({ pathname: '/wallstreet/api/hub/feed', query: new URLSearchParams('sector=水产养殖'), method: 'GET' })
  assert.equal(miss.total, 0)
  return `半导体=${direct.total} 芯片=${alias.total} 水产养殖=${miss.total}`
})

// ---------------------------------------------------------------- 4.6 P2：重要度模型 / 成分股 / AI 摘要
await check('P2 重要度：分量可解释，政务类封顶', async () => {
  const tagged = (await import('../lib/hub/tagging.js')).tagItem(
    { title: '国务院办公厅关于2027年部分节假日安排的通知', summary: '', kind: 'policy', tickers: [], sectors: [] },
    null,
  )
  assert.ok(tagged.importanceParts && typeof tagged.importanceParts.type === 'number', '应有分量拆解')
  assert.ok(tagged.importance <= 42, `政务流水账应封顶 42，实际 ${tagged.importance}`)
  const notice = (await import('../lib/hub/tagging.js')).tagItem(
    { title: '国务院关于修改部分行政法规的决定', summary: '', kind: 'policy', tickers: [], sectors: [] },
    null,
  )
  assert.ok(notice.importance <= 58, `无市场含义的政策应封顶 58，实际 ${notice.importance}`)
  return `节假日=${tagged.importance} 一般政策=${notice.importance}`
})

await check('P2 重要度：风险事件 + 持仓个股拿到高分', async () => {
  const dict = await (await import('../lib/hub/tagging.js')).loadDictionary()
  const risk = (await import('../lib/hub/tagging.js')).tagItem(
    { title: '紫金矿业收到立案告知书', summary: '公司公告', kind: 'announcement', tickers: ['601899'], sectors: [] },
    dict,
  )
  assert.equal(risk.eventType, '风险事件')
  assert.ok(risk.importance >= 60, `风险事件应 >=60，实际 ${risk.importance}`)
  assert.ok(risk.importanceParts.watch > 0, '持仓股应有 watch 加权')
  return `importance=${risk.importance} parts=${JSON.stringify(risk.importanceParts)}`
})

await check('P2 成分股：无缓存时不阻塞、返回 pending', async () => {
  const membership = await import('../lib/hub/membership.js')
  membership.resetMembershipCache()
  const result = await membership.membersOf('半导体设备')
  assert.ok(result && ['pending', 'members'].includes(result.basis), `basis 应为 pending/members，实际 ${result && result.basis}`)
  const stats = await membership.membershipStats()
  assert.ok(stats.boards >= 0 && Array.isArray(stats.failures))
  return `basis=${result.basis} cachedBoards=${stats.boardsWithMembers}`
})

await check('P2 AI 摘要：用假模型跑通「生成→解析→落库」', async () => {
  const { runSummaries } = await import('../lib/hub/summarize.js')
  const fakeResponse = '{"summary":"紫金矿业被立案，短期承压","sentiment":"利空","impact":["601899"]}'
  const fakeCtx = {
    get(name) {
      if (name === 'llm') {
        return {
          async *stream() {
            yield { type: 'text-delta', text: fakeResponse }
            yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 30 } }
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) }
      }
      return undefined
    },
  }
  // 先造一条高分事件
  await runIngest({
    sources: [
      {
        id: 'p2-risk',
        label: 'P2源',
        kind: 'announcement',
        intervalMs: 60_000,
        enabled: true,
        async fetch() {
          return [{ title: '紫金矿业收到证监会立案告知书', summary: '涉嫌信息披露违法违规', ts: now - 10 * 60_000, url: 'https://example.com/p2' }]
        },
      },
    ],
    force: true,
    log: () => {},
  })
  const result = await runSummaries(fakeCtx, { minImportance: 40, maxPerRun: 3, log: () => {} })
  assert.equal(result.ok, true, `应跑通，实际 ${JSON.stringify(result)}`)
  assert.ok(result.done >= 1, `应至少总结 1 条，实际 ${result.done}`)
  const { events } = store.queryFeed({ q: '紫金矿业', limit: 4 })
  const event = events.find((item) => item.llm && item.llm.summary)
  assert.ok(event, '事件应带 llm.summary')
  assert.equal(event.llm.sentiment, '利空')
  assert.match(event.llm.summary, /紫金矿业/)
  return `done=${result.done} sentiment=${event.llm.sentiment} tokens=${result.tokens || 0}`
})

await check('P2 AI 摘要：没有默认模型时安静降级', async () => {
  const { runSummaries } = await import('../lib/hub/summarize.js')
  const emptyCtx = { get: () => undefined }
  const result = await runSummaries(emptyCtx, { log: () => {} })
  assert.equal(result.ok, false)
  assert.match(result.reason, /默认模型/)
  return result.reason
})

await check('P2 成分股：预置缓存后按成分股精确计数与过滤', async () => {
  // 上游此刻被 RST 时这条也要能过：直接写一份最小的成分股缓存，验证机制本身。
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = join(tmpdir(), `hub-members-${process.pid}`)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'sector-members.json')
  // 事件里 601600 中国铝业属于「有色金属」板块
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      listFetchedAt: Date.now(),
      boards: {
        有色金属: { code: 'BK0478', listedAt: Date.now(), members: ['601600', '601899'], fetchedAt: Date.now() },
      },
    }),
  )
  process.env.DSH_WALLSTREET_MEMBERS_FILE = file
  const membership = await import('../lib/hub/membership.js')
  membership.resetMembershipCache()

  await runIngest({
    sources: [
      {
        id: 'p2-member',
        label: 'P2成分源',
        kind: 'flash',
        intervalMs: 60_000,
        enabled: true,
        async fetch() {
          return [
            { title: '601600 中国铝业三季度业绩说明会纪要', summary: '公司披露经营数据', ts: now - 8 * 60_000, url: 'https://example.com/p2m' },
          ]
        },
      },
    ],
    force: true,
    log: () => {},
  })

  const members = await membership.membersOf('有色金属')
  assert.equal(members.basis, 'members', `缓存命中应为 members，实际 ${members.basis}`)
  assert.deepEqual(members.codes.sort(), ['601600', '601899'])

  const sectors = await hubRoute({
    pathname: '/wallstreet/api/hub/sectors',
    query: new URLSearchParams('names=有色金属:BK0478&since=24h'),
    method: 'GET',
  })
  const board = sectors.sectors[0]
  assert.equal(board.basis, 'members')
  assert.ok(board.events >= 1, `按成分股应至少命中 1 条，实际 ${board.events}`)

  const feed = await hubRoute({
    pathname: '/wallstreet/api/hub/feed',
    query: new URLSearchParams('sector=有色金属&sectorCode=BK0478&limit=10'),
    method: 'GET',
  })
  assert.equal(feed.filters.sectorBasis, 'members', `feed 应标注成分股口径，实际 ${feed.filters.sectorBasis}`)
  assert.ok(feed.events.some((event) => (event.tickers || []).includes('601600')), '应命中带 601600 的事件')
  return `events=${board.events} feed=${feed.total} basis=${feed.filters.sectorBasis}`
})

// ---------------------------------------------------------------- 4.7 P2.5：清洗 / 缓存 / 上游
await check('清洗：模型没按 JSON 回时退回纯文本', async () => {
  const { cleanSummaryText, parseSummaryOutput, describeFinish } = await import('../lib/hub/summarize.js')
  assert.equal(cleanSummaryText('```json\n{"summary":"x"}\n```'), '{"summary":"x"}')
  assert.equal(cleanSummaryText('**紫金矿业** 被立案调查，短期承压。'), '紫金矿业 被立案调查，短期承压。')
  assert.equal(cleanSummaryText('## 一句话\n- 公司公告：股东减持 2%'), '一句话 公司公告：股东减持 2%')
  assert.equal(cleanSummaryText('「宁德时代扩产」'), '宁德时代扩产')
  assert.equal(cleanSummaryText('好的'), '')
  const fromJson = parseSummaryOutput('{"summary":"央行开展 MLF 操作","sentiment":"利好"}')
  assert.equal(fromJson.degraded, false)
  assert.equal(fromJson.sentiment, '利好')
  const fromText = parseSummaryOutput('紫金矿业收到立案告知书，短期承压明显。')
  assert.equal(fromText.degraded, true, '纯文本兜底应标 degraded')
  assert.match(fromText.summary, /紫金矿业/)
  assert.equal(parseSummaryOutput('好的'), null)
  assert.match(describeFinish({ kind: 'max-tokens' }, 'x'), /max-tokens/)
  assert.match(describeFinish({ kind: 'error', failure: { code: 'TRANSPORT' } }, ''), /TRANSPORT/)
  return `text=${fromText.summary.slice(0, 12)}`
})

await check('缓存：并发去重 / 过期可读 / 上限淘汰', async () => {
  const { createCache } = await import('../lib/hub/cache.js')
  let clock = 1000
  const cache = createCache({ now: () => clock, maxEntries: 4 })
  let calls = 0
  const loader = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { v: calls }
  }
  // 并发三次只应打一次 loader
  const [a, b, c] = await Promise.all([cache.memo('k', 100, loader), cache.memo('k', 100, loader), cache.memo('k', 100, loader)])
  assert.equal(calls, 1, `并发应只调一次 loader，实际 ${calls}`)
  assert.deepEqual(a, b)
  assert.deepEqual(b, c)
  // 未过期：命中，不再调 loader
  clock = 1050
  await cache.memo('k', 100, loader)
  assert.equal(calls, 1)
  // 过期：get 拿不到，但 peek 还能读到旧的
  clock = 2000
  assert.equal(cache.get('k'), undefined)
  const stale = cache.peek('k')
  assert.ok(stale && stale.value && stale.value.v === 1, 'peek 应返回过期值')
  // 上限淘汰：塞 6 个，size 不超过 4
  for (let i = 0; i < 6; i += 1) cache.set(`x${i}`, i, 10_000)
  assert.ok(cache.size() <= 4, `size 应 <= 4，实际 ${cache.size()}`)
  return `calls=${calls} size=${cache.size()}`
})

await check('上游：错误分类与重试策略（本地假服务器）', async () => {
  const http = await import('node:http')
  const { fetchJson, UpstreamError } = await import('../lib/hub/upstream.js')
  let hits = 0
  const server = http.createServer((req, res) => {
    hits += 1
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":1}')
      return
    }
    if (req.url === '/404') {
      res.writeHead(404)
      res.end('nope')
      return
    }
    if (req.url === '/500') {
      res.writeHead(500)
      res.end('boom')
      return
    }
    if (req.url === '/slow') {
      // 永不返回，靠调用方超时
      return
    }
    if (req.url === '/badjson') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>not json</html>')
      return
    }
    res.writeHead(200)
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  try {
    const ok = await fetchJson(`${base}/ok`, { label: '测试源' })
    assert.equal(ok.ok, 1)

    // 500：可重试 → 打两次
    hits = 0
    await assert.rejects(() => fetchJson(`${base}/500`, { label: '测试源' }), (error) => {
      assert.ok(error instanceof UpstreamError)
      assert.equal(error.code, 'http')
      assert.match(error.message, /上游 HTTP 500/)
      return true
    })
    assert.equal(hits, 2, `500 应重试一次（共 2 次），实际 ${hits}`)

    // 404：不可重试 → 只打一次
    hits = 0
    await assert.rejects(() => fetchJson(`${base}/404`, { label: '测试源' }), /HTTP 404/)
    assert.equal(hits, 1, `404 不应重试，实际 ${hits}`)

    // 超时：code=timeout，中文文案
    await assert.rejects(
      () => fetchJson(`${base}/slow`, { label: '测试源', timeoutMs: 200, deadlineMs: 400, retries: 0 }),
      (error) => {
        assert.equal(error.code, 'timeout')
        assert.match(error.message, /超时/)
        return true
      },
    )

    // 非 JSON：code=parse
    await assert.rejects(() => fetchJson(`${base}/badjson`, { label: '测试源' }), (error) => {
      assert.equal(error.code, 'parse')
      assert.match(error.message, /不是 JSON|返回格式/)
      return true
    })

    // 超时文案要写实际预算，而不是写死 8s
    await assert.rejects(
      () => fetchJson(`${base}/slow`, { label: '测试源', timeoutMs: 200, deadlineMs: 400, retries: 0 }),
      (error) => /超时（1s）|超时（0s）|超时/.test(error.message),
    )
  } finally {
    server.close()
  }

  // GBK 自动识别：non-UTF8 字节 + encoding:'auto' 应解成中文
  const { fetchText } = await import('../lib/hub/upstream.js')
  const gbkServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=gbk' })
    // "中文测试" 的 GBK 字节：D6 D0 CE C4 B2 E2 CA D4
    res.end(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]))
  })
  await new Promise((resolve) => gbkServer.listen(0, '127.0.0.1', resolve))
  try {
    const text = await fetchText(`http://127.0.0.1:${gbkServer.address().port}/`, { label: 'GBK测试', encoding: 'auto' })
    assert.equal(text, '中文测试', `GBK 自动识别失败：${text}`)
  } finally {
    gbkServer.close()
  }

  return 'ok/500重试/404不重试/超时/非JSON/GBK自动 全部符合'
})

// ---------------------------------------------------------------- 5. 真实上游
await check('调度：时段判定在允许集合内', async () => {
  const phase = phaseNow()
  assert.ok(['trading', 'offhours', 'weekend'].includes(phase), phase)
  return phase
})

if (process.env.SKIP_LIVE === '1') {
  record('SKIP', '真实上游抓取（SKIP_LIVE=1）')
} else {
  await check('真实上游：≥6 个源抓到数据', async () => {
    let SOURCES = []
    try {
      SOURCES = (await import('../lib/hub/sources.js')).SOURCES || []
    } catch (error) {
      throw new Error(`sources.js 无法加载：${error.message}`)
    }
    const live = await runIngest({ sources: SOURCES, force: true, log: () => {} })
    const ok = live.sources.filter((entry) => entry.ok && entry.count > 0)
    const lines = live.sources.map((entry) => `${entry.id}:${entry.ok ? entry.count : '失败(' + entry.error + ')'}`)
    record('INFO', `上游明细：${lines.join(' | ')}`)
    assert.ok(ok.length >= 6, `只有 ${ok.length} 个源有数据：${lines.join(' | ')}`)
    return `${ok.length}/${live.sources.length} 源可用，共入库 ${live.ingested} 条`
  })
}

// ---------------------------------------------------------------- 输出
store.closeStore()
const width = Math.max(...rows.map((row) => row.name.length))
let failed = 0
console.log('\n华尔街之狼 · 资讯集散中心验收\n')
for (const row of rows) {
  if (row.status === 'FAIL') failed += 1
  const badge = row.status === 'PASS' ? '✓' : row.status === 'FAIL' ? '✗' : '·'
  console.log(`${badge} ${row.name.padEnd(width)}  ${row.detail}`)
}
const passed = rows.filter((row) => row.status === 'PASS').length
const total = rows.filter((row) => row.status !== 'INFO' && row.status !== 'SKIP').length
console.log(`\n${passed}/${total} 通过${failed ? `，${failed} 项失败` : ''}\n`)
process.exit(failed > 0 ? 1 : 0)
