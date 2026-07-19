# TASK-260719: README How to 追記 (サーバ時刻 / 型付き hooks)

- Status: **Done (2026-07-19)**

## やったこと

- README「サーバ時刻で機能を組む」: 同期経路では `action.meta.dispatched` が `serverNow()` (サーバ基準時刻) に上書きされるため、reducer は dispatched を読めば時刻依存ロジックが全端末で一致する、を案内
    - firebase transport の `serverNow()` は offset cache により O(1) (往復なし) であることを補足
    - standalone / `setEnabled(false)` の local 適用では端末時計になる非対称を明記
- README「useSelector / useDispatch の型補完」: Redux 公式 `.withTypes<>()` + `sync.rootReducer` からの RootState 導出 snippet を追加 (synqux 固有機構は不要)

## 残項目

なし
