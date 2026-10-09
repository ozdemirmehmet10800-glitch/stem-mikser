"""Hedef melodi (Mikrofon paketi 9) API uclari: GERCEK handler'lar, sahte Modal.

test_lyrics_api.py ile ayni yontem: `api()` fabrikasinin dondurdugu FastAPI uygulamasi TestClient ile calisir; Volume, `.spawn` ve
seviye olcumu sahtelenir. SENTETIK veri (gercek vokal / soz YOK). Kapsam: POST/GET /songs/{id}/melody, vokal yok kapisi (is acilmaz),
kaynak secimi (lead / vocals), mevcut sonuc korumasi, replace, silme ve yeniden isleme engelleri, /songs alanlari, bayat isareti.

Gerektirir: fastapi==0.141.1 starlette==1.7.0 python-multipart==0.0.32 httpx==0.28.1.
Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\test_melody_api.py
"""

import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile
import time

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSED, FAILED = [], []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


class FakeCall:
    object_id = "fc-melody-1"


class FakeSpawner:
    def __init__(self):
        self.calls = []

    def spawn(self, *args):
        self.calls.append(args)
        return FakeCall()


class AioCallable:
    def __init__(self):
        self.count = 0

    def __call__(self, *a, **k):
        self.count += 1

    async def aio(self, *a, **k):
        self.count += 1


class FakeVolume:
    def __init__(self):
        self.commit = AioCallable()
        self.reload = AioCallable()


LEVELS = {}


def make_song(root, song_id, loud=True, state="done", melody=None, sub=None, lead=False, blob=None, stems_version=7):
    base = pathlib.Path(root) / "songs" / song_id
    LEVELS[(song_id, "vocals")] = -20.0 if loud else -200.0
    (base / "master").mkdir(parents=True, exist_ok=True)
    (base / "master" / "vocals.flac").write_bytes(b"fLaC-yer-tutucu")
    if lead:
        (base / "master" / "sub").mkdir(parents=True, exist_ok=True)
        (base / "master" / "sub" / "lead.flac").write_bytes(b"fLaC-lead")
    (base / "stems").mkdir(parents=True, exist_ok=True)
    status = {"id": song_id, "title": "Test " + song_id[:4], "state": state, "stems": ["vocals", "drums"],
              "stems_version": stems_version, "pipeline": "hifi_v2", "created_at": "2026-10-01T00:00:00Z", "duration": 2.0}
    if melody is not None:
        status["melody"] = melody
    if sub is not None:
        status["sub"] = sub
    (base / "status.json").write_text(json.dumps(status), encoding="utf-8")
    if blob is not None:
        (base / "melody.bin").write_bytes(blob)
    return base


def read_status(root, song_id):
    return json.loads((pathlib.Path(root) / "songs" / song_id / "status.json").read_text("utf-8"))


