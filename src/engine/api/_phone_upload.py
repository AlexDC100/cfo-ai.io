"""Upload portal — the LOCAL NETWORK route.

Ported from DocVex's desktop upload server (``src/phoneUploadServer.js``).
Every upload section of the web app on a PC offers "Upload from phone": a QR
code the phone scans. This module is the route that never leaves the
network: the ENGINE ITSELF serves the phone page and receives the files,
which then wait here until the PC's browser takes them into the upload
section that opened the portal (or rejects them). The other route, through
the cloud, is the Supabase Edge Function ``phone-upload``
(supabase/schema_phase_phone_upload.sql).

ONLY WHEN THE ENGINE RUNS ON THE USER'S OWN COMPUTER. A phone can reach this
engine only on the same network, so the route is OFF unless
``PHONE_UPLOAD_LOCAL`` is set (``1`` / ``true`` / ``yes``) — set it in the
local ``docker-compose.override.yml`` or the dev shell, never on the VPS.
While off, every route here answers 404 ``local_disabled`` and the frontend
shows only the cloud route. The routes are REGISTERED unconditionally (the
anonymous-route gate refuses a route registered under an undeclared flag);
the switch is read per request.

Addresses. The phone needs this computer's LAN address. Detected from the
host's interfaces; inside Docker that is the CONTAINER's, which a phone
cannot reach — set ``PHONE_UPLOAD_LAN_URL`` (e.g. ``http://192.168.1.20:8000``)
to the host's address and published port. The session answer says
``in_container`` so the UI can tell the user.

The phone side holds a random 144-bit token (in the QR code's fragment,
sent as ``x-upload-token``); only its SHA-256 is kept. Sessions and staged
files live in this process (memory + a temp directory): a restart drops
them, which for a hand-off is the right failure.

Routes (prefix ``/api/phone-upload/local``):

  PC (signed in, ``Authorization: Bearer <jwt>``):
    POST /sessions                         {surface, token?} → {token, session_id, urls, expires_at}
    POST /sessions/{sid}/close             pauses it (the PC closed the window)
    GET  /sessions/{sid}/files             files waiting
    GET  /sessions/{sid}/files/{fid}       the bytes
    POST /sessions/{sid}/files/{fid}/decision   {status: accepted|rejected}

  Phone (``x-upload-token``):
    GET  /page                             the phone page
    GET  /info                             is the portal open?
    POST /file?name=…                      raw body, one file
    GET  /status?ids=a,b                   what the PC decided
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import secrets
import shutil
import socket
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

PAGE_PATH = Path(__file__).with_name("phone_upload_page.html")

SESSION_SECONDS = 7 * 24 * 3600  # sliding: every reopen pushes it back
MAX_FILE_BYTES = 200 * 1024 * 1024
MAX_FILES = 300
MAX_SESSION_BYTES = 2 * 1024 * 1024 * 1024
DECIDED_KEEP = 2000  # decisions remembered for the phone's status poll

SURFACES = {"workspace", "company", "statements", "periods", "products", "sources", "budget", "chat", "upload"}
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def local_enabled() -> bool:
    """Read per request, so a test (or an operator) can flip it."""
    return os.environ.get("PHONE_UPLOAD_LOCAL", "").strip().lower() in {"1", "true", "yes", "on"}


def _stage_root() -> Path:
    root = Path(os.environ.get("PHONE_UPLOAD_DIR") or Path(tempfile.gettempdir()) / "cfo-ai-phone-upload")
    root.mkdir(parents=True, exist_ok=True)
    return root


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _clean_name(name: str) -> str:
    base = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(name or "file")).strip(" .")
    return (base or "file")[:200]


# ── State (one process) ─────────────────────────────────────────────────────

class _Store:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.sessions: Dict[str, Dict[str, Any]] = {}   # sid → session
        self.by_hash: Dict[str, str] = {}               # token hash → sid
        self.decided: Dict[str, tuple] = {}             # file id → (session id, accepted|rejected)

    def reset(self) -> None:
        with self.lock:
            for s in self.sessions.values():
                shutil.rmtree(s["dir"], ignore_errors=True)
            self.sessions.clear()
            self.by_hash.clear()
            self.decided.clear()

    def sweep(self) -> None:
        """Sessions a day past their end lose their staged files."""
        cutoff = time.time() - 24 * 3600
        with self.lock:
            for sid in [k for k, s in self.sessions.items() if s["expires_at"] < cutoff]:
                s = self.sessions.pop(sid)
                self.by_hash.pop(s["token_hash"], None)
                shutil.rmtree(s["dir"], ignore_errors=True)


STORE = _Store()


def _phone_session(token: Optional[str]) -> Dict[str, Any]:
    """The open session a phone's token names, or the HTTP refusal."""
    if not local_enabled():
        raise HTTPException(status_code=404, detail="local_disabled")
    if not token or not _TOKEN_RE.match(token):
        raise HTTPException(status_code=401, detail="no_token")
    h = _hash(token)
    with STORE.lock:
        sid = STORE.by_hash.get(h)
        s = STORE.sessions.get(sid) if sid else None
    # Constant-time compare on the stored hash too (the dict lookup already
    # keyed on it; this keeps a timing-equal path for a present entry).
    if not s or not hmac.compare_digest(s["token_hash"], h):
        raise HTTPException(status_code=404, detail="unknown")
    if s["closed"]:
        raise HTTPException(status_code=410, detail="closed")
    if s["expires_at"] < time.time():
        raise HTTPException(status_code=410, detail="expired")
    return s


