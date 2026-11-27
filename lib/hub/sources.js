/**
 * 信息资讯集散中心 · 源适配器（docs/info-hub.md §3 / §4）
 *
 * 每个 adapter 只做两件事：fetch 上游 + 归一化成 §2 的裸 item。
 * **不生成 id / eventType / importance** —— 那是 schema 层与 tagging 层的事，
 * 本文件不 import schema.js（并行开发），上层 ingest 用 sha1(source|url||title) 补 id。
 *
 * 硬约束（违反即打回）：
 *   - 上游调用统一走 lib/hub/upstream.js（`fetchJson` / `fetchText` / `UpstreamError`）：
 *     自报 UA、单请求超时、总预算内一次重试、错误带稳定 code。
 *     **本文件里不再自己写 fetch** —— 每个适配器各写一遍的结果就是 UA/超时口径不一、
 *     面板只剩一句 `fetch failed`，分不清超时、限流还是站点改版。
 *   - 零第三方依赖；不起浏览器；不 spawn 子进程；不读私有凭据。
 *   - 错误文案 = 来源名 + upstream 的中文原因（`新浪财经超时（8s）` /
 *     `见闻上游 HTTP 503` / `巨潮返回的不是 JSON`）。JSON 结构变了抛
 *     `UpstreamError(..., { code: 'parse' })`，让面板能和网络抖动分开。
 *   - GBK 页面用 `fetchText(..., { encoding: 'gbk' })`。实测这 13 个端点都是 UTF-8，
 *     没有真 GBK 页；readText 仍保留老兜底：解出替换符（U+FFFD）就按 GBK 再取一次。
 *   - 单条字段缺失 → continue；整源失败 → throw（中文人话）。
 *   - 返回前按 id 同一口径（source|url||title）去重；空结果返回 []。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 实测记录（2026-11-25，curl 直连 + node 解析，UA=插件自报 dsh-wallstreet/0.7）
 * ───────────────────────────────────────────────────────────────────────────
 * id          | 状态 | 条数 | 端点 / 关键字段 / 坑
 * ────────────┼──────┼──────┼────────────────────────────────────────────────
 * sina        |  ✅  | 30   | GET feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516
 *             |      |      | result.data[]；title/intro/url/ctime(秒)/media_name。
 *             |      |      | 注意 lid=2516 实为「港股」频道；需 referer finance.sina.com.cn。
 *             |      |      | media_name 是媒体名（新浪港股/市场资讯），不能当 sectors。
 * ────────────┼──────┼──────┼────────────────────────────────────────────────
 * wscn        |  ✅  | 30   | GET api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel
 *             |      |      | data.items[]；title 多为空串，正文在 content_text，时间
 *             |      |      | display_time(秒)，链接 uri，富文本在 content(HTML)。
 *             |      |      | **原域名 api-one.wallstcn.com 已挂，curl exit 6 / http 000，
 *             |      |      | 只能走 awtmt**。
 * ────────────┼──────┼──────┼────────────────────────────────────────────────
 * cninfo-sz   |  ✅  | 30+  | POST www.cninfo.com.cn/new/hisAnnouncement/query
 *             |      |      | **必须带 plate=sz，否则 column 被忽略**，sz/sse 会返回
 *             |      |      | 同一批全市场公告（实测 total 都是 233188）。
 *             |      |      | announcements[]；announcementTime(毫秒)；PDF 路径
 *             |      |      | static.cninfo.com.cn/<adjunctUrl>（http/https 均 200）。
 * ────────────┼──────┼──────┼────────────────────────────────────────────────
 * cninfo-sh   |  ✅  | 30+  | 同上，column=sse&plate=sh（实测 total 99353，与深市互不重叠，
 *             |      |      | 代码/URL 零交集）。**沪市 announcementTime 只到天（全 00:00:00）**，
 *             |      |      | 那是上游真实披露日，不算 degraded。
 * ────────────┼──────┼──────┼────────────────────────────────────────────────
 * em-ann      |  ✅  | 30   | GET np-anotice-stock.eastmoney.com/api/security/ann
 *             |      |      | data.list[]；codes[]{stock_code,short_name}；title 已含
 *             |      |      | 「简称:标题」；display_time 是 `YYYY-MM-DD HH:MM:SS:mm`（第 4 个冒号
 *             |      |      | 分隔毫秒，Date.parse 直吃会 NaN，须先剥掉）。详情页
 *             |      |      | data.eastmoney.com/notices/detail/<code>/<art_code>.html。
 * ────────────┼──────┼──────┼────────────────────────────────────────────────
 * em-report   |  ✅  | 20   | GET reportapi.eastmoney.com/report/list
 *             |      |      | **beginTime/endTime 必填，缺一个直接 HTTP 400**（实测）。
 *             |      |      | data[]；publishDate `YYYY-MM-DD 00:00:00.000`（只有日期）；
 *             |      |      | infoCode → data.eastmoney.com/report/zw_stock.jshtml?infocode=…
 *             |      |      | **industryName 恒为空串，行业名在 indvInduName**（半导体/电池/电力），
 *             |      |      | 那才是能进 sectors 的字段。
 * ────────────┼──────┼──────┼────────────────────────────────────────────────
 * gov-policy  |  ✅  | 1117 | GET www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json
 *             |      |      | 顶层即数组；{TITLE,SUB_TITLE,URL,DOCRELPUBTIME}，日期仅到天
 *             |      |      | （2020-01-05 ~ 2026-11-15）。全量 1117 条，取最新 40。
 * ────────────┼──────┼──────┼────────────────────────────────────────────────
 * cls         |  ✅  | 20   | 直连财联社 404（要签名，不试）。改读
 *             |      |      | /root/workspace/plugins/dsh-wallstreet/data/market_data.json 的 cls_news。
 *             |      |      | **实际 time 字段是 `HH:MM:SS` 而不是契约写的完整日期**，
 *             |      |      | 日期只能从同文件 fetch_time 借（本文件为 2026-11-24 15:11:01）；
 *             |      |      | 文件缺失一律返回 []，不抛错。
 * ────────────┼──────┼──────┼────────────────────────────────────────────────
 * pbc         |  ✅  | 20   | GET www.pbc.gov.cn/tiaofasi/144941/144979/index.html（规章/征求意见）
 *             |      |      | http 会 302 到 https，直接写 https。列表是 table 老式 HTML，
 *             |      |      | 链接里带 19 位时间码 `2026101615545554309`（前 14 位 YYYYMMDDHHMMSS），
 *             |      |      | 标题被截断成「…」，必须取 <a title="完整标题"> 属性。
 * ────────────┼──────┼──────┼────────────────────────────────────────────────
 * csrc        |  ❌  | 0    | **禁用**。c100028/news 静态列表页内容冻结在 2021-12-10
 *             |      |      | （带 cache-buster 也一样），新列表由 /searchList/c100028 渲染，
 *             |      |      | 该接口现在恒返回 {total:0}（频道 id 已迁移）。无可解析内容。
 *             |      |      | 同站 c100027「时政要闻」是新鲜的（2026-11-24），但那是时政非证监会，
 *             |      |      | 拿它冒充会误导用户，故不采用。
 * ────────────┼──────┼──────┼────────────────────────────────────────────────
 * stats       |  ✅  | 15   | GET www.stats.gov.cn/sj/zxfb/
 *             |      |      | UTF-8 HTML；`<li><a class="fl pc_1600" href="./202611/t…_…html"
 *             |      |      | title='…'>…<span>YYYY-MM-DD</span>`；日期只到天。
 *             |      |      | 注意文件名是 `t20261123_1965935.html`（中间有下划线），
 *             |      |      | 写成 `t\d+\.html` 会 0 命中。
 * ────────────┼──────┼──────┼────────────────────────────────────────────────
 * sina-global |  ✅  | 20   | GET zhibo.sina.com.cn/api/zhibo/feed?zhibo_id=152（7×24 全球快讯）
 *             |      |      | 契约只写「新浪滚动其它 lid」；实测 lid=2510/2511/2515 是
 *             |      |      | 国内/国际时事/科技，不是市场；2516/2517 回流港股。真正含
 *             |      |      | 国际/宏观/全球市场的快讯在 7×24 feed：
 *             |      |      | result.data.feed.list[]；rich_text(HTML)、create_time(完整时间)、
 *             |      |      | tag[].name（国际/宏观…）、docurl（逐条唯一，19/20）。
 * ────────────┼──────┼──────┼────────────────────────────────────────────────
 * em-flash    |  ✅  | 20   | GET np-listapi.eastmoney.com/comm/web/getNewsByColumns
 *             |      |      | **必须带 req_trace=1**：缺它上游只回 87 字节错误信封
 *             |      |      | {code:0,message:"Required String parameter 'req_trace'
 *             |      |      | is not present"}，**HTTP 仍是 200**，所以要看信封 code。
 *             |      |      | 成功信封 code 是字符串 "1"；data.list[]；showTime 是
 *             |      |      | `YYYY-MM-DD HH:MM:SS`（北京时间）；uniqueUrl/url 都是
 *             |      |      | http://（升 https）；个别条目没有 title，只有 summary。
 *             |      |      | 注意：np-listapi 与 push2 是**两个子服务、独立限流**——
 *             |      |      | push2 对这台机器全 RST 时它照样通，别合并失败判断。
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { readFile } from 'node:fs/promises'

import { fetchJson, fetchText, UpstreamError } from './upstream.js'

const TITLE_MAX = 120
const SUMMARY_MAX = 200
const MAX_ITEMS = 40
/** 快讯没有独立标题时，用首句/【】导语当标题的最大字数（契约要求 ≤46）。 */
const FLASH_TITLE_MAX = 46

