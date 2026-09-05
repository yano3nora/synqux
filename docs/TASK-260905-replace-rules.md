# TASK-260905: replace-rules

260905 instance を生かしたまま automations / listeners を差し替える (HMR 対応の続き)
===

## asis

- TASK-260904 で reducer は `replaceReducers` で差し替えられるようになったが、automations / listeners は createSynqux の閉包定数のまま。consumer (テンプレ) では automations / listeners がゲーム固有の拡張点で、編集のたびに手動 reload が要る
- 加えて automations / listeners は domains を import するため、domains の編集で module が再評価されても閉包内の rule は旧 module の関数を掴んだままになる (TASK-260904 で「残る限界」として記録)

## tobe

- core instance に `replaceRules({ automations?, listeners? })` を追加。validation は create 時と同じ関数を通し、失敗は throw (差し替わらない)
- automations: 配列を差し替え、session が live (engine 起動後) なら engine を再起動する。`lastIssuedAt` (rule id ごとの発行時刻) は引き継いで即時の二重発行を避け、tick (retryMs の最小値) は新 rule 群で計算し直す。初期 0 件でも engine を起動しておき、後から rule が増えても評価される
- listeners: 配列と `scope: 'all'` の有無を差し替える。`fire: 'persisted'` で待機中の効果は捕捉済みの旧 closure が 1 回走る (dev 用途で許容)
- middlewares / transport は据え置き (consumer 側で full reload に落とす)

## todo

- [x] TASK 起票
- [x] core: `let automations / listeners / hasAllScopeListeners` 化、validation 関数化、engine の stop / restart 化、`replaceRules`
- [x] テスト: automations 差し替え (旧 rule 停止・新 rule 発行・lastIssuedAt 引き継ぎ・初期 0 件からの起動・validation 失敗で据え置き)、listeners 差し替え (旧停止・新発火・scope 'all' の後付け)
- [x] docs: SPEC-0002 (Synqux 型) / README (API 表 + HMR 節)
- [x] npm run fix / npm test (vitest 46 files 442 tests, oxlint, oxfmt, tsc)
- [x] Codex レビュー (core は問題なし。docs の指摘 2 件を反映: README の HMR 例で初期 createSynqux に automations / listeners を渡していなかった → 追加し「初回は no-op」の表現も修正。README / SPEC / hmr.ts / replaceRootReducer docstring に残っていた「reducer のみ差し替え可能」を replaceRules 込みへ更新)

## testcases

- [x] host で automations を差し替えると、旧 rule は以後発行されず新 rule が発行される
- [x] 差し替え直後、直前に発行した同 id の rule は retryMs 内なら再発行されない (lastIssuedAt 引き継ぎ)
- [x] 初期 automations が 0 件の instance でも差し替え後に rule が評価・発行される
- [x] validation 失敗 (id 重複) は throw し、既存の rule が据え置かれる
- [x] listeners を差し替えると、旧 listener は発火せず新 listener が発火する。scope 'all' を後付けすると local action でも発火する
- [x] serverNow 待ち中に差し替えても旧 engine は発行しない (active フラグ)

## notes

- 発見経緯: fc-310 の HMR 対応 (docs/TASK-260905-hmr-reducers.md) で automations / listeners の開発体験を reducer と同等にしたい要望
- reducer と違い、automations / listeners は await を跨ぐ裁定に関与しないため保留ゲートは不要。差し替え中の在庫は「evaluate の serverNow 待ち」だけで、engine の active フラグで無害化される
- automation 再起動直後に `when` を満たす rule が 1 回発行され得るのは rejects-repeat 契約 (ADR-0007) の範囲内。lastIssuedAt の引き継ぎで retryMs 内の再発行は抑える
