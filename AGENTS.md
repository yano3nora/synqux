# AGENTS - Development Guide
> https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/

## Overview
- synqux は Redux (Redux Toolkit) アプリに「クライアントホスト型のリアルタイム端末間同期」を後付けする npm ライブラリ (MIT 公開)
- client の action を「host への request」に変換し、host が reducer の試し実行で成否判定、全端末が host の決めた順序で action を適用することで同期を成立させる
- 由来は 5 年運用された社内ブラウザゲームテンプレートの同期基盤。**仕様の正は `docs/SPEC-0001-requests-sync.md`**（仕組み・不変条件・既知の問題・設計ガイドラインを含む）
- 移植元 repo (参照実装 + Phase 0 characterization tests) は社内 repo のため、パス等の具体情報は git 管理外の `CLAUDE.local.md` を参照
    - characterization tests のシナリオ（Phase 1 はこれを新 API 向けに書き直したものを仕様とする）と Phase 0 の記録も移植元側にある
- 第一の消費者は社内ゲーム repo 群。firebase realtime database を最初の transport とするが、core は特定インフラに依存しない

### 🎯 Role & Objective
あなたはエキスパートソフトウェアエンジニアとして、分散システムの失敗モード（重複配信・順序入れ替え・切断・時計ズレ）を前提に、このライブラリの設計・実装・テストを行うこと。

### 🚨 CRITICAL: Architecture
- **Reducer が唯一の判定器**: host は consumer から注入された rootReducer を試し実行し、`result.type` (`error` / `success`) で request の受理・拒否を判定する。成否判定ロジックを middleware や transport 層に分散させてはいけない
- **Transport 抽象**: core は「NoSQL な JSON を websocket で高速に sync できるインフラ」を interface として抽象化した transport にのみ依存する。firebase は adapter 実装の 1 つであり、core から firebase の型・API を import してはいけない
- **モジュール変数のグローバル状態は禁止**: 処理済みリスト (REVISIONS 相当) などの同期状態は、すべてファクトリが返すインスタンスの内部に持つ。移植元の module 変数方式はテスト困難・リロード時の暗黙リセットの温床だった（SPEC の既知の問題を参照）
- **at-least-once を前提に設計する**: transport のイベントは「重複する・遅れる・順序が入れ替わる・来ない」ものとして扱う。check-then-act の間に await を挟まない。挟むなら同期的な処理中ガードを先に立てる
- **YAGNI / framework 化しない**: 消費者は自社 repo 群のみ。仮想ユーザ向けの設定・プラグイン機構・過剰な柔軟性を追加しない。API 表面積の小ささが breaking change の少なさに直結する

### 📂 Code Organization Constraints
- **`src/core/`**: transport 非依存の同期ステートマシン（request/response、host 採番 seq による線形化、host 判定、snapshot/restore）
- **`src/firebase/`**: transport adapter 実装（当面は firebase のみ。subpath export `synqux/firebase`）
- **`src/testing/`**: 公開 API の一部として提供するテストユーティリティ（in-memory transport、重複/遅延/ドロップ注入、action 冪等性ハーネス）
- **`src/react/`**: ゲーム開発者層の読み取り hooks（subpath export `synqux/react`）
- **`demo/`**: firebase emulator での手動確認用 demo（npm 配布・build・CI 対象外）
- **型**: consumer の State / Action は generics で受ける。ライブラリ都合で `any` / `string` へ widen しない。境界でやむを得ない場合も「比較点・代入点だけを dirty にする」こと

### 🛠️ Workflow & Development Rules
- **Secrets**: 企業名・製品名・機密情報などがあった場合、コード上に残らないように汎用・一般名称に差し替えること。
- **Commit**: `git commit` は基本的には人間判断で行うため、指示されたとき以外はコミットせず人間に判断を委ねること。
- **Push / Publish**: `github push` や `npm publish` など、外部へ公開・配布する操作は Agent が実行しない。人間が判断して実行する。
- **Testing**: タスクを完了とする前に、必ず `npm test` を実行して変更の妥当性を検証すること
    - 同期挙動のテストは in-memory transport による決定的 simulation test を第一級とする。firebase emulator 依存のテストを増やさない
    - 分散制御のバグ修正は「そのバグを再現するテスト」を先に書いてから直す
- **Documentation**:
    - 技術的な意思決定や検討は `docs/ADR-XXXX-*.md` に記録し、大きな変更の前には既存 ADR を確認する
    - 設計・仕様の検討・決定事項は `docs/SPEC-XXXX-*.md` に記録する
    - 原則、全開発タスクが適切な粒度で `docs/TASK-YYMMDD-*.md` に残るようにする
        - 同期の仕組み・不変条件を変えたら `docs/SPEC-0001-requests-sync.md` を必ず更新する
    - 画像などは `docs/assets/` へ配置してリンクする
- **Versioning**: semver を厳守し CHANGELOG を保守する。消費者 repo は「テンプレは ^latest 追従、出荷済みプロジェクトは exact pin」で運用される前提

## Domains
- `request`
    - client の action を host へ判定依頼するための封筒。`requestedBy` / `result` と、裁定後は `(epoch, seq)` を持つ
- `response`
    - host による request への裁定。受理なら全端末が action を適用、拒否なら `result` の通知のみ
- `host`
    - 同期グループの単一権威。接続端末プールから決定的に導出され、離脱時は自動で移譲される (host migration)
- `seq` / `epoch`
    - host が裁定時に採番する適用順連番と host 世代番号 (fencing)。封筒に焼かれた seq が「実際に適用された順序」の ground truth であり、「appliedSeq + 1 を適用する」線形化の基盤 (ADR-0002)
- `snapshot`
    - host が永続化する同期対象 state の全量コピー。途中参加・リロード時の restore 起点
- `transport`
    - 同期インフラの抽象。request の push / 変更購読 / snapshot 永続化を提供する
