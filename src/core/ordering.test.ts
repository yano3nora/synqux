import { describe, expect, it } from 'vitest'
import { APPLIED_WINDOW_SIZE, createOrdering } from './ordering.js'

/**
 * 順序判定モジュール (seq 版、ADR-0002) の unit test
 * v1 (push id 辞書順 + prev チェーン) の characterization は seq 化で役目を終え、
 * 本ファイルが v2 の判定仕様を固定する
 */
describe('createOrdering (ADR-0002)', () => {
  describe('適用規則 (shouldWait / isStale / markApplied)', () => {
    it('appliedSeq + 1 だけが適用可能で、先の seq は待機、過去の seq は stale', () => {
      const ordering = createOrdering()
      ordering.markApplied(1, 'req-1')

      expect(ordering.isStale(1)).toBe(true)
      expect(ordering.shouldWait(2)).toBe(false) // 次に適用すべき seq
      expect(ordering.shouldWait(3)).toBe(true) // 先行 seq 未適用
    })

    it('markApplied は appliedSeq を進め、id を適用済みとして記録する', () => {
      const ordering = createOrdering()
      ordering.markApplied(1, 'req-1')
      ordering.markApplied(2, 'req-2')

      expect(ordering.appliedSeq()).toBe(2)
      expect(ordering.isApplied('req-1')).toBe(true)
      expect(ordering.isApplied('req-x')).toBe(false)
    })

    it('【既知の問題②の根治】順序判定は request id (端末時計) を一切参照しない', () => {
      // v1 では処理済み末尾より辞書順で古い id を「遅延」として意図的に
      // ドロップしていた (isDelayedRequestId)。v2 に同種の判定は存在せず、
      // どんな id の request も host が採番した seq で普通に適用される
      const ordering = createOrdering()
      ordering.markApplied(1, '-Zzz-newest-id')

      // 辞書順で古い id が次の seq を持って届いても、判定は seq のみで決まる
      expect(ordering.shouldWait(2)).toBe(false)
      ordering.markApplied(2, '-Aaa-older-id')
      expect(ordering.isApplied('-Aaa-older-id')).toBe(true)
    })
  })

  describe('採番 (beginHosting / issueSeq)', () => {
    it('初回昇格は epoch 1、以後は観測済み最大 epoch を跨いで進む', () => {
      const ordering = createOrdering()
      expect(ordering.beginHosting()).toBe(1)
      expect(ordering.beginHosting()).toBe(1) // 継続 host は世代を維持

      // 他 host の裁定 (より新しい世代) を観測したら、次の昇格で跨ぐ
      ordering.observe({ epoch: 3, seq: 10 })
      expect(ordering.beginHosting()).toBe(4)
    })

    it('observe は観測済み最大 seq を追跡する', () => {
      const ordering = createOrdering()
      ordering.observe({ seq: 3 })
      ordering.observe({ seq: 2 })
      expect(ordering.maxSeenSeq()).toBe(3)
    })

    it('issueSeq は appliedSeq + 1 を発行し、未適用のまま二重発行すると throw する', () => {
      const ordering = createOrdering()
      ordering.markApplied(1, 'req-1')

      expect(ordering.issueSeq()).toBe(2)
      expect(ordering.hasPendingIssue()).toBe(true)
      expect(() => ordering.issueSeq()).toThrow('pending issue')

      ordering.markApplied(2, 'req-2')
      expect(ordering.hasPendingIssue()).toBe(false)
      expect(ordering.issueSeq()).toBe(3)
    })

    it('retractIssue で発行を取り消し、host の永久停止を防ぐ', () => {
      const ordering = createOrdering()
      ordering.issueSeq()
      expect(ordering.hasPendingIssue()).toBe(true)

      ordering.retractIssue()
      expect(ordering.hasPendingIssue()).toBe(false)
      expect(ordering.issueSeq()).toBe(1) // 再発行は同じ seq (衝突は tiebreak が収束)
    })
  })

  describe('永続状態 (restore / state / stateWith / 直近窓)', () => {
    it('restore し、直近窓の id は適用済みとして扱う (正史/敗者の判別)', () => {
      const ordering = createOrdering()
      ordering.restore({
        epoch: 5,
        appliedSeq: 10,
        applied: { 9: 'req-9', 10: 'req-10' },
      })

      expect(ordering.appliedSeq()).toBe(10)
      expect(ordering.isApplied('req-10')).toBe(true) // 窓にある = 正史
      expect(ordering.isStale(9)).toBe(true)
      // 窓にない stale id は敗者候補 (isApplied false のまま)
      expect(ordering.isApplied('req-loser')).toBe(false)
      // 復元した epoch を跨いで昇格する
      expect(ordering.beginHosting()).toBe(6)
    })

    it('restore は適用位置と直近窓を snapshot の正史で完全置換する', () => {
      const ordering = createOrdering()
      ordering.markApplied(1, 'X')

      ordering.restore({
        epoch: 2,
        appliedSeq: 2,
        applied: { 1: 'Y', 2: 'Z' },
      })

      expect(ordering.isApplied('X')).toBe(false)
      expect(ordering.isApplied('Y')).toBe(true)
      expect(ordering.isApplied('Z')).toBe(true)
      expect(ordering.appliedSeq()).toBe(2)
    })

    it('restore は観測済み epoch を後退させない', () => {
      const ordering = createOrdering()
      ordering.observe({ epoch: 5 })

      ordering.restore({ epoch: 2, appliedSeq: 0, applied: {} })

      expect(ordering.beginHosting()).toBe(6)
    })

    it('restore は処理中ガードを維持する', () => {
      const ordering = createOrdering()
      ordering.beginProcessing('P')

      ordering.restore({ epoch: 2, appliedSeq: 0, applied: {} })

      expect(ordering.isProcessing('P')).toBe(true)
    })

    it('stateWith は「この request 適用後」の snapshot 状態を返す (ack await 前の評価固定用)', () => {
      const ordering = createOrdering()
      ordering.markApplied(1, 'req-1')
      ordering.beginHosting()

      const projected = ordering.stateWith(2, 'req-2')
      expect(projected.appliedSeq).toBe(2)
      expect(projected.applied[1]).toBe('req-1')
      expect(projected.applied[2]).toBe('req-2')
      // stateWith は評価するだけで内部状態を進めない
      expect(ordering.appliedSeq()).toBe(1)
    })

    it('直近窓は APPLIED_WINDOW_SIZE で打ち切られ、それより古い seq は isBeyondWindow になる', () => {
      const ordering = createOrdering()
      const total = APPLIED_WINDOW_SIZE + 10

      for (let seq = 1; seq <= total; seq += 1) {
        ordering.markApplied(seq, `req-${String(seq)}`)
      }

      const state = ordering.state()
      expect(Object.keys(state.applied)).toHaveLength(APPLIED_WINDOW_SIZE)
      expect(ordering.isBeyondWindow(total - APPLIED_WINDOW_SIZE)).toBe(true)
      expect(ordering.isBeyondWindow(total - APPLIED_WINDOW_SIZE + 1)).toBe(
        false,
      )
      // 窓から溢れた id の適用記録も解放される (メモリの無限成長防止)
      expect(ordering.isApplied('req-1')).toBe(false)
    })
  })

  describe('acceptAdded (added 重複配送ガード)', () => {
    it('初出の request id は受理し、重複配送は破棄する', () => {
      const ordering = createOrdering()
      expect(ordering.acceptAdded('req-1')).toBe(true)
      expect(ordering.acceptAdded('req-1')).toBe(false)
      expect(ordering.acceptAdded('req-2')).toBe(true)

      ordering.resetAddedGuard()
      expect(ordering.acceptAdded('req-1')).toBe(true)
    })
  })

  describe('processing ガード (v1 の既知の問題①′対策の継続)', () => {
    it('beginProcessing 中は isProcessing が立ち、endProcessing で解放される', () => {
      const ordering = createOrdering()
      expect(ordering.isProcessing('req-1')).toBe(false)

      ordering.beginProcessing('req-1')
      expect(ordering.isProcessing('req-1')).toBe(true)

      ordering.endProcessing('req-1')
      expect(ordering.isProcessing('req-1')).toBe(false)
    })
  })

  describe('reset (seedSynced の新規 session 初期化)', () => {
    it('session 状態を初期化し fencing (maxSeenEpoch) だけ維持する', () => {
      const ordering = createOrdering()
      ordering.observe({ epoch: 3, seq: 5 })
      ordering.restore({ epoch: 3, appliedSeq: 5, applied: { 5: 'req-5' } })
      ordering.beginProcessing('req-p')
      expect(ordering.acceptAdded('req-6')).toBe(true)

      ordering.reset()

      expect(ordering.appliedSeq()).toBe(0)
      expect(ordering.maxSeenSeq()).toBe(0)
      expect(ordering.hasPendingIssue()).toBe(false)
      expect(ordering.isApplied('req-5')).toBe(false)
      expect(ordering.isProcessing('req-p')).toBe(false)
      // added guard も解除され、synced 復帰時の backlog replay を受け直せる
      expect(ordering.acceptAdded('req-6')).toBe(true)
      // fencing は後退しない: 観測済み epoch 3 を跨いだ世代で host になる
      expect(ordering.beginHosting()).toBe(4)
    })
  })
})
