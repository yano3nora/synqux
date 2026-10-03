import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotThrottle } from './snapshot-throttle.js'

describe('createSnapshotThrottle (ADR-0030)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const runner = () => {
    const calls: string[] = []
    const run = (label: string) => async () => {
      calls.push(label)
    }
    return { calls, run }
  }

  it('waitMs 0 は間引かず毎回実行する', async () => {
    const { calls, run } = runner()
    const throttle = createSnapshotThrottle(0)

    await throttle.schedule(run('a'))
    await throttle.schedule(run('b'))

    expect(calls).toEqual(['a', 'b'])
  })

  it('先頭は即時、window 内の後続は最後の run だけを window 終了時に実行する', async () => {
    const { calls, run } = runner()
    const throttle = createSnapshotThrottle(1000)

    await throttle.schedule(run('a'))
    await throttle.schedule(run('b'))
    await throttle.schedule(run('c'))
    expect(calls).toEqual(['a'])

    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toEqual(['a'])

    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual(['a', 'c'])
  })

  it('呼ばれ続けても waitMs ごとに最新の run で 1 回ずつ実行する', async () => {
    const { calls, run } = runner()
    const throttle = createSnapshotThrottle(1000)

    for (let i = 0; i < 30; i += 1) {
      await throttle.schedule(run(String(i)))
      await vi.advanceTimersByTimeAsync(100)
    }

    // 0ms (0), 1000ms (9), 2000ms (19), 3000ms (29)
    expect(calls).toEqual(['0', '9', '19', '29'])

    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toEqual(['0', '9', '19', '29'])
  })

  it('immediate は保留を破棄して即時実行し window を張り直す', async () => {
    const { calls, run } = runner()
    const throttle = createSnapshotThrottle(1000)

    await throttle.schedule(run('a'))
    await throttle.schedule(run('b'))
    await vi.advanceTimersByTimeAsync(500)
    await throttle.schedule(run('c'), { immediate: true })
    expect(calls).toEqual(['a', 'c'])

    // 元の window 終了時点 (1000ms) では b を実行しない
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toEqual(['a', 'c'])

    // 張り直した window 内の後続は 1500ms に実行する
    await throttle.schedule(run('d'))
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toEqual(['a', 'c', 'd'])
  })

  it('flush は保留中の run を同期的に開始し timer を解除する', async () => {
    const { calls, run } = runner()
    const throttle = createSnapshotThrottle(1000)

    await throttle.schedule(run('a'))
    await throttle.schedule(run('b'))
    throttle.flush()
    expect(calls).toEqual(['a', 'b'])

    // 解除済みの window 終了で二重実行しない
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toEqual(['a', 'b'])

    // flush 後の schedule は再び先頭扱いで即時実行する
    await throttle.schedule(run('c'))
    expect(calls).toEqual(['a', 'b', 'c'])
  })

  it('保留がなければ flush は何もしない', async () => {
    const { calls, run } = runner()
    const throttle = createSnapshotThrottle(1000)

    await throttle.schedule(run('a'))
    throttle.flush()

    expect(calls).toEqual(['a'])
  })
})
