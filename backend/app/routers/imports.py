"""取り込み設定（プリセット）と、ブック丸ごとの一括取り込み。

要望: シートが多いブックを毎回ウィザードで設定し直すのが辛い／データ取り込みは
何度もやり直す。そこで —

1. どのウィザードでも取り込みが成功した時点で、その設定を ``ImportPreset`` として
   ワークシート名で保存する（利用者は何も操作しない。最初に丁寧に確認しながらやる
   作業が、そのまま設定登録になる）。
2. ``POST /api/import/workbook/inspect`` は落とされたブックの全ワークシートを
   プリセットに突き合わせ、「どのシートに / 何行が新規・更新 / どんな警告か」を
   1画面ぶん返す。何も書かない。
3. ``POST /api/import/workbook`` は確認済みのプランを **1トランザクション** で
   実行する。途中で失敗したら全部ロールバックするので、中途半端に半分だけ入った
   状態にはならない。

ワークシート単位の読み取り・列マッピング・upsert のロジックは ``routers.excel``
のものをそのまま再利用している（単発の取り込みと挙動が食い違わないように）。
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Form, HTTPException, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import xlsx_import as xlsx
from app.db import get_db
from app.deps import get_sheet_for_user
from app.models import ImportPreset, Sheet, User
from app.routers import excel
from app.schedule_service import ensure_schedule_columns
from app.schemas import ImportPresetOut, ImportPresetSave
from app.security import current_user

router = APIRouter(prefix="/api/import", tags=["import"])

#: What a worksheet should do in a 一括取り込み plan.
ACTIONS = ("existing", "new", "skip")


# --------------------------------------------------------------------------- #
# プリセット CRUD
# --------------------------------------------------------------------------- #
@router.get("/presets", response_model=list[ImportPresetOut])
def list_presets(
    user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[ImportPreset]:
    return list(
        db.execute(
            select(ImportPreset)
            .where(ImportPreset.org_id == user.org_id)
            .order_by(ImportPreset.worksheet_name)
        ).scalars()
    )


@router.post("/presets", response_model=ImportPresetOut)
def save_preset(
    body: ImportPresetSave,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> ImportPreset:
    """Create or refresh the setting for a source worksheet (org-wide)."""
    ws_name = body.worksheet_name.strip()
    if not ws_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="ワークシート名が空です"
        )
    if body.target_sheet_id is not None:
        # 404s when the sheet belongs to another org.
        get_sheet_for_user(db, body.target_sheet_id, user)

    preset = db.execute(
        select(ImportPreset).where(
            ImportPreset.org_id == user.org_id, ImportPreset.worksheet_name == ws_name
        )
    ).scalar_one_or_none()
    if preset is None:
        preset = ImportPreset(org_id=user.org_id, worksheet_name=ws_name, created_by=user.id)
        db.add(preset)

    preset.name = (body.name or ws_name).strip()[:255]
    preset.workbook_name = body.workbook_name.strip()[:255]
    preset.target_sheet_id = body.target_sheet_id
    preset.target_sheet_name = body.target_sheet_name.strip()[:255]
    preset.has_week_grid = body.has_week_grid
    preset.header_row = body.header_row
    preset.last_row = body.last_row
    preset.id_column = body.id_column
    preset.match_mode = excel.resolve_match_mode(body.match_mode, body.id_column)
    preset.mapping = _clean_mapping(body.mapping)
    db.commit()
    db.refresh(preset)
    return preset


@router.delete("/presets/{preset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_preset(
    preset_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> Response:
    preset = db.get(ImportPreset, preset_id)
    if preset is None or preset.org_id != user.org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="設定が見つかりません")
    db.delete(preset)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _clean_mapping(raw: list) -> list[dict]:
    """`[{index, name, type}]` — anything else in the payload is dropped."""
    out: list[dict] = []
    for it in raw or []:
        if not isinstance(it, dict):
            continue
        try:
            idx = int(it.get("index"))
        except (TypeError, ValueError):
            continue
        out.append(
            {
                "index": idx,
                "name": str(it.get("name") or "").strip(),
                "type": str(it.get("type") or "").strip(),
            }
        )
    return out


# --------------------------------------------------------------------------- #
# ブック一括
# --------------------------------------------------------------------------- #
def _presets_by_worksheet(db: Session, org_id: int) -> dict[str, ImportPreset]:
    return {
        p.worksheet_name: p
        for p in db.execute(
            select(ImportPreset).where(ImportPreset.org_id == org_id)
        ).scalars()
    }


def _plan_items(raw: str) -> dict[str, dict]:
    """The posted plan keyed by worksheet name. `{}` when none was sent."""
    items = xlsx.parse_json_field(raw, "取り込みプラン")
    if items is None:
        return {}
    if not isinstance(items, list):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="取り込みプランを読み取れませんでした"
        )
    out: dict[str, dict] = {}
    for it in items:
        if isinstance(it, dict) and str(it.get("worksheet") or "").strip():
            out[str(it["worksheet"]).strip()] = it
    return out


def _resolve(
    ws_name: str,
    preset: ImportPreset | None,
    override: dict | None,
    sheets_by_id: dict[int, Sheet],
) -> dict:
    """The effective settings for one worksheet: the preset, with anything the user
    changed on the 一括取り込み screen layered on top.

    A worksheet with no preset defaults to `skip` — dropping a book must never
    silently create a pile of new sheets. A preset whose target sheet was deleted
    (target_sheet_id went NULL) degrades to 新規作成 for the same reason: the saved
    intent survives, it just has nowhere to land.
    """
    target_id = preset.target_sheet_id if preset else None
    plan = {
        "action": "existing" if target_id in sheets_by_id else ("new" if preset else "skip"),
        "target_sheet_id": target_id if target_id in sheets_by_id else None,
        "target_sheet_name": (preset.target_sheet_name if preset else "") or ws_name,
        "has_week_grid": preset.has_week_grid if preset else True,
        # 誰も選んでいないとき（初めてのワークシート）は見出し行から推測する。
        # 前回の設定 or 画面での選択があれば、それが優先。
        "week_grid_explicit": preset is not None,
        "header_row": preset.header_row if preset else 0,
        # 0 = 最後まで. Where a sheet stops being a table is a property of the
        # source, so it rides along with everything else.
        "last_row": preset.last_row if preset else 0,
        "id_column": preset.id_column if preset else 0,
        # 行の照合。前回の設定があればそのときのモード。記録の無い（この設定より前に
        # 保存された）ものと、設定の無いワークシートは、これまでどおり「ID列で照合」に
        # 解決する — 一括取り込みは同じファイルを繰り返し流す場所なので、既定を黙って
        # 「照合しない」に変えると、取り込み直すたびに行が倍になってしまう。画面には
        # 照合の列が出るので、まとめたくないときはその場で切り替えられる。
        "match_mode": excel.resolve_match_mode(
            preset.match_mode if preset else "", preset.id_column if preset else 0
        ),
        # Empty means "not recorded" → fall back to the by-name defaults. An empty
        # list would otherwise import the IDs and none of the values.
        "mapping": (_clean_mapping(preset.mapping) if preset else None) or None,
    }
    if override:
        if str(override.get("action") or "") in ACTIONS:
            plan["action"] = override["action"]
        if "target_sheet_id" in override:
            tid = override["target_sheet_id"]
            plan["target_sheet_id"] = int(tid) if tid not in (None, "") else None
        for key in ("target_sheet_name",):
            if override.get(key):
                plan[key] = str(override[key]).strip()
        for key in ("header_row", "last_row", "id_column"):
            if override.get(key) is not None:
                try:
                    plan[key] = int(override[key])
                except (TypeError, ValueError):
                    pass
        if str(override.get("match_mode") or "") in excel.MATCH_MODES:
            plan["match_mode"] = override["match_mode"]
        if override.get("has_week_grid") is not None:
            plan["has_week_grid"] = bool(override["has_week_grid"])
            plan["week_grid_explicit"] = True
        if override.get("columns"):
            plan["mapping"] = _clean_mapping(override["columns"])

    # An "existing" target that no longer resolves has to become 新規 or the run
    # would fail late, after the earlier worksheets were already written.
    if plan["action"] == "existing" and plan["target_sheet_id"] not in sheets_by_id:
        plan["action"] = "new"
        plan["target_sheet_id"] = None
    return plan


@router.post("/workbook/inspect")
def inspect_workbook(
    file: UploadFile,
    plan: str = Form(default=""),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Dry-run a whole workbook: every worksheet matched to its saved setting, with
    the 新規/更新 counts and the warnings it would raise. Writes nothing."""
    data = xlsx.upload_bytes(file)
    wb = xlsx.workbook_from_bytes(data)
    presets = _presets_by_worksheet(db, user.org_id)
    overrides = _plan_items(plan)
    sheets_by_id = {
        s.id: s
        for s in db.execute(select(Sheet).where(Sheet.org_id == user.org_id)).scalars()
    }

    out: list[dict] = []
    for ws_meta in xlsx.worksheets_of(wb):
        ws_name = ws_meta["name"]
        preset = presets.get(ws_name)
        settings = _resolve(ws_name, preset, overrides.get(ws_name), sheets_by_id)
        entry = {
            "worksheet": ws_name,
            # Size of the worksheet itself, before the 見出し行 is taken off.
            "sheet_rows": ws_meta["rows"],
            "sheet_columns": ws_meta["columns"],
            "preset_id": preset.id if preset else None,
            "preset_updated_at": preset.updated_at.isoformat() if preset else None,
            **settings,
            "suggested_header_row": 0,
            "sheet_last_row": ws_meta["rows"],
            "total_rows": 0,
            "available_rows": 0,
            "column_count": 0,
            "new_rows": 0,
            "updated_rows": 0,
            "deleted_rows": 0,
            "blank_ids": 0,
            "duplicate_ids": 0,
            "invalid": 0,
            "warnings": [],
            "error": None,
        }
        # A preset that points nowhere is worth saying out loud — the sheet it used
        # to fill was deleted, so this run would create a fresh one.
        if preset and preset.target_sheet_id is None and settings["action"] == "new":
            entry["warnings"].append("取り込み先だったシートが見つかりません（新しく作成します）")

        if settings["action"] != "skip":
            try:
                _analyse(db, user, wb, ws_name, settings, sheets_by_id, entry)
            except HTTPException as exc:
                entry["error"] = str(exc.detail)
        out.append(entry)

    return {"workbook_name": file.filename or "", "worksheets": out}