/** 市场报告产出的行情快照（cls 源的唯一入口）。允许环境变量重定向。 */
const MARKET_REPORT_DATA_DIR =
  (typeof process !== 'undefined' && process.env && process.env.MARKET_REPORT_DATA_DIR) ||
  process.env.DSH_WALLSTREET_DATA_DIR || '/root/workspace/plugins/dsh-wallstreet/data'

/* ------------------------------------------------------------------ */
/* 文本清洗                                                            */
/* ------------------------------------------------------------------ */

const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
}

/** 去 HTML 标签 + 解常用实体 + 收空白。输入非字符串时给 ''。 */
function cleanText(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h\d)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
      if (body.charAt(0) === '#') {
        const code = body.charAt(1).toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
        if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return ' '
        try {
          return String.fromCodePoint(code)
        } catch {
          return ' '
        }
      }
      const key = body.toLowerCase()
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : whole
    })
    .replace(/[\s\u3000\u00a0]+/g, ' ')
    .trim()
}

/** 截断到 max 个「字符」（码点），超出补省略号但不挤爆上限。 */
function clip(value, max) {
  const text = String(value || '')
  if (text.length <= max) return text
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

/** 取第一句（中文句末标点或硬截断）。用于没有独立标题的快讯。 */
function firstSentence(value, max) {
  const text = cleanText(value)
  if (!text) return ''
  const hit = text.match(/^[\s\S]*?[。！？!?；;]/)
  const sentence = hit ? hit[0] : text
  return clip(sentence.replace(/[。！？!?；;]$/, ''), max)
}

/** 「【标题】正文」拆成 {title, summary}；没有方括号就当整段正文用。 */
function splitBracketTitle(value, max) {
  const text = cleanText(value)
  if (!text) return { title: '', summary: '' }
  const hit = text.match(/^[【\[]([^】\]]{2,80})[】\]]\s*([\s\S]*)$/)
  if (hit) {
    return { title: clip(hit[1].trim(), max), summary: clip(hit[2].trim(), SUMMARY_MAX) }
  }
  return { title: '', summary: text }
}

