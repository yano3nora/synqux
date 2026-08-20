import { afterEach, beforeEach, vi } from 'vitest'
import type { MockInstance } from 'vitest'

// memory-hub の faults.* が意図的に投げる注入エラーは、core が console.error で
// 記録して処理継続する設計のため、テスト出力では想定内ノイズとして黙殺する。
// それ以外の console.error は「想定外のエラーログ」としてテストを失敗させ、
// 本物の regression ログが注入ノイズに埋もれるのを防ぐ (全テストファイルへ自動適用)。
// テスト側が vi.spyOn(console, 'error') し直した場合は同一 spy が返り、
// mockImplementation の差し替えでこの検査を明示的に opt-out できる
const EXPECTED_ERROR_PATTERN =
  /Injected (?:respondRequest failure|respondRequest ack loss|saveSnapshot failure|subscription cancellation)/

const formatArg = (arg: unknown): string =>
  arg instanceof Error ? (arg.stack ?? arg.message) : String(arg)

let errorSpy: MockInstance | undefined
let unexpected: string[] = []

beforeEach(() => {
  unexpected = []
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const text = args.map(formatArg).join(' ')
    if (!EXPECTED_ERROR_PATTERN.test(text)) {
      unexpected.push(text)
    }
  })
})

afterEach(() => {
  errorSpy?.mockRestore()
  errorSpy = undefined
  if (unexpected.length > 0) {
    const captured = unexpected.join('\n---\n')
    unexpected = []
    throw new Error(`Unexpected console.error during test:\n${captured}`)
  }
})
