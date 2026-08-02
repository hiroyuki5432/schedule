"""マスタシート（is_master）。

要望: マスタ設定みたいなのもできるといい。参照(LOOKUP)でできることではあるが、
マスタシートがたくさん並ぶと使いにくいので「表には見えないテーブル」が欲しい。

サーバ側の役目はフラグを持ち回るところまで。隠すのは画面側（サイドバーの「シート」・
ダッシュボード等のシート選択から外す）で、API はマスタも普通に返す — 参照先として
選べる必要があるし、開けば編集もできるため。
"""
from __future__ import annotations

from .conftest import make_sheet


def test_a_sheet_is_not_a_master_by_default(auth_client):
    sid = make_sheet(auth_client, "設計")
    assert auth_client.get("/api/sheets").json()[0]["is_master"] is False
    assert auth_client.get(f"/api/sheets/{sid}").json()["sheet"]["is_master"] is False


def test_a_master_can_be_created_and_toggled(auth_client):
    r = auth_client.post(
        "/api/sheets", json={"name": "顧客マスタ", "has_week_grid": False, "is_master": True}
    )
    assert r.status_code in (200, 201), r.text
    sid = r.json()["id"]
    assert r.json()["is_master"] is True

    # マスタも一覧には出る（参照先として選ぶため）。
    listed = {s["id"]: s for s in auth_client.get("/api/sheets").json()}
    assert listed[sid]["is_master"] is True

    # あとから普通のシートに戻せる。
    assert auth_client.patch(f"/api/sheets/{sid}", json={"is_master": False}).status_code == 200
    assert auth_client.get("/api/sheets").json()[0]["is_master"] is False