/* ------------------------------------------------------------------ */
/* 时间归一                                                            */
/* ------------------------------------------------------------------ */

/** 合法区间：2005-01-01 ~ 现在 + 1 天。越界视为上游给了脏时间。 */
const MIN_TS = 1_104_537_600_000
const MAX_TS = () => Date.now() + 86_400_000

function saneTs(ms) {
  if (!Number.isFinite(ms)) return 0
  if (ms < MIN_TS || ms > MAX_TS()) return 0
  return Math.floor(ms)
}

function fromParts(y, mo, d, h = 0, mi = 0, s = 0) {
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  if (!year || !month || !day) return 0
  if (month < 1 || month > 12 || day < 1 || day > 31) return 0
  return saneTs(new Date(year, month - 1, day, Number(h) || 0, Number(mi) || 0, Number(s) || 0).getTime())
}

/**
 * 把上游各种时间写法收敛成 epoch ms；认不出返回 0（调用方决定是否 degraded）。
 * 支持：秒/毫秒时间戳（数字或纯数字串）、YYYY-MM-DD HH:MM:SS[:ms]、
 * YYYY-MM-DD、YYYY/MM/DD HH:MM:SS、YYYYMMDDHHMMSS、ISO 串。
 */
function parseTime(value) {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0
    if (value > 1e12) return saneTs(value)
    if (value > 1e9) return saneTs(value * 1000)
    return 0
  }
  const text = String(value).trim()
  if (!text) return 0

  if (/^\d{10}$/.test(text)) return saneTs(Number(text) * 1000)
  if (/^\d{13}$/.test(text)) return saneTs(Number(text))
  if (/^\d{14}$/.test(text)) {
    return fromParts(text.slice(0, 4), text.slice(4, 6), text.slice(6, 8), text.slice(8, 10), text.slice(10, 12), text.slice(12, 14))
  }

  let hit = text.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/)
  if (hit) {
    return fromParts(hit[1], hit[2], hit[3], hit[4], hit[5], hit[6])
  }

  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? saneTs(parsed) : 0
}

/* ------------------------------------------------------------------ */
/* 代码 / 板块抽取                                                      */
/* ------------------------------------------------------------------ */

const CODE_PREFIXES = new Set([
  '600', '601', '603', '605', '688', '689', // 沪
  '000', '001', '002', '003', '300', '301', '302', // 深
  '430', '830', '831', '832', '833', '834', '835', '836', '837', '838', '839', '870', '871', '872', '873', // 北交所
  '920', // 北交所新号段
])

function isTicker(code) {
  return /^\d{6}$/.test(code) && CODE_PREFIXES.has(code.slice(0, 3))
}

/** 从任意段文本里抽 6 位 A 股代码，去重、限量。 */
function extractTickers(...values) {
  const out = []
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue
    for (const hit of value.matchAll(/(?:^|[^0-9])(\d{6})(?![0-9])/g)) {
      const code = hit[1]
      if (!isTicker(code) || out.includes(code)) continue
      out.push(code)
    }
  }
  return out.slice(0, 8)
}

/** 板块名只留正常短词，滤掉空串和明显不是板块的长句。 */
function cleanSectors(values) {
  if (!Array.isArray(values)) return []
  const out = []
  for (const raw of values) {
    const name = cleanText(raw)
    if (!name || name.length > 20 || out.includes(name)) continue
    out.push(name)
  }
  return out.slice(0, 4)
}

