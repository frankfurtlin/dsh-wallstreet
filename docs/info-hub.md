# 信息资讯集散中心（dsh-wallstreet info hub）

> 契约文档。**代码以本文件为准**；实现与本文冲突时先改本文再改代码。
> 版本：v1 · 2026-11-25 · P0 契约（入站 → 归一化 → 聚簇 → 打标 → 分发）

## 0. 一句话

**条目进，事件出。** 多源抓取归一化成 `item`，同事件多条聚成 `event`，规则打标打分，
从三个入口分发：面板「资讯」tab、agent tool `wallstreet_news`、`/wallstreet/api/hub/*`。

## 1. 文件归属（并行开发时不要越界）

| 文件 | 所有者 | 职责 |
|---|---|---|
| `lib/hub/sources.js` | 源适配器 | 每个上游一个 adapter，只负责 fetch + normalize |
| `lib/hub/schema.js` | 核心 | item/event 构造、id 生成、文本清洗、时间归一 |
| `lib/hub/store.js` | 核心 | node:sqlite 落库、查询、清理 |
| `lib/hub/tagging.js` | 核心 | 规则打标（事件类型 + 个股/板块 + 重要度） |
| `lib/hub/ingest.js` | 核心 | 调度、并发、去重、聚簇、写入 |
| `lib/hub/index.js` | 核心 | 装配：路由 + tool + 定时器 |
| `lib/index.js` | 核心 | 挂 `/wallstreet/api/hub/*`、注册 tool |
| `client.js` | 面板 | 新增「资讯」view |
| `verification/verify-hub.mjs` | 核心 | 端到端验收 |

## 2. item（归一化后的单条）

```js
{
  id: string,          // 稳定去重键：sha1(source + '|' + (url || title))，由 schema.itemId() 生成
  ts: number,          // epoch ms，内容发布时间（不是抓取时间）；拿不到时间用抓取时间但要标 degraded
  source: string,      // adapter id，见 §4
  sourceLabel: string, // 中文源名，展示用
  kind: string,        // 'flash' | 'announcement' | 'report' | 'policy'
  title: string,       // 必填，已清洗，<=120 字
  summary: string,     // 可为 ''，<=200 字
  url: string,         // 可为 ''，原文链接
  tickers: string[],   // 6 位代码（600519），从标题/摘要/源字段抽；可空数组
  sectors: string[],   // 行业/板块中文名；可空数组
  eventType: string,   // 源层留 ''，由 tagging 填
  importance: number,  // 源层留 0，由 tagging 重算 0–100
  degraded: boolean    // true = 时间或用料是兜底值，UI 要标
}
```

## 3. source adapter 接口（`lib/hub/sources.js`）

```js
export const SOURCES = [
  {
    id: 'sina',            // 与 §4 表一致
    label: '新浪财经',
    kind: 'flash',
    intervalMs: 120000,    // 该源建议刷新间隔（盘中口径）
    enabled: true,
    async fetch() { /* 返回 item[]，按 §2 字段填；失败 throw new Error('中文原因') */ },
  },
]
```

硬性要求：

- **只用 fetch**，不引第三方包、不起浏览器、不 spawn 进程；单请求 8s 超时（`AbortSignal.timeout`）。
- 带 `user-agent`（Mozilla/5.0 桌面）+ 必要的 `referer`；GBK 源自行解码（`TextDecoder('gbk')`）。
- 永不返回 `undefined`；空结果返回 `[]`；单条字段非法就跳过那一条，不整源失败。
- 一个源失败**不得**影响其它源；`fetch()` 抛出的错误信息会被写进 `/hub/stats` 的 `lastError`，请写人话（如「上游 403」）。
- 同源返回按 `id` 去重后再返回。
- 时间戳：能拿到原始秒/毫秒就用；拿不到就 `Date.now()` 并 `degraded: true`。

## 4. 源清单（P0 目标）

