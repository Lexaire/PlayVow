# SteamGifts Cloudflare Worker proxy

Tiny CF Worker that re-issues SG requests from Cloudflare's IP space, used to
bypass the JS challenge that Cloudflare WAF serves to certain VPS IP ranges.

## Why

PlayVow's worker and `/admin/cookies` test path both hit
`https://www.steamgifts.com/...`. From a flagged VPS IP, Cloudflare returns a
"Just a moment…" JS challenge (HTTP 403) instead of the page. CF→CF traffic
from a Worker doesn't get the same treatment, so we hop through one.

## Deploy (~5 minutes, zero CLI)

1. Cloudflare dashboard → **Workers & Pages → Create → Worker**.
2. Name it (e.g. `playvow-sg-proxy`), **Deploy**.
3. **Edit code**, paste [`worker.js`](./worker.js), **Deploy**.
4. **Settings → Variables and Secrets → Add → Type: Secret**:
   - Name: `PROXY_SHARED_SECRET`
   - Value: any random string (`openssl rand -base64 32`)
5. **Bindings → Add → Rate Limiting** (top nav tab, not under Settings):
   - Variable name: `PROXY_RATE_LIMIT` (must match `worker.js` exactly)
   - Namespace ID: `1001` (any small int unique to this worker)
   - Limit: `30`, Period: `60` seconds
   - Save, then re-deploy the worker so the binding takes effect.
6. Note the worker URL (top of dashboard) — looks like
   `https://playvow-sg-proxy.<your-subdomain>.workers.dev`.

## Wire into PlayVow

Set on the prod environment file (see [`infra/.env.example`](../.env.example)):

```
SG_PROXY_BASE=https://playvow-sg-proxy.<subdomain>.workers.dev
SG_PROXY_AUTH=<same value as PROXY_SHARED_SECRET>
```

Restart `playvow-web` and `playvow-worker`. Both the daily scrape and the
`/admin/cookies` Test button will route through the proxy.

## Verify

From the prod box (replace `<URL>` and `<SECRET>`):

```sh
curl -sS -o /tmp/sg.html -w "%{http_code}\n" \
  -H "X-Proxy-Auth: <SECRET>" \
  -H 'User-Agent: playvow/0.1 (+https://playvow.com)' \
  -H 'Accept: text/html,application/xhtml+xml' \
  '<URL>/group/xBp7E/taleplay/search?page=1'
```

Expect `200` and SG markup (look for `class="giveaway__row-outer-wrap"` in
`/tmp/sg.html`). `403` plain "forbidden" = secret mismatch. `403` with `Just
a moment...` = CF challenges its own workers for SG, fall back to a
residential proxy or Tailscale exit node.

## Cost

Free tier: 100k requests/day. PlayVow uses ~30/day (one daily scrape + a few
ad-hoc tests).