/** 新浪 7×24 是综合直播流，里面混着社会新闻；按标签 + 金融词过滤掉非市场内容。 */
const MARKET_TAGS = new Set([
  '市场', '公司', '宏观', 'A股', '港股', '美股', '行业', '焦点', '原创',
  '外汇', '商品', '债市', '基金', '证券', 'ETF',
])
const MARKET_HINT =
  /股|指数|期货|国债|债券|债市|汇率|利率|央行|银行|证券|券商|基金|上市|监管|货币|通胀|CPI|PPI|GDP|PMI|社融|信贷|财政|关税|出口|进口|贸易|经济|营收|净利|财报|产能|产量|成交|涨|跌|黄金|原油|铜|锂|美联储|降息|加息|评级|违约|利差|信用/

function looksLikeMarketNews(tags, text) {
  if (tags.some((tag) => MARKET_TAGS.has(tag))) return true
  return MARKET_HINT.test(text)
}

/* ------------------------------------------------------------------ */
/* HTTP（统一走 upstream.js：自报 UA / 单请求超时 / 预算内重试 / code）  */
/* ------------------------------------------------------------------ */

/**
 * 站点改版专用错误：JSON 结构变了不是网络问题，code 必须是 'parse'，
 * 面板据此把「站点改版」和「网络抖动」分开（也便于人工只修解析）。
 * @param {string} label 来源名（进错误文案）
 * @param {string} missing 缺了什么，例如 `data.items 缺失`
 */
function formatError(label, missing) {
  return new UpstreamError(`${label} 返回格式变了（${missing}）`, { code: 'parse' })
}

/** 浏览器来源站普遍要 referer；UA / 超时 / 重试交给 upstream。 */
function siteHeaders(referer, extra = {}) {
  return {
    'accept-language': 'zh-CN,zh;q=0.9',
    ...(referer ? { referer } : {}),
    ...extra,
  }
}

/**
 * 取 JSON。失败一律是 upstream 的 `UpstreamError` + 中文文案：
 *   `新浪财经超时（8s）` / `见闻上游 HTTP 503` / `巨潮返回的不是 JSON`。
 * @param {string} url
 * @param {{label: string, referer?: string, method?: 'GET'|'POST', body?: string,
 *          headers?: Record<string,string>}} [options]
 */
function readJson(url, { label, referer, method, body, headers } = {}) {
  return fetchJson(url, {
    label,
    method,
    body,
    headers: siteHeaders(referer, headers),
  })
}

/**
 * 取文本（HTML / JSON 文件都走这里）。GBK 源显式传 `encoding: 'gbk'`。
 *
 * 老 gov 站偶发 GBK 输出：upstream 的 TextDecoder 是非 fatal 的，乱码会变成
 * 替换符 U+FFFD 而不是抛异常，所以这里按替换符判断，命中就按 GBK 再取一次。
 */
async function readText(url, { label, referer, headers, encoding = 'utf-8' } = {}) {
  const options = { label, encoding, headers: siteHeaders(referer, headers) }
  const text = await fetchText(url, options)
  if (encoding === 'utf-8' && text.includes('\uFFFD')) {
    return fetchText(url, { ...options, encoding: 'gbk' })
  }
  return text
}

/** 上游给 http:// 时升到 https（避免 https 页面里打开混合内容告警）。 */
function httpsUrl(value) {
  const url = cleanText(value)
  if (!url) return ''
  return url.replace(/^http:\/\//i, 'https://')
}

/** 东财快讯的 summary 一律以【导语】开头，那是标题而不是正文，剥掉免得标题行重复一遍。 */
function stripBracketLead(value) {
  return cleanText(value).replace(/^[【[][^】\]]{2,80}[】\]]\s*/, '')
}

/* ------------------------------------------------------------------ */
/* item 装配 + 同源去重                                                */
/* ------------------------------------------------------------------ */

/**
 * 逐条构造 §2 的裸 item（不含 id/eventType/importance）。
 * 标题缺失 → 返回 null（调用方 continue）；时间拿不到 → 抓取时间 + degraded。
 */
function buildItem(profile, fields) {
  const title = clip(cleanText(fields.title), TITLE_MAX)
  if (!title) return null

  const summary = clip(cleanText(fields.summary), SUMMARY_MAX)
  const explicitTs = saneTs(Number(fields.ts) || 0)
  const degraded = Boolean(fields.degraded) || !explicitTs
  const url = typeof fields.url === 'string' && /^https?:\/\//i.test(fields.url.trim()) ? fields.url.trim() : ''

  const tickers = Array.isArray(fields.tickers) && fields.tickers.length
    ? fields.tickers.filter(isTicker).slice(0, 8)
    : extractTickers(title, summary)

  return {
    ts: explicitTs || Date.now(),
    source: profile.id,
    sourceLabel: profile.label,
    kind: profile.kind,
    title,
    summary,
    url,
    tickers,
    sectors: cleanSectors(fields.sectors),
    degraded,
  }
}

/** 与 schema.itemId() 同口径的去重键（source|url||title）。 */
function dedupeKey(item) {
  return `${item.source}|${item.url || item.title}`
}

/**
 * 收尾：丢掉 null、按 source|url||title 去重、按时间倒序、限量。
 * 0 条不是错误，但网络源真 0 条通常意味着结构变了 —— 由 assertNotEmpty 决定。
 */
function finalize(profile, items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    if (!item) continue
    const key = dedupeKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  out.sort((a, b) => b.ts - a.ts)
  return out.slice(0, MAX_ITEMS)
}

