"""リアルタイム更新 — 他の人の変更を、開いている画面へすぐ届ける。

要望: Excel 365 の共同編集と比べられる。画面を開き直さないと他の人の更新が見えない
のでは見劣りする。

仕組み（3段）:

1. **DB のトリガ**（app.db_triggers）が、行・列・工数などが変わるたびに
   ``pg_notify('app_change', {o: グループ, s: シート, t: 種類, u: 人, c: 画面})`` を出す。
   どの入口（画面の編集・取り込み・復元…）から書いても漏れない。通知はコミット時に
   だけ届くので、取り消された書き込みは伝わらない。
2. **このモジュールの listener** が、サーバのプロセスごとに1本 LISTEN し、受けた通知を
   そのプロセスにつながっている画面へ配る（本番は uvicorn のワーカーが複数なので、
   プロセスをまたぐ配送は Postgres に任せている）。
3. **``GET /api/events``**（Server-Sent Events）でブラウザへ流す。中身は「どのシートが
   変わったか」だけで、値は送らない。受け取った画面はいつもの API で読み直すので、
   権限の確認もいつもの経路を通る。

SSE を選んだのは、ふつうの HTTP なので社内の nginx 等をそのまま通るから
（``X-Accel-Buffering: no`` で nginx の溜め込みだけ止める）。WebSocket は
プロキシ側に Upgrade の設定が要る。
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import event, text
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.db_triggers import CHANNEL
from app.models import User

logger = logging.getLogger("uvicorn.error")

#: 何も起きていないときに送る空行の間隔（秒）。プロキシのアイドル切断（nginx の
#: 既定は60秒）より短くしておく。
PING_SECONDS = 20
#: 1つの画面に溜めておける通知の数。超えたら「全部読み直して」を1通送って捨てる。
QUEUE_MAX = 200


# --------------------------------------------------------------------------- #
# 誰が書いたか — トリガが読む app.user_id / app.client_id を設定する
# --------------------------------------------------------------------------- #
def tag_session(db: Session, user_id: int, client_id: str | None) -> None:
    """このセッションの書き込みに「誰が・どの画面から」を付ける。

    値はトランザクションごとに消える（set_config の第3引数 true）ので、いまの
    トランザクションには直接設定し、コミット後に始まるトランザクションには
    ``after_begin`` で設定し直す。
    """
    cid = (client_id or "")[:64]
    db.info["actor"] = (str(user_id), cid)
    _apply_actor(db.connection(), str(user_id), cid)


def _apply_actor(conn, uid: str, cid: str) -> None:
    conn.execute(
        text("SELECT set_config('app.user_id', :u, true), set_config('app.client_id', :c, true)"),
        {"u": uid, "c": cid},
    )


@event.listens_for(Session, "after_begin")
def _retag(session: Session, transaction, connection) -> None:
    actor = session.info.get("actor")
    if actor:
        _apply_actor(connection, *actor)


# --------------------------------------------------------------------------- #
# プロセス内の配送
# --------------------------------------------------------------------------- #
class Broker:
    """このプロセスにつながっている画面（購読）への配送。イベントループ上だけで使う。"""

    def __init__(self) -> None:
        self._subs: dict[asyncio.Queue, int] = {}

    def subscribe(self, org_id: int) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self._subs[q] = org_id
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.pop(q, None)

    @property
    def count(self) -> int:
        return len(self._subs)

    def publish(self, msg: dict[str, Any]) -> None:
        """グループが一致する購読へ配る。``o`` が無いもの（再接続の合図）は全員へ。"""
        org = msg.get("o")
        for q, sub_org in list(self._subs.items()):
            if org is not None and org != sub_org:
                continue
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                # 読み切れない画面には、細かい通知の代わりに「全部読み直して」を残す。
                while not q.empty():
                    q.get_nowait()
                q.put_nowait({"t": "resync"})


broker = Broker()


def _libpq_dsn(url: str) -> str:
    """SQLAlchemy の URL（postgresql+psycopg://…）を psycopg が読める形に。"""
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


async def listen_forever() -> None:
    """Postgres の通知を受けて broker へ流し続ける。切れたらつなぎ直す。

    つなぎ直したときは、その間の通知を取りこぼしているかもしれないので、全画面に
    ``resync``（全部読み直して）を送る。
    """
    import psycopg  # 遅延 import: テストや他のコマンドでは不要

    backoff = 1.0
    first = True
    while True:
        try:
            async with await psycopg.AsyncConnection.connect(
                _libpq_dsn(settings.DATABASE_URL), autocommit=True
            ) as conn:
                await conn.execute(f"LISTEN {CHANNEL}")
                logger.info("Realtime: listening on '%s'.", CHANNEL)
                if not first:
                    broker.publish({"t": "resync"})
                first = False
                backoff = 1.0
                async for n in conn.notifies():
                    try:
                        msg = json.loads(n.payload)
                    except ValueError:
                        continue
                    broker.publish(msg)
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - depends on the DB going away
            logger.exception("Realtime: listener lost its connection; retrying.")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


# --------------------------------------------------------------------------- #
# SSE エンドポイント
# --------------------------------------------------------------------------- #
router = APIRouter(prefix="/api", tags=["realtime"])


def _org_of(user_id: int) -> int | None:
    # get_db は使わない — 依存関係の後片付けがストリームの終わりまで延びると、
    # つながっている間ずっと DB の接続を1本握り続けることになる。確かめたら返す。
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if user is None or not user.is_active:
            return None
        return user.org_id


@router.get("/events")
async def events(request: Request) -> StreamingResponse:
    """このグループの変更通知を流し続ける（text/event-stream）。"""
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    org_id = await asyncio.to_thread(_org_of, user_id)
    if org_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    q = broker.subscribe(org_id)

    async def stream():
        try:
            # retry: 切れたときにブラウザがつなぎ直すまでの待ち（ミリ秒）。
            yield "retry: 3000\n\nevent: hello\ndata: {}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=PING_SECONDS)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                # 送るのはシート・種類・変えた人/画面だけ（グループは自明なので省く）。
                out = {k: msg.get(k) for k in ("s", "t", "u", "c") if msg.get(k) is not None}
                yield f"data: {json.dumps(out)}\n\n"
        finally:
            broker.unsubscribe(q)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            # nginx が応答を溜め込まずにすぐ流すように。
            "X-Accel-Buffering": "no",
        },
    )
