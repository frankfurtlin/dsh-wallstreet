/**
 * lib/hub/upstream.js —— 统一上游调用单测
 *
 * 网络全部走本地 http server（127.0.0.1 随机端口），不发真实请求。
 * 重点验证「哪类错误重试、哪类不重试」和「超时文案带本次实际预算」。
 */
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import {
  fetchJson,
  fetchText,
  describeUpstreamError,
  UpstreamError,
  USER_AGENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DEADLINE_MS,
  DEFAULT_RETRIES,
} from '../lib/hub/upstream.js'

let server
let base
let hits = {}

const GBK_TEXT = '中文测试'
const GBK_BYTES = [0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]
const UTF8_BYTES = Buffer.from(GBK_TEXT, 'utf8')

before(async () => {
  server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1
    const path = req.url.split('?')[0]
    if (path === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":1,"items":["a","b"]}')
      return
    }
    if (path === '/echo') {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ua: req.headers['user-agent'] || '',
          accept: req.headers.accept || '',
          custom: req.headers['x-test'] || '',
          method: req.method,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      return
    }
    if (path === '/flaky') {
      // 第一次 500，第二次 200：验证「重试后成功」
      if ((hits['/flaky'] || 0) < 2) {
        res.writeHead(500)
        res.end('boom')
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true,"attempt":2}')
      }
      return
    }
    if (path === '/500') {
      res.writeHead(500)
      res.end('boom')
      return
    }
    if (path === '/429') {
      res.writeHead(429)
      res.end('slow down')
      return
    }
    if (path === '/404') {
      res.writeHead(404)
      res.end('nope')
      return
    }
    if (path === '/403') {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (path === '/badjson') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>not json</html>')
      return
    }
    if (path === '/text') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('hello 中文')
      return
    }
    if (path === '/json-text') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('{"not":"parsed"}')
      return
    }
    if (path === '/gbk') {
      res.writeHead(200, { 'content-type': 'text/html; charset=gbk' })
      res.end(Buffer.from(GBK_BYTES))
      return
    }
    if (path === '/utf8') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(UTF8_BYTES)
      return
    }
    if (path === '/slow') {
      // 永不返回，靠调用方超时；连接关闭时不需要额外清理
      req.on('close', () => {})
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  server.on('clientError', (error, socket) => socket.destroy())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
  hits = {}
})

const count = (path) => hits[path] || 0

/* ------------------------------ 正常路径 ------------------------------ */

test('fetchJson：200 返回解析后的 JSON', async () => {
  const body = await fetchJson(`${base}/ok`)
  assert.deepEqual(body, { ok: 1, items: ['a', 'b'] })
  assert.equal(count('/ok'), 1)
})

test('fetchJson：自报 UA + accept=application/json，自定义 headers 透传', async () => {
  const body = await fetchJson(`${base}/echo`, { headers: { 'x-test': 'hello' } })
  assert.equal(body.ua, USER_AGENT)
  assert.match(body.ua, /dsh-wallstreet/)
  assert.equal(body.accept, 'application/json')
  assert.equal(body.custom, 'hello')
  assert.equal(body.method, 'GET')
})

test('fetchJson：POST 方法与方法体透传', async () => {
  const body = await fetchJson(`${base}/echo`, { method: 'POST', body: '{"q":1}' })
  assert.equal(body.method, 'POST')
  assert.equal(body.body, '{"q":1}')
})

test('常量：默认超时/预算/重试次数与文档一致', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 8000)
  assert.equal(DEFAULT_DEADLINE_MS, 12000)
  assert.equal(DEFAULT_RETRIES, 1)
  assert.match(USER_AGENT, /^dsh-wallstreet\//)
})

/* ------------------------------ 重试策略 ------------------------------ */

test('fetchJson：500 重试一次（共 2 次请求），错误 code=http/status=500', async () => {
  await assert.rejects(
    () => fetchJson(`${base}/500`, { label: '测试源' }),
    (error) => {
      assert.ok(error instanceof UpstreamError)
      assert.equal(error.code, 'http')
      assert.equal(error.status, 500)
      assert.equal(error.name, 'UpstreamError')
      assert.equal(error.message, '测试源上游 HTTP 500')
      return true
    },
  )
  assert.equal(count('/500'), 2, '5xx 应重试一次')
})