| id | label | kind | 端点 | 实测状态（2026-11-25） |
|---|---|---|---|---|
| `sina` | 新浪财经 | flash | `feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516` | ✅ 200 |
| `wscn` | 华尔街见闻 | flash | `api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel` | ✅ 200（**原域名 api-one.wallstcn.com 已挂，必须用 awtmt**） |
| `cninfo-sz` | 巨潮·深市公告 | announcement | `www.cninfo.com.cn/new/hisAnnouncement/query` POST | ✅ |
| `cninfo-sh` | 巨潮·沪市公告 | announcement | 同上，column=sse | ✅ |
| `em-ann` | 东财公告 | announcement | `np-anotice-stock.eastmoney.com/api/security/ann` | ✅ 200 |
| `em-report` | 东财研报 | report | `reportapi.eastmoney.com/report/list` | ✅ 200 |
| `gov-policy` | 国务院政策 | policy | `www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json` | ✅ 200 |
| `cls` | 财联社 | flash | 直连 404（要签名）；改读 `<market-report>/data/market_data.json` 的 `cls_news` | ✅ 间接 |
| `pbc` | 央行 | policy | `pbc.gov.cn` 公告页 | ⚠️ 待验（302） |
| `csrc` | 证监会 | policy | `csrc.gov.cn` | ⚠️ 待验（301） |
| `stats` | 统计局 | policy | `stats.gov.cn` | ⚠️ 待验 |
| `sina-global` | 新浪·全球市场 | flash | 新浪滚动其它 lid | ⚠️ 待验 |

不可用的源把 `enabled: false` 留着并写明原因，不要删——审计要能看见为什么没有它。

## 5. event（聚簇结果）

```js
{
  id: string,              // 聚簇主键 = 簇内最早 item 的 id
  ts: number,              // 首曝时间
  lastTs: number,          // 最后一次被同一事件刷新
  title: string,           // 代表标题（首曝条目，可加后缀「等 N 家报道」由 UI 拼）
  summary: string,
  url: string,             // 首选链接
  kind: string,
  sourceCount: number,     // 簇内不同 source 数量
  sources: [{ source, label, title, url, ts }],  // 最多 8 条，按时间升序
  tickers: string[],       // 簇内并集
  sectors: string[],
  eventType: string,       // 取簇内最高频，平票取更重要类型
  importance: number       // 簇内最大值
}
```

聚簇规则（P0 够用即可，P1 再调）：

1. 时间窗 ±90 分钟；2. 共享至少 1 个 ticker，或标题 3-gram Jaccard ≥ 0.58；
3. 同 kind 才聚；4. 已聚入的 item 不重复成簇。

## 6. HTTP API（都过 DSH 登录闸门，`GET` 除 sync 外）

### `GET /wallstreet/api/hub/feed`

查询参数（都可省）：`since`（epoch ms 或 ISO）、`limit`（默认 50，上限 200）、
`kind`、`source`、`ticker`、`sector`、`eventType`、`minImportance`、`q`（标题模糊）。

```js
{ ok: true, fetchedAt: 'ISO', total: 1234,
  stats: { items: 5000, events: 900, lastIngestAt: 'ISO', sources: 8 },
  events: [ /* §5 */ ] }
```

### `GET /wallstreet/api/hub/stats`

```js
{ ok: true, items: 0, events: 0, span: { first: 0, last: 0 }, lastIngestAt: 'ISO',
  bySource: [{ id, label, count, lastOk, lastError, lastErrorAt }],
  byKind: [{ kind, count }],
  byEventType: [{ eventType, count }] }
```

### `POST /wallstreet/api/hub/sync`

立即跑一轮入站，返回 `{ ok, ingested, elapsedMs, sources: [{ id, ok, count, error }] }`。
宿主默认自己定时跑，这个接口只给面板「立即同步」和验收脚本用。

## 7. agent tool（`lib/hub/index.js` 导出，`lib/index.js` 注册）

```
wallstreet_news({
  query?: string,        // 标题/摘要模糊词
  ticker?: string,       // 6 位代码
  sector?: string,
  kind?: 'flash'|'announcement'|'report'|'policy',
  sinceHours?: number,   // 默认 24
  limit?: number,        // 默认 20，上限 50
  minImportance?: number // 0–100
})
```

返回纯文本（每行一条事件，时间 + 事件类型 + 标题 + 来源数 + 链接），末尾一行统计；
无结果返回「近 N 小时没有匹配的资讯」。**不要**返回原始 JSON 给模型。

## 8. 面板「资讯」view

- 工具栏 tab：`{ id: 'news', label: '资讯' }`，插在「异动」之后。
- 顶部一行统计：今日事件数 / 入库条目 / 最近同步时间 / 「立即同步」按钮。
- 筛选行：kind chips（全部 / 快讯 / 公告 / 研报 / 政策）+ 关键词输入 + 个股代码输入。
- 事件列表：时间、标题、`N 家` 角标、eventType 徽标、ticker chips、重要度点（>=70 红色）；
  点击展开显示簇内各源标题与原文链接（`target=_blank rel="noopener noreferrer"`）。
