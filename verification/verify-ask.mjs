#!/usr/bin/env node
/**
 * dsh-wallstreet「右侧 AI 问答栏」浏览器验收（Playwright headless）。
 *
 * 覆盖：五个 tab 共用同一个右侧问答栏、快捷问题随 tab 变化、问答能带上当前页数据、
 * 多轮追问保留、窄屏收成悬浮按钮并能展开覆盖抽屉，以及无 JS 异常 / 失败请求。
 *
 * 这一步会真的调宿主模型（每次约 10–40 秒），不是离线测试。
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
const consoleErrors = []
const failedResponses = []

const PAGE_LABELS = { market: '盘面', moves: '异动', news: '资讯', research: '研究', strategy: '策略' }
const EXPECTED_QUESTIONS = {
  market: '今天为什么涨',
  moves: '涨停结构',
  news: '最重要的三条消息',
  research: '研究结论',
  strategy: '配置比例',
}

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

/** 读当前问答栏的形态、页标签与快捷问题。 */
async function askDockSnapshot() {
  return page.evaluate(() => {
    const dock = document.querySelector('[data-ask-dock], [data-ask-toggle]');
    if (!dock) return null;
    return {
      mode: dock.getAttribute('data-ask-dock') || 'toggle',
      text: (dock.textContent || '').replace(/\s+/g, ' ').trim(),
      suggestions: Array.from(dock.querySelectorAll('[data-ask-suggestion]')).map((node) =>
        (node.textContent || '').trim(),
      ),
    };
  });
}

/** 等第 count 条 assistant 回答稳定下来。 */
async function waitForAnswer(count, timeoutMs = 90_000) {
  const started = Date.now();
  let last = '';
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    const texts = await page.locator('[data-ask-message="assistant"]').evaluateAll((nodes) =>
      nodes.map((node) => (node.textContent || '').trim()),
    );
    if (texts.length >= count) {
      const current = texts[count - 1] || '';
      if (current.length > 40 && current === last) {
        stable += 1;
        if (stable >= 3) return current;
      } else {
        stable = 0;
      }
      last = current;
    }
    await page.waitForTimeout(1_000);
  }
  return last;
}

async function switchTab(view) {
  await page.locator(`[data-dsh-wallstreet-tab="${view}"]`).click();
  await page.waitForTimeout(600);
}

