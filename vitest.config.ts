import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const srcUrl = fileURLToPath(new URL('./src', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '#': srcUrl,
      '@': srcUrl,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
  },
})
