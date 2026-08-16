import { useEffect, useRef } from 'react'
import { useSelector, useStore } from 'react-redux'
import type { Synqux, SynquxSubscribeOptions } from '../core/create-synqux.js'
import { selectSyncPhase } from '../core/selectors.js'
import type { SynquxPhase, SynquxState } from '../core/slice.js'

/**
 * synqux/react — 購読開始 hook (ADR-0001 Decision 7 / ADR-0022 / ADR-0023)
 *
 * 読み取りは core selectors (`selectIsHost` / `selectPeers` / `selectSyncHealth`
 * 等) を consumer 自身の typed `useAppSelector` へ直接渡すのが canonical
 * (README / SPEC-0002)。薄い hook wrapper 群は `useAppSelector(selectIsHost)` に
 * 対する付加価値がなく ADR-0023 で廃止した。ここに残るのは「購読開始の排他と
 * lifecycle」という react 固有の関心のみ
 */

// 予約 key `state.synqux` を読む内部キャストはこのモジュールの 1 箇所に閉じる。
// consumer 側は自分の RootState で型が付くため、この widen は外へ漏れない
type WithSynqux = { synqux: SynquxState }

/**
 * react consumer の購読開始の canonical な入口。mount 時に一度だけ購読を開始し、
 * 進行 phase を返す。store は react-redux の useStore() から取得する。
 * 排他は state.synqux.phase で判定し、'idle' 以外なら何もしない — StrictMode /
 * 多重 mount の二重発火はこれで無害化される (subscribe 開始時の
 * phaseChanged('subscribing') は同期 dispatch のため、同一 commit 内でも安全)。
 * 失敗遷移は createSynqux の onSubscribeFailed で設定する
 */
export const useSynquxSubscription = <TRoot extends { synqux: SynquxState }>(
  sync: Pick<Synqux<TRoot>, 'subscribe'>,
  options: Omit<SynquxSubscribeOptions<TRoot>, 'store' | 'groupId'> & {
    /** 未確定 (undefined) の間は購読を開始しない */
    groupId?: string
  },
): SynquxPhase => {
  // react-redux の既定 RootState は unknown のため、公開型を widen せず subscribe
  // へ渡す比較点だけを consumer の TRoot store として扱う。
  const store = useStore() as SynquxSubscribeOptions<TRoot>['store']
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (
      options.groupId === undefined ||
      selectSyncPhase(store.getState()) !== 'idle'
    ) {
      return
    }

    const { groupId: _groupId, ...subscribeOptions } = optionsRef.current
    void sync
      .subscribe({
        ...subscribeOptions,
        store,
        groupId: options.groupId,
        signal: subscribeOptions.signal ?? AbortSignal.timeout(30_000),
      })
      .catch((error: unknown) => {
        // reject の未処理化だけを防ぐ。失敗政策は createSynqux config の
        // onSubscribeFailed が rollback 後に一元的に実行する。
        console.error(error)
      })
  }, [sync, options.groupId])

  return useSelector((state) => selectSyncPhase(state as WithSynqux))
}
