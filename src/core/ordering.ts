import type { RequestEnvelope } from './types.js'

/**
 * 順序判定モジュール (ADR-0001 Decision 10 の保険 1)
 *
 * 「遅延か・次に適用すべきか・適用済みか」の判定と処理済みリストの管理を
 * ここへ隔離する。Phase 3 で push id 比較 → host 採番 seq に置き換えるときは
 * このモジュールごと差し替え、呼び出し側 (ステートマシン) には手を入れない。
 *
 * 移植元の対応物: `constants/requests.ts` の REVISIONS / REQUESTS /
 * isDelayedRequestId (モジュール変数だったものをインスタンス内部状態へ移した)
 */
export type Ordering = {
  /** restore した snapshot の revisions から処理済みリストを復元する */
  seed(revisions: RequestEnvelope['id'][]): void

  /** 自端末で適用 (または破棄確定) 済みか */
  isApplied(id: RequestEnvelope['id']): boolean

  /**
   * 先行 request が未適用で、処理を待機させるべきか
   * prev が無い (チェーン先頭) 場合は待機不要
   */
  shouldWaitFor(prev: RequestEnvelope['prev']): boolean

  /**
   * 処理済み末尾より辞書順で古い id を「遅延 request」として意図的に落とす判定
   *
   * 順序保証を優先し、復帰不能な順序破壊よりも「操作 1 回の取りこぼし」を
   * 軽症とみなす設計上の割り切り (SPEC-requests-sync.md)。push id は端末時計に
   * 依存するため、時計がズレた端末の正当な request も落とし得る (既知の問題②、
   * 根治は Phase 3 の host 採番 seq)
   */
  isDelayed(id: RequestEnvelope['id']): boolean

  /**
   * 適用完了を記録する
   * NOTE 重複記録の防止は呼び出し側の責務 (既知の問題①は呼び出し側 =
   * requestListener の評価タイミング修正で対策済み)。ここで dedup しないのは
   * 「記録された列がそのまま適用履歴」という ground truth 性を守るため
   */
  markApplied(id: RequestEnvelope['id']): void

  /**
   * 同期的な処理中ガード (既知の問題①′の対策)
   *
   * responseListener の「isApplied チェック → dispatch → await → markApplied」は
   * check-then-act のため、同一 request の changed が同時に二重配送されると両方の
   * fork がチェックを通過してしまう。dispatch 直前 (await を挟まず同期的) に
   * これを立てることで 2 本目の fork を弾く。markApplied 後は不要になるため
   * 必ず解放する — 失敗時も解放することで、再配送での retry 余地を残す
   *
   * 注意: prev 待機 loop の途中で立ててはいけない (待機中に fork が死ぬと
   * 誰もその request を処理できなくなる)。立てるのは dispatch 直前のみ
   */
  isProcessing(id: RequestEnvelope['id']): boolean
  beginProcessing(id: RequestEnvelope['id']): void
  endProcessing(id: RequestEnvelope['id']): void

  /**
   * transport の added 重複配送ガード (移植元 REQUESTS 相当)
   * 初出の prevKey なら記録して true (処理してよい)、既出なら false (破棄)
   *
   * NOTE id ではなく「infra 観測順の prevKey」で重複判定する移植元仕様。
   * 遅延ののち重複した added は prevKey が既出になることを利用しており、
   * 素直な id 判定にしないのは「同一 request でも prev が付け直されて再配送
   * される (restore) ケースを弾かないため」
   */
  acceptAdded(prevKey: RequestEnvelope['id'] | null): boolean

  /** snapshot 封筒へ永続化する状態。「実際に適用された順序」の ground truth */
  revisions(): RequestEnvelope['id'][]

  lastRevision(): RequestEnvelope['id'] | undefined
}

export const createOrdering = (): Ordering => {
  const applied: RequestEnvelope['id'][] = []
  const seenPrevKeys = new Set<RequestEnvelope['id'] | null>()
  const processing = new Set<RequestEnvelope['id']>()

  return {
    seed(revisions) {
      applied.push(...revisions)
    },

    isApplied(id) {
      return applied.includes(id)
    },

    shouldWaitFor(prev) {
      return !!prev && !applied.includes(prev)
    },

    isDelayed(id) {
      const last = applied.at(-1)

      if (!last) {
        return false
      }

      return id < last
    },

    markApplied(id) {
      applied.push(id)
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

    acceptAdded(prevKey) {
      if (seenPrevKeys.has(prevKey)) {
        return false
      }

      seenPrevKeys.add(prevKey)
      return true
    },

    revisions() {
      return [...applied]
    },

    lastRevision() {
      return applied.at(-1)
    },
  }
}
