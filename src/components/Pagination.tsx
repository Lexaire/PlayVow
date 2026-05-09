import { Link, type LinkOptions } from '@tanstack/react-router'

export type PaginationProps = {
  readonly page: number
  readonly pageSize: number
  readonly total: number
  // Build the link target for a given page number. Receives the page number,
  // returns the full LinkOptions (to/params/search) for that page. The caller
  // decides which route + which search-param key to use.
  readonly hrefForPage: (page: number) => LinkOptions
}

const NUMBERED_WINDOW = 2 // pages on each side of the current page

const buildPageList = (current: number, totalPages: number): ReadonlyArray<number | 'gap'> => {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  const items: Array<number | 'gap'> = [1]
  const start = Math.max(2, current - NUMBERED_WINDOW)
  const end = Math.min(totalPages - 1, current + NUMBERED_WINDOW)
  if (start > 2) items.push('gap')
  for (let p = start; p <= end; p++) items.push(p)
  if (end < totalPages - 1) items.push('gap')
  items.push(totalPages)
  return items
}

export function Pagination({ page, pageSize, total, hrefForPage }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const startRow = total === 0 ? 0 : (page - 1) * pageSize + 1
  const endRow = Math.min(page * pageSize, total)
  const items = buildPageList(page, totalPages)

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 text-sm"
    >
      <p className="text-neutral-600">
        {total === 0
          ? 'No results.'
          : `Showing ${String(startRow)}–${String(endRow)} of ${String(total)}`}
      </p>
      {totalPages > 1 ? (
        <ul className="flex items-center gap-1">
          <li>
            {page > 1 ? (
              <Link
                activeOptions={{ exact: true, includeSearch: true, explicitUndefined: true }}
                {...hrefForPage(page - 1)}
                className="whitespace-nowrap rounded border border-neutral-300 px-3 py-1 hover:bg-neutral-100"
              >
                ← Prev
              </Link>
            ) : (
              <span className="whitespace-nowrap rounded border border-neutral-200 px-3 py-1 text-neutral-400">
                ← Prev
              </span>
            )}
          </li>
          {items.map((item, i) =>
            item === 'gap' ? (
              <li key={`gap-${String(i)}`} className="px-2 text-neutral-400" aria-hidden="true">
                …
              </li>
            ) : item === page ? (
              <li key={item}>
                <span
                  aria-current="page"
                  className="rounded border border-neutral-900 bg-surface-strong px-3 py-1 text-content-on-strong"
                >
                  {item}
                </span>
              </li>
            ) : (
              <li key={item}>
                <Link
                  activeOptions={{ exact: true, includeSearch: true, explicitUndefined: true }}
                  {...hrefForPage(item)}
                  className="rounded border border-neutral-300 px-3 py-1 hover:bg-neutral-100"
                >
                  {item}
                </Link>
              </li>
            ),
          )}
          <li>
            {page < totalPages ? (
              <Link
                activeOptions={{ exact: true, includeSearch: true, explicitUndefined: true }}
                {...hrefForPage(page + 1)}
                className="whitespace-nowrap rounded border border-neutral-300 px-3 py-1 hover:bg-neutral-100"
              >
                Next →
              </Link>
            ) : (
              <span className="whitespace-nowrap rounded border border-neutral-200 px-3 py-1 text-neutral-400">
                Next →
              </span>
            )}
          </li>
        </ul>
      ) : null}
    </nav>
  )
}
