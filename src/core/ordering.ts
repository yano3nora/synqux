import type { RequestEnvelope } from './types.js'

/**
 * 順序判定モジュール — host 採番 seq 版 (ADR-0002)
 *
 * 「次に適用すべきか・適用済みか・裁定してよいか」の判定と順序状態の管理を
 * ここへ隔離する。ADR-0001 Decision 10 の保険どおり、push id 辞書順 + prev
 * チェーン (v1) からの差し替えはこのモジュールの置き換えで完結している。
 *
 * 状態は 3 つ:
 * - appliedSeq: ここまでの seq を適用済み (全端末の適用規則は「appliedSeq+1 を適用」)
 * - epoch: 自分が host として裁定するときの世代番号 (fencing)
 * - 直近適用窓 (seq → request id): restore 後に「過去の正史」と「dual-host の
 *   敗者 (再裁定待ち)」を区別するための有限記録
 */

/** snapshot 封筒へ載せる直近適用窓のサイズ。敗者救済が届く範囲でもある */
export const APPLIED_WINDOW_SIZE = 200

export type OrderingState = {
  epoch: number
  appliedSeq: number
  /** 直近 APPLIED_WINDOW_SIZE 件の { seq: requestId } */
  applied: Record<number, RequestEnvelope['id']>
}

export type Ordering = {
  /** restore した snapshot の順序状態から復元する */
  seed(state: OrderingState): void

  /** snapshot 封筒へ永続化する状態 */
  state(): OrderingState

  appliedSeq(): number

  /** この端末が観測した裁定済み envelope の最大 seq */
  maxSeenSeq(): number

  /** 受信 envelope の裁定印を報告する (epoch/seq の観測最大値の追跡) */
  observe(stamp: { epoch?: number; seq?: number }): void

  /**
   * host として裁定を始める。観測済み最大 epoch を跨ぐ世代番号を確定して返す
   * (すでに自 epoch が最大なら維持)。transport に原子カウンタは要求しない —
   * 衝突時の決定性は responsedBy tiebreak が担う (ADR-0002 Decision 2)
   */
  beginHosting(): number

  /**
   * 裁定の採番。直列裁定 (自分の発行済み seq が全て適用されてから次を発行) を
   * 前提とするため appliedSeq + 1 を返す。前提が破れていれば throw (バグ検出)
   */
  issueSeq(): number

  /** 自分の発行した seq が未適用のあいだ true (host は次の裁定を待つ) */
  hasPendingIssue(): boolean

  /**
   * 発行の取り消し (respondRequest が throw したときの復旧用)
   * 永続化に成功していた場合は同一 seq の二重発行 = 衝突になり得るが、
   * それは fencing の tiebreak が収束させる。発行済みが残って host が
   * 永久停止するより軽症、という判断
   */
  retractIssue(): void

  /** 「この request を適用した後」の snapshot 用順序状態 (ack await 前に評価固定する) */
  stateWith(seq: number, id: RequestEnvelope['id']): OrderingState

  /** この端末で適用済みの request か (セッション内メモリ + 復元した直近窓) */
  isApplied(id: RequestEnvelope['id']): boolean

  /** まだ適用できない (先行 seq が未適用の) 裁定か */
  shouldWait(seq: number): boolean

  /** 適用済み位置以前の seq か (正史 or dual-host 敗者。区別は isApplied で行う) */
  isStale(seq: number): boolean

  /**
   * 窓より古い stale か。ここまで古いと正史/敗者の区別記録がなく、
   * 敗者だとしても救済対象外として適用済み扱いで破棄する (ADR-0002 Decision 4)
   */
  isBeyondWindow(seq: number): boolean

  /** 適用完了の記録。appliedSeq を進め、直近窓へ id を積む */
  markApplied(seq: number, id: RequestEnvelope['id']): void

  /** transport の added 重複配送ガード (request id ベース) */
  acceptAdded(id: RequestEnvelope['id']): boolean

  /**
   * 同期的な処理中ガード (既知の問題①′の対策、v1 から継続)
   * dispatch 直前 (await を挟まず同期的) に立て、markApplied 後 finally で解放する。
   * prev/seq の待機 loop 内で立ててはいけない (fork が死ぬと誰も処理できなくなる)
   */
  isProcessing(id: RequestEnvelope['id']): boolean
  beginProcessing(id: RequestEnvelope['id']): void
  endProcessing(id: RequestEnvelope['id']): void
}

