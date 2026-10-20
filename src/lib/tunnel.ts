// Phase 4 tunnel adapter: typed client for the Cloudflare cfd_tunnel
// configurations endpoint. The Cloudflare API replaces the whole ingress list
// and has no conflict check, so every write is a serialized read-modify-write
// that round-trips rules SupaConsole does not own.

export interface IngressRule {
  hostname?: string
  service: string
  [key: string]: unknown
}

export interface TunnelConfig {
  config: {
    ingress: IngressRule[]
    [key: string]: unknown
  }
}

export interface CloudflareTunnelOptions {
  account?: string
  tunnel?: string
  apiToken?: string
  domain?: string
  fetch?: typeof fetch
}

// Module-scope lock map, pinned on globalThis so Next dev HMR (which replaces
// the module on every save) does not fork the queue. Two `CloudflareTunnel`
// instances for the same account/tunnel share the same FIFO chain; the key is
// `${account}/${tunnel}` so concurrent writers cannot lose updates even when
// they come from different call sites (e.g. an API route + the worker).
const lockGlobal = globalThis as typeof globalThis & { __supaconsoleTunnelLocks?: Map<string, Promise<void>> }
const tunnelLocks: Map<string, Promise<void>> = lockGlobal.__supaconsoleTunnelLocks ??= new Map()

// DNS single-label regex (RFC 1123 hostnames, no dots). The hostname parameter
// of addPreviewRoute / removePreviewRoute is exactly one label followed by
// `.{domain}`; labels with dots (a.b.vpszone.xyz) would fall outside Universal
// SSL coverage, and labels containing spaces / wildcards (a b / *.) would
// either be invalid Cloudflare DNS or shadow later previews.
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function isCatchAll(rule: IngressRule): boolean {
  // A Cloudflare catch-all rule has neither hostname nor path; the rule
  // matches every request the tunnel receives.
  return rule.hostname === undefined && (rule as { path?: unknown }).path === undefined
}

export function previewHostname(slug: string, domain: string): string {
  // The hostname the runtime should configure auth/SITE_URL for. The slug is
  // the per-preview single label preview-runtime.ts already builds (and which
  // preview-worker.ts owns); combining it with the configured domain yields
  // the tunnel route's hostname.
  const normalizedDomain = domain.toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain) || normalizedDomain.includes('..')) {
    throw new Error('Invalid preview domain')
  }
  if (!LABEL_PATTERN.test(slug.toLowerCase())) throw new Error('Invalid preview slug')
  return `${slug.toLowerCase()}.${normalizedDomain}`
}

export class CloudflareTunnel {
  readonly account: string
  readonly tunnelId: string
  readonly domain: string
  readonly #apiToken: string
  readonly #fetchImpl: typeof fetch
  readonly #endpoint: string

