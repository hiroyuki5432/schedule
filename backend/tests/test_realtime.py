"""リアルタイム更新: DB のトリガが通知を出すこと、配送がグループで分かれること。

SSE のストリームそのものは終わらない応答なので、ここでは両端（通知の発生と配送）を
確かめる。ブラウザまでの通しは画面で確認している。
"""
from __future__ import annotations

import asyncio
import json
import time

import psycopg
import pytest

from app.config import settings
from app.realtime import Broker, _libpq_dsn
from tests.conftest import make_row, make_sheet


class _Listener:
    def __init__(self) -> None:
        self.conn = psycopg.connect(_libpq_dsn(settings.DATABASE_URL), autocommit=True)
        self.received: list[str] = []
        self.conn.add_notify_handler(lambda n: self.received.append(n.payload))
        self.conn.execute("LISTEN app_change")


def _drain(lis: _Listener) -> list[dict]:
    """ここまでに届いた通知を取り出す（psycopg 3.1 は次のコマンドの実行時に配る）。"""
    time.sleep(0.2)
    lis.conn.execute("SELECT 1")
    out = [json.loads(p) for p in lis.received]
    lis.received.clear()
    return out


@pytest.fixture
def listener():
    lis = _Listener()
    yield lis
    lis.conn.close()


def test_a_row_edit_notifies_with_sheet_and_author(auth_client, listener):
    sid = make_sheet(auth_client)
    _drain(listener)
    row = make_row(auth_client, sid)
    auth_client.patch(
        f"/api/rows/{row['id']}",
        json={"data": {"x": 1}, "version": row["version"]},
        headers={"X-Client-Id": "tab-123"},
    )
    msgs = _drain(listener)
    rows_msgs = [m for m in msgs if m["t"] == "rows" and m["s"] == sid]
    assert rows_msgs, msgs
    org_id = auth_client.org_admin["org_id"]
    assert all(m["o"] == org_id for m in rows_msgs)
    # 誰が・どの画面から変えたか（自分の変更で画面を読み直さないために使う）。
    assert any(m.get("c") == "tab-123" for m in rows_msgs)
    assert all(m.get("u") == str(auth_client.org_admin["admin_id"]) for m in rows_msgs)


def test_effort_and_notes_notify_their_sheet(auth_client, listener):
    sid = make_sheet(auth_client)
    row = make_row(auth_client, sid)
    _drain(listener)
    auth_client.put(f"/api/rows/{row['id']}/effort/2026-06-22", json={"planned_hours": 4})
    auth_client.put(f"/api/rows/{row['id']}/notes", json={"cell_key": "__id__", "text": "x"})
    kinds = {(m["t"], m["s"]) for m in _drain(listener)}
    assert ("effort_entries", sid) in kinds
    assert ("cell_notes", sid) in kinds


def test_many_rows_in_one_transaction_collapse_to_one_notice(auth_client, listener):
    sid = make_sheet(auth_client)
    ids = [make_row(auth_client, sid)["id"] for _ in range(5)]
    _drain(listener)
    auth_client.post(
        "/api/rows/bulk-update", json={"items": [{"id": i, "data": {"x": 1}} for i in ids]}
    )
    rows_msgs = [m for m in _drain(listener) if m["t"] == "rows"]
    assert len(rows_msgs) == 1


def test_broker_delivers_only_to_the_same_group():
    async def run():
        b = Broker()
        mine = b.subscribe(1)
        theirs = b.subscribe(2)
        b.publish({"o": 1, "s": 10, "t": "rows"})
        assert mine.get_nowait()["s"] == 10
        assert theirs.empty()
        # 再接続の合図（グループ無し）は全員へ。
        b.publish({"t": "resync"})
        assert mine.get_nowait()["t"] == "resync"
        assert theirs.get_nowait()["t"] == "resync"
        b.unsubscribe(mine)
        assert b.count == 1

    asyncio.run(run())


def test_broker_turns_an_overflow_into_a_resync():
    async def run():
        b = Broker()
        q = b.subscribe(1)
        for i in range(500):
            b.publish({"o": 1, "s": i, "t": "rows"})
        items = []
        while not q.empty():
            items.append(q.get_nowait())
        assert {"t": "resync"} in items
        assert len(items) <= 200

    asyncio.run(run())


def test_events_endpoint_requires_login(client):
    assert client.get("/api/events").status_code == 401
