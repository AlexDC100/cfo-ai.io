"""Upload portal — the LOCAL NETWORK route (src/engine/api/_phone_upload.py).

What it reds on:
  * the route answering anything but 404 `local_disabled` while
    PHONE_UPLOAD_LOCAL is unset (it must never be live on the VPS);
  * a phone request without, or with a wrong, token reaching a session;
  * a file not reaching the PC byte for byte, or the PC's decision not
    reaching the phone;
  * one user reading another user's portal;
  * a closed portal still taking files;
  * the reopened (kept) token not naming the same portal.
The PC's identity is stubbed (`_pc_user`): JWT verification has its own gates.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

from engine.api import _phone_upload as pu


@pytest.fixture()
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("PHONE_UPLOAD_LOCAL", "1")
    monkeypatch.setenv("PHONE_UPLOAD_DIR", str(tmp_path))
    monkeypatch.setenv("PHONE_UPLOAD_LAN_URL", "http://192.168.1.20:8000")

    def fake_user(authorization):
        if not pu.local_enabled():
            raise HTTPException(status_code=404, detail="local_disabled")
        if not authorization:
            raise HTTPException(status_code=401, detail="no_jwt")
        return authorization.replace("Bearer ", "")

    monkeypatch.setattr(pu, "_pc_user", fake_user)
    pu.STORE.reset()
    app = FastAPI()
    app.include_router(pu.build_router())
    yield TestClient(app)
    pu.STORE.reset()


def _open(client, user="alice", token=None):
    r = client.post("/api/phone-upload/local/sessions", json={"surface": "products", "token": token},
                    headers={"Authorization": f"Bearer {user}"})
    assert r.status_code == 200, r.text
    return r.json()


def test_off_by_default(monkeypatch, client):
    monkeypatch.delenv("PHONE_UPLOAD_LOCAL")
    assert client.get("/api/phone-upload/local/page").status_code == 404
    assert client.get("/api/phone-upload/local/info", headers={"x-upload-token": "x" * 24}).status_code == 404
    r = client.post("/api/phone-upload/local/sessions", json={}, headers={"Authorization": "Bearer alice"})
    assert r.status_code == 404


def test_the_page_is_served(client):
    r = client.get("/api/phone-upload/local/page")
    assert r.status_code == 200
    assert "CFO AI" in r.text and r.headers["cache-control"] == "no-store"


def test_a_file_travels_and_the_decision_comes_back(client):
    s = _open(client)
    assert s["urls"] == ["http://192.168.1.20:8000"]
    phone = {"x-upload-token": s["token"]}
    assert client.get("/api/phone-upload/local/info", headers=phone).json()["surface"] == "products"

    body = b"Cont,Denumire\n101,Capital social\n"
    r = client.post("/api/phone-upload/local/file?name=../../vanzari.csv", content=body,
                    headers={**phone, "content-type": "text/csv"})
    assert r.status_code == 200, r.text
    fid = r.json()["id"]

    pc = {"Authorization": "Bearer alice"}
    files = client.get(f"/api/phone-upload/local/sessions/{s['session_id']}/files", headers=pc).json()["files"]
    assert [f["id"] for f in files] == [fid]
    assert "/" not in files[0]["name"] and files[0]["name"].endswith("vanzari.csv")
    got = client.get(f"/api/phone-upload/local/sessions/{s['session_id']}/files/{fid}", headers=pc)
    assert got.content == body

    assert client.get(f"/api/phone-upload/local/status?ids={fid}", headers=phone).json()["status"][fid] == "waiting"
    r = client.post(f"/api/phone-upload/local/sessions/{s['session_id']}/files/{fid}/decision",
                    json={"status": "accepted"}, headers=pc)
    assert r.status_code == 200
    assert client.get(f"/api/phone-upload/local/status?ids={fid}", headers=phone).json()["status"][fid] == "accepted"
    assert client.get(f"/api/phone-upload/local/sessions/{s['session_id']}/files", headers=pc).json()["files"] == []


def test_wrong_token_and_wrong_owner_are_refused(client):
    s = _open(client)
    assert client.post("/api/phone-upload/local/file", content=b"x",
                       headers={"x-upload-token": "A" * 24}).status_code == 404
    assert client.post("/api/phone-upload/local/file", content=b"x").status_code == 401
    other = {"Authorization": "Bearer mallory"}
    assert client.get(f"/api/phone-upload/local/sessions/{s['session_id']}/files", headers=other).status_code == 404


def test_closed_portal_takes_nothing_and_reopens_with_the_kept_token(client):
    s = _open(client)
    pc = {"Authorization": "Bearer alice"}
    client.post(f"/api/phone-upload/local/sessions/{s['session_id']}/close", headers=pc)
    r = client.post("/api/phone-upload/local/file", content=b"x", headers={"x-upload-token": s["token"]})
    assert r.status_code == 410
    again = _open(client, token=s["token"])
    assert again["session_id"] == s["session_id"] and again["token"] == s["token"]
    # Another user's kept token names nothing of theirs: a fresh portal.
    theirs = _open(client, user="mallory", token=s["token"])
    assert theirs["session_id"] != s["session_id"]


def test_status_answers_only_for_the_asking_portal(client):
    a, b = _open(client), _open(client, user="bob")
    fid = client.post("/api/phone-upload/local/file", content=b"x",
                      headers={"x-upload-token": a["token"]}).json()["id"]
    client.post(f"/api/phone-upload/local/sessions/{a['session_id']}/files/{fid}/decision",
                json={"status": "rejected"}, headers={"Authorization": "Bearer alice"})
    st = client.get(f"/api/phone-upload/local/status?ids={fid}", headers={"x-upload-token": b["token"]}).json()
    assert st["status"][fid] == "unknown"
