/**
 * lib/hub/summarize.js —— LLM 摘要的纯函数单测
 *
 * 只测「模型输出文本 → 结构化结果 → 面板能用的提示词」这条链路，
 * 不调模型、不落库（runSummaries 属于集成验收，见 verification/verify-hub.mjs）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseSummaryOutput, cleanSummaryText, describeFinish, buildMessages } from '../lib/hub/summarize.js'

/* ------------------------------ parseSummaryOutput ------------------------------ */

test('parseSummaryOutput：合法 JSON 解析出摘要/倾向，且 degraded=false', () => {
  const parsed = parseSummaryOutput('{"summary":"央行开展 MLF 操作","sentiment":"利好"}')
  assert.deepEqual(parsed, { summary: '央行开展 MLF 操作', sentiment: '利好', degraded: false })
})

test('parseSummaryOutput：带 ```json 围栏也能解析', () => {
  const parsed = parseSummaryOutput('```json\n{"summary":"紫金矿业被立案，短期承压","sentiment":"利空"}\n```')
  assert.equal(parsed.summary, '紫金矿业被立案，短期承压')
  assert.equal(parsed.sentiment, '利空')
  assert.equal(parsed.degraded, false)
})

test('parseSummaryOutput：JSON 前后夹着解释文字时抠出花括号内容', () => {
  const parsed = parseSummaryOutput('好的，结果如下：{"summary":"公司中标10亿元大单","sentiment":"中性"} 希望有帮助')
  assert.equal(parsed.summary, '公司中标10亿元大单')
  assert.equal(parsed.degraded, false)
})

test('parseSummaryOutput：sentiment 非法或缺失一律落「中性」', () => {
  assert.equal(parseSummaryOutput('{"summary":"公司发布业绩预告","sentiment":"大涨"}').sentiment, '中性')
  assert.equal(parseSummaryOutput('{"summary":"公司发布业绩预告"}').sentiment, '中性')
  assert.equal(parseSummaryOutput('{"summary":"公司发布业绩预告","sentiment":null}').sentiment, '中性')
})

test('parseSummaryOutput：summary 首尾空白被 trim，JSON 里多余的 impact 不影响结果', () => {
  const parsed = parseSummaryOutput('{"summary":"  央行降准 0.5 个百分点  ","sentiment":"利好","impact":["600519"]}')
  assert.equal(parsed.summary, '央行降准 0.5 个百分点')
  assert.deepEqual(Object.keys(parsed).sort(), ['degraded', 'sentiment', 'summary'])
})

test('parseSummaryOutput：summary 恰好 4 字仍算合法 JSON（不被当废话）', () => {
  const parsed = parseSummaryOutput('{"summary":"央行降准"}')
  assert.equal(parsed.summary, '央行降准')
  assert.equal(parsed.degraded, false)
})

test('parseSummaryOutput：JSON 里 summary 不足 4 字 → 判空，不把 JSON 文本当摘要', () => {
  // 修 D3 之前这里会退回纯文本兜底，把 `{"summary":"好"}` 整段原样当摘要显示。
  assert.equal(parseSummaryOutput('{"summary":"好"}'), null)
  assert.equal(parseSummaryOutput('{"summary":"  "}'), null)
  // 但没有 JSON 结构的纯文本仍然走兜底。
  const plain = parseSummaryOutput('央行降准，流动性宽松')
  assert.equal(plain.degraded, true)
  assert.equal(plain.summary, '央行降准，流动性宽松')
})

test('parseSummaryOutput：JSON 里 summary 超长时截到 200 字', () => {
  const long = '字'.repeat(260)
  const parsed = parseSummaryOutput(JSON.stringify({ summary: long }))
  assert.equal(parsed.summary.length, 200)
  assert.equal(parsed.summary, long.slice(0, 200))
})

test('parseSummaryOutput：纯文本回答走兜底并标 degraded=true', () => {
  const parsed = parseSummaryOutput('紫金矿业收到立案告知书，短期承压明显。')
  assert.equal(parsed.degraded, true)
  assert.equal(parsed.sentiment, '中性')
  assert.equal(parsed.summary, '紫金矿业收到立案告知书，短期承压明显。')
})

