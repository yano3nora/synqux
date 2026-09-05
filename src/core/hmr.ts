/**
 * HMR 一式の片割れ (TASK-260904)。bundler の hot context (Vite の `import.meta.hot`
 * など) の `data` に singleton を保持し、module の再評価を跨いで同じ instance を
 * 返す。`replaceReducers` と対で使う — instance を保持しなければ差し替える先が
 * なく、差し替えなければ保持した instance が古い reducer のまま残る。
 *
 * synqux 固有の知識は持たない汎用 3 行だが、consumer 側の HMR 定型を README で
 * 説明する代わりに一式として配る (責務超過は承知の上で、consumer が自社 repo 群
 * に限られる private 寄りライブラリとして許容。docs/TASK-260904)。
 *
 * hot の型は bundler 固有型を import せず、必要な `data` だけの構造型で受ける
 * (Vite の ViteHotContext は `data: any` のためそのまま渡せる)。hot が undefined
 * (本番 build / HMR 無効) のときは毎回 create する = 通常の module 評価と同じ。
 * 前提は Vite の `import.meta.hot` (data が常に object で、代入がそのまま次世代へ
 * 引き継がれる)。webpack の `module.hot` は data が初回 undefined で、引き継ぎも
 * `dispose(data => ...)` 経由のため対象外 (consumer は Vite のみ)
 */
export type HotContextLike = { data: Record<string, unknown> } | undefined

/**
 * hot.data[key] があればそれを、なければ create() して保持したうえで返す。
 *
 * 契約:
 * - 差し替えられるのは reducer だけ (`replaceReducers`)。middlewares / automations /
 *   listeners / transport を持つ module の変更は保持した instance に反映されない —
 *   その module では `hot.invalidate()` で full reload させること
 * - key は module 内で一意にする (hot.data は module 単位の名前空間)
 */
export const keepAcrossHmr = <T>(
  hot: HotContextLike,
  key: string,
  create: () => T,
): T => {
  if (!hot) {
    return create()
  }
  // `in` だと継承プロパティ (constructor など) を拾って create を飛ばすため own 判定
  if (!Object.hasOwn(hot.data, key)) {
    hot.data[key] = create()
  }
  return hot.data[key] as T
}
