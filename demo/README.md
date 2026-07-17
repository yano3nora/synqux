# synqux demo

firebase emulator 上で counter と ledger を端末間同期する手動確認用 demo。npm には含まれない (`files: ["dist"]`)。CI もこれに依存しない。

## Getting Started

```sh
# 1. RTDB emulator を起動 (Java が必要。firebase-tools は npx で取得)
npm run demo:emulator

# 2. 別ターミナルで dev server を起動
npm run demo
# → http://localhost:5173 を複数タブで開く
```

- `?group=xxx` で部屋を分ける / `?role=dedicated` `?role=observer` で役割を変える
- src を alias で直接読むため、ビルド不要で API 変更が即反映される

## Testcases

1. 2 タブで +1 が相互反映される (適用順の一致)
2. 最新接続タブが HOST 👑 になり、そのタブを閉じると残りが昇格する (onDisconnect → migration)
3. リロードで count が復元される (snapshot restore)
4. +10 連打で 100 を超えると拒否され、押した本人にだけ message が出る (reducer validation)
5. `?role=dedicated` のタブが常に host に固定される
6. `?role=observer` のタブは host にならない

## Stress mode

counter の加算は適用順が入れ替わっても同じ値になるため、ledger の running hash で
同時多発 request の順序保証と適用一意性を確認する。

1. RTDB emulator と demo を Getting Started の手順で起動する
2. 同じ `group` のタブを 3 つ以上開く
3. 各タブで `Storm x50` または `Storm x200` を実行する。全タブを
   `?storm=200` 付きの同じ URL で開いて自動開始してもよい
4. storm 終了後、すべての request が静穏化するまで待つ

**全タブの ledger count と hash が完全一致すれば正常**。1 つでも違えば、順序保証か
適用一意性のバグとして扱う。

storm 中にタブを閉じて host migration を混ぜると、dual-host 窓の既知トレードオフ
(SPEC-0001「設計上の割り切り」) により一時分岐があり得る。バグと判定するのは、
**host 交代を伴わない安定運用で不一致になった場合だけ**とする。