test('parseSummaryOutput：围栏里不是 JSON 时也走纯文本兜底', () => {
  const parsed = parseSummaryOutput('```text\n公司公告：股东拟减持 2%\n```')
  assert.equal(parsed.degraded, true)
  assert.equal(parsed.summary, '公司公告：股东拟减持 2%')
})

test("parseSummaryOutput：'好的' 这类废话判空（返回 null）", () => {
  assert.equal(parseSummaryOutput('好的'), null)
  assert.equal(parseSummaryOutput('好的，收到'), null)
  assert.equal(parseSummaryOutput('   '), null)
  assert.equal(parseSummaryOutput(''), null)
  assert.equal(parseSummaryOutput(null), null)
  assert.equal(parseSummaryOutput(undefined), null)
})

/* ------------------------------ cleanSummaryText ------------------------------ */

test('cleanSummaryText：剥掉代码块围栏，保留围栏里的正文', () => {
  assert.equal(cleanSummaryText('```json\n{"summary":"x"}\n```'), '{"summary":"x"}')
  assert.equal(cleanSummaryText('```\n公司中标大单，金额 10 亿元\n```'), '公司中标大单，金额 10 亿元')
})

test('cleanSummaryText：去掉 markdown 标题与列表前缀', () => {
  assert.equal(cleanSummaryText('## 一句话\n- 公司公告：股东减持 2%'), '一句话 公司公告：股东减持 2%')
  assert.equal(cleanSummaryText('### 摘要'), '') // 剥完只剩 2 字 → 判太短
  assert.equal(cleanSummaryText('# 紫金矿业被立案调查'), '紫金矿业被立案调查')
})

test('cleanSummaryText：去掉加粗星号', () => {
  assert.equal(cleanSummaryText('**紫金矿业** 被立案调查，短期承压。'), '紫金矿业 被立案调查，短期承压。')
})

test('cleanSummaryText：去掉首尾引号与书名号', () => {
  assert.equal(cleanSummaryText('「宁德时代扩产」'), '宁德时代扩产')
  assert.equal(cleanSummaryText('《半导体行业深度报告》'), '半导体行业深度报告')
  assert.equal(cleanSummaryText('“公司中标 10 亿订单”'), '公司中标 10 亿订单')
})

test('cleanSummaryText：换行与连续空白压成单个空格', () => {
  assert.equal(cleanSummaryText('第一行\n\n第二行'), '第一行 第二行')
  assert.equal(cleanSummaryText('  多个   空格\t混排  '), '多个 空格 混排')
})

test('cleanSummaryText：去掉编号列表前缀', () => {
  assert.equal(cleanSummaryText('1. 公司公告：股东减持 2%'), '公司公告：股东减持 2%')
  assert.equal(cleanSummaryText('2、央行开展逆回购操作'), '央行开展逆回购操作')
})

test('cleanSummaryText：少于 6 字判空', () => {
  assert.equal(cleanSummaryText('好的'), '')
  assert.equal(cleanSummaryText('五个字啊'), '')
  assert.equal(cleanSummaryText(''), '')
  assert.equal(cleanSummaryText(null), '')
})

test('cleanSummaryText：恰好 6 字保留（有效的一句话摘要）', () => {
  assert.equal(cleanSummaryText('宁德时代扩产'), '宁德时代扩产')
  assert.equal(cleanSummaryText('「宁德时代扩产」'), '宁德时代扩产')
})

test('cleanSummaryText：超过 60 字截到 60 字（59 字 + 省略号）', () => {
  const long = '字'.repeat(90)
  const cleaned = cleanSummaryText(long)
  assert.equal(cleaned.length, 60)
  assert.ok(cleaned.endsWith('…'))
  assert.equal(cleaned, `${'字'.repeat(59)}…`)
})

/* ------------------------------ describeFinish ------------------------------ */

test('describeFinish：max-tokens 指向推理烧完预算', () => {
  const text = describeFinish({ kind: 'max-tokens' }, '')
  assert.match(text, /max-tokens/)
  assert.match(text, /推理/)
})

test('describeFinish：aborted 指向超时/宿主关闭', () => {
  assert.match(describeFinish({ kind: 'aborted' }, ''), /请求被中止/)
})

