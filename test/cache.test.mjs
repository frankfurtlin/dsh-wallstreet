/**
 * lib/hub/cache.js —— 进程内三档缓存单测
 *
 * 时间一律用注入的假时钟 `now`，并发用例用「闸门 Promise」把 loader 卡住，
 * 保证「三个并发只打一次上游」是被真的验证过，而不是碰巧串行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createCache } from '../lib/hub/cache.js'

/** 假时钟：手动拨表。 */
const clock = (start = 1000) => {
  let value = start
  return { now: () => value, set: (next) => { value = next }, advance: (ms) => { value += ms } }
}

/** 闸门 loader：拿到 resolve/reject 之前一直挂着。 */
const gated = () => {
  let open
  let close
  const gate = new Promise((resolve, reject) => {
    open = resolve
    close = reject
  })
  return { gate, open: (value) => open(value), fail: (error) => close(error) }
}

test('get：没有写过的 key 返回 undefined', () => {
  const cache = createCache({ now: () => 1000 })
  assert.equal(cache.get('missing'), undefined)
  assert.equal(cache.peek('missing'), undefined)
  assert.equal(cache.size(), 0)
})

test('set/get：新鲜值原样返回（同一个对象引用，不做拷贝）', () => {
  const cache = createCache({ now: () => 1000 })
  const value = { list: [1, 2, 3] }
  cache.set('k', value, 500)
  assert.equal(cache.get('k'), value)
  assert.equal(cache.peek('k').value, value)
})

test('peek：新鲜条目的 staleMs 为 0', () => {
  const cache = createCache({ now: () => 1000 })
  cache.set('k', 'v', 500)
  assert.deepEqual(cache.peek('k'), { value: 'v', staleMs: 0 })
})

test('memo：首次调 loader，之后新鲜命中不再调', async () => {
  const t = clock()
  const cache = createCache({ now: t.now })
  let calls = 0
  const loader = async () => {
    calls += 1
    return { n: calls }
  }
  assert.deepEqual(await cache.memo('k', 100, loader), { n: 1 })
  assert.deepEqual(await cache.memo('k', 100, loader), { n: 1 })
  assert.equal(calls, 1)
  assert.equal(cache.size(), 1)
})

test('memo：三个并发调用只打一次 loader', async () => {
  const t = clock()
  const cache = createCache({ now: t.now })
  const { gate, open } = gated()
  let calls = 0
  const loader = async () => {
    calls += 1
    await gate
    return `value-${calls}`
  }
  const p1 = cache.memo('k', 100, loader)
  const p2 = cache.memo('k', 100, loader)
  const p3 = cache.memo('k', 100, loader)
  open()
  const [a, b, c] = await Promise.all([p1, p2, p3])
  assert.equal(calls, 1, `并发应只调一次 loader，实际 ${calls}`)
  assert.equal(a, 'value-1')
  assert.equal(b, a)
  assert.equal(c, a)
})

test('memo：并发调用拿到的是同一个 Promise 的结果（不是各自算一遍）', async () => {
  const cache = createCache({ now: () => 1000 })
  const { gate, open } = gated()
  const value = { heavy: true }
  const loader = async () => {
    await gate
    return value
  }
  const p1 = cache.memo('k', 100, loader)
  const p2 = cache.memo('k', 100, loader)
  open()
  assert.equal(await p1, value)
  assert.equal(await p2, value)
})

test('memo：不同 key 并发时各调一次 loader', async () => {
  const cache = createCache({ now: () => 1000 })
  const { gate, open } = gated()
  let calls = 0
  const loader = () => {
    calls += 1
    const n = calls
    return gate.then(() => n)
  }
  const p1 = cache.memo('a', 100, loader)
  const p2 = cache.memo('b', 100, loader)
  open()
  assert.deepEqual(await Promise.all([p1, p2]), [1, 2])
  assert.equal(calls, 2)
})

test('memo：过期后 get 拿不到，但 peek 还能读到旧值', async () => {
  const t = clock()
  const cache = createCache({ now: t.now })
  await cache.memo('k', 100, async () => 'v1')
  t.set(1100) // 恰好到 expiresAt
  assert.equal(cache.get('k'), undefined)
  assert.deepEqual(cache.peek('k'), { value: 'v1', staleMs: 0 })
  t.set(1500)
  assert.equal(cache.get('k'), undefined)
  assert.deepEqual(cache.peek('k'), { value: 'v1', staleMs: 400 })
})

test('memo：过期后会重新调 loader 并覆盖旧值', async () => {
  const t = clock()
  const cache = createCache({ now: t.now })
  let calls = 0
  const loader = async () => {
    calls += 1
    return `v${calls}`
  }
  await cache.memo('k', 100, loader)
  t.advance(101)
  assert.equal(await cache.memo('k', 100, loader), 'v2')
  assert.equal(calls, 2)
  assert.equal(cache.peek('k').value, 'v2')
})

test('memo：ttl 为 0/负数时立刻过期（get 拿不到，peek 有）', async () => {
  const t = clock()
  const cache = createCache({ now: t.now })
  await cache.memo('zero', 0, async () => 'z')
  await cache.memo('negative', -100, async () => 'n')
  assert.equal(cache.get('zero'), undefined)
  assert.equal(cache.get('negative'), undefined)
  assert.equal(cache.peek('zero').value, 'z')
  assert.equal(cache.peek('negative').value, 'n')
})

test('memo：loader 抛错时向上传播、不写缓存，下次调用重新试', async () => {
  const cache = createCache({ now: () => 1000 })
  let calls = 0
  await assert.rejects(
    () => cache.memo('k', 100, async () => {
      calls += 1
      throw new Error('上游挂了')
    }),
    /上游挂了/,
  )
  assert.equal(calls, 1)
  assert.equal(cache.size(), 0)
  const value = await cache.memo('k', 100, async () => {
    calls += 1
    return 'ok'
  })
  assert.equal(value, 'ok')
  assert.equal(calls, 2)
})

