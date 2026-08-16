import { useEffect, useRef } from 'react'
import { shallowEqual, useSelector, useStore } from 'react-redux'
import type { Synqux, SynquxSubscribeOptions } from '../core/create-synqux.js'
import {
  selectIsHost,
  selectIsLive,
  selectIsSyncStalled,
  selectIsSyncUnrecoverable,
  selectPeers,
  selectSelf,
  selectSelfId,
  selectSelfRole,
  selectSyncHealth,
  selectSyncPhase,
} from '../core/selectors.js'
import type { SynquxHealth, SynquxPhase, SynquxState } from '../core/slice.js'
import type { Peer, PeerRole } from '../core/types.js'

/**
 * synqux/react — ゲーム開発者層の購読開始と読み取り hooks (ADR-0001 Decision 7)
 *
 * Provider は不要 (ADR-0022 で廃止)。購読開始は useSynquxSubscription、読み取りは
 * selector hooks を使う。result は consumer 自身の synced state から typed selector で
 * 直読みする (`isResultForPeer` + `selectSelfId` の組み合わせ。SPEC-0002 参照)。
 * requests / prev / revisions の語彙はここには一切出てこない
 */

type WithSynqux = { synqux: SynquxState }

/** 自端末が host か。standalone 時は常に true */
export const useIsHost = (): boolean =>
  useSelector((state) => selectIsHost(state as WithSynqux))

/** 同期グループの接続端末一覧 (読み取り専用) */
export const usePeers = (): Peer[] =>
  useSelector((state) => selectPeers(state as WithSynqux), shallowEqual)

export const useSelfId = (): Peer['id'] | null =>
  useSelector((state) => selectSelfId(state as WithSynqux))

/** 自端末の Peer。presence 反映前は null */
export const useSelf = (): Peer | null =>
  useSelector((state) => selectSelf(state as WithSynqux), shallowEqual)

/** 自端末の role。role 未指定は 'player' に正規化する */
export const useSelfRole = (): PeerRole | null =>
  useSelector((state) => selectSelfRole(state as WithSynqux))

export const useSyncPhase = (): SynquxPhase =>
  useSelector((state) => selectSyncPhase(state as WithSynqux))

export const useIsLive = (): boolean =>
  useSelector((state) => selectIsLive(state as WithSynqux))

/** response 欠落などによる同期停止の検知状態 */
export const useSyncHealth = (): SynquxHealth =>
  useSelector((state) => selectSyncHealth(state as WithSynqux), shallowEqual)

/** 同期停止を検知済みか。standalone / runtime off 時は常に false */
export const useIsSyncStalled = (): boolean =>
  useSelector((state) => selectIsSyncStalled(state as WithSynqux))

/** 自動回復を 1 巡しても同期停止が解消せず、リロード案内が必要か */
export const useIsSyncUnrecoverable = (): boolean =>
  useSelector((state) => selectIsSyncUnrecoverable(state as WithSynqux))

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

  return useSyncPhase()
}
