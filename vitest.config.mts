import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The Firestore rules suite is a separate command — it needs the emulator (Java)
    // and cannot run in-process. See `npm run test:rules`.
  },
})