test('fetchJson：429 视为可重试（共 2 次请求）', async () => {
  await assert.rejects(() => fetchJson(`${base}/429`, { label: '测试源' }), /HTTP 429/)
  assert.equal(count('/429'), 2)
})

test('fetchJson：404 不重试（只打 1 次）', async () => {
  await assert.rejects(
    () => fetchJson(`${base}/404`, { label: '测试源' }),
    (error) => {
      assert.equal(error.code, 'http')
      assert.equal(error.status, 404)
      assert.equal(error.fatal, true)
      return true
    },
  )
  assert.equal(count('/404'), 1)
})

test('fetchJson：403 同样不重试（4xx 是请求本身不对，不是对方暂时不行）', async () => {
  await assert.rejects(() => fetchJson(`${base}/403`, { label: '测试源' }), /HTTP 403/)
  assert.equal(count('/403'), 1)
})

test('fetchJson：retries=0 时 500 只打一次', async () => {
  await assert.rejects(() => fetchJson(`${base}/500`, { label: '测试源', retries: 0 }), /HTTP 500/)
  assert.equal(count('/500'), 1)
})

test('fetchJson：第一次 500、第二次 200 时重试成功', async () => {
  const body = await fetchJson(`${base}/flaky`, { label: '测试源' })
  assert.deepEqual(body, { ok: true, attempt: 2 })
  assert.equal(count('/flaky'), 2)
})

test('fetchJson：总预算不够再走一次时不发起重试', async () => {
  await assert.rejects(
    () => fetchJson(`${base}/500`, { label: '测试源', deadlineMs: 100 }),
    /HTTP 500/,
  )
  assert.equal(count('/500'), 1, '预算只剩 100ms，重试要 600ms 余量，应直接放弃')
})

/* ------------------------------ 超时 ------------------------------ */

test('fetchJson：超时抛 code=timeout，文案写本次实际预算（1s 而非写死 8s）', async () => {
  await assert.rejects(
    () => fetchJson(`${base}/slow`, { label: '测试源', timeoutMs: 200, deadlineMs: 400, retries: 0 }),
    (error) => {
      assert.equal(error.code, 'timeout')
      assert.equal(error.message, '测试源超时（1s）')
      assert.doesNotMatch(error.message, /8s/)
      return true
    },
  )
})

test('fetchJson：超时可重试，重试后仍超时则抛出（打 2 次）', async () => {
  await assert.rejects(
    () => fetchJson(`${base}/slow`, { label: '测试源', timeoutMs: 100, deadlineMs: 5000 }),
    (error) => {
      assert.equal(error.code, 'timeout')
      return true
    },
  )
  assert.equal(count('/slow'), 2)
})

/* ------------------------------ 解析与网络错误 ------------------------------ */

test('fetchJson：200 但返回不是 JSON 时抛 code=parse 且不重试', async () => {
  await assert.rejects(
    () => fetchJson(`${base}/badjson`, { label: '测试源' }),
    (error) => {
      assert.equal(error.code, 'parse')
      assert.equal(error.fatal, true)
      assert.equal(error.message, '测试源返回的不是 JSON')
      return true
    },
  )
  assert.equal(count('/badjson'), 1)
})

test('fetchJson：label 缺省时文案用「上游」', async () => {
  await assert.rejects(() => fetchJson(`${base}/badjson`), (error) => {
    assert.equal(error.message, '上游返回的不是 JSON')
    return true
  })
})

test('fetchJson：连不上时抛 code=network 且文案是中文', async () => {
  // 先占一个端口再关掉，保证该端口拒绝连接
  const probe = http.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const deadPort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  await assert.rejects(
    () => fetchJson(`http://127.0.0.1:${deadPort}/x`, { label: '测试源', timeoutMs: 500, deadlineMs: 1000 }),
    (error) => {
      assert.equal(error.code, 'network')
      assert.equal(error.message, '测试源连不上')
      return true
    },
  )
})

