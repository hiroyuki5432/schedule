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

## 週次工数 (effort)
`effort = { row_id, week_start, planned_hours, actual_hours, version }`
- 表示規則: 過去週=実績、現在週以降=予定（フロントで判定）。
- 値ゼロ/未入力の週は色を塗らない。
| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/sheets/{id}/effort?from=YYYY-MM-DD&to=YYYY-MM-DD` | `[effort]`（範囲省略時は全件）|
| PUT | `/api/rows/{rowId}/effort/{week_start}` | `{planned_hours?, actual_hours?, version?}` → upsert |

## マイルストン（フェーズ境界・連続バーの色分け）
`milestone = { id, row_id, name, boundary_date, color, order }`
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

## 集計（ダッシュボード）
| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/sheets/{id}/aggregate?group_by={col_id}&from=&to=` | `[{ group, planned_sum, actual_sum, count }]` |

## エクスポート / インポート
| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/sheets/{id}/export.csv` | CSV（属性列＋週次工数）|
| GET | `/api/sheets/{id}/export.xlsx` | Excel（属性列＋週次工数。担当はメンバー名で出力）|
| POST | `/api/sheets/{id}/import.xlsx` | multipart `file`。ID(key_value)で照合し upsert（一致=更新 / 無い=新規）。`{created, updated}` を返す。週次セルは過去=実績・現在以降=予定で取込。**参照(LOOKUP)列は計算列のため取込時に無視**（出力は空欄）|
| GET | `/api/worklog/export.xlsx?from=&to=` | 全員の日報を範囲で Excel 出力（みんなの入力一覧）。列: 日付/ユーザー/タスクID/大分類/中分類/メモ/時間 |
| POST | `/api/worklog/import.xlsx` | **admin**。multipart `file`。各行を新規の日報として追加（ユーザーは名前で照合、タスクはIDで照合）。`{created, skipped}` を返す |

## 実装優先度
1. auth / org / members / sheets / columns / rows / effort / milestones（スケジュール画面が動く中核）
2. snapshot(as-of) / changes（変化点）
3. aggregate / export
未実装は 501 か空応答＋ `STATUS.md` 反映ではなく、コード内 `TODO` で明示。
