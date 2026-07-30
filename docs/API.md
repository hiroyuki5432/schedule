# API 契約 (v1)

backend と frontend の結合契約。両者はこの定義に従う。SPEC.md がドメイン仕様の正本。

- ベース URL: `/api`
- 形式: JSON（UTF-8）
- 認証: **Cookie セッション**（HttpOnly）。ログインでセッション確立、以降は Cookie 同送。
- 日付: `YYYY-MM-DD`（週は月曜＝`week_start`）。
- 楽観ロック: 行・工数は `version`（整数）。不一致は `409 Conflict` + `{detail, current}`。
- エラー: `{ "detail": "..." }`、適切な HTTP ステータス。

## 認証
| メソッド | パス | 概要 |
|---|---|---|
| POST | `/api/auth/login` | body `{email, password}` → 200 `{user}` ＋ Set-Cookie。失敗 401 |
| POST | `/api/auth/logout` | 204 |
| GET | `/api/auth/me` | `{user}` / 未ログイン 401 |

`user = { id, name, email, role("admin"|"member"), org_id }`

## 組織・メンバー
| メソッド | パス | 概要 |
|---|---|---|
| POST | `/api/org/signup` | 公開。`{org_name, admin_name, admin_email, admin_password}` → 新組織＋管理者を作成し自動ログイン（空の週次シート1枚付き）。重複ID 409 |
| GET | `/api/org` | `{ id, name, slug, settings }`（settings: `week_start_weekday`=1..7 既定1=月, `app_title`=サイドバー表示名）|
| PATCH | `/api/org` | admin。`{name?, settings?}`（settings は浅いマージ）。グループ名・アプリ表示名の変更に使用 |
| GET | `/api/members` | `[{ id, name, email, role, worklog_required }]` |
| POST | `/api/members` | admin。`{name,email,password,role,worklog_required?}` → member。`email` はログインID（メール形式でなくても可）|
| PATCH | `/api/members/{id}` | admin。`{name?,role?,password?,worklog_required?}` |
| DELETE | `/api/members/{id}` | admin（自分自身は不可）|

## シート
`sheet = { id, name, order, has_week_grid, key_column_id, color_basis_column_id, settings }`
`settings = { pinned_columns?: int(左端固定列数, 既定1), default_milestones?: [{name,color}] }`
| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/sheets` | `[sheet]` |
| POST | `/api/sheets` | `{name, has_week_grid}` → sheet |
| GET | `/api/sheets/{id}` | `{ sheet, columns:[column], rows:[row] }`（まとめ取得。アクセス時に週次スナップショットを遅延生成）|
| PATCH | `/api/sheets/{id}` | `{name?,has_week_grid?,key_column_id?,color_basis_column_id?,order?,settings?}` |
| DELETE | `/api/sheets/{id}` | admin |

## 列
`column = { id, sheet_id, name, type, order, is_key, config }`
- `type`: `text | number | date | dropdown | status | member | lookup`
- `config`（type 別）:
  - dropdown: `{ options:[{value,color}] }`
  - status（条件付き・ルールビルダー）: `{ rules:[{ conditions:[{col_id,op,value}], label, color }] }`（上から最初の一致）
  - lookup: `{ target_sheet_id, match_key_column_id, return_column_id }`
  - member/date/text/number: 省略可

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/sheets/{id}/columns` | `[column]` |
| POST | `/api/sheets/{id}/columns` | `{name,type,config?,order?}` |
| PATCH | `/api/columns/{id}` | 部分更新 |
| DELETE | `/api/columns/{id}` | |

## 行
`row = { id, sheet_id, key_value, data:{col_id: value}, version }`
※ key_value はシート内で重複可（同一開発の再実施などで同じIDを使える）。lookup は先頭一致で解決。
| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/sheets/{id}/rows` | `[row]` |
| POST | `/api/sheets/{id}/rows` | `{key_value?, data}`（key_value 未指定なら採番ルールで自動）|
| PATCH | `/api/rows/{id}` | `{data, version}` → 更新後 row（409 で衝突）|
| DELETE | `/api/rows/{id}` | |
| DELETE | `/api/sheets/{id}/rows` | **admin**。シートの行・工数・マイルストン・スナップショットを全削除（列/設定は保持、採番は1にリセット）。`{deleted}` を返す |
| POST | `/api/org/clear-data` | **admin**。グループ内全シートに対し上記の全削除を実行。`{sheets, deleted}` を返す |

※ 週次グリッドのシートは初回アクセス時に **開始日 / 完了日** 列（`date`型・`config.sched_role='start'|'end'`）を自動生成し、旧 `__sched_start/__sched_end` 値を移行（追加のみ）。列一覧で並べ替え・固定・ソート可能。

## 週次工数 (effort)
`effort = { row_id, week_start, planned_hours, actual_hours, version }`
- 表示規則: 過去週=実績、現在週以降=予定（フロントで判定）。
- 値ゼロ/未入力の週は色を塗らない。
| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/sheets/{id}/effort?from=YYYY-MM-DD&to=YYYY-MM-DD` | `[effort]`（範囲省略時は全件）|
| PUT | `/api/rows/{rowId}/effort/{week_start}` | `{planned_hours?, actual_hours?, version?}` → upsert |
| PUT | `/api/effort/bulk` | `{items:[{row_id, week_start, planned_hours?, actual_hours?}]}` → `[effort]`。範囲貼り付け・一括クリア・その取り消しを1リクエストで書き込む。**version チェックなし（last-write-wins）**：範囲上書きは意図的な操作で、数百セル分の衝突解決をユーザーに求める方が害が大きいため。省略したフィールドは変更しない（予定の貼り付けが日報由来の実績を消さない）。全セルが変更履歴に残る |

