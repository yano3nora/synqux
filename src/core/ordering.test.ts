import { describe, expect, it } from 'vitest'
import { createOrdering } from './ordering.js'

/**
 * Phase 0 characterization test (移植元 constants/requests.test.ts) の
 * isDelayedRequestId / REVISIONS / REQUESTS 相当シナリオの新 API 移植。
 * 既知の問題も含めて移植元の挙動を正とする (修正は C6 で行う)
 */
describe('createOrdering', () => {
  describe('isDelayed (移植元 isDelayedRequestId)', () => {
    it('処理済みリストが空なら常に遅延ではない', () => {
      const ordering = createOrdering()
      expect(ordering.isDelayed('-Any')).toBe(false)
    })

    it('処理済み末尾より辞書順で新しい id は遅延ではない', () => {
      const ordering = createOrdering()
      ordering.seed(['-Aaa', '-Bbb'])
      expect(ordering.isDelayed('-Ccc')).toBe(false)
    })

    it('処理済み末尾より辞書順で古い id は遅延と判定する', () => {
      const ordering = createOrdering()
      ordering.seed(['-Bbb'])
      expect(ordering.isDelayed('-Aaa')).toBe(true)
    })

    it('【既知の問題②の機構】辞書順比較は push id = 端末時計に依存するため、時計がズレた端末の正当な request も遅延と誤判定し得る', () => {
      // 実時間では「あと」に送信された request でも、送信端末の時計が
      // 遅れていると push id が辞書順で「まえ」になり、取りこぼされる
      const newerButSkewedId = '-OwWbW56Lp4fz-eiDXWN' // 実データ由来の例
      const ordering = createOrdering()
      ordering.seed(['-OwWbW651v_vXDMKpqbu'])
      expect(ordering.isDelayed(newerButSkewedId)).toBe(true)
    })
  })

  describe('shouldWaitFor / isApplied', () => {
    it('prev が無ければ待機しない', () => {
      const ordering = createOrdering()
      expect(ordering.shouldWaitFor(null)).toBe(false)
      expect(ordering.shouldWaitFor(undefined)).toBe(false)
    })

    it('prev が未適用なら待機し、適用済みになったら解除される', () => {
      const ordering = createOrdering()
      expect(ordering.shouldWaitFor('req-1')).toBe(true)

      ordering.markApplied('req-1')
      expect(ordering.shouldWaitFor('req-1')).toBe(false)
      expect(ordering.isApplied('req-1')).toBe(true)
    })

    it('seed した revisions も適用済みとして扱う (restore 後の順序保証の継続)', () => {
      const ordering = createOrdering()
      ordering.seed(['req-1', 'req-2'])
      expect(ordering.isApplied('req-2')).toBe(true)
      expect(ordering.shouldWaitFor('req-2')).toBe(false)
      expect(ordering.lastRevision()).toBe('req-2')
    })
  })

  describe('markApplied / revisions', () => {
    it('重複記録を防がない (防止は呼び出し側の責務。記録列 = 適用履歴の ground truth 性を守る)', () => {
      const ordering = createOrdering()
      ordering.markApplied('req-1')
      ordering.markApplied('req-1')
      expect(ordering.revisions()).toEqual(['req-1', 'req-1'])
    })

    it('revisions() はコピーを返し、外部からの変更が内部状態に漏れない', () => {
      const ordering = createOrdering()
      ordering.markApplied('req-1')

      const leaked = ordering.revisions()
      leaked.push('req-x')
      expect(ordering.revisions()).toEqual(['req-1'])
    })
  })

  describe('processing ガード (既知の問題①′の対策)', () => {
    it('beginProcessing 中は isProcessing が立ち、endProcessing で解放される', () => {
      const ordering = createOrdering()
      expect(ordering.isProcessing('req-1')).toBe(false)

      ordering.beginProcessing('req-1')
      expect(ordering.isProcessing('req-1')).toBe(true)

      ordering.endProcessing('req-1')
      expect(ordering.isProcessing('req-1')).toBe(false)
    })
  })

  describe('acceptAdded (移植元 REQUESTS ガード)', () => {
    it('初出の prevKey は受理し、同一 prevKey の重複配送は破棄する', () => {
      const ordering = createOrdering()
      expect(ordering.acceptAdded(null)).toBe(true) // チェーン先頭 (prevKey なし)
      expect(ordering.acceptAdded('req-1')).toBe(true)
      expect(ordering.acceptAdded('req-1')).toBe(false) // 遅延後の重複配送
    })

    it('【移植元仕様の温存】prevKey null の 2 件目は別 request でも破棄される', () => {
      // 判定 key が request id ではなく prevKey であることの帰結。
      // live 運用では先頭以外の prevKey は必ず埋まるため実害が顕在化しにくい
      const ordering = createOrdering()
      expect(ordering.acceptAdded(null)).toBe(true)
      expect(ordering.acceptAdded(null)).toBe(false)
    })
  })
})
