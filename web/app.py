from __future__ import annotations

import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
from json import JSONDecodeError
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import requests
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.concurrency import run_in_threadpool

from fundrive.drives.wenshushu import Downloader, WSSDrive


WEB_DIR = Path(__file__).resolve().parent
STATIC_DIR = WEB_DIR / "static"
DATA_DIR = WEB_DIR / "data"
TEMP_DIR = WEB_DIR / "temp"
UPLOAD_TEMP_DIR = TEMP_DIR / "uploads"
DOWNLOAD_DIR = DATA_DIR / "downloads"
DB_PATH = DATA_DIR / "wenshushu.db"
ROOT_DIR = WEB_DIR.parent
PLAYWRIGHT_UPLOAD_SCRIPT = WEB_DIR / "upload_via_playwright.mjs"
AUTO_RENEW_CHECK_INTERVAL_SECONDS = 600
AUTO_RENEW_THRESHOLD_SECONDS = 6 * 3600
WENSHUSHU_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

for directory in (DATA_DIR, UPLOAD_TEMP_DIR, DOWNLOAD_DIR):
    directory.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Wenshushu Web", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response


app.add_middleware(NoCacheMiddleware)

_drive = WSSDrive()
_drive_lock = threading.RLock()


class DownloadRequest(BaseModel):
    share_url: str = Field(..., min_length=8)
    filename: str | None = None
    overwrite: bool = False


class AutoRenewRequest(BaseModel):
    enabled: bool


class IpUserMappingRequest(BaseModel):
    ip: str = Field(..., min_length=1)
    user: str = Field(..., min_length=1)


