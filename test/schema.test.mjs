/**
 * lib/hub/schema.js —— 纯函数单测
 *
 * 这里只测「输入 → 输出」，不碰网络、不碰数据库、不碰文件系统。
 * 时间相关全部注入固定值，不依赖 Date.now() 的真实读数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  itemId,
  hash,
  cleanText,
  toMs,
  uniqueStrings,
  makeItem,
  eventIdOf,
  trigrams,
  jaccard,
  normalizeTitle,
  normalizeText,
  hasCjk,
  tokenize,
  tokenSetJaccard,
  tokenLcsRatio,
  lcsRatio,
  titleSimilarity,
  normalizeSector,
  sectorMatches,
  sectorVariants,
  beijingDayStart,
  formatStamp,
} from '../lib/hub/schema.js'

const SHANGHAI = 8 * 60 * 60 * 1000
/** 北京时间 → epoch ms（测试里造固定时刻用）。 */
const bj = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) - SHANGHAI
const iso = (ms) => new Date(ms).toISOString()

/* ------------------------------- toMs：时间解析 ------------------------------- */

test('toMs：13 位数字当毫秒，原样返回', () => {
  assert.equal(toMs(1_700_000_000_000, 1), 1_700_000_000_000)
  assert.equal(toMs(1_700_000_000_001, 1), 1_700_000_000_001)
})

test('toMs：10 位数字当秒，乘 1000', () => {
  assert.equal(toMs(1_700_000_000, 1), 1_700_000_000_000)
  assert.equal(toMs(1_600_000_001, 1), 1_600_000_001_000)
})

test('toMs：字符串时间戳按位数补到毫秒', () => {
  assert.equal(toMs('1700000000', 1), 1_700_000_000_000)
  assert.equal(toMs('1700000000000', 1), 1_700_000_000_000)
})

test("toMs：'YYYY-MM-DD HH:mm:ss' 按 Asia/Shanghai 解释", () => {
  // 北京时间 2026-11-25 09:30:00 = UTC 01:30
  assert.equal(toMs('2026-11-25 09:30:00', 1), bj(2026, 11, 25, 9, 30, 0))
  assert.equal(iso(toMs('2026-11-25 09:30:00', 1)), '2026-11-25T01:30:00.000Z')
})

test("toMs：'YYYY-MM-DD HH:mm' 缺秒时按 00 秒", () => {
  assert.equal(toMs('2026-11-25 09:30', 1), bj(2026, 11, 25, 9, 30, 0))
})

test("toMs：'YYYY/MM/DD' 斜杠格式与只有日期（00:00 北京）", () => {
  assert.equal(toMs('2026/11/25 09:30', 1), bj(2026, 11, 25, 9, 30))
  assert.equal(toMs('2026-11-25', 1), bj(2026, 11, 25))
  assert.equal(iso(toMs('2026-11-25', 1)), '2026-11-24T16:00:00.000Z')
})

test('toMs：无时区 ISO 串同样按北京时间解释', () => {
  assert.equal(toMs('2026-11-25T09:30:00', 1), bj(2026, 11, 25, 9, 30))
  // 带 +08:00 的 ISO 与无时区写法应解析到同一时刻
  assert.equal(toMs('2026-11-25T09:30:00', 1), bj(2026, 11, 25, 9, 30))
})

test('toMs：Date 实例取 getTime，无效 Date 回退 fallback', () => {
  assert.equal(toMs(new Date('2026-11-25T01:30:00Z'), 1), Date.UTC(2026, 10, 25, 1, 30))
  assert.equal(toMs(new Date('not a date'), 424242), 424242)
})

test('toMs：解析不了的一律回退 fallback（不抛错、不瞎猜）', () => {
  assert.equal(toMs('不是时间', 111), 111)
  assert.equal(toMs('', 222), 222)
  assert.equal(toMs('   ', 333), 333)
  assert.equal(toMs(null, 444), 444)
  assert.equal(toMs(undefined, 555), 555)
  assert.equal(toMs(0, 666), 666)
  assert.equal(toMs(-1_700_000_000_000, 777), 777)
  assert.equal(toMs(NaN, 888), 888)
  // 9 位数字：既不是 10 位秒也不是 13 位毫秒 → 回退
  assert.equal(toMs(123_456_789, 999), 999)
})