function assertNotEmpty(profile, items) {
  if (items.length === 0) {
    // 网络源真 0 条通常不是「今天没新闻」，而是页面结构变了 —— 用 parse 让面板
    // 能与网络抖动分开（见文件头「硬约束」）。
    throw new UpstreamError(`${profile.label} 返回 0 条（可能是页面结构变了）`, { code: 'parse' })
  }
  return items
}

/* ------------------------------------------------------------------ */
/* §4 源清单（13 个：12 启用 + 证监会禁用）                              */
/* ------------------------------------------------------------------ */

/** 1. 新浪财经 · 滚动快讯（lid=2516 港股频道，契约指定端点） */
const sina = {
  id: 'sina',
  label: '新浪财经',
  kind: 'flash',
  intervalMs: 120_000,
  enabled: true,
  async fetch() {
    const payload = await readJson(
      'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=30&page=1',
      { label: '新浪财经', referer: 'https://finance.sina.com.cn/' },
    )
    const rows = payload && payload.result && Array.isArray(payload.result.data) ? payload.result.data : null
    if (!rows) throw formatError('新浪财经', 'result.data 缺失')

    const items = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const title = cleanText(row.title) || firstSentence(row.intro, TITLE_MAX)
      const ts = parseTime(row.ctime) || parseTime(row.intime) || parseTime(row.mtime)
      items.push(
        buildItem(sina, {
          ts,
          title,
          summary: cleanText(row.intro),
          url: row.url,
          // media_name 是媒体名（新浪港股/市场资讯），不是行业，不塞进 sectors
          degraded: !ts,
        }),
      )
    }
    return finalize(sina, assertNotEmpty(sina, items))
  },
}

/** 2. 华尔街见闻 · 全球快讯（必须 awtmt 域名） */
const wscn = {
  id: 'wscn',
  label: '华尔街见闻',
  kind: 'flash',
  intervalMs: 120_000,
  enabled: true,
  async fetch() {
    const payload = await readJson(
      'https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&limit=30',
      { label: '见闻', referer: 'https://wallstreetcn.com/' },
    )
    const rows = payload && payload.data && Array.isArray(payload.data.items) ? payload.data.items : null
    if (!rows) throw formatError('见闻', 'data.items 缺失')

    const items = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const body = cleanText(row.content_text) || cleanText(row.content)
      if (!body) continue // 纯图片/日历条目，没正文就没法成条
      const heading = cleanText(row.title)
      const title = heading || firstSentence(body, TITLE_MAX)
      const ts = parseTime(row.display_time)
      const id = row.id
      items.push(
        buildItem(wscn, {
          ts,
          title,
          summary: heading ? body : '',
          url: row.uri || (id ? `https://wallstreetcn.com/livenews/${id}` : ''),
          tickers: extractTickers(row.title, body, ...(Array.isArray(row.symbols) ? row.symbols.map((s) => String(s)) : [])),
          // global_channel_name 恒为「7x24快讯」，不是行业，不塞进 sectors
          degraded: !ts,
        }),
      )
    }
    return finalize(wscn, assertNotEmpty(wscn, items))
  },
}

/** 3/4. 巨潮公告（深市 / 沪市）：column 与 plate 必须配对，否则返回全市场 */
function createCninfoSource({ id, label, plate, column }) {
  const profile = {
    id,
    label,
    kind: 'announcement',
    intervalMs: 180_000,
    enabled: true,
    async fetch() {
      const body = [
        'pageNum=1',
        'pageSize=30',
        `column=${column}`,
        'tabName=fulltext',
        `plate=${plate}`,
        'stock=',
        'searchkey=',
        'secid=',
        'category=',
        'trade=',
        'seDate=',
        'sortName=',
        'sortType=',
        'isHLtitle=true',
      ].join('&')

      const payload = await readJson('https://www.cninfo.com.cn/new/hisAnnouncement/query', {
        label: '巨潮',
        method: 'POST',
        referer: 'https://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body,
      })

      // 巨潮在限流时会返回 {classifiedAnnouncements:null} 之类，别当成「今天没公告」
      const rows = payload && Array.isArray(payload.announcements) ? payload.announcements : null
      if (!rows) throw formatError('巨潮', 'announcements 缺失')

      const items = []
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const code = cleanText(row.secCode)
        const name = cleanText(row.secName)
        const heading = cleanText(row.announcementTitle)
        if (!heading) continue
        const ts = parseTime(row.announcementTime)
        const pdf = cleanText(row.adjunctUrl)
        items.push(
          buildItem(profile, {
            ts,
            title: name ? `${name}：${heading}` : heading,
            summary: '',
            url: pdf ? `https://static.cninfo.com.cn/${pdf.replace(/^\/+/, '')}` : '',
            tickers: isTicker(code) ? [code] : [],
            degraded: !ts,
          }),
        )
      }
      return finalize(profile, assertNotEmpty(profile, items))
    },
  }
  return profile
}

