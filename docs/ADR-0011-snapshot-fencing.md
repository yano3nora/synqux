# ADR-0011: snapshot 書き込みの fencing (単調性の保証)

- Status: **Accepted** (2026-07-20 実装)
- Date: 2026-07-20
- 関連: ADR-0002 (epoch fencing / tiebreak), ADR-0005 (retention), ADR-0010 (snapshot は正史ではなくチェックポイント), TASK-260719-ordering-restore-replacement (restore 受理条件 `>` の再判断を本 ADR へ委譲)

## Context

`saveSnapshot(key, payload)` は全実装 (Firebase `set` / memory / localStorage) で無条件上書きであり、書き込みの単調性を保証する仕組みがない。

1. **巻き戻し**: host migration 直後、旧 host の遅延した saveSnapshot が新 host の書いた snapshot を上書きし、保存済みの `(epoch, appliedSeq)` が後退し得る
2. **復元不能化**: prune の安全線は「snapshot が appliedSeq まで含む」前提で `appliedSeq - 200` に引かれている (ADR-0005)。巻き戻った snapshot と prune が組み合わさると、復帰端末が「古い snapshot + 再生用封筒は削除済み」で追いつけなくなる
3. restore の受理条件 `snapshot.appliedSeq > applied` は「同値 snapshot による早期適用是正」を拒否しており、snapshot の信頼性が保証されるなら緩和できる (TASK-260719-ordering-restore-replacement で発見)

位置づけ: dual-host 窓の競合のうち、**裁定 (respond) 側には決定的 tiebreak という審判がいる** (ADR-0002) が、**snapshot の上書きには審判がおらず「後から書いた者勝ち」**のまま残っていた。本 ADR はこの最後の無防備な競合面に fence を置くものであり、これで裁定・snapshot の両面の競合が閉じる。

## Decisions

### 1. transport 契約へ fence 付き条件付き書き込みを導入する

- `saveSnapshot(key, payload, fence: { epoch: number; appliedSeq: number }): Promise<boolean>` へ変更する
- adapter は fence を payload と並べて保存し、**原子的な条件付き書き込み (CAS / transaction)** で「保存済み fence より辞書順で低い書き込み」を棄却する。棄却は正常系であり reject しない。戻り値は `true` = 書き込んだ / `false` = fence で棄却
- payload は引き続き不透明な文字列として扱う (adapter に封筒の parse をさせない。fence を引数で渡すのはこのため)

### 2. 比較は `(epoch, appliedSeq)` の辞書順。同値は受理 (冪等)

- 受理条件: `epoch > stored.epoch || (epoch === stored.epoch && appliedSeq >= stored.appliedSeq)`
- **epoch 優先の理由**: dual-host 窓では旧 epoch host が一時的に先の appliedSeq を持ち得るが、正史の収束先は高 epoch 側 (ADR-0002 の tiebreak)。appliedSeq だけの比較では敗者履歴を含む旧 host snapshot が勝ててしまう
- fencing の目標は「巻き戻し防止 (単調性)」であって完全な正史選別ではない。dual-host 窓の混在履歴 (旧 epoch host のみが裁定した slot が正史になるケース等) は ADR-0002 の既知トレードオフの範疇で、端末側の restore + 再裁定が吸収する

### 3. prune は書き込みが受理されたときだけ実行する

- fenced-out (`false`) の場合、その host の orderingState 由来の prune 線は保存済み snapshot と無関係に先行し得るため、prune まで進むと「stale snapshot + 封筒削除」の復元不能を自ら作る
- `persistSnapshot` の戻り値で分岐し、`false` なら prune をスキップする (ADR-0010 の「snapshot 失敗時は prune スキップ」と同型の防衛)

### 4. adapter の保存形状と互換性

- Firebase: snapshot node を `{ fence: { epoch, appliedSeq }, payload }` とし、`runTransaction` で比較・棄却する。memory / localStorage も同じ比較を実装する
- 旧形状 (生 payload 文字列) との後方互換は持たない。0.x・消費者は社内 repo のみ・group は短命 (ゲームルーム単位) であり、migration コードの恒久保守コストに見合わない。transport 契約の breaking change として CHANGELOG に記録する