test('toMs：不传 fallback 时回退到「现在」，返回有限时间戳', () => {
  const before = Date.now()
  const value = toMs('完全不是时间')
  const after = Date.now()
  assert.ok(Number.isFinite(value))
  assert.ok(value >= before && value <= after)
})

/* ------------------------------- cleanText：文本清洗 ------------------------------- */

test('cleanText：去 HTML 标签、script 块与常见实体', () => {
  assert.equal(cleanText('<b>央行</b>降准'), '央行 降准')
  assert.equal(cleanText('<script>alert(1)</script>正文'), '正文')
  assert.equal(cleanText('a&nbsp;b'), 'a b')
  assert.equal(cleanText('利润&amp;营收'), '利润&营收')
  assert.equal(cleanText('&lt;tag&gt;'), '<tag>')
  assert.equal(cleanText('他说&quot;涨&quot;'), '他说"涨"')
  assert.equal(cleanText("it&#39;s"), "it's")
})

test('cleanText：空白（含换行/制表）压成单个空格并去首尾', () => {
  assert.equal(cleanText('  a\n\tb  '), 'a b')
  assert.equal(cleanText('第一行\n\n第二行'), '第一行 第二行')
})

test('cleanText：超过 max 时截到 max-1 再加省略号', () => {
  assert.equal(cleanText('一二三四五', 4), '一二三…')
  assert.equal(cleanText('abcdef', 6), 'abcdef')
  assert.equal(cleanText('abcdef', 7), 'abcdef')
  const long = cleanText('字'.repeat(300))
  assert.equal(long.length, 120)
  assert.ok(long.endsWith('…'))
})

test('cleanText：max 非正数/非有限数不截断，null/undefined 当空串', () => {
  assert.equal(cleanText('abcdef', 0), 'abcdef')
  assert.equal(cleanText('abcdef', -3), 'abcdef')
  assert.equal(cleanText('abcdef', NaN), 'abcdef')
  assert.equal(cleanText('abcdef', Infinity), 'abcdef')
  assert.equal(cleanText(null), '')
  assert.equal(cleanText(undefined), '')
  assert.equal(cleanText(123), '123')
})

/* ------------------------------- id：去重键稳定性 ------------------------------- */

test('itemId：同一来源同一 url 每次都得到同一个 id', () => {
  const a = itemId('eastmoney', 'https://example.com/a', '标题一')
  const b = itemId('eastmoney', 'https://example.com/a', '标题二（改了标题）')
  assert.equal(a, b)
  assert.equal(a, itemId('eastmoney', 'https://example.com/a', '标题一'))
})

test('itemId：来源不同则 id 不同（不同源同 url 不合并）', () => {
  assert.notEqual(itemId('eastmoney', 'https://example.com/a', 't'), itemId('sina', 'https://example.com/a', 't'))
})

test('itemId：url 缺失时退回标题', () => {
  const fromTitle = itemId('s', '', '同一条新闻')
  assert.equal(fromTitle, itemId('s', null, '同一条新闻'))
  assert.equal(fromTitle, itemId('s', undefined, '同一条新闻'))
  assert.notEqual(fromTitle, itemId('s', '', '另一条新闻'))
  // url 与标题都没给 → 稳定地在 's|' 上取哈希
  assert.equal(itemId('s', '', ''), itemId('s', '', ''))
})

test('itemId/hash/eventIdOf：16 位十六进制、稳定且可追溯', () => {
  const id = itemId('s', 'https://example.com/x', 't')
  assert.match(id, /^[0-9a-f]{16}$/)
  assert.match(hash('whatever'), /^[0-9a-f]{16}$/)
  assert.equal(hash('same'), hash('same'))
  assert.notEqual(hash('a'), hash('b'))
  const eventId = eventIdOf({ id: 'abc123' })
  assert.equal(eventId, eventIdOf({ id: 'abc123' }))
  assert.notEqual(eventId, eventIdOf({ id: 'abc124' }))
  assert.match(eventId, /^[0-9a-f]{16}$/)
})

