import '#/lib/server-only'

type Entry<V> = { readonly value: V; readonly expiresAt: number }

export type TtlCache<K extends string, V> = {
  readonly get: (key: K, load: () => Promise<V>) => Promise<V>
  readonly invalidate: (key: K) => void
  readonly clear: () => void
}

export const createTtlCache = <K extends string, V>(ttlMs: number): TtlCache<K, V> => {
  const store = new Map<K, Entry<V>>()
  const inflight = new Map<K, Promise<V>>()

  return {
    async get(key, load) {
      const now = Date.now()
      const hit = store.get(key)
      if (hit && hit.expiresAt > now) return hit.value

      const pending = inflight.get(key)
      if (pending) return pending

      const p = load()
        .then((value) => {
          store.set(key, { value, expiresAt: Date.now() + ttlMs })
          return value
        })
        .finally(() => {
          inflight.delete(key)
        })
      inflight.set(key, p)
      return p
    },
    invalidate(key) {
      store.delete(key)
    },
    clear() {
      store.clear()
    },
  }
}