def _pc_user(authorization: Optional[str]) -> str:
    if not local_enabled():
        raise HTTPException(status_code=404, detail="local_disabled")
    from ._billing import _require_jwt, _user_id_from_jwt
    return _user_id_from_jwt(_require_jwt(authorization))


def _owned(sid: str, user_id: str) -> Dict[str, Any]:
    with STORE.lock:
        s = STORE.sessions.get(sid)
    if not s or s["user_id"] != user_id:
        raise HTTPException(status_code=404, detail="unknown_session")
    return s


# ── Addresses ───────────────────────────────────────────────────────────────

def _private(ip: str) -> bool:
    return bool(re.match(r"^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)", ip))


def lan_urls(request_port: Optional[int]) -> List[str]:
    """The addresses a phone on the same network can try, likeliest first."""
    override = os.environ.get("PHONE_UPLOAD_LAN_URL", "").strip().rstrip("/")
    if override:
        return [override]
    port = int(os.environ.get("PHONE_UPLOAD_PORT") or request_port or 8000)
    ips: List[str] = []
    try:
        # No packet is sent: connect() on UDP only picks the outgoing interface.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ips.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.append(info[4][0])
    except OSError:
        pass
    seen: List[str] = []
    for ip in ips:
        if ip and not ip.startswith("127.") and ip not in seen:
            seen.append(ip)
    seen.sort(key=lambda ip: (not _private(ip), not ip.startswith("192.168.")))
    return [f"http://{ip}:{port}" for ip in seen]


def _in_container() -> bool:
    return Path("/.dockerenv").exists() and not os.environ.get("PHONE_UPLOAD_LAN_URL")


# ── Request bodies (module scope — §22: never inside the router factory) ────

class SessionRequest(BaseModel):
    surface: Optional[str] = None
    token: Optional[str] = None


class DecisionRequest(BaseModel):
    status: str


def _file_view(f: Dict[str, Any]) -> Dict[str, Any]:
    return {"id": f["id"], "name": f["name"], "size": f["size"], "mime": f["mime"], "created_at": f["created_at"]}


