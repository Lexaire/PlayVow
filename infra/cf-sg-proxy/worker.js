// Minimal SteamGifts proxy. The path on this worker maps 1:1 to
// https://www.steamgifts.com/<path>. We forward the caller's Cookie + other
// headers untouched, only rewriting Host so SG sees its own domain. CF→CF
// traffic isn't subject to the same WAF heuristics that gate VPS IP ranges
// with a "Just a moment..." JS challenge.
//
// PlayVow's web + worker processes set:
//   SG_PROXY_BASE=https://<this-worker>.workers.dev
//   SG_PROXY_AUTH=<the same secret stored as PROXY_SHARED_SECRET below>
//
// Set PROXY_SHARED_SECRET in the dashboard:
//   Worker → Settings → Variables and Secrets → Add → Type: Secret
//   Name: PROXY_SHARED_SECRET
//   Value: any random string (e.g. `openssl rand -base64 32`)
// That gates the worker so it isn't an open SG proxy. Anything without a
// matching X-Proxy-Auth header gets 403'd here.

export default {
  async fetch(request, env) {
    const expected = env.PROXY_SHARED_SECRET
    if (!expected) {
      return new Response('worker missing PROXY_SHARED_SECRET', { status: 500 })
    }

    // Per-IP rate limit (binding set in dashboard: 30 req / 60s). Runs before
    // the auth check so a brute-forcer trying random secrets gets capped at
    // 30 attempts/minute per IP instead of burning Worker CPU on string
    // comparisons. PlayVow itself does ~30 req/day so the legit caller never
    // touches the ceiling. Binding is optional — falls through if absent so
    // local replays / new deploys without the binding still work.
    if (env.PROXY_RATE_LIMIT) {
      const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown'
      const { success } = await env.PROXY_RATE_LIMIT.limit({ key: clientIp })
      if (!success) {
        return new Response('rate limited', { status: 429 })
      }
    }

    if (request.headers.get('X-Proxy-Auth') !== expected) {
      return new Response('forbidden', { status: 403 })
    }

    const url = new URL(request.url)
    const target = `https://www.steamgifts.com${url.pathname}${url.search}`

    const headers = new Headers(request.headers)
    headers.delete('X-Proxy-Auth')
    headers.delete('host')
    headers.delete('cf-connecting-ip')
    headers.delete('cf-ray')
    headers.delete('cf-visitor')
    headers.delete('x-forwarded-for')
    headers.delete('x-forwarded-proto')
    headers.delete('x-real-ip')

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'follow',
    })

    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    })
  },
}
