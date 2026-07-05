import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * demo は publish 前の src を直接読む (dist ビルド不要で API 変更が即反映される)
 * consumer と同じ import 文 (`from 'synqux'`) を保つための alias
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
