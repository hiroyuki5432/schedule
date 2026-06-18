# 実装状況 / 残作業

最終更新: 2026-06-16（編集機能＋サイドバーのシート化まで実装・検証）

## 完了・検証済み
- [x] SPEC（[SPEC.md](SPEC.md)）／デザイン基準モック（[mockup/schedule.html](mockup/schedule.html)）
- [x] ルート足場: docker-compose / .env.example / README / API 契約
- [x] backend（FastAPI + SQLAlchemy + Postgres + 全API + seed）
- [x] frontend（Vite + React + Tailwind）
- [x] `docker compose up --build` 実機検証 OK（db/backend/frontend、ログイン〜工数まで通し）
- [x] **編集機能の実装**（tsc 通過・ライブAPI検証済み）
  - サイドバーに**シート一覧＋「＋シート追加」**（スケジュール型/テーブル型）。`/sheets/:id` ルーティング
  - 工数セル編集が**確実に反映**（フェーズ外の週でも入力が見えるよう表示修正＝中立色）
  - 件名・担当の**インライン編集**（行 PATCH）、新規行
  - 行ごとの**マイルストン編集**（境界日付・色）→ ガント再描画
  - シート設定: **列CRUD＋プルダウン選択肢／ステータスのルールビルダー／lookup設定**、キー列・色基準列
  - テーブル型シートの**編集テーブル**（属性列×行）

## 起動 / 確認
```
docker compose up -d --build
```
- フロント: http://localhost:5173 （admin@demo.local / demo1234）
- ※ コード反映のため、ブラウザは**ハードリフレッシュ**（Ctrl+Shift+R）

## 追加修正（フィードバック対応, 2026-06-16 後半）
- [x] backend: 工数を**数値**で返す（Decimal→float。文字列化で表示/編集不能だった主因）
- [x] 工数は**セル直接入力**（モーダル廃止）＋反映、数値パース頑健化（過去=実績/今日以降=予定、境界週フォールバック）
- [x] **設定で追加した列をグリッドに動的表示**（固定列ハードコードを撤廃）
- [x] **削除**: 行 / 列 / シート（確認つき）
- [x] **シート名のインライン改名**（年重複の撤去）
- [x] **絞り込み**（担当/ステータス/件名）
- [x] **モバイル対応**（サイドバーをドロワー化＋ハンバーガー）
- [x] **今日線/ラベルの重なり修正**（z-index・固定列上に出さない）
- [x] **凡例を動的化**（実データのフェーズ＋遅延）＋ヘルプ
- 「全然変わらない」の真因＝**Windows×Dockerバインドマウントで vite が変更未検知**（古い配信）。`vite.config.ts` に `watch.usePolling` を追加＋再起動で解消（以後の編集は自動反映）
- グリッド再設計: **固定=ID＋件名のみ**、担当/ステータス/カスタム/予定計は横スクロール、初期表示は**今日へ自動スクロール**。列仮想化は撤去（54週は素描画）
- ステータス表示修正（保存実値を優先＝進行中/遅延/完了 が正しく出る）
- **ブラウザ実機で検証済**: ガント表示・直接入力の反映・今日線・動的列・シート追加(スケジュール/テーブル)・遷移

## 追加修正（フィードバック対応 第3弾, 2026-06-17）
- [x] **XLOOKUP を ID で照合**：lookup設定を4項目化（対象シート / このシートのキー / 照合する対象列 / 取得する対象列、各「ID」選択可）。リゾルブ修正。**行ID(key_value)を編集可能化**（backend PATCH + テーブルでインライン編集）。実機検証: Review行ID=`P26-001`→AA=「認証基盤」(開発スケジュールからID参照) ✓
- [x] **ステータスを編集可能**に（バッジをクリック→候補ドロップダウン、保存値を表示。全部「未着手」バグ解消）
- [x] **編集時に列幅が変わらない**（box-border幅・table-fixed）
- [x] **今日線を明確化**（2px・var(--today)・週セルの上、キャプション色も統一）
- [x] **マイルストン編集の導線明示**（行ID横◇に「フェーズ（マイルストン）を編集」ツールチップ）。※現状の色/遅延はseed初期値＋今日基準の自動計算
- 注: マイルストンは各行ごと（◇から日付・色を編集）。ステータスは行に保存した値（ルールは未対応opあり）

