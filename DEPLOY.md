# デプロイ手順（GitHub → GHCR → EC2 / Docker Compose）

GitHub に push すると、GitHub Actions が backend / frontend のイメージをビルドして
**GHCR**（GitHub Container Registry）へ push し、**EC2** に SSH してイメージを pull・再起動します。

```
push main ──> GitHub Actions
                ├─ build & push  ghcr.io/<owner>/<repo>-backend:latest
                ├─ build & push  ghcr.io/<owner>/<repo>-frontend:latest
                └─ ssh EC2 ─> git pull + docker compose pull + up -d
EC2:  [host nginx + 証明書(HTTPS)] ──proxy──> 127.0.0.1:8080
        └─ docker compose (prod): frontend(nginx静的+/api) ─> backend(uvicorn) ─> db(postgres)
```

関連ファイル: [docker-compose.prod.yml](docker-compose.prod.yml) ・ [.env.prod.example](.env.prod.example) ・
[frontend/Dockerfile](frontend/Dockerfile) ・ [frontend/nginx.conf](frontend/nginx.conf) ・
[.github/workflows/deploy.yml](.github/workflows/deploy.yml)

---

## 1. GitHub リポジトリを作成して push

ローカル（このフォルダ）で：

```bash
git init
git add -A
git commit -m "Initial commit: schedule app + deploy config"
git branch -M main
# GitHub 側で空のリポジトリを作成（gh が無いのでブラウザで作成）後：
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

> `.env`（本番の秘密）は [.gitignore](.gitignore) で除外済み。コミットされないことを確認してください。

## 2. GitHub リポジトリの Secrets を登録

リポジトリ → Settings → Secrets and variables → Actions → **New repository secret**：

| Secret | 必須 | 内容 |
|---|---|---|
| `EC2_HOST` | ✅ | EC2 のパブリック IP か DNS 名 |
| `EC2_USER` | ✅ | SSH ユーザー（例: `ubuntu`） |
| `EC2_SSH_KEY` | ✅ | デプロイ用 SSH **秘密鍵**（対応する公開鍵を EC2 の `~/.ssh/authorized_keys` に登録） |
| `EC2_PORT` | 任意 | SSH ポート（既定 22） |
| `GHCR_USER` | 任意 | GHCR を **private** にする場合の GitHub ユーザー名 |
| `GHCR_TOKEN` | 任意 | 同上。`read:packages` 権限の PAT（public にするなら不要） |

※ イメージの push は `GITHUB_TOKEN` で自動的に行われるため、push 用の Secret は不要です。

## 3. EC2 を準備（初回のみ）

SSH で EC2 に入り：

```bash
# Docker と compose プラグイン（未導入なら）
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # 入り直し

# アプリ配置（compose ファイルをここで git 管理。イメージは GHCR から pull）
sudo mkdir -p /opt/schedule && sudo chown $USER /opt/schedule
git clone https://github.com/<owner>/<repo>.git /opt/schedule
cd /opt/schedule

# 本番 .env を作成（テンプレからコピーして実値に）
cp .env.prod.example .env
nano .env
#   - POSTGRES_PASSWORD / SESSION_SECRET を強いランダム値に（例: openssl rand -hex 32）
#   - COOKIE_SECURE=true（HTTPS のため）
#   - DEMO_ADMIN_EMAIL / DEMO_ADMIN_PASSWORD = 初期管理者（初回 seed で作成）
#   - BACKEND_IMAGE / FRONTEND_IMAGE = ghcr.io/<owner>/<repo>-backend:latest など
```

> デプロイ先ディレクトリを `/opt/schedule` 以外にする場合は、Actions の Secret に
> `EC2_APP_DIR` を追加してそのパスを設定してください。

**GHCR が private の場合**は EC2 でも一度ログインしておきます（Actions も毎回ログインします）：
```bash
echo <PAT(read:packages)> | docker login ghcr.io -u <github-user> --password-stdin
```
public にする場合は不要（リポジトリ → Packages → 各 package → Package settings → Change visibility → Public）。

## 4. ホスト nginx（HTTPS）を 127.0.0.1:8080 へプロキシ

既存の nginx（証明書あり）に、このアプリ用の vhost を追加します。例：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.example;

    ssl_certificate     /etc/letsencrypt/live/your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.example/privkey.pem;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
server {                       # HTTP→HTTPS リダイレクト
    listen 80;
    server_name your-domain.example;
    return 301 https://$host$request_uri;
}
```
```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 5. 初回デプロイ

EC2 にリポジトリと `.env` が揃った状態で、ローカルから `main` に push（または Actions を手動実行）。
Actions が「build → GHCR push → EC2 で pull & up」を実行します。

確認：
```bash
cd /opt/schedule && docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f backend   # "Seed check complete." 等
```
ブラウザで `https://your-domain.example` → `.env` の DEMO_ADMIN_EMAIL/PASSWORD でログイン。
**ログイン後にパスワードを変更**し、`.env` の `SEED_ON_STARTUP=false` にして再 push（再デプロイ）。

## 6. 以降のデプロイ

`main` に push するだけ。Actions が自動でビルド＆反映します。手動再実行は Actions タブの
「Build & Deploy」→ Run workflow。

## 7. 運用メモ

- **DB マイグレーション**: 起動時に `create_all` ＋ 冪等 `ALTER`（[backend/app/main.py](backend/app/main.py)）。
  列追加はこの方式で対応中（Alembic は未整備）。スキーマ破壊変更時は要注意。
- **バックアップ**: `docker compose -f docker-compose.prod.yml exec db pg_dump -U $POSTGRES_USER $POSTGRES_DB > backup.sql`
- **ロールバック**: GHCR の特定 `:<sha>` タグに `.env` の `*_IMAGE` を切り替えて `pull && up -d`。
- **DB は外部公開していません**（compose 内ネットワークのみ）。frontend も `127.0.0.1:8080` のみ公開。
- 秘密情報（`.env`）はサーバ上にのみ置き、リポジトリには絶対にコミットしないこと。