/** 5. 东财公告 */
const emAnn = {
  id: 'em-ann',
  label: '东财公告',
  kind: 'announcement',
  intervalMs: 180_000,
  enabled: true,
  async fetch() {
    const payload = await readJson(
      'https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=30&page_index=1&ann_type=A&client_source=web&f_node=0&s_node=0',
      { label: '东财公告', referer: 'https://data.eastmoney.com/' },
    )
    const rows = payload && payload.data && Array.isArray(payload.data.list) ? payload.data.list : null
    if (!rows) throw formatError('东财公告', 'data.list 缺失')

    const items = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const heading = cleanText(row.title)
      if (!heading) continue
      const codes = Array.isArray(row.codes) ? row.codes : []
      const tickers = codes.map((entry) => cleanText(entry && entry.stock_code)).filter(isTicker)
      const firstCode = tickers[0] || ''
      const artCode = cleanText(row.art_code)
      // display_time 形如 2026-11-25 11:38:04:344，第 4 个冒号是毫秒分隔，先剥掉再解析
      const ts = parseTime(String(row.display_time || '').replace(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}):\d+$/, '$1')) ||
        parseTime(row.notice_date)
      items.push(
        buildItem(emAnn, {
          ts,
          title: heading,
          summary: '',
          url: artCode && firstCode ? `https://data.eastmoney.com/notices/detail/${firstCode}/${artCode}.html` : '',
          tickers,
          degraded: !ts,
        }),
      )
    }
    return finalize(emAnn, assertNotEmpty(emAnn, items))
  },
}

function ymd(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 6. 东财研报（beginTime/endTime 必填，缺一个就 400） */
const emReport = {
  id: 'em-report',
  label: '东财研报',
  kind: 'report',
  intervalMs: 600_000,
  enabled: true,
  async fetch() {
    const today = new Date()
    const from = new Date(today.getTime() - 3 * 86_400_000)
    const url =
      'https://reportapi.eastmoney.com/report/list?industryCode=*&pageSize=30&industry=*&pageNo=1' +
      '&qType=0&rating=&ratingChange=&fields=' +
      `&beginTime=${ymd(from)}&endTime=${ymd(today)}`
    const payload = await readJson(url, { label: '东财研报', referer: 'https://data.eastmoney.com/report/' })
    const rows = payload && Array.isArray(payload.data) ? payload.data : null
    if (!rows) throw formatError('东财研报', 'data 缺失')

    const items = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const heading = cleanText(row.title)
      if (!heading) continue
      const stockName = cleanText(row.stockName)
      const stockCode = cleanText(row.stockCode)
      const org = cleanText(row.orgSName) || cleanText(row.orgName)
      // 实测 industryName 一律是空串，真行业名在 indvInduName（半导体/电池/电力…）
      const industry = cleanText(row.indvInduName) || cleanText(row.industryName)
      const infoCode = cleanText(row.infoCode)
      const ts = parseTime(row.publishDate)
      items.push(
        buildItem(emReport, {
          ts,
          title: stockName ? `${stockName}：${heading}` : heading,
          summary: [org, industry].filter(Boolean).join(' · '),
          url: infoCode ? `https://data.eastmoney.com/report/zw_stock.jshtml?infocode=${infoCode}` : '',
          tickers: isTicker(stockCode) ? [stockCode] : [],
          sectors: industry ? [industry] : [],
          degraded: !ts,
        }),
      )
    }
    return finalize(emReport, assertNotEmpty(emReport, items))
  },
}

/** 7. 国务院政策（顶层数组 1117 条，只取最新 40） */
const govPolicy = {
  id: 'gov-policy',
  label: '国务院政策',
  kind: 'policy',
  intervalMs: 1_800_000,
  enabled: true,
  async fetch() {
    const payload = await readJson('https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json', {
      label: '国务院政策',
    })
    if (!Array.isArray(payload)) throw formatError('国务院政策', '顶层不是数组')

    const items = []
    for (const row of payload) {
      if (!row || typeof row !== 'object') continue
      const heading = cleanText(row.TITLE)
      if (!heading) continue
      const ts = parseTime(row.DOCRELPUBTIME)
      items.push(
        buildItem(govPolicy, {
          ts,
          title: heading,
          summary: cleanText(row.SUB_TITLE),
          url: row.URL,
          degraded: false, // 日期只到天，但那确实是发布时间，不算兜底
        }),
      )
    }
    return finalize(govPolicy, assertNotEmpty(govPolicy, items))
  },
}

/** 8. 财联社：直连要签名（404），改读市场报告的 cls_news 快照 */
const cls = {
  id: 'cls',
  label: '财联社',
  kind: 'flash',
  intervalMs: 600_000,
  enabled: true,
  async fetch() {
    const file = `${MARKET_REPORT_DATA_DIR.replace(/\/+$/, '')}/market_data.json`
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return [] // 快照没生成时静默空，不当作故障
    }

    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new Error('本地快照非 JSON（market_data.json 损坏）')
    }

    const rows = payload && Array.isArray(payload.cls_news) ? payload.cls_news : []
    if (!Array.isArray(payload && payload.cls_news)) return []

    // cls_news 的 time 实测只有 HH:MM:SS，日期要从同文件 fetch_time 借
    const snapshotDate = cleanText(payload.fetch_time).slice(0, 10)
    const dateMatch = /^\d{4}-\d{2}-\d{2}$/.test(snapshotDate) ? snapshotDate : ''

    const items = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const digest = cleanText(row.digest)
      const heading = cleanText(row.title)
      if (!digest && !heading) continue

      let ts = parseTime(row.time)
      let degraded = false
      if (!ts) {
        const clock = String(row.time || '').trim()
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(clock) && dateMatch) {
          ts = parseTime(`${dateMatch} ${clock.length === 5 ? `${clock}:00` : clock}`)
        }
      }
      if (!ts) degraded = true // 时间只能退回抓取时间

      let title = heading
      let summary = digest
      if (!title) {
        const split = splitBracketTitle(digest, TITLE_MAX)
        title = split.title || split.summary
        summary = split.title ? split.summary : ''
      }

      items.push(
        buildItem(cls, {
          ts,
          title,
          summary,
          url: '', // 快照里没有原文链接，留空让上层用标题做去重键
          degraded,
        }),
      )
    }
    return finalize(cls, items)
  },
}

