"""Alt parca (Asama 10) API uclari: GERCEK handler'lar, sahte Modal.

FastAPI + httpx TestClient ile `api()` fabrikasinin dondurdugu uygulama
calistirilir; Modal Volume, `.spawn` ve seviye olcumu (`_sub_vocal_level`,
ffmpeg gerektirir) sahtelenir: yerelde ffmpeg yok. Gercek astats olcumu canli
dogrulandi (`modal run backend/app.py::sub_gate`) ve ayristirici
tests/test_sub_gate.py'de. Kapsam: POST /sub
durumlari, GET /substems, auth, silme/yeniden isleme engelleri, /songs alanlari.

Gerektirir (yalniz yerel gelistirme): fastapi==0.141.1 starlette==1.7.0
python-multipart==0.0.32 httpx==0.28.1.

Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\test_sub_api.py
"""

import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSED, FAILED = [], []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


class FakeCall:
    object_id = "fc-test-1"


class FakeSpawner:
    def __init__(self):
        self.calls = []

    def spawn(self, *args):
        self.calls.append(args)
        return FakeCall()


class AioCallable:
    def __init__(self, fn=lambda: None):
        self.fn = fn
        self.count = 0

    def __call__(self, *a, **k):
        self.count += 1
        return self.fn()

    async def aio(self, *a, **k):
        self.count += 1
        return self.fn()


class FakeVolume:
    def __init__(self):
        self.commit = AioCallable()
        self.reload = AioCallable()


LEVELS = {}     # kimlik -> sahte vokal RMS (dBFS)


