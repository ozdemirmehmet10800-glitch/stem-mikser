"""Soz cevirisi (Asama 14) API uclari: GERCEK handler'lar, sahte Modal. SENTETIK sozler (gercek soz yok).

test_export_api.py ile ayni yontem: `api()` FastAPI uygulamasi TestClient ile calisir; Volume ve `.spawn`
sahtelenir (Gemini cagrilmaz; gercek cikti canlida: tests/translate_live.py).
Kapsam: auth, dil kurallari (tr 400, en/ja serbest), eksik satir hesabi, `existing`, replace, spawn argumanlari,
calisirken tekrar, sozler calisirken/silme/yeniden isleme engelleri, GET hizalamasi (zaman/siralama degisse de ceviri
korunur, metin degisen satir null), 404, liste alanlari.

Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\test_translate_api.py
"""

import importlib.util
import json
import os
import pathlib
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSED, FAILED = [], []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


class FakeCall:
    object_id = "fc-tr-1"


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


def make_song(root, song_id, lang="en", lines=None, lyrics_state="done", translation=None, tr_status=None, state="done"):
    base = pathlib.Path(root) / "songs" / song_id
    base.mkdir(parents=True, exist_ok=True)
    status = {"id": song_id, "title": "Sentetik", "state": state, "duration": 100.0,
              "stems": ["drums", "bass", "other", "vocals", "guitar", "piano"], "stems_version": 7,
              "created_at": "2026-10-01T00:00:00Z"}
    if lyrics_state:
        status["lyrics"] = {"state": lyrics_state, "version": 5, "language": lang}
    if tr_status:
        status["translation"] = tr_status
    (base / "status.json").write_text(json.dumps(status), encoding="utf-8")
    if lines is not None:
        doc = {"schema": 1, "version": 5, "language": lang,
               "lines": [{"t": float(i * 3), "e": float(i * 3 + 2), "text": text, "w": []} for i, text in enumerate(lines)]}
        (base / "lyrics.json").write_text(json.dumps(doc), encoding="utf-8")
    if translation is not None:
        (base / "translation.json").write_text(json.dumps(translation), encoding="utf-8")
    return base