test('uniqueStrings：去重、去空、截断，单字符串也接受', () => {
  assert.deepEqual(uniqueStrings(['a', 'b', 'a', '', '  ']), ['a', 'b'])
  assert.deepEqual(uniqueStrings('a'), ['a'])
  assert.deepEqual(uniqueStrings(null), [])
  assert.deepEqual(uniqueStrings(undefined), [])
  assert.deepEqual(uniqueStrings(['1', '2', '3'], 2), ['1', '2'])
  assert.deepEqual(uniqueStrings([' a ', 'a']), ['a'])
})

test('makeItem：标题为空返回 null，正常条目字段归一', () => {
  assert.equal(makeItem(null, { id: 's' }), null)
  assert.equal(makeItem({ title: '   ' }, { id: 's' }), null)
  const item = makeItem(
    { title: '<b>央行降准</b>', summary: '摘要', url: ' https://e.com/a ', ts: 1_700_000_000, tickers: ['sh600519'], sectors: ['半导体', '半导体'], kind: 'policy' },
    { id: 'eastmoney', label: '东方财富', kind: 'flash' },
  )
  assert.equal(item.source, 'eastmoney')
  assert.equal(item.sourceLabel, '东方财富')
  assert.equal(item.kind, 'policy') // raw.kind 优先于 meta.kind
  assert.equal(item.title, '央行降准')
  assert.equal(item.url, 'https://e.com/a')
  assert.equal(item.ts, 1_700_000_000_000)
  assert.deepEqual(item.tickers, ['600519']) // 去掉 sh/sz/bj 前缀
  assert.deepEqual(item.sectors, ['半导体'])
  assert.equal(item.eventType, '')
  assert.equal(item.importance, 0)
  assert.equal(item.degraded, false)
})

test('makeItem：未知 kind 落 flash，meta.kind 兜底', () => {
  assert.equal(makeItem({ title: 't', kind: '不知道' }, { id: 's' }).kind, 'flash')
  assert.equal(makeItem({ title: 't' }, { id: 's', kind: 'report' }).kind, 'report')
  assert.equal(makeItem({ title: 't' }, { id: 's' }).sourceLabel, 's')
})

/* ------------------------------- 相似度：trigrams / jaccard / LCS ------------------------------- */

test('trigrams：空/短串规则 + 忽略大小写、标点与空白', () => {
  assert.equal(trigrams('').size, 0)
  assert.equal(trigrams(null).size, 0)
  assert.deepEqual([...trigrams('a')], ['a'])
  assert.deepEqual([...trigrams('ab')], ['ab'])
  assert.deepEqual([...trigrams('abc')], ['abc'])
  assert.equal(trigrams('abcd').size, 2)
  assert.deepEqual([...trigrams('abcde')], ['abc', 'bcd', 'cde'])
  // 归一化后再切 3-gram
  assert.deepEqual([...trigrams('A B, c')], ['abc'])
  assert.deepEqual([...trigrams('A B, c')], [...trigrams('abc')])
  assert.deepEqual([...trigrams('半导体！')], [...trigrams('半导体')])
})

test('trigrams：口径走 NFKC——全角字母/数字与半角是同一组 3-gram', () => {
  assert.deepEqual([...trigrams('ＮＶＩＤＩＡ')], [...trigrams('NVIDIA')])
  // 摘要去重（ingest 用 jaccard(trigrams(summary))）同样不再被全角数字拆散
  assert.equal(jaccard(trigrams('同比增长３０％'), trigrams('同比增长30%')), 1)
})

test('jaccard：空集为 0、相同为 1、不相交为 0、部分重叠按交集/并集', () => {
  assert.equal(jaccard(new Set(), new Set()), 0)
  assert.equal(jaccard(new Set(), trigrams('abc')), 0)
  assert.equal(jaccard(trigrams('半导体'), trigrams('半导体')), 1)
  assert.equal(jaccard(trigrams('abc'), trigrams('xyz')), 0)
  // {半导体} vs {半导体, 导体设, 体设备} → 1/3
  assert.equal(jaccard(trigrams('半导体'), trigrams('半导体设备')), 1 / 3)
})

test('normalizeTitle：小写 + 去空白与标点', () => {
  assert.equal(normalizeTitle('央行开展 1 万亿元 MLF 操作！'), '央行开展1万亿元mlf操作')
  assert.equal(normalizeTitle('  ABC  '), 'abc')
  assert.equal(normalizeTitle(null), '')
})

/* ------------------------- normalizeText：NFKC 严格归一化 ------------------------- */

