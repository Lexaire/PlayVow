import { useEffect } from 'react'

import type { CurrentUserInfo } from '#/server/modFns'
import { identifyPostHogUser, initPostHogClient } from '#/lib/posthog-client'

initPostHogClient()

type PostHogTrackerProps = {
  readonly currentUser: CurrentUserInfo | null
}

export function PostHogTracker({ currentUser }: PostHogTrackerProps): null {
  useEffect(() => {
    identifyPostHogUser(currentUser)
  }, [currentUser])

  return null
}