- 轮询 60s，页面隐藏时暂停；样式复用现有 `COLORS` / `Card` / `Table` / `Pill` 组件，不引新依赖。

## 9. 验收

```bash
node --check lib/hub/sources.js && node --check lib/hub/store.js   # 语法
node verification/verify-hub.mjs                                    # 源/库/API/tool 四段
```

真面板：`webpilot_*` 打开 `/wallstreet` → 切「资讯」→ 断言事件数 > 0、筛选生效 → 截图。

## 10. 落地状态（2026-11-25 P0 完成）

### 与本文的偏离（都已生效，以此处为准）

| 项 | 契约原写 | 实际实现 | 原因 |
| --- | --- | --- | --- |
| 源数量 | 12 个目标 | 11 个启用 + 1 个 `csrc` disabled | 证监会静态列表冻结在 2021-12，新接口恒返回 0；不拿时政冒充 |
| `sina-global` | 「新浪滚动其它 lid」 | `zhibo.sina.com.cn` 7×24 feed + 市场相关性过滤 | 实测 2510/2511/2515 是时事/科技，无市场频道 |
| `cls` | `time: 'YYYY-MM-DD HH:mm:ss'` | 实际只有 `HH:MM:SS`，日期借同文件 `fetch_time` | 快照字段如此 |
| `feed.stats` | `{items, events, lastIngestAt, sources}` | 另加 `todayEvents` / `today` / `todaySince` / `phase` | 面板要「今日事件数」，避免前端按当前页现算 |
| 聚簇阈值 | 单一 0.58 Jaccard | 按 kind 分档 + LCS 混合相似度 | 公告用同一阈值会把同一只票的多份公告揉成一条（实测 4 份神雾节能公告被并成 1） |
| 清理口径 | 未写 | 按 `ingested_at`（抓取时间）保留 30 天 | 按发布时间清理会让政策/央行文档入库即被删（实测 gov-policy 40→9、pbc 20→0） |
| 今日事件 | 未写 | `beijingDayStart()` 按北京时间零点切 | 「今日」必须与用户直觉一致 |

### 已知不足（P1 优先）

1. **跨源正文没有比对**：只按标题聚簇，同一事件两家标题差异大时仍是两条（可加正文首段相似度）。
2. **重要度是启发式**：政策类基准偏高，「国务院节假日通知」这类仍能进前几（已用 `DEMOTE_WORDS`
   降 22 分，但从 70 降到 48，仍高于个股公告），P2 可以按「是否含标的/是否影响交易」重排。
3. **没有时间轴对齐**：板块异动与事件还没打通，「某板块为什么涨」需要人工对照。
4. **面板没做源健康度卡片**：`/hub/stats` 已返回 `bySource`，前端只用了数量与最近同步时间。
5. **沪市公告只有日期没有时分**：巨潮 `announcementTime` 对沪市只到天（全 00:00:00），
   这类条目按时间排序会沉到当天末尾；同一公告若东财也抓到（有真实时分），聚簇后事件的
   `last_ts` 会取到真实时间，问题自愈。只有「仅巨潮独有」的公告会显示 00:00。

## 11. P1（2026-11-25 下午）：盘面对齐 / 源健康度 / 跨源正文去重

### 11.1 跨源正文去重（已完成，后端）

聚簇时若标题相似度不达标，再比一次**摘要前 80 字**的 3-gram Jaccard：

```
qualifies = 标题相似度 >= 分档阈值
         或 (摘要相似度 >= 0.55 且 (共享个股 || 共享板块 || 标题相似度 >= 0.3))
```

为什么限制在 80 字：摘要最长 200 字，两两全量比较在中盘高峰期（几百条 × 几百个候选）
会把 CPU 打满；80 字已经能覆盖「同一事件不同写法」的开头部分。公告类 `summary` 多为空，
因此天然不参与这条通道，不会被误并。

### 11.2 板块对齐（已完成，后端）

东财的行业板块切得极细（`水产养殖` / `集成电路封测` / `电子化学品Ⅲ`），跟我们打标用的
板块词表不同源，直接按名字相等过滤会永远 0 条。三层兜底：

1. `normalizeSector()` 去后缀（行业/板块/概念/指数/服务/制造/设备/产业）；
2. `sectorVariants()` 产出别名（有色金属→有色/铜/铝/黄金）+ 长名拆 2 字窗口（水产养殖→水产/养殖）；
3. 查询时把「板块字段命中」和「标题出现核心词」放进**同一个 OR 组**（不是 AND，否则几乎永不成立）。

