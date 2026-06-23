# 工数スケジュール管理アプリ

行（管理対象）をユーザー定義の列で管理し、週次で予定/実績工数をガント風に可視化する、単一組織・小規模チーム向け Web アプリ。

- 仕様: [SPEC.md](SPEC.md)
- API 契約: [docs/API.md](docs/API.md)
- 画面モック: [mockup/schedule.html](mockup/schedule.html)（ブラウザで開く）
- 進捗・やり残し: [STATUS.md](STATUS.md)

## スタック
- Backend: FastAPI + SQLAlchemy 2.0 + PostgreSQL（Alembic）
- Frontend: React + Vite + TypeScript + Tailwind + TanStack Table/Query
- 実行: Docker Compose（開発は Windows、本番は Ubuntu 想定）

## 起動（Docker Compose）
```bash
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
docker compose up --build
```
- frontend: http://localhost:5173
- backend (OpenAPI): http://localhost:8000/docs
- db: localhost:5432

初回起動で（`SEED_ON_STARTUP=true` の場合）デモ組織・ユーザー・シートを投入。

### デモログイン
- 管理者: `admin@demo.local` / `demo1234`

## ローカル開発（Docker を使わない場合）
- db のみ Docker: `docker compose up db`
- backend: `cd backend && python -m venv .venv && .venv\Scripts\activate && pip install -r requirements.txt && uvicorn app.main:app --reload`
- frontend: `cd frontend && npm install && npm run dev`

## テスト
- バックエンド（pytest、専用の `<db>_test` データベースを自動作成。本番データには触れません）:
  ```bash
  docker compose exec backend pip install -r requirements-dev.txt   # 初回のみ
  docker compose exec backend python -m pytest
  ```
- フロントエンド（vitest、純ロジックの単体テスト）:
  ```bash
  cd frontend && npm test
  ```

## バックアップ / リストア
プレーンSQLのgzipダンプを `./backups` に出力します（`--clean --if-exists` 付きで上書き復元可）。

- 手動バックアップ: `sh scripts/backup.sh`
- 復元（**現在のDBを上書き**）: `sh scripts/restore.sh backups/schedule_YYYYMMDD_HHMMSS.sql.gz`
- 自動バックアップ（cron不要のループ。既定で1日1回、最新14世代を保持）:
  ```bash
  docker compose --profile backup up -d
  ```
  間隔・保持数は `BACKUP_INTERVAL_SECONDS` / `BACKUP_KEEP` で調整（`.env` 可）。

## ディレクトリ
```
backend/    FastAPI アプリ・モデル・API・seed・Alembic
frontend/   React/Vite アプリ（schedule 画面ほか）
mockup/     デザイン基準の単体HTMLモック
docs/       API 契約ほか
SPEC.md     ドメイン仕様（正本）
STATUS.md   実装状況・残作業
```
