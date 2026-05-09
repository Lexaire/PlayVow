import { useEffect, useState } from 'react'

const localDateFormat = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
})

const localDateTimeFormat = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
})

const utcDateFormat = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  timeZone: 'UTC',
})

const utcDateTimeFormat = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
})

// SSR renders the UTC fallback (deterministic across server runtimes), then a
// post-mount effect swaps in the browser's local-timezone formatting. This
// avoids the SSR/client TZ mismatch that produced different times on the VPS
// (UTC) vs. dev machines.
export function LocalDate({ date }: { readonly date: Date }) {
  const [text, setText] = useState(() => utcDateFormat.format(date))
  const [title, setTitle] = useState(() => utcDateTimeFormat.format(date))
  useEffect(() => {
    setText(localDateFormat.format(date))
    setTitle(localDateTimeFormat.format(date))
  }, [date])
  return (
    <time dateTime={date.toISOString()} title={title}>
      {text}
    </time>
  )
}

export function LocalDateTime({ date }: { readonly date: Date }) {
  const [text, setText] = useState(() => utcDateTimeFormat.format(date))
  useEffect(() => {
    setText(localDateTimeFormat.format(date))
  }, [date])
  return <time dateTime={date.toISOString()}>{text}</time>
}