/** 9. 央行 · 规章与征求意见稿（老式 table HTML + 19 位时间码） */
const pbc = {
  id: 'pbc',
  label: '央行',
  kind: 'policy',
  intervalMs: 3_600_000,
  enabled: true,
  async fetch() {
    const html = await readText('https://www.pbc.gov.cn/tiaofasi/144941/144979/index.html', {
      label: '央行',
      referer: 'https://www.pbc.gov.cn/',
    })
    // 标题在正文里被截成「…」，必须取 <a title="完整标题">。
    // 注意属性里还有 istitle="true"，所以 title 前必须要求一个空白，否则会吃到它。
    const pattern = /<a[^>]+href="([^"]*\/20\d{8,}\/index\.html)"[^>]*?\stitle="([^"]{4,160})"/g
    const items = []
    const seen = new Set()
    let hit
    while ((hit = pattern.exec(html)) !== null) {
      const href = hit[1]
      if (seen.has(href)) continue
      seen.add(href)
      const title = cleanText(hit[2])
      if (!title) continue
      const codeHit = href.match(/\/(\d{10,})\/index\.html$/)
      const ts = codeHit ? parseTime(codeHit[1].slice(0, 14)) : 0
      items.push(
        buildItem(pbc, {
          ts,
          title,
          summary: '',
          url: href.startsWith('http') ? href : `https://www.pbc.gov.cn${href}`,
          degraded: !ts,
        }),
      )
      if (items.length >= MAX_ITEMS) break
    }
    return finalize(pbc, assertNotEmpty(pbc, items))
  },
}

/**
 * 10. 证监会 —— 禁用。
 * 静态列表页冻结在 2021-12-10，新的 /searchList/c100028 接口恒返回 total:0
 * （频道 id 已迁移，找不到可用频道号），2 个前端都拿不到新公告，故不进轮询。
 */
const csrc = {
  id: 'csrc',
  label: '证监会',
  kind: 'policy',
  intervalMs: 3_600_000,
  enabled: false,
  async fetch() {
    throw new Error('证监会列表页冻结在 2021-12，searchList 接口恒返回 0 条')
  },
}

/** 11. 统计局 · 数据发布 */
const stats = {
  id: 'stats',
  label: '统计局',
  kind: 'policy',
  intervalMs: 3_600_000,
  enabled: true,
  async fetch() {
    const html = await readText('https://www.stats.gov.cn/sj/zxfb/', {
      label: '统计局',
      referer: 'https://www.stats.gov.cn/',
    })
    // 每个 <li> 里 3 个同样 href 的自适应锚点 + 1 个 <span>日期</span>，
    // 整段用一条大正则容易跨 li 抢词，改成先切 li 再逐块取。
    const items = []
    const seen = new Set()
    for (const block of html.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
      const chunk = block[1]
      const link = chunk.match(/href="(\.\/20\d{4}\/t\d+_\d+\.html)"[^>]*title='([^']{4,160})'/)
      if (!link) continue
      const href = link[1]
      if (seen.has(href)) continue
      seen.add(href)
      const title = cleanText(link[2])
      if (!title) continue
      const dateHit = chunk.match(/<span>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/)
      const ts = dateHit ? parseTime(dateHit[1]) : 0
      items.push(
        buildItem(stats, {
          ts,
          title,
          summary: '',
          url: `https://www.stats.gov.cn/sj/zxfb/${href.replace(/^\.\//, '')}`,
          degraded: !ts,
        }),
      )
      if (items.length >= MAX_ITEMS) break
    }
    return finalize(stats, assertNotEmpty(stats, items))
  },
}

/**
 * 12. 新浪 · 全球市场快讯。
 * 契约写「新浪滚动其它 lid」，但实测 lid=2510/2511/2515 分别落国内/国际时事/科技，
 * 2516/2517 回流港股；含国际、宏观、全球市场的快讯在 7×24 直播 feed 里，故改用它。
 */