### 11.3 新增接口

#### `GET /wallstreet/api/hub/sectors`

两种模式：

| 参数 | 返回 | 用途 |
|---|---|---|
| `since=24h&limit=60` | `{ok, since, total, sectors:[{name, events, lastTs, importance, tickers[]}]}` | 板块热度总览（我们自己的板块词表） |
| `names=水产养殖,半导体,...&since=24h` | `{ok, mode:'names', total, sectors:[{name, events, lastTs}]}` | 盘面「板块轮动」每行挂「资讯 N」徽标，16 个名字一次请求 |

`/hub/feed` 的 `sector` 参数同样走 11.2 的三层兜底，`titleHints` 由后端内部展开，前端不用管。

### 11.4 面板（P1 已完成）

- 资讯 tab：板块筛选输入 + 事件行板块 chips + 源健康度折叠卡（读 `/hub/stats` 的 `bySource`，
  失败源标红并显示最近错误）。✅
- 盘面「板块轮动」：每行右侧「资讯 N」徽标（`/hub/sectors?names=` 一次请求 16 个板块）；
  点击整行 → 切到资讯 tab 并带 `sector=<板块名>`，资讯页顶部显示「来自盘面：板块名 ×」。✅
- 日期级事件：后端在 `decodeEvent` 里给 `timeUnknown` 标记（`last_ts` 落在北京时间 00:00 整），
  面板显示「当日」而不是 00:00。✅
- 已知口径：徽标数按「相关资讯」算——标题里出现板块核心词也会计入，所以「半导体设备 / 半导体材料 /
  电子化学品」在半导体大跌日会同时偏高。这不是 bug，是三级行业分类天然重叠；要精确到个股归属
  需要成分股映射（P2）。

## 12. P2（2026-11-25 下午）：成分股映射 / 重要度模型 / AI 摘要

### 12.1 板块成分股映射

目标：把「板块 → 资讯」从关键词升级成成分股。数据源是东财行业板块成分
（`fs=b:BKxxxx`），但 **push2 在这台机器上是间歇性 RST**（README 有史），所以设计成
「按需懒取 + 本地缓存 + 失败回退」：

1. 面板从 `/overview` 直接拿得到板块代码（`BK1326` 这类），点板块时把 `名字:代码` 传给
   `/hub/sectors`，后端不需要先翻板块名单；
2. 请求路径**只读缓存**，缺的丢进后台队列（每 30 秒最多 3 个、串行 1.2 秒间隔）；
3. 抓到就落 `data/sector-members.json`（板块 → 成分股），之后一直用；
4. 失败退避 30 分钟；全程失败就退回关键词口径，响应里用 `basis` 标明当前口径
   （`members` / `keywords`），面板徽标的 title 也会写清楚。

`/hub/sectors?names=半导体设备:BK1326,...` 与 `/hub/feed?sector=X&sectorCode=BK1326`
都会优先走成分股；`/hub/stats` 的 `membership` 字段给缓存健康度（板块数/股票数/待补/最近失败）。

> 现状（2026-11-25 15:40）：东财 push2 主域与 82/48 子域全部返回 `http 000`，
> 只成功抓到 2 个板块（银行、水产养殖，46 只）；其余板块徽标仍是关键词口径。
> 上游恢复后后台队列会自动补，不需要人工干预。

### 12.2 重要度模型 v2（可解释）

分数 = 分量之和，每个分量都能单独说清：

| 分量 | 取值 | 说明 |
|---|---|---|
| `kind` | 政策 30 / 公告 34 / 研报 26 / 快讯 22 | 类型基准 |
| `type` | 0–22 | 事件类型权重 ×0.9 |
| `ticker` / `multi` | +8 / +5 | 涉及个股 / 多标的 |
| `watch` | +8 | 命中持仓（来自持仓快照） |
| `hot` | +6 | 命中当日涨停池 / 龙虎榜 |
| `market` | +5 | 标题含交易相关词（降准/关税/涨停/解禁…） |
| `demote` | −26 | 政务流水账（节假日/保护区/表彰…），并**封顶 42** |
| `degraded` | −4 | 时间兜底 |
| `diffusion` | 0–10 | 事件级：不同源个数 ×4，最多 +10 |

另有一条硬约束：政策/政策法规类**没有市场相关词就封顶 58**，避免「节假日安排」这类
通知挤进重要度前列。