def _analyse(
    db: Session,
    user: User,
    wb,
    ws_name: str,
    settings: dict,
    sheets_by_id: dict[int, Sheet],
    entry: dict,
) -> None:
    """Fill one worksheet's dry-run numbers into `entry` (mutated in place)."""
    _ws, grid, hr, header, data_rows = xlsx.slice_worksheet(
        wb, ws_name, settings["header_row"], settings["last_row"]
    )
    entry["header_row"] = hr
    # 形式（スケジュール／テーブル）を誰も選んでいないうちは、見出しから推測した形を出す。
    if not settings["week_grid_explicit"]:
        settings["has_week_grid"] = excel.looks_like_schedule(header)
        entry["has_week_grid"] = settings["has_week_grid"]
    entry["suggested_header_row"] = xlsx.auto_header_row(grid)
    entry["sheet_last_row"] = len(grid)
    entry["total_rows"] = len(data_rows)
    entry["available_rows"] = xlsx.data_row_total(grid, hr)
    id_column = settings["id_column"]

    if settings["action"] == "existing":
        sheet = sheets_by_id[settings["target_sheet_id"]]
        ensure_schedule_columns(db, sheet)
        cols, _targets = excel.row_target_info(
            db, user, sheet, header, data_rows, id_column, settings["mapping"]
        )
        taken = [c for c in cols if c["target"]]
        entry["column_count"] = len(taken)
        entry.update(
            excel.upsert_counts(db, sheet, data_rows, id_column, settings["match_mode"])
        )
        if entry["deleted_rows"]:
            entry["warnings"].append(
                f"取り込む前に、いまある {entry['deleted_rows']} 行を削除します（入れ替え）"
            )
        # A saved mapping can outlive the column it points at (renamed / deleted /
        # turned into 計算列). Those are skipped on import either way — the point of
        # saying so is that the setting is now stale.
        for c in cols:
            if c["lost_reason"] == "computed":
                entry["warnings"].append(
                    f"「{c['header']}」→「{c['lost_target']}」は計算列になったため取り込みません（値は自動計算）"
                )
            elif c["lost_reason"] == "missing":
                entry["warnings"].append(
                    f"「{c['header']}」の取り込み先「{c['lost_target']}」が見つかりません（この列は取り込まれません）"
                )
        skipped = [
            c["header"]
            for c in cols
            if not c["target"] and not c["lost_reason"] and c["index"] != id_column and c["header"]
        ]
        if skipped:
            entry["warnings"].append(f"取り込まない列：{'、'.join(skipped)}")
    else:
        cols = excel.new_sheet_column_info(
            db, user, header, data_rows, id_column, settings["has_week_grid"], settings["mapping"]
        )
        taken = [c for c in cols if c["selected"]]
        entry["column_count"] = len(taken)
        entry.update(excel.id_column_counts(data_rows, id_column))
        # 新しいシートなので照合する相手はいないが、「IDで照合」だとファイルの中で
        # 同じIDの行どうしが1行にまとまる。件数はその結果を出す（プレビューと実際が
        # 食い違わないように）。
        entry["new_rows"] = len(data_rows) - (
            entry["duplicate_ids"]
            if settings["match_mode"] == "id" and id_column >= 0
            else 0
        )

    entry["invalid"] = sum(c["invalid"] for c in taken)
    for c in taken:
        if c["invalid"]:
            entry["warnings"].append(
                f"「{c['header']}」に読めない値が {c['invalid']} 件（空欄で取り込まれます）"
            )
    if settings["match_mode"] != "id":
        # 照合しない／入れ替え：Excel の1行がそのまま1行になる。IDが重なっていても
        # まとまらないので、ここで警告することは何もない。
        if id_column < 0 and settings["match_mode"] == "none":
            entry["warnings"].append("すべて新規行として追加されます（IDは自動採番）")
    elif id_column < 0:
        entry["warnings"].append("ID列の指定がないため、すべて新規行として追加されます")
    else:
        if entry["blank_ids"]:
            entry["warnings"].append(f"IDが空の行が {entry['blank_ids']} 行（自動採番されます）")
        if entry["duplicate_ids"]:
            entry["warnings"].append(f"同じIDの行が {entry['duplicate_ids']} 行（1行にまとまります）")
    if entry["column_count"] == 0:
        entry["warnings"].append("取り込む列がありません")
    cut = entry["available_rows"] - entry["total_rows"]
    if cut > 0:
        entry["warnings"].append(
            f"{entry['last_row']} 行目までを取り込み（それ以降の {cut} 行は除外）"
        )