## 追加修正（フィードバック対応 第4弾, 2026-06-17）
- [x] **ソート**：列ヘッダクリックで昇順→降順→解除（スケジュール固定列＋テーブル）
- [x] **シート設定で列の並べ替え**（上下ボタン→order を PATCH）
- [x] **年表示バンド**＋**表示範囲を約3年(156週)に拡張**＋「もっと前/もっと後」操作
- [x] **凡例・バー色をユーザーのマイルストンのみ**から生成（ハードコードの設計/実装…taxonomy撤廃）
- [x] **マイルストンに名称＋「達成」フラグ**（done）。◇は達成で塗り、ホバーで名称表示。backend: row_milestones.done 追加＋起動時 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS done`
- [x] **ステータスをマイルストン達成から自動判定**（status列 config.auto_from_milestones）。完了/遅延/進行中/未着手を算出
- [x] **変化点＝前週比の赤字**（週次予定が前週と異なる/新規はアクセント色、クライアント計算）
- ⚠ 156週×行をDOM全描画（列仮想化を外したまま）→ 大量行で重い。再導入推奨（HANDOFF.md 参照）

## 追加修正（フィードバック対応 第5弾, 2026-06-17）
- [x] **列の並べ替えが反映されない**を解消：スケジュール表は固定で「ID＋件名」を強制ピンしていたため、設定で担当を上に動かしても見た目が変わらなかった。**全列（件名含む）を `order` 通りに描画**し、**左端固定列数をシート設定 `settings.pinned_columns` で指定**できるよう変更（既定1＝従来の見た目）。ID は常に最左固定。担当を先頭にも置けるようになった。
- [x] **変化点（赤字）を本来の意味に修正**：従来は「隣の前週と数値が違えば赤」で、通常の増減でも全部赤くなっていた。**現在の予定とその週の計画スナップショット（前回記録）を比較し、実際に変えた週だけ赤**にした（`useScheduleData.changedVsBaseline`、live時のみ／baselineは当週スナップショット）。凡例も「前回の計画から変更」に修正。
- [x] **既定マイルストン（フェーズ）をシート設定で定義**：`settings.default_milestones=[{name,color}]`。シート設定に編集UI追加。マイルストン編集（◇）はこれをパレット＋未設定行のプリフィルに使用し、**凡例にも既定色を表示**（③の「設計/実装…」のハードコードを置換）。
- [x] **マイルストン編集モーダルを拡幅＋整形**（460→680px、フェーズ名を広く、日付/色/達成にラベル）。「狭くて書けない」を解消。
- [x] backend: `sheets.settings JSONB` 追加（起動時 `ALTER TABLE sheets ADD COLUMN IF NOT EXISTS settings ...`）。SheetOut/SheetUpdate に `settings`。seed の開発スケジュールに既定マイルストン＋`pinned_columns:1` を投入。
- 注: ⑤「ステータス自動判定」は実装不要。既存の status 列 `auto_from_milestones` で完了/遅延/進行中/未着手を自動算出可能（[status.ts](frontend/src/lib/status.ts) `statusFromMilestones`）。精度を上げるなら実績h到達で完了扱い等を追加。
- ⚠ backend を変更したので **`docker compose restart backend`** 必須。**既存DBには空 settings が入る**ので、seed済みの既定マイルストン（設計/実装/テスト/レビュー）を反映したい場合のみ `docker compose down -v` → up で再 seed（任意。未設定でもフォールバック動作）。

## 追加修正（フィードバック対応 第6弾, 2026-06-17）
- [x] **変化点を「差分あれば赤」に拡張**：工数だけでなく**属性列（ステータス/担当/日付/プルダウン等）も当週スナップショット（前回記録）と比較**し、差分セルを赤の左罫＋淡赤背景でハイライト（[useScheduleData.ts](frontend/src/hooks/useScheduleData.ts) `changedColIds`、[GanttGrid.tsx](frontend/src/components/schedule/GanttGrid.tsx)）。lookupは計算列なので対象外。※当週スナップショット起点なので、シード直後（無変更）は赤なし＝正しい状態。値を変えると赤。
- [x] **③④ 凡例は既定マイルストンのみ**に変更（各行の名前は出さない）。**マイルストン編集の色ピッカーを撤去**＝色は同名の既定マイルストンから自動継承。フェーズ名は既定からのドロップダウン選択に（[MilestoneEditor.tsx](frontend/src/components/schedule/MilestoneEditor.tsx)、[Legend.tsx](frontend/src/components/schedule/Legend.tsx)）。
- [x] **今日線のキャプションが行に食い込む**のを修正：「今日 M/D」をヘッダ最上段のピル表示に移動（本体行へ被らない）。
- [x] **固定列を2段階に**（広い画面/狭い画面で別々の固定列数）。狭い画面では固定を減らしてスケジュールを見えるように（[SchedulePage.tsx](frontend/src/pages/SchedulePage.tsx) `useIsNarrow(900)`、設定UIは [SheetSettingsPage.tsx](frontend/src/pages/SheetSettingsPage.tsx)）。固定列数は元々0〜全列で任意指定可。
- [x] **IDが見切れる**のを修正：ID列幅 92→136。
- [x] **同じIDの重複を許可**：`rows` の `UNIQUE(sheet_id,key_value)` を撤去（起動時 `ALTER TABLE rows DROP CONSTRAINT IF EXISTS uq_rows_sheet_key`、modelの制約も削除）。同一開発の再実施などで同じIDを使える。⚠ lookupは先頭一致で解決（重複時は最初の行）。
- [x] **危険なシート削除をサイドバーから撤去**：削除はシート設定画面の「シートを削除」からのみ（[AppLayout.tsx](frontend/src/components/AppLayout.tsx)）。
- ⚠ backend変更のため **`docker compose restart backend`** 済み（マイグレーション確認済み）。
- ◻ **未対応（要相談）**: スケジュールの「細/標準/広」を**週/月トグル**に変え、月=4週合計表示＋月から入力→週へ分割。粒度（暦月 vs 4週固定）と入力の分割方法を確認のうえ次で実装予定。

## 追加修正（フィードバック対応 第7弾, 2026-06-17）
- [x] **⑥ 今日線キャプションの食い込み**：原因はWindows×Dockerでfrontendがホットリロードされず古い配信のままだった（プレビューで実コードは修正済みを確認：キャプションはヘッダ最上段 y106–122、本体行は y152〜で被らない）。z-indexも安全側に（キャプションz-20／縦線z-10＜固定列z-20）で固定列に被らないよう補強。**`docker compose restart frontend` 実施済み**。
- [x] **③ 凡例の遅延は「実際に節目超過がある時だけ」表示**（`hasLate` のみ）。遅延の定義＝行の最後のマイルストン境界日を今日が過ぎていて未達成（done=false）。例: E26-001 は対応(4/30)未達成で今日超過→遅延。
- [x] **⑦ 固定列はボタンで切替**（自動ではなく手動）。スケジュール画面の「固定列: 通常／最小」ボタンで `pinned_columns`⇄`pinned_columns_narrow` を切替（プレビュー確認: 660px→232px）。設定の2値は「通常／最小化時」に改称。
- [x] **⑧ スケジュール画面でID編集可**：IDをクリックでインライン入力→保存（重複可なので自由にリネーム）。`useRowMutation` に `keyValue` 追加。テーブル画面でも従来どおり編集可。
- [x] **② 変化点＝週次スナップショット（断面）比較に確定**（第9弾, ユーザ希望）。**今週の断面（週初に自動取得・cron不要の遅延取得）と現在の予定を比較し、変えた週だけ赤**。編集した週だけ赤くなり隣には影響しない（前週比の隣接結合を解消）。`changedVsBaseline` + `baselineQ=getSnapshot(currentWeek)`。月表示は「その月のいずれかの週が断面から変化」で赤。凡例「今週の断面から変更」。※断面は週の初回アクセス時取得＝週初近似。属性列のハイライトは今回は入れていない（必要なら追加可）。
- [x] **⑩ 月/週表示（A=暦月）実装**：右上トグル「週/月」。月は**データ層で週→暦月に集計**して既存グリッドで描画（GanttGridはほぼ無改修＝低リスク）。月セル=その月の合計（過去実績/未来予定）、色＝月内最初の色、◇・遅延・前週比も月粒度。**月セル入力→その月の週へ均等分割**（端数は先頭週、field は過去=実績/未来=予定）。`useScheduleData(viewMode)` + `monthWeeks` マップ、`SchedulePage.saveWeek` で分割。プレビューで月列37本×52px・今日マーカーを確認。セル数値は実アプリで要確認。
- ◻ **②再検討 / ③超過の説明 / ⑤ルール表示**：超過＝最後の節目を今日が過ぎ未達成（salmonバー）。⑤の「担当=true」表示はseedの未対応op（overdue/done/in_progress）がUIで化けたもの＝「達成状況から自動判定」ON推奨。
- ⑤ auto_from_milestones の説明はHANDOFF/コード参照（status列 config）。

## 追加修正（フィードバック対応 第10弾, 2026-06-18）
- [x] **as-of：バナーだけ撤去、ステッパーは存置**（指摘修正）。「‹ 基準週 ›」で過去週の計画（断面）を閲覧する機能は残し、「…時点の計画…を表示中」バナーのみ削除。as-of中は基準ラベル＋青い基準線＋コンパクトな「今日」ボタンで示す。as-of中は読み取り専用（editable=live）。as-ofステッパーは週表示のみ（月表示では断面=週粒度のため非表示）。
- ◻ **色の整理（要方針合意）**：ステータス色（バッジ＝状態）とマイルストン色（ガント帯＝工程）は別軸。既定マイルストンが A/B/C/D の曖昧色だと混乱→意味ある工程名＋区別しやすい淡色を推奨。遅延色（サーモン）はガント上の「超過」表現でステータス「遅延」と同条件。ユーザに設計方針を説明＆推奨適用を提案中。

## デプロイ整備（2026-06-18）
- [x] **本番デプロイ構成を追加**（GitHub Actions → GHCR → EC2/Docker Compose、TLSはhost nginx終端）。
  - [frontend/Dockerfile](frontend/Dockerfile)（build→nginx静的配信＋/apiプロキシ）＋[frontend/nginx.conf](frontend/nginx.conf)、[backend/.dockerignore](backend/.dockerignore)
  - [docker-compose.prod.yml](docker-compose.prod.yml)（db内部のみ／backendは--reload無し2workers／frontendは127.0.0.1:8080公開）
  - [.github/workflows/deploy.yml](.github/workflows/deploy.yml)（build&push→SSHでpull&up）、[.env.prod.example](.env.prod.example)、[DEPLOY.md](DEPLOY.md)
  - backend: 本番Cookie Secure用に `COOKIE_SECURE` 設定追加（[config.py](backend/app/config.py)/[main.py](backend/app/main.py)）
  - ローカル検証: prodフロントビルド成功・compose prod構文OK・backend compile OK。※実デプロイ（repo作成/push/EC2準備/secrets）はユーザ作業（DEPLOY.md参照）。
  - 注: まだ git リポジトリ未初期化。Alembic未整備（起動時create_all＋ALTER運用）。

## 残課題 / 既知の制限
- 失敗時のトースト通知が未実装（現状サイレント。`// TODO: toast`）
- シート設定の列**並べ替え**は未（表示は order 順）
- ダッシュボード / マイタスクは先頭シート固定（シート選択は未対応）
- 変化点（週次スナップショット差分）は簡易実装のまま
- ダッシュボード集計は基本のみ（多軸ピボット・横断は未）
- エクスポートは CSV のみ（Excel 未）
- Alembic 本番マイグレーションは未整備（現状 create_all + seed 起動）

## 次の一手の候補
1. 実ブラウザでの通し確認・細部の微調整（編集UX、トースト）
2. ダッシュボード/マイタスクのシート選択対応
3. 変化点の本実装・Excel エクスポート・Alembic 整備