class RemarkRequest(BaseModel):
    remark: str = ""


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
                created_at INTEGER NOT NULL,
                task_id TEXT,
                owner_token TEXT,
                auto_renew INTEGER NOT NULL DEFAULT 0,
                renew_interval_days INTEGER NOT NULL DEFAULT 1,
                last_renew_at INTEGER NOT NULL DEFAULT 0,
                uploader_ip TEXT,
                user_name TEXT,
                remark TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ip_user_mappings (
                ip TEXT PRIMARY KEY,
                user_name TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
            """
        )
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(uploads)").fetchall()
        }
        optional_columns = {
            "task_id": "ALTER TABLE uploads ADD COLUMN task_id TEXT",
            "owner_token": "ALTER TABLE uploads ADD COLUMN owner_token TEXT",
            "auto_renew": "ALTER TABLE uploads ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 0",
            "renew_interval_days": "ALTER TABLE uploads ADD COLUMN renew_interval_days INTEGER NOT NULL DEFAULT 1",
            "last_renew_at": "ALTER TABLE uploads ADD COLUMN last_renew_at INTEGER NOT NULL DEFAULT 0",
            "uploader_ip": "ALTER TABLE uploads ADD COLUMN uploader_ip TEXT",
            "user_name": "ALTER TABLE uploads ADD COLUMN user_name TEXT",
            "remark": "ALTER TABLE uploads ADD COLUMN remark TEXT",
        }
        for column, ddl in optional_columns.items():
            if column not in columns:
                conn.execute(ddl)
        conn.commit()


def _safe_filename(filename: str | None, fallback: str) -> str:
    raw = Path(filename or fallback).name.strip()
    if not raw:
        raw = fallback
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", raw)


def _safe_text(value: str | None, max_length: int = 200) -> str:
    return (value or "").strip()[:max_length]


def _normalize_ip(ip: str | None) -> str:
    value = (ip or "").strip()
    if "," in value:
        value = value.split(",", 1)[0].strip()
    return value or "unknown"


def _get_request_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return _normalize_ip(forwarded)
    return _normalize_ip(request.client.host if request.client else "")


def _resolve_user_by_ip(ip: str) -> str:
    with _connect() as conn:
        row = conn.execute(
            "SELECT user_name FROM ip_user_mappings WHERE ip = ?",
            (ip,),
        ).fetchone()
    return row["user_name"] if row else ip


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
        "task_id": row["task_id"] or "",
        "auto_renew": bool(row["auto_renew"]),
        "renew_interval_days": int(row["renew_interval_days"] or 1),
        "last_renew_at": int(row["last_renew_at"] or 0),
        "can_auto_renew": bool((row["owner_token"] or "").strip()),
        "uploader_ip": row["uploader_ip"] or "",
        "user": row["user_name"] or row["uploader_ip"] or "",
        "remark": row["remark"] or "",
    }


def _drive_file_to_upload(
    file_info: dict[str, Any],
    uploader_ip: str = "",
    user_name: str = "",
    remark: str = "",
) -> dict[str, Any]:
    return {
        "id": file_info.get("fid", ""),
        "name": file_info.get("name", ""),
        "size": int(file_info.get("size") or 0),
        "upload_time": file_info.get("upload_time") or file_info.get("time") or "",
        "share_url": file_info.get("share_url") or "",
        "mgr_url": file_info.get("mgr_url") or "",
        "local_path": file_info.get("local_path") or "",
        "created_at": int(time.time()),
        "uploader_ip": uploader_ip,
        "user": user_name,
        "remark": remark,
    }


def _save_upload_record(upload: dict[str, Any]) -> None:
    with _connect() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO uploads
                (
                    id, filename, size, upload_time, share_url, mgr_url, local_path, created_at,
                    task_id, owner_token, auto_renew, renew_interval_days, last_renew_at,
                    uploader_ip, user_name, remark
                )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                upload.get("task_id", ""),
                upload.get("owner_token", ""),
                1 if upload.get("auto_renew") else 0,
                int(upload.get("renew_interval_days") or 1),
                int(upload.get("last_renew_at") or 0),
                upload.get("uploader_ip", ""),
                upload.get("user", ""),
                upload.get("remark", ""),
            ),
        )
        conn.commit()


def _list_uploads(
    keyword: str | None = None,
    user: str | None = None,
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM uploads"
    where: list[str] = []
    params: list[Any] = []
    if keyword:
        where.append(
            """
            (
                filename LIKE ?
                OR share_url LIKE ?
                OR remark LIKE ?
                OR user_name LIKE ?
                OR uploader_ip LIKE ?
            )
            """
        )
        like = f"%{keyword}%"
        params.extend([like, like, like, like, like])
    if user:
        where.append("COALESCE(NULLIF(user_name, ''), uploader_ip, '') = ?")
        params.append(user)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC"
    with _connect() as conn:
        return [_row_to_upload(row) for row in conn.execute(sql, tuple(params)).fetchall()]


def _list_ip_user_mappings() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT ip, user_name FROM ip_user_mappings ORDER BY ip"
        ).fetchall()
    return [{"ip": row["ip"], "user": row["user_name"]} for row in rows]


def _list_users() -> list[str]:
    users: set[str] = set()
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT COALESCE(NULLIF(user_name, ''), uploader_ip, '') AS user
            FROM uploads
            WHERE COALESCE(NULLIF(user_name, ''), uploader_ip, '') != ''
            UNION
            SELECT user_name AS user FROM ip_user_mappings WHERE COALESCE(user_name, '') != ''
            ORDER BY user
            """
        ).fetchall()
    for row in rows:
        if row["user"]:
            users.add(row["user"])
    return sorted(users)


