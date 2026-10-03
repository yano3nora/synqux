/**
 * snapshot 保存の間引き (ADR-0030)
 *
 * 先頭の schedule は即時実行し、window 内の後続は最後の run だけを保持して
 * window 終了時に実行する (leading + trailing)。連続して呼ばれ続けても
 * waitMs ごとに最新の run で 1 回ずつ実行される。immediate は保留を破棄して
 * 即時実行し、window を張り直す。
 *
 * run は「保存 + 後処理 (watermark / prune)」の閉包を想定する。保留分が
 * 捨てられても失われるのは古い state だけで、最新の state は必ず実行される。
 * timer は instance 寿命で、session 跨ぎの無効化は run 側の session 検査が担う
 */
export type SnapshotThrottle = {
  /** 戻り値は即時実行した run の完了。保留した場合は即 resolve する */
  schedule(
    run: () => Promise<void>,
    options?: { immediate?: boolean },
  ): Promise<void>
  /**
   * 保留中の run を今すぐ開始する (teardown 用)。timer は解除する。
   * 完了は待たない (実行中の run も追跡しない) — transport 障害で永遠に
   * settle しない保存を teardown が待たないため。run は最初の await (transport
   * への書き込み呼び出し) まで同期的に進むので、flush の戻り時点で transport へ
   * 書き込みを依頼済みになる (その先の送信は transport の責務)
   */
  flush(): void
}

export const createSnapshotThrottle = (waitMs: number): SnapshotThrottle => {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: (() => Promise<void>) | null = null

  const runPending = (): Promise<void> => {
    const run = pending
    pending = null
    return run ? run() : Promise.resolve()
  }

  const onWindowEnd = (): void => {
    timer = null
    if (pending === null) {
      return
    }
    // trailing 実行後も window を張り直し、連続時は waitMs ごとに 1 回に保つ
    timer = setTimeout(onWindowEnd, waitMs)
    void runPending()
  }

  return {
    schedule(run, options) {
      if (waitMs <= 0) {
        return run()
      }

      if (timer !== null && !options?.immediate) {
        pending = run
        return Promise.resolve()
      }

      if (timer !== null) {
        clearTimeout(timer)
      }
      pending = null
      timer = setTimeout(onWindowEnd, waitMs)
      return run()
    },

    flush() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      void runPending()
    },
  }
}
