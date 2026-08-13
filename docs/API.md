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
`sheet = { id, name, order, has_week_grid, is_master, key_column_id, color_basis_column_id, settings }`
※ `is_master`=true は**マスタシート**（参照(LOOKUP)/数式の元にする一覧）。API は普通のシートと同じ／一覧にも出るが、画面側でサイドバーの「シート」やダッシュボード等のシート選択からは外れ、「マスタ」からのみ開ける。
`settings = { pinned_columns?: int(左端固定列数, 既定1), default_milestones?: [{name,color}] }`
| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/sheets` | `[sheet]` |
| POST | `/api/sheets` | `{name, has_week_grid, is_master?}` → sheet |
| GET | `/api/sheets/{id}` | `{ sheet, columns:[column], rows:[row] }`（まとめ取得。アクセス時に週次スナップショットを遅延生成）|
| PATCH | `/api/sheets/{id}` | `{name?,has_week_grid?,is_master?,key_column_id?,color_basis_column_id?,order?,settings?}` |
| DELETE | `/api/sheets/{id}` | admin |

## 列
`column = { id, sheet_id, name, type, order, is_key, config }`
- `type`: `text | number | date | dropdown | status | member | lookup | formula`
- `lookup` と `formula` は**計算列**（値を保存しない・手入力不可・Excel の書き出しは空欄／取り込みは対象外）。解決はフロント側で行う。
- `config`（type 別）:
  - dropdown: `{ options:[{value,color}] }`
  - status（条件付き・ルールビルダー）: `{ rules:[{ conditions:[{col_id,op,value}], label, color }] }`（上から最初の一致）
  - lookup: `{ target_sheet_id, match_key_column_id, return_column_id }`
  - formula: `{ expr, decimals? }` — `expr` は同じ行の列を**名前**で参照する式（例 `[単価] * [数量]`、`[完了日] - [開始日]`）。`[ID]` は行のキー値。使える関数は IF/IFERROR/AND/OR/NOT/ISBLANK/SUM/AVERAGE/COUNT/MIN/MAX/ABS/INT/ROUND/ROUNDUP/ROUNDDOWN/LEN/LEFT/RIGHT/MID/CONCAT/TRIM/TODAY/DAYS/DATE/YEAR/MONTH/DAY。日付−日付＝日数、日付±数値＝日付。`decimals` は表示桁数。**列名を変更すると同じシートの式も自動で書き換わる**
  - member/date/text/number: 省略可
- 日付列の保存形は常に `YYYY-MM-DD`。行の作成・更新時にサーバ側で揃える（`2025/10/18`・`2025年10月18日`・`2025-10-18 00:00:00` を受け付け、時刻は落とす）。日付として読めない値（「未定」など）は消さずそのまま保存。
- `PATCH /api/columns/{id}` に `type:"date"` を送ると、その列の**既存の値も**同じ規則で揃え直す（取り込みで時刻つきになった列の修復。シート設定の「値を日付に揃える」がこれ）

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/sheets/{id}/columns` | `[column]` |
| POST | `/api/sheets/{id}/columns` | `{name,type,config?,order?}` |
| PATCH | `/api/columns/{id}` | 部分更新。`value_remap`（`{"旧の値": "新しい値"}`、値 `null` で空にする）を添えると、保存と同時に**その値が入っている行**も書き換える。プルダウンの選択肢を削るとき「その行をどこにあてがうか」を選ぶための指定（選択肢の*改名*は `options[].id` で自動追従するので不要）|
| DELETE | `/api/columns/{id}` | |