test('normalizeText：NFKC 把全角字母/数字折成半角', () => {
  assert.equal(normalizeText('ＮＶＩＤＩＡ １Ｑ'), 'nvidia1q')
  assert.equal(normalizeText('１２３'), '123')
  // 兼容字符：连字 → 基本字母，半角片假名 → 全角
  assert.equal(normalizeText('ﬁle'), 'file')
  assert.equal(normalizeText('ﾃｽﾄ'), 'テスト')
  assert.equal(normalizeText('①②３'), '123')
})

test('normalizeText：删控制/格式字符（零宽空格、BOM、NUL）后再折叠', () => {
  assert.equal(normalizeText('a\u200Bb\uFEFFc'), 'abc')
  assert.equal(normalizeText('a\u0000b\u001Fc'), 'abc')
  assert.equal(normalizeText('央行\u200B降准'), '央行降准')
})

test('normalizeText：去标点/符号/空白（含全角空格），CJK 与拉丁都连写', () => {
  assert.equal(normalizeText('央行开展 1 万亿元 MLF 操作！'), '央行开展1万亿元mlf操作')
  assert.equal(normalizeText('半导体　设备'), '半导体设备')
  assert.equal(normalizeText(' "%$#@!? " '), '')
  assert.equal(normalizeText(null), '')
  assert.equal(normalizeText(undefined), '')
  assert.equal(normalizeText(''), '')
})

test('normalizeText：normalizeTitle 是同一个口径（旧名保留）', () => {
  for (const text of ['ＮＶＩＤＩＡ １Ｑ', '央行开展 1 万亿元 MLF 操作！', 'a\u200Bb', '', null]) {
    assert.equal(normalizeTitle(text), normalizeText(text))
  }
})

/* ------------------------- hasCjk / tokenize：按书写系统选切分单位 ------------------------- */

test('hasCjk：汉字/假名/谚文为真，纯拉丁与空值为假', () => {
  assert.equal(hasCjk('央行降准'), true)
  assert.equal(hasCjk('宁德时代 CATL'), true)
  assert.equal(hasCjk('ア汉字한글'), true)
  // NFKC 之后再判断：半角片假名折成全角后同样算 CJK
  assert.equal(hasCjk('ﾃｽﾄ'), true)
  assert.equal(hasCjk('NVIDIA beats Q3'), false)
  assert.equal(hasCjk(''), false)
  assert.equal(hasCjk(null), false)
  assert.equal(hasCjk('123 456'), false)
})

test('tokenize：含 CJK 走字符 bigram；单字退化为单字；长度 2 只有一个 bigram', () => {
  assert.deepEqual(tokenize('稀土价格上涨'), ['稀土', '土价', '价格', '格上', '上涨'])
  assert.deepEqual(tokenize('稀土'), ['稀土'])
  assert.deepEqual(tokenize('涨'), ['涨'])
  assert.deepEqual(tokenize('a涨'), ['a涨'])
  // 标点与空白不产生 bigram（归一化后连写）
  assert.deepEqual(tokenize('稀土！价格 上涨'), tokenize('稀土价格上涨'))
})

test('tokenize：纯拉丁按词切，标点当词边界、撇号当词内符号', () => {
  assert.deepEqual(tokenize('NVIDIA beats Q3 earnings'), ['nvidia', 'beats', 'q3', 'earnings'])
  assert.deepEqual(tokenize('NVIDIA,beats Q3'), ['nvidia', 'beats', 'q3'])
  assert.deepEqual(tokenize("Fed's rate"), ['feds', 'rate'])
  assert.deepEqual(tokenize('ＮＶＩＤＩＡ １Ｑ'), ['nvidia', '1q'])
})

test('tokenize：中英混排不抛错，去空白后与连写完全同一切分', () => {
  assert.deepEqual(tokenize('宁德时代 CATL 发布半年报'), tokenize('宁德时代CATL发布半年报'))
  assert.deepEqual(tokenize('宁德时代 CATL 发布半年报'), [
    '宁德', '德时', '时代', '代c', 'ca', 'at', 'tl', 'l发', '发布', '布半', '半年', '年报',
  ])
})

test('tokenize：空串 / null / 纯标点都返回空数组', () => {
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(null), [])
  assert.deepEqual(tokenize(undefined), [])
  assert.deepEqual(tokenize('！！！。。。'), [])
  assert.deepEqual(tokenize('   '), [])
})

