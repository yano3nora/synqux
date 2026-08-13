import type { Action } from '@reduxjs/toolkit'
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react'
import { shallowEqual, useSelector, useStore } from 'react-redux'
import type { Synqux, SynquxSubscribeOptions } from '../core/create-synqux.js'
import { isResultForPeer } from '../core/results.js'
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
import type {
  Peer,
  PeerRole,
  Result,
  ResultMessage,
  SynquxSynced,
} from '../core/types.js'

/**
 * synqux/react — ゲーム開発者層の読み取り hooks (ADR-0001 Decision 7)
 *
 * setup 層が redux の Provider と並べて SynquxProvider を配線し、
 * ゲーム開発者は hooks だけを使う。requests / prev / revisions の語彙は
 * ここには一切出てこない
 */

type WithSynqux = { synqux: SynquxState }

// instance の synced 位置解決だけを Provider で運ぶ。
// (root: never) => は「どんな TRoot の Synqux でも代入できる」ための逆変位置の型
type SynquxContextValue = {
  selectSynced: (root: never) => SynquxSynced
}

const SynquxContext = createContext<SynquxContextValue | null>(null)

export const SynquxProvider = (props: {
  /**
   * createSynqux の返り値。TRoot の具体型はここでは不要なため、逆変位置の
   * 構造型で受けて「どの TRoot の Synqux でもそのまま渡せる」ようにしている
   */
  sync: Pick<Synqux<never>, 'selectSynced'>
  children: ReactNode
}): ReactNode =>
  createElement(
    SynquxContext.Provider,
    { value: { selectSynced: props.sync.selectSynced } },
    props.children,
  )

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
 * 直近の判定結果 (reducer が積んだ result) を読む
 * 通知 UI (toast 等) は consumer 側の責務で、重複表示の判定には
 * result.action.meta.hash を使う
 */
export const useLatestResult = <
  TAction extends Action = Action,
  TMessage extends ResultMessage = ResultMessage,
>(): Result<TAction, TMessage> | null => {
  const context = useContext(SynquxContext)

  if (!context) {
    throw new Error('useLatestResult must be used within <SynquxProvider>')
  }

  return useSelector(
    (state) => context.selectSynced(state as never).result,
  ) as Result<TAction, TMessage> | null
}

/** 直近 result が standalone / 全員宛てまたは自端末宛ての場合だけ返す */
export const useMyLatestResult = <
  TAction extends Action = Action,
  TMessage extends ResultMessage = ResultMessage,
>(): Result<TAction, TMessage> | null => {
  const context = useContext(SynquxContext)

  if (!context) {
    throw new Error('useMyLatestResult must be used within <SynquxProvider>')
  }

  return useSelector((state) => {
    const root = state as WithSynqux
    const result = context.selectSynced(state as never).result
    return isResultForPeer(result, selectSelfId(root)) ? result : null
  }) as Result<TAction, TMessage> | null
}

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
