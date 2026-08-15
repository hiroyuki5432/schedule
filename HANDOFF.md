# 引き継ぎ (HANDOFF) — 工数スケジュール管理アプリ

次の担当（AI/人）向けの現状まとめ。最終更新 2026-06-24。

## 0. まず読む順
1. このファイル（全体像・運用の落とし穴）
2. [CLAUDE.md](CLAUDE.md) — 触る前のチェックリスト（テストの走らせ方・Excel取り込みで実際に壊した13件）
3. [SPEC.md](SPEC.md) — ドメイン仕様の正本（設計判断の経緯）
4. [STATUS.md](STATUS.md) — 実装チェックリスト（done/残）
5. [docs/API.md](docs/API.md) — REST 契約
6. [mockup/schedule.html](mockup/schedule.html) — デザイン基準（単体HTML）
7. [DEPLOY.md](DEPLOY.md) — 本番デプロイ（GitHub Actions → GHCR → EC2/Compose、host nginxでHTTPS終端）

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
- フロント http://localhost:5173 / API http://localhost:8100/docs / db :5432
- デモログイン: `admin@demo.local` / `demo1234`（メンバーは sato/tanaka/suzuki/yamamoto@demo.local も同PW）
- ログインIDは**メール形式でなくても可**（`@` 不要。backend は単なる文字列として扱う）。
- ログイン画面の「**新しいグループを作成する**」から、組織＋管理者を自分で作成できる（`POST /api/org/signup`、作成後に自動ログイン＋空の週次シート1枚を用意）。
- メニュー「**グループ管理**」（旧メンバー管理, ルートは `/members`）で、メンバー管理に加え**グループ名**と**アプリ表示名**（`org.settings.app_title`、サイドバー上部・グループごと）を編集。
- **Excel入出力**（`backend/app/routers/excel.py`、`openpyxl`）: `GET .../export.xlsx` / `POST .../import.xlsx`。インポートは ID で upsert、属性＋週次工数（過去=実績/未来=予定）。フロントは [ExcelToolbar.tsx](frontend/src/components/ExcelToolbar.tsx)。
- **実績入力の分類（段数可変）**: 段の名称は `org.settings.worklog.category_levels`（既定 `["大分類","中分類"]`、最大3段＝`work_logs.cat1..cat3`）、項目は `worklog.categories` の入れ子ツリー。フロントは [lib/worklogCats.ts](frontend/src/lib/worklogCats.ts) 経由で扱い、編集は [WorklogMasterEditor.tsx](frontend/src/components/worklog/WorklogMasterEditor.tsx)（実績入力の「分類の設定」、管理者のみ）。**cat3 追加のマイグレーションあり（0012）→ backend 再起動で自動適用**。
- **タスク表示列**: シートの `settings.worklog_task_columns`（列ID配列 / `"__id__"`=ID）。バックエンドが `TaskOption.label` と `WorkLogOut.row_label` を組み立てる（[worklog.py](backend/app/routers/worklog.py) の `_label_keys` / `_task_label`）。設定UIはシート設定の「実績入力でのタスク表示」。
- **取り込みウィザードは3種類で共通**: 解析（書き込みなし）の `*/inspect` → 確定の import という2段構え。共通の xlsx 読み取りは [xlsx_import.py](backend/app/xlsx_import.py)、UIの共通部分は [WizardShell.tsx](frontend/src/components/import/WizardShell.tsx) と [SourceStep.tsx](frontend/src/components/import/SourceStep.tsx)。実装は ①新規シート [ImportSheetWizard.tsx](frontend/src/components/ImportSheetWizard.tsx) ②既存シート [ImportRowsWizard.tsx](frontend/src/components/import/ImportRowsWizard.tsx)（ExcelToolbar から起動）③日報 [ImportWorklogWizard.tsx](frontend/src/components/import/ImportWorklogWizard.tsx)（みんなの入力一覧から起動、管理者のみ）。日報の件数は `_plan_worklog_import` の空実行で出すので、プレビューと本番が必ず一致する。
- **シート新規作成の取り込みウィザード**: 「シート追加」で .xlsx を選ぶと [ImportSheetWizard.tsx](frontend/src/components/ImportSheetWizard.tsx) に遷移し、ワークシート／見出し行／ID列 → 取り込む列（列名・型の変更可）→ プレビューと警告、の順で確認してから作成。解析は書き込みなしの `POST /api/sheets/import.xlsx/inspect`（同じ引数を渡すと選択内容で再検証）、確定は `POST /api/sheets/import.xlsx`（`sheet_name` / `header_row` / `id_column` / `columns` JSON）。
- **完全オフライン**: フロントの Google Fonts CDN を撤去（端末標準フォントにフォールバック）。運用中の外部アクセスは無し。**openpyxl を追加したので backend は要リビルド**（`up -d --build`）。
- 初回起動で seed 投入（`SEED_ON_STARTUP=true`、orgが空のときだけ）。

### ⚠ Windows × Docker バインドマウントのホットリロード問題（最重要）
- **vite**: `frontend/vite.config.ts` に `server.watch.usePolling:true` を入れてある。これで概ね自動反映するが、**反映されない/古いまま**のときは `docker compose restart frontend`。
- **backend (uvicorn --reload)**: バインドマウントの fs イベントを拾えず**自動リロードしないことが多い**。backend を編集したら必ず `docker compose restart backend`。
- ブラウザ側もコード差し替え時は **Ctrl+Shift+R** で確実に。
- 「全然変わらない」と言われたら、まずこのリロード問題を疑うこと（過去に実際これだった）。

### ⚠ DBスキーマ変更
- **Alembic 整備済み**。`backend/alembic/versions/`（initial + 0002〜0009）。起動時に `entrypoint.sh` が pre-Alembic の既存DBを baseline に stamp してから `alembic upgrade head` する。
- 列・テーブル追加は新しい Alembic リビジョンを足す（過去の lifespan ALTER 方式は廃止）。
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
4. ダッシュボード/マイタスクは先頭シート固定（シート選択未対応）。Excel出力未（CSVのみ）。
5. lookup の循環参照ガード無し。（失敗時トーストは実装済み: `lib/toast.ts` + `Toaster.tsx`。Alembic も整備済み。）
7. as-of（基準週スナップショット）は簡易。snapshot_service の差分検出を精緻化。

## 7. ディレクトリ早見
```
backend/app/
  main.py           FastAPI起動・SessionMiddleware・lifespan(create_all + ALTER + seed)
  models.py schemas.py security.py db.py seed.py deps.py snapshot_service.py weeks.py
  routers/ auth org(+/signup) members sheets columns rows effort milestones snapshots aggregate export excel(xlsx入出力) worklog notifications
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
