export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Readonly<Record<string, unknown>>

type LogFn = (msg: string, fields?: LogFields) => void

export type Logger = {
  readonly debug: LogFn
  readonly info: LogFn
  readonly warn: LogFn
  readonly error: LogFn
  readonly child: (bindings: LogFields) => Logger
}

export type LoggerConfig = {
  readonly bindings?: LogFields
  readonly write?: (line: string) => void
  readonly now?: () => Date
  // Threshold below which log calls are dropped. Defaults to LOG_LEVEL env var
  // if set, otherwise 'info'. Set LOG_LEVEL=debug to enable debug locally.
  readonly level?: LogLevel
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const parseLevel = (raw: string | undefined): LogLevel | null => {
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  return null
}

const resolveLevel = (cfg: LoggerConfig): LogLevel =>
  cfg.level ?? parseLevel(process.env.LOG_LEVEL) ?? 'info'

const formatLine = (
  level: LogLevel,
  msg: string,
  bindings: LogFields,
  fields: LogFields | undefined,
  now: () => Date,
): string =>
  JSON.stringify({
    ts: now().toISOString(),
    level,
    msg,
    ...bindings,
    ...fields,
  })

const defaultWrite = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

export const createLogger = (cfg: LoggerConfig = {}): Logger => {
  const bindings = cfg.bindings ?? {}
  const write = cfg.write ?? defaultWrite
  const now = cfg.now ?? (() => new Date())
  const level = resolveLevel(cfg)
  const threshold = LEVEL_RANK[level]
  const log = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_RANK[lvl] < threshold) return
    write(formatLine(lvl, msg, bindings, fields, now))
  }
  return {
    debug: (msg, fields) => {
      log('debug', msg, fields)
    },
    info: (msg, fields) => {
      log('info', msg, fields)
    },
    warn: (msg, fields) => {
      log('warn', msg, fields)
    },
    error: (msg, fields) => {
      log('error', msg, fields)
    },
    child: (extra) =>
      createLogger({
        bindings: { ...bindings, ...extra },
        write,
        now,
        level,
      }),
  }
}
