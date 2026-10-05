"""Soz (Asama 11) API uclari: GERCEK handler'lar, sahte Modal.

test_sub_api.py ile ayni yontem: `api()` fabrikasinin dondurdugu FastAPI uygulamasi
TestClient ile calisir; Volume, `.spawn` ve seviye olcumu sahtelenir. SENTETIK
metin kullanilir: gercek sarki sozu YOK. Kapsam: POST/GET /lyrics, vokal yok
kapisi (GPU acilmaz), mevcut sonuc korumasi, pasted/auto kurallari, silme ve
yeniden isleme engelleri, /songs alanlari, eski ayristirma isareti.

Gerektirir: fastapi==0.141.1 starlette==1.7.0 python-multipart==0.0.32 httpx==0.28.1.
Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\test_lyrics_api.py
"""

import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSED, FAILED = [], []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


class FakeCall:
    object_id = "fc-lyrics-1"


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


def make_song(root, song_id, loud=True, state="done", lyrics=None, doc=None, stems_version=7):
    base = pathlib.Path(root) / "songs" / song_id
    LEVELS[(song_id, "vocals")] = -20.0 if loud else -200.0
    (base / "master").mkdir(parents=True, exist_ok=True)
    (base / "master" / "vocals.flac").write_bytes(b"fLaC-yer-tutucu")
    (base / "stems").mkdir(parents=True, exist_ok=True)
    status = {"id": song_id, "title": "Test " + song_id[:4], "state": state,
              "stems": ["vocals", "drums"], "stems_version": stems_version, "pipeline": "hifi_v2",
              "created_at": "2026-10-01T00:00:00Z", "duration": 2.0}
    if lyrics is not None:
        status["lyrics"] = lyrics
    (base / "status.json").write_text(json.dumps(status), encoding="utf-8")
    if doc is not None:
        (base / "lyrics.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return base


def read_status(root, song_id):
    return json.loads((pathlib.Path(root) / "songs" / song_id / "status.json").read_text("utf-8"))


def main():
    os.environ["API_TOKEN"] = "test-token"
    os.environ["SIGNING_KEY"] = "test-key"
    os.environ["ALLOWED_ORIGINS"] = "http://localhost:8000"

    spec = importlib.util.spec_from_file_location("app_lyrics_api", ROOT / "backend" / "app.py")
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)

    from fastapi.testclient import TestClient

    tmp = tempfile.mkdtemp()
    app.DATA_DIR = tmp
    app.volume = FakeVolume()
    spawner = FakeSpawner()
    reprocess_spawner = FakeSpawner()
    app.extract_lyrics = spawner
    app.separate = reprocess_spawner
    app._sub_vocal_level = lambda path: LEVELS[(path.parent.parent.name, path.stem)]

    client = TestClient(app.api.get_raw_f()())
    H = {"Authorization": "Bearer test-token"}

    LOUD, QUIET, BUSY = "a" * 64, "b" * 64, "c" * 64
    DONE, PASTED, RUNNING, STALE_RUN = "d" * 64, "e" * 64, "f" * 64, "1" * 64
    OLD, QUIET_DONE = "2" * 64, "3" * 64
    # POST testleri bu sarkilari "running"e ceviriyor: GET/liste/reprocess icin AYRI kopyalar
    G_DONE, G_OLD, G_PASTED, G_REPRO = "4" * 64, "5" * 64, "6" * 64, "7" * 64
    doc = {"schema": 1, "version": 55, "source": "auto", "language": "tr", "duration": 2.0,
           "lines": [{"t": 0.5, "e": 1.5, "text": "deneme satiri", "w": [[0.5, 1.0, "deneme"], [1.0, 1.5, "satiri"]]}]}
    done_rec = {"state": "done", "source": "auto", "language": "tr", "version": 55,
                "parent_stems_version": 7, "warning": None}
    now = int(time.time())
    for song_id, kwargs in (
        (LOUD, {}),
        (QUIET, {"loud": False}),
        (BUSY, {"state": "separating"}),
        (DONE, {"lyrics": dict(done_rec), "doc": doc}),
        (PASTED, {"lyrics": dict(done_rec, source="pasted", warning="text_mismatch"),
                  "doc": dict(doc, source="pasted")}),
        (RUNNING, {"lyrics": {"state": "running", "started": now}}),
        (STALE_RUN, {"lyrics": {"state": "running", "started": now - 99999}}),
        (OLD, {"lyrics": dict(done_rec, parent_stems_version=6), "doc": doc}),
        (QUIET_DONE, {"loud": False, "lyrics": dict(done_rec), "doc": doc}),
        (G_DONE, {"lyrics": dict(done_rec), "doc": doc}),
        (G_OLD, {"lyrics": dict(done_rec, parent_stems_version=6), "doc": doc}),
        (G_PASTED, {"lyrics": dict(done_rec, source="pasted", warning="text_mismatch"),
                    "doc": dict(doc, source="pasted")}),
        (G_REPRO, {"lyrics": dict(done_rec, parent_stems_version=6), "doc": doc}),
    ):
        make_song(tmp, song_id, **kwargs)

    def post(song_id, body, headers=H):
        return client.post(f"/songs/{song_id}/lyrics", json=body, headers=headers)

    # --- auth / girdi
    check("auth yok -> 401", client.post(f"/songs/{LOUD}/lyrics", json={}).status_code == 401)
    check("GET auth yok -> 401", client.get(f"/songs/{DONE}/lyrics").status_code == 401)
    check("gecersiz kimlik -> 400", post("not-an-id", {}).status_code == 400)
    check("olmayan sarki -> 404", post("9" * 64, {}).status_code == 404)
    check("govde JSON degil -> 400",
          client.post(f"/songs/{LOUD}/lyrics", content=b"xx", headers=H).status_code == 400)
    check("govde nesne degil -> 400", post(LOUD, [1, 2]).status_code == 400)
    check("gecersiz mod -> 400", post(LOUD, {"mode": "x"}).status_code == 400)
    check("gecersiz dil (ko) -> 400", post(LOUD, {"language": "ko"}).status_code == 400)
    check("pasted metinsiz -> 400", post(LOUD, {"mode": "pasted"}).status_code == 400)
    check("pasted bos metin -> 400", post(LOUD, {"mode": "pasted", "text": " \n \n"}).status_code == 400)
    check("pasted cok uzun -> 400",
          post(LOUD, {"mode": "pasted", "text": "a" * (app.LYRICS_MAX_CHARS + 1)}).status_code == 400)
    check("pasted cok satir -> 400",
          post(LOUD, {"mode": "pasted", "text": "\n".join(["x"] * (app.LYRICS_MAX_LINES + 1))}).status_code == 400)
    check("parent isleniyor -> 409", post(BUSY, {}).status_code == 409)
    check("hicbiri spawn etmedi", spawner.calls == [])

    # --- vokal yok: GPU ACILMAZ
    response = post(QUIET, {})
    body = response.json()
    check("vokal yok: 200 + no_vocals", response.status_code == 200 and body["state"] == "no_vocals", str(body))
    check("vokal yok: GPU spawn EDILMEDI", spawner.calls == [])
    saved = read_status(tmp, QUIET)
    check("vokal yok: status.lyrics yazildi, ana alanlara dokunulmadi",
          saved["lyrics"]["state"] == "no_vocals" and saved["lyrics"]["rms_dbfs"] < -50
          and saved["stems_version"] == 7 and saved["state"] == "done")
    again = post(QUIET, {}).json()
    check("vokal yok: tekrar istek mevcut sonucu doner", again["state"] == "no_vocals" and again.get("existing"))
    pasted_quiet = post(QUIET, {"mode": "pasted", "text": "bir\niki"}).json()
    check("vokal yok: pasted da GPU acmaz", pasted_quiet["state"] == "no_vocals" and spawner.calls == [])
    kept = post(QUIET_DONE, {"mode": "pasted", "text": "bir"}).json()
    check("vokal yok + onceki tamam soz: durum bozulmaz, GPU yok",
          kept["state"] == "no_vocals" and read_status(tmp, QUIET_DONE)["lyrics"]["state"] == "done"
          and spawner.calls == [])

    # --- auto
    response = post(LOUD, {})
    body = response.json()
    check("auto: 200 + running", response.status_code == 200 and body["state"] == "running", str(body))
    check("auto: extract_lyrics 1 kez, (kimlik, auto, auto, bos metin)",
          spawner.calls == [(LOUD, "auto", "auto", "", [])], str(spawner.calls))
    saved = read_status(tmp, LOUD)
    check("auto: status.lyrics running + started + onceki yok",
          saved["lyrics"]["state"] == "running" and saved["lyrics"]["started"] > 0
          and saved["lyrics"]["previous"] is None and saved["stems_version"] == 7)
    check("auto: suren is: ikinci istek spawn ETMEZ",
          post(LOUD, {}).json()["state"] == "running" and len(spawner.calls) == 1)
    check("running (baska kayit): spawn yok", post(RUNNING, {}).json()["state"] == "running"
          and len(spawner.calls) == 1)
    check("takilmis running: yeniden denenir", post(STALE_RUN, {"language": "ja"}).json()["state"] == "running"
          and spawner.calls[-1] == (STALE_RUN, "auto", "ja", "", []), str(spawner.calls[-1]))

    # --- mevcut sonuc korumasi
    n = len(spawner.calls)
    existing = post(DONE, {}).json()
    check("auto: tamam sonuc varsa koşmaz (existing)", existing["state"] == "done" and existing.get("existing")
          and len(spawner.calls) == n)
    prot = post(PASTED, {"mode": "auto"}).json()
    check("auto: YAPISTIRILMIS sozun ustune yazmaz", prot["state"] == "done" and prot["source"] == "pasted"
          and len(spawner.calls) == n and read_status(tmp, PASTED)["lyrics"]["source"] == "pasted")
    rep = post(DONE, {"replace": True, "language": "en"}).json()
    check("auto + replace: yeniden kosar", rep["state"] == "running" and spawner.calls[-1] == (DONE, "auto", "en", "", []))
    prev = read_status(tmp, DONE)["lyrics"]["previous"]
    check("replace: onceki tamam kayit `previous`ta saklanir (hata olursa geri konur)",
          prev and prev["state"] == "done" and prev["version"] == 55 and "previous" not in prev, str(prev))
    check("replace: lyrics.json yerinde", (pathlib.Path(tmp) / "songs" / DONE / "lyrics.json").is_file())

    # --- pasted
    text = "  birinci   satir \n\n ikinci satir\x00 \n"
    response = post(PASTED, {"mode": "pasted", "language": "tr", "text": text})
    check("pasted: tamam sonucun ustune de kosar (kullanici istedi)",
          response.status_code == 200 and response.json()["state"] == "running")
    check("pasted: metin temizlenip satirlarla spawn edilir",
          spawner.calls[-1] == (PASTED, "pasted", "tr", "birinci satir\nikinci satir", []), str(spawner.calls[-1]))
    check("pasted: dil auto da gecerli",
          post(OLD, {"mode": "pasted", "text": "x y"}).json()["state"] == "running"
          and spawner.calls[-1][2] == "auto")
    saved = read_status(tmp, PASTED)
    check("pasted: yapistirilan metin status'a YAZILMAZ (yalniz Volume'daki lyrics.json'da)",
          "birinci" not in json.dumps(saved), json.dumps(saved)[:200])

    # --- GET
    check("GET: soz yok -> 404", client.get(f"/songs/{LOUD}/lyrics", headers=H).status_code == 404)
    check("GET: gecersiz kimlik -> 400", client.get("/songs/zz/lyrics", headers=H).status_code == 400)
    got = client.get(f"/songs/{G_DONE}/lyrics", headers=H)
    data = got.json()
    check("GET: 200, durum ozeti + lyrics.json", got.status_code == 200 and data["lyrics"]["schema"] == 1
          and data["lyrics"]["lines"][0]["text"] == "deneme satiri" and data["language"] == "tr")
    check("GET: stale=false (ayni ayristirma)", data["stale"] is False)
    check("GET: Cache-Control must-revalidate", "must-revalidate" in got.headers.get("cache-control", ""))
    old = client.get(f"/songs/{G_OLD}/lyrics", headers=H).json()
    check("GET: ana sarki yeniden islenmis -> stale=true (soz SILINMEZ)", old["stale"] is True
          and old["lyrics"]["lines"], str(old["stale"]))
    mismatch = client.get(f"/songs/{G_PASTED}/lyrics", headers=H).json()
    check("GET: uyari alani tasinir", mismatch["warning"] == "text_mismatch" and mismatch["source"] == "pasted")

    # --- silme / yeniden isleme
    check("sozler surerken reprocess -> 409", client.post(f"/songs/{RUNNING}/reprocess", headers=H).status_code == 409)
    check("reprocess spawn edilmedi", reprocess_spawner.calls == [])
    blocked = client.delete(f"/songs/{RUNNING}", headers=H)
    check("sozler surerken silme engellenir", "Sozler" in blocked.text, blocked.text[:160])
    check("engellenen sarki silinmedi", (pathlib.Path(tmp) / "songs" / RUNNING).exists())
    ok = client.post(f"/songs/{G_REPRO}/reprocess", headers=H)
    check("sozler bitmisken reprocess serbest; soz kaydi ve dosyasi yerinde",
          ok.status_code == 200 and len(reprocess_spawner.calls) == 1
          and read_status(tmp, G_REPRO)["lyrics"]["state"] == "done"
          and (pathlib.Path(tmp) / "songs" / G_REPRO / "lyrics.json").is_file())

    # --- liste
    songs = {item["id"]: item for item in client.get("/songs", headers=H).json()["songs"]}
    check("/songs: tamam soz alanlari (durum, surum, kaynak)",
          songs[G_PASTED]["lyrics_state"] == "done" and songs[G_PASTED]["lyrics_version"] == 55
          and songs[G_PASTED]["lyrics_source"] == "pasted")
    check("/songs: ayni ayristirma -> lyrics_stale false", songs[G_DONE]["lyrics_stale"] is False)
    check("/songs: eski ayristirma -> lyrics_stale true", songs[G_OLD]["lyrics_stale"] is True)
    check("/songs: calisan sozun durumu running", songs[LOUD]["lyrics_state"] == "running"
          and songs[LOUD]["lyrics_stale"] is False)
    check("/songs: soz yoksa alanlar None/false",
          songs[BUSY]["lyrics_state"] is None and songs[BUSY]["lyrics_stale"] is False)
    check("/songs: alt parca alanlari bozulmadi", "sub_state" in songs[BUSY] and "sub_drums_state" in songs[BUSY])

    # --- elle zaman (manual) ve satir zamani duzeltme (Asama 11 v2)
    T_DONE, T_RUN = "8" * 64, "9" * 64
    timed = {"schema": 1, "version": 100, "source": "pasted", "language": "tr", "duration": 100.0, "lines": [
        {"t": 10.0, "e": 14.0, "text": "bir", "w": [[10.0, 12.0, "a"], [12.0, 14.0, "b"]]},
        {"t": 15.0, "e": 18.0, "text": "iki", "w": [[15.0, 18.0, "c"]], "c": 0},
        {"t": 20.0, "e": 25.0, "text": "uc", "w": [[20.0, 25.0, "d"]]}]}
    make_song(tmp, T_DONE, lyrics=dict(done_rec, source="pasted", version=100), doc=timed)
    make_song(tmp, T_RUN, lyrics={"state": "running", "started": now}, doc=timed)
    G_MAN = "a1" * 32
    make_song(tmp, G_MAN, lyrics=dict(done_rec, version=3), doc=doc)
    for song_id in (T_DONE, T_RUN, G_MAN, LOUD):               # elle zaman testleri 100 sn'lik sarkida
        status_path = pathlib.Path(tmp) / "songs" / song_id / "status.json"
        data = json.loads(status_path.read_text("utf-8"))
        data["duration"] = 100.0
        status_path.write_text(json.dumps(data), encoding="utf-8")
    check("manual auto modunda -> 400", post(G_MAN, {"mode": "auto", "manual": [{"i": 0, "t": 1}]}).status_code == 400)
    text3 = "bir\niki\nuc\ndort"
    for name, manual in (("satir sinir disi", [{"i": 4, "t": 1}]), ("zaman sure disi", [{"i": 0, "t": 999}]),
                         ("zamanlar azalan", [{"i": 0, "t": 20}, {"i": 1, "t": 10}]),
                         ("liste degil", {"i": 0, "t": 1}), ("ayni satir iki kez", [{"i": 1, "t": 5}, {"i": 1, "t": 6}])):
        check(f"manual gecersiz -> 400: {name}",
              post(G_MAN, {"mode": "pasted", "text": text3, "manual": manual}).status_code == 400)
    response = post(G_MAN, {"mode": "pasted", "language": "tr", "text": text3,
                            "manual": [{"i": 2, "t": 30.5}, {"i": 0, "t": 10}]})
    check("manual gecerli: 200 + running", response.status_code == 200 and response.json()["state"] == "running", response.text[:100])
    check("manual: sirali ve normalize edilmis spawn'a gider",
          spawner.calls[-1] == (G_MAN, "pasted", "tr", text3, [{"i": 0, "t": 10.0}, {"i": 2, "t": 30.5}]), str(spawner.calls[-1]))

    def times(song_id, payload, headers=H):
        return client.post(f"/songs/{song_id}/lyrics/times", json=payload, headers=headers)

    check("times auth yok -> 401", client.post(f"/songs/{T_DONE}/lyrics/times", json={}).status_code == 401)
    check("times govde JSON degil -> 400", client.post(f"/songs/{T_DONE}/lyrics/times", content=b"x", headers=H).status_code == 400)
    check("times soz yok -> 409", times(LOUD, {"set": [{"i": 0, "t": 1}]}).status_code == 409)
    check("times sozler hazirlanirken -> 409", times(T_RUN, {"set": [{"i": 0, "t": 1}]}).status_code == 409)
    check("times surum uyusmuyor -> 409", times(T_DONE, {"version": 1, "set": [{"i": 1, "t": 16}]}).status_code == 409)
    check("times gecersiz satir -> 400", times(T_DONE, {"set": [{"i": 7, "t": 16}]}).status_code == 400)
    check("times sira bozan zaman -> 400", times(T_DONE, {"set": [{"i": 1, "t": 21}]}).status_code == 400)
    check("times set yok -> 400", times(T_DONE, {}).status_code == 400)
    response = times(T_DONE, {"version": 100, "set": [{"i": 1, "t": 16.5}]})
    body = response.json()
    check("times gecerli: 200, yeni surum, degisen satir", response.status_code == 200 and body["version"] > 100
          and body["changed"] == [{"i": 1, "t": 16.5, "e": 19.5}], str(body))
    saved_doc = json.loads((pathlib.Path(tmp) / "songs" / T_DONE / "lyrics.json").read_text("utf-8"))
    check("times: dosya guncellendi (m=1, c kalkti, onceki satir kisaldi, surum)",
          saved_doc["lines"][1]["t"] == 16.5 and saved_doc["lines"][1]["m"] == 1 and "c" not in saved_doc["lines"][1]
          and saved_doc["lines"][0]["e"] <= 16.48 and saved_doc["version"] == body["version"])
    saved_status = read_status(tmp, T_DONE)
    check("times: status.lyrics surum, edited ve elle satir sayisi; ana alanlar ayni",
          saved_status["lyrics"]["version"] == body["version"] and saved_status["lyrics"]["edited"] is True
          and saved_status["lyrics"]["manual_lines"] == 1 and saved_status["lyrics"]["source"] == "pasted"
          and saved_status["stems_version"] == 7)
    got = client.get(f"/songs/{T_DONE}/lyrics", headers=H).json()
    check("GET: duzeltilen belge ve m isareti", got["lyrics"]["lines"][1]["m"] == 1 and got["version"] == body["version"])
    stale_version = times(T_DONE, {"version": 100, "set": [{"i": 2, "t": 22}]})
    check("times: eski surumle ikinci duzeltme 409", stale_version.status_code == 409)
    check("times: yeni surumle devam", times(T_DONE, {"version": body["version"], "set": [{"i": 2, "t": 22}]}).status_code == 200)

    shutil.rmtree(tmp, ignore_errors=True)
    print("\n" + "=" * 60)
    print(f"gecen: {len(PASSED)}   basarisiz: {len(FAILED)}")
    for name in FAILED:
        print(f"  BASARISIZ: {name}")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
