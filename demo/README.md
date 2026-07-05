# synqux demo

firebase emulator 上で counter を端末間同期する手動確認用 demo。npm には含まれない (`files: ["dist"]`)。CI もこれに依存しない。

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