def main():
    os.environ["API_TOKEN"] = "test-token"
    os.environ["SIGNING_KEY"] = "test-key"
    os.environ["ALLOWED_ORIGINS"] = "http://localhost:8000"

    spec = importlib.util.spec_from_file_location("app_translate_api", ROOT / "backend" / "app.py")
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)

    from fastapi.testclient import TestClient

    tmp = tempfile.mkdtemp()
    app.DATA_DIR = tmp
    app.volume = FakeVolume()
    spawner = FakeSpawner()
    app.translate_lyrics = spawner
    other = FakeSpawner()
    app.extract_lyrics = other
    app.separate = other

    client = TestClient(app.api.get_raw_f()())
    H = {"Authorization": "Bearer test-token"}
    h = app._tr_hash

    EN, JA, TR, NOLYR, RUN, STALE, FULL, PART, UNK, BUSYLYR = ("a" * 64, "b" * 64, "c" * 64, "d" * 64, "e" * 64,
                                                               "f" * 64, "1" * 64, "2" * 64, "3" * 64, "4" * 64)
    lines = ["Line one", "Line two", "Line one", "Line three"]
    make_song(tmp, EN, "en", lines)
    make_song(tmp, JA, "ja", ["一行目", "二行目"])
    make_song(tmp, TR, "tr", ["Bir", "Iki"])
    make_song(tmp, NOLYR, "en", None, lyrics_state=None)
    make_song(tmp, RUN, "en", lines, tr_status={"state": "running", "started": int(time.time())})
    make_song(tmp, STALE, "en", lines, tr_status={"state": "running", "started": int(time.time()) - 99999})
    full = {"schema": 1, "lang": "en", "version": 9, "model": "m",
            "items": {h("Line one"): {"tr": "Bir"}, h("Line two"): {"tr": "Iki"}, h("Line three"): {"tr": "Uc"}}}
    make_song(tmp, FULL, "en", lines, translation=full, tr_status={"state": "done", "version": 9})
    part = {"schema": 1, "lang": "en", "version": 9, "items": {h("Line one"): {"tr": "Bir"}}}
    make_song(tmp, PART, "en", lines, translation=part, tr_status={"state": "done", "version": 9})
    make_song(tmp, UNK, "de", ["Eins"])
    make_song(tmp, BUSYLYR, "en", lines, lyrics_state="running")
    (pathlib.Path(tmp) / "songs" / BUSYLYR / "status.json").write_text(json.dumps({
        "id": BUSYLYR, "state": "done", "stems": ["vocals"], "lyrics": {"state": "running", "started": int(time.time())}}), encoding="utf-8")

    def post(song_id, payload=None, headers=H):
        return client.post(f"/songs/{song_id}/translate", json=payload if payload is not None else {}, headers=headers)

    # --- auth ve girdi
    check("POST auth yok -> 401", client.post(f"/songs/{EN}/translate").status_code == 401)
    check("GET auth yok -> 401", client.get(f"/songs/{EN}/translation").status_code == 401)
    check("olmayan sarki -> 404", post("9" * 64).status_code == 404)
    check("gecersiz kimlik -> 400", post("not-an-id").status_code == 400)
    check("sozler yok -> 409", post(NOLYR).status_code == 409)
    check("sozler hazirlaniyor -> 409", post(BUSYLYR).status_code == 409)
    r = post(TR)
    check("Turkce sozler -> 400 (cevrilmez)", r.status_code == 400 and "Turkce" in r.json()["detail"], r.text)
    check("desteklenmeyen dil -> 400", post(UNK).status_code == 400)
    check("hicbiri spawn etmedi", spawner.calls == [])

    # --- baslat
    r = post(EN)
    body = r.json()
    check("baslat: running, 3 benzersiz satir (tekrar bedava), dil", r.status_code == 200 and body["state"] == "running"
          and body["todo"] == 3 and body["lang"] == "en", str(body))
    check("spawn: (sarki, replace=False)", spawner.calls == [(EN, False)])
    status = json.loads((pathlib.Path(tmp) / "songs" / EN / "status.json").read_text("utf-8"))
    check("status.translation running yazildi", status["translation"]["state"] == "running" and status["translation"]["todo"] == 3)
    r = post(EN)
    check("calisirken tekrar: existing running, yeni spawn yok", r.json() == {"id": EN, "state": "running", "existing": True}
          and len(spawner.calls) == 1)
    r = post(JA)
    check("ja: baslar (okunus dahil), spawn", r.json()["state"] == "running" and spawner.calls[-1] == (JA, False))
    r = post(RUN)
    check("calisan sarki: existing running", r.json().get("existing") is True and len(spawner.calls) == 2)
    r = post(STALE)
    check("bayat running (>15 dk) yeniden baslatilir", r.json()["state"] == "running" and not r.json().get("existing") and len(spawner.calls) == 3)

    # --- eksik satirlar / existing / replace
    n = len(spawner.calls)
    r = post(FULL)
    check("hepsi cevrili: existing done, spawn yok", r.json() == {"id": FULL, "state": "done", "existing": True, "missing": 0} and len(spawner.calls) == n)
    r = post(FULL, {"replace": True})
    check("replace: bastan, spawn replace=True", r.json()["state"] == "running" and spawner.calls[-1] == (FULL, True))
    r = post(PART)
    check("kismi: yalniz eksik 2 satir (Line two, Line three)", r.json()["todo"] == 2 and spawner.calls[-1] == (PART, False), str(r.json()))

    # --- sozler / silme / yeniden isleme engelleri
    r = client.post(f"/songs/{RUN}/lyrics", json={"mode": "pasted", "text": "x\ny"}, headers=H)
    check("ceviri surerken sozler yeniden uretilemez -> 409", r.status_code == 409, r.text)
    r = client.delete(f"/songs/{RUN}", headers=H)
    check("ceviri surerken silinemez -> 409", r.status_code == 409, r.text)
    r = client.post(f"/songs/{RUN}/reprocess", headers=H)
    check("ceviri surerken yeniden islenemez -> 409", r.status_code == 409, r.text)
    r = client.post(f"/songs/{RUN}/lyrics/times", json={"set": [{"i": 0, "t": 1.0}]}, headers=H)
    check("zaman duzeltme ceviri surerken SERBEST (metin degismiyor)", r.status_code != 409 or "ceviri" not in r.text.lower(), r.text[:100])

    # --- GET
    r = client.get(f"/songs/{FULL}/translation", headers=H)
    body = r.json()
    check("GET: satirlara hizali, tekrar ayni, eksik yok", r.status_code == 200 and [x["tr"] for x in body["lines"]] == ["Bir", "Iki", "Bir", "Uc"]
          and body["missing"] == 0 and body["lang"] == "en" and body["version"] == 9 and body["has_reading"] is False, str(body))
    check("GET: Cache-Control no-cache", "must-revalidate" in r.headers.get("cache-control", ""))
    r = client.get(f"/songs/{PART}/translation", headers=H)
    body = r.json()
    check("GET kismi: eksik satirlar null, missing 2", [x and x["tr"] for x in body["lines"]] == ["Bir", None, "Bir", None] and body["missing"] == 2)
    # sozler duzenlendi (metin degisti) ve zamanlar degisti
    doc_path = pathlib.Path(tmp) / "songs" / FULL / "lyrics.json"
    doc = json.loads(doc_path.read_text("utf-8"))
    doc["lines"][1]["text"] = "Line two CHANGED"
    for line in doc["lines"]:
        line["t"] += 10.0
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    body = client.get(f"/songs/{FULL}/translation", headers=H).json()
    check("metni degisen satir null (cevrilmedi), zamani degisenler korunur", [x and x["tr"] for x in body["lines"]] == ["Bir", None, "Bir", "Uc"] and body["missing"] == 1)
    check("sozu olmayan/ceviri olmayan -> 404", client.get(f"/songs/{EN}/translation", headers=H).status_code == 404
          and client.get(f"/songs/{NOLYR}/translation", headers=H).status_code == 404)
    # hata durumu GET'te gorunur
    fail = make_song(tmp, "5" * 64, "en", lines, translation=full,
                     tr_status={"state": "error", "code": "busy", "message": "Çeviri servisi şu an meşgul, biraz sonra tekrar dene."})
    body = client.get(f"/songs/{'5' * 64}/translation", headers=H).json()
    check("GET: hata kodu ve mesaji", body["state"] == "error" and body["code"] == "busy" and "meşgul" in body["message"])
    body = client.get(f"/songs/{RUN}/translation", headers=H)
    check("calisirken (ceviri dosyasi yok) 404", body.status_code == 404)

    # --- liste
    listing = {item["id"]: item for item in client.get("/songs", headers=H).json()["songs"]}
    check("liste: translation_state / translation_version", listing[EN]["translation_state"] == "running"
          and listing["5" * 64]["translation_state"] == "error" and "translation_version" in listing[EN])

    print(f"\n{len(PASSED)} gecti, {len(FAILED)} basarisiz")
    raise SystemExit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
