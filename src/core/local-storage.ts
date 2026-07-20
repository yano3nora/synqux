import type { SnapshotFence, SnapshotStore } from './types.js'

type StoredSnapshot = { fence: SnapshotFence; payload: string }

const isStoredSnapshot = (value: unknown): value is StoredSnapshot => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<StoredSnapshot>
  return (
    typeof candidate.payload === 'string' &&
    typeof candidate.fence?.epoch === 'number' &&
    typeof candidate.fence.appliedSeq === 'number'
  )
}

const acceptsFence = (stored: SnapshotFence, next: SnapshotFence): boolean =>
  next.epoch > stored.epoch ||
  (next.epoch === stored.epoch && next.appliedSeq >= stored.appliedSeq)

/**
 * localStorage 実装の SnapshotStore (standalone 用の既定実装)
 *
 * ブラウザ環境専用。dedicated (lambda 等の常駐プロセス) には localStorage が
 * 存在しないため、そうした環境では別の SnapshotStore 実装を注入すること。
 * 失敗 (容量超過・プライベートモード等) は握りつぶして console へ流す
 * (移植元 libs/local-storage.ts 踏襲。standalone 永続化は best effort)
 */
export const localStorageSnapshotStore = (): SnapshotStore => ({
  saveSnapshot(key, payload, fence) {
    try {
      const raw = localStorage.getItem(key)
      const parsed: unknown = raw === null ? null : JSON.parse(raw)

      if (isStoredSnapshot(parsed) && !acceptsFence(parsed.fence, fence)) {
        return false
      }

      // localStorage に CAS はないため比較→書き込みは best effort。複数タブが
      // 同時に書く場合の TOCTOU race は残る (standalone 永続化の制約)。
      localStorage.setItem(key, JSON.stringify({ fence, payload }))
      return true
    } catch (e) {
      console.error(e)
      return false
    }
  },

  loadSnapshot(key) {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) {
        return null
      }

      const parsed: unknown = JSON.parse(raw)
      return isStoredSnapshot(parsed) ? parsed.payload : null
    } catch (e) {
      console.error(e)
      return null
    }
  },
})