分量随事件返回（`importanceParts`），面板红点 hover 显示拆解；老库通过启动时的
规则回填（`rescoreRecent`）补齐。

### 12.3 AI 摘要

- 模型走宿主自己的 `ctx.llm`（同账号同配额），不引第三方 key；
- 触发：每 5 分钟一轮，`POST /hub/summarize` 可手动跑一轮；
- 闸门：`importance >= 62`（`DSH_WALLSTREET_LLM_MIN`）、每轮最多 3 条
  （`DSH_WALLSTREET_LLM_MAX`）、只处理 24 小时内入库、同一事件只写一次、
  `DSH_WALLSTREET_LLM=0` 可整体关闭；
- 输出严格是 JSON（`{summary, sentiment, impact}`），解析失败只记日志不写库；
- 面板：事件标题下多一行「AI 中性 <摘要>」，AI 角标 hover 显示模型名；
  tool 输出里带 `AI：<摘要>（<倾向>）`；
- 踩过的坑：`messages[].content` 必须是内容块数组
  （`[{type:'text',text}]`），传字符串上游会报 `content.some is not a function`；
  opencode-go 这类 provider 还要求 `sessionId` 字段，缺了拿不到内容。

## 13. P3（2026-11-25 傍晚）：对照同类插件后的七处收口

来源：[docs/prior-art-2026-11-25.md](./prior-art-2026-11-25.md)。七处全部落地。

### 13.1 新增 `lib/hub/upstream.js`（统一上游调用）

| 规则 | 说明 |
|---|---|
| UA 自报 | `dsh-wallstreet/0.7 (+…)`；东财部分边缘节点对 Node 默认 UA 直接 403 |
| 超时 + 预算内重试 | 单请求 8s、总预算 12s；`attempt > 0` 前先算「还来不来得及」，来不及就不发起 |
| 重试分类 | 只重试 `timeout` / `network` / 5xx / 429；4xx 与 parse 是 `fatal`，不重试 |
| 错误带 code | `timeout / network / http / parse / aborted / rejected`，message 是中文人话，面板「最近失败」直接显示 |
| 超时文案 | 取**本次实际预算**，不写死 8s（源改成 3s 时不会谎报） |
| `fetchText` | 与 `fetchJson` 同一套重试；`encoding:'auto'` = 严格 UTF-8 失败后退 GBK（一次请求内解决） |

`sources.js` 里现在零裸 `fetch(`、零自实现超时（验收脚本会静态断言这两条）。

### 13.2 新增 `lib/hub/cache.js`（三档缓存）

`memo(key, ttl, loader)`（命中即返回，**并发调用共用一个 Promise**，防一次刷新打 N 个相同上游）/
`peek(key)`（**过期也读得到**，返回 `{value, staleMs}`）/ `set(key, value, ttl, {storedAt})` /
`setStale(key, value)` / `delete` / `clear` / `size`。上限 `maxEntries` 后按最旧淘汰。

### 13.3 新增 `em-flash` 源（东财快讯）

`np-listapi.eastmoney.com/comm/web/getNewsByColumns?...&column=344&req_trace=1`。
两个坑：① **必须带 `req_trace=1`**，不带返回 87 字节的 `{"code":0,...}` 错误信封，
所以要判断信封 `code`（成功是字符串 `"1"`）而不是只看 `response.ok`；
② 该域名与 `push2`（行情）是**独立限流**的不同子服务——push2 全 RST 时它照样通，
所以不能把两者的失败合并判断。标题缺失时取 summary 里的【导语】或首句（≤46 字），链接统一升 https。

### 13.4 板块列表改「市值排序一页拿全」

`fid=f20`（市值）+ `pz=150` + `fs=m:90+t:2`，请求数从 5 页降到 1 页（满页才补第 2 页）；
成分股 `fid=f6`（成交额降序）+ `pz=400`，单页被压到 100 条时按 `data.total` 翻页补齐（最多 4 页，
页间 1.2s）。名单与成分股都进 `cache.js`，**抓取失败用 `peek` 拿过期值顶上并标 `stale: true`**。

> 顺带修掉一个真 bug：上一版 `fetchJsonWithHosts` 引用了未定义的 `PUSH_HOSTS`，
> 抛 `ReferenceError` 后被 catch 吞掉 → 板块名单**从来没刷新成功过**，一直吃磁盘里那份 100 条的旧数据。
> 这也解释了「为什么只缓存到 2 个板块」——不全是 RST 的锅。

### 13.5 AI 摘要：预算、失败分类、两级清洗

