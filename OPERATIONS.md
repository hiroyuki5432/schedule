# 運用・更新マニュアル（工数スケジュール管理アプリ）

本番環境の **日々の運用** と **更新（再デプロイ）** の手順書。
初回構築の手順は [DEPLOY.md](DEPLOY.md) を参照。

---

## 0. 環境のまとめ（自分用メモ）

| 項目 | 値 |
|---|---|
| GitHub リポジトリ | `hiroyuki5432/schedule` |
| 本番サーバ | AWS EC2（Ubuntu）、ユーザー `ubuntu` |
| アプリ配置先 | `/opt/schedule` |
| 本番 compose | `docker-compose.prod.yml` |
| イメージ | `ghcr.io/hiroyuki5432/schedule-backend:latest` / `-frontend:latest`（GHCR） |
| 公開URL | `https://（設定したドメイン）` |
| 管理者ログイン | `hiroyuki.hamasaki@gmail.com` ＋ 設定した初期パスワード |
| TLS | EC2 上の nginx（証明書）→ `127.0.0.1:8080` にプロキシ |

**構成（push したら自動で本番反映）**
```
git push ─> GitHub Actions ─ ビルド → GHCR(倉庫)へ保存
                              └─ EC2にSSH → pull → 再起動
EC2: [nginx + 証明書] ──HTTPS──> 127.0.0.1:8080
       └─ docker compose: frontend(nginx) → backend(FastAPI) → db(Postgres)
```

サーバへの入り方（手元PCの PowerShell）:
```bash
ssh -i "C:\path\to\鍵.pem" ubuntu@（EC2のIPかドメイン）
```

---

## 1. ★ 更新（アップデート）の仕方 ★

### A. 通常の更新（これが基本）
コードを直したら **push するだけ**。GitHub Actions が自動でビルド＆本番反映します。

手元PC（プロジェクトフォルダ）で:
```bash
git add -A
git commit -m "変更内容を書く"
git push
```
→ 反映の確認：GitHub → **Actions タブ** → 最新の「Build & Deploy」が**緑（成功）**になればOK（数分かかります）。

> 仕組み：push → イメージをビルドして GHCR に保存 → EC2 に SSH して
> `git pull` ＋ `docker compose pull` ＋ `up -d` を自動実行。

### B. デプロイだけ手動でやり直す（Actions の deploy が赤いとき等）
- 簡単：GitHub → Actions → 失敗した実行を開く → 右上 **「Re-run jobs」**。
- またはサーバで直接（最後に GHCR にあるイメージを反映）:
  ```bash
  cd /opt/schedule
  git pull
  docker compose -f docker-compose.prod.yml pull
  docker compose -f docker-compose.prod.yml up -d
  docker image prune -f
  ```

> 注意：**新しいコードを本番に出すには A の `git push` が必要**（イメージは Actions がビルドするため）。
> B は「すでにビルド済みのイメージを取り直す」だけです。

---

## 2. 状態確認・ログ（サーバで）

```bash
cd /opt/schedule

# コンテナの状態（db/backend/frontend が Up か）
docker compose -f docker-compose.prod.yml ps

# ログを見る（Ctrl+C で抜ける）
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs --tail=50

# アプリがローカルで応答するか（200 が返ればOK）
curl -I http://127.0.0.1:8080
```

---

## 3. 再起動・停止・起動

```bash
cd /opt/schedule

# 一部だけ再起動
docker compose -f docker-compose.prod.yml restart backend

# 全部再起動
docker compose -f docker-compose.prod.yml restart

# 停止（DBのデータは残る）
docker compose -f docker-compose.prod.yml down

# 起動
docker compose -f docker-compose.prod.yml up -d
```

---

## 4. ロールバック（前のバージョンに戻す）

### 簡単：コミットを取り消して push
手元PCで:
```bash
git revert HEAD      # 直前の変更を打ち消すコミットを作る
git push             # Actions が「戻した状態」を自動で本番反映
```

