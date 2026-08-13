"""このアプリのバージョン情報。

「今動いているのはどのバージョンか」を画面から確認できるようにするための情報源
（要望: 今のシステムがどのバージョンなのか分かるようにしてほしい）。

値はビルド時に環境変数で埋める（docker build --build-arg APP_COMMIT=... 等）。
埋まっていないときは、開発中とみなして git から拾う → それも無理なら 'dev'。

VERSION は手で上げる番号（機能追加＝マイナー、修正＝パッチ）。COMMIT と BUILT_AT が
「実際に動いている物」の正体で、ユーザーが「直したはずなのに直っていない」ときに
最初に見るべき値になる。
"""
from __future__ import annotations

import os
import subprocess
from functools import lru_cache
from pathlib import Path

#: 手動で上げるアプリのバージョン。フロントの package.json と揃えること。
VERSION = "1.1.0"


@lru_cache(maxsize=1)
def _git_commit() -> str:
    """開発環境向けのフォールバック。イメージには .git が無いので普通は空。"""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def build_info() -> dict[str, str]:
    """画面と /api/version が使う辞書。"""
    return {
        "version": os.getenv("APP_VERSION") or VERSION,
        # 例: 'bef6949'。'dev' のときはビルド情報が埋まっていない（＝ソース直実行）。
        "commit": os.getenv("APP_COMMIT") or _git_commit() or "dev",
        # ISO8601。docker build 時に埋める。
        "built_at": os.getenv("APP_BUILT_AT") or "",
    }