  constructor(options: CloudflareTunnelOptions = {}) {
    const account = options.account ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? ''
    const tunnel = options.tunnel ?? process.env.CLOUDFLARE_TUNNEL_ID ?? ''
    const apiToken = options.apiToken ?? process.env.CLOUDFLARE_PREVIEW_API_TOKEN ?? ''
    const domain = options.domain ?? process.env.PREVIEW_DOMAIN ?? ''
    const fetcher = options.fetch ?? globalThis.fetch
    if (!account) throw new Error('CLOUDFLARE_ACCOUNT_ID is required')
    if (!tunnel) throw new Error('CLOUDFLARE_TUNNEL_ID is required')
    if (!apiToken) throw new Error('CLOUDFLARE_PREVIEW_API_TOKEN is required')
    const normalizedDomain = domain.toLowerCase()
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(normalizedDomain) || normalizedDomain.includes('..')) {
      throw new Error('PREVIEW_DOMAIN is required')
    }
    if (typeof fetcher !== 'function') throw new Error('fetch is unavailable in this runtime')
    this.account = account
    this.tunnelId = tunnel
    this.#apiToken = apiToken
    this.domain = normalizedDomain
    this.#fetchImpl = fetcher
    this.#endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/cfd_tunnel/${tunnel}/configurations`
  }

  async getConfig(): Promise<TunnelConfig> {
    return this.#request('GET')
  }

  // Intentionally NOT under the per-tunnel mutex: a direct caller can clobber
  // a write that is in flight. Use addPreviewRoute / removePreviewRoute for
  // the read-modify-write path so concurrent edits serialize through the
  // tunnel lock; this entry point is for tests, initial setup, or recovery
  // reconciliation that intentionally takes over the whole config.
  async putConfig(config: TunnelConfig): Promise<void> {
    await this.#request('PUT', config)
  }

  async addPreviewRoute(hostname: string, origin: string): Promise<void> {
    const normalized = this.#assertOwned(hostname)
    await this.#withLock(async () => {
      const config = await this.getConfig()
      const ingress = config.config.ingress
      const lastRule = ingress[ingress.length - 1]
      // Cloudflare rejects an ingress list with no catch-all at the end. If
      // the last rule isn't a catch-all (or there is no last rule), our
      // preview rule would land in front of a foreign rule, silently making
      // that foreign rule the new catch-all. Refuse the write instead.
      if (!lastRule || !isCatchAll(lastRule)) {
        throw new Error('Tunnel ingress has no catch-all rule at the end')
      }
      const withoutExisting = ingress.filter(rule => rule.hostname !== normalized)
      const rule: IngressRule = { hostname: normalized, service: origin }
      const insertAt = withoutExisting.length - 1
      withoutExisting.splice(insertAt, 0, rule)
      await this.putConfig({ config: { ...config.config, ingress: withoutExisting } })
    })
  }

  async removePreviewRoute(hostname: string): Promise<void> {
    const normalized = this.#assertOwned(hostname)
    await this.#withLock(async () => {
      const config = await this.getConfig()
      const filtered = config.config.ingress.filter(rule => rule.hostname !== normalized)
      if (filtered.length === config.config.ingress.length) return
      await this.putConfig({ config: { ...config.config, ingress: filtered } })
    })
  }

  // Domain enforcement (P4-4): the adapter ONLY touches rules whose hostname
  // is exactly one DNS label before .{domain}. A caller that names a foreign
  // rule (wildcard, multi-label, empty label, or whitespace) gets an explicit
  // error before the read-modify-write touches the live config.
  #assertOwned(hostname: string): string {
    const normalized = hostname.toLowerCase()
    const suffix = `.${this.domain}`
    if (!normalized.endsWith(suffix)) {
      throw new Error(`Hostname ${hostname} is outside the configured domain ${this.domain}`)
    }
    const label = normalized.slice(0, -suffix.length)
    if (!LABEL_PATTERN.test(label)) {
      throw new Error(`Hostname ${hostname} is outside the configured domain ${this.domain}`)
    }
    return normalized
  }

  async #request(method: 'GET' | 'PUT', body?: TunnelConfig): Promise<TunnelConfig> {
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${this.#apiToken}`, 'Content-Type': 'application/json' },
    }
    if (body) init.body = JSON.stringify(body)
    const response = await this.#fetchImpl(this.#endpoint, init)
    let text: string
    try { text = await response.text() } catch { text = '' }
    if (!response.ok) throw new Error(`Cloudflare tunnel config ${method} failed: ${response.status} ${this.#formatErrorDetail(text)}`.trim())
    // The GET response's `result.config` is the inner config object
    // (e.g. { ingress, "warp-routing" }), NOT wrapped again. The PUT body, by
    // contrast, is the wrapped shape { config: { ... } }, which is what
    // TunnelConfig represents. Wrap the GET inner on the way out so callers
    // see the same TunnelConfig shape regardless of direction.
    let data: { success?: boolean; errors?: unknown[]; result?: { config?: TunnelConfig['config'] } }
    try { data = JSON.parse(text) as typeof data } catch { throw new Error(`Cloudflare tunnel config ${method} returned non-JSON`) }
    if (!data || data.success !== true || !data.result?.config) {
      throw new Error(`Cloudflare tunnel config ${method} returned no config`)
    }
    if (!Array.isArray(data.result.config.ingress)) {
      throw new Error(`Cloudflare tunnel config ${method} returned config without ingress array`)
    }
    return { config: data.result.config }
  }

  // Defence in depth: even though the adapter never echoes the token into an
  // error string, we redact any accidental substring match before throwing.
  // Upstream body is truncated so a verbose Cloudflare error can't bloat logs.
  #formatErrorDetail(body: string): string {
    const MAX = 500
    let detail = ''
    if (body) {
      try {
        const parsed = JSON.parse(body) as { errors?: Array<{ code?: unknown; message?: unknown }> }
        if (Array.isArray(parsed.errors) && parsed.errors.length) {
          detail = `[errors: ${parsed.errors.map(e => `${e.code}:${e.message}`).join('; ')}]`
        } else {
          detail = `[${body}]`
        }
      } catch {
        detail = `[${body}]`
      }
      if (detail.length > MAX) detail = detail.slice(0, MAX) + '...[truncated]'
    }
    return detail.split(this.#apiToken).join('[redacted]')
  }

  async #withLock<T>(work: () => Promise<T>): Promise<T> {
    const key = `${this.account}/${this.tunnelId}`
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    const previous = tunnelLocks.get(key) ?? Promise.resolve()
    const tail = previous.then(() => next)
    tunnelLocks.set(key, tail)
    await previous
    try {
      return await work()
    } finally {
      release()
      // Drop the entry when the queue has fully drained so the lock map does
      // not grow unbounded for a process that touches many tunnels over time.
      if (tunnelLocks.get(key) === tail) tunnelLocks.delete(key)
    }
  }
}