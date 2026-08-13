import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * The demo reads src directly before publishing (API changes appear without a dist build).
 * This alias keeps the same imports as consumers (`from 'synqux'`).
 */
export default defineConfig({
  resolve: {
    alias: {
      'synqux/firebase': fileURLToPath(
        new URL('../src/firebase/index.ts', import.meta.url),
      ),
      synqux: fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    },
  },
})
