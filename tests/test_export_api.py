"""Miks disa aktarma (Asama 12) API uclari: GERCEK handler'lar, sahte Modal.

test_sub_api.py / test_lyrics_api.py ile ayni yontem: `api()` fabrikasinin FastAPI uygulamasi
TestClient ile calisir; Volume ve `.spawn` sahtelenir (ffmpeg calismaz; gercek ses olcumleri
`modal run backend/app.py::export_validate`). Kapsam: dogrulama, spawn argumanlari, ayar
onbellegi (hash), tek is kurali, durum yoklamasi, imzali link ve indirme (imza, sure, bicim),
silme/yeniden isleme engelleri, auth.

Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\test_export_api.py
"""

import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile
import time
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSED, FAILED = [], []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


class FakeCall:
    object_id = "fc-export-1"


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


def make_song(root, song_id, state="done", export=None, sub=None):
    base = pathlib.Path(root) / "songs" / song_id
    (base / "master").mkdir(parents=True, exist_ok=True)
    status = {"id": song_id, "title": "Zeus Kabadayı & Rota", "state": state, "duration": 100.0,
              "stems": ["drums", "bass", "other", "vocals", "guitar", "piano"],
              "stems_version": 7, "pipeline": "hifi_v2", "created_at": "2026-10-01T00:00:00Z"}
    if export is not None:
        status["export"] = export
    if sub is not None:
        status["sub"] = sub
    (base / "status.json").write_text(json.dumps(status), encoding="utf-8")
    return base


def read_status(root, song_id):
    return json.loads((pathlib.Path(root) / "songs" / song_id / "status.json").read_text("utf-8"))


