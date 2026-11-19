#!/usr/bin/env node
/**
 * dsh-wallstreet 在 DSH Web 内的浏览器验收（Playwright headless）。
 *
 * 覆盖：侧栏顺序（酒馆 < 知识库 < 紫微斗数 < 华尔街之狼）、点击入口打开面板、
 * 各分区真实渲染出数据、手动刷新能拿到新响应、返回对话能退出面板。
 * 截图写入 verification/shots/。
 *
 * 用法：
 *   node verification/verify-ui.mjs --token='<dsh web token>'
 *   DSH_WEB_TOKEN=... node verification/verify-ui.mjs
 *   （URL 可用 DSH_WEB_URL 覆盖，默认 http://127.0.0.1:3080）
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire('/root/workspace/hermes-site/tools/node_modules/')
const { chromium } = require('playwright')

const argv = process.argv.slice(2)
const tokenArg = argv.find((arg) => arg.startsWith('--token='))
const token = (tokenArg ? tokenArg.slice('--token='.length) : '') || process.env.DSH_WEB_TOKEN || ''
const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'

if (!token) {
  console.error('缺少 DSH Web token：用 --token=<token> 或环境变量 DSH_WEB_TOKEN 传入。')
  process.exit(2)
}

const shotsDir = join(dirname(fileURLToPath(import.meta.url)), 'shots')
mkdirSync(shotsDir, { recursive: true })

const failures = []
const consoleErrors = []

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  locale: 'zh-CN',
  deviceScaleFactor: 1,
})
const page = await context.newPage()
const failedResponses = []
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
page.on('response', (response) => {
  const status = response.status()
  if (status >= 400) failedResponses.push(`${status} ${response.url()}`)
})
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`)
})

try {
  await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'load', timeout: 60_000 })
  await page.waitForSelector('button[aria-label]', { timeout: 60_000 })
  await page.waitForTimeout(1_500)

  /* ---- 1. 侧栏入口存在，且顺序正确 ---- */
  const entry = page.locator('[data-dsh-panel-entry="wallstreet"]')
  await entry.waitFor({ state: 'visible', timeout: 30_000 })
  check('侧栏出现「华尔街之狼」图标', true)

  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button[aria-label]'))
      .filter((button) => String(button.className).includes('panelRow'))
      .map((button) => ({
        label: button.getAttribute('aria-label'),
        id: button.querySelector('[data-dsh-panel-entry]')?.getAttribute('data-dsh-panel-entry') || null,
      })),
  )
  const customOrder = rows
    .map((row) => row.id)
    .filter((id) => id && ['tavern', 'kb', 'ziwei', 'wallstreet'].includes(id))
  check(
    '自研插件顺序：酒馆 → 知识库 → 紫微斗数 → 华尔街之狼',
    JSON.stringify(customOrder) === JSON.stringify(['tavern', 'kb', 'ziwei', 'wallstreet']),
    JSON.stringify(customOrder),
  )
  const labels = rows.map((row) => row.label).filter(Boolean)
  const automationIndex = labels.findIndex((label) => label === '自动化任务')
  const tavernIndex = labels.findIndex((label) => label === '酒馆')
  check('自动化任务 在 酒馆 之前', automationIndex >= 0 && tavernIndex >= 0 && automationIndex < tavernIndex, `${automationIndex} < ${tavernIndex}`)

  await page.screenshot({ path: join(shotsDir, 'sidebar.png') })

  /* ---- 2. 点击入口打开面板 ---- */
  await entry.locator('xpath=ancestor::button[1]').click()
  await page.waitForSelector('[data-dsh-wallstreet-panel]', { state: 'visible', timeout: 30_000 })
  check('点击后打开华尔街之狼面板', true)

  await page.waitForSelector('[data-wallstreet-index]', { state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(800)

  /* ---- 3. 盘面 tab：快照 + 腾讯实时 ---- */
  const marketView = page.locator('[data-dsh-wallstreet-view="market"]')
  await marketView.waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForSelector('[data-wallstreet-index]', { state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(800)

  const indexCount = await page.locator('[data-wallstreet-index]').count()
  check('盘面 · 指数卡片 10 张', indexCount === 10, `实际 ${indexCount}`)

  const shCard = page.locator('[data-wallstreet-index="000001"]')
  check('盘面 · 上证卡片存在且含名称', (await shCard.innerText()).includes('上证指数'))

  const pricedCards = await page.locator('[data-wallstreet-index]').evaluateAll((cards) =>
    cards.filter((card) => /\d/.test(card.textContent || '')).length,
  )
  check('盘面 · 指数卡片含数值', pricedCards >= 8, `${pricedCards}/10`)

  // 回归：指数卡片（价格 + 涨跌幅 + 涨跌点）在窄面板下不得横向溢出。
  const overflowProbe = () =>
    page.locator('[data-wallstreet-index]').evaluateAll((cards) =>
      cards
        .map((card) => ({
          code: card.getAttribute('data-wallstreet-index'),
          dx: card.scrollWidth - card.clientWidth,
          inner: [...card.querySelectorAll('*')].filter((n) => n.scrollWidth > n.clientWidth + 1).length,
        }))
        .filter((row) => row.dx > 1 || row.inner > 0),
    )
  let cardOverflow = await overflowProbe()
  check('盘面 · 指数卡片内容不溢出（1440）', cardOverflow.length === 0, JSON.stringify(cardOverflow).slice(0, 160))

  await page.setViewportSize({ width: 1120, height: 900 })
  await page.waitForTimeout(500)
  cardOverflow = await overflowProbe()
  check('盘面 · 指数卡片内容不溢出（1120 窄屏）', cardOverflow.length === 0, JSON.stringify(cardOverflow).slice(0, 160))
  const cardFooters = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-wallstreet-index]')).map((el) => ({
      text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      svg: !!el.querySelector('svg'),
    })),
  )
  const oddFooters = cardFooters.filter((card) => card.svg || !/成交/.test(card.text))
  check(
    '盘面 · 指数卡底部统一展示成交额（不再只有上证有迷你走势）',
    cardFooters.length === 10 && oddFooters.length === 0,
    JSON.stringify(oddFooters).slice(0, 160),
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(500)

  const temperature = page.locator('[data-wallstreet-temperature]')
  check('盘面 · 市场温度渲染', (await temperature.count()) > 0)
  const temperatureText = (await temperature.count()) > 0 ? await temperature.innerText() : ''
  check('盘面 · 温度含 0–100 分与标签', /\d+/.test(temperatureText) && /市场温度/.test(temperatureText), temperatureText.replace(/\n/g, ' / ').slice(0, 80))

  const breadth = page.locator('[data-wallstreet-breadth]')
  const breadthText = (await breadth.count()) > 0 ? await breadth.innerText() : ''
  check('盘面 · 市场宽度渲染涨/跌/涨停', /上涨/.test(breadthText) && /下跌/.test(breadthText) && /涨停/.test(breadthText))

  const sectorsText = await page.locator('[data-wallstreet-sectors]').innerText()
  check('盘面 · 板块轮动渲染领涨/领跌', /领涨行业/.test(sectorsText) && /领跌行业/.test(sectorsText))

  const klineText = await page.locator('[data-wallstreet-kline]').innerText()
  check('盘面 · 60 日趋势渲染均线图例', /MA5/.test(klineText) && /MA20/.test(klineText))

  // ① 分时图：涨跌幅 Y 轴刻度 + hover 十字线 / 浮层。
  const pctTickCount = await page
    .locator('[data-wallstreet-trend] svg text')
    .evaluateAll((nodes) => nodes.filter((node) => /%$/.test((node.textContent || '').trim())).length)
  check('盘面 · 分时图含涨跌幅 Y 轴刻度', pctTickCount >= 2, `${pctTickCount} 个`)
  const trendBox = await page.locator('[data-wallstreet-trend] svg').first().boundingBox()
  if (trendBox) await page.mouse.move(trendBox.x + trendBox.width * 0.5, trendBox.y + trendBox.height * 0.4)
  await page.waitForTimeout(250)
  const trendTip = (await page.locator('[data-wallstreet-trend-tip]').count()) > 0
    ? await page.locator('[data-wallstreet-trend-tip]').innerText()
    : ''
  check('盘面 · 分时图 hover 显示十字线浮层', /均价|\d{2}:\d{2}/.test(trendTip), trendTip.replace(/\n/g, ' ').slice(0, 60))
  await page.mouse.move(0, 0)
  await page.waitForTimeout(150)

  // ② 60 日K线改为蜡烛图：每根蜡烛由 rect 构成（含成交量柱），应明显多于 2 根均线。
  const candleRects = await page.locator('[data-wallstreet-kline] svg rect').count()
  check('盘面 · 60 日K线为蜡烛图', candleRects >= 50, `${candleRects} 个 rect`)

  const svgCount = await page.locator('[data-dsh-wallstreet-panel] svg').count()
  check('盘面 · 面板内含走势/仪表 SVG', svgCount >= 3, `${svgCount} 个`)

  const marketText = await marketView.innerText()
  check('盘面 · 不再包含「涨停池」（已移入异动）', !/涨停池/.test(marketText))

  const summaryText = (await page.locator('[data-wallstreet-summary]').count()) > 0
    ? await page.locator('[data-wallstreet-summary]').innerText()
    : ''
  check('盘面 · 一句话盘面结论渲染', /温度/.test(summaryText) && /涨停/.test(summaryText), summaryText.replace(/\n/g, ' ').slice(0, 80))

  const freshnessText = await page.locator('[data-dsh-wallstreet-freshness]').innerText()
  check('盘面 · 页头标注数据时间', /盘中实时 · \d{2}:\d{2} 更新|收盘快照 · \d{4}-\d{2}-\d{2}/.test(freshnessText), freshnessText)
  const marketBody = await marketView.innerText()
  check('盘面 · 分区标注盘中实时/收盘快照', /盘中实时|收盘快照/.test(marketBody))
  check('盘面 · 盘中显示预计全天成交额', !/盘中实时/.test(freshnessText) || /预计全天/.test(marketBody))

  const breadth5Text = (await page.locator('[data-wallstreet-breadth5]').count()) > 0
    ? await page.locator('[data-wallstreet-breadth5]').innerText()
    : ''
  check('盘面 · 近 5 日累计涨跌展示', /近 5 日累计/.test(breadth5Text) && /\d/.test(breadth5Text), breadth5Text)

  await page.screenshot({ path: join(shotsDir, 'wallstreet-market.png') })

  /* ---- 4. 异动 tab：涨停池 / 龙虎榜 / 涨跌幅榜 / 板块资金流 / 资金流向榜 ---- */
  await page.locator('[data-dsh-wallstreet-tab="moves"]').click()
  await page.waitForSelector('[data-dsh-wallstreet-moves]', { state: 'visible', timeout: 30_000 })
  // 盘中是实时接口，比文件快照慢：先等第一行数据渲染出来，避免把「读取中…」当成渲染失败
  await page.waitForSelector('[data-wallstreet-stock]', { state: 'visible', timeout: 30_000 })
  const movesText = await page.locator('[data-dsh-wallstreet-moves]').innerText()
  check('异动 · 涨停池区块渲染', /涨停池/.test(movesText) && /今日/.test(movesText) && /昨日/.test(movesText))
  check('异动 · 龙虎榜区块渲染', /龙虎榜/.test(movesText) && /净买入/.test(movesText))
  check('异动 · 涨跌幅榜区块渲染', /涨跌幅榜/.test(movesText))
  check(
    '异动 · 行业资金流区块渲染',
    /行业资金流/.test(movesText) && (/(领涨股|主力净额)/.test(movesText)),
    movesText.includes('领涨股') ? '收盘快照含领涨股' : '盘中实时按主力净额',
  )
  check('异动 · 重复的资金流向榜已合并', !/资金流向榜/.test(movesText))
  check('异动 · 不再包含指数卡片', (await page.locator('[data-wallstreet-index]').count()) === 0)
  const movesFreshness = await page.locator('[data-dsh-wallstreet-freshness]').innerText()
  check('异动 · 页头标注数据时间', /盘中实时 · \d{2}:\d{2} 更新|收盘快照 · \d{4}-\d{2}-\d{2}/.test(movesFreshness), movesFreshness)
  if (/盘中实时/.test(movesFreshness)) {
    check('异动 · 盘中涨停池显示连板列', /连板/.test(movesText))
    check('异动 · 盘中不再显示 T-1 快照提示', !/不是最新交易日/.test(movesText))
  }
  const stickyHeader = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('[data-dsh-wallstreet-panel] div')).filter((el) => {
      const cs = getComputedStyle(el)
      return cs.overflowY === 'auto' && el.clientHeight <= 320 && el.scrollHeight > el.clientHeight + 4 && el.querySelector('th')
    })
    if (!boxes.length) return null
    const box = boxes[0]
    box.scrollTop = 160
    const th = box.querySelector('th')
    const rect = th.getBoundingClientRect()
    const boxRect = box.getBoundingClientRect()
    return { top: Math.round(rect.top - boxRect.top), bg: getComputedStyle(th).backgroundColor }
  })
  check(
    '异动 · 表格滚动时表头固定且不透明',
    !!stickyHeader && Math.abs(stickyHeader.top) <= 2 && !/rgba\(0, 0, 0, 0\)/.test(stickyHeader.bg),
    JSON.stringify(stickyHeader),
  )

  // 个股下钻：点涨停池/龙虎榜里的股票名，弹出分时 + 日K 弹层，再关闭。
  const stockLinks = page.locator('[data-wallstreet-stock]')
  check('异动 · 个股名称可点击', (await stockLinks.count()) > 0, `${await stockLinks.count()} 个`)
  if ((await stockLinks.count()) > 0) {
    const pickedCode = await stockLinks.first().getAttribute('data-wallstreet-stock')
    await stockLinks.first().click()
    await page.waitForSelector('[data-dsh-wallstreet-stock-modal]', { state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(1_800)
    const modalText = await page.locator('[data-dsh-wallstreet-stock-modal]').innerText()
    check('异动 · 个股弹层打开并加载报价', /腾讯行情/.test(modalText) && /\d/.test(modalText), `${pickedCode}`)
    check('异动 · 个股弹层含分时/日K 区块', /分时/.test(modalText) && /日K|60 日/.test(modalText), modalText.replace(/\n/g, ' ').slice(0, 80))
    // ③ 弹层内搜索其它代码（600519 贵州茅台），并验证 Esc 关闭。
    const stockSearch = page.locator('[data-dsh-wallstreet-stock-search]')
    check('异动 · 个股弹层含搜索框', (await stockSearch.count()) > 0)
    await stockSearch.fill('600519')
    await stockSearch.press('Enter')
    await page.waitForTimeout(2_600)
    const searchedText = await page.locator('[data-dsh-wallstreet-stock-modal]').innerText()
    check('异动 · 搜索 600519 切换到贵州茅台', /贵州茅台/.test(searchedText) && /600519/.test(searchedText), searchedText.replace(/\n/g, ' ').slice(0, 60))
    await page.screenshot({ path: join(shotsDir, 'wallstreet-stock-modal.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-dsh-wallstreet-stock-modal]', { state: 'hidden', timeout: 10_000 })
    check('异动 · Esc 关闭个股弹层', true)
  }
  await page.screenshot({ path: join(shotsDir, 'wallstreet-moves.png') })

  /* ---- 5. 研究 tab：归档结论 + 估值/两融/期货 + 持仓 ---- */
  await page.locator('[data-dsh-wallstreet-tab="research"]').click()
  await page.waitForSelector('[data-dsh-wallstreet-research]', { state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(600)
  const researchText = await page.locator('[data-dsh-wallstreet-research]').innerText()
  check('研究 · 研究结论渲染', /研究结论/.test(researchText) && /没有可实盘的策略/.test(researchText))
  check('研究 · 策略统计（有效/边缘/无效）', /有效/.test(researchText) && /边缘/.test(researchText) && /无效/.test(researchText))
  check('研究 · 估值分位区块渲染', /估值分位/.test(researchText))
  check('研究 · 持仓集中度区块渲染', /持仓集中度/.test(researchText))
  check('研究 · 不再包含「涨停池」（已移入异动）', !/涨停池/.test(researchText))
  check('研究 · 财经快讯与公告区块渲染', /财经快讯与公告/.test(researchText))
  const newsLinks = await page.$$eval('[data-dsh-wallstreet-research] a', (as) => as.filter((a) => /^https?:\/\//.test(a.href) && a.target === '_blank').map((a) => a.href))
  check('研究 · 快讯可点击跳原文（>=10 条）', newsLinks.length >= 10, `${newsLinks.length} 条`)
  check('研究 · 快讯来源多样', /新浪|华尔街见闻|巨潮/.test(researchText))

  const historyText = (await page.locator('[data-wallstreet-history]').count()) > 0
    ? await page.locator('[data-wallstreet-history]').innerText()
    : ''
  check('研究 · 市场情绪历史区块渲染', /涨停/.test(historyText) && /跌停/.test(historyText) && /\d/.test(historyText), historyText.replace(/\n/g, ' ').slice(0, 80))
  await page.screenshot({ path: join(shotsDir, 'wallstreet-research.png') })

  /* ---- 6. 各 tab 手动刷新命中各自接口 ---- */
  const [quantResponse] = await Promise.all([
    page.waitForResponse((item) => item.url().includes('/wallstreet/api/quant/overview') && item.ok(), { timeout: 30_000 }),
    page.locator('[data-dsh-wallstreet-action="refresh"]').click(),
  ])
  check('研究 tab 刷新触发 /quant/overview 200', quantResponse.status() === 200, String(quantResponse.status()))

  await page.locator('[data-dsh-wallstreet-tab="moves"]').click()
  const [movesResponse] = await Promise.all([
    page.waitForResponse((item) => item.url().includes('/wallstreet/api/moves') && item.ok(), { timeout: 30_000 }),
    page.locator('[data-dsh-wallstreet-action="refresh"]').click(),
  ])
  check('异动 tab 刷新触发 /moves 200', movesResponse.status() === 200, String(movesResponse.status()))

  await page.locator('[data-dsh-wallstreet-tab="market"]').click()
  const [overviewResponse] = await Promise.all([
    page.waitForResponse((item) => item.url().includes('/wallstreet/api/overview') && item.ok(), { timeout: 30_000 }),
    page.locator('[data-dsh-wallstreet-action="refresh"]').click(),
  ])
  check('盘面 tab 刷新触发 /overview 200', overviewResponse.status() === 200, String(overviewResponse.status()))
  await page.waitForSelector('[data-wallstreet-index]', { state: 'visible', timeout: 30_000 })

  /* ---- 6b. 响应式：窄屏（收起侧栏 / 手机宽度）三 tab 均不得横向溢出 ---- */
  const measureOverflow = () =>
    page.evaluate(() => {
      const panel = document.querySelector('[data-dsh-wallstreet-panel]')
      const doc = document.scrollingElement
      return {
        panel: panel ? panel.scrollWidth - panel.clientWidth : 0,
        doc: doc ? doc.scrollWidth - window.innerWidth : 0,
      }
    })
  for (const width of [768, 480]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(500)
    for (const tab of ['market', 'moves', 'research']) {
      await page.locator(`[data-dsh-wallstreet-tab="${tab}"]`).first().click()
      await page.waitForTimeout(500)
      const overflow = await measureOverflow()
      check(`响应式 ${width}px · ${tab} 无横向溢出`, overflow.panel <= 1 && overflow.doc <= 1, JSON.stringify(overflow))
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(500)
  await page.locator('[data-dsh-wallstreet-tab="market"]').click()
  await page.waitForTimeout(500)

  /* ---- 7. 返回对话 ---- */
  await page.locator('[data-dsh-wallstreet-action="back"]').click()
  await page.waitForSelector('[data-dsh-wallstreet-panel]', { state: 'hidden', timeout: 15_000 })
  check('返回对话后面板关闭', true)

  const pageErrors = consoleErrors.filter((line) => line.startsWith('pageerror:'))
  check('面板无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

  const wallstreetFailures = failedResponses.filter((line) => line.includes('/wallstreet/'))
  check('华尔街接口无失败请求', wallstreetFailures.length === 0, wallstreetFailures.slice(0, 3).join(' | '))

  // 非接口的偶发 4xx（favicon、被撤销的旧会话探测等）只报告不判失败，偶发噪声需人工看。
  const otherFailures = failedResponses.filter(
    (line) => !line.includes('/wallstreet/') && !line.includes('/favicon'),
  )
  if (otherFailures.length > 0) console.log(`INFO 其他非 2xx 响应（不判失败）：${otherFailures.slice(0, 5).join(' | ')}`)
} catch (error) {
  failures.push(`异常：${error.message}`)
  await page.screenshot({ path: join(shotsDir, 'failure.png') }).catch(() => {})
} finally {
  await browser.close()
}

console.log('')
if (failures.length === 0) {
  console.log(`浏览器验收通过。截图：${shotsDir}`)
  process.exit(0)
}
console.error(`验收失败 ${failures.length} 项：${failures.join('；')}`)
process.exit(1)
