/**
 * dsh-wallstreet —— 信息资讯集散中心 · 规则打标层
 *
 * 为什么先规则后模型：资讯的 80% 价值在「这件事跟哪只票、哪个板块、哪类事件有关」，
 * 这些用词典 + 正则就能拿到 90% 的准头，而且零 token、零延迟、可解释。
 * 模型只留作后续可选增益（P2），不放在主路径上。
 *
 * 词典来源（都不硬编码在代码里）：
 *  - 个股名→代码：market-report 每日快照的涨停池/涨跌幅/龙虎榜 + 持仓快照；
 *  - 行业名：同一份快照的 sectors；
 *  - 事件类型：本文件里的一张规则表（这就是知识本身，放代码里更可读）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanText } from './schema.js'

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const MARKET_DIR =
  process.env.DSH_WALLSTREET_MARKET_DIR || process.env.DSH_WALLSTREET_DATA_DIR || join(PLUGIN_ROOT, 'data')
const MARKET_JSON = join(MARKET_DIR, 'market_data.json')
const HOLDINGS_DIR =
  process.env.DSH_WALLSTREET_HOLDINGS_DIR || join(PLUGIN_ROOT, 'data', 'quant-archive', 'data')

/** 词典缓存 10 分钟：快照一天一变，没必要每条都读盘。 */
const DICT_TTL_MS = 10 * 60 * 1000

let dictionary = { at: 0, names: new Map(), sectors: [], watchlist: new Set() }

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 构建/刷新词典。任何文件缺失都退化成空词典，打标继续跑（只是抽不到标的）。
 * @returns {Promise<{names: Map<string,string>, sectors: string[], watchlist: Set<string>}>}
 */