### 5. restore の受理条件を `>=` へ緩和する

- fencing により保存済み snapshot の単調性が保証されるため、`restoreFromLatestSnapshot` の受理条件を `snapshot.appliedSeq >= applied` へ緩める
- 同値受理は「同 seq だが synced が分岐している端末 (dual-host 早期適用)」を正史へ引き戻す唯一の手段であり、ordering 完全置換 + 再評価 (ADR-0010 の #2 実装) と組み合わせて初めて安全に機能する。健全な端末では同値 restore は冪等 (no-op 相当)

## Performance notes (transaction 化の性能影響の見立て)

- **同期速度 (ユーザ体感) には乗らない**。action 反映のクリティカルパスは「pushRequest → 裁定 → respondRequest → changed 配送 → 適用」で、snapshot はその後の後処理。直列裁定ゲートの解除条件は「前の seq の**適用** (markApplied)」であって snapshot 完了ではなく、適用は responseListener という別 fork が担うため、persistSnapshot の await は次の裁定を塞がない
- `runTransaction` は「現在値を読む → 比較 → CAS」だが、RTDB はローカルキャッシュ値で楽観的に初回試行する。**snapshot の書き手は定常状態で host 1 台**であり直前の自書き込みがキャッシュにあるため、初回試行がそのまま通って実質 `set` と同等。追加往復が生じるのは初回書き込みと host migration 直後 (= まさに fence が働くべき瞬間) のみ
- RTDB の write レート制約に対しては、1 action あたり約 3 write (push / respond / snapshot) で、ターン制・協力型の想定ユースケースは桁で下回る。超過時の挙動も遅延 (キューイング) であって破壊ではない
- それでも実測で痛む場合に削るのは fence ではなく **snapshot の書き込み頻度** (BACKLOG P2「実運用計測後に見直す」)。恒久障害の保険を速度のために外さない
- 副次効果: fence は「同一 host 内で snapshot 書き込みが追い越されるケース」(seq N の書き込み await 中に seq N+1 が先に着地し、遅れた N が巻き戻す) も同じ比較で防ぐ

## Alternatives considered

- **read-then-write (書く前に読んで比較)**: check と write の間に他の書き込みが入る TOCTOU race が残る。まさに「遅延書き込み」問題の再演であり、原子性のない比較は解決にならない
- **タイムスタンプで新しい方を勝たせる**: 端末時計を correctness に使わない大原則 (ADR-0002 で clock skew 依存を根絶した経緯) に逆行する
- **snapshot の追記型化 (履歴を残し読み側で選別)**: 容量が成長し、prune 設計が別途必要になり、読み側の選別ロジックとして結局同じ fence 比較が要る。書き込み点で 1 回比較する方が単純
- **現状維持 (無条件上書き)**: 巻き戻し + prune の複合で復元不能を作る。P0 の由来そのもの

## Consequences

- transport 契約の breaking change (`saveSnapshot` の引数・戻り値・保存形状)。semver 上の扱いは BACKLOG「公開前 gate」の version 判断に含める
- MemoryHub に snapshot 書き込みの保留 fault (`holdSnapshot`) を追加し、「旧 host の遅延書き込み」を決定的に再現する
- Firebase adapter の runTransaction 化は SDK mock で単体検証し、emulator 実機確認は BACKLOG P1「conformance gate」に委ねる

## Amendment (2026-08-16): `applyLocally: false` (ADR-0021)

fence 購読 (`subscribeSnapshotFence`、transport 契約 13) へ楽観 local echo を
流さないため、firebase adapter の `runTransaction` は `applyLocally: false` で
実行するようになった。Performance notes の「初回試行がそのまま通って実質 `set` と
同等」という説明は書き込み往復については引き続き成立するが、**購読側の可視性**
(自端末の local event が即時に発火すること) については成立しない — fence 購読
イベントは server 確定後にのみ届く。これは `fire: 'persisted'` の「耐久化済み
だけを観測する」契約のための意図的な変更 (ADR-0021 Decision 3)。
