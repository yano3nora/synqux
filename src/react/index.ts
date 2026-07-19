import type { Action } from '@reduxjs/toolkit'
import { createContext, createElement, useContext, type ReactNode } from 'react'
import { shallowEqual, useSelector } from 'react-redux'
import type { Synqux } from '../core/create-synqux.js'
import {
  selectIsHost,
  selectIsSyncStalled,
  selectIsSyncUnrecoverable,
  selectPeers,
  selectSelfId,
  selectSyncHealth,
} from '../core/selectors.js'
import type { SynquxHealth, SynquxState } from '../core/slice.js'
import type {
  Peer,
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

/** 自端末が host か。standalone (enabled=false) 時は常に true */
export const useIsHost = (): boolean =>
  useSelector((state) => selectIsHost(state as WithSynqux))

/** 同期グループの接続端末一覧 (読み取り専用) */
export const usePeers = (): Peer[] =>
  useSelector((state) => selectPeers(state as WithSynqux), shallowEqual)

export const useSelfId = (): Peer['id'] | null =>
  useSelector((state) => selectSelfId(state as WithSynqux))

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
