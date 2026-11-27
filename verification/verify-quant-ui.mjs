#!/usr/bin/env node
/**
 * dsh-wallstreet「量化研究」tab 的浏览器验收（Playwright headless）。
 *
 * 覆盖：切到量化研究视图 → 研究结论/每日市场数据/持仓集中度渲染出真实内容
 * → 确认历史日报模块已移除 → 刷新命中 /quant/overview → 切回市场概览仍可用。
 *
 * 用法：
 *   node verification/verify-quant-ui.mjs --token='<dsh web token>'
 *   DSH_WEB_TOKEN=... node verification/verify-quant-ui.mjs
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// playwright 解析顺序：环境变量 > 同目录的 hermes-site 副本 > 全局安装
const require = createRequire(
  process.env.PLAYWRIGHT_MODULE_DIR || new URL('../../hermes-site/tools/node_modules/', import.meta.url)
)
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
const pageErrors = []
const failedResponses = []

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
page.on('pageerror', (error) => pageErrors.push(error.message))
page.on('response', (response) => {
  if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
})

try {
  await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'load', timeout: 60_000 })
  await page.waitForSelector('button[aria-label]', { timeout: 60_000 })
  await page.waitForTimeout(1_200)

  /* ---- 1. 打开面板并切到「量化研究」 ---- */
  const entry = page.locator('[data-dsh-panel-entry="wallstreet"]')
  await entry.waitFor({ state: 'visible', timeout: 30_000 })
  await entry.locator('xpath=ancestor::button[1]').click()
  await page.waitForSelector('[data-dsh-wallstreet-panel]', { state: 'visible', timeout: 30_000 })

  const quantTab = page.locator('[data-dsh-wallstreet-tab="research"]')
  await quantTab.waitFor({ state: 'visible', timeout: 15_000 })
  await quantTab.click()
  await page.waitForSelector('[data-dsh-wallstreet-research]', { state: 'visible', timeout: 30_000 })
  check('切换到「量化研究」tab', true)

  const view = await page.locator('[data-dsh-wallstreet-panel]').getAttribute('data-dsh-wallstreet-view')
  check('面板视图标记为 research', view === 'research', String(view))

  /* ---- 2. 四个数据源都渲染出内容 ---- */
  const quant = page.locator('[data-dsh-wallstreet-research]')
  await page
    .waitForFunction(
      () => {
        const node = document.querySelector('[data-dsh-wallstreet-research]')
        return node && node.textContent && node.textContent.includes('当前策略库没有可实盘的策略')
      },
      { timeout: 30_000 },
    )
    .catch(() => {})

  const text = await quant.innerText()
  check('研究结论渲染（含一句话结论）', text.includes('研究结论') && text.includes('当前策略库没有可实盘的策略'))
  check('研究结论含回测计数', /回测结果\s*\d+\s*份/.test(text), (text.match(/回测结果\s*\d+\s*份/) || [''])[0])
  check('每日市场数据渲染估值分位', text.includes('估值分位') && text.includes('PE(TTM)'))
  check('研究视图不再含异动区块（涨跌幅榜/资金流向榜/首封）', !text.includes('涨跌幅榜') && !text.includes('资金流向榜') && !text.includes('首封'))
  check('持仓集中度渲染', text.includes('持仓集中度'))
  check('历史日报模块已移除', !text.includes('历史日报') && !text.includes('共 40 期'))
  const headerText = await page.locator('body').innerText()
  check('页头展示 quant 数据日期', /归档 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(headerText), '页头副标题')

  const strategyRows = await quant.locator('table tbody tr').count()
  check('策略表格行数 ≥ 30', strategyRows >= 30, `${strategyRows} 行`)

  await page.screenshot({ path: join(shotsDir, 'quant-research.png') })

  /* ---- 3. 量化视图下刷新 ---- */
  const [refreshResponse] = await Promise.all([
    page.waitForResponse(
      (item) => item.url().includes('/wallstreet/api/quant/overview') && item.ok(),
      { timeout: 30_000 },
    ),
    page.locator('[data-dsh-wallstreet-action="refresh"]').click(),
  ])
  check('量化视图刷新命中 /quant/overview 200', refreshResponse.status() === 200, String(refreshResponse.status()))

  /* ---- 4. 切回市场概览仍可用 ---- */
  await page.locator('[data-dsh-wallstreet-tab="market"]').click()
  await page.waitForSelector('[data-wallstreet-index]', { state: 'visible', timeout: 30_000 })
  const indexCount = await page.locator('[data-wallstreet-index]').count()
  check('切回市场概览仍有 10 张指数卡', indexCount === 10, `${indexCount} 张`)

  const quantFailures = failedResponses.filter((line) => line.includes('/wallstreet/'))
  check('quant 接口无失败请求', quantFailures.length === 0, quantFailures.slice(0, 3).join(' | '))
  check('页面无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} catch (error) {
  failures.push(`异常：${error.message}`)
  await page.screenshot({ path: join(shotsDir, 'quant-failure.png') }).catch(() => {})
} finally {
  await browser.close()
}

console.log('')
if (failures.length === 0) {
  console.log(`量化研究浏览器验收通过。截图：${shotsDir}`)
  process.exit(0)
}
console.error(`验收失败 ${failures.length} 项：${failures.join('；')}`)
process.exit(1)
