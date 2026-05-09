import { Link, createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { AdminTabs } from '#/components/admin/AdminTabs'
import { ManualRuns } from '#/components/admin/ManualRuns'
import { formatRelativeTime } from '#/components/admin/cookie-ui'
import { JOB_RUN_STATUSES } from '#/db/schema'
import { HEARTBEAT_STALE_MS, STALE_THRESHOLD_MS } from '#/lib/health-rollup'
import { formatOperationalError } from '#/lib/operational-errors'
import type { JobRunStatus } from '#/db/schema'
import type { JobRunRow, JsonValue } from '#/repos/jobRuns'
import type { WorkerHeartbeatRow } from '#/repos/workerHeartbeats'
import type { AdminJobLatest } from '#/server/jobsFns'
import { listJobRunsForAdmin } from '#/server/jobsFns'

const SearchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  job: z.string().min(1).max(64).optional(),
  status: z.enum(JOB_RUN_STATUSES).optional(),
})

export const Route = createFileRoute('/admin/jobs')({
  validateSearch: (search: Record<string, unknown>) => SearchSchema.parse(search),
  loaderDeps: ({ search }) => ({
    page: search.page ?? 1,
    jobName: search.job,
    status: search.status,
  }),
  loader: async ({ deps }) =>
    listJobRunsForAdmin({
      data: {
        page: deps.page,
        ...(deps.jobName ? { jobName: deps.jobName } : {}),
        ...(deps.status ? { status: deps.status } : {}),
      },
    }),
  component: AdminJobsPage,
})

const STATUS_PILL: Record<JobRunStatus | 'stale', string> = {
  running: 'bg-sky-100 text-sky-800',
  succeeded: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-rose-100 text-rose-800',
  stale: 'bg-amber-100 text-amber-900',
}

const displayStatus = (row: JobRunRow, now: Date): JobRunStatus | 'stale' => {
  if (row.status !== 'running') return row.status
  return now.getTime() - row.startedAt.getTime() > STALE_THRESHOLD_MS ? 'stale' : 'running'
}