| 项 | 旧 | 新 |
|---|---|---|
| `maxTokens` | 700 | **4096**（同类插件实测：200→7/20、1024→12/20、4096→20/20；推理 token 与正文共享预算） |
| 失败可见性 | 只有 journal | `summaryStatus().failures` = 最多 3 类原因 + 次数，进 `/hub/stats` 与 tool 脚注 |
| 输出解析 | 只认 JSON，失败整条丢 | **两级**：JSON 优先，失败退回 `cleanSummaryText()`（去围栏/引号书名号/markdown 前缀/压空白，<6 字视为废话），并标 `degraded` |
| 失败退避 | 30 分钟 | 不变，另按原因归类，避免「高分事件反复烧额度」 |

### 13.6 验证

| 项 | 结果 |
|---|---|
| `npm run verify:hub`（含真实上游） | ✅ **25/25**，12/12 源可用，314 条入库 |
| `node verification/verify-sources.mjs` | ✅ 12/12 启用源 >0 条；em-flash 8 条离线契约断言全过 |
| 新增单测 | 清洗兜底、缓存并发去重/过期可读/上限淘汰、上游 500 重试·404 不重试·超时·非 JSON·GBK 自动识别（本地假服务器） |
| 面板 | ✅ 源健康度卡显示 12 个源，含「东财快讯」 |

### 13.7 两个口径修正（改源之后暴露出来的）

1. **次日披露日不再压过当天实时资讯**：巨潮盘后发的公告，`announcementTime` 写的是**次日 00:00**
   （11-25 晚上发的，标 11-26）。原本按 `last_ts` 排序，这些「明天的公告」直接占满列表顶部。
   改成排序键取 `MIN(last_ts, created_at)`：正常资讯 `last_ts` 是发布时间、`created_at` 是收到时间（更晚），
   取小值等于发布时间；次日公告的 `last_ts` 在未来，取 `created_at` = 实际收到时间，
   于是与当晚的实时资讯按到达顺序交错。**显示仍用真实披露日**。
2. **面板把未来日期标成「次日」**：`hubTimeText()` 原来对日期级事件统一显示「MM-DD 当日」，
   晚上看会像穿越。现在「日期在今天之后」显示「MM-DD 次日」；判定条件是「不同一天且时间在未来」，
   不能用「差 6 小时」——18:30 看次日 00:00 只差 5.5 小时。

### 13.8 现状（2026-11-25 18:40）

```
12 个源 · 全部正常（含新增「东财快讯」）
今日事件 1,558 · 全库事件 1,628 · 入库条目 2,266
AI 摘要 21+ 条，失败按原因分类（「请求被中止」「上游报错 TRANSPORT」各 1）
成分股缓存 2 个板块 / 46 只 · 待补 7（东财 push2 仍 RST）
```

## 14. P4（2026-11-25 晚）：源配置面 + 测试按纯函数拆分

### 14.1 源配置面（面板里开关源 / 调抓取间隔）

原先 13 个适配器的开关与间隔全写死在 `sources.js`，关一条噪音源都要改代码重载插件。
现在抽成配置层：

- `lib/hub/config.js`：`loadConfig` / `saveConfigUpdates` / `effectiveSources` / `describeSources` /
  `normalizeInterval`，落 `data/hub-settings.json`（原子写：先写 `.tmp` 再 rename）。
- 校验在**后端**：间隔夹在 30 秒–6 小时、未知 source id 直接报错、整批失败不落一半。
- `ingest.loadSourceList()` 每轮重新读配置 → 面板改完**下一轮入站就生效**，不用重载插件。
- API：`GET /wallstreet/api/hub/config`（默认值与有效值并排 + `overridden` 标记）、
  `POST /hub/config`（`{sources:[{id,enabled,intervalMs}]}`）。
- 面板：「数据源」展开后点「配置源」→ 逐源 启用/停用 + 间隔下拉（1/2/5/10/30 分钟、1 小时；
  当前值不在预设里时自动补进去），未保存改动标「已改（未保存）」，保存后回显「已保存 N 条改动」。
- 权限：和所有面板接口一样先过 DSH 登录闸门；`POST` 只对 `/hub/sync`、`/hub/summarize`、
  `/hub/config` 三个路由开放，其余仍是只读 GET。

### 14.2 测试按纯函数拆分（`npm test`）

`verification/verify-hub.mjs` 保留为端到端验收；新增 `test/*.test.mjs` 用 **内置 `node:test`**
（零依赖），共 **262 个用例 / 8 个文件**：

