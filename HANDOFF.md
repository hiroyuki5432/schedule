# 引き継ぎ (HANDOFF) — 工数スケジュール管理アプリ

次の担当（AI/人）向けの現状まとめ。最終更新 2026-06-17。

## 0. まず読む順
1. このファイル（全体像・運用の落とし穴）
2. [SPEC.md](SPEC.md) — ドメイン仕様の正本（設計判断の経緯）
3. [STATUS.md](STATUS.md) — 実装チェックリスト（done/残）
4. [docs/API.md](docs/API.md) — REST 契約
5. [mockup/schedule.html](mockup/schedule.html) — デザイン基準（単体HTML）
6. [DEPLOY.md](DEPLOY.md) — 本番デプロイ（GitHub Actions → GHCR → EC2/Compose、host nginxでHTTPS終端）

## 1. 何のアプリか
単一組織・小規模チーム向けの「スケジュール＆工数管理」Web アプリ。
- 行＝管理対象（ID=key_value、例 P26-001）、列はユーザー定義（text/number/date/dropdown/status/member/lookup）。
- 1シートだけ週次グリッド（has_week_grid=true）：週ごとに予定/実績工数、フェーズ色の連続ガント、今日線、変化点。
- 他シートはテーブル型（集計・参照）。シートは左サイドバーに一覧＋「＋シート追加」。
- lookup 列で XLOOKUP 的参照（ID等で他シートを照合）。

## 2. スタック / 構成
- backend: FastAPI + SQLAlchemy2.0 + PostgreSQL（`backend/`）。Cookieセッション認証（SessionMiddleware）。
- frontend: React+Vite+TS + Tailwind + TanStack Query/Virtual（`frontend/`）。状態は React Query。
- 実行: Docker Compose（db / backend / frontend）。開発=Windows、本番想定=Ubuntu。
- 認証: メール+パスワード（管理者発行）。Admin/Member の2ロール、全データ org_id スコープ。

## 3. 起動・運用（重要な落とし穴）
```
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
docker compose up -d --build
```
- フロント http://localhost:5173 / API http://localhost:8000/docs / db :5432
- デモログイン: `admin@demo.local` / `demo1234`（メンバーは sato/tanaka/suzuki/yamamoto@demo.local も同PW）
- 初回起動で seed 投入（`SEED_ON_STARTUP=true`、orgが空のときだけ）。

### ⚠ Windows × Docker バインドマウントのホットリロード問題（最重要）
- **vite**: `frontend/vite.config.ts` に `server.watch.usePolling:true` を入れてある。これで概ね自動反映するが、**反映されない/古いまま**のときは `docker compose restart frontend`。
- **backend (uvicorn --reload)**: バインドマウントの fs イベントを拾えず**自動リロードしないことが多い**。backend を編集したら必ず `docker compose restart backend`。
- ブラウザ側もコード差し替え時は **Ctrl+Shift+R** で確実に。
- 「全然変わらない」と言われたら、まずこのリロード問題を疑うこと（過去に実際これだった）。

### ⚠ DBスキーマ変更
- 起動時は `Base.metadata.create_all` のみ＝**既存テーブルに列を追加しない**。
- 列追加は `backend/app/main.py` の lifespan で `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`（冪等・try/except）を追記する方式（例: row_milestones.done）。Alembic は未整備（要整備）。
- 作り直すなら `docker compose down -v`（pgdata 削除）→ up で再 seed。

## 4. データモデル（PostgreSQL, `backend/app/models.py`）
organizations / users / sheets / columns / rows / effort_entries / row_milestones / sheet_snapshots。
- rows.data = JSONB `{ "<column_id>": value }`。ID は rows.key_value（編集可）。**uniq制約なし＝同IDの重複可**（起動時に `uq_rows_sheet_key` を DROP）。lookupは先頭一致で解決。
- effort_entries: (row_id, week_start[月曜], planned_hours, actual_hours) UNIQUE(row_id,week_start)。**JSONは数値で返す**（EffortOut は float。Decimalだと文字列化してフロントが0扱いになるので注意）。
- row_milestones: (row_id, name, boundary_date, color, order, **done**)。連続バーの色＝各セグメントの milestone.color、ラベル＝name。
- columns.config（型別）: dropdown `{options:[{value,color}]}` / status `{rules:[...], auto_from_milestones?:bool}` / lookup `{target_sheet_id, local_key_column_id, match_key_column_id, return_column_id}`（各キーは `"__id__"` で key_value を指す）。
- sheets.settings JSONB: `{ pinned_columns?:int(左端固定列数, 既定1), default_milestones?:[{name,color}] }`。起動時 `ALTER TABLE sheets ADD COLUMN IF NOT EXISTS settings ...` で冪等追加。空DBは `{}`（フロントが既定値にフォールバック）。

