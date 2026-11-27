/**
 * dsh-wallstreet —— 信息资讯集散中心 · 归一化层
 *
 * 只做「把上游各种各样的一条东西，压成同一个 item 形状」这一件事：
 *  - id 稳定：同一来源的同一条内容重复抓取必须得到同一个 id（去重靠它）；
 *  - 时间统一成 epoch ms；字符串时间按 Asia/Shanghai（+08:00）解释，
 *    上游给的秒级时间戳要乘 1000；
 *  - 文本清洗：去 HTML 标签、压空白、截断，超长不抛错。
 *
 * 契约见 docs/info-hub.md §2。这里不碰网络、不碰数据库。
 */
import { createHash } from 'node:crypto'

/** 允许的 kind。未知值一律落到 flash，宁可标错也不丢条目。 */
export const KINDS = ['flash', 'announcement', 'report', 'policy']

export const KIND_LABELS = {
  flash: '快讯',
  announcement: '公告',
  report: '研报',
  policy: '政策',
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

/** 短哈希：16 位十六进制足够区分，又不会把 SQLite 索引撑大。 */
export function hash(input) {
  return createHash('sha1').update(String(input)).digest('hex').slice(0, 16)
}

/**
 * 条目去重键。优先用 url（同一篇文章换标题也算同一篇），没有 url 才用标题。
 * @param {string} source adapter id
 * @param {string} url 原文链接
 * @param {string} title 标题
 */
export function itemId(source, url, title) {
  return hash(`${source}|${String(url || title || '')}`)
}

/** 清洗一段文本：去标签、解常见实体、压空白、可选截断。 */
export function cleanText(value, max = 120) {
  const text = String(value == null ? '' : value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  if (!Number.isFinite(max) || max <= 0) return text
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 13 位当毫秒、10 位当秒；拿不准就给 fallback，不瞎猜。 */
function numericStamp(n) {
  if (!Number.isFinite(n) || n <= 0) return null
  if (n > 1e12) return Math.round(n)          // 毫秒
  if (n > 1e9) return Math.round(n * 1000)    // 秒
  return null
}

/**
 * 任意时间表示 → epoch ms。
 * 支持：13/10 位数字、'YYYY-MM-DD HH:mm(:ss)'、ISO 字符串。
 * 解析不出来返回 fallback（默认现在），调用方要按 degraded 标记。
 */
export function toMs(value, fallback = Date.now()) {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : fallback
  }
  if (typeof value === 'number') return numericStamp(value) ?? fallback
  const raw = String(value == null ? '' : value).trim()
  if (raw === '') return fallback
  if (/^\d{10,13}$/.test(raw)) return numericStamp(Number(raw)) ?? fallback
  // 明确带时区的（`Z` / `+08:00` / `-0500`）一律交给 Date.parse：
  // 我们的默认口径是「无时区信息 = 北京时间」，但有明确时区时不能再往里套 +08:00，
  // 否则 `2026-11-25T09:30:00Z` 会被当成北京时间 09:30（整体偏 8 小时）。
  if (/([zZ]|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const zoned = Date.parse(raw)
    if (Number.isFinite(zoned)) return zoned
  }
  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (match) {
    const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = match
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss)) - SHANGHAI_OFFSET_MS
    return Number.isFinite(ms) ? ms : fallback
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 数组去重 + 去空 + 截断；上游给单个字符串时也接受。 */
export function uniqueStrings(value, max = 8) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value]
  const seen = new Set()
  const out = []
  for (const entry of list) {
    const text = String(entry == null ? '' : entry).trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

/**
 * 把一个 adapter 的裸对象压成 item。标题为空直接返回 null（调用方跳过）。
 * @param {object} raw adapter 产出
 * @param {{id:string,label?:string,kind?:string}} meta adapter 元信息
 */
export function makeItem(raw, meta) {
  if (!raw || typeof raw !== 'object') return null
  const title = cleanText(raw.title, 120)
  if (!title) return null
  const sourceId = String(meta.id || raw.source || 'unknown')
  const url = String(raw.url || '').trim()
  const ts = toMs(raw.ts)
  return {
    id: itemId(sourceId, url, title),
    ts,
    source: sourceId,
    sourceLabel: String(meta.label || raw.sourceLabel || sourceId),
    kind: KINDS.includes(raw.kind) ? raw.kind : KINDS.includes(meta.kind) ? meta.kind : 'flash',
    title,
    summary: cleanText(raw.summary, 200),
    url,
    tickers: uniqueStrings(raw.tickers, 8).map((code) => code.replace(/^(sh|sz|bj)/i, '')),
    sectors: uniqueStrings(raw.sectors, 4),
    eventType: '',
    importance: 0,
    degraded: raw.degraded === true,
  }
}

/** 事件 id：取簇内首曝条目的 id，天然去重且可追溯。 */
export function eventIdOf(item) {
  return hash(`event|${item.id}`)
}

/* ------------------------- 标题相似度：归一化 → 切分 → 比较 ------------------------- */

/** 控制字符与格式字符（含零宽空格/连接符、BOM）：对「是否同一件事」没有信息，直接删。 */
const CONTROL_RE = /[\p{Cc}\p{Cf}]+/gu
/** 标点与符号（含各类空白）：CJK 里是纯噪声；拉丁里是词边界。 */
const NOISE_RE = /[\s\p{P}\p{S}]+/gu
/** CJK 文字：汉字 / 日文假名 / 谚文 / 注音。这些文字没有空格分词，按「字」比较。 */
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u

/**
 * 先折叠一层：NFKC → 去控制字符 → 小写。
 * 之后两条路分叉：CJK 走「连写 + 字符 bigram」，拉丁走「保留词边界 + 按词」。
 */
function foldText(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .replace(CONTROL_RE, '')
    .toLowerCase()
}

function stripNoise(folded) {
  return folded.replace(NOISE_RE, '')
}

/**
 * 严格归一化：折叠之后把标点/符号/空白全部删掉，CJK 与拉丁都变成连写串。
 * 与 normalizeTitle 的唯一区别是先做 NFKC（全角数字/字母/连字先折成半角基本字母）。
 */
export function normalizeText(text) {
  return stripNoise(foldText(text))
}

/** 旧名保留：语义等同 normalizeText（多的只是 NFKC 这一步）。 */
export function normalizeTitle(text) {
  return normalizeText(text)
}

/** 字符 bigram；只剩 1 个字时退化为单字。 */
function bigrams(text) {
  const chars = [...text]
  if (chars.length <= 1) return chars
  const tokens = []
  for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1])
  return tokens
}

/** 纯拉丁按词切：标点/符号当词边界；撇号/反引号先删——它们是词内符号。 */
function words(folded) {
  if (!folded) return []
  return folded
    .replace(/['’`]+/g, '')
    .replace(NOISE_RE, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * 一次折叠出相似度比较要用的三样东西，保证各处口径天然一致：
 *  - normalized：连写串（标点/空白全删），给字符级 LCS 与 3-gram 用；
 *  - tokens：比较单位——含 CJK 是字符 bigram，纯拉丁是词；
 *  - cjk：是否含 CJK，决定顺序侧按字符还是按词元比。
 */
function analyze(text) {
  const folded = foldText(text)
  const normalized = stripNoise(folded)
  const cjk = CJK_RE.test(folded)
  return { folded, normalized, cjk, tokens: cjk ? bigrams(normalized) : words(folded) }
}

/** 3-gram 集合，用于摘要相似度（中英混排都适用，不需要分词词典）。归一化口径走 normalizeText。 */
export function trigrams(text) {
  const normalized = normalizeText(text)
  const set = new Set()
  if (normalized.length <= 3) {
    if (normalized.length > 0) set.add(normalized)
    return set
  }
  for (let i = 0; i + 3 <= normalized.length; i += 1) set.add(normalized.slice(i, i + 3))
  return set
}

/** 是否含 CJK 文字。在 NFKC 之后判断：半角片假名折成全角后同样算 CJK。 */
export function hasCjk(text) {
  return analyze(text).cjk
}

/**
 * 切分单位：纯拉丁按「词」，含 CJK 按「字符 bigram」（只剩 1 个字时退化为单字）。
 *
 * 为什么分两套：拉丁文字有空格分词，trigram 会把一个词切成互相重叠的碎片，
 * 改一个字母就丢 3 个 gram；CJK 没有空格，真正的词粒度拿不到（不引分词词典），
 * 但 2 字窗口已经能抓住「稀土/价格」这类固定搭配，对短标题比 3 字窗口敏感得多。
 *
 * 含 CJK 时整串按字切，混排里的拉丁段也落进同一个 bigram 流、不做特殊处理——
 * 跨书写系统的字面重合本来就没有意义，我们真正要抓的是「同一串换了写法」。
 */
export function tokenize(text) {
  return analyze(text).tokens
}

/** Jaccard 相似度：0–1。两边都空算 0，避免把空标题聚成一坨。 */
export function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0
  let shared = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const gram of small) if (large.has(gram)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** 字符串按 tokenize 切；数组/Set/其它可迭代原样收。 */
function toTokens(value) {
  if (typeof value === 'string') return tokenize(value)
  if (!value || typeof value[Symbol.iterator] !== 'function') return []
  return [...value]
}

/** token 集合的 Jaccard：算法与 jaccard 完全一致，只是入参换成 tokenize 的结果。 */
export function tokenSetJaccard(a, b) {
  return jaccard(new Set(toTokens(a)), new Set(toTokens(b)))
}

/** 通用 LCS 长度：元素用 === 比较，字符与词元共用同一套实现。 */
function lcsLength(left, right) {
  if (left.length === 0 || right.length === 0) return 0
  const [short, long] = left.length <= right.length ? [left, right] : [right, left]
  let previous = new Uint16Array(long.length + 1)
  let current = new Uint16Array(long.length + 1)
  for (let i = 1; i <= short.length; i += 1) {
    const unit = short[i - 1]
    for (let j = 1; j <= long.length; j += 1) {
      current[j] = unit === long[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1])
    }
    const swap = previous
    previous = current
    current = swap
    current.fill(0)
  }
  return previous[long.length]
}

/** 公共子序列长度占较短序列的比例；任一侧为空返回 0。 */
function sequenceLcsRatio(left, right) {
  if (left.length === 0 || right.length === 0) return 0
  return lcsLength(left, right) / Math.min(left.length, right.length)
}

/**
 * 最长公共子序列占较短串的比例（字符粒度，归一化走 normalizeText/NFKC）。
 *
 * 中文标题里「同一事件的不同写法」通常保留一大段完全相同的措辞
 * （例：`央行开展1万亿元MLF操作600519` vs `央行开展1万亿元MLF操作保持流动性`），
 * bigram Jaccard 对这种「共享长前缀」仍然打折，字符级 LCS 能稳定识别。
 * O(n×m)，标题 ≤120 字，单次比较可忽略。
 */
export function lcsRatio(a, b) {
  return sequenceLcsRatio([...analyze(a).normalized], [...analyze(b).normalized])
}

/**
 * 词元粒度的 LCS 占比。
 * 纯英文标题上字符级 LCS 太宽松：`NVIDIA beats Q3 earnings estimates` 与
 * `Fed holds rates steady` 这两个毫不相干的标题，字符级 LCS 也有 0.42
 * （字母撞车太多），按词元比就是 0。所以拉丁标题的顺序分走上这一套。
 */
export function tokenLcsRatio(a, b) {
  return sequenceLcsRatio(toTokens(a), toTokens(b))
}

/**
 * 综合相似度：按书写系统选切分单位，再取「token Jaccard」与「LCS 占比」的较大者。
 *
 * token 侧：拉丁按词、CJK 按字符 bigram（见 tokenize）。
 * 顺序侧的口径必须与 token 侧一致——否则短英文标题会被字符级 LCS 抬到 0.4+。
 * 含 CJK 的标题仍然走字符级 LCS：中文同一事件的改写常保留一大段完全相同的措辞，
 * 字符级 LCS 对「共享长前缀」最稳；同时这也是 ingest 现有聚簇阈值
 * （快讯 0.5 / 公告 0.85 / 研报 0.72 / 政策 0.55）标定的基准，
 * 中文这一侧的判定方向刻意保持不变。
 */
export function titleSimilarity(a, b) {
  const left = analyze(a)
  const right = analyze(b)
  const tokenScore = tokenSetJaccard(left.tokens, right.tokens)
  const orderScore =
    left.cjk || right.cjk
      ? sequenceLcsRatio([...left.normalized], [...right.normalized])
      : sequenceLcsRatio(left.tokens, right.tokens)
  return Math.max(tokenScore, orderScore)
}

/** 北京时间的一天边界（用于「今日事件数」口径）。 */
export function beijingDayStart(now = Date.now()) {
  const shifted = new Date(now + SHANGHAI_OFFSET_MS)
  const midnightUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  return midnightUtc - SHANGHAI_OFFSET_MS
}

/** 'MM-DD HH:mm' 口径的时间标签，列表里够用且不占宽度。 */
export function formatStamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const d = new Date(ms + SHANGHAI_OFFSET_MS)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** 板块名归一化：去掉「行业/板块/概念/指数/服务/制造」这类后缀，便于跨源比对。 */
export function normalizeSector(name) {
  return String(name || '')
    .replace(/[\s　]+/g, '')
    .replace(/(行业|板块|概念|指数|服务|制造|设备|产业)$/g, '')
    .trim()
}

/**
 * 两个板块名是否指同一件事。
 * 规则：归一化后相等；或一方包含另一方且较短的一方 >= 2 字（「半导体」⊂「半导体设备」）。
 * 不用编辑距离——中国行业名就那几百个，包含关系已经覆盖大部分跨源差异。
 */
export function sectorMatches(a, b) {
  const left = normalizeSector(a)
  const right = normalizeSector(b)
  if (!left || !right) return false
  if (left === right) return true
  const [short, long] = left.length <= right.length ? [left, right] : [right, left]
  return short.length >= 2 && long.includes(short)
}

/** 把一个板块名展开成查询用的候选变体（原始 + 归一化 + 常见同义）。 */
export function sectorVariants(name) {
  const raw = String(name || '').trim()
  if (!raw) return []
  const variants = new Set([raw, normalizeSector(raw)])
  const alias = {
    有色金属: ['有色', '铜', '铝', '黄金'],
    半导体: ['芯片', '集成电路'],
    电力设备: ['电力', '电池'],
    食品饮料: ['白酒', '消费'],
    计算机: ['软件', '信创'],
    医药生物: ['医药', '创新药'],
    非银金融: ['券商', '保险'],
    银行: ['银行'],
    房地产: ['地产'],
    汽车: ['汽车', '新能源车'],
    煤炭: ['煤炭', '焦煤'],
    石油石化: ['石油', '石化'],
    钢铁: ['钢铁'],
    国防军工: ['军工'],
    传媒: ['传媒', '游戏'],
    家用电器: ['家电'],
    机械设备: ['机械'],
    基础化工: ['化工'],
    交通运输: ['航运', '港口', '航空'],
    建筑装饰: ['基建', '建筑'],
    公用事业: ['电力'],
    农林牧渔: ['农业', '养殖'],
  }
  for (const [key, list] of Object.entries(alias)) {
    if (sectorMatches(key, raw)) for (const item of list) variants.add(item)
  }
  // 东财的行业板块切得很细（水产养殖 / 集成电路封测 / 电子化学品Ⅲ），跟我们打标的
  // 板块词表对不上。补一层「核心词」：长名字拆成 2 字窗口，用来在标题里兜底匹配。
  const normalized = normalizeSector(raw)
  if (normalized.length >= 3) {
    for (let i = 0; i + 2 <= normalized.length && variants.size < 10; i += 1) {
      const gram = normalized.slice(i, i + 2)
      if (!/^[\u4e00-\u9fa5]{2}$/.test(gram)) continue
      variants.add(gram)
    }
  }
  return [...variants].filter(Boolean)
}