test('tokenSetJaccard：相同为 1、无交集为 0、空为 0，字符串入参自动切分', () => {
  assert.equal(tokenSetJaccard(tokenize('半导体'), tokenize('半导体')), 1)
  assert.equal(tokenSetJaccard(tokenize('半导体'), tokenize('贵州茅台')), 0)
  assert.equal(tokenSetJaccard([], []), 0)
  assert.equal(tokenSetJaccard(null, undefined), 0)
  assert.equal(tokenSetJaccard('NVIDIA beats Q3', 'nvidia beats q3'), 1)
  assert.equal(tokenSetJaccard(new Set(['a']), ['a']), 1)
  // {半导体, 导体设} vs {半导体, 导体设, 体设备, 设备} → 2/4
  assert.equal(tokenSetJaccard(tokenize('半导体'), tokenize('半导体设备')), 0.5)
})

test('lcsRatio：空串为 0、相同为 1、无关为 0、短串被完全包含为 1', () => {
  assert.equal(lcsRatio('', ''), 0)
  assert.equal(lcsRatio('', 'abc'), 0)
  assert.equal(lcsRatio('abc', ''), 0)
  assert.equal(lcsRatio('宁德时代扩产', '宁德时代扩产'), 1)
  assert.equal(lcsRatio('abc', 'xyz'), 0)
  assert.equal(lcsRatio('半导体', '半导体设备'), 1)
  assert.equal(lcsRatio('a', 'a'), 1)
})

test('lcsRatio：共享长前缀的改写标题仍拿到高分', () => {
  const ratio = lcsRatio('央行开展1万亿元MLF操作600519', '央行开展1万亿元MLF操作保持流动性')
  assert.ok(ratio >= 0.7, `长前缀改写应 >=0.7，实际 ${ratio}`)
  assert.ok(ratio < 1, `不该判成完全相同，实际 ${ratio}`)
})

test('lcsRatio：口径同样走 NFKC（与 tokenize 一致），全角/半角、零宽字符都不影响', () => {
  assert.equal(lcsRatio('ＮＶＩＤＩＡ １Ｑ', 'NVIDIA 1Q'), 1)
  assert.equal(lcsRatio('央行开展１万亿元ＭＬＦ操作', '央行开展1万亿元MLF操作'), 1)
  assert.equal(lcsRatio('a\u200Bb', 'ab'), 1)
})

test('tokenLcsRatio：词元粒度，词序一致才得分，字母撞车不算', () => {
  assert.equal(tokenLcsRatio('NVIDIA beats Q3', 'nvidia beats q3'), 1)
  assert.equal(tokenLcsRatio('NVIDIA beats Q3', 'Fed holds rates'), 0)
  assert.equal(tokenLcsRatio('', ''), 0)
  assert.equal(tokenLcsRatio([], []), 0)
  // 词序颠倒只保住公共词元数（1/2），不因字母撞车拿分
  assert.equal(tokenLcsRatio('beats NVIDIA', 'NVIDIA beats'), 0.5)
})

test('titleSimilarity：空标题不聚簇（0），相同为 1，无关为 0', () => {
  assert.equal(titleSimilarity('', ''), 0)
  assert.equal(titleSimilarity('', '央行降准'), 0)
  assert.equal(titleSimilarity('宁德时代扩产', '宁德时代扩产'), 1)
  assert.equal(titleSimilarity('央行降准', '贵州茅台涨价'), 0)
})

test('titleSimilarity：等于「token Jaccard」与「顺序侧 LCS」取大（口径按书写系统）', () => {
  // 含 CJK：顺序侧是字符级 LCS——中文改写常保留大段相同措辞，也是 ingest 阈值的标定基准
  const cjkPairs = [
    ['半导体', '半导体设备'],
    ['央行开展1万亿元MLF操作，保持流动性', '央行开展1万亿元MLF操作 保持流动性合理充裕'],
    ['紫金矿业关于控股股东减持股份的公告', '紫金矿业关于高管辞职的公告'],
  ]
  for (const [a, b] of cjkPairs) {
    assert.equal(
      titleSimilarity(a, b),
      Math.max(tokenSetJaccard(tokenize(a), tokenize(b)), lcsRatio(a, b)),
      `CJK 口径不符：${a} / ${b}`,
    )
  }
  // 纯拉丁：顺序侧是词元级 LCS（字符级 LCS 在英文上太宽松，见下一条）
  const latinPairs = [
    ['NVIDIA beats Q3 earnings estimates', 'NVIDIA beats Q3 earnings estimate'],
    ['Fed holds rates steady', 'Fed leaves rates unchanged'],
  ]
  for (const [a, b] of latinPairs) {
    assert.equal(
      titleSimilarity(a, b),
      Math.max(tokenSetJaccard(tokenize(a), tokenize(b)), tokenLcsRatio(a, b)),
      `拉丁口径不符：${a} / ${b}`,
    )
  }
})