def _save_ip_user_mapping(ip: str, user: str) -> dict[str, Any]:
    safe_ip = _normalize_ip(ip)
    safe_user = _safe_text(user, 80)
    if safe_ip == "unknown":
        raise RuntimeError("IP不能为空")
    if not safe_user:
        raise RuntimeError("用户不能为空")

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO ip_user_mappings (ip, user_name, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(ip) DO UPDATE SET
                user_name = excluded.user_name,
                created_at = excluded.created_at
            """,
            (safe_ip, safe_user, int(time.time())),
        )
        conn.execute(
            """
            UPDATE uploads
            SET user_name = ?
            WHERE uploader_ip = ?
            """,
            (safe_user, safe_ip),
        )
        conn.commit()
    return {"ip": safe_ip, "user": safe_user}


def _delete_ip_user_mapping(ip: str) -> None:
    safe_ip = _normalize_ip(ip)
    with _connect() as conn:
        conn.execute("DELETE FROM ip_user_mappings WHERE ip = ?", (safe_ip,))
        conn.execute("UPDATE uploads SET user_name = '' WHERE uploader_ip = ?", (safe_ip,))
        conn.commit()


def _update_upload_remark(upload_id: str, remark: str) -> dict[str, Any]:
    with _connect() as conn:
        row = conn.execute("SELECT id FROM uploads WHERE id = ?", (upload_id,)).fetchone()
        if row is None:
            raise RuntimeError("未找到上传记录")
        conn.execute(
            "UPDATE uploads SET remark = ? WHERE id = ?",
            (_safe_text(remark, 500), upload_id),
        )
        refreshed = conn.execute("SELECT * FROM uploads WHERE id = ?", (upload_id,)).fetchone()
        conn.commit()
    return _row_to_upload(refreshed)


def _delete_upload_record(upload_id: str) -> None:
    with _connect() as conn:
        row = conn.execute("SELECT id FROM uploads WHERE id = ?", (upload_id,)).fetchone()
        if row is None:
            raise RuntimeError("未找到上传记录")
        conn.execute("DELETE FROM uploads WHERE id = ?", (upload_id,))
        conn.commit()


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
            raise RuntimeError(getattr(_drive, "last_error", "") or "Upload failed")

        latest_id = next(reversed(_drive.uploaded_files))
        latest = dict(_drive.uploaded_files[latest_id])
        latest["fid"] = latest_id
        latest["local_path"] = str(filepath)
        upload = _drive_file_to_upload(latest)
        _save_upload_record(upload)
        return upload


def _upload_to_wenshushu_via_playwright(
    filepath: Path,
    filename: str,
    auto_renew: bool,
    uploader_ip: str,
    user_name: str,
    remark: str,
) -> dict[str, Any]:
    command = [
        "node",
        str(PLAYWRIGHT_UPLOAD_SCRIPT),
        str(filepath),
        filename,
    ]
    result = subprocess.run(
        command,
        cwd=ROOT_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip() or "Playwright upload failed"
        raise RuntimeError(detail)

    stdout = result.stdout.strip()
    if not stdout:
        raise RuntimeError("Playwright upload returned empty result")

    try:
        payload = json.loads(stdout)
    except JSONDecodeError as exc:
        raise RuntimeError(f"Invalid Playwright upload result: {stdout}") from exc

    if not payload.get("ok"):
        raise RuntimeError(payload.get("error") or "Playwright upload failed")

    upload = {
        "id": payload.get("fid") or f"pw_{int(time.time())}",
        "name": filename,
        "size": filepath.stat().st_size,
        "upload_time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "share_url": payload.get("share_url") or "",
        "mgr_url": payload.get("mgr_url") or "",
        "local_path": str(filepath),
        "created_at": int(time.time()),
        "task_id": payload.get("task_id") or payload.get("fid") or "",
        "owner_token": payload.get("owner_token") or "",
        "auto_renew": bool(auto_renew and payload.get("owner_token")),
        "renew_interval_days": 1,
        "last_renew_at": 0,
        "uploader_ip": uploader_ip,
        "user": user_name,
        "remark": remark,
    }
    _save_upload_record(upload)
    return upload


def _build_owner_session(owner_token: str) -> requests.Session:
    if not owner_token:
        raise RuntimeError("该记录缺少续期凭据，请重新上传")

    session = requests.Session()
    session.headers.update(
        {
            "X-TOKEN": owner_token,
            "User-Agent": WENSHUSHU_USER_AGENT,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN, en-um;q=0.9",
            "Content-Type": "application/json;charset=UTF-8",
            "Prod": "com.wenshushu.web.pc",
            "Referer": "https://www.wenshushu.cn/",
            "Origin": "https://www.wenshushu.cn",
        }
    )
    return session


def _get_task_tid(row: sqlite3.Row) -> str:
    task_id = (row["task_id"] or "").strip()
    if task_id:
        return task_id

    share_url = (row["share_url"] or "").strip()
    if not share_url:
        raise RuntimeError("该记录没有分享链接")
    return share_url.rstrip("/").split("/")[-1]


def _get_task_remaining_seconds(row: sqlite3.Row) -> float:
    session = _build_owner_session((row["owner_token"] or "").strip())
    task_id = _get_task_tid(row)
    response = session.post(
        "https://www.wenshushu.cn/ap/task/mgrtask",
        json={"tid": task_id, "password": ""},
        timeout=30,
    )
    payload = response.json()
    if payload.get("code") != 0:
        raise RuntimeError(payload.get("message") or "获取任务信息失败")
    return float(payload["data"]["expire"])


def _renew_upload_by_row(row: sqlite3.Row, delay_days: int | None = None) -> None:
    session = _build_owner_session((row["owner_token"] or "").strip())
    task_id = _get_task_tid(row)
    renew_days = int(delay_days or row["renew_interval_days"] or 1)
    response = session.post(
        "https://www.wenshushu.cn/ap/task/delay",
        json={"tid": task_id, "delay_time": renew_days, "is_extension": False},
        timeout=30,
    )
    payload = response.json()
    if payload.get("code") != 0:
        raise RuntimeError(payload.get("message") or "续期失败")

    with _connect() as conn:
        conn.execute(
            "UPDATE uploads SET last_renew_at = ? WHERE id = ?",
            (int(time.time()), row["id"]),
        )
        conn.commit()


def _set_auto_renew(upload_id: str, enabled: bool) -> dict[str, Any]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM uploads WHERE id = ?", (upload_id,)).fetchone()
        if row is None:
            raise RuntimeError("未找到上传记录")

        if enabled and not (row["owner_token"] or "").strip():
            raise RuntimeError("该记录缺少续期凭据，请重新上传")

        conn.execute(
            "UPDATE uploads SET auto_renew = ? WHERE id = ?",
            (1 if enabled else 0, upload_id),
        )
        conn.commit()

        refreshed = conn.execute("SELECT * FROM uploads WHERE id = ?", (upload_id,)).fetchone()
        return _row_to_upload(refreshed)


def _auto_renew_due_uploads_once() -> None:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM uploads WHERE auto_renew = 1 AND owner_token IS NOT NULL AND owner_token != ''"
        ).fetchall()

    for row in rows:
        try:
            remaining_seconds = _get_task_remaining_seconds(row)
            if remaining_seconds <= AUTO_RENEW_THRESHOLD_SECONDS:
                _renew_upload_by_row(row)
        except Exception:
            continue


def _auto_renew_worker() -> None:
    while True:
        try:
            _auto_renew_due_uploads_once()
        finally:
            time.sleep(AUTO_RENEW_CHECK_INTERVAL_SECONDS)


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


def _build_download_command(upload_id: str) -> dict[str, str]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT filename, share_url FROM uploads WHERE id = ?",
            (upload_id,),
        ).fetchone()

    if row is None:
        raise RuntimeError("未找到上传记录")

    filename = _safe_filename(row["filename"], "download.bin")
    share_url = (row["share_url"] or "").strip()
    if not share_url:
        raise RuntimeError("该记录没有分享链接")

    with _drive_lock:
        internal_drive = _drive if (_drive.session is not None and _drive.token) else None
        downloader = Downloader(share_url=share_url, drive=internal_drive or None)
        url = share_url
        if len(url.split("/")[-1]) == 16:
            tid = downloader.get_tid(url.split("/")[-1])
        elif len(url.split("/")[-1]) == 11:
            tid = url.split("/")[-1]
        else:
            raise RuntimeError("分享链接格式不正确")

        bid, pid = downloader.mgrtask(tid)
        response = downloader.session.post(
            url="https://www.wenshushu.cn/ap/ufile/list",
            json={
                "start": 0,
                "sort": {"name": "asc"},
                "bid": bid,
                "pid": pid,
                "type": 1,
                "options": {"uploader": "true"},
                "size": 50,
            },
        )
        files = response.json()["data"]["fileList"]
        target = next((item for item in files if item["fname"] == row["filename"]), None) or files[0]
        direct_url = downloader.sign_url(target["fid"])

    target_path = f"/home/forlinx/{filename}"
    command = f'rm -f "{target_path}" && wget -O "{target_path}" "{direct_url}"'
    return {"command": command, "filename": filename, "direct_url": direct_url}


@app.on_event("startup")
def on_startup() -> None:
    _init_db()
    worker = threading.Thread(target=_auto_renew_worker, daemon=True)
    worker.start()


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
def files(user: str = "") -> dict[str, Any]:
    return {"ok": True, "files": _list_uploads(user=user.strip() or None), "users": _list_users()}


@app.get("/api/search")
def search(keyword: str = "", user: str = "") -> dict[str, Any]:
    return {
        "ok": True,
        "files": _list_uploads(keyword.strip() or None, user.strip() or None),
        "users": _list_users(),
    }


@app.post("/api/upload")
async def upload(
    request: Request,
    file: UploadFile = File(...),
    filename: str | None = Form(default=None),
    auto_renew: bool = Form(default=False),
    remark: str | None = Form(default=""),
) -> dict[str, Any]:
    safe_name = _safe_filename(filename or file.filename, "upload.bin")
    uploader_ip = _get_request_ip(request)
    user_name = _resolve_user_by_ip(uploader_ip)
    safe_remark = _safe_text(remark, 500)
    upload_dir = UPLOAD_TEMP_DIR / uuid4().hex
    upload_dir.mkdir(parents=True, exist_ok=True)
    temp_path = upload_dir / safe_name

    try:
        with temp_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        upload_info = await run_in_threadpool(
            _upload_to_wenshushu_via_playwright,
            temp_path,
            safe_name,
            auto_renew,
            uploader_ip,
            user_name,
            safe_remark,
        )
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


@app.get("/api/download-command/{upload_id}")
def download_command(upload_id: str) -> dict[str, Any]:
    try:
        result = _build_download_command(upload_id)
        return {"ok": True, **result}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.delete("/api/files/{upload_id}")
def delete_upload_record(upload_id: str) -> dict[str, Any]:
    try:
        _delete_upload_record(upload_id)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/files/{upload_id}/remark")
def update_remark(upload_id: str, request: RemarkRequest) -> dict[str, Any]:
    try:
        upload = _update_upload_remark(upload_id, request.remark)
        return {"ok": True, "file": upload}
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/auto-renew/{upload_id}")
def set_auto_renew(upload_id: str, request: AutoRenewRequest) -> dict[str, Any]:
    try:
        upload = _set_auto_renew(upload_id, request.enabled)
        return {"ok": True, "file": upload}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/ip-users")
def ip_users() -> dict[str, Any]:
    return {"ok": True, "mappings": _list_ip_user_mappings(), "users": _list_users()}


@app.post("/api/ip-users")
def save_ip_user_mapping(request: IpUserMappingRequest) -> dict[str, Any]:
    try:
        mapping = _save_ip_user_mapping(request.ip, request.user)
        return {"ok": True, "mapping": mapping, "mappings": _list_ip_user_mappings(), "users": _list_users()}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/ip-users/{ip}")
def delete_ip_user_mapping(ip: str) -> dict[str, Any]:
    _delete_ip_user_mapping(ip)
    return {"ok": True, "mappings": _list_ip_user_mappings(), "users": _list_users()}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
