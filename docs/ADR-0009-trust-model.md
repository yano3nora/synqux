# ADR-0009: 協調的な非敵対クライアントを trust boundary とする

- Status: **Accepted**
- Date: 2026-07-19
- 関連: `SPEC-0001-requests-sync.md`、`TASK-260719-trust-model.md`

## Context

Firebase adapter を使う browser client は transport への書き込み権限を持つ。したがって改造 client や DB への直接書き込みを許すと、request / response / `(epoch, seq)` / snapshot / presence を偽造できる。Firebase Authentication は端末の識別であり、host だけが正しい裁定を書いたことの証明にはならない。

これを防ぐには、信頼できる server へ reducer 判定・seq 採番・snapshot 永続化を移すか、署名・検証を含む別の権威モデルが必要になる。これは client-host 型によって server の開発・運用コストを省く本ライブラリの目的と衝突する。

## Decision

1. synqux は consumer が認証・認可した**協調的な非敵対クライアント**間の同期を対象とする
2. 改造クライアント、チート、transport データの直接改ざんへの耐性は提供しない
3. 敵対クライアントを想定する consumer は synqux の client-host 型を採用せず、信頼できる server を唯一の判定器・採番者・永続化主体とする
4. room 外アクセスや情報漏えいを防ぐ Authentication / Security Rules、group ごとの認可、データ削除は引き続き consumer の責務とする
5. `demo/database.rules.json` の全 read/write 許可は emulator 専用とし、本番利用を禁止する

## Consequences

- core に署名、anti-cheat、host response の真正性検証を追加しない
- 「host が単一権威」という不変条件は、協調的クライアントと正しく実装された transport の範囲で成立する
- Firebase Rules は不正な host 裁定の完全防止ではなく、認可されていない user / room 間のアクセス防止を主目的とする
- 将来、不正操作耐性が要件になった場合は option 追加ではなく同期モデルの再選定として新しい ADR を起こす
