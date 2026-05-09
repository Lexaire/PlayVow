import { Link, createFileRoute } from '@tanstack/react-router'

import { AdminTabs } from '#/components/admin/AdminTabs'
import {
  HEALTH_HINT,
  HEALTH_LABEL,
  HEALTH_PILL,
  formatRelativeTime,
} from '#/components/admin/cookie-ui'
import type { CookieHealth } from '#/components/admin/cookie-ui'
import type { OverallStatus, ScrapeJobStatus, WorkerHealthStatus } from '#/lib/health-rollup'
import { getAdminHealthSummary } from '#/server/healthFns'
import type { ScrapeJobSummary } from '#/server/healthFns'

export const Route = createFileRoute('/admin/')({
  loader: () => getAdminHealthSummary(),
  component: AdminHealthPage,
})

const OVERALL_PILL: Readonly<Record<OverallStatus, string>> = {
  healthy: 'bg-emerald-100 text-emerald-800',
  degraded: 'bg-amber-100 text-amber-900',
  failing: 'bg-rose-100 text-rose-800',
  unknown: 'bg-neutral-200 text-neutral-700',
}

const WORKER_PILL: Readonly<Record<WorkerHealthStatus, string>> = {
  healthy: 'bg-emerald-100 text-emerald-800',
  stale: 'bg-amber-100 text-amber-900',
  unknown: 'bg-neutral-200 text-neutral-700',
}

const SCRAPE_PILL: Readonly<Record<ScrapeJobStatus, string>> = {
  healthy: 'bg-emerald-100 text-emerald-800',
  overdue: 'bg-amber-100 text-amber-900',
  failing: 'bg-rose-100 text-rose-800',
  never: 'bg-neutral-200 text-neutral-700',
}

const formatDurationMs = (ms: number | null): string => {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  return remSec === 0 ? `${min}m` : `${min}m ${remSec}s`
}

function AdminHealthPage() {
  const data = Route.useLoaderData()
  const now = data.now

  return (
    <div className="space-y-6">
      <AdminTabs active="health" />
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Health</h1>
          <p className="text-sm text-neutral-600">
            System overview — worker, cookies, and scrape freshness at a glance.
          </p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${OVERALL_PILL[data.overall]}`}
        >
          {data.overall}
        </span>
      </header>

      <div className="space-y-3">
        <WorkerSection status={data.worker.status} heartbeat={data.worker.heartbeat} now={now} />
        <CookiesSection cookies={data.cookies} />
        <ScrapesSection scrapes={data.scrapes} now={now} />
      </div>
    </div>
  )
}

function SectionCard({
  title,
  pill,
  pillClass,
  children,
}: {
  readonly title: string
  readonly pill: string
  readonly pillClass: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="rounded border border-neutral-200 bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${pillClass}`}
        >
          {pill}
        </span>
      </div>
      {children}
    </div>
  )
}

function WorkerSection({
  status,
  heartbeat,
  now,
}: {
  readonly status: WorkerHealthStatus
  readonly heartbeat: {
    readonly startedAt: Date
    readonly lastSeenAt: Date
    readonly pid: number
  } | null
  readonly now: Date
}) {
  return (
    <SectionCard title="Worker" pill={status} pillClass={WORKER_PILL[status]}>
      {heartbeat === null ? (
        <p className="mt-2 text-xs text-neutral-500">
          No heartbeat recorded yet. The worker may not have started since this feature shipped.
        </p>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-neutral-700 md:grid-cols-4">
          <dt className="text-neutral-500">Last seen</dt>
          <dd>{formatRelativeTime(heartbeat.lastSeenAt, now)}</dd>
          <dt className="text-neutral-500">Uptime</dt>
          <dd>{formatDurationMs(now.getTime() - heartbeat.startedAt.getTime())}</dd>
        </dl>
      )}
    </SectionCard>
  )
}

function CookiesSection({
  cookies,
}: {
  readonly cookies: {
    readonly status: CookieHealth
    readonly counts: {
      readonly working: number
      readonly anonymous: number
      readonly untested: number
      readonly failing: number
    }
    readonly total: number
  }
}) {
  const { status, counts, total } = cookies
  const parts: string[] = []
  if (counts.working > 0) parts.push(`${counts.working} working`)
  if (counts.anonymous > 0) parts.push(`${counts.anonymous} anonymous`)
  if (counts.untested > 0) parts.push(`${counts.untested} untested`)
  if (counts.failing > 0) parts.push(`${counts.failing} failing`)

  return (
    <SectionCard
      title={`Cookies (${total} group${total === 1 ? '' : 's'})`}
      pill={HEALTH_LABEL[status]}
      pillClass={HEALTH_PILL[status]}
    >
      <p className="mt-2 text-xs text-neutral-600">
        {parts.length > 0 ? parts.join(' · ') : 'No groups configured.'}
      </p>
      <p className="mt-1 text-xs text-neutral-500">{HEALTH_HINT[status]}</p>
      <Link
        to="/admin/cookies"
        className="mt-2 inline-block text-xs text-emerald-700 hover:underline"
      >
        Cookie details →
      </Link>
    </SectionCard>
  )
}

function ScrapesSection({
  scrapes,
  now,
}: {
  readonly scrapes: {
    readonly status: ScrapeJobStatus
    readonly perJob: ReadonlyArray<ScrapeJobSummary>
  }
  readonly now: Date
}) {
  return (
    <SectionCard title="Scrapes" pill={scrapes.status} pillClass={SCRAPE_PILL[scrapes.status]}>
      <div className="mt-3 divide-y divide-neutral-100">
        {scrapes.perJob.map((job) => (
          <ScrapeJobRow key={job.catalogue.name} job={job} now={now} />
        ))}
      </div>
      <Link to="/admin/jobs" className="mt-2 inline-block text-xs text-emerald-700 hover:underline">
        Run history →
      </Link>
    </SectionCard>
  )
}

function ScrapeJobRow({ job, now }: { readonly job: ScrapeJobSummary; readonly now: Date }) {
  return (
    <div className="flex items-center gap-3 py-1.5 text-xs">
      <span className="w-48 font-mono text-[11px] text-neutral-700 truncate">
        {job.catalogue.name}
      </span>
      <span className="flex-1 text-neutral-500">
        {job.lastSuccessAt ? formatRelativeTime(job.lastSuccessAt, now) : 'never'}
      </span>
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${SCRAPE_PILL[job.status]}`}
      >
        {job.status}
      </span>
    </div>
  )
}