@router.post("/workbook")
def run_workbook(
    file: UploadFile,
    plan: str = Form(default=""),
    save_presets: bool = Form(default=True),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Import every non-skipped worksheet of a workbook in ONE transaction.

    Any failure rolls the whole thing back — with a dozen worksheets going into a
    dozen sheets, a partial import is far worse than none. On success each
    worksheet's settings are written back as a preset, so the next round is just
    「ファイルを選ぶ → 実行」.
    """
    data = xlsx.upload_bytes(file)
    wb = xlsx.workbook_from_bytes(data)
    presets = _presets_by_worksheet(db, user.org_id)
    overrides = _plan_items(plan)
    sheets_by_id = {
        s.id: s
        for s in db.execute(select(Sheet).where(Sheet.org_id == user.org_id)).scalars()
    }

    results: list[dict] = []
    ws_name = ""
    try:
        for ws_meta in xlsx.worksheets_of(wb):
            ws_name = ws_meta["name"]
            settings = _resolve(
                ws_name, presets.get(ws_name), overrides.get(ws_name), sheets_by_id
            )
            if settings["action"] == "skip":
                continue
            _ws, _grid, hr, header, data_rows = xlsx.slice_worksheet(
                wb, ws_name, settings["header_row"], settings["last_row"]
            )
            # Remember the RESOLVED 見出し行, not the 0 that means 自動判定 — the run
            # the user just confirmed is exactly what the next one should repeat.
            settings["header_row"] = hr
            # 確認画面と同じ推測を使う（画面で選ばれていれば、そちらが優先される）。
            if not settings["week_grid_explicit"]:
                settings["has_week_grid"] = excel.looks_like_schedule(header)
            if settings["action"] == "existing":
                sheet = sheets_by_id[settings["target_sheet_id"]]
                # commit=False: this run is all-or-nothing (see the except below).
                ensure_schedule_columns(db, sheet, commit=False)
                counts = excel.import_rows_with_mapping(
                    db, user, sheet, header, data_rows, settings["id_column"],
                    settings["mapping"], commit=False, match_mode=settings["match_mode"],
                )
                res = {"sheet_id": sheet.id, "name": sheet.name, "columns": 0, **counts}
            else:
                res = excel.create_sheet_with_selection(
                    db,
                    user,
                    name=settings["target_sheet_name"],
                    has_week_grid=settings["has_week_grid"],
                    worksheet_title=ws_name,
                    header=header,
                    data_rows=data_rows,
                    id_column=settings["id_column"],
                    selection=settings["mapping"],
                    commit=False,
                    match_mode=settings["match_mode"],
                )
            if save_presets:
                # Store the RESOLVED picks, not the plan's `None`: a first run that
                # relied on the defaults must still replay identically next time.
                _remember(
                    db, user, ws_name, file.filename or "", settings,
                    res["sheet_id"], res.get("selection"),
                )
            res.pop("selection", None)
            results.append({"worksheet": ws_name, "header_row": hr, **res})
    except HTTPException as exc:
        db.rollback()
        where = f"「{ws_name}」で失敗したため、すべて取り消しました：" if ws_name else ""
        raise HTTPException(status_code=exc.status_code, detail=f"{where}{exc.detail}")
    except Exception:
        db.rollback()
        raise

    if not results:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="取り込む対象がありません（取り込み先を選んでください）",
        )
    db.commit()
    return {
        "results": results,
        "created": sum(r["created"] for r in results),
        "updated": sum(r["updated"] for r in results),
        "deleted": sum(r.get("deleted", 0) for r in results),
    }


def _remember(
    db: Session,
    user: User,
    ws_name: str,
    workbook_name: str,
    settings: dict,
    sheet_id: int,
    selection: list[dict] | None,
) -> None:
    """Write the settings a worksheet was just imported with back as its preset.

    Always points at the sheet the data actually landed in — a worksheet imported
    as 新規 becomes an 更新 next time, which is what makes repeated data loads
    idempotent instead of duplicating sheets. Part of the caller's transaction.
    """
    preset = db.execute(
        select(ImportPreset).where(
            ImportPreset.org_id == user.org_id, ImportPreset.worksheet_name == ws_name
        )
    ).scalar_one_or_none()
    if preset is None:
        preset = ImportPreset(org_id=user.org_id, worksheet_name=ws_name, created_by=user.id)
        preset.name = ws_name[:255]
        db.add(preset)
    preset.workbook_name = workbook_name[:255]
    preset.target_sheet_id = sheet_id
    preset.target_sheet_name = settings["target_sheet_name"][:255]
    preset.has_week_grid = settings["has_week_grid"]
    preset.header_row = settings["header_row"]
    preset.last_row = settings["last_row"]
    preset.id_column = settings["id_column"]
    preset.match_mode = settings["match_mode"]
    effective = selection if selection is not None else settings["mapping"]
    if effective:
        preset.mapping = effective
    preset.last_used_at = datetime.now(timezone.utc)
    db.flush()