def make_wav_flac(path: pathlib.Path, amplitude: float):
    """Yer tutucu dosya (gercek FLAC degil); seviye LEVELS'tan geliyor."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"fLaC-yer-tutucu")


def make_song(root, song_id, amplitude, state="done", sub=None):
    base = pathlib.Path(root) / "songs" / song_id
    LEVELS[song_id] = -200.0 if amplitude == 0 else -20.0
    make_wav_flac(base / "master" / "vocals.flac", amplitude)
    (base / "stems").mkdir(parents=True, exist_ok=True)
    (base / "stems" / "vocals.m4a").write_bytes(b"ana")
    status = {"id": song_id, "title": "Test " + song_id[:4], "state": state,
              "stems": ["vocals", "drums"], "stems_version": 7, "pipeline": "hifi_v2",
              "created_at": "2026-10-01T00:00:00Z", "duration": 2.0}
    if sub is not None:
        status["sub"] = sub
    (base / "status.json").write_text(json.dumps(status), encoding="utf-8")
    return base


def main():
    os.environ["API_TOKEN"] = "test-token"
    os.environ["SIGNING_KEY"] = "test-key"
    os.environ["ALLOWED_ORIGINS"] = "http://localhost:8000"

    spec = importlib.util.spec_from_file_location("app_sub_api", ROOT / "backend" / "app.py")
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)

    from fastapi.testclient import TestClient

    tmp = tempfile.mkdtemp()
    app.DATA_DIR = tmp
    app.volume = FakeVolume()
    spawner = FakeSpawner()
    reprocess_spawner = FakeSpawner()
    app.separate_sub = spawner
    app.separate = reprocess_spawner
    app._sub_vocal_level = lambda path: LEVELS[path.parent.parent.name]

    web = app.api.get_raw_f()()
    client = TestClient(web)
    H = {"Authorization": "Bearer test-token"}

    LOUD = "a" * 64       # gercek vokal (-20 dBFS civari)
    QUIET = "b" * 64      # dijital sessizlik (vokal yok)
    BUSY = "c" * 64       # parent hala isleniyor
    DONE = "d" * 64       # alt ayrim zaten tamam
    RUNNING = "e" * 64    # alt ayrim suruyor
    STALE = "f" * 64      # takilmis 'running'
    for song_id, amp, kwargs in (
        (LOUD, 0.1, {}),
        (QUIET, 0, {}),
        (BUSY, 0.1, {"state": "separating"}),
        (DONE, 0.1, {"sub": {"state": "done", "version": 55, "reliability": "warn"}}),
        (RUNNING, 0.1, {"sub": {"state": "running", "started": int(time.time())}}),
        (STALE, 0.1, {"sub": {"state": "running", "started": int(time.time()) - 99999}}),
    ):
        make_song(tmp, song_id, amp, **kwargs)

    # --- auth
    check("auth yok -> 401", client.post(f"/songs/{LOUD}/sub").status_code == 401)
    check("yanlis token -> 401",
          client.post(f"/songs/{LOUD}/sub", headers={"Authorization": "Bearer x"}).status_code == 401)
    check("substems auth yok -> 401", client.get(f"/songs/{LOUD}/substems/lead.m4a").status_code == 401)

    # --- gecersiz girdi
    check("gecersiz kimlik -> 400", client.post("/songs/not-an-id/sub", headers=H).status_code == 400)
    check("olmayan sarki -> 404", client.post(f"/songs/{'9' * 64}/sub", headers=H).status_code == 404)
    check("parent isleniyor -> 409", client.post(f"/songs/{BUSY}/sub", headers=H).status_code == 409)

    # --- vokal yok: GPU AÇILMAZ
    response = client.post(f"/songs/{QUIET}/sub", headers=H)
    body = response.json()
    check("vokal yok: 200 + state no_vocals", response.status_code == 200 and body["state"] == "no_vocals", str(body))
    check("vokal yok: GPU spawn EDILMEDI", spawner.calls == [], str(spawner.calls))
    check("vokal yok: seviye < -50", body.get("vocal_rms_dbfs", 0) < -50, str(body.get("vocal_rms_dbfs")))
    saved = json.loads((pathlib.Path(tmp) / "songs" / QUIET / "status.json").read_text("utf-8"))
    check("vokal yok: status.sub yazildi", saved["sub"]["state"] == "no_vocals"
          and saved["stems_version"] == 7 and saved["pipeline"] == "hifi_v2")
    again = client.post(f"/songs/{QUIET}/sub", headers=H).json()
    check("vokal yok: tekrar istek mevcut sonucu doner, spawn yok",
          again["state"] == "no_vocals" and again.get("existing") and spawner.calls == [])

    # --- gercek vokal: GPU isi baslar
    response = client.post(f"/songs/{LOUD}/sub", headers=H)
    body = response.json()
    check("vokal var: 200 + running", response.status_code == 200 and body["state"] == "running", str(body))
    check("vokal var: seviye makul (> -50)", body.get("vocal_rms_dbfs", -200) > -50, str(body.get("vocal_rms_dbfs")))
    check("vokal var: separate_sub 1 kez, uretim modunda",
          len(spawner.calls) == 1 and spawner.calls[0] == (LOUD, "stem", app.SUB_OVERLAP, False, True),
          str(spawner.calls))
    saved = json.loads((pathlib.Path(tmp) / "songs" / LOUD / "status.json").read_text("utf-8"))
    check("vokal var: status.sub running + started",
          saved["sub"]["state"] == "running" and saved["sub"]["started"] > 0)
    check("ana alanlara dokunulmadi", saved["state"] == "done" and saved["stems"] == ["vocals", "drums"]
          and saved["stems_version"] == 7)
    again = client.post(f"/songs/{LOUD}/sub", headers=H).json()
    check("suren is: ikinci istek spawn ETMEZ", again["state"] == "running" and len(spawner.calls) == 1)

    # --- mevcut / takilmis
    done = client.post(f"/songs/{DONE}/sub", headers=H).json()
    check("tamam: mevcut sonuc, spawn yok", done["state"] == "done" and done.get("existing")
          and len(spawner.calls) == 1)
    running = client.post(f"/songs/{RUNNING}/sub", headers=H).json()
    check("suruyor: spawn yok", running["state"] == "running" and len(spawner.calls) == 1)
    stale = client.post(f"/songs/{STALE}/sub", headers=H).json()
    check("takilmis running: yeniden denenir", stale["state"] == "running" and len(spawner.calls) == 2)

    # --- silme / yeniden isleme engelleri
    check("alt ayrim surerken reprocess -> 409",
          client.post(f"/songs/{RUNNING}/reprocess", headers=H).status_code == 409)
    check("reprocess spawn edilmedi", reprocess_spawner.calls == [])
    ok = client.post(f"/songs/{DONE}/reprocess", headers=H)
    check("alt ayrim bitmisken reprocess serbest", ok.status_code == 200 and len(reprocess_spawner.calls) == 1)
    blocked = client.delete(f"/songs/{RUNNING}", headers=H)
    check("alt ayrim surerken silme engellenir",
          blocked.status_code in (200, 409) and "Alt parcalar" in blocked.text, blocked.text[:200])
    check("engellenen sarki silinmedi", (pathlib.Path(tmp) / "songs" / RUNNING).exists())

    # --- liste alanlari
    songs = {item["id"]: item for item in client.get("/songs", headers=H).json()["songs"]}
    check("/songs: sub_state alanlari",
          songs[DONE]["sub_state"] == "done" and songs[DONE]["sub_version"] == 55
          and songs[QUIET]["sub_state"] == "no_vocals" and songs[BUSY]["sub_state"] is None)
    check("/songs: stems_version/pipeline hala var",
          songs[DONE]["stems_version"] == 7 and songs[DONE]["pipeline"] == "hifi_v2")
    detail = client.get(f"/songs/{DONE}", headers=H).json()
    check("GET /songs/{id}: status.sub gorunuyor", detail["status"]["sub"]["reliability"] == "warn")

    # --- /substems
    sub_dir = pathlib.Path(tmp) / "songs" / DONE / "stems" / "sub"
    sub_dir.mkdir(parents=True)
    payload = bytes(range(256)) * 40
    (sub_dir / "lead.m4a").write_bytes(payload)
    full = client.get(f"/songs/{DONE}/substems/lead.m4a", headers=H)
    check("substems: 200 + icerik + audio/mp4",
          full.status_code == 200 and full.content == payload and full.headers["content-type"] == "audio/mp4")
    check("substems: Accept-Ranges", full.headers.get("accept-ranges") == "bytes")
    part = client.get(f"/songs/{DONE}/substems/lead.m4a", headers={**H, "Range": "bytes=10-19"})
    check("substems: Range 206 + Content-Range",
          part.status_code == 206 and part.content == payload[10:20]
          and part.headers["content-range"] == f"bytes 10-19/{len(payload)}")
    bad = client.get(f"/songs/{DONE}/substems/lead.m4a", headers={**H, "Range": "bytes=99999-"})
    check("substems: karsilanamaz Range 416", bad.status_code == 416)
    check("substems: olmayan dosya 404", client.get(f"/songs/{DONE}/substems/backing.m4a", headers=H).status_code == 404)
    check("substems: bilinmeyen ad 400", client.get(f"/songs/{DONE}/substems/vocals.m4a", headers=H).status_code == 400)
    check("substems: yol kacisi 400/404 (stem adi olarak ../)",
          client.get(f"/songs/{DONE}/substems/..%2Fstems%2Fvocals.m4a", headers=H).status_code in (400, 404))
    check("substems: gecersiz sarki kimligi 400",
          client.get("/songs/..%2F..%2Fx/substems/lead.m4a", headers=H).status_code in (400, 404))
    check("ana stem yolu degismedi", client.get(f"/songs/{LOUD}/stems/vocals.m4a", headers=H).content == b"ana")
    check("ana stem'e sub adi uymaz",
          client.get(f"/songs/{LOUD}/stems/lead.m4a", headers=H).status_code == 404)

    shutil.rmtree(tmp, ignore_errors=True)
    print("\n" + "=" * 60)
    print(f"gecen: {len(PASSED)}   basarisiz: {len(FAILED)}")
    for name in FAILED:
        print(f"  BASARISIZ: {name}")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
