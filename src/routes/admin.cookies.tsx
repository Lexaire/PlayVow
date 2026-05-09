import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'

import { AdminTabs } from '#/components/admin/AdminTabs'
import {
  HEALTH_HINT,
  HEALTH_LABEL,
  HEALTH_PILL,
  TEST_RESULT_PILL,
  cookieHealth,
  formatRelativeTime,
  formatSetCookieError,
  formatTestResult,
} from '#/components/admin/cookie-ui'
import type { GroupCookieStatus } from '#/repos/groupSecrets'
import {
  clearGroupCookieFn,
  listGroupCookieStatusFn,
  setGroupCookieFn,
  testGroupCookieFn,
} from '#/server/cookieAdminFns'

export const Route = createFileRoute('/admin/cookies')({
  loader: async () => listGroupCookieStatusFn(),
  component: AdminCookiesPage,
})

type TestResultMsg = {
  readonly groupId: number
  readonly tone: 'ok' | 'warn' | 'err'
  readonly text: string
}

function AdminCookiesPage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const setCookie = useServerFn(setGroupCookieFn)
  const clearCookie = useServerFn(clearGroupCookieFn)
  const testCookie = useServerFn(testGroupCookieFn)

  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [pendingId, setPendingId] = useState<number | null>(null)
  const [testMsg, setTestMsg] = useState<TestResultMsg | null>(null)
  const [errMsg, setErrMsg] = useState<string | null>(null)

  const onSave = async (groupId: number) => {
    if (draft.trim().length < 10) {
      setErrMsg('Cookie looks too short — paste the full Cookie header value.')
      return
    }
    setPendingId(groupId)
    setErrMsg(null)
    try {
      const r = await setCookie({ data: { groupId, cookie: draft } })
      if (!r.ok) {
        setErrMsg(formatSetCookieError(r.error.kind))
        return
      }
      setEditingId(null)
      setDraft('')
      await router.invalidate()
    } finally {
      setPendingId(null)
    }
  }

  const onClear = async (groupId: number) => {
    if (
      !confirm(
        'Clear the SteamGifts cookie for this group? Scrapes for this group will be skipped until a new cookie is set.',
      )
    ) {
      return
    }
    setPendingId(groupId)
    setErrMsg(null)
    try {
      const r = await clearCookie({ data: { groupId } })
      if (!r.ok) {
        setErrMsg(formatSetCookieError(r.error.kind))
        return
      }
      await router.invalidate()
    } finally {
      setPendingId(null)
    }
  }

  const onTest = async (groupId: number) => {
    setPendingId(groupId)
    setTestMsg(null)
    setErrMsg(null)
    try {
      const r = await testCookie({ data: { groupId } })
      if (!r.ok) {
        setErrMsg(formatSetCookieError(r.error.kind))
        return
      }
      setTestMsg({
        groupId,
        tone: r.value.result === 'ok' ? 'ok' : r.value.result === 'login_required' ? 'err' : 'warn',
        text: formatTestResult(r.value.result, r.value.httpStatus ?? null),
      })
      await router.invalidate()
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <AdminTabs active="cookies" />
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">SteamGifts cookies</h1>
        <p className="text-sm text-neutral-600">
          PlayVow checks each group's SteamGifts page once a day to find new giveaways and record
          who won them. Most of what we read is public — listings, profiles, and the winners of 1-
          and 2-copy giveaways all come through without a cookie. A cookie is only needed for one
          thing: confirming the full winner list on group giveaways with 3 or more copies.
        </p>
        <p className="text-sm text-neutral-600">
          So a missing or expired cookie isn't an outage — daily scrapes still flow, you just lose
          the multi-copy reconciliation. Those giveaways stay marked unsettled and get re-checked on
          every scrape until a working cookie shows up here. Replace the cookie whenever a row's
          status flips to <strong>Failing</strong>.
        </p>
      </header>

      <details className="rounded border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700 open:bg-neutral-50">
        <summary className="cursor-pointer font-medium text-neutral-900">
          How do I get a SteamGifts cookie?
        </summary>
        <ol className="mt-3 list-decimal space-y-2 pl-5">
          <li>
            Open{' '}
            <a
              href="https://www.steamgifts.com/"
              target="_blank"
              rel="noreferrer noopener"
              className="text-blue-700 hover:underline"
            >
              steamgifts.com
            </a>{' '}
            in a new tab and sign in with the Steam account that has access to this group.
          </li>
          <li>
            Open your browser's developer tools:
            <ul className="mt-1 list-disc pl-5 text-neutral-600">
              <li>
                Chrome / Edge: press{' '}
                <kbd className="rounded border border-neutral-300 bg-white px-1 text-xs">F12</kbd>,
                then click the <em>Application</em> tab
              </li>
              <li>
                Firefox: press{' '}
                <kbd className="rounded border border-neutral-300 bg-white px-1 text-xs">F12</kbd>,
                then click the <em>Storage</em> tab
              </li>
              <li>
                Safari: enable the Develop menu in Settings → Advanced, then Develop → Show Web
                Inspector → <em>Storage</em> tab
              </li>
            </ul>
          </li>
          <li>
            In the left sidebar, expand <strong>Cookies</strong> and click{' '}
            <code className="rounded bg-white px-1 font-mono text-xs">
              https://www.steamgifts.com
            </code>
            .
          </li>
          <li>
            Find the row named{' '}
            <code className="rounded bg-white px-1 font-mono text-xs">PHPSESSID</code> and copy its{' '}
            <em>Value</em>.
          </li>
          <li>
            Back here, click <strong>Set</strong> (or <strong>Replace</strong>) for the group, paste
            the value with the prefix{' '}
            <code className="rounded bg-white px-1 font-mono text-xs">PHPSESSID=</code> in front,
            and Save. The whole field should look like{' '}
            <code className="rounded bg-white px-1 font-mono text-xs">PHPSESSID=abcd1234…</code>.
          </li>
        </ol>
        <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
          <strong>Always click Test after saving.</strong> Test confirms SteamGifts accepted the
          cookie. If it shows a red error like "the cookie probably expired," sign back in to
          SteamGifts and copy a fresh PHPSESSID — the old one stops working when you sign out, clear
          cookies, or after long inactivity.
        </p>
        <p className="mt-3 text-neutral-600">
          The cookie acts like a password for the bot's SteamGifts session, so don't paste it into
          chat messages or share it with anyone. Once saved here it's encrypted and can never be
          read back — only replaced.
        </p>
      </details>

      {errMsg ? (
        <p className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {errMsg}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded border border-neutral-200 bg-surface">
        <table className="min-w-full divide-y divide-neutral-200 text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-semibold uppercase text-neutral-600">
            <tr>
              <th className="px-3 py-2">Group</th>
              <th className="px-3 py-2">Health</th>
              <th className="px-3 py-2">Updated</th>
              <th className="px-3 py-2">Last test</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {data.map((row) => (
              <CookieRow
                key={row.groupId}
                row={row}
                editing={editingId === row.groupId}
                pending={pendingId === row.groupId}
                draft={editingId === row.groupId ? draft : ''}
                testMsg={testMsg && testMsg.groupId === row.groupId ? testMsg : null}
                onStartEdit={() => {
                  setEditingId(row.groupId)
                  setDraft('')
                  setErrMsg(null)
                  setTestMsg(null)
                }}
                onCancelEdit={() => {
                  setEditingId(null)
                  setDraft('')
                }}
                onDraftChange={setDraft}
                onSave={() => void onSave(row.groupId)}
                onClear={() => void onClear(row.groupId)}
                onTest={() => void onTest(row.groupId)}
              />
            ))}
            {data.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-neutral-500">
                  No groups yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CookieRow({
  row,
  editing,
  pending,
  draft,
  testMsg,
  onStartEdit,
  onCancelEdit,
  onDraftChange,
  onSave,
  onClear,
  onTest,
}: {
  readonly row: GroupCookieStatus
  readonly editing: boolean
  readonly pending: boolean
  readonly draft: string
  readonly testMsg: TestResultMsg | null
  readonly onStartEdit: () => void
  readonly onCancelEdit: () => void
  readonly onDraftChange: (s: string) => void
  readonly onSave: () => void
  readonly onClear: () => void
  readonly onTest: () => void
}) {
  return (
    <>
      <tr>
        <td className="px-3 py-2">
          <Link
            to="/g/$slug"
            params={{ slug: row.groupSlug }}
            className="text-blue-700 hover:underline"
          >
            {row.groupName}
          </Link>
        </td>
        <td className="px-3 py-2">
          {(() => {
            const health = cookieHealth(row)
            return (
              <span
                title={HEALTH_HINT[health]}
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${HEALTH_PILL[health]}`}
              >
                {HEALTH_LABEL[health]}
              </span>
            )
          })()}
        </td>
        <td className="px-3 py-2 text-neutral-600">
          {row.updatedAt ? (
            <>
              {formatRelativeTime(row.updatedAt)}
              {row.updatedBy?.steamgiftsUsername ? (
                <>
                  {' '}
                  by <span className="font-mono">{row.updatedBy.steamgiftsUsername}</span>
                </>
              ) : null}
            </>
          ) : (
            '—'
          )}
        </td>
        <td className="px-3 py-2">
          {row.lastTestResult && row.lastTestedAt ? (
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TEST_RESULT_PILL[row.lastTestResult]}`}
            >
              {row.lastTestResult} · {formatRelativeTime(row.lastTestedAt)}
            </span>
          ) : (
            <span className="text-xs text-neutral-400">never tested</span>
          )}
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              disabled={pending}
              onClick={onStartEdit}
              className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
            >
              {row.isSet ? 'Replace' : 'Set'}
            </button>
            <button
              type="button"
              disabled={pending || !row.isSet}
              onClick={onTest}
              className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
            >
              Test
            </button>
            <button
              type="button"
              disabled={pending || !row.isSet}
              onClick={onClear}
              className="rounded border border-rose-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </td>
      </tr>
      {editing ? (
        <tr>
          <td colSpan={5} className="bg-neutral-50 px-3 py-3">
            <div className="space-y-2">
              <label className="block text-xs font-medium text-neutral-600">
                Paste cookie header value (`name=value; ...`)
              </label>
              <input
                type="text"
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded border border-neutral-300 px-3 py-1.5 font-mono text-sm"
                placeholder="PHPSESSID=..."
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={onSave}
                  className="rounded bg-surface-strong px-3 py-1 text-xs font-medium text-content-on-strong disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={onCancelEdit}
                  className="rounded border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
              <p className="text-xs text-neutral-500">
                After saving, the value is encrypted and never displayed again. Use Test to confirm
                it works.
              </p>
            </div>
          </td>
        </tr>
      ) : null}
      {testMsg ? (
        <tr>
          <td colSpan={5} className="px-3 pb-3">
            <p
              className={
                testMsg.tone === 'ok'
                  ? 'rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
                  : testMsg.tone === 'err'
                    ? 'rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800'
                    : 'rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800'
              }
            >
              {testMsg.text}
            </p>
          </td>
        </tr>
      ) : null}
    </>
  )
}