## マイルストン（フェーズ境界・連続バーの色分け）
`milestone = { id, row_id, name, kind('phase'|'milestone'), boundary_date, color, order, done, actual_date }`
| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/rows/{rowId}/milestones` | `[milestone]` |
| PUT | `/api/rows/{rowId}/milestones` | `[milestone]`（全置換）|

## 変化点 / as-of スナップショット
- シート GET 時、現在週 > 直近スナップショット週なら遅延生成。
| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/sheets/{id}/snapshot?week=YYYY-MM-DD` | その週時点の計画（`{ rows, effort }`）。基準週(as-of)切替に使用 |
| GET | `/api/sheets/{id}/changes?week=YYYY-MM-DD` | 前週との差分 `[{row_id, field, old, new}]`（変化点）|

## 変更履歴（誰がいつ何を変えたか）
`row_event = { id, row_id, row_key, user_name, kind('create'|'update'|'delete'|'effort'), field_label, old_value, new_value, created_at }`
- スナップショット差分が「この2週間のどこかで変わった」しか言えないのに対し、こちらは**編集そのもの**を1件ずつ記録する。
- 値は記録時点の**表示用文字列**（メンバーIDは氏名、プルダウンは表示値）。`field_label` も記録時点の列名なので、列を改名・削除しても過去の履歴が読めなくならない。
- 行削除時は `row_id` が NULL になるが `row_key` にその時のタスクIDが残るため、削除自体も追跡できる。
- 内部キー（`__wk_*` など週次リセットの週スタンプ）は記録しない。

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/rows/{rowId}/history?limit=200` | そのタスクの全変更（新しい順）|
| GET | `/api/sheets/{id}/history?limit=200` | シート全体の最近の変更（新しい順）。「先週から何が変わった？」用 |

## 横断検索
`search_hit = { row_id, sheet_id, sheet_name, key_value, title, matched_field }`
- 組織内の全シートを対象に、タスクID と全属性値（JSONB を text にキャストして ILIKE）を検索。
- `matched_field` は値が一致した列名。ID 一致は `"ID"`、件名一致は `null`。ID/件名の一致が先頭に並ぶ。
- 上限 50 件。

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/search?q=...&limit=50` | `[search_hit]` |

## 集計（ダッシュボード）
| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/sheets/{id}/aggregate?group_by={col_id}&from=&to=` | `[{ group, planned_sum, actual_sum, count }]` |

## 日報（実績入力）
`work_log = { id, user_id, work_date, row_id, row_key_value, row_label, sheet_id, cat1, cat2, cat3, memo, hours }`
- **分類は段数・名称とも可変**（`org.settings.worklog.category_levels`、既定 `["大分類","中分類"]`、保存枠は `cat1..cat3` の最大3段）。項目そのものは `org.settings.worklog.categories`（段ごとに入れ子のツリー）。
- `row_label` / `TaskOption.label` は**シートごと**の `settings.worklog_task_columns`（列ID配列、`"__id__"`=タスクID）で組み立てた表示テキスト。未設定なら従来どおり ID＋件名。参照(LOOKUP)列はサーバ側で解決しないため対象外。

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/worklog?from=&to=&user_id=` | 自分（admin は `user_id` で他人も）の日報。既定は今週 |
| POST | `/api/worklog` | `{work_date, row_id?, cat1?, cat2?, cat3?, memo?, hours}` → 作成。リンク先タスクの週次実績を再計算 |
| PATCH | `/api/worklog/{id}` | 部分更新（本人 or admin）。実績を再計算 |
| DELETE | `/api/worklog/{id}` | 削除。実績を再計算 |
| GET | `/api/worklog/tasks` | 自分が担当のタスク `[{row_id, key_value, title, label, sheet_id, sheet_name}]` |
| GET | `/api/worklog/all?date=` | 全員の1日分（みんなの入力一覧）。メンバー別に合計付き |