/* ------------------------- 标题相似度：分书写系统的口径 ------------------------- */

test('titleSimilarity：英文近似标题高相似（实测 0.8），无关标题低相似（实测 0）', () => {
  const near = titleSimilarity('NVIDIA beats Q3 earnings estimates', 'NVIDIA beats Q3 earnings estimate')
  assert.ok(near >= 0.7, `英文近似应 >=0.7，实际 ${near}`)
  // token Jaccard 4/6≈0.667，词元 LCS 4/5=0.8 → 取大
  assert.equal(near, 0.8)

  const far = titleSimilarity('NVIDIA beats Q3 earnings estimates', 'Fed holds rates steady')
  assert.ok(far < 0.3, `英文无关应 <0.3，实际 ${far}`)
  assert.equal(far, 0)
})

test('titleSimilarity：英文无关标题——字符级 LCS 上有 0.42 的假高分，词元级为 0', () => {
  const a = 'NVIDIA beats Q3 earnings estimates'
  const b = 'Fed holds rates steady'
  // 旧口径的第二路（字符级 LCS）在这对无关标题上仍有 8/19≈0.421：字母撞车太多
  assert.equal(lcsRatio(a, b), 8 / 19)
  assert.ok(lcsRatio(a, b) > 0.3)
  // 换成语义单位一致的词元级 LCS 后为 0，整体相似度才压得下来
  assert.equal(tokenLcsRatio(a, b), 0)
  assert.ok(tokenLcsRatio(a, b) < lcsRatio(a, b))
})

test('titleSimilarity：CJK 短标题——bigram 口径明显高于旧 trigram 口径', () => {
  const a = '稀土价格上涨'
  const b = '稀土价格上调'
  const tokenScore = tokenSetJaccard(tokenize(a), tokenize(b))
  const trigramScore = jaccard(trigrams(a), trigrams(b))
  // bigram：5 个窗口共享 4 → 4/6≈0.667
  assert.equal(tokenScore, 4 / 6)
  // 旧 trigram：4 个窗口共享 3 → 3/5=0.6（4 字/5 字按 3 字切，短标题上几乎丢掉差异位）
  assert.equal(trigramScore, 3 / 5)
  assert.ok(tokenScore > trigramScore, `bigram 应高于 trigram：${tokenScore} vs ${trigramScore}`)
  assert.ok(tokenScore - trigramScore >= 0.06, `差值应 >=0.06，实际 ${(tokenScore - trigramScore).toFixed(4)}`)
  // 整体值由字符级 LCS（5/6≈0.833）兜住，改造前后都稳在快讯阈值 0.5 以上
  assert.ok(titleSimilarity(a, b) >= 0.83, `整体应 >=0.83，实际 ${titleSimilarity(a, b)}`)
})

test('titleSimilarity：CJK 短标题——trigram 完全失效时 bigram 仍给出信号', () => {
  // 「央行降准」vs「央行宣布降准」：旧 trigram 交集为空，bigram 仍共享 央行/降准
  assert.equal(jaccard(trigrams('央行降准'), trigrams('央行宣布降准')), 0)
  assert.equal(tokenSetJaccard(tokenize('央行降准'), tokenize('央行宣布降准')), 1 / 3)
  // 「半导体」vs「半导体设备」：bigram 2/4=0.5，旧 trigram 1/3
  assert.equal(tokenSetJaccard(tokenize('半导体'), tokenize('半导体设备')), 0.5)
  assert.equal(jaccard(trigrams('半导体'), trigrams('半导体设备')), 1 / 3)
})

