from __future__ import annotations

import os
import re
import shutil
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from fundrive.drives.wenshushu import WSSDrive


WEB_DIR = Path(__file__).resolve().parent
STATIC_DIR = WEB_DIR / "static"
DATA_DIR = WEB_DIR / "data"
TEMP_DIR = WEB_DIR / "temp"
UPLOAD_TEMP_DIR = TEMP_DIR / "uploads"
DOWNLOAD_DIR = DATA_DIR / "downloads"
DB_PATH = DATA_DIR / "wenshushu.db"

for directory in (DATA_DIR, UPLOAD_TEMP_DIR, DOWNLOAD_DIR):
    directory.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Wenshushu Web", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_drive = WSSDrive()
_drive_lock = threading.RLock()


class DownloadRequest(BaseModel):
    share_url: str = Field(..., min_length=8)
    filename: str | None = None
    overwrite: bool = False


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS uploads (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                size INTEGER NOT NULL DEFAULT 0,
                upload_time TEXT,
                share_url TEXT,
                mgr_url TEXT,
                local_path TEXT,
                created_at INTEGER NOT NULL
            )
            """
        )
        conn.commit()


def _safe_filename(filename: str | None, fallback: str) -> str:
    raw = Path(filename or fallback).name.strip()
    if not raw:
        raw = fallback
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", raw)


def _row_to_upload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["filename"],
        "size": row["size"],
        "upload_time": row["upload_time"],
        "share_url": row["share_url"] or "",
        "mgr_url": row["mgr_url"] or "",
        "local_path": row["local_path"] or "",
        "created_at": row["created_at"],
    }


def _drive_file_to_upload(file_info: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": file_info.get("fid", ""),
        "name": file_info.get("name", ""),
        "size": int(file_info.get("size") or 0),
        "upload_time": file_info.get("upload_time") or file_info.get("time") or "",
        "share_url": file_info.get("share_url") or "",
        "mgr_url": file_info.get("mgr_url") or "",
        "local_path": file_info.get("local_path") or "",
        "created_at": int(time.time()),
    }


def _save_upload_record(upload: dict[str, Any]) -> None:
    with _connect() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO uploads
                (id, filename, size, upload_time, share_url, mgr_url, local_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                upload["id"],
                upload["name"],
                upload["size"],
                upload.get("upload_time", ""),
                upload.get("share_url", ""),
                upload.get("mgr_url", ""),
                upload.get("local_path", ""),
                upload["created_at"],
            ),
        )
        conn.commit()


def _list_uploads(keyword: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM uploads"
    params: tuple[Any, ...] = ()
    if keyword:
        sql += " WHERE filename LIKE ? OR share_url LIKE ?"
        like = f"%{keyword}%"
        params = (like, like)
    sql += " ORDER BY created_at DESC"
    with _connect() as conn:
        return [_row_to_upload(row) for row in conn.execute(sql, params).fetchall()]


def _ensure_login() -> bool:
    with _drive_lock:
        if _drive.session is not None and _drive.token:
            return True
        ok = _drive.login()
        if ok:
            _drive._is_logged_in = True
        return ok


def _get_storage() -> dict[str, Any]:
    with _drive_lock:
        if not _ensure_login():
            raise RuntimeError("Wenshushu anonymous login failed")
        return _drive.get_storage_info()


def _upload_to_wenshushu(filepath: Path, filename: str) -> dict[str, Any]:
    with _drive_lock:
        if not _ensure_login():
            raise RuntimeError("Wenshushu anonymous login failed")
        success = _drive.upload_file(str(filepath), "", filename=filename)
        if not success or not _drive.uploaded_files:
            raise RuntimeError("Upload failed")

        latest_id = next(reversed(_drive.uploaded_files))
        latest = dict(_drive.uploaded_files[latest_id])
        latest["fid"] = latest_id
        latest["local_path"] = str(filepath)
        upload = _drive_file_to_upload(latest)
        _save_upload_record(upload)
        return upload


def _download_from_wenshushu(request: DownloadRequest) -> dict[str, Any]:
    share_url = request.share_url.strip()
    if not share_url.startswith(("http://", "https://")):
        raise RuntimeError("Download requires a Wenshushu share link")

    before = {path.name for path in DOWNLOAD_DIR.iterdir() if path.is_file()}
    with _drive_lock:
        if not _ensure_login():
            raise RuntimeError("Wenshushu anonymous login failed")
        success = _drive.download_file(
            share_url,
            save_dir=str(DOWNLOAD_DIR),
            overwrite=request.overwrite,
        )
    if not success:
        raise RuntimeError("Download failed")

    after_paths = [path for path in DOWNLOAD_DIR.iterdir() if path.is_file()]
    new_paths = [path for path in after_paths if path.name not in before]
    saved_paths = new_paths or after_paths

    if request.filename and len(saved_paths) == 1:
        target = DOWNLOAD_DIR / _safe_filename(request.filename, saved_paths[0].name)
        if target.exists() and not request.overwrite:
            raise RuntimeError(f"File already exists: {target.name}")
        if target != saved_paths[0]:
            saved_paths[0].replace(target)
            saved_paths = [target]

    return {
        "success": True,
        "download_dir": str(DOWNLOAD_DIR),
        "files": [{"name": path.name, "size": path.stat().st_size} for path in saved_paths],
    }


@app.on_event("startup")
def on_startup() -> None:
    _init_db()


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/status")
def status() -> dict[str, Any]:
    ok = _ensure_login()
    return {"ok": ok, "logged_in": ok, "service": "wenshushu"}


@app.get("/api/storage")
def storage() -> dict[str, Any]:
    try:
        return {"ok": True, "storage": _get_storage()}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/files")
def files() -> dict[str, Any]:
    return {"ok": True, "files": _list_uploads()}


@app.get("/api/search")
def search(keyword: str = "") -> dict[str, Any]:
    return {"ok": True, "files": _list_uploads(keyword.strip() or None)}


@app.post("/api/upload")
async def upload(
    file: UploadFile = File(...),
    filename: str | None = Form(default=None),
) -> dict[str, Any]:
    safe_name = _safe_filename(filename or file.filename, "upload.bin")
    temp_path = UPLOAD_TEMP_DIR / f"{uuid4().hex}_{safe_name}"

    try:
        with temp_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        upload_info = await run_in_threadpool(_upload_to_wenshushu, temp_path, safe_name)
        return {"ok": True, "file": upload_info}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    finally:
        await file.close()


@app.post("/api/download")
async def download(request: DownloadRequest) -> dict[str, Any]:
    try:
        result = await run_in_threadpool(_download_from_wenshushu, request)
        return {"ok": True, **result}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