def main():
    os.environ["API_TOKEN"] = "test-token"
    os.environ["SIGNING_KEY"] = "test-key"
    os.environ["ALLOWED_ORIGINS"] = "http://localhost:8000"

    spec = importlib.util.spec_from_file_location("app_melody_api", ROOT / "backend" / "app.py")
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)

    from fastapi.testclient import TestClient

    tmp = tempfile.mkdtemp()
    app.DATA_DIR = tmp
    app.volume = FakeVolume()
    spawner = FakeSpawner()
    reprocess_spawner = FakeSpawner()
    app.extract_melody = spawner
    app.separate = reprocess_spawner
    app._sub_vocal_level = lambda path: LEVELS[(path.parent.parent.name, path.stem)]

    client = TestClient(app.api.get_raw_f()())
    H = {"Authorization": "Bearer test-token"}

    header = {"v": 1, "method": "pyin", "source": "vocals", "sr": 22050, "hop": 512, "hop_s": 512 / 22050, "n": 5, "unit": "midi_x100"}
    blob = app._melody_encode(np.array([0, 5700, 5750, 5800, 0], dtype=np.int16), header)
    now = int(time.time())
    done_rec = {"state": "done", "version": 55, "method": "pyin", "source": "vocals", "parent_stems_version": 7, "voiced_ratio": 0.6}
    ids = {name: "0123456789abcdef"[i] * 64 for i, name in enumerate(   # kimlik: 64 onaltilik hane
        ["LOUD", "QUIET", "BUSY", "DONE", "RUNNING", "STALE_RUN", "OLD", "QUIET_DONE", "SUB_OK", "SUB_WARN", "SUB_NOLEAD", "SUB_MISSING",
         "G_DONE", "G_OLD", "G_REPRO", "G_NONE"])}
    for name, kwargs in (
        ("LOUD", {}), ("QUIET", {"loud": False}), ("BUSY", {"state": "separating"}),
        ("DONE", {"melody": dict(done_rec), "blob": blob}),
        ("RUNNING", {"melody": {"state": "running", "started": now}}),
        ("STALE_RUN", {"melody": {"state": "running", "started": now - 99999}}),
        ("OLD", {"melody": dict(done_rec, parent_stems_version=6), "blob": blob}),
        ("QUIET_DONE", {"loud": False, "melody": dict(done_rec), "blob": blob}),
        ("SUB_OK", {"sub": {"state": "done", "reliability": "ok", "lead_share": 0.9}, "lead": True}),
        ("SUB_WARN", {"sub": {"state": "done", "reliability": "warn", "lead_share": 0.4}, "lead": True}),
        ("SUB_NOLEAD", {"sub": {"state": "done", "reliability": "ok", "lead_share": 0.9}, "lead": False}),
        ("SUB_MISSING", {}),
        ("G_DONE", {"melody": dict(done_rec), "blob": blob}),
        ("G_OLD", {"melody": dict(done_rec, parent_stems_version=6), "blob": blob}),
        ("G_REPRO", {"melody": dict(done_rec, parent_stems_version=6), "blob": blob}),
        ("G_NONE", {}),
    ):
        make_song(tmp, ids[name], **kwargs)
    I = ids.__getitem__

    def post(song_id, body=None, headers=H):
        return client.post(f"/songs/{song_id}/melody", json=body if body is not None else {}, headers=headers)

    # --- auth / girdi
    check("POST auth yok -> 401", client.post(f"/songs/{I('LOUD')}/melody", json={}).status_code == 401)
    check("GET auth yok -> 401", client.get(f"/songs/{I('DONE')}/melody").status_code == 401)
    check("gecersiz kimlik -> 400", post("not-an-id").status_code == 400)
    check("olmayan sarki -> 404", post("ab" * 32).status_code == 404)
    check("gecersiz kaynak -> 400", post(I("LOUD"), {"source": "mix"}).status_code == 400)
    check("parent isleniyor -> 409", post(I("BUSY")).status_code == 409)
    check("hicbiri spawn etmedi", spawner.calls == [])
    check("govdesiz / bozuk govde sorun degil (varsayilanlar)", client.post(f"/songs/{I('G_NONE')}/melody", content=b"xx", headers=H).status_code == 200)
    spawner.calls.clear()
    make_song(tmp, I("G_NONE"))                         # sifirla (running yazildi)

    # --- vokal yok: is ACILMAZ
    body = post(I("QUIET")).json()
    check("vokal yok: 200 + no_vocals", body["state"] == "no_vocals", str(body))
    check("vokal yok: is spawn EDILMEDI", spawner.calls == [])
    saved = read_status(tmp, I("QUIET"))
    check("vokal yok: status.melody yazildi, ana alanlara dokunulmadi", saved["melody"]["state"] == "no_vocals" and saved["melody"]["rms_dbfs"] < -50
          and saved["stems_version"] == 7 and saved["state"] == "done")
    again = post(I("QUIET")).json()
    check("vokal yok: tekrar istek mevcut sonucu doner", again["state"] == "no_vocals" and again.get("existing"))
    kept = post(I("QUIET_DONE"), {"replace": True}).json()
    check("vokal yok + onceki tamam melodi: durum bozulmaz, is yok", kept["state"] == "no_vocals" and read_status(tmp, I("QUIET_DONE"))["melody"]["state"] == "done"
          and spawner.calls == [])

    # --- baslat
    response = post(I("LOUD"))
    body = response.json()
    check("baslat: 200 + running + kaynak vocals", response.status_code == 200 and body["state"] == "running" and body["source"] == "vocals", str(body))
    check("baslat: extract_melody 1 kez, (kimlik, vocals)", spawner.calls == [(I("LOUD"), "vocals")], str(spawner.calls))
    saved = read_status(tmp, I("LOUD"))
    check("baslat: status.melody running + started + onceki yok", saved["melody"]["state"] == "running" and saved["melody"]["started"] > 0
          and saved["melody"]["previous"] is None and saved["stems_version"] == 7)
    check("suren is: ikinci istek spawn ETMEZ", post(I("LOUD")).json()["state"] == "running" and len(spawner.calls) == 1)
    check("running (baska kayit): spawn yok", post(I("RUNNING")).json()["state"] == "running" and len(spawner.calls) == 1)
    check("takilmis running: yeniden denenir", post(I("STALE_RUN")).json()["state"] == "running" and spawner.calls[-1] == (I("STALE_RUN"), "vocals"))

    # --- kaynak secimi
    check("alt parca guvenilir + lead.flac var -> lead", post(I("SUB_OK")).json()["source"] == "lead" and spawner.calls[-1] == (I("SUB_OK"), "lead"))
    check("alt parca 'warn' -> vocals", post(I("SUB_WARN")).json()["source"] == "vocals" and spawner.calls[-1] == (I("SUB_WARN"), "vocals"))
    check("alt parca ok ama lead.flac yok (auto) -> vocals'a duser", post(I("SUB_NOLEAD")).json()["source"] == "vocals")
    make_song(tmp, I("SUB_NOLEAD"), sub={"state": "done", "reliability": "ok", "lead_share": 0.9})
    check("lead ISTENIR ama alt parca yok -> 409", post(I("SUB_MISSING"), {"source": "lead"}).status_code == 409)
    check("lead ISTENIR ama dosya yok -> 409", post(I("SUB_NOLEAD"), {"source": "lead"}).status_code == 409)
    make_song(tmp, I("SUB_OK"), sub={"state": "done", "reliability": "ok", "lead_share": 0.9}, lead=True)
    check("vocals ISTENIR (alt parca olsa da) -> vocals", post(I("SUB_OK"), {"source": "vocals"}).json()["source"] == "vocals")

    # --- mevcut sonuc korumasi / replace
    n = len(spawner.calls)
    existing = post(I("DONE")).json()
    check("tamam sonuc varsa kosmaz (existing), kaynak ve bayat bilgisi", existing["state"] == "done" and existing.get("existing")
          and existing["source"] == "vocals" and existing["stale"] is False and len(spawner.calls) == n)
    check("eski ayristirmadan: yine kosmaz ama stale=true (kullanici replace ile yeniler)", post(I("OLD")).json()["stale"] is True and len(spawner.calls) == n)
    rep = post(I("DONE"), {"replace": True}).json()
    check("replace: yeniden kosar", rep["state"] == "running" and spawner.calls[-1][0] == I("DONE"))
    prev = read_status(tmp, I("DONE"))["melody"]["previous"]
    check("replace: onceki tamam kayit `previous`ta saklanir (hata olursa geri konur)", prev and prev["state"] == "done" and prev["version"] == 55 and "previous" not in prev, str(prev))
    check("replace: melody.bin yerinde (is bitene dek eski veri kullanilabilir)", (pathlib.Path(tmp) / "songs" / I("DONE") / "melody.bin").is_file())

    # --- GET
    check("GET: melodi yok -> 404", client.get(f"/songs/{I('LOUD')}/melody", headers=H).status_code == 404)
    check("GET: gecersiz kimlik -> 400", client.get("/songs/zz/melody", headers=H).status_code == 400)
    got = client.get(f"/songs/{I('G_DONE')}/melody", headers=H)
    check("GET: 200 + ikili govde birebir", got.status_code == 200 and got.content == blob and got.headers["content-type"].startswith("application/octet-stream"))
    check("GET: Cache-Control must-revalidate", "must-revalidate" in got.headers.get("cache-control", ""))
    decoded_header, frames = app._melody_decode(got.content)
    check("GET: govde cozulur (yontem pyin, kareler)", decoded_header["method"] == "pyin" and list(frames) == [0, 5700, 5750, 5800, 0])
    check("GET: eski ayristirma da SILINMEDEN doner", client.get(f"/songs/{I('G_OLD')}/melody", headers=H).status_code == 200)

    # --- silme / yeniden isleme
    check("melodi surerken reprocess -> 409", client.post(f"/songs/{I('RUNNING')}/reprocess", headers=H).status_code == 409)
    check("reprocess spawn edilmedi", reprocess_spawner.calls == [])
    blocked = client.delete(f"/songs/{I('RUNNING')}", headers=H)
    check("melodi surerken silme engellenir", "Hedef melodi" in blocked.text, blocked.text[:160])
    check("engellenen sarki silinmedi", (pathlib.Path(tmp) / "songs" / I("RUNNING")).exists())
    ok = client.post(f"/songs/{I('G_REPRO')}/reprocess", headers=H)
    check("melodi bitmisken reprocess serbest; kayit ve dosya yerinde", ok.status_code == 200 and len(reprocess_spawner.calls) == 1
          and read_status(tmp, I("G_REPRO"))["melody"]["state"] == "done" and (pathlib.Path(tmp) / "songs" / I("G_REPRO") / "melody.bin").is_file())

    # --- liste
    songs = {item["id"]: item for item in client.get("/songs", headers=H).json()["songs"]}
    check("/songs: tamam melodi alanlari (durum, surum, kaynak)", songs[I("G_DONE")]["melody_state"] == "done" and songs[I("G_DONE")]["melody_version"] == 55
          and songs[I("G_DONE")]["melody_source"] == "vocals")
    check("/songs: ayni ayristirma -> melody_stale false, eski -> true", songs[I("G_DONE")]["melody_stale"] is False and songs[I("G_OLD")]["melody_stale"] is True)
    check("/songs: calisan melodinin durumu running", songs[I("LOUD")]["melody_state"] == "running" and songs[I("LOUD")]["melody_stale"] is False)
    check("/songs: melodi yoksa alanlar None/false", songs[I("BUSY")]["melody_state"] is None and songs[I("BUSY")]["melody_stale"] is False)
    check("/songs: soz / alt parca alanlari bozulmadi", "lyrics_state" in songs[I("BUSY")] and "sub_state" in songs[I("BUSY")] and "translation_state" in songs[I("BUSY")])

    # --- gizlilik: sunucuda mikrofon verisi alan HICBIR uc yok
    paths = [route.path for route in client.app.routes]
    check("melodi uclari yalniz POST/GET /songs/{id}/melody (mikrofon verisi alan uc YOK)", [p for p in paths if "melody" in p] == ["/songs/{song_id}/melody", "/songs/{song_id}/melody"])

    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{len(PASSED)} gecti, {len(FAILED)} basarisiz")
    if FAILED:
        print("BASARISIZ:", *FAILED, sep="\n  ")
        sys.exit(1)


if __name__ == "__main__":
    main()
