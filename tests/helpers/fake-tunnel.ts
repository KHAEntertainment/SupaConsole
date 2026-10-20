import { CloudflareTunnel, type IngressRule } from '../../src/lib/tunnel'

// A real CloudflareTunnel whose fetch is an in-memory Cloudflare
// configurations endpoint, so worker tests exercise the adapter's
// read-modify-write semantics without touching the network.
export function fakeTunnel(domain = 'preview.example.invalid') {
  let ingress: IngressRule[] = [{ service: 'http_status:404' }]
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') ingress = (JSON.parse(String(init.body)) as { config: { ingress: IngressRule[] } }).config.ingress
    return new Response(JSON.stringify({ success: true, errors: [], result: { config: { ingress } } }), { status: 200 })
  }
  // Unique per instance so parallel test files never share a lock chain.
  const tunnel = new CloudflareTunnel({ account: `test-${crypto.randomUUID()}`, tunnel: 'test-tunnel', apiToken: 'synthetic-token', domain, fetch })
  return Object.assign(tunnel, { routes: () => ingress.filter(rule => rule.hostname !== undefined) })
}