test('describeFinish：error 带 code 时把 code 写进人话，没 code 时只报「上游报错」', () => {
  assert.equal(describeFinish({ kind: 'error', failure: { code: 'TRANSPORT' } }, ''), '上游报错 TRANSPORT')
  assert.equal(describeFinish({ kind: 'error' }, ''), '上游报错')
  assert.equal(describeFinish({ kind: 'error', failure: {} }, ''), '上游报错')
})

test('describeFinish：tool-calls 单独归类（模型没在写摘要）', () => {
  assert.match(describeFinish({ kind: 'tool-calls' }, ''), /工具调用/)
})

test('describeFinish：没有 finish 且文本为空 → 空输出', () => {
  assert.equal(describeFinish(undefined, ''), '空输出')
  assert.equal(describeFinish(null, '   '), '空输出')
  assert.equal(describeFinish({}, ''), '空输出')
})

test('describeFinish：正常结束且有文本 → 空字符串（不是失败）', () => {
  assert.equal(describeFinish({ kind: 'stop' }, '有内容'), '')
  assert.equal(describeFinish({ kind: '' }, '有内容'), '')
  assert.equal(describeFinish(null, '有内容'), '')
})

/* ------------------------------ buildMessages ------------------------------ */

const sampleEvent = () => ({
  title: '紫金矿业收到立案告知书',
  summary: '涉嫌信息披露违法违规',
  tickers: ['601899'],
  sectors: ['有色金属', '黄金'],
  sources: [{ source: 'eastmoney', label: '东方财富', title: '紫金矿业被立案' }],
})

test('buildMessages：system 是中文摘要指令，要求只输出 JSON', () => {
  const { system } = buildMessages(sampleEvent())
  assert.equal(typeof system, 'string')
  assert.match(system, /A 股资讯编辑/)
  assert.match(system, /只输出 JSON/)
  assert.match(system, /summary/)
  assert.match(system, /sentiment/)
})

test('buildMessages：user 内容是「内容块数组」，不是字符串', () => {
  const { messages } = buildMessages(sampleEvent())
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.ok(Array.isArray(messages[0].content), 'content 必须是数组（DSH 的 RequestMessage 口径）')
  assert.equal(messages[0].content.length, 1)
  assert.equal(messages[0].content[0].type, 'text')
  assert.equal(typeof messages[0].content[0].text, 'string')
})

test('buildMessages：user 文本包含标题、代码、板块与其他报道来源', () => {
  const text = buildMessages(sampleEvent()).messages[0].content[0].text
  assert.match(text, /事件：紫金矿业收到立案告知书/)
  assert.match(text, /摘要：涉嫌信息披露违法违规/)
  assert.match(text, /涉及代码：601899/)
  assert.match(text, /涉及板块：有色金属、黄金/)
  assert.match(text, /其他报道：/)
  assert.match(text, /1\. \[东方财富\] 紫金矿业被立案/)
})

test('buildMessages：其他报道最多 3 条，label 缺失时回退 source', () => {
  const text = buildMessages({
    title: 't',
    sources: [
      { source: 's1', label: '一源', title: '标题1' },
      { source: 's2', title: '标题2' },
      { source: 's3', label: '三源', title: '标题3' },
      { source: 's4', label: '四源', title: '标题4' },
    ],
  }).messages[0].content[0].text
  assert.match(text, /1\. \[一源\] 标题1/)
  assert.match(text, /2\. \[s2\] 标题2/)
  assert.match(text, /3\. \[三源\] 标题3/)
  assert.doesNotMatch(text, /标题4/)
})

test('buildMessages：空字段整行省略，不留「涉及代码：」这种空壳', () => {
  const text = buildMessages({ title: '只有标题的事件' }).messages[0].content[0].text
  assert.equal(text, '事件：只有标题的事件')
  assert.doesNotMatch(text, /摘要：/)
  assert.doesNotMatch(text, /涉及代码：/)
  assert.doesNotMatch(text, /涉及板块：/)
  assert.doesNotMatch(text, /其他报道：/)
})

test('buildMessages：事件摘要最多送 200 字给模型', () => {
  const text = buildMessages({ title: 't', summary: 'a'.repeat(250) }).messages[0].content[0].text
  assert.ok(text.includes('a'.repeat(200)), '应包含前 200 字')
  assert.ok(!text.includes('a'.repeat(201)), '不应把 201 字以后的内容送进去')
})