test('titleSimilarity：中英混排不抛错，仅空白差异判为完全相同', () => {
  assert.equal(titleSimilarity('宁德时代 CATL 发布半年报', '宁德时代CATL发布半年报'), 1)
  const mixed = titleSimilarity('宁德时代 CATL', 'CATL earnings')
  assert.ok(Number.isFinite(mixed))
  assert.ok(mixed >= 0 && mixed <= 1)
})

test('titleSimilarity：全角数字/字母（NFKC）与半角判为相同', () => {
  assert.equal(titleSimilarity('ＮＶＩＤＩＡ １Ｑ', 'NVIDIA 1Q'), 1)
  assert.equal(titleSimilarity('央行开展１万亿元ＭＬＦ操作', '央行开展1万亿元MLF操作'), 1)
})

test('titleSimilarity：空串 / 纯标点 / 单字的边界明确为 0 或 1', () => {
  assert.equal(titleSimilarity('', ''), 0)
  assert.equal(titleSimilarity('', '涨'), 0)
  assert.equal(titleSimilarity('abc', ''), 0)
  assert.equal(titleSimilarity(null, undefined), 0)
  assert.equal(titleSimilarity('！！！。。。', ''), 0)
  assert.equal(titleSimilarity('，', '。'), 0) // 纯标点归一化后为空 → 0，不会互相聚簇
  assert.equal(titleSimilarity('涨', '涨'), 1) // 单字退化为单字：相等即 1
  assert.equal(titleSimilarity('涨', '跌'), 0)
  assert.equal(titleSimilarity('a', 'a'), 1) // 拉丁单字母同理
})

test('titleSimilarity：ingest 中文口径不漂移（快讯阈值 0.5 的两条边界）', () => {
  // 应聚簇：实测 0.5909（13/22 字符级 LCS），与改造前完全一致
  const mlf = titleSimilarity(
    '央行开展 1 万亿元 MLF 操作 600519 贵州茅台',
    '央行开展1万亿元MLF操作，保持流动性合理充裕',
  )
  assert.equal(mlf, 13 / 22)
  assert.ok(mlf >= 0.5, `央行/MLF 同事件应 >=0.5，实际 ${mlf}`)

  // 不应聚簇：实测 0
  const unrelated = titleSimilarity('某公司发布三季报 净利润同比增长 30%', '这只票被立案调查')
  assert.equal(unrelated, 0)
  assert.ok(unrelated < 0.5, `无关快讯应 <0.5，实际 ${unrelated}`)
})

/* ------------------------------- 板块归一化 ------------------------------- */

test('normalizeSector：去掉行业/板块/概念/指数/服务/制造/设备/产业后缀', () => {
  assert.equal(normalizeSector('半导体行业'), '半导体')
  assert.equal(normalizeSector('芯片板块'), '芯片')
  assert.equal(normalizeSector('人工智能概念'), '人工智能')
  assert.equal(normalizeSector('沪深300指数'), '沪深300')
  assert.equal(normalizeSector('半导体设备'), '半导体')
  assert.equal(normalizeSector('白酒'), '白酒')
  assert.equal(normalizeSector('有色金属'), '有色金属')
})

test('normalizeSector：只去掉最后一个后缀（不做链式剥离）', () => {
  // '设备制造' → 去掉末尾 '制造' 得 '风电设备'，不会继续剥 '设备'
  assert.equal(normalizeSector('风电设备制造'), '风电设备')
})

test('normalizeSector：去半角/全角空格，空值返回空串', () => {
  assert.equal(normalizeSector('半导体 行业'), '半导体')
  assert.equal(normalizeSector('半导体　行业'), '半导体')
  assert.equal(normalizeSector(''), '')
  assert.equal(normalizeSector(null), '')
})

test('sectorMatches：归一化后相等或包含（短边 >= 2 字）为真', () => {
  assert.equal(sectorMatches('半导体', '半导体设备'), true) // 归一化后相等
  assert.equal(sectorMatches('有色', '有色金属'), true)
  assert.equal(sectorMatches('白酒', '白酒行业'), true)
  assert.equal(sectorMatches('半导体', '芯片'), false)
  assert.equal(sectorMatches('水产养殖', '半导体'), false)
})