## 行
`row = { id, sheet_id, key_value, data:{col_id: value}, version }`
※ key_value はシート内で重複可（同一開発の再実施などで同じIDを使える）。lookup は先頭一致で解決。計算列（lookup/formula）の値は `data` に入らない。
| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/sheets/{id}/rows` | `[row]` |
| POST | `/api/sheets/{id}/rows` | `{key_value?, data}`（key_value 未指定なら採番ルールで自動）|
| PATCH | `/api/rows/{id}` | `{data, version}` → 更新後 row（409 で衝突）|
| DELETE | `/api/rows/{id}` | |
| DELETE | `/api/sheets/{id}/rows` | **admin**。シートの行・工数・マイルストン・スナップショットを全削除（列/設定は保持、採番は1にリセット）。`{deleted}` を返す |
| POST | `/api/org/clear-data` | **admin**。グループ内全シートに対し上記の全削除を実行。`{sheets, deleted}` を返す |
| POST | `/api/sheets/{id}/replace` | **一括置換**。`{column_id?, find, replace, whole_cell?, case_sensitive?, include_key?, include_options?, dry_run?}` → `{rows, cells, options, applied, samples[]}`。`column_id` 省略＝このシートの全列、`"__id__"`＝ID(key_value) だけ。`dry_run` は**既定 true**（何も書かずに件数と before/after の例を返す）。計算列（lookup/formula）は対象外（単独指定は 400）。`include_options`（既定 true）でプルダウンの**選択肢そのもの**も同じ規則で置換し、重複した選択肢は畳む。数値列・日付列は置換後に保存形へ戻す。変更は1セル1件で変更履歴に残る |

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
| POST | `/api/sheets/{id}/import.xlsx/inspect` | **書き込みなし**の解析（既存シート用ウィザード）。multipart `file` ＋任意の `sheet_name` / `header_row` / **`last_row`** / **`tail_from`** / `id_column` / `columns`。任意の **`match_mode`**（`none`/`id`/`replace`）。ワークシート一覧・見出し行の自動判定・**先頭プレビュー(`preview`)と末尾プレビュー(`tail_preview`)**・`last_row` / `sheet_last_row` / `available_rows`（切らなかった場合の行数）に加え、各Excel列の**対応先**（同名の列／予約見出し／空=取り込まない）、選べる対応先一覧 `targets`、**新規/更新の行数**（`match_mode` に従う。`replace` は消える行数 `deleted_rows` も）、変換できない値の件数を返す。取り込み先に指定されていても**実際には書けない**列（改名/削除された、または計算列になった）は `target` を空にしたうえで `lost_target` / `lost_reason`(`computed`\|`missing`) で理由を返す — 件数が黙って合わなくなるのを防ぐため |
| POST | `/api/sheets/{id}/import.xlsx` | multipart `file`。**`match_mode`** で行の照合を選ぶ（`none`=照合しない・Excelの1行がそのまま1行／`id`=ID(key_value)で照合して upsert／`replace`=取り込む前にシートの行を全部消す）。**省略時は従来どおり**「ID列があれば照合」に解決する（ウィザードは常に明示的に送り、既定は `none`）。`replace` のときだけ `{deleted}` も返す。`{created, updated}` を返す。週次セルは過去=実績・現在以降=予定。**進捗(%)** は行の進捗、**先行タスク(ID)** はID(key_value)で全行取込後に解決。**◇予定/実績**列が非空なら、テンプレ（既定マイルストン）に沿って行のマイルストンを再構築（フェーズ境界は開始日＋◇から復元、実績日があれば達成）。**参照(LOOKUP)列は無視**（出力は空欄）。ウィザードからは `sheet_name` / `header_row` / **`last_row`** / `id_column` / `columns`（JSON `[{index,name}]`＝Excel列→取り込み先の見出し名）を指定でき、省略時は従来どおり（先頭ワークシート・1行目=見出し・A列=ID・同名列に対応）。`last_row` は**取り込む最終行**（1始まり・その行を含む、`0`=最後まで）。末尾の合計行・注記・別表を切り落とすための指定で、空行を詰める前の**物理行番号**に対して効く（プレビューでクリックした行番号がそのまま効く）|
| POST | `/api/sheets/import.xlsx/inspect` | **書き込みなし**の解析（取り込みウィザード用）。multipart `file` ＋任意の `sheet_name` / `header_row` / **`last_row`** / **`tail_from`** / `id_column` / `has_week_grid` / `columns`。`{worksheets[], sheet_name, header_row, suggested_header_row, last_row, sheet_last_row, total_rows, available_rows, preview[], tail_preview[], columns[], blank_ids, duplicate_ids}` を返す。`tail_preview` は**末尾側の窓**（見出し行より上には出ない・1回最大300行）で、「これ以降を取り込まない」を選ぶためのもの。既定は末尾15行だが、`tail_from`（1始まり）でその行から開くことができ（「さらに上を表示」）、`last_row` が指定されていれば**その手前まで窓が自動で広がる**ので、数値入力した最終行も必ず目視できる。`columns[]` は各見出しの `role`（attr/week/progress/deps/milestone）・推定型・値の例・**変換できない値の件数**（`invalid`/`invalid_samples`）|
| POST | `/api/sheets/import.xlsx` | **新規シート**を作って取り込む。multipart `file` ＋ `name` / `has_week_grid` ／ウィザードの指定 `sheet_name`（ワークシート）・`header_row`（1始まり、既定=自動判定）・**`last_row`**（取り込む最終行、1始まり・その行を含む、`0`=最後まで）・`id_column`（0始まり、`-1`=自動採番）・**`match_mode`**（`none`/`id`。新しいシートなので効くのは「ファイル内で同じIDの行をまとめるかどうか」だけ）・`columns`（JSON `[{index,name,type}]`）。`columns` 省略時は全列を型推定して取込。`{sheet_id, name, columns, created, updated}` を返す |
| GET | `/api/worklog/export.xlsx?from=&to=` | 全員の日報を範囲で Excel 出力（みんなの入力一覧）。列: 日付/ユーザー/タスクID/**分類の各段**/メモ/時間。分類の見出しは `org.settings.worklog.category_levels`（既定 大分類・中分類、最大3段）|
| POST | `/api/worklog/import.xlsx/inspect` | **admin・書き込みなし**。取り込み前の空実行。multipart `file` ＋任意の `sheet_name` / `header_row` / **`last_row`** / **`tail_from`** / `mapping`。ワークシート一覧・見出し行・先頭/末尾プレビュー・各項目（日付/ユーザー/タスクID/分類/メモ/時間）が読む列と、**追加/スキップ/重複の件数**と行ごとの理由 `issues` を返す。本番と同じ処理を空実行するのでプレビューの件数＝実際の結果 |
| POST | `/api/worklog/import.xlsx` | **admin**。multipart `file`（＋ウィザードの `sheet_name` / `header_row` / **`last_row`** / `mapping` JSON `{"user":1,"hours":6}`＝項目→列番号、0始まり・-1で不使用）。各行を新規の日報として追加（ユーザーは名前で照合、タスクはIDで照合）。分類列は設定した段の名前で照合し、`大分類/中分類/小分類` もフォールバックで受け付ける。`{created, skipped, duplicates}` を返す |

## 取り込み設定（プリセット）と一括取り込み
シートの多いブックを毎回設定し直さずに済むように、取り込みが成功するとその設定が
**ワークシート名をキーに**保存される（組織で共有）。2回目以降は同じファイルを選んで
一括実行するだけで更新できる。

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/import/presets` | 保存済みの取り込み設定一覧（組織単位）|
| POST | `/api/import/presets` | 設定の保存（`worksheet_name` で upsert）。`{worksheet_name, name, workbook_name, target_sheet_id, target_sheet_name, has_week_grid, header_row, last_row, id_column, match_mode, mapping}`（`last_row`＝取り込む最終行、`0`=最後まで。`match_mode`＝行の照合。空文字はこの設定より前に保存されたもので、読むときに ID列の有無から従来の意味に解決される）。`target_sheet_id` が `null` なら取り込み時に新規シートを作る。取り込み先シートを削除しても設定は残り（`target_sheet_id` が `null` になる）「新規作成」に降格する |
| DELETE | `/api/import/presets/{id}` | 設定を削除（204）|
| POST | `/api/import/workbook/inspect` | **書き込みなし**。multipart `file` ＋任意 `plan`（JSON）。ブック内の全ワークシートを設定に突き合わせ、`{workbook_name, worksheets[]}` を返す。各要素は `action`（existing/new/skip）・`target_sheet_id` ・`header_row` ・`last_row` ・`total_rows` ・`available_rows` ・`column_count` ・`match_mode`・**新規/更新の行数**（`replace` なら `deleted_rows` も）・`invalid`・`warnings[]`・`error`。**設定の無いワークシートは既定で `skip`**（ブックを投げただけでシートが量産されない）。`has_week_grid` は前回の設定 or `plan` の指定が優先され、どちらも無ければ**見出し行から推測**（週の日付列・進捗(%)・◇（予定/実績）があればスケジュール形式、無ければテーブル形式）|
| POST | `/api/import/workbook` | ブックを**1トランザクション**で一括取り込み。multipart `file` ＋ `plan`（JSON `[{worksheet, action, target_sheet_id, target_sheet_name, has_week_grid, header_row, last_row, id_column, match_mode, columns}]`）＋ `save_presets`（既定 true）。どれか1つでも失敗したら**全部ロールバック**。成功時は各ワークシートの設定を「実際に入ったシート」を指す形で保存し直すので、初回=新規作成→次回=更新 になる。`{results[], created, updated, deleted}` を返す |

