if (typeof window !== 'undefined') {
  throw new Error(
    'This module is server-only and must not be imported on the client. ' +
      'Move the import behind a server function (createServerFn) or a route loader.',
  )
}