## 5. 実装済み・検証済み（ブラウザ実機で確認）
- 認証/組織/メンバー、シートCRUD（サイドバー一覧＋追加＋削除＋インライン改名）、ルーティング `/sheets/:id`。
- スケジュール: 固定列=ID＋件名、属性(担当/ステータス/カスタム/予定計)は横スクロール、週は**全描画**（列仮想化は撤去）。**今日へ自動スクロール**。
- 週セル**直接入力**（クリック→input、Enter/blur保存）。過去=実績/現在以降=予定。**前週比の変化は赤字**。
- 連続ガント＋◇マイルストン（名称・色・**達成done**、達成で塗り）。**年バンド表示**＋範囲約3年＋「もっと前/後」。
- **ステータス**: 手動ドロップダウン編集／status列 `auto_from_milestones` で達成状況から自動判定（完了/遅延/進行中/未着手）。
- **lookup(XLOOKUP)**: ID/列で照合、ID同士の照合可。Review例で行ID=P26-001→AA=「認証基盤」を確認。
- **行ID(key_value)編集可**（テーブルのIDクリック）。**列の並べ替え**（設定）。**ソート**（ヘッダクリック昇順/降順）。
- **列順を全列（件名含む）で反映**＋**左端固定列数を設定で2段階指定**（`settings.pinned_columns`=広い画面 / `pinned_columns_narrow`=狭い画面、ID は常に最左固定。`useIsNarrow(900)`）。
- **既定マイルストン**をシート設定で定義（`settings.default_milestones`）。**各行のマイルストン色は同名の既定から自動継承**（◇編集に色ピッカーは無い／名前はドロップダウン）。**凡例は既定マイルストンのみ**表示。
- **変化点＝差分あれば赤**：工数＋属性列（status/担当/date/dropdown）を当週スナップショットと比較（`changedColIds`）。lookupは対象外。
- **シート削除はシート設定からのみ**（サイドバーの削除ボタンは撤去）。
- テーブル型シート（属性×行の編集テーブル、lookup解決表示）。ダッシュボード（簡易ピボット＋バー）、マイタスク、メンバー管理、シート設定（列CRUD＋プルダウン選択肢＋ステータスルールビルダー＋lookup設定）。
- CSVエクスポート（backend）。

## 6. 既知の課題・TODO（次にやると良い順）
1. **大量データ時の性能**: 週列を156週・全DOM描画（列仮想化を外した）。行が増えると重く、クリック直後の再描画が一瞬詰まる（CDPスクショがtimeoutするほど）。→ 週列の仮想化を「先頭オフセット(pinned+attr)を考慮した形」で再導入するか、表示ウィンドウを可変描画に。
2. **変化点の本実装（行データ側）**: 工数の赤字は「**現在の予定 vs 当週スナップショットの予定**」で実際の編集を検出する形に改善済み（`changedVsBaseline`、live時のみ）。ただし SPEC本来の「日付変更/行追加/列追加 等の行データ週次差分」(`sheet_snapshots`/`/changes`/`compute_changes`) は簡易のまま・UI未接続。`getChanges`/`ChangeEntry` は未使用で残置。工数の変化点は「当週スナップショット起点＝今週変えた分」を表す点に注意（前々週以前との比較ではない）。
3. **ステータスのルールビルダー**: 手書きルールの op に `overdue`/`done` 等があるが frontend 評価未対応。`auto_from_milestones` で代替中。整理する。
4. **Alembic 本番マイグレーション**整備（現状 create_all + lifespan ALTER）。
5. ダッシュボード/マイタスクは先頭シート固定（シート選択未対応）。Excel出力未（CSVのみ）。
6. 失敗時トースト未実装（`// TODO: toast` 多数）。lookup の循環参照ガード無し。
7. as-of（基準週スナップショット）は簡易。snapshot_service の差分検出を精緻化。

## 7. ディレクトリ早見
```
backend/app/
  main.py           FastAPI起動・SessionMiddleware・lifespan(create_all + ALTER + seed)
  models.py schemas.py security.py db.py seed.py deps.py snapshot_service.py weeks.py
  routers/ auth org members sheets columns rows effort milestones snapshots aggregate export
frontend/src/
  api/client.ts            全エンドポイント呼び出し
  lib/ gantt.ts(週セルモデル・色) status.ts(バッジ/ルール/auto) lookup.ts(参照解決) dates.ts
  hooks/ useScheduleData useEffortMutation useRowMutation useSheets useLookupTargets useAuth
  components/schedule/ GanttGrid(コア) MilestoneEditor InlineCell Legend
  components/settings/ StatusRuleBuilder DropdownOptionsEditor LookupConfigEditor
  pages/ SchedulePage SheetPage TableSheetView SheetSettingsPage Dashboard Members MyTasks Login
```

## 8. 検証手順（スモーク）
```
docker compose up -d --build
# API: login → /api/sheets → /api/sheets/1（columns/rows）→ /api/sheets/1/effort（数値で返る事）
# 画面: http://localhost:5173 で admin@demo.local/demo1234 →
#   スケジュール: 週セルに数値入力が即反映 / 今日線 / 年バンド / ソート
#   Review(テーブル): ID編集 / AA(lookup)が解決 / 列並べ替え(設定)
```
編集してUIが変わらない時は §3 のリロード問題を最初に疑う。