try {
  await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'load', timeout: 60_000 })
  await page.waitForSelector('button[aria-label]', { timeout: 60_000 })
  await page.waitForTimeout(1_200)

  const entry = page.locator('[data-dsh-panel-entry="wallstreet"]')
  await entry.waitFor({ state: 'visible', timeout: 30_000 })
  await entry.locator('xpath=ancestor::button[1]').click()
  await page.waitForSelector('[data-dsh-wallstreet-panel]', { state: 'visible', timeout: 30_000 })
  await page.waitForSelector('[data-dsh-wallstreet-view="market"]', { state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(800)

  /* ---- 1. 五个 tab 共用同一个右侧问答栏，快捷问题随 tab 变化 ---- */
  for (const view of Object.keys(PAGE_LABELS)) {
    if (view !== 'market') await switchTab(view)
    const snapshot = await askDockSnapshot()
    check(`${PAGE_LABELS[view]} · 右侧问答栏存在`, Boolean(snapshot), snapshot ? snapshot.mode : '未找到')
    if (!snapshot) continue
    check(`${PAGE_LABELS[view]} · 标注当前页`, snapshot.text.includes(`${PAGE_LABELS[view]}页`), snapshot.text.slice(0, 40))
    check(
      `${PAGE_LABELS[view]} · 快捷问题贴着本页`,
      snapshot.suggestions.some((item) => item.includes(EXPECTED_QUESTIONS[view])),
      snapshot.suggestions.join(' / '),
    )
    const dockBox = await page.locator('[data-ask-dock], [data-ask-toggle]').first().boundingBox()
    const panelBox = await page.locator('[data-dsh-wallstreet-panel]').boundingBox()
    check(
      `${PAGE_LABELS[view]} · 问答栏在面板最右侧`,
      Boolean(dockBox && panelBox) && Math.abs(dockBox.x + dockBox.width - (panelBox.x + panelBox.width)) <= 2,
      dockBox && panelBox
        ? `dock 右缘 ${Math.round(dockBox.x + dockBox.width)} / 面板右缘 ${Math.round(panelBox.x + panelBox.width)}`
        : '无坐标',
    )
  }

  /* ---- 2. 盘面问答（带页面数据） ---- */
  await switchTab('market')
  await page.locator('[data-ask-suggestion]', { hasText: '今天为什么涨' }).first().click()
  const marketAnswer = await waitForAnswer(1)
  check('盘面 · 回答有正文', marketAnswer.length > 40, `${marketAnswer.length} 字：${marketAnswer.slice(0, 50)}`)
  check('盘面 · 回答带数据时间', /2026-11-27|\d{2}:\d{2}/.test(marketAnswer), marketAnswer.slice(0, 60))
  await page.screenshot({ path: join(shotsDir, 'ask-dock-market.png') })

  /* ---- 3. 换到异动页追问：历史保留，但上下文换成异动数据 ---- */
  await switchTab('moves')
  await page.locator('[data-ask-suggestion]', { hasText: '涨停结构' }).first().click()
  const movesAnswer = await waitForAnswer(2)
  check('异动 · 第二次回答有正文', movesAnswer.length > 40, `${movesAnswer.length} 字：${movesAnswer.slice(0, 50)}`)
  check('异动 · 回答引用了异动页数据', /涨停|连板|资金|龙虎榜/.test(movesAnswer), movesAnswer.slice(0, 60))
  const userCount = await page.locator('[data-ask-message="user"]').count()
  check('对话保留两轮提问', userCount === 2, `${userCount} 条`)
  await page.screenshot({ path: join(shotsDir, 'ask-dock-moves.png') })

  /* ---- 4. 策略页快捷问题 + 新对话 ---- */
  await switchTab('strategy')
  const strategySnapshot = await askDockSnapshot()
  check(
    '策略 · 快捷问题包含配置比例',
    (strategySnapshot?.suggestions || []).some((item) => item.includes('配置比例')),
    (strategySnapshot?.suggestions || []).join(' / '),
  )
  await page.locator('[data-dsh-wallstreet-action="ask-clear"]').click()
  await page.waitForTimeout(400)
  check('「新对话」清空历史', (await page.locator('[data-ask-message]').count()) === 0)

  /* ---- 5. 窄屏：收成悬浮按钮，点开是覆盖抽屉 ---- */
  await page.setViewportSize({ width: 900, height: 900 })
  await page.waitForTimeout(900)
  const narrowSnapshot = await askDockSnapshot()
  check('窄屏 · 问答栏收成悬浮按钮', narrowSnapshot && narrowSnapshot.mode === 'toggle', narrowSnapshot ? narrowSnapshot.mode : '未找到')
  if (narrowSnapshot && narrowSnapshot.mode === 'toggle') {
    await page.locator('[data-ask-toggle]').click()
    await page.waitForTimeout(500)
    const opened = await askDockSnapshot()
    check('窄屏 · 点开后出现覆盖抽屉', opened && opened.mode === 'floating', opened ? opened.mode : '未找到')
    await page.screenshot({ path: join(shotsDir, 'ask-dock-narrow.png') })
  }

  /* ---- 6. 无 JS 异常 / 失败请求 ---- */
  const apiFailures = failedResponses.filter((line) => line.includes('/wallstreet/api/'))
  check('无失败的面板 API 请求', apiFailures.length === 0, apiFailures.slice(0, 3).join('；'))
  const pageErrors = consoleErrors.filter((line) => line.startsWith('pageerror:'))
  check('无页面 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join('；'))
} catch (error) {
  check(`验收过程未抛异常（${error && error.message ? error.message.slice(0, 120) : error}）`, false)
  await page.screenshot({ path: join(shotsDir, 'ask-dock-error.png') }).catch(() => {})
} finally {
  await browser.close()
}

console.log(failures.length === 0 ? '\n全部通过' : `\n${failures.length} 项失败：${failures.join('；')}`)
process.exit(failures.length === 0 ? 0 : 1)