## バックアップ / 復元（管理者のみ）
グループ丸ごとの論理バックアップ。**主キーを含めてそのまま保存し、復元時も同じIDで書き戻す**。
理由: `rows.data` は列IDがキー、参照(LOOKUP)列の `config` はシート/列ID、`sheets.settings`
の `worklog_task_columns`・`key_column_id`・ステータスルールの `col_id`・完了条件 なども
すべてIDを持つため、採番し直すと JSONB 内の参照を全部書き換える必要があり、漏れると
「シートは開くが別の列を見ている」という壊れ方を静かに起こす。IDを保つことでこれを回避する。

- 対象: `users` / `sheets` / `columns` / `rows` / `effort_entries` / `row_milestones` /
  `sheet_snapshots` / `work_logs` / `row_events` / `import_presets`、および組織の `name` / `settings`。
- 対象外: `notifications`（派生データ。開き直すと再生成）、`backups` 自身（復元で消えると戻せなくなるため）。
- **同じグループにしか復元できない**（IDをそのまま書き戻すため、他グループと衝突する）。
- 復元は1トランザクション。実行前に「復元前の自動バックアップ」を自動取得する。
- 復元後は各テーブルの id シーケンスを `max(id)+1` に再設定する（しないと次の INSERT が重複キーで落ちる）。

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/backups` | 一覧（新しい順）。`{id,label,format_version,summary,size_bytes,created_at,created_by_name}`。payload は返さない |
| POST | `/api/backups` | `{label?}` → 現在の状態を保存 |
| GET | `/api/backups/{id}/download` | .json としてダウンロード（DB ごと失った場合の戻し口）|
| DELETE | `/api/backups/{id}` | 削除（204）|
| POST | `/api/backups/{id}/restore` | この時点に完全復元。`{restored_from, counts, safety_backup_id, signed_out}` を返す。`signed_out` は「復元後のデータに自分のアカウントが無い」= このセッションが無効になったことを示す |
| POST | `/api/backups/restore-file` | multipart `file`（ダウンロードした .json）から復元。同上 |

復元は次を拒否する: 形式バージョン不一致 / 別グループのバックアップ / 管理者アカウントを含まないバックアップ（復元後にグループを管理できなくなるため）。

## データのお掃除（管理者のみ）
画面から行やシートを消しても消えないものがある — 変更履歴・週次スナップショット・
既読の通知・**消した列の値**（`rows.data` に列IDのまま残り、画面のどこにも出ない）・
予定も実績も無い工数セル・古いバックアップ。溜まり続けるので、見てから消せるようにする。

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/maintenance/usage` | **admin**。`?row_events_keep_days=&snapshots_keep_weeks=&backups_keep=`（既定 365/52/10）。`{database_bytes, tables[{name,label,rows,bytes}], cleanable{...}}`。`rows` はこのグループの件数、`bytes` は**サーバ全体**のテーブルサイズ（Postgres 以外では `null`）|
| POST | `/api/maintenance/cleanup` | **admin**。`{row_events_keep_days?, snapshots_keep_weeks?, notifications_read?, orphan_cells?, legacy_cells?, empty_effort?, backups_keep?, dry_run?}` → `{dry_run, deleted{...}, total}`。`dry_run` は**既定 true**。日数/週数/件数は `null` なら「触らない」。1トランザクション。`legacy_cells` は 開始日/完了日 の移行前の値のうち**実列に同じ値が入っているコピーだけ**を消す（実列が空なら残す）|

## 実装優先度
1. auth / org / members / sheets / columns / rows / effort / milestones（スケジュール画面が動く中核）
2. snapshot(as-of) / changes（変化点）
3. aggregate / export
未実装は 501 か空応答＋ `STATUS.md` 反映ではなく、コード内 `TODO` で明示。