const sinaGlobal = {
  id: 'sina-global',
  label: '新浪·全球市场',
  kind: 'flash',
  intervalMs: 120_000,
  enabled: true,
  async fetch() {
    const payload = await readJson(
      'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=30&zhibo_id=152&tag_id=0&dire=f&dpc=1',
      { label: '新浪7×24', referer: 'https://finance.sina.com.cn/7x24/' },
    )
    const rows =
      payload && payload.result && payload.result.data && payload.result.data.feed
        && Array.isArray(payload.result.data.feed.list)
        ? payload.result.data.feed.list
        : null
    if (!rows) throw formatError('新浪7×24', 'feed.list 缺失')

    const items = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const body = cleanText(row.rich_text) || cleanText(row.text)
      if (!body) continue
      const split = splitBracketTitle(body, TITLE_MAX)
      const title = split.title || firstSentence(body, TITLE_MAX)
      const ts = parseTime(row.create_time)
      const tags = Array.isArray(row.tag) ? row.tag.map((entry) => cleanText(entry && entry.name)) : []
      if (!looksLikeMarketNews(tags, body)) continue // 社会新闻不进市场 hub
      const docurl = cleanText(row.docurl)
      items.push(
        buildItem(sinaGlobal, {
          ts,
          title,
          summary: split.title ? split.summary : '',
          url: /^https?:\/\//i.test(docurl) && docurl.includes('detail-') ? docurl : '',
          // tag 只是话题标签（国际/宏观/焦点），已用于过滤噪音，不写进 sectors
          degraded: !ts,
        }),
      )
    }
    return finalize(sinaGlobal, assertNotEmpty(sinaGlobal, items))
  },
}

/* ------------------------------------------------------------------ */

/**
 * 13. 东财 · 快讯（np-listapi 子服务）。
 *
 * 与 push2 行情是**两个子服务、独立限流**：push2 对本机全 RST 时这个域名照样通，
 * 所以不要把它和行情源的失败并成一个判断（本文件本来也没有全局熔断，保持这样）。
 *
 * 两个坑（实测）：
 *   1. **req_trace=1 必填**。缺它上游只回 87 字节错误信封
 *      `{"code":0,"message":"Required String parameter 'req_trace' is not present"}`，
 *      **HTTP 还是 200** —— 只看 response.ok 会把错误当「今天没快讯」，必须看信封 code；
 *      成功信封的 code 是字符串 `"1"`（不是数字 1）。
 *   2. `uniqueUrl`/`url` 都是 `http://`，统一升 https，免得 https 页面里开 http 触发混合内容告警。
 *
 * 上游 `order=1` 只是大致倒序（实测同一页 15:24 会排在 15:31 前面），
 * 最终顺序由 finalize() 按 ts 再排一次保证。
 */
const emFlash = {
  id: 'em-flash',
  label: '东财快讯',
  kind: 'flash',
  intervalMs: 120_000,
  enabled: true,
  async fetch() {
    const payload = await readJson(
      'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns' +
        '?client=web&biz=web_news_col&column=344&order=1&needInteractData=0' +
        '&page_index=1&page_size=20&req_trace=1',
      { label: '东财快讯', referer: 'https://finance.eastmoney.com/' },
    )

    // 业务信封：成功 code 是字符串 "1"；参数缺失/被限流是数字 0 + message。
    // 没有 code 字段就当不是信封（走下面的 data.list 检查，别报「code=undefined」）。
    if (!payload || typeof payload !== 'object') throw formatError('东财快讯', '顶层不是对象')
    if (payload.code !== undefined && String(payload.code) !== '1') {
      const reason = cleanText(payload.message) || '上游未说明原因'
      throw new UpstreamError(`东财快讯 返回错误（code=${payload.code}：${reason}）`, { code: 'parse' })
    }

    const rows = payload.data && Array.isArray(payload.data.list) ? payload.data.list : null
    if (!rows) throw formatError('东财快讯', 'data.list 缺失')

    const items = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const heading = cleanText(row.title)
      // 个别条目没有 title 只有 summary：先取【】里的导语（那才是原文标题），
      // 没有方括号就取首句，两种都 ≤46 字。
      const fallback = splitBracketTitle(row.summary, FLASH_TITLE_MAX)
      const title = heading || fallback.title || firstSentence(row.summary, FLASH_TITLE_MAX)
      if (!title) continue
      const ts = parseTime(row.showTime) // `YYYY-MM-DD HH:MM:SS`，北京时间
      items.push(
        buildItem(emFlash, {
          ts,
          title,
          // 标题取自 summary 时不再把同一段塞进 summary（避免上下两行一模一样）；
          // 有 title 时剥掉 summary 开头重复的【导语】。
          summary: heading ? stripBracketLead(row.summary) : '',
          url: httpsUrl(row.uniqueUrl || row.url),
          degraded: !ts,
        }),
      )
    }
    return finalize(emFlash, assertNotEmpty(emFlash, items))
  },
}

/* ------------------------------------------------------------------ */

/** §4 的 13 个源（12 个启用 + 1 个禁用），顺序即面板展示顺序。 */
export const SOURCES = [
  sina,
  wscn,
  createCninfoSource({ id: 'cninfo-sz', label: '巨潮·深市公告', plate: 'sz', column: 'szse' }),
  createCninfoSource({ id: 'cninfo-sh', label: '巨潮·沪市公告', plate: 'sh', column: 'sse' }),
  emAnn,
  emReport,
  govPolicy,
  cls,
  pbc,
  csrc,
  stats,
  sinaGlobal,
  emFlash,
]

export default SOURCES