| 文件 | 用例 | 覆盖 |
|---|---:|---|
| `schema.test.mjs` | 40 | 时间解析（含显式时区）、文本清洗、id 稳定性、相似度边界、板块归一化 |
| `tagging.test.mjs` | 39 | 事件规则命中顺序、9 个重要度分量、封顶规则、扩散度 |
| `summarize.test.mjs` | 33 | JSON/纯文本两级解析、清洗、终止原因、消息构造（content 必须是块数组） |
| `cache.test.mjs` | 24 | 并发去重、过期可读、`setStale`、上限淘汰 |
| `upstream.test.mjs` | 29 | 本地假服务器验重试矩阵、超时文案、GBK 自动识别 |
| `ingest-pure.test.mjs` | 33 | 时段判定、到期判断、聚簇阈值与窗口边界 |
| `config.test.mjs` | 30 | 间隔夹紧、未知源拒绝、整批失败不落盘、默认值不被覆盖带偏 |
| `store.test.mjs` + 其他 | 34 | SQLite 过滤矩阵、日期级事件入窗、清理口径、摘要队列 |

跑法：`npm test`（脚本是 `node --test "test/**/*.test.mjs"`——Node 24 的 `--test` 不接受目录参数，
传目录会被当成入口模块加载）。

### 14.3 单测翻出并修掉的 6 个缺陷

| # | 缺陷 | 表现 | 修法 |
|---|---|---|---|
| D1 | `describeSources` 的默认值取自**合并后**的适配器 | 面板「默认 2 分钟」会跟着用户覆盖漂，看不出改过什么 | 默认值改回原始适配器 |
| D2 | `UpstreamError` 丢 `timeoutMs` | 二次渲染从「超时（2s）」退化成「超时」 | 构造器保留 `timeoutMs` |
| D3 | `parseSummaryOutput` 把裸 JSON 当摘要 | `{"summary":"好"}` 会原样显示成 AI 摘要 | JSON 解析成功但 summary 不合格 → 判空 |
| D4 | `toMs` 忽略显式时区 | `2026-11-25T09:30:00Z` 被当北京时间，整体偏 8 小时 | 带 `Z`/`±HH:MM` 的串交给 `Date.parse` |
| D5 | `mergeTags([null])` 抛 TypeError | 健壮性缺口 | 跳过非对象条目 |
| D6 | 环境变量把配置指到子目录时写失败 | `ENOENT ...tmp` | 建目标文件的父目录 |

另修两个「静默失效」的行为：`titleHints` 单字提示被长度过滤吞掉（板块名可能就是一个字，
如「铝」→ 筛选不生效返回全部）；`pendingSummaryEvents({minImportance:0})` 被 `|| 70` 吃成 70。

## 15. 决定不做（2026-11-25，用户明确否掉）

| 候选 | 为什么曾被列为候选 | 决定 |
|---|---|---|
| systemPrompt 注入最近 3 条资讯 | 同类 RSS 插件的做法：模型能直接引用当天要闻，不用先调工具 | **不做**。与 `wallstreet_news` 工具定位重复，且每轮都要占上下文；工具按需查更省。 |
| 词典法情感兜底（模型不可用时用正负词表打「利好/利空」） | 模型挂了还能给倾向 | **不做**。会和模型口径形成两套标准，同一事件两种倾向反而更难解释；宁可显示「无 AI 摘要」。 |

以后若再提这两项，先看这条记录。

## 16. P5（2026-11-25 21:20）：第二轮调研的六条全部落地

来源 [prior-art-2026-11-25.md](./prior-art-2026-11-25.md) §5。

### 16.1 标题相似度改「按脚本分词」

`titleSimilarity` 不再是 char-trigram 与字符 LCS 取大，而是：
`tokenSetJaccard(tokenize(a), tokenize(b))` 与**顺序侧 LCS** 取大，其中

- `normalizeText`：NFKC → 去控制字符/零宽 → 小写 → 去标点空白（CJK 直接连写）；
- `tokenize`：纯拉丁按**词**切，含 CJK 按**字符 bigram** 切（1 字退化为单字）；
- 顺序侧：任一侧含 CJK 用字符级 LCS（中文口径与以前逐位一致），两侧纯拉丁用词元级 LCS。

