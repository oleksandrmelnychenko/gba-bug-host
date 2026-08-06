const BUILD_PATTERN = /\b20\d{2}\.\d{2}\.\d{2}\.\d{3,4}\b/
const ASSET_PATTERN = /\/assets\/index-[A-Za-z0-9_-]+\.js/

export class BuildNumberSource {
  constructor({
    url = process.env.BUILD_SOURCE_URL ?? '',
    fallback = '0.1.0-local',
    ttlMs = Number.parseInt(process.env.BUILD_SOURCE_TTL_MS ?? '30000', 10),
    timeoutMs = Number.parseInt(process.env.BUILD_SOURCE_TIMEOUT_MS ?? '4000', 10),
    fetchImpl = fetch,
  } = {}) {
    this.url = url.replace(/\/$/, '')
    this.fallback = fallback
    this.ttlMs = ttlMs
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl
    this.resolved = ''
    this.resolvedAt = 0
    this.bundle = { asset: '', number: '' }
  }

  async request(pathname) {
    const response = await this.fetchImpl(`${this.url}${pathname}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`${pathname} → ${response.status}`)
    return response
  }

  async fromBuildInfo() {
    const payload = await (await this.request('/build.json')).json()
    const number = typeof payload?.build === 'string' ? payload.build.trim() : ''
    return number || null
  }

  async fromBundle() {
    const asset = ASSET_PATTERN.exec(await (await this.request('/')).text())?.[0]
    if (!asset) return null
    if (asset === this.bundle.asset) return this.bundle.number || null

    const number = BUILD_PATTERN.exec(await (await this.request(asset)).text())?.[0] ?? ''
    this.bundle = { asset, number }
    return number || null
  }

  async current() {
    if (!this.url) return this.fallback
    if (this.resolved && Date.now() - this.resolvedAt < this.ttlMs) return this.resolved

    for (const read of [() => this.fromBuildInfo(), () => this.fromBundle()]) {
      const number = await read().catch(() => null)
      if (!number) continue
      this.resolved = number
      this.resolvedAt = Date.now()
      return number
    }

    return this.resolved || this.fallback
  }
}