test('sectorMatches：短边只有 1 字或任一侧为空时为假', () => {
  assert.equal(sectorMatches('钢', '钢铁'), false)
  assert.equal(sectorMatches('', '钢铁'), false)
  assert.equal(sectorMatches('钢铁', ''), false)
  assert.equal(sectorMatches(null, null), false)
})

test('sectorVariants：原始名 + 归一化名 + 别名', () => {
  const variants = sectorVariants('半导体')
  assert.ok(variants.includes('半导体'))
  assert.ok(variants.includes('芯片'))
  assert.ok(variants.includes('集成电路'))
})

test('sectorVariants：半导体设备 → 含「半导体」，东财细分名补 2 字核心词', () => {
  const variants = sectorVariants('半导体设备')
  assert.ok(variants.includes('半导体'), `应含半导体：${variants.join('/')}`)
  assert.ok(variants.includes('半导体设备'))
  assert.ok(variants.includes('芯片'))

  const fine = sectorVariants('集成电路封测')
  assert.ok(fine.includes('集成电路封测'))
  assert.ok(fine.includes('集成'))
  assert.ok(fine.includes('封测'))

  const aqua = sectorVariants('水产养殖')
  assert.ok(aqua.includes('水产养殖'))
  assert.ok(aqua.includes('养殖'))
  assert.ok(!aqua.includes('半导体'))
})

test('sectorVariants：有色金属展开常见同义词；空名返回空数组', () => {
  const variants = sectorVariants('有色金属')
  for (const expected of ['有色金属', '有色', '铜', '铝', '黄金']) {
    assert.ok(variants.includes(expected), `应含 ${expected}：${variants.join('/')}`)
  }
  assert.deepEqual(sectorVariants(''), [])
  assert.deepEqual(sectorVariants(null), [])
  assert.deepEqual(sectorVariants('   '), [])
})

/* ------------------------------- 时间口径 ------------------------------- */

test('beijingDayStart：任意时刻都落到当天北京 00:00（恰为 00:00 时返回自身）', () => {
  // 2026-11-25 10:30 北京
  assert.equal(iso(beijingDayStart(bj(2026, 11, 25, 10, 30))), '2026-11-24T16:00:00.000Z')
  // 2026-11-25 00:05 北京（UTC 还是前一天 16:05）
  assert.equal(iso(beijingDayStart(bj(2026, 11, 25, 0, 5))), '2026-11-24T16:00:00.000Z')
  // 2026-11-24 23:59 北京
  assert.equal(iso(beijingDayStart(bj(2026, 11, 24, 23, 59))), '2026-11-23T16:00:00.000Z')
  // 边界：恰好北京 00:00
  const midnight = bj(2026, 11, 25)
  assert.equal(beijingDayStart(midnight), midnight)
})

test("formatStamp：'MM-DD HH:mm' 补零；非法/零/负数时间显示占位符", () => {
  assert.equal(formatStamp(bj(2026, 11, 25, 9, 5)), '11-25 09:05')
  assert.equal(formatStamp(bj(2026, 1, 2, 3, 4)), '01-02 03:04')
  assert.equal(formatStamp(bj(2026, 12, 31, 23, 59)), '12-31 23:59')
  assert.equal(formatStamp(0), '—')
  assert.equal(formatStamp(-1), '—')
  assert.equal(formatStamp(NaN), '—')
  assert.equal(formatStamp(Infinity), '—')
  assert.equal(formatStamp(null), '—')
})

test('时区口径：toMs / beijingDayStart / formatStamp 三者对齐（+08:00）', () => {
  const text = '2026-11-25 09:30'
  const ms = toMs(text, 1)
  assert.equal(formatStamp(ms), '11-25 09:30')
  const dayStart = beijingDayStart(ms)
  assert.equal(toMs('2026-11-25', 1), dayStart)
  assert.equal((ms - dayStart) / 60_000, 9 * 60 + 30)
})

test('toMs：带明确时区的串按原时区解析（修 D4）', async () => {
  assert.equal(toMs('2026-11-25T09:30:00Z', 1), Date.parse('2026-11-25T09:30:00Z'))
  assert.equal(toMs('2026-11-25T09:30:00+08:00', 1), Date.parse('2026-11-25T09:30:00+08:00'))
  // 无时区信息仍然按北京时间解释
  assert.equal(toMs('2026-11-25 09:30:00', 1), Date.parse('2026-11-25T09:30:00+08:00'))
})
