import assert from 'node:assert/strict'
import test from 'node:test'
import { BuildNumberSource } from '../server/build-source.js'

function stubFetch(routes) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const pathname = url.replace('http://console', '')
    const handler = routes[pathname]
    if (!handler) return { ok: false, status: 404 }
    return { ok: true, status: 200, json: async () => handler, text: async () => handler }
  }
  return { fetchImpl, calls }
}

test('BuildNumberSource бере номер із build.json', async () => {
  const { fetchImpl } = stubFetch({ '/build.json': { build: '2026.08.06.1848' } })
  const source = new BuildNumberSource({ url: 'http://console', fallback: 'desk-local', fetchImpl })
  assert.equal(await source.current(), '2026.08.06.1848')
})

test('BuildNumberSource вичитує номер із бандла, коли build.json ще немає', async () => {
  const { fetchImpl, calls } = stubFetch({
    '/': '<script src="/assets/index-CvXwDMRx.js"></script>',
    '/assets/index-CvXwDMRx.js': 'const b="2026.08.06.1848";',
  })
  const source = new BuildNumberSource({ url: 'http://console', fallback: 'desk-local', fetchImpl })
  assert.equal(await source.current(), '2026.08.06.1848')

  source.resolvedAt = 0
  assert.equal(await source.current(), '2026.08.06.1848')
  assert.equal(calls.filter((url) => url.endsWith('.js')).length, 1)
})

test('BuildNumberSource падає на власний номер, коли консоль недоступна', async () => {
  const { fetchImpl } = stubFetch({})
  const source = new BuildNumberSource({ url: 'http://console', fallback: 'desk-local', fetchImpl })
  assert.equal(await source.current(), 'desk-local')

  const configured = new BuildNumberSource({ url: '', fallback: 'desk-local', fetchImpl })
  assert.equal(await configured.current(), 'desk-local')
})

test('BuildNumberSource кешує відповідь у межах TTL', async () => {
  const { fetchImpl, calls } = stubFetch({ '/build.json': { build: '2026.08.06.1848' } })
  const source = new BuildNumberSource({ url: 'http://console', fallback: 'desk-local', fetchImpl })
  await source.current()
  await source.current()
  assert.equal(calls.length, 1)
})