const formatDurationMs = (ms: number | null): string => {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return remSec === 0 ? `${min}m` : `${min}m ${remSec}s`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`
}

function AdminJobsPage() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const now = new Date()

  return (
    <div className="space-y-6">
      <AdminTabs active="jobs" />
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Jobs</h1>
        <p className="text-sm text-neutral-600">
          Scheduled background jobs. Each card shows the most recent run; the table below is the
          full history.
        </p>
      </header>

      <HeartbeatCard heartbeat={data.heartbeat} now={now} />

      <ManualRuns groups={data.groups} pendingWins={data.pendingWins} />

      <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {data.latest.map((entry) => (
          <JobSummaryCard key={entry.catalogue.name} entry={entry} now={now} />
        ))}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex items-end gap-1">
            <span className="mb-1 text-xs font-medium text-neutral-600">Job</span>
            <Link
              to="/admin/jobs"
              search={(prev) => ({ ...prev, job: undefined, page: undefined })}
              className={pillCls(search.job === undefined)}
            >
              all
            </Link>
            {data.latest.map((e) => (
              <Link
                key={e.catalogue.name}
                to="/admin/jobs"
                search={(prev) => ({ ...prev, job: e.catalogue.name, page: undefined })}
                className={pillCls(search.job === e.catalogue.name)}
              >
                {e.catalogue.name}
              </Link>
            ))}
          </div>
          <div className="flex items-end gap-1">
            <span className="mb-1 text-xs font-medium text-neutral-600">Status</span>
            <Link
              to="/admin/jobs"
              search={(prev) => ({ ...prev, status: undefined, page: undefined })}
              className={pillCls(search.status === undefined)}
            >
              all
            </Link>
            {JOB_RUN_STATUSES.map((s) => (
              <Link
                key={s}
                to="/admin/jobs"
                search={(prev) => ({ ...prev, status: s, page: undefined })}
                className={pillCls(search.status === s)}
              >
                {s}
              </Link>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto rounded border border-neutral-200 bg-surface">
          <table className="min-w-full divide-y divide-neutral-200 text-sm">
            <thead className="bg-neutral-50 text-left text-xs font-semibold uppercase text-neutral-600">
              <tr>
                <th className="px-3 py-2">Job</th>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Steam</th>
                <th className="px-3 py-2 text-right">SG</th>
                <th className="px-3 py-2">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {data.history.map((row) => {
                const status = displayStatus(row, now)
                return (
                  <tr key={row.id}>
                    <td className="px-3 py-2 font-mono text-xs">{row.jobName}</td>
                    <td className="px-3 py-2 text-neutral-600">
                      {row.startedAt.toISOString().replace('T', ' ').slice(0, 19)}
                    </td>
                    <td className="px-3 py-2 text-neutral-600">
                      {formatDurationMs(row.durationMs)}
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill status={status} />
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-600">
                      {row.steamCalls ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-600">{row.sgCalls ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-neutral-700">
                      {row.errorMessage ? (
                        <ErrorCell raw={row.errorMessage} jobName={row.jobName} />
                      ) : row.summary !== null && row.summary !== undefined ? (
                        <code className="block max-w-md overflow-x-auto whitespace-pre-wrap text-[11px] text-neutral-600">
                          {summarize(row.summary)}
                        </code>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                )
              })}
              {data.history.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-sm text-neutral-500">
                    No runs match.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between text-sm text-neutral-600">
          <span>
            Page {data.page} · {data.total} total
          </span>
          <div className="flex gap-2">
            {data.page > 1 ? (
              <Link
                to="/admin/jobs"
                search={{ ...search, page: data.page - 1 }}
                className="rounded border border-neutral-300 px-3 py-1 hover:bg-neutral-100"
              >
                ← Prev
              </Link>
            ) : null}
            {data.page * data.pageSize < data.total ? (
              <Link
                to="/admin/jobs"
                search={{ ...search, page: data.page + 1 }}
                className="rounded border border-neutral-300 px-3 py-1 hover:bg-neutral-100"
              >
                Next →
              </Link>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  )
}

function HeartbeatCard({
  heartbeat,
  now,
}: {
  readonly heartbeat: WorkerHeartbeatRow | null
  readonly now: Date
}) {
  if (heartbeat === null) {
    return (
      <div className="rounded border border-neutral-200 bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Worker heartbeat</h2>
            <p className="mt-0.5 text-xs text-neutral-600">
              No heartbeat recorded yet. The worker may not have started since this feature shipped.
            </p>
          </div>
          <span className="inline-flex items-center rounded-full bg-neutral-200 px-2.5 py-0.5 text-xs font-medium text-neutral-700">
            unknown
          </span>
        </div>
      </div>
    )
  }
  const sinceLastSeenMs = now.getTime() - heartbeat.lastSeenAt.getTime()
  const isStale = sinceLastSeenMs > HEARTBEAT_STALE_MS
  return (
    <div
      className={`rounded border p-4 ${
        isStale ? 'border-amber-300 bg-amber-50' : 'border-neutral-200 bg-surface'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Worker heartbeat</h2>
          <p className="mt-0.5 text-xs text-neutral-600">
            {isStale
              ? 'Worker has not checked in. Background updates may be stopped.'
              : 'Worker is running and writing a heartbeat every 5 minutes.'}
          </p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            isStale ? 'bg-amber-200 text-amber-900' : 'bg-emerald-100 text-emerald-800'
          }`}
        >
          {isStale ? 'stale' : 'healthy'}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-neutral-700 md:grid-cols-3">
        <dt className="text-neutral-500">Last seen</dt>
        <dd className="md:col-span-2">{formatRelativeTime(heartbeat.lastSeenAt, now)}</dd>
        <dt className="text-neutral-500">Uptime</dt>
        <dd className="md:col-span-2">
          {formatDurationMs(now.getTime() - heartbeat.startedAt.getTime())}
        </dd>
        <dt className="text-neutral-500">PID</dt>
        <dd className="md:col-span-2 font-mono">{heartbeat.pid}</dd>
      </dl>
    </div>
  )
}

function JobSummaryCard({ entry, now }: { readonly entry: AdminJobLatest; readonly now: Date }) {
  const { catalogue, latest } = entry
  const status = latest === null ? 'never' : displayStatus(latest, now)
  return (
    <div className="rounded border border-neutral-200 bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-mono text-sm font-semibold">{catalogue.name}</h2>
          <p className="mt-0.5 text-xs text-neutral-600">{catalogue.description}</p>
          <p className="mt-1 font-mono text-[11px] text-neutral-500">{catalogue.cron}</p>
        </div>
        {status === 'never' ? (
          <span className="inline-flex items-center rounded-full bg-neutral-200 px-2.5 py-0.5 text-xs font-medium text-neutral-700">
            never run
          </span>
        ) : (
          <StatusPill status={status} />
        )}
      </div>
      {latest !== null ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-neutral-700">
          <dt className="text-neutral-500">Last started</dt>
          <dd>{formatRelativeTime(latest.startedAt, now)}</dd>
          <dt className="text-neutral-500">Duration</dt>
          <dd>{formatDurationMs(latest.durationMs)}</dd>
          <dt className="text-neutral-500">Steam calls</dt>
          <dd>{latest.steamCalls ?? '—'}</dd>
          <dt className="text-neutral-500">SG calls</dt>
          <dd>{latest.sgCalls ?? '—'}</dd>
          {latest.errorMessage ? (
            <>
              <dt className="text-neutral-500">Error</dt>
              <dd>
                <ErrorCell raw={latest.errorMessage} jobName={catalogue.name} />
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  )
}

function ErrorCell({ raw, jobName }: { readonly raw: string; readonly jobName: string }) {
  const { summary, suggestion } = formatOperationalError(raw, { jobName })
  return (
    <div>
      <span className="text-rose-700">{summary}</span>
      {suggestion ? <p className="mt-0.5 text-neutral-500">{suggestion}</p> : null}
      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] text-neutral-400 hover:text-neutral-600">
          raw error
        </summary>
        <code className="mt-1 block max-w-sm overflow-x-auto whitespace-pre-wrap text-[11px] text-neutral-500">
          {raw}
        </code>
      </details>
    </div>
  )
}

function StatusPill({ status }: { readonly status: JobRunStatus | 'stale' }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_PILL[status]}`}
    >
      {status}
    </span>
  )
}

const pillCls = (active: boolean): string =>
  `rounded border px-2 py-1 text-xs ${
    active
      ? 'border-neutral-900 bg-surface-strong text-content-on-strong'
      : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100'
  }`

// Compact one-line representation of the per-job summary JSON. Full structured
// detail can wait until someone asks for a job-detail page.
const summarize = (value: JsonValue): string => {
  if (value === null) return ''
  if (Array.isArray(value)) return `[${String(value.length)} item${value.length === 1 ? '' : 's'}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')
      .map(([k, v]) => `${k}=${String(v)}`)
    return entries.join(' ')
  }
  return String(value)
}