## エクスポート / インポート
| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/sheets/{id}/export.csv` | CSV（属性列＋週次工数）|
| GET | `/api/sheets/{id}/export.xlsx` | Excel（属性列＋**進捗(%)/先行タスク(ID)**＋**テンプレ◇ごとの「予定/実績」列**＋週次工数）。開始日/完了日は実列なので通常列として出力。担当はメンバー名、先行タスクはID(key_value)で出力 |
| POST | `/api/sheets/{id}/import.xlsx/inspect` | **書き込みなし**の解析（既存シート用ウィザード）。multipart `file` ＋任意の `sheet_name` / `header_row` / `id_column` / `columns`。ワークシート一覧・見出し行の自動判定・プレビューに加え、各Excel列の**対応先**（同名の列／予約見出し／空=取り込まない）、選べる対応先一覧 `targets`、**新規/更新の行数**、変換できない値の件数を返す |
| POST | `/api/sheets/{id}/import.xlsx` | multipart `file`。ID(key_value)で照合し upsert（一致=更新 / 無い=新規）。`{created, updated}` を返す。週次セルは過去=実績・現在以降=予定。**進捗(%)** は行の進捗、**先行タスク(ID)** はID(key_value)で全行取込後に解決。**◇予定/実績**列が非空なら、テンプレ（既定マイルストン）に沿って行のマイルストンを再構築（フェーズ境界は開始日＋◇から復元、実績日があれば達成）。**参照(LOOKUP)列は無視**（出力は空欄）。ウィザードからは `sheet_name` / `header_row` / `id_column` / `columns`（JSON `[{index,name}]`＝Excel列→取り込み先の見出し名）を指定でき、省略時は従来どおり（先頭ワークシート・1行目=見出し・A列=ID・同名列に対応）|
| POST | `/api/sheets/import.xlsx/inspect` | **書き込みなし**の解析（取り込みウィザード用）。multipart `file` ＋任意の `sheet_name` / `header_row` / `id_column` / `has_week_grid` / `columns`。`{worksheets[], sheet_name, header_row, suggested_header_row, total_rows, preview[], columns[], blank_ids, duplicate_ids}` を返す。`columns[]` は各見出しの `role`（attr/week/progress/deps/milestone）・推定型・値の例・**変換できない値の件数**（`invalid`/`invalid_samples`）|
| POST | `/api/sheets/import.xlsx` | **新規シート**を作って取り込む。multipart `file` ＋ `name` / `has_week_grid` ／ウィザードの指定 `sheet_name`（ワークシート）・`header_row`（1始まり、既定=自動判定）・`id_column`（0始まり、`-1`=自動採番）・`columns`（JSON `[{index,name,type}]`）。`columns` 省略時は全列を型推定して取込。`{sheet_id, name, columns, created, updated}` を返す |
| GET | `/api/worklog/export.xlsx?from=&to=` | 全員の日報を範囲で Excel 出力（みんなの入力一覧）。列: 日付/ユーザー/タスクID/**分類の各段**/メモ/時間。分類の見出しは `org.settings.worklog.category_levels`（既定 大分類・中分類、最大3段）|
| POST | `/api/worklog/import.xlsx/inspect` | **admin・書き込みなし**。取り込み前の空実行。multipart `file` ＋任意の `sheet_name` / `header_row` / `mapping`。ワークシート一覧・見出し行・プレビュー・各項目（日付/ユーザー/タスクID/分類/メモ/時間）が読む列と、**追加/スキップ/重複の件数**と行ごとの理由 `issues` を返す。本番と同じ処理を空実行するのでプレビューの件数＝実際の結果 |
| POST | `/api/worklog/import.xlsx` | **admin**。multipart `file`（＋ウィザードの `sheet_name` / `header_row` / `mapping` JSON `{"user":1,"hours":6}`＝項目→列番号、0始まり・-1で不使用）。各行を新規の日報として追加（ユーザーは名前で照合、タスクはIDで照合）。分類列は設定した段の名前で照合し、`大分類/中分類/小分類` もフォールバックで受け付ける。`{created, skipped, duplicates}` を返す |

## 実装優先度
1. auth / org / members / sheets / columns / rows / effort / milestones（スケジュール画面が動く中核）
2. snapshot(as-of) / changes（変化点）
3. aggregate / export
未実装は 501 か空応答＋ `STATUS.md` 反映ではなく、コード内 `TODO` で明示。
