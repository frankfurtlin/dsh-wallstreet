#!/usr/bin/env node
/**
 * dsh-wallstreet「盘面 AI 问答」浏览器验收（Playwright headless）。
 *
 * 覆盖：盘面 tab 出现问答卡片、快捷问题能发起流式请求、回答逐字落地、
 * 多轮追问保留上下文、新对话能清空，以及面板里没有 JS 异常 / 失败请求。
 *
 * 这一步会真的调宿主模型（约 10–40 秒/次），不是离线测试。
 *
 * 用法：
 *   node verification/verify-ask.mjs --token='<dsh web token>'
 *   DSH_WEB_TOKEN=... node verification/verify-ask.mjs
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

page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
page.on('response', (response) => {
  const status = response.status()
  if (status >= 400) failedResponses.push(`${status} ${response.url()}`)
})
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`)
})

/** 读问答卡片里所有 assistant 气泡的文本。 */
async function assistantTexts() {
  return page.locator('[data-ask-message="assistant"]').evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent || '').trim()),
  )
}

/** 等第 count 条 assistant 回答出现（流式结束前也会逐渐变长，这里等它稳定）。 */
async function waitForAnswer(count, timeoutMs = 90_000) {
  const started = Date.now()
  let last = ''
  let stable = 0
  while (Date.now() - started < timeoutMs) {
    const texts = await assistantTexts()
    if (texts.length >= count) {
      const current = texts[count - 1] || ''
      if (current.length > 40 && current === last) {
        stable += 1
        if (stable >= 3) return current
      } else {
        stable = 0
      }
      last = current
    }
    await page.waitForTimeout(1_000)
  }
  const texts = await assistantTexts()
  return texts[count - 1] || last || ''
}

try {
  await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'load', timeout: 60_000 })
  await page.waitForSelector('button[aria-label]', { timeout: 60_000 })
  await page.waitForTimeout(1_200)

  const entry = page.locator('[data-dsh-panel-entry="wallstreet"]')
  await entry.waitFor({ state: 'visible', timeout: 30_000 })
  await entry.locator('xpath=ancestor::button[1]').click()
  await page.waitForSelector('[data-dsh-wallstreet-panel]', { state: 'visible', timeout: 30_000 })

  /* ---- 1. 盘面 tab 出现问答卡片 ---- */
  const marketView = page.locator('[data-dsh-wallstreet-view="market"]')
  await marketView.waitFor({ state: 'visible', timeout: 30_000 })
  const askCard = page.locator('[data-wallstreet-card="ask"]')
  await askCard.waitFor({ state: 'visible', timeout: 30_000 })
  const askText = await askCard.innerText()
  check('盘面出现「AI 盘面问答」卡片', askText.includes('AI 盘面问答'), askText.slice(0, 60))
  check('卡片说明会带上本页数据', askText.includes('指数') && askText.includes('成交额'), askText.slice(0, 120))
  const suggestions = await page.locator('[data-ask-suggestion]').count()
  check('空状态有快捷问题', suggestions >= 3, `${suggestions} 个`)
  await page.screenshot({ path: join(shotsDir, 'ask-empty.png') })

  /* ---- 2. 快捷问题发起流式问答 ---- */
  await page.locator('[data-ask-suggestion]', { hasText: '今天为什么涨' }).click()
  const first = await waitForAnswer(1)
  check('第一次回答有正文', first.length > 40, `${first.length} 字：${first.slice(0, 50)}`)
  check('回答带数据时间（不是空白模板）', /2026-11-27|13:\d\d/.test(first), first.slice(0, 80))
  check('回答引用了页面里的涨跌/成交数据', /涨|跌|成交|涨停/.test(first), first.slice(0, 80))
  await page.screenshot({ path: join(shotsDir, 'ask-answer.png') })

  /* ---- 3. 多轮追问：历史保留 ---- */
  await page.fill('[data-ask-input]', '那明天怎么走？给我一句概率判断。')
  await page.keyboard.press('Enter')
  const second = await waitForAnswer(2)
  check('追问得到第二条回答', second.length > 40, `${second.length} 字：${second.slice(0, 50)}`)
  const userCount = await page.locator('[data-ask-message="user"]').count()
  check('对话保留两轮提问', userCount === 2, `${userCount} 条`)

  /* ---- 4. 新对话清空 ---- */
  await page.locator('[data-dsh-wallstreet-action="ask-clear"]').click()
  await page.waitForTimeout(400)
  const resetCount = await page.locator('[data-ask-message]').count()
  check('「新对话」清空历史', resetCount === 0, `剩 ${resetCount} 条`)
  const emptyAgain = await page.locator('[data-ask-suggestion]').count()
  check('清空后回到快捷问题状态', emptyAgain >= 3, `${emptyAgain} 个`)

  /* ---- 5. 无 JS 异常 / 失败请求 ---- */
  const apiFailures = failedResponses.filter((line) => line.includes('/wallstreet/api/'))
  check('无失败的面板 API 请求', apiFailures.length === 0, apiFailures.slice(0, 3).join('；'))
  // 与 verify-ui 同口径：只把页面级 JS 异常判失败；DSH 自身旧会话探测的 401 噪声不算。
  const pageErrors = consoleErrors.filter((line) => line.startsWith('pageerror:'))
  check('无页面 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join('；'))
  const others = failedResponses.filter((line) => !line.includes('/wallstreet/api/') && !line.includes('/favicon'))
  if (others.length > 0) console.log(`INFO 其他非 2xx 响应（不判失败）：${others.slice(0, 5).join(' | ')}`)
} catch (error) {
  check(`验收过程未抛异常（${error && error.message ? error.message.slice(0, 120) : error}）`, false)
  await page.screenshot({ path: join(shotsDir, 'ask-error.png') }).catch(() => {})
} finally {
  await browser.close()
}

console.log(failures.length === 0 ? '\n全部通过' : `\n${failures.length} 项失败：${failures.join('；')}`)
process.exit(failures.length === 0 ? 0 : 1)
