# TASK-260810: result 再生成原則の組み込みと stateWithTransaction の移植

- 背景・決定: `docs/ADR-0013-result-lifecycle.md` を先に読むこと
- 対象 version: 0.5.0 (version bump 自体は release 手順で人間が行うため、このタスクでは触らない)

## Phase 1: result 再生成原則 (ADR-0013 Decision 1–3)

### 1-1. `stateWithDefaultResult` を `src/core/results.ts` に追加

```ts
/** synced domain action の適用前に result を default success へ差し替える (ADR-0013)。
 *  createSynquxRootReducer が内部で呼ぶ。primitive 方式の consumer は自前 rootReducer の
 *  synced reducer 前段でこれを呼ぶ義務を負う */
export const stateWithDefaultResult = <
  TSynced extends SynquxSynced<TAction, TMessage>,
  TAction extends Action,
  TMessage extends ResultMessage = ResultMessage,
>(
  state: TSynced,
  action: TAction,
): TSynced => ({
  ...state,
  result: generateResult<TAction, TMessage>({ action, type: 'success' }),
})
```

- immutable (新オブジェクト返却)。immer 前提の `stateWithResult` 系と違い reducer 実行「前」に呼ぶため
- message / log は付けない (= UI 通知なし・console 出力なし、ADR-0008)

### 1-2. `createSynquxRootReducer` (`src/core/root-reducer.ts`) へ組み込み

- config に `isSyncedAction: (action: Action) => action is TAction` を **required** で追加 (generics に `TAction` を追加)
- 返り値に `isSyncedAction` をそのまま echo する (spread 慣用句で `createSynqux` へ届くように)
- synced reducer 実行部を変更: `synquxRestored` 分岐は現状維持。通常分岐は
  「`state` が存在し、かつ `isSyncedAction(action)` のとき、`stateWithDefaultResult(state[syncedKey], action)` を synced reducer へ渡す」。それ以外は従来どおり
- stamp が走った action では synced の参照が必ず変わる (= `changed` になる) が、これは意図どおり (no-op 受理でも result は更新される)

### 1-3. 追従修正

- `src/index.ts`: `stateWithDefaultResult` を export に追加
- `src/index.test.ts`: export 表明を更新
- `src/core/test-fixtures.ts`:
    - `gameReducer` の increment / toggle / random 分岐から手書きの `result: null` を削除
    - primitive 方式の手書き `rootReducer` で、`isGameAction(action)` のとき `stateWithDefaultResult` を `gameReducer` の前段に挟む (primitive 契約のドッグフーディング)
- `demo/main.ts`: `isSyncedAction` を `createSynquxRootReducer` の config へ移し、spread echo で `createSynqux` へ渡す形に更新
- 既存テストの表明更新 (最低限、以下は必ず確認):
    - `src/core/characterization.test.ts:226-227` 付近「increment は result を積まない (= null) ので success 扱い」→ patch.result が default success の直列化になる表明へ書き換え (コメントも ADR-0013 参照に更新)
    - `src/core/create-synqux.test.ts:236` 付近の `game.result` null 表明は文脈 (restore 直後か) を確認し、restore 経路なら現状維持
    - その他 `npm test` で落ちる表明はすべて「stamp 後の意味」で更新する。**挙動を変えて緑にするのではなく、表明を新契約に合わせる**こと

### 1-4. 新規テスト (Phase 1 の完了条件)

`src/core/root-reducer.test.ts` へ:

1. result を書かない synced action → 適用後 result が当該 action の success になる (result.action.type と meta.hash の一致まで見る)
2. `stateWithError` する分岐 → stamp を上書きして error が残る
3. `isSyncedAction` が false の action → result は不変 (残留しない/消えない)
4. **残留 error の regression**: 「error result が残った state に、result を書かない synced action を適用 → result が success に更新される」
5. 返り値 echo: `createSynquxRootReducer({...}).isSyncedAction` が渡した述語と同一

`src/core/host-adjudication.test.ts` (または適切な simulation test) へ:

6. **誤裁定 regression (このタスクの動機)**: in-memory transport で「message 付き error で拒否される request → 続けて result を書かない request」を流し、2 つ目が受理され全端末へ適用されること

## Phase 2: `stateWithTransaction` の移植 (ADR-0013 Decision 4)

### 2-1. `src/core/results.ts` へ追加

```ts
export const stateWithTransaction = <
  TSynced extends SynquxSynced<TAction, TMessage>,
  TAction extends Action,
  TMessage extends ResultMessage = ResultMessage,
>(
  state: TSynced,
  mutate: (draft: TSynced) => void,
): TSynced => {
  const base = isDraft(state) ? (current(state) as TSynced) : state
  const next = createNextState(base, (draft) => {
    mutate(draft as TSynced)
  })

  return next.result?.type === 'error'
    ? { ...base, result: next.result }
    : next
}
```

- `createNextState` / `current` / `isDraft` は `@reduxjs/toolkit` から import する (immer を直接依存に追加しない)
- 移植元の同名 helper との差分を JSDoc に明記すること:
    - `draft.result = null` リセットは持たない (ADR-0013 の stamp が前提。リセットすると silent success 時に stamp 済み success を破壊するため)
    - error 時も draft を直接 mutate せず「base のコピー + error result」を返す (draft 無変更なら producer の値返却は immer 的に合法なため、成功/失敗どちらの経路も draft に触らない)
- JSDoc に利用契約と注意も明記:
    - reducer 内の状態変更はすべて mutate callback の中で行うこと。mutate 外で draft を変更してから呼ぶと、immer が「draft 変更 + 新値 return」を検出して throw する (host 上ではそれが reducer throw = 拒否裁定として扱われる)
    - state 全体のコピーが走るため高頻度 action では使わないこと

### 2-2. `src/index.ts` / `src/index.test.ts` へ export 追加

### 2-3. 新規テスト (`src/core/results.test.ts`)

1. success: mutate 内の複数 mutation が採用され、事前の stamp 済み success result が保持される
2. mutate 内で `stateWithResult` (success + message) → その result が保持される
3. mutate 途中で `stateWithError` → **全 mutation が巻き戻り**、error result だけが載る (domain field が base と一致すること)
4. RTK `createReducer` (immer producer) 内での利用: success / error 両経路が動く
5. plain object (非 draft、standalone フィクスチャ流) での利用: success / error 両経路
6. 契約違反の characterization: producer 内で draft を直接 mutate した後に呼び出し、success 経路で immer が throw すること

## Phase 3: ドキュメント更新 (完了条件)

- `docs/SPEC-0001-requests-sync.md`: 「reducer の作り方」節に result 再生成原則 (silent success は default success になる・残留 result は裁定に影響しない) を追記
- `docs/SPEC-0002-public-api.md`:
    - `createSynquxRootReducer` の config / 返り値の変更
    - API 表へ `stateWithDefaultResult` / `stateWithTransaction` を追加
    - primitive 方式の契約に「synced reducer 前段での stateWithDefaultResult 呼び出し義務」を追記
- `README.md` に reducer helper の節があれば追従 (なければ不要)

## 完了条件 (チェックリスト)

- [x] Phase 1–3 の全項目
- [x] `npm run fix` 通過
- [x] `npm test` 全緑 (demo 型検査含む)
- [x] git commit / push はしない (人間が判断する)
- [x] 会社名・移植元 repo 名などの固有情報をコード・コメント・ドキュメントに書かない (「移植元」と呼ぶ)