export const createOrdering = (): Ordering => {
  let appliedSeq = 0
  let myEpoch: number | null = null
  let maxSeenEpoch = 0
  let maxIssuedSeq = 0

  /** 直近適用窓。restore の seed でも埋まる */
  const appliedWindow = new Map<number, RequestEnvelope['id']>()
  /** セッション内で適用した (または窓で復元した) request id */
  const appliedIds = new Set<RequestEnvelope['id']>()
  const seenAddedIds = new Set<RequestEnvelope['id']>()
  const processing = new Set<RequestEnvelope['id']>()

  const trimWindow = (): void => {
    for (const seq of appliedWindow.keys()) {
      if (seq <= appliedSeq - APPLIED_WINDOW_SIZE) {
        const id = appliedWindow.get(seq)
        appliedWindow.delete(seq)
        // 窓から溢れた id は isApplied 判定からも外す (メモリの無限成長防止)。
        // 以後は isBeyondWindow が「適用済み扱いで破棄」を引き受ける
        if (id !== undefined) {
          appliedIds.delete(id)
        }
      }
    }
  }

  return {
    seed(state) {
      appliedSeq = state.appliedSeq
      maxSeenEpoch = Math.max(maxSeenEpoch, state.epoch)

      for (const [seq, id] of Object.entries(state.applied)) {
        appliedWindow.set(Number(seq), id)
        appliedIds.add(id)
      }
    },

    state() {
      const applied: Record<number, RequestEnvelope['id']> = {}
      for (const [seq, id] of appliedWindow) {
        applied[seq] = id
      }

      return { epoch: myEpoch ?? maxSeenEpoch, appliedSeq, applied }
    },

    appliedSeq() {
      return appliedSeq
    },

    maxSeenSeq() {
      return maxIssuedSeq
    },

    observe(stamp) {
      if (stamp.epoch !== undefined) {
        maxSeenEpoch = Math.max(maxSeenEpoch, stamp.epoch)
      }
      if (stamp.seq !== undefined) {
        maxIssuedSeq = Math.max(maxIssuedSeq, stamp.seq)
      }
    },

    beginHosting() {
      // 自分より新しい世代を観測していたら、その世代を跨いで自分の世代を進める。
      // 初回昇格・migration 直後・dual-host 窓からの復帰がすべてこの 1 行に畳まれる
      if (myEpoch === null || myEpoch <= maxSeenEpoch) {
        myEpoch = maxSeenEpoch + 1
      }

      return myEpoch
    },

    issueSeq() {
      if (maxIssuedSeq > appliedSeq) {
        // 直列裁定の前提: 発行済みが未適用のうちは次を発行しない (呼び出し側バグ)
        throw new Error(
          `issueSeq called with pending issue (applied=${String(appliedSeq)}, issued=${String(maxIssuedSeq)})`,
        )
      }

      maxIssuedSeq = appliedSeq + 1
      return maxIssuedSeq
    },

    hasPendingIssue() {
      return maxIssuedSeq > appliedSeq
    },

    retractIssue() {
      maxIssuedSeq = appliedSeq
    },

    stateWith(seq, id) {
      const applied: Record<number, RequestEnvelope['id']> = {}
      for (const [windowSeq, windowId] of appliedWindow) {
        if (windowSeq > seq - APPLIED_WINDOW_SIZE) {
          applied[windowSeq] = windowId
        }
      }
      applied[seq] = id

      return {
        epoch: myEpoch ?? maxSeenEpoch,
        appliedSeq: Math.max(appliedSeq, seq),
        applied,
      }
    },

    isApplied(id) {
      return appliedIds.has(id)
    },

    shouldWait(seq) {
      return seq > appliedSeq + 1
    },

    isStale(seq) {
      return seq <= appliedSeq
    },

    isBeyondWindow(seq) {
      return seq <= appliedSeq - APPLIED_WINDOW_SIZE
    },

    markApplied(seq, id) {
      appliedSeq = Math.max(appliedSeq, seq)
      appliedWindow.set(seq, id)
      appliedIds.add(id)
      trimWindow()
    },

    acceptAdded(id) {
      if (seenAddedIds.has(id)) {
        return false
      }

      seenAddedIds.add(id)
      return true
    },

    isProcessing(id) {
      return processing.has(id)
    },

    beginProcessing(id) {
      processing.add(id)
    },

    endProcessing(id) {
      processing.delete(id)
    },
  }
}