export async function loadDictionary(force = false) {
  if (!force && Date.now() - dictionary.at < DICT_TTL_MS) return dictionary
  const names = new Map()
  const sectors = []
  const watchlist = new Set()
  const market = await readJson(MARKET_JSON)
  const hot = new Set()
  const addRow = (row) => {
    if (!row) return
    const code = String(row.code || row.secCode || '').trim()
    const name = cleanText(row.name || row.secName || '', 12)
    if (/^\d{6}$/.test(code) && name.length >= 2 && !names.has(name)) names.set(name, code)
  }
  if (market) {
    for (const key of ['zt_pool', 'top10', 'bot10', 'lhb']) {
      for (const row of Array.isArray(market[key]) ? market[key] : []) {
        addRow(row)
        const code = String((row && row.code) || '').trim()
        if (/^\d{6}$/.test(code)) hot.add(code)
      }
    }
    for (const row of Array.isArray(market.sectors) ? market.sectors : []) {
      const name = cleanText(row && (row.name || row['行业']), 12)
      if (name && !sectors.includes(name)) sectors.push(name)
    }
    for (const row of Array.isArray(market.sector_flow) ? market.sector_flow : []) {
      const name = cleanText(row && (row['行业'] || row.industry), 12)
      if (name && !sectors.includes(name)) sectors.push(name)
    }
  }
  // 持仓：group_members 只有代码，没有名字 —— 用来给「自己的票」加权。
  try {
    const { readdir } = await import('node:fs/promises')
    const files = (await readdir(HOLDINGS_DIR))
      .filter((name) => /^holdings_concentration_\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort()
    if (files.length > 0) {
      const node = await readJson(join(HOLDINGS_DIR, files[files.length - 1]))
      for (const codes of Object.values((node && node.group_members) || {})) {
        for (const code of Array.isArray(codes) ? codes : []) {
          if (/^\d{6}$/.test(String(code))) watchlist.add(String(code))
        }
      }
    }
  } catch {
    /* 没有持仓快照也照常跑 */
  }
  dictionary = { at: Date.now(), names, sectors, watchlist, hot }
  return dictionary
}

/**
 * 事件类型规则表。顺序即优先级：先命中先定类。
 * `weight` 进重要度公式；`pattern` 用中文关键词，避免正则转义噪音。
 */
export const EVENT_RULES = [
  { type: '风险事件', weight: 22, words: ['立案', '处罚', '问询', '警示函', '退市', 'ST', '违约', '爆雷', '诉讼', '冻结', '停产', '事故', '召回', '被查', '监管函', '处分'] },
  { type: '货币政策', weight: 20, words: ['降准', '降息', '加息', 'LPR', 'MLF', '逆回购', '公开市场', '存款准备金', '再贷款', 'PSL', '流动性'] },
  { type: '宏观数据', weight: 16, words: ['CPI', 'PPI', 'GDP', 'PMI', '社融', 'M2', '非农', '失业率', '进出口', '零售销售', '工业增加值', '固投', '财政赤字'] },
  { type: '政策法规', weight: 18, words: ['国务院', '证监会', '发改委', '工信部', '财政部', '商务部', '央行', '政策', '关税', '补贴', '监管', '征求意见', '新规', '试点', '指导意见', '规划', '出口管制'] },
  { type: '重组并购', weight: 16, words: ['重组', '并购', '收购', '资产注入', '借壳', '要约', '吸收合并', '股权转让', '控制权'] },
  { type: '业绩', weight: 12, words: ['业绩预告', '业绩快报', '预增', '预减', '扭亏', '净利润', '营业收入', '年报', '季报', '预告', '超预期', '不及预期'] },
  { type: '中标合同', weight: 11, words: ['中标', '签约', '合同', '订单', '框架协议', '战略合作'] },
  { type: '停复牌', weight: 14, words: ['停牌', '复牌', '临时停牌', '终止上市'] },
  { type: '融资', weight: 10, words: ['定增', '配股', '可转债', '增发', '发债', 'IPO', '上市辅导', '注册生效', '过会'] },
  { type: '减持增持', weight: 9, words: ['减持', '增持', '回购', '股权激励', '员工持股', '解禁', '限售股'] },
  { type: '分红送转', weight: 7, words: ['分红', '派息', '送转', '特别股息', '利润分配'] },
  { type: '涨价提价', weight: 12, words: ['涨价', '提价', '涨价函', '上调价格', '价格上调', '供不应求', '紧缺', '缺口'] },
  { type: '海外市场', weight: 14, words: ['美联储', '欧央行', '日本央行', '美股', '纳指', '道指', '俄乌', '中东', 'OPEC', '地缘', '原油', '黄金', '美元指数', '汇率'] },
]

/** 板块别名：把新闻里常见的说法映射到快照的行业名上（粗匹配用）。 */
export const SECTOR_ALIASES = [
  '半导体', '芯片', '人工智能', '算力', '光伏', '锂电', '储能', '新能源车', '稀土', '黄金', '有色金属',
  '铜', '铝', '煤炭', '石油', '化工', '钢铁', '银行', '券商', '保险', '地产', '白酒', '食品饮料',
  '医药', '创新药', '军工', '电力', '农业', '养殖', '传媒', '游戏', '消费电子', '汽车', '家电',
  '机械', '基建', '航运', '港口', '航空', '旅游', '零售', '纺织', '造纸', '环保', '通信', '软件',
]

const KIND_BASE = { policy: 52, announcement: 40, report: 30, flash: 24 }

/**
 * 「是政策，但与交易无关」的降权词：节假日安排、保护区规划、表彰、人事任免这类
 * 公告会在政策库里排到前面，若不降权会把资讯面板的重要度榜刷成政务流水账。
 * 只降权不丢条目——用户在政策筛选里仍能看到它们。
 */
/** 「跟二级市场有关」的词：直接影响交易决策的政策/数据才配高分。 */
const MARKET_WORDS = [
  '降准', '降息', '加息', 'LPR', 'MLF', '逆回购', '存款准备金', '社融', 'M2', 'CPI', 'PPI', 'PMI',
  '关税', '补贴', '出口管制', '涨价', '提价', '限产', '停产', '退市', '立案', '处罚', '问询',
  '涨停', '跌停', '主力', '成交额', '净流入', '解禁', '减持', '回购', '并购', '重组', '中标',
]

const DEMOTE_WORDS = ['节假日', '放假', '保护区', '风景名胜', '表彰', '任免', '逝世', '贺信', '慰问', '纪念', '座谈会']

/**
 * 给一条 item 打标（原地返回新对象）：
 *  - tickers：标题/摘要里的 6 位代码 + 词典里的股票名；
 *  - sectors：行业名/别名命中；
 *  - eventType：规则表首个命中；
 *  - importance：kind 基准 + 类型权重 + 标的加权 + 自选加权，夹在 0–100。
 */
export function tagItem(item, dict) {
  const text = `${item.title} ${item.summary}`
  const tickers = new Set(Array.isArray(item.tickers) ? item.tickers : [])
  for (const match of text.matchAll(/\b(\d{6})\b/g)) tickers.add(match[1])
  if (dict && dict.names) {
    for (const [name, code] of dict.names) {
      if (name.length >= 2 && text.includes(name)) tickers.add(code)
    }
  }
  const sectors = new Set(Array.isArray(item.sectors) ? item.sectors : [])
  if (dict) {
    for (const name of dict.sectors) {
      if (name.length >= 2 && text.includes(name)) sectors.add(name)
    }
  }
  for (const alias of SECTOR_ALIASES) {
    if (text.includes(alias)) sectors.add(alias)
  }

  let eventType = ''
  let typeWeight = 0
  for (const rule of EVENT_RULES) {
    if (rule.words.some((word) => text.includes(word))) {
      eventType = rule.type
      typeWeight = rule.weight
      break
    }
  }

  const tickerList = [...tickers].slice(0, 8)
  const watchHit = tickerList.some((code) => dict && dict.watchlist && dict.watchlist.has(code))
  const hotHit = tickerList.some((code) => dict && dict.hot && dict.hot.has(code))
  const demoted = DEMOTE_WORDS.some((word) => text.includes(word))
  const marketWord = MARKET_WORDS.some((word) => text.includes(word))

  // 每个分量都单列出来，面板可以解释「为什么这条分高」，也方便调参。
  const parts = {
    kind: KIND_BASE[item.kind] || 22,
    type: Math.round(typeWeight * 0.9),
    ticker: tickerList.length > 0 ? 8 : 0,
    multi: tickerList.length >= 2 ? 5 : 0,
    watch: watchHit ? 8 : 0,
    hot: hotHit ? 6 : 0,
    market: marketWord ? 5 : 0,
    demote: demoted ? -26 : 0,
    degraded: item.degraded ? -4 : 0,
  }
  let importance = Object.values(parts).reduce((sum, value) => sum + value, 0)
  // 政务流水账（节假日/保护区/表彰）封顶：不丢，但不许挤进重要度前列。
  if (demoted) importance = Math.min(importance, 42)
  // 政策/宏观类只有真带市场含义的词才配高分；纯程序性通知压在 55 以下。
  if ((item.kind === 'policy' || eventType === '政策法规') && !marketWord && !demoted) {
    importance = Math.min(importance, 58)
  }

  return {
    ...item,
    tickers: tickerList,
    sectors: [...sectors].slice(0, 4),
    eventType,
    importance: Math.max(0, Math.min(100, Math.round(importance))),
    importanceParts: parts,
  }
}

/** 簇内合并：事件类型取最高频（平票取权重更高），重要度取最大。 */
export function mergeTags(items) {
  const counts = new Map()
  let bestType = ''
  let bestWeight = -1
  const tickers = new Set()
  const sectors = new Set()
  let importance = 0
  const maxParts = {}
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    if (item.importanceParts) {
      for (const [key, value] of Object.entries(item.importanceParts)) {
        if (typeof value === 'number' && (maxParts[key] === undefined || value > maxParts[key])) maxParts[key] = value
      }
    }
    if (item.eventType) {
      counts.set(item.eventType, (counts.get(item.eventType) || 0) + 1)
      const weight = (EVENT_RULES.find((rule) => rule.type === item.eventType) || {}).weight || 0
      if (weight > bestWeight) {
        bestWeight = weight
        bestType = item.eventType
      }
    }
    for (const code of item.tickers || []) tickers.add(code)
    for (const name of item.sectors || []) sectors.add(name)
    importance = Math.max(importance, Number(item.importance) || 0)
  }
  if (counts.size > 0) {
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
    const top = ranked[0]
    const tie = ranked.filter((entry) => entry[1] === top[1])
    bestType = tie.length > 1 && bestType ? bestType : top[0]
  }
  // 扩散度：几个源同时报，说明这事不小（但最多 +10，不许盖过基本面权重）。
  const distinctSources = new Set(items.map((item) => item.source).filter(Boolean)).size
  const diffusion = Math.min(10, Math.max(0, distinctSources - 1) * 4)
  const final = Math.max(0, Math.min(100, importance + diffusion))
  return {
    eventType: bestType,
    tickers: [...tickers].slice(0, 8),
    sectors: [...sectors].slice(0, 4),
    importance: final,
    importanceParts: { ...maxParts, sources: distinctSources, diffusion },
  }
}
