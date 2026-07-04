import type { SnapshotStore } from './types.js'

/**
 * localStorage 実装の SnapshotStore (standalone 用の既定実装)
 *
 * ブラウザ環境専用。dedicated (lambda 等の常駐プロセス) には localStorage が
 * 存在しないため、そうした環境では別の SnapshotStore 実装を注入すること。
 * 失敗 (容量超過・プライベートモード等) は握りつぶして console へ流す
 * (移植元 libs/local-storage.ts 踏襲。standalone 永続化は best effort)
 */
export const localStorageSnapshotStore = (): SnapshotStore => ({
  saveSnapshot(key, payload) {
    try {
      localStorage.setItem(key, payload)
    } catch (e) {
      console.error(e)
    }
  },

  loadSnapshot(key) {
    try {
      return localStorage.getItem(key)
    } catch (e) {
      console.error(e)
      return null
    }
  },
})