def build_router() -> APIRouter:
    router = APIRouter(prefix="/api/phone-upload/local", tags=["phone-upload"])

    # ── PC ──────────────────────────────────────────────────────────────────

    @router.post("/sessions")
    def create_session(req: SessionRequest, request: Request, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        user_id = _pc_user(authorization)
        STORE.sweep()
        surface = req.surface if req.surface in SURFACES else "upload"
        expires_at = time.time() + SESSION_SECONDS
        kept = req.token if req.token and _TOKEN_RE.match(req.token) else ""
        with STORE.lock:
            if kept:
                sid = STORE.by_hash.get(_hash(kept))
                s = STORE.sessions.get(sid) if sid else None
                if s and s["user_id"] == user_id:
                    s.update(closed=False, expires_at=expires_at, surface=surface)
                    token = kept
                else:
                    kept = ""
            if not kept:
                token = secrets.token_urlsafe(18)
                sid = uuid.uuid4().hex
                d = _stage_root() / sid
                d.mkdir(parents=True, exist_ok=True)
                STORE.sessions[sid] = {
                    "id": sid, "user_id": user_id, "token_hash": _hash(token), "surface": surface,
                    "expires_at": expires_at, "closed": False, "dir": d, "files": {}, "bytes": 0, "count": 0,
                }
                STORE.by_hash[_hash(token)] = sid
        return {
            "ok": True,
            "token": token,
            "session_id": sid,
            "expires_at": expires_at,
            "urls": lan_urls(request.url.port),
            "in_container": _in_container(),
            "computer": socket.gethostname(),
        }

    @router.post("/sessions/{sid}/close")
    def close_session(sid: str, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        s = _owned(sid, _pc_user(authorization))
        with STORE.lock:
            s["closed"] = True
        return {"ok": True}

    @router.get("/sessions/{sid}/files")
    def list_files(sid: str, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        s = _owned(sid, _pc_user(authorization))
        with STORE.lock:
            files = [_file_view(f) for f in s["files"].values() if f["status"] == "waiting"]
        files.sort(key=lambda f: f["created_at"])
        return {"ok": True, "files": files}

    @router.get("/sessions/{sid}/files/{fid}")
    def get_file(sid: str, fid: str, authorization: Optional[str] = Header(None)) -> FileResponse:
        s = _owned(sid, _pc_user(authorization))
        with STORE.lock:
            f = s["files"].get(fid)
        if not f or not Path(f["path"]).exists():
            raise HTTPException(status_code=404, detail="unknown_file")
        return FileResponse(f["path"], media_type=f["mime"] or "application/octet-stream", filename=f["name"])

    @router.post("/sessions/{sid}/files/{fid}/decision")
    def decide(sid: str, fid: str, req: DecisionRequest, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        s = _owned(sid, _pc_user(authorization))
        if req.status not in {"accepted", "rejected"}:
            raise HTTPException(status_code=400, detail="bad_status")
        with STORE.lock:
            f = s["files"].pop(fid, None)
            if f is None:
                raise HTTPException(status_code=404, detail="unknown_file")
            STORE.decided[fid] = (sid, req.status)
            while len(STORE.decided) > DECIDED_KEEP:
                STORE.decided.pop(next(iter(STORE.decided)))
        try:
            os.remove(f["path"])
        except OSError:
            pass
        return {"ok": True}

    # ── Phone ───────────────────────────────────────────────────────────────

    @router.get("/page")
    def page() -> HTMLResponse:
        if not local_enabled():
            raise HTTPException(status_code=404, detail="local_disabled")
        return HTMLResponse(
            PAGE_PATH.read_text(encoding="utf-8"),
            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY"},
        )

    @router.get("/info")
    def info(x_upload_token: Optional[str] = Header(None)) -> Dict[str, Any]:
        s = _phone_session(x_upload_token)
        return {"ok": True, "surface": s["surface"], "files": s["count"], "maxBytes": MAX_FILE_BYTES}

    @router.post("/file")
    async def receive(request: Request, name: str = "file", x_upload_token: Optional[str] = Header(None)) -> JSONResponse:
        s = _phone_session(x_upload_token)
        declared = int(request.headers.get("content-length") or 0)
        if declared > MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail="too_large")
        if s["count"] >= MAX_FILES:
            raise HTTPException(status_code=429, detail="too_many")
        if s["bytes"] + declared > MAX_SESSION_BYTES:
            raise HTTPException(status_code=413, detail="session_full")
        fid = uuid.uuid4().hex
        part = Path(s["dir"]) / f".{fid}.part"
        size = 0
        try:
            with open(part, "wb") as out:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_FILE_BYTES:
                        raise HTTPException(status_code=413, detail="too_large")
                    out.write(chunk)
        except BaseException:
            part.unlink(missing_ok=True)
            raise
        final = Path(s["dir"]) / fid
        part.replace(final)
        mime = (request.headers.get("content-type") or "").split(";")[0].strip()[:120] or None
        entry = {
            "id": fid, "name": _clean_name(name), "size": size, "mime": mime, "path": str(final),
            "status": "waiting", "created_at": time.time(),
        }
        with STORE.lock:
            s["files"][fid] = entry
            s["count"] += 1
            s["bytes"] += size
        return JSONResponse({"ok": True, "id": fid, "held": True})

    @router.get("/status")
    def status(ids: str = "", x_upload_token: Optional[str] = Header(None)) -> Dict[str, Any]:
        s = _phone_session(x_upload_token)
        out: Dict[str, str] = {}
        with STORE.lock:
            for fid in [i for i in ids.split(",") if _ID_RE.match(i)][:200]:
                if fid in s["files"]:
                    out[fid] = "waiting"
                else:
                    got = STORE.decided.get(fid)
                    out[fid] = got[1] if got and got[0] == s["id"] else "unknown"
        return {"ok": True, "status": out}

    return router
