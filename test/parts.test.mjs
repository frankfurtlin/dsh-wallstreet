/**
 * `lib/hub/parts.js` 的分区四态：纯逻辑单测。
 *
 * 四态：缓存新鲜 / loader 成功 / 失败但有旧值（stale）/ 连旧值都没有（ok:false + 错误码）。
 * 另外验证超时不会取消 loader —— 它跑完仍会写进缓存。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPartsRunner, partErrorCode, partErrorText, PART_ERROR_CODES } from '../lib/hub/parts.js'
import { createCache } from '../lib/hub/cache.js'

function makeRunner(options = {}) {
  let clock = 1000
  const cache = createCache({ now: () => clock, maxEntries: 64 })
  const runner = createPartsRunner({ cache, now: () => clock, deadlineMs: options.deadlineMs || 1000 })
  return {
    cache,
    runner,
    advance: (ms) => {
      clock += ms
    },
    setNow: (value) => {
      clock = value
    },
  }
}

test('第一态：缓存新鲜时不调用 loader', async () => {
  const { cache, runner, advance } = makeRunner()
  let calls = 0
  const loader = async () => {
    calls += 1
    return { v: calls }
  }
  cache.set('quotes', { v: 'warm' }, 60_000)
  const result = await runner.run('quotes', loader, { key: 'quotes', ttlMs: 60_000 })
  assert.equal(result.ok, true)
  assert.equal(result.stale, false)
  assert.equal(calls, 0, '缓存新鲜时不该碰上游')
  assert.deepEqual(result.value, { v: 'warm' })
  advance(1000)
})

test('第二态：loader 成功 → ok:true，并写进缓存', async () => {
  const { cache, runner } = makeRunner()
  const result = await runner.run('quotes', async () => ({ v: 42 }), { key: 'quotes', ttlMs: 60_000 })
  assert.equal(result.ok, true)
  assert.equal(result.stale, false)
  assert.deepEqual(result.value, { v: 42 })
  assert.deepEqual(cache.get('quotes'), { v: 42 })
  assert.ok(result.ms >= 0)
})

test('第三态：loader 失败但有过期值 → 返回旧值 + stale', async () => {
  const { cache, runner, advance } = makeRunner()
  cache.set('quotes', { v: 'old' }, 10)
  advance(50) // 让它过期
  const result = await runner.run('quotes', async () => { throw new Error('boom') }, { key: 'quotes', ttlMs: 10 })
  assert.equal(result.ok, true)
  assert.equal(result.stale, true)
  assert.deepEqual(result.value, { v: 'old' })
  assert.equal(result.error, 'unknown')
})

test('第四态：连旧值都没有 → ok:false + 错误码', async () => {
  const { runner } = makeRunner()
  const result = await runner.run('quotes', async () => { throw new Error('boom') }, { key: 'quotes', ttlMs: 10 })
  assert.equal(result.ok, false)
  assert.equal(result.stale, false)
  assert.equal(result.value, undefined)
  assert.ok(PART_ERROR_CODES.includes(result.error), `错误码应在枚举内，实际 ${result.error}`)
})

test('第四态：空值也算没有旧值（undefined / null 不兜底）', async () => {
  const { cache, runner, advance } = makeRunner()
  cache.set('quotes', null, 10)
  advance(50)
  const result = await runner.run('quotes', async () => { throw new Error('boom') }, { key: 'quotes', ttlMs: 10 })
  assert.equal(result.ok, false, 'null 不应被当成有效旧值')
})

test('超时：错误码是 timeout，且 loader 跑完仍会写入缓存（下一轮直接用）', async () => {
  const { cache, runner } = makeRunner({ deadlineMs: 30 })
  let resolveLate
  const late = new Promise((resolve) => {
    resolveLate = resolve
  })
  const result = await runner.run('quotes', () => late, { key: 'quotes', ttlMs: 60_000 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'timeout')
  // 让「超时」的那个 loader 完成：它的结果应该落进缓存
  resolveLate({ v: 'late' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(cache.get('quotes'), { v: 'late' }, '超时的 loader 完成后应写进缓存')
})

test('summarize：只暴露 id/ok/ms/error，不把 value 翻倍返回', async () => {
  const { runner } = makeRunner()
  const results = [
    await runner.run('quotes', async () => ({ big: 'x'.repeat(100) }), { key: 'q', ttlMs: 1000 }),
    await runner.run('snapshot', async () => { throw new Error('x') }, { key: 's', ttlMs: 1000 }),
  ]
  const parts = runner.summarize(results)
  assert.equal(parts.length, 2)
  for (const part of parts) {
    assert.deepEqual(Object.keys(part).filter((key) => !['stale', 'error'].includes(key)).sort(), ['id', 'ms', 'ok'].sort())
    assert.equal(part.value, undefined)
  }
  assert.equal(parts[0].ok, true)
  assert.equal(parts[1].ok, false)
})

test('partErrorCode：把各类异常收敛成固定枚举', () => {
  assert.equal(partErrorCode({ code: 'timeout' }), 'timeout')
  assert.equal(partErrorCode({ code: 'http', status: 503 }), 'http')
  assert.equal(partErrorCode({ status: 404 }), 'http')
  assert.equal(partErrorCode(new Error('request timed out')), 'timeout')
  assert.equal(partErrorCode(new Error('返回格式变了（data.items 缺失）')), 'parse')
  assert.equal(partErrorCode(new Error('连不上')), 'network')
  assert.equal(partErrorCode(new Error('fetch failed')), 'network')
  assert.equal(partErrorCode(new Error('boom')), 'unknown')
  assert.equal(partErrorCode({}), 'unknown')
  assert.equal(partErrorCode('weird'), 'unknown')
})

test('partErrorText：中文文案带错误码', () => {
  assert.match(partErrorText('指数报价', { code: 'timeout' }), /指数报价超时（timeout）/u)
  assert.match(partErrorText('板块', { code: 'http' }), /上游报错（http）/u)
})

test('未知 loader（非函数）不炸，直接 ok:false', async () => {
  const { runner } = makeRunner()
  const result = await runner.run('quotes', null, { key: 'quotes' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'unknown')
})

test('createPartsRunner：cache 缺少 memo/peek 直接报错（早失败好过晚出错）', () => {
  assert.throws(() => createPartsRunner({ cache: {} }), /memo 与 peek/u)
})
