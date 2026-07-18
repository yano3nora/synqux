# TASK: 多端末同時操作の stress simulation test (CI)

- Date: 2026-07-18
- Status: Complete
- 出自: `docs/BACKLOG.md`「多端末同時操作の stress simulation test (CI)」
- 前提知識 (必読): `src/core/health.test.ts` / `src/core/recovery.test.ts` / `src/core/retention.test.ts` (シナリオ構築と settle / fake timers の技法)、`src/core/test-fixtures.ts`、`src/testing/memory-hub.ts` (faults と request id の採番規則)、`docs/ADR-0002` 〜 `ADR-0005`

## 目的

シード付き乱数で N 端末 × M request の並行送信 + fault 注入を回し、**今回のイテレーションで実装した機能群 (sync health / 自動回復 / retention) が stress 下でも機能し、同期の不変条件が保たれること**を CI で継続的に実証する。

機能とシナリオの対応 (この実証マップを test コメントにも残すこと):

| 対象 | シナリオ | 実証内容 |
| --- | --- | --- |
| 順序保証・適用一意性 (core) | 1, 2, 3 | 全端末の適用列 (log) が完全一致し、各 request は高々 1 回適用 |
| retention prune (ADR-0005) | 1, 3 | 窓超え運転で transport の requests が窓サイズに抑えられ、prune 後の途中参加も収束 |
| sync health 検知 (ADR-0003) | 2 | 恒久 drop で stall した端末が非 ok phase を経由する |
| 自動回復 (ADR-0004) | 2 | stall した端末がリロードなしで収束し、最終的に全端末 ok |

NOTE: prune の logs 退避と presence 再登録は firebase adapter 固有機能のため本 stress の対象外 (adapter unit test で担保済み)。この除外も test コメントに明記する。

## 設計コンセプト (この判断は変えないこと)

- **決定的であること**: 乱数は必ず自前のシード付き PRNG (mulberry32 等を test ファイル内に実装)。`Math.random` / `Date.now` を test ロジックに使わない。fake timers + `vi.setSystemTime` は既存テストに倣う
- **シードは固定リストを `it.each` で回す** (例: 3 シード)。**シード探し (落ちるシードを通るシードに差し替える行為) は禁止**。あるシードで落ちたら、それは (a) 製品バグか (b) ハーネスの非決定性のどちらかである。(a) なら修正せず本ファイル末尾に再現条件を報告して停止する (このテストの存在意義そのもの)。(b) ならハーネスを直す。assertion を弱めて通すことも禁止
- **fault は memory hub の採番規則を利用して事前に狙い撃つ**: request id は push 順の連番 (`'000000000001'` 形式) なので、k 番目の request への fault を dispatch 前に登録できる
- 実行時間はファイル全体で概ね 15 秒以内に収める (シードあたり M ≈ 240 request 程度、`stallAfterMs` は 3 秒程度に短縮)

## 実装内容

### `src/core/stress.test.ts` (新規)

共通ハーネス: N=4 端末 (+ シナリオ 3 の途中参加 1 端末)、request は `game/increment` を一意 payload (連番) で dispatch し、`game.log` の完全一致 = 適用列の一致として検証する。dispatch する端末・fault の種類と対象は PRNG で選ぶ。

1. **シナリオ 1 — 一過性 chaos での収束と retention**: M ≈ 240 (窓 200 超え)。確率的に注入: added/changed の duplicate、delay (後で必ず release)、host の強制切断 (disconnect。切断後は残存端末で継続、切断は端末数 2 を下回らない範囲)。終了処理 (全 delay release → fake timers を回復サイクルぶん進める → settle) 後に assert:
   - 生存全端末の `game.log` が完全一致し、要素はすべて一意、件数 = 生存端末が dispatch した総数
   - `hub.inspect.requests` の件数が `APPLIED_WINDOW_SIZE + 少量の余裕` 以下 (prune が stress 下でも効いている)。残存 envelope の最小 seq が `appliedSeq - APPLIED_WINDOW_SIZE` より新しい
   - 全端末の health が ok
2. **シナリオ 2 — 恒久 drop からの自動回復**: シナリオ 1 の chaos に加えて、ランダムな端末への特定 response の恒久 drop を数回注入する。`store.subscribe` で各端末の health phase 履歴を記録し、assert:
   - 少なくとも 1 端末が非 ok phase (stalled / recovering) を経由した (検知が発火した実証)
   - 終了処理後、**リロードなしで**全端末の log が完全一致し、全端末 ok (自動回復の実証)
3. **シナリオ 3 — prune 後の途中参加**: シナリオ 1 相当の運転を M ≈ 220 まで進めた後、新規端末が subscribe → 以降の chaos にも参加し、終了時に他端末と log / synced state が完全一致する (snapshot + prune 後の残存 requests だけで追いつける実証)

補足:
- 終了処理は helper に括り出す (delay の release 漏れが無いよう、登録した delay ハンドルを配列で管理する)
- 恒久 drop の対象は「その envelope が prune で消えても restore で回復できる」ため任意でよいが、シナリオ 2 では stall 検知 (stallAfterMs) → 回復 (2 段階) が完了するだけの fake timer 進行を終了処理に含めること
- 切断済み端末の store は assert 対象から外す (プロセス死の模擬のため)

### ドキュメント

- **`docs/BACKLOG.md`**: 運用ルール 2 に従い、当該項目をリンクごと削除する
- **`README.md`**: Development の Commands 近くに「stress simulation は `src/core/stress.test.ts` (シード固定・決定的)」を 1 行 (任意、収まりが悪ければ省略可)
- CHANGELOG は不要 (consumer 向け変更なし)

## 制約

- 変更は `src/core/stress.test.ts` と docs に閉じる。**製品コード (`src/core` の実装 / `src/testing` / `src/firebase`) は変更しない** — テストを通すための製品変更が必要になった場合は、それはバグ発見なので報告して停止する
- 依存パッケージを追加しない
- git commit しない (人間が判断する)

## 完了条件

- [x] `npm run fix` 実行済みで clean
- [x] `npm test` が全部通り、stress.test.ts が 3 シード × 3 シナリオで安定して通る (連続 3 回実行して flake しないことを確認)
- [x] 実証マップと除外 (firebase 固有機能) がテストコメントに記載されている
- [x] BACKLOG が更新されている