test('setStale：get 拿不到、peek 拿得到，staleMs 为正', () => {
  const t = clock(1000)
  const cache = createCache({ now: t.now })
  cache.setStale('k', 'old', 400)
  t.set(1500)
  assert.equal(cache.get('k'), undefined)
  // staleMs 是「距离过期时刻过了多久」，storedAt=400 的那条在 expiresAt=0 就过期了
  assert.deepEqual(cache.peek('k'), { value: 'old', staleMs: 1500 })
})

test('setStale：不传 storedAt 也能写入（get 不命中、peek 有值）', () => {
  const cache = createCache({ now: () => 1000 })
  cache.setStale('k', 'old')
  assert.equal(cache.get('k'), undefined)
  assert.equal(cache.peek('k').value, 'old')
})

test('set：storedAt 传入非有限值时回退为当前时间', () => {
  const t = clock(1000)
  const cache = createCache({ now: t.now })
  cache.set('nan', 'v', 100, { storedAt: NaN })
  assert.equal(cache.get('nan'), 'v', 'storedAt 非法应回落为 now，值仍然新鲜')
})

test('set：storedAt 指定为很久以前时按剩余 TTL 算，可能一开始就是过期值', () => {
  const t = clock(1500)
  const cache = createCache({ now: t.now })
  cache.set('k', 'v', 100, { storedAt: 1000 })
  assert.equal(cache.get('k'), undefined, 'storedAt+ttl=1100 已过期，get 不该命中')
  assert.deepEqual(cache.peek('k'), { value: 'v', staleMs: 400 })
})

test('set：storedAt 指定为最近时仍然新鲜', () => {
  const t = clock(1500)
  const cache = createCache({ now: t.now })
  cache.set('k', 'v', 100, { storedAt: 1450 })
  assert.equal(cache.get('k'), 'v')
  assert.equal(cache.peek('k').staleMs, 0)
})

test('maxEntries：超上限时淘汰最旧的一条', () => {
  const t = clock(100)
  const cache = createCache({ now: t.now, maxEntries: 2 })
  cache.set('x1', 1, 10_000)
  t.set(200)
  cache.set('x2', 2, 10_000)
  t.set(300)
  cache.set('x3', 3, 10_000)
  assert.equal(cache.size(), 2)
  assert.equal(cache.get('x1'), undefined, '最旧的 x1 应被淘汰')
  assert.equal(cache.get('x2'), 2)
  assert.equal(cache.get('x3'), 3)
})

test('maxEntries：淘汰前先把已过期条目清掉', () => {
  const t = clock(0)
  const cache = createCache({ now: t.now, maxEntries: 2 })
  cache.set('stale', 'old', 10) // 在 t=10 过期
  t.set(1000)
  cache.set('fresh1', 'a', 10_000)
  cache.set('fresh2', 'b', 10_000)
  assert.equal(cache.size(), 2)
  assert.equal(cache.get('stale'), undefined)
  assert.equal(cache.get('fresh1'), 'a')
  assert.equal(cache.get('fresh2'), 'b')
})

test('maxEntries：全是过期值时会被整批清空（不占用配额）', () => {
  const t = clock(0)
  const cache = createCache({ now: t.now, maxEntries: 2 })
  cache.setStale('z1', 1, 1)
  cache.setStale('z2', 2, 2)
  cache.setStale('z3', 3, 3)
  // 三条都已是过期值（expiresAt=0），sweep 先按过期清光
  assert.equal(cache.size(), 0)
})

test('delete：删掉指定 key，其它 key 不受影响', () => {
  const cache = createCache({ now: () => 1000 })
  cache.set('a', 1, 1000)
  cache.set('b', 2, 1000)
  cache.delete('a')
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('b'), 2)
  assert.equal(cache.size(), 1)
  cache.delete('不存在的 key')
  assert.equal(cache.size(), 1)
})

test('clear：清空所有条目', () => {
  const cache = createCache({ now: () => 1000 })
  cache.set('a', 1, 1000)
  cache.set('b', 2, 1000)
  cache.setStale('c', 3, 1)
  assert.equal(cache.size(), 3)
  cache.clear()
  assert.equal(cache.size(), 0)
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.peek('b'), undefined)
})

test('size：只数当前存活的条目数（过期未清也还在表里）', () => {
  const t = clock(0)
  const cache = createCache({ now: t.now })
  cache.set('a', 1, 10)
  cache.set('b', 2, 10_000)
  assert.equal(cache.size(), 2)
  t.set(100) // a 过期但还没触发 sweep
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.size(), 2)
})

test('createCache：默认参数可用（now=Date.now, maxEntries=512）', async () => {
  const cache = createCache()
  await cache.memo('k', 60_000, async () => 'v')
  assert.equal(cache.get('k'), 'v')
  for (let i = 0; i < 600; i += 1) cache.set(`x${i}`, i, 60_000)
  assert.ok(cache.size() <= 512, `size 应 <= 512，实际 ${cache.size()}`)
})

test('memo：loader 返回 undefined 时不算有效缓存（每次都会重算）', async () => {
  const cache = createCache({ now: () => 1000 })
  let calls = 0
  const loader = async () => {
    calls += 1
    return undefined
  }
  assert.equal(await cache.memo('k', 100, loader), undefined)
  assert.equal(await cache.memo('k', 100, loader), undefined)
  assert.equal(calls, 2, 'undefined 无法与「未命中」区分，只能重算')
})