### 特定バージョンに固定（上級）
GHCR には `:latest` の他に `:＜コミットSHA＞` タグも保存されています。
サーバの `/opt/schedule/.env` の以下2行を、戻したい SHA に変更して再起動:
```
BACKEND_IMAGE=ghcr.io/hiroyuki5432/schedule-backend:＜SHA＞
FRONTEND_IMAGE=ghcr.io/hiroyuki5432/schedule-frontend:＜SHA＞
```
```bash
cd /opt/schedule
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```
（戻し終わったら `:latest` に戻しておくと、次の push で通常運用に復帰）

---

## 5. バックアップ・復元（DB）

```bash
cd /opt/schedule

# バックアップ（ホームに日付付きで保存）
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U app schedule > ~/schedule-backup-$(date +%Y%m%d).sql

# 復元（※既存データに上書き。慎重に）
cat ~/schedule-backup-YYYYMMDD.sql | \
  docker compose -f docker-compose.prod.yml exec -T db psql -U app -d schedule
```

> 定期バックアップにするなら、上のバックアップ行を `crontab -e` で毎日実行に登録。

---

## 6. 設定（.env）を変えたとき

`/opt/schedule/.env` を編集したら、反映に再起動が必要:
```bash
cd /opt/schedule
nano .env                                   # 編集（Ctrl+O→Enter→Ctrl+X で保存）
docker compose -f docker-compose.prod.yml up -d
```
よく変える項目：
- `SEED_ON_STARTUP=false` … 初回投入（デモデータ）を止める（公開後は false 推奨）
- `DEMO_ADMIN_*` … 初期管理者（※すでに作成済みの管理者は画面から変更する。ここを変えても既存ユーザーは変わらない）

---

## 7. 公開直後にやる安全対策（未実施なら）

初回 seed で**デモアカウント**（`sato@demo.local` 等、パスワード `demo1234`）とデモデータが作られています。
1. 画面の **メンバー管理** から、`*@demo.local` の4アカウントを**削除またはパスワード変更**
2. 管理者パスワードも念のため変更
3. 再シードを止める:
   ```bash
   cd /opt/schedule
   sed -i 's/^SEED_ON_STARTUP=.*/SEED_ON_STARTUP=false/' .env
   docker compose -f docker-compose.prod.yml up -d
   ```

---

## 8. 困ったとき（今回ハマった所も含む）

| 症状 | 原因・対処 |
|---|---|
| Actions の deploy が赤 | EC2 が落ちている/SSH不可。Secrets（EC2_HOST/USER/SSH_KEY）を確認。直したら Re-run jobs |
| `permission denied ... docker.sock` | ユーザーが docker グループ未所属。`sudo usermod -aG docker $USER` → 一度 `exit` して入り直す |
| `docker login` が `denied` | パスワード欄への貼り付け失敗が多い。`read -s -p "token: " T; echo` → `echo "$T" \| docker login ghcr.io -u hiroyuki5432 --password-stdin` |
| `git pull` で認証エラー | トークン切れ。新しい classic PAT（`repo`＋`read:packages`）を作り直し、`git remote set-url origin https://hiroyuki5432:＜PAT＞@github.com/hiroyuki5432/schedule.git` |
| イメージ pull が `not found` | Actions のビルドがまだ/失敗。Actions タブで build の成否を確認 |
| 画面が502/応答なし | コンテナ停止の可能性。`docker compose -f docker-compose.prod.yml ps` と `logs` を確認、必要なら `up -d` |

---

## 9. 関連ドキュメント
- [DEPLOY.md](DEPLOY.md) … 初回構築の手順（ゼロから）
- [HANDOFF.md](HANDOFF.md) … アプリ全体像・開発の落とし穴
- [STATUS.md](STATUS.md) … 実装状況・変更履歴
- [SPEC.md](SPEC.md) … 仕様
- [docs/API.md](docs/API.md) … API 契約