/* ------------------------------ describeUpstreamError ------------------------------ */

test('describeUpstreamError：timeout 带实际预算秒数', () => {
  assert.equal(describeUpstreamError({ code: 'timeout', timeoutMs: 8000 }, '东财'), '东财超时（8s）')
  assert.equal(describeUpstreamError({ code: 'timeout', timeoutMs: 200 }, '东财'), '东财超时（1s）')
  assert.equal(describeUpstreamError({ code: 'timeout' }, '东财'), '东财超时')
})

test('describeUpstreamError：aborted / http / parse 分支', () => {
  assert.equal(describeUpstreamError({ code: 'aborted' }, '东财'), '东财请求被取消')
  assert.equal(describeUpstreamError({ code: 'http', status: 503 }, '东财'), '东财上游 HTTP 503')
  assert.equal(describeUpstreamError({ code: 'http' }, '东财'), '东财上游 HTTP ?')
  assert.equal(describeUpstreamError({ code: 'parse' }, '东财'), '东财返回的不是 JSON')
})

test('describeUpstreamError：rejected / 未知 code / 空错误都落到「连不上」', () => {
  assert.equal(describeUpstreamError({ code: 'rejected' }, '东财'), '东财拒绝了请求（上游返回业务错误）')
  assert.equal(describeUpstreamError({ code: 'weird' }, '东财'), '东财连不上')
  assert.equal(describeUpstreamError(null, '东财'), '东财连不上')
  assert.equal(describeUpstreamError(undefined, '东财'), '东财连不上')
})

/* ------------------------------ fetchText ------------------------------ */

test('fetchText：默认按 UTF-8 解码', async () => {
  assert.equal(await fetchText(`${base}/utf8`), GBK_TEXT)
  assert.equal(await fetchText(`${base}/text`), 'hello 中文')
})

test('fetchText：不做 JSON 解析，JSON 文本原样返回', async () => {
  assert.equal(await fetchText(`${base}/json-text`), '{"not":"parsed"}')
})

test("fetchText：encoding='gbk' 显式按 GBK 解码", async () => {
  assert.equal(await fetchText(`${base}/gbk`, { encoding: 'gbk' }), GBK_TEXT)
})

test("fetchText：encoding='auto' 严格 UTF-8 失败后回退 GBK", async () => {
  assert.equal(await fetchText(`${base}/gbk`, { encoding: 'auto' }), GBK_TEXT)
})

test("fetchText：encoding='auto' 对合法 UTF-8 不用回退", async () => {
  assert.equal(await fetchText(`${base}/utf8`, { encoding: 'auto' }), GBK_TEXT)
})

test('fetchText：未知编码名回退 UTF-8 解码（不抛错）', async () => {
  assert.equal(await fetchText(`${base}/utf8`, { encoding: 'not-a-real-encoding' }), GBK_TEXT)
})

test('fetchText：500 重试一次；404 不重试', async () => {
  await assert.rejects(() => fetchText(`${base}/500`, { label: '测试源' }), /HTTP 500/)
  assert.equal(count('/500'), 2)
  await assert.rejects(
    () => fetchText(`${base}/404`, { label: '测试源' }),
    (error) => {
      assert.equal(error.code, 'http')
      assert.equal(error.fatal, true)
      return true
    },
  )
  assert.equal(count('/404'), 1)
})

test('fetchText：超时抛 code=timeout，文案带实际预算', async () => {
  await assert.rejects(
    () => fetchText(`${base}/slow`, { label: '测试源', timeoutMs: 200, deadlineMs: 400, retries: 0 }),
    (error) => {
      assert.equal(error.code, 'timeout')
      assert.equal(error.message, '测试源超时（1s）')
      return true
    },
  )
})

test('UpstreamError 保留 timeoutMs，二次渲染仍是「超时（2s）」（修 D2）', async () => {
  const error = new UpstreamError('随便', { code: 'timeout', url: 'u', timeoutMs: 2000 })
  assert.equal(error.timeoutMs, 2000)
  assert.equal(describeUpstreamError(error, '测试源'), '测试源超时（2s）')
})