实测（单测里写死数值）：英文近似对 `NVIDIA beats Q3 earnings estimates`/`…estimate`
旧口径 1.0（虚高，字符碰巧重合）→ 新 0.8；英文无关对 0.42 → **0.0**；
CJK 短标题 `稀土价格上涨`/`稀土价格上调` bigram 0.6→0.667；`央行降准`/`央行宣布降准` 0→0.333。
生产库 731,831 个候选对里口径变化只有 4 对且都远离阈值，**ingest 阈值不需要调**（0.5/0.85/0.72/0.55 原样保留）。

### 16.2 模型路由三级兜底

`resolveModel` 从「只读 `agentDefaultModel`」改为：默认模型 → `llm.listProviders()`（优先 deepseek/official）
→ `llm.listModels(provider)`（优先 chat/flash/deepseek/v3/r1/pro），并且**每次调用时解析**
（HMR / 晚注册的适配器才能被尊重）。拿不到时的报错文案也改成「默认模型与 provider 列表都取不到」。

### 16.3 工具输出截断 + 只放行 http(s)

`wallstreet_news` 的每一行：标题 ≤120、AI 摘要 ≤100、链接 ≤300 且**只保留 http/https**
（`javascript:` / `data:` 直接不渲染），来源名 ≤40；整个输出 ≤8000 字符，超出写
「…（还有 N 条未列出，缩小 sinceHours 或加筛选条件）」。理由见 §5.4：外部内容的长度由上游决定，
模型侧没有任何一层会替我们截。

### 16.4 盘面接口四态契约

新增 `lib/hub/parts.js`（纯逻辑）：每分区四态——缓存新鲜 / loader 成功 / **失败但有旧值（stale）** /
连旧值都没有（`ok:false` + 错误码 `timeout|network|http|parse|empty|unknown`）。每分区独立 deadline（6s），
**超时不取消**：loader 继续跑完写进缓存，下一轮直接用。

`getOverview` 改用 `createPartsRunner`，新增 `parts: [{id, ok, ms, error?, stale?}]` 与 `partsStale`，
原有 `stale` 保持原义（收盘快照是否为上一交易日）。面板：盘面表头 hover 显示每个分区耗时与状态，
`partsStale` 时多一个「部分缓存」角标。

### 16.5 每日 Markdown/HTML 日报 + 知识库

新增 `lib/hub/digest.js`：`renderDigestMarkdown`（纯函数）、`renderDigestHtml`（知识库收 HTML）、
`generateDigest`（写 `data/digest/YYYY-MM-DD.md|.html` + `latest.*`，原子写）、`listDigests`、`publishDigest`
（调 `/root/scripts/kb/kb_publish.py`）。

- 面板：「导出日报」「发到知识库」两个按钮，结果就地回显（实测发布成功 `doc/6b06df33a756504f`）。
- 定时：每天 **23:30**（北京时间）自动生成。为什么不是收盘 15:35——A 股公告集中在 16:00–22:00，
  收盘就出会把当天最重要的一批公告漏到第二天。
- 归日口径：按**事件披露/发布时间**（`lastTs`），所以巨潮盘后标「次日」的公告进次日日报，
  与面板「次日」标注一致。
- API：`GET /hub/digest` 列历史，`POST /hub/digest` 生成（`{publish:true}` 时顺带发布）。

### 16.6 今日头版

新增 `lib/hub/frontpage.js`（`buildFrontpage` 纯函数 + `getFrontpage` 取数）与 `GET /hub/frontpage`。
面板「资讯」页顶部一张卡，一屏回答四件事：

| 区块 | 口径 |
|---|---|
| 今日要闻 | 重要度 ≥60，取前 5；**同一只票只出现一次**（3 条 \*ST 同票公告不刷屏），宁可少于 5 条也不拿同票凑数 |
| 板块热度 | 当天事件按板块计数，归一后合并，取前 3（带最高重要度） |
| 我关注的票 | 持仓快照命中的票，每只取最新一条，最多 5 条 |
| 数量 | 事件 / 多源 / 有 AI 摘要 / 源数（store 统计优先） |

外部内容同样截断（标题 140、摘要 120、AI 120）且只放行 http(s) 链接。

### 16.7 验收

| 项 | 结果 |
|---|---|
| `npm test` | ✅ **335/335**（新增 parts 11 + frontpage 12 + digest 29 + schema 21） |
| `npm run check` | ✅ 18 个 lib 文件 + client.js 语法全过 |
| 面板 | ✅ 头版卡、导出日报（10.8 KB / 1621 条）、发到知识库（`doc/6b06df33a756504f` 可查）、盘面分区耗时 hover |
| 真实上游 | ✅ `verify:hub` 25/25（12/12 源） |