def main():
    os.environ["API_TOKEN"] = "test-token"
    os.environ["SIGNING_KEY"] = "test-key"
    os.environ["ALLOWED_ORIGINS"] = "http://localhost:8000"

    spec = importlib.util.spec_from_file_location("app_export_api", ROOT / "backend" / "app.py")
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)

    from fastapi.testclient import TestClient

    tmp = tempfile.mkdtemp()
    app.DATA_DIR = tmp
    app.volume = FakeVolume()
    spawner = FakeSpawner()
    reprocess_spawner = FakeSpawner()
    app.export_mix = spawner
    app.separate = reprocess_spawner

    client = TestClient(app.api.get_raw_f()())
    H = {"Authorization": "Bearer test-token"}

    LIVE, BUSY, RUN, STALE = "a" * 64, "b" * 64, "c" * 64, "d" * 64
    CACHED, NOSUB = "e" * 64, "f" * 64
    SUB_DONE = {"state": "done", "version": 11, "reliability": "ok"}
    make_song(tmp, LIVE, sub=SUB_DONE)
    make_song(tmp, BUSY, state="separating")
    make_song(tmp, RUN, export={"state": "running", "hash": "0" * 32, "started": int(time.time())})
    make_song(tmp, STALE, export={"state": "running", "hash": "1" * 32, "started": int(time.time()) - 99999})
    make_song(tmp, CACHED, sub=SUB_DONE)
    make_song(tmp, NOSUB)

    karaoke = {"format": "m4a", "label": "Karaoke (arka vokal kalsın)",
               "gains": {"backing": 1, "drums": 1, "bass": 1, "other": 1, "guitar": 1, "piano": 1}}

    def post(song_id, payload, headers=H):
        return client.post(f"/songs/{song_id}/export", json=payload, headers=headers)

    # --- auth / girdi
    check("POST auth yok -> 401", client.post(f"/songs/{LIVE}/export", json=karaoke).status_code == 401)
    check("GET auth yok -> 401", client.get(f"/songs/{LIVE}/export/{'0' * 32}").status_code == 401)
    check("link auth yok -> 401", client.post(f"/songs/{LIVE}/export/{'0' * 32}/link").status_code == 401)
    check("gecersiz sarki kimligi -> 400", post("not-an-id", karaoke).status_code == 400)
    check("olmayan sarki -> 404", post("9" * 64, karaoke).status_code == 404)
    check("govde JSON degil -> 400",
          client.post(f"/songs/{LIVE}/export", content=b"xx", headers=H).status_code == 400)
    check("parent isleniyor -> 409", post(BUSY, karaoke).status_code == 409)
    for name, payload in (
        ("gecersiz format (mp3)", dict(karaoke, format="mp3")),
        ("kazanc > 2", dict(karaoke, gains={"drums": 3})),
        ("hicbir kanal duyulmuyor", dict(karaoke, gains={"drums": 0})),
        ("hiz sinir disi", dict(karaoke, rate=2.0)),
        ("ton sinir disi", dict(karaoke, semitones=9)),
        ("bolge sarki disinda", dict(karaoke, region={"a": 500, "b": 600})),
        ("bilinmeyen kanal", dict(karaoke, gains={"hayalet": 1})),
        ("fx: pan sinir disi", dict(karaoke, fx={"drums": {"pan": 2}})),
        ("fx: eq sinir disi", dict(karaoke, fx={"drums": {"eq": [13, 0, 0]}})),
        ("fx: gonderim > 1", dict(karaoke, fx={"drums": {"send": 1.2}})),
        ("fx: bilinmeyen kanal", dict(karaoke, fx={"hayalet": {"pan": 0.5}})),
        ("fx: oda suresi sinir disi", dict(karaoke, fx={"drums": {"send": 0.5}}, room={"decay": 9})),
    ):
        response = post(LIVE, payload)
        check(f"gecersiz istek -> 400: {name}", response.status_code == 400, response.text[:100])
    response = post(NOSUB, karaoke)
    check("alt parcasi olmayan sarkida backing -> 400", response.status_code == 400, response.text[:100])
    response = post(LIVE, dict(karaoke, gains={"vocals": 1, "backing": 1}))
    check("ana kanal + alt parcasi birlikte -> 400", response.status_code == 400)
    check("hicbiri spawn etmedi", spawner.calls == [])

    # --- baslat
    response = post(LIVE, karaoke)
    body = response.json()
    expected_spec, _ = app._export_check(karaoke, read_status(tmp, LIVE) | {"duration": 100.0})
    digest = app._export_hash(expected_spec)
    check("baslat: 200 + running + hash", response.status_code == 200 and body["state"] == "running"
          and body["hash"] == digest, str(body))
    check("baslat: export_mix (kimlik, hash, spec) ile 1 kez spawn", len(spawner.calls) == 1
          and spawner.calls[0][0] == LIVE and spawner.calls[0][1] == digest
          and spawner.calls[0][2]["label"] == "Karaoke (arka vokal kalsın)", str(spawner.calls[:1])[:200])
    saved = read_status(tmp, LIVE)
    check("baslat: status.export running + hash, ana alanlara dokunulmadi",
          saved["export"]["state"] == "running" and saved["export"]["hash"] == digest
          and saved["stems_version"] == 7 and saved["sub"]["version"] == 11)
    again = post(LIVE, karaoke).json()
    check("ayni ayar suren isi tekrar baslatmaz", again["state"] == "running" and again.get("existing")
          and len(spawner.calls) == 1)
    other = post(LIVE, dict(karaoke, rate=0.8))
    check("baska ayar suren isteyken 409", other.status_code == 409 and len(spawner.calls) == 1, other.text[:100])
    check("suren is: silme engellenir", "Disa aktarma" in client.delete(f"/songs/{LIVE}", headers=H).text)
    check("suren is: yeniden isleme 409", client.post(f"/songs/{LIVE}/reprocess", headers=H).status_code == 409
          and reprocess_spawner.calls == [])
    check("baska sarkida kendi suren isi varken (farkli hash) 409",
          post(RUN, {"format": "m4a", "gains": {"drums": 1}}).status_code == 409)
    stale = post(STALE, dict(karaoke, gains={"drums": 1, "bass": 1}))
    check("takilmis running: yeniden denenir", stale.status_code == 200 and stale.json()["state"] == "running"
          and len(spawner.calls) == 2, stale.text[:100])

    # --- durum yoklamasi
    get = lambda song_id, h: client.get(f"/songs/{song_id}/export/{h}", headers=H)
    check("GET: gecersiz hash -> 400", get(LIVE, "xyz").status_code == 400 and get(LIVE, "../etc").status_code in (400, 404))
    running = get(LIVE, digest).json()
    check("GET: calisiyor", running["state"] == "running", str(running))
    check("GET: bilinmeyen hash -> 404", get(LIVE, "9" * 32).status_code == 404)
    stuck = get(RUN, "0" * 32).json()
    check("GET: taze running hala running", stuck["state"] == "running")
    status = read_status(tmp, LIVE)
    status["export"] = {"state": "error", "hash": digest, "message": "patladi"}
    (pathlib.Path(tmp) / "songs" / LIVE / "status.json").write_text(json.dumps(status), encoding="utf-8")
    err = get(LIVE, digest).json()
    check("GET: hata mesaji tasinir", err["state"] == "error" and err["message"] == "patladi", str(err))

    # --- hazir dosya: sidecar + onbellek
    folder = pathlib.Path(tmp) / "songs" / CACHED / "exports"
    folder.mkdir(parents=True)
    cached_spec, _ = app._export_check(karaoke, read_status(tmp, CACHED))
    cached_digest = app._export_hash(cached_spec)
    audio = b"fake-m4a-" * 500
    (folder / f"{cached_digest}.m4a").write_bytes(audio)
    filename = app._export_filename("Zeus Kabadayı & Rota", cached_spec)
    (folder / f"{cached_digest}.json").write_text(json.dumps(
        {"hash": cached_digest, "filename": filename, "format": "m4a", "bytes": len(audio),
         "duration": 99.9, "peak_db": -1.2}), encoding="utf-8")
    old = time.time() - 3 * 3600
    os.utime(folder / f"{cached_digest}.m4a", (old, old))
    calls_before = len(spawner.calls)
    hit = post(CACHED, karaoke).json()
    check("onbellek isabeti: done + existing, GPU/CPU isi YOK", hit["state"] == "done" and hit.get("existing")
          and hit["filename"] == filename and len(spawner.calls) == calls_before, str(hit))
    check("onbellek isabeti 24 saati yeniler (mtime)", time.time() - (folder / f"{cached_digest}.m4a").stat().st_mtime < 60)
    done = get(CACHED, cached_digest).json()
    check("GET: hazir dosya bilgisi", done["state"] == "done" and done["bytes"] == len(audio)
          and done["peak_db"] == -1.2 and done["format"] == "m4a", str(done))
    wav_spec, _ = app._export_check(dict(karaoke, format="wav"), read_status(tmp, CACHED))
    check("ayni ayar baska bicim = baska hash", app._export_hash(wav_spec) != cached_digest)

    # --- imzali link ve indirme
    check("link: hazir degilse 404", client.post(f"/songs/{CACHED}/export/{'9' * 32}/link", headers=H).status_code == 404)
    check("link: gecersiz hash 400", client.post(f"/songs/{CACHED}/export/zz/link", headers=H).status_code == 400)
    link = client.post(f"/songs/{CACHED}/export/{cached_digest}/link", headers=H).json()
    check("link: url + sure + dosya adi", "/export-file/" in link["url"] and link["ttl"] == app.DOWNLOAD_TTL
          and link["filename"] == filename and link["format"] == "m4a", str(link)[:200])
    path_query = link["url"].split("testserver", 1)[1]
    response = client.get(path_query)          # TOKEN YOK: yetki imzada
    check("indirme: imzayla token'siz 200 + icerik", response.status_code == 200 and response.content == audio)
    check("indirme: audio/mp4", response.headers["content-type"].startswith("audio/mp4"))
    disposition = response.headers.get("content-disposition", "")
    check("indirme: attachment + UTF-8 dosya adi (Turkce karakter)",
          disposition.startswith("attachment") and urllib.parse.quote(filename, safe="") in disposition, disposition[:160])
    check("indirme: Content-Length", response.headers.get("content-length") == str(len(audio)))
    broken = path_query.replace("sig=", "sig=0")
    check("indirme: bozuk imza 403", client.get(broken).status_code == 403)
    check("indirme: imzasiz 403", client.get(f"/songs/{CACHED}/export-file/{cached_digest}?format=m4a&exp=9999999999").status_code == 403)
    expired = int(time.time()) - 10
    signature = app._sign_download("test-key", CACHED, f"export{cached_digest}", "m4a", expired)
    check("indirme: suresi gecmis 403", client.get(
        f"/songs/{CACHED}/export-file/{cached_digest}?format=m4a&exp={expired}&sig={signature}").status_code == 403)
    check("indirme: gecersiz bicim 400", client.get(
        f"/songs/{CACHED}/export-file/{cached_digest}?format=flac&exp=1&sig=x").status_code == 400)
    other_sig = app._sign_download("test-key", CACHED, f"export{'8' * 32}", "m4a", int(time.time()) + 600)
    check("indirme: baska hash'in imzasi gecmez", client.get(
        f"/songs/{CACHED}/export-file/{cached_digest}?format=m4a&exp={int(time.time()) + 600}&sig={other_sig}").status_code == 403)
    ghost = "7" * 32
    ghost_sig = app._sign_download("test-key", CACHED, f"export{ghost}", "m4a", int(time.time()) + 600)
    check("indirme: dosya yoksa 404", client.get(
        f"/songs/{CACHED}/export-file/{ghost}?format=m4a&exp={int(time.time()) + 600}&sig={ghost_sig}").status_code == 404)
    wav_sig = app._sign_download("test-key", CACHED, f"export{cached_digest}", "wav", int(time.time()) + 600)
    check("indirme: bicim uyusmazligi 404 (m4a dosyasina wav istegi)", client.get(
        f"/songs/{CACHED}/export-file/{cached_digest}?format=wav&exp={int(time.time()) + 600}&sig={wav_sig}").status_code == 404)

    shutil.rmtree(tmp, ignore_errors=True)
    print("\n" + "=" * 60)
    print(f"gecen: {len(PASSED)}   basarisiz: {len(FAILED)}")
    for name in FAILED:
        print(f"  BASARISIZ: {name}")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
