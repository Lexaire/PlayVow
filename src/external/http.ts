import type { Result } from '#/lib/result'
import { err, ok } from '#/lib/result'

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export type HttpError =
  | { readonly kind: 'http_status'; readonly status: number; readonly body: string }
  | { readonly kind: 'network'; readonly message: string }

export const fetchText = async (
  fetcher: Fetcher,
  url: string,
  init?: RequestInit,
): Promise<Result<string, HttpError>> => {
  let res: Response
  try {
    res = await fetcher(url, init)
  } catch (e) {
    return err({
      kind: 'network',
      message: e instanceof Error ? e.message : String(e),
    })
  }
  const body = await res.text()
  if (res.status < 200 || res.status >= 300) {
    return err({ kind: 'http_status', status: res.status, body })
  }
  return ok(body)
}
