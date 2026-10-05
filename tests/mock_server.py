"""Sahte API sunucusu - yalniz yerel gelistirme icin.

Amac: oynatici arayuzunu Modal'a hic dokunmadan, kredi harcamadan ve gercek
token'i hicbir yere girmeden test edebilmek. Indirilmis stem'leri (out/<sha>/)
gercek API ile ayni uclardan servis eder.

Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\mock_server.py
    (varsayilan: http://127.0.0.1:8001, token "mock-token")

Sonra ayri bir kabukta on yuzu servis edin:
    .\\.venv\\Scripts\\python.exe -m http.server 8000 --directory frontend

Tarayicida http://localhost:8000, ayarlara:
    adres  http://127.0.0.1:8001
    token  mock-token
"""

import argparse
import hashlib
import hmac
import json
import pathlib
import re
import urllib.parse
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "out"
TOKEN = "mock-token"
SIGNING_KEY = "mock-signing-key"
DOWNLOAD_TTL = 600

STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"]

# Sahte silme. out/ altindaki dosyalara DOKUNULMUYOR - onlar yerel test
# malzemesi, silinseler yeniden indirmek gerekirdi. Silinen kimlikler yalniz
# bellekte tutuluyor ve listeden duserek arayuzun silme akisini tam olarak
# yasatiyor. Sunucu yeniden baslayinca sarkilar geri geliyor.
DELETED = set()

# app.py'deki SONG_ID_RE ile ayni: 64 kucuk hex + istege bagli kisa deney eki.
SONG_ID_RE = re.compile(r"^[0-9a-f]{64}(-[a-z0-9]{1,12})?$")

# Modal'in SOGUK BASLANGICI taklidi: ilk istek bu kadar saniye gec cevaplanir,
# sonrakiler normal. On yuzun zaman asimi soguk baslangicta yanlis alarm
# veriyor mu, baska turlu olculemiyordu.
COLD_DELAY = 0.0
_warm = {"done": False}

# "Ayristirma yeni bitti" taklidi: bir sarki ilk N listelemede "separating"
# gorunur, sonra "done" olur. On yuzun biten sarkiyi yakalayip sesi ONDEN
# indirmeye baslamasi baska turlu denenemiyor.
PENDING_POLLS = 0
_pending = {"left": 0}
# Alt ayrim (Asama 10) taklidi: --sub-mode done|warn|unreliable|no_vocals|error,
# --sub-polls N: POST /sub sonrasi N durum sorgusu boyunca "running" kalir.
_sub = {"mode": "done", "polls": 0, "left": {}, "state": {}}

# Soz (Asama 11) taklidi: --lyrics-mode done|warn|no_vocals|error|no_lyrics,
# --lyrics-polls N: POST sonrasi N durum sorgusu boyunca "running" kalir,
# --lyrics-stale: sonuc "eski ayristirmadan" (parent_stems_version != stems_version).
# SENTETIK satirlar uretir (gercek soz yok): "Sentetik satir N" / Japonca "テスト行 N".
_lyrics = {"mode": "done", "polls": 0, "stale": False, "left": {}, "state": {}, "docs": {},
           "pending": {}}

# Miks disa aktarma (Asama 12) taklidi: --export-mode done|error|busy|notready,
# --export-polls N: POST sonrasi N durum sorgusu boyunca "running" kalir.
# Cikti SENTETIK: sarkinin vokal stem'i dosya olarak servis edilir (gercek miks DEGIL);
# arayuz testi istegin icerigini /__last_export ile okur.
_export = {"mode": "done", "polls": 0, "jobs": {}, "left": {}, "last": None, "log": []}
EXPORT_PARENT = {"lead": "vocals", "backing": "vocals", "kick": "drums", "snare": "drums",
                 "toms": "drums", "hihat": "drums", "cymbals": "drums"}

# Soz cevirisi (Asama 14) taklidi: --translate-mode done|busy|error|refused, --translate-polls N (POST sonrasi N durum
# sorgusu "running"), --lyrics-lang tr|en|ja (otomatik cikarmada dil). SENTETIK: "Ceviri: <metin>" / ja'da "romaji: <metin>".
# Metne gore tutulur (gercek sunucudaki hash gibi): yeniden yapistirilan sozde degisen satir "cevrilmedi" olur.
_translate = {"mode": "done", "polls": 0, "items": {}, "state": {}, "left": {}, "version": 0, "log": []}

# Stem servisini yavaslatma: telefondaki ~0.6-1.2 MB/sn'yi taklit etmek ve
# ilerleme/duraklatma davranisini gorebilmek icin.
STEM_DELAY = 0.0


def synthetic_lyrics(duration, language, source, lines_text=None, version=1, manual=None, low=()):
    """Gercek soz degil: esit aralikli yer tutucu satirlar, ortada bir ara muzik boslugu."""
    word = "テスト行" if language == "ja" else "Sentetik satir"
    texts = list(lines_text) if lines_text else [f"{word} {i + 1}" for i in range(24)]
    count = len(texts)
    span = max(duration - 12.0, 3.0 * count)
    step = span / count
    lines = []
    for i, text in enumerate(texts):
        start = 3.0 + i * step + (6.0 if i >= count // 2 else 0.0)   # ortada ~6 sn ara muzik
        end = start + min(step * 0.8, 6.0)
        parts = text.split()
        words = []
        for j, part in enumerate(parts):
            ws = start + (end - start) * j / max(len(parts), 1)
            we = start + (end - start) * (j + 1) / max(len(parts), 1)
            words.append([round(ws, 2), round(we, 2), part])
        line = {"t": round(start, 2), "e": round(end, 2), "text": text, "w": words}
        if i in low:
            line["c"] = 0
        if manual and i in manual:
            shift = manual[i] - line["t"]
            line.update(t=round(manual[i], 2), e=round(line["e"] + shift, 2), m=1)
            line.pop("c", None)
        lines.append(line)
    return {"schema": 1, "version": version, "source": source, "language": language,
            "duration": round(duration, 2), "lines": lines}


def cold_start_delay():
    if COLD_DELAY <= 0 or _warm["done"]:
        return 0.0
    _warm["done"] = True
    print(f"[soguk] ilk istek {COLD_DELAY} sn bekletiliyor")
    time.sleep(COLD_DELAY)
    return COLD_DELAY


def find_songs():
    """out/<sha>/ altindaki isi bitmis sarkilari bulur."""
    songs = []
    if not OUT_DIR.is_dir():
        return songs
    for entry in sorted(OUT_DIR.iterdir()):
        if entry.name in DELETED:
            continue          # sahte silme; dosyalar yerinde
        stems_dir = entry / "stems"
        if not stems_dir.is_dir():
            continue
        stems = sorted(p.stem for p in stems_dir.glob("*.m4a"))
        if not stems:
            continue
        status_path = entry / "status.json"
        status = {}
        if status_path.is_file():
            status = json.loads(status_path.read_text(encoding="utf-8"))
        chords_path = entry / "chords.json"
        chords = None
        if chords_path.is_file():
            chords = json.loads(chords_path.read_text(encoding="utf-8"))
        # Gercek API stems_version donduruyor (on yuz onbellek anahtarinda ve
        # "ayni sarkiya hizli donus" kapisinda kullaniyor). Indirilmis test
        # malzemesinde bu alan olmayabilir; stems klasorunun degisme zamanindan
        # KARARLI bir sayi uretiyoruz, yoksa hizli yol yerelde hic denenemezdi.
        status.setdefault("stems_version", int(stems_dir.stat().st_mtime))
        status.setdefault("id", entry.name)
        status.setdefault("title", entry.name[:12])
        status["state"] = "done"
        status["progress"] = 100
        for group, key in (("vocals", "sub"), ("drums", "sub_drums")):
            if (entry.name, group) in _sub["state"]:
                status[key] = _sub["state"][(entry.name, group)]
        if entry.name in _lyrics["state"]:
            status["lyrics"] = _lyrics["state"][entry.name]
        if entry.name in _translate["state"]:
            status["translation"] = _translate["state"][entry.name]
        status["stems"] = [s for s in STEM_ORDER if s in stems] + \
                          [s for s in stems if s not in STEM_ORDER]
        songs.append({"dir": entry, "status": status, "chords": chords})
    return songs


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # daha sessiz kayit
        print(f"  {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")

    # ---------------- yardimcilar ----------------

    def _cors(self):
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Range")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Expose-Headers",
                         "Content-Range, Accept-Ranges, Content-Length")

    def _send(self, code, body=b"", content_type="application/json", extra=None):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, payload, extra=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8", extra)

    def _authorized(self):
        cold_start_delay()
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer ") or not hmac.compare_digest(header[7:], TOKEN):
            self._json(401, {"detail": "Bearer token gerekli"})
            return False
        return True

    def _song(self, song_id):
        for song in find_songs():
            if song["status"]["id"] == song_id or song["dir"].name == song_id:
                return song
        return None

    # ---------------- yonlendirme ----------------

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        path = self.path.split("?")[0]
        query = dict(re.findall(r"([^?&=]+)=([^&]*)", self.path))

        match = re.fullmatch(r"/songs/([^/]+)/export", path)
        if match:
            if not self._authorized():
                return
            self._start_export(match.group(1))
            return

        match = re.fullmatch(r"/songs/([^/]+)/translate", path)
        if match:
            if not self._authorized():
                return
            self._start_translate(match.group(1))
            return

        match = re.fullmatch(r"/songs/([^/]+)/export/([0-9a-f]{32})/link", path)
        if match:
            if not self._authorized():
                return
            song_id, digest = match.groups()
            job = _export["jobs"].get(digest)
            if not job or job["state"] != "done":
                self._json(404, {"detail": "Disa aktarma yok ya da suresi doldu"})
                return
            expires = int(time.time()) + DOWNLOAD_TTL
            message = f"{song_id}|export{digest}|{job['format']}|{expires}".encode("utf-8")
            signature = hmac.new(SIGNING_KEY.encode(), message, hashlib.sha256).hexdigest()
            host = self.headers.get("Host", "127.0.0.1:8001")
            url = (f"http://{host}/songs/{song_id}/export-file/{digest}"
                   f"?format={job['format']}&exp={expires}&sig={signature}")
            self._json(200, {"url": url, "expires_at": expires, "ttl": DOWNLOAD_TTL,
                             "filename": job["filename"], "format": job["format"], "bytes": job["bytes"]})
            return

        match = re.fullmatch(r"/songs/([^/]+)/sub", path)
        if match:
            if not self._authorized():
                return
            song_id = match.group(1)
            group = query.get("group", "vocals")
            if group not in ("vocals", "drums"):
                self._json(400, {"detail": "Gecersiz grup"})
                return
            key = "sub" if group == "vocals" else "sub_drums"
            song = self._song(song_id)
            if not song:
                self._json(404, {"detail": "Sarki bulunamadi"})
                return
            current = song["status"].get(key) or {}
            if current.get("state") in ("done", "unreliable", "no_vocals", "no_drums"):
                self._json(200, {"id": song_id, "group": group, "state": current["state"], "existing": True})
                return
            mode = _sub["mode"]
            if mode == "no_vocals":     # gercek API'de bu kontrol CPU'da, aninda
                silent = "no_vocals" if group == "vocals" else "no_drums"
                _sub["state"][(song_id, group)] = {"state": silent, "rms_dbfs": -118.66}
                self._json(200, {"id": song_id, "group": group, "state": silent, "rms_dbfs": -118.66})
                return
            _sub["state"][(song_id, group)] = {"state": "running", "started": int(time.time())}
            _sub["left"][(song_id, group)] = _sub["polls"]
            self._json(200, {"id": song_id, "group": group, "state": "running"})
            return

        match = re.fullmatch(r"/songs/([^/]+)/lyrics/times", path)
        if match:
            if not self._authorized():
                return
            song_id = match.group(1)
            song = self._song(song_id)
            doc = _lyrics["docs"].get(song_id)
            lyr = (song or {}).get("status", {}).get("lyrics") or {}
            if not song or not doc or lyr.get("state") != "done":
                self._json(409, {"detail": "Duzeltilecek soz yok"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                self._json(400, {"detail": "Govde JSON olmali"})
                return
            if body.get("version") is not None and body["version"] != lyr.get("version"):
                self._json(409, {"detail": "Sozler baska bir yerden degismis; yenile"})
                return
            changed = []
            for item in sorted(body.get("set") or [], key=lambda it: it.get("i", 0)):
                i, t = item.get("i"), item.get("t")
                if not isinstance(i, int) or not 0 <= i < len(doc["lines"]) or not isinstance(t, (int, float)):
                    self._json(400, {"detail": "gecersiz satir ya da zaman"})
                    return
                lines_ = doc["lines"]
                if (i > 0 and t < lines_[i - 1]["t"] + 0.05) or (i + 1 < len(lines_) and t > lines_[i + 1]["t"] - 0.05):
                    self._json(400, {"detail": f"siralama bozuluyor (satir {i + 1})"})
                    return
                shift = t - lines_[i]["t"]
                lines_[i].update(t=round(t, 2), e=round(lines_[i]["e"] + shift, 2), m=1)
                lines_[i].pop("c", None)
                if i > 0 and lines_[i - 1]["e"] > t - 0.02:
                    lines_[i - 1]["e"] = round(max(lines_[i - 1]["t"] + 0.05, t - 0.02), 2)
                changed.append({"i": i, "t": lines_[i]["t"], "e": lines_[i]["e"]})
            version = int(lyr.get("version", 0)) + 1
            doc["version"] = version
            _lyrics["state"][song_id] = dict(lyr, version=version, edited=True)
            self._json(200, {"id": song_id, "version": version, "changed": changed})
            return

        match = re.fullmatch(r"/songs/([^/]+)/lyrics", path)
        if match:
            if not self._authorized():
                return
            song_id = match.group(1)
            song = self._song(song_id)
            if not song:
                self._json(404, {"detail": "Sarki bulunamadi"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                self._json(400, {"detail": "Govde JSON olmali"})
                return
            mode = (body or {}).get("mode", "auto")
            language = (body or {}).get("language", "auto")
            replace = (body or {}).get("replace") is True
            if mode not in ("auto", "pasted") or language not in ("auto", "tr", "en", "ja"):
                self._json(400, {"detail": "Gecersiz mod ya da dil"})
                return
            lines = []
            manual_raw = (body or {}).get("manual")
            if mode == "pasted":
                lines = [" ".join(x.split()) for x in str((body or {}).get("text") or "").splitlines()]
                lines = [x for x in lines if x]
                if not lines:
                    self._json(400, {"detail": "metin bos"})
                    return
            elif manual_raw is not None:
                self._json(400, {"detail": "manual yalniz pasted modunda"})
                return
            current = song["status"].get("lyrics") or {}
            if current.get("state") == "running":
                self._json(200, {"id": song_id, "state": "running", "existing": True})
                return
            if mode == "auto" and not replace and current.get("state") in ("done", "no_vocals", "no_lyrics"):
                self._json(200, {"id": song_id, "state": current["state"], "existing": True,
                                 "source": current.get("source")})
                return
            if _lyrics["mode"] == "no_vocals":
                _lyrics["state"][song_id] = {"state": "no_vocals", "rms_dbfs": -118.66}
                self._json(200, {"id": song_id, "state": "no_vocals", "rms_dbfs": -118.66})
                return
            previous = current if current.get("state") == "done" else None
            _lyrics["state"][song_id] = {"state": "running", "started": int(time.time()),
                                         "mode": mode, "language_requested": language,
                                         "previous": previous}
            _lyrics["left"][song_id] = _lyrics["polls"]
            _lyrics["pending"][song_id] = (mode, language, lines, {
                int(item["i"]): float(item["t"]) for item in (manual_raw or []) if isinstance(item, dict)})
            _lyrics.setdefault("log", []).append({"mode": mode, "manual": manual_raw or []})
            self._json(200, {"id": song_id, "state": "running", "mode": mode, "language": language})
            return

        if re.fullmatch(r"/songs/[^/]+/download-link", path):
            if not self._authorized():
                return
            song_id = path.split("/")[2]
            name = query.get("name", "vocals")
            fmt = query.get("format", "m4a")
            expires = int(time.time()) + DOWNLOAD_TTL
            message = f"{song_id}|{name}|{fmt}|{expires}".encode("utf-8")
            signature = hmac.new(SIGNING_KEY.encode(), message, hashlib.sha256).hexdigest()
            host = self.headers.get("Host", "127.0.0.1:8001")
            url = (f"http://{host}/songs/{song_id}/download/{name}"
                   f"?format={fmt}&exp={expires}&sig={signature}")
            self._json(200, {"url": url, "expires_at": expires, "ttl": DOWNLOAD_TTL})
            return

        if path == "/songs/delete":
            if not self._authorized():
                return
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                self._json(400, {"detail": "Govde JSON olmali"})
                return
            ids = body.get("ids") if isinstance(body, dict) else None
            if not isinstance(ids, list) or not ids:
                self._json(400, {"detail": "ids listesi gerekli"})
                return
            results = []
            for song_id in ids:
                if not SONG_ID_RE.match(str(song_id)):
                    results.append({"id": str(song_id)[:80], "outcome": "invalid",
                                    "detail": "Gecersiz sarki kimligi"})
                elif self._song(song_id):
                    DELETED.add(str(song_id))
                    results.append({"id": song_id, "outcome": "deleted"})
                else:
                    results.append({"id": song_id, "outcome": "not_found"})
            counts = {}
            for item in results:
                counts[item["outcome"]] = counts.get(item["outcome"], 0) + 1
            self._json(200, {"results": results, "counts": counts,
                             "deleted": counts.get("deleted", 0)})
            return

        if path == "/songs":
            if not self._authorized():
                return
            # Sahte sunucu gercekten islemiyor; var olan sarkiyi dondururuz.
            songs = find_songs()
            if songs:
                self._json(200, {"id": songs[0]["status"]["id"], "existing": True,
                                 "state": "done"})
            else:
                self._json(400, {"detail": "Sahte sunucuda islenmis sarki yok"})
            return

        self._json(404, {"detail": "yok"})

    def do_DELETE(self):
        path = self.path.split("?")[0]
        match = re.fullmatch(r"/songs/([^/]+)", path)
        if not match:
            self._json(404, {"detail": "yok"})
            return
        if not self._authorized():
            return
        song_id = match.group(1)
        if not SONG_ID_RE.match(song_id):
            self._json(400, {"detail": "Gecersiz sarki kimligi"})
            return
        if not self._song(song_id):
            self._json(200, {"id": song_id, "deleted": False,
                             "outcome": "not_found"})
            return
        DELETED.add(song_id)
        self._json(200, {"id": song_id, "deleted": True, "outcome": "deleted"})

    def do_GET(self):
        path = self.path.split("?")[0]
        query = dict(re.findall(r"([^?&=]+)=([^&]*)", self.path))

        if path == "/health":
            if not self._authorized():
                return
            self._json(200, {
                "ok": True,
                "allowed_origins": ["http://localhost:8000", "http://127.0.0.1:8000"],
                "reload_count": 0,
                "fastapi": "sahte-sunucu",
                "download_ttl": DOWNLOAD_TTL,
            })
            return

        if path == "/songs":
            if not self._authorized():
                return
            # Ilk sarki, --pending verildiyse birkac listelemede "isleniyor"
            # gorunsun; sonraki listelemede "done" olsun.
            pending_now = _pending["left"] > 0
            if pending_now:
                _pending["left"] -= 1
            songs = [
                {
                    "id": song["status"]["id"],
                    "title": song["status"].get("title"),
                    "state": ("separating" if (pending_now and index == 0)
                              else "done"),
                    "duration": song["status"].get("duration"),
                    "progress": 40 if (pending_now and index == 0) else 100,
                    "created_at": song["status"].get("created_at"),
                    "stems_version": song["status"].get("stems_version"),
                    "quality": song["status"].get("quality"),
                    "sub_state": (song["status"].get("sub") or {}).get("state"),
                    "sub_version": (song["status"].get("sub") or {}).get("version"),
                    "sub_drums_state": (song["status"].get("sub_drums") or {}).get("state"),
                    "sub_drums_version": (song["status"].get("sub_drums") or {}).get("version"),
                    "translation_state": (song["status"].get("translation") or {}).get("state"),
                    "translation_version": (song["status"].get("translation") or {}).get("version"),
                    "lyrics_state": (song["status"].get("lyrics") or {}).get("state"),
                    "lyrics_version": (song["status"].get("lyrics") or {}).get("version"),
                    "lyrics_source": (song["status"].get("lyrics") or {}).get("source"),
                    "lyrics_stale": (
                        (song["status"].get("lyrics") or {}).get("state") == "done"
                        and (song["status"].get("lyrics") or {}).get("parent_stems_version")
                        != song["status"].get("stems_version")),
                }
                for index, song in enumerate(find_songs())
            ]
            self._json(200, {"songs": songs})
            return

        match = re.fullmatch(r"/songs/([^/]+)/translation", path)
        if match:
            if not self._authorized():
                return
            song_id = match.group(1)
            song = self._song(song_id)
            doc = _lyrics["docs"].get(song_id)
            items = _translate["items"].get(song_id)
            if not song or not doc or not items:
                self._json(404, {"detail": "Ceviri yok"})
                return
            record = song["status"].get("translation") or {}
            lines = []
            for line in doc["lines"]:
                entry = items.get(" ".join(line["text"].lower().split()))
                lines.append(dict(entry) if entry else None)
            self._json(200, {"state": record.get("state"), "code": record.get("code"), "message": record.get("message"),
                             "lang": doc["language"], "version": record.get("version") or _translate["version"],
                             "model": "mock", "missing": sum(1 for x in lines if x is None),
                             "has_reading": doc["language"] == "ja", "lines": lines})
            return

        if path == "/__last_export":
            self._json(200, {"last": _export["last"], "log": _export["log"]})
            return

        match = re.fullmatch(r"/songs/([^/]+)/export/([0-9a-f]{32})", path)
        if match:
            if not self._authorized():
                return
            song_id, digest = match.groups()
            job = _export["jobs"].get(digest)
            if not job:
                self._json(404, {"detail": "Disa aktarma yok ya da suresi doldu"})
                return
            if job["state"] == "running":
                left = _export["left"].get(digest, 0)
                if left > 0:
                    _export["left"][digest] = left - 1
                elif _export["mode"] == "error":
                    job["state"] = "error"
                    job["message"] = "sahte hata"
                else:
                    job["state"] = "done"
            if job["state"] == "running":
                self._json(200, {"id": song_id, "hash": digest, "state": "running"})
            elif job["state"] == "error":
                self._json(200, {"id": song_id, "hash": digest, "state": "error", "message": job["message"]})
            else:
                self._json(200, {"id": song_id, "hash": digest, "state": "done", "filename": job["filename"],
                                 "format": job["format"], "bytes": job["bytes"], "duration": job["duration"]})
            return

        match = re.fullmatch(r"/songs/([^/]+)/export-file/([0-9a-f]{32})", path)
        if match:
            # Imzali indirme: token ISTEMEZ (gercek API ile ayni)
            song_id, digest = match.groups()
            fmt = query.get("format", "m4a")
            try:
                exp = int(query.get("exp", "0"))
            except ValueError:
                exp = 0
            message = f"{song_id}|export{digest}|{fmt}|{exp}".encode("utf-8")
            expected = hmac.new(SIGNING_KEY.encode(), message, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(query.get("sig", ""), expected):
                self._json(403, {"detail": "Imza gecersiz"})
                return
            job = _export["jobs"].get(digest)
            song = self._song(song_id)
            if not job or job["state"] != "done" or not song:
                self._json(404, {"detail": "Dosya bulunamadi"})
                return
            data = (song["dir"] / "stems" / "vocals.m4a").read_bytes()
            ascii_name = job["filename"].encode("ascii", "ignore").decode("ascii").strip() or "export"
            self._send(200, data, "audio/mp4" if fmt == "m4a" else "audio/wav", {
                "Content-Disposition": f'attachment; filename="{ascii_name}"'})
            return

        match = re.fullmatch(r"/songs/([^/]+)/lyrics", path)
        if match:
            if not self._authorized():
                return
            song_id = match.group(1)
            song = self._song(song_id)
            doc = _lyrics["docs"].get(song_id)
            if not song or not doc:
                self._json(404, {"detail": "Soz yok"})
                return
            lyr = song["status"].get("lyrics") or {}
            stale = (lyr.get("state") == "done"
                     and lyr.get("parent_stems_version") != song["status"].get("stems_version"))
            self._json(200, {"state": lyr.get("state"), "stale": stale, "source": lyr.get("source"),
                             "language": lyr.get("language"), "version": lyr.get("version"),
                             "warning": lyr.get("warning"), "lyrics": doc})
            return

        match = re.fullmatch(r"/songs/([^/]+)", path)
        if match:
            if not self._authorized():
                return
            song = self._song(match.group(1))
            if not song:
                self._json(404, {"detail": "Sarki bulunamadi"})
                return
            self._finish_lyrics(match.group(1), song)
            song = self._song(match.group(1)) or song
            self._finish_sub(match.group(1), song)
            self._finish_translate(match.group(1), song)
            song = self._song(match.group(1)) or song
            self._json(200, {"status": song["status"], "chords": song["chords"]})
            return

        match = re.fullmatch(
            r"/songs/([^/]+)/substems/(lead|backing|kick|snare|toms|hihat|cymbals)\.m4a", path)
        if match:
            if not self._authorized():
                return
            source = "vocals.m4a" if match.group(2) in ("lead", "backing") else "drums.m4a"
            self._serve_file(match.group(1), "stems", source, "audio/mp4", ranges=True)
            return

        match = re.fullmatch(r"/songs/([^/]+)/stems/([^/]+)\.m4a", path)
        if match:
            if not self._authorized():
                return
            self._serve_file(match.group(1), "stems", match.group(2) + ".m4a",
                             "audio/mp4", ranges=True)
            return

        match = re.fullmatch(r"/songs/([^/]+)/download/([^/]+)", path)
        if match:
            # Imzali indirme: token ISTEMEZ (gercek API ile ayni davranis)
            song_id, name = match.group(1), match.group(2)
            fmt = query.get("format", "m4a")
            try:
                exp = int(query.get("exp", "0"))
            except ValueError:
                exp = 0
            message = f"{song_id}|{name}|{fmt}|{exp}".encode("utf-8")
            expected = hmac.new(SIGNING_KEY.encode(), message, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(query.get("sig", ""), expected):
                self._json(403, {"detail": "Imza gecersiz"})
                return
            if exp < int(time.time()):
                self._json(403, {"detail": "Link suresi gecmis"})
                return
            song = self._song(song_id)
            title = (song["status"].get("title") if song else None) or song_id[:12]
            bad = set('<>:"/|?*') | {"\\"}
            cleaned = " ".join(
                "".join(" " if c in bad else c for c in title).split()
            )[:80] or "sarki"
            filename = f"{cleaned} - {name}.{fmt}"
            ascii_name = filename.encode("ascii", "ignore").decode("ascii").strip()
            if not ascii_name or ascii_name.startswith("."):
                ascii_name = f"stem.{fmt}"
            quoted = urllib.parse.quote(filename, safe="")
            disposition = (
                'attachment; filename="' + ascii_name + '"; '
                + "filename*=UTF-8''" + quoted
            )
            self._serve_file(song_id, "stems", name + ".m4a", "audio/mp4",
                             extra={"Content-Disposition": disposition})
            return

        self._json(404, {"detail": "yok"})

    # ---------------- dosya servisi ----------------

    def _finish_lyrics(self, song_id, song):
        """Calisan sahte soz isini, bekleme sorgulari bitince sonuclandirir."""
        lyr = song["status"].get("lyrics") or {}
        if lyr.get("state") != "running":
            return
        left = _lyrics["left"].get(song_id, 0)
        if left > 0:
            _lyrics["left"][song_id] = left - 1
            return
        mode, language, lines, manual = _lyrics["pending"].get(song_id, ("auto", "auto", [], {}))
        previous = lyr.get("previous")
        if _lyrics["mode"] == "error":
            _lyrics["state"][song_id] = (
                dict(previous, last_attempt={"state": "error", "message": "sahte hata"})
                if previous else {"state": "error", "message": "sahte hata"})
            return
        if _lyrics["mode"] == "no_lyrics" and mode == "auto":
            _lyrics["state"][song_id] = (
                dict(previous, last_attempt={"state": "no_lyrics", "message": "sonuc yok"})
                if previous else {"state": "no_lyrics", "message": "sonuc yok"})
            return
        lang = language if language != "auto" else _lyrics.get("auto_lang", "tr")
        version = int(time.time() * 1000) % 10**9
        duration = float(song["status"].get("duration") or 120.0)
        # yapistir-hizala taklidi: 3. ve 4. satir "eslesmedi" (dusuk guven); elle satirlar capa
        low = (2, 3) if mode == "pasted" and len(lines) > 5 else ()
        _lyrics["docs"][song_id] = synthetic_lyrics(duration, lang, mode, lines or None, version, manual, low)
        stems_version = song["status"].get("stems_version")
        parent = (int(stems_version) - 1) if (_lyrics["stale"] and stems_version) else stems_version
        warning = "text_mismatch" if (_lyrics["mode"] == "warn" and mode == "pasted") else None
        _lyrics["state"][song_id] = {
            "state": "done", "source": mode, "language": lang, "language_requested": language,
            "version": version, "lines": len(_lyrics["docs"][song_id]["lines"]),
            "warning": warning, "parent_stems_version": parent,
        }
        if mode == "pasted":
            _lyrics["state"][song_id]["match"] = {
                "method": "anchored", "match_ratio": 0.8, "anchor_lines": max(len(lines) - len(low), 0),
                "manual_lines": len(manual), "low_confidence_lines": list(low),
                "gaps": [[round(duration * 0.5, 1), round(duration * 0.5 + 18, 1), 24]]}

    def _start_export(self, song_id):
        song = self._song(song_id)
        if not song:
            self._json(404, {"detail": "Sarki bulunamadi"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._json(400, {"detail": "Govde JSON olmali"})
            return
        if not isinstance(body, dict):
            self._json(400, {"detail": "Govde JSON nesnesi olmali"})
            return
        status = song["status"]
        _export["log"].append(body)
        _export["last"] = body
        if _export["mode"] == "notready":
            self._json(409, {"detail": "Sarki henuz hazir degil"})
            return
        fmt = body.get("format", "m4a")
        if fmt not in ("m4a", "wav"):
            self._json(400, {"detail": "format m4a/wav olmali"})
            return
        gains = body.get("gains")
        if not isinstance(gains, dict) or not gains:
            self._json(400, {"detail": "gains (kanal -> kazanc) gerekli"})
            return
        ready = set(status.get("stems") or [])
        for group, key in (("vocals", "sub"), ("drums", "sub_drums")):
            if ((_sub["state"].get((song_id, group)) or status.get(key) or {}).get("state")) == "done":
                ready.update(n for n, p in EXPORT_PARENT.items() if p == group)
        for name, value in gains.items():
            if name not in ready:
                self._json(400, {"detail": f"Bilinmeyen ya da kullanilamayan kanal: {name[:30]}"})
                return
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 2:
                self._json(400, {"detail": f"kazanc ({name}) 0..2 araliginda olmali"})
                return
            parent = EXPORT_PARENT.get(name)
            if parent and gains.get(parent):
                self._json(400, {"detail": f"{parent} ile alt parcasi ({name}) birlikte karistirilamaz"})
                return
        if not any(value > 0 for value in gains.values()):
            self._json(400, {"detail": "Hicbir kanal duyulmuyor"})
            return
        canon = json.dumps({**body, "sv": status.get("stems_version")}, sort_keys=True,
                           separators=(",", ":"), ensure_ascii=False)
        digest = hashlib.sha256(canon.encode("utf-8")).hexdigest()[:32]
        job = _export["jobs"].get(digest)
        if job and job["state"] == "done":
            self._json(200, {"id": song_id, "hash": digest, "state": "done", "existing": True,
                             "filename": job["filename"], "bytes": job["bytes"], "duration": job["duration"]})
            return
        if any(j["state"] == "running" and h != digest for h, j in _export["jobs"].items()) \
                or _export["mode"] == "busy":
            self._json(409, {"detail": "Baska bir disa aktarma suruyor"})
            return
        region = body.get("region")
        duration = float(status.get("duration") or 120.0)
        rate = float(body.get("rate") or 1.0)
        if region:
            duration = float(region["b"]) - float(region["a"])
        bad = set('<>:"/|?*') | {"\\"}
        title = " ".join("".join(" " if c in bad else c for c in (status.get("title") or song_id[:12])).split())[:80]
        tail = " - ".join([body.get("label") or "Miks"]
                          + ([f"{rate:g}x"] if rate != 1.0 else [])
                          + ([f"{int(body['semitones']):+d}"] if body.get("semitones") else [])
                          + (["dongu"] if region else []))
        filename = f"{title} - {tail}.{fmt}"
        size = (song["dir"] / "stems" / "vocals.m4a").stat().st_size
        _export["jobs"][digest] = {"state": "running", "format": fmt, "filename": filename,
                                   "bytes": size, "duration": round(duration / rate, 2)}
        _export["left"][digest] = _export["polls"]
        self._json(200, {"id": song_id, "hash": digest, "state": "running", "format": fmt})

    def _start_translate(self, song_id):
        song = self._song(song_id)
        if not song:
            self._json(404, {"detail": "Sarki bulunamadi"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            body = {}
        doc = _lyrics["docs"].get(song_id)
        lyr = song["status"].get("lyrics") or {}
        if lyr.get("state") != "done" or not doc:
            self._json(409, {"detail": "Once sozler gerekli"})
            return
        if doc["language"] == "tr":
            self._json(400, {"detail": "Turkce sozler cevrilmez"})
            return
        if doc["language"] not in ("en", "ja"):
            self._json(400, {"detail": "Bu dildeki sozler cevrilemez"})
            return
        current = song["status"].get("translation") or {}
        if current.get("state") == "running":
            self._json(200, {"id": song_id, "state": "running", "existing": True})
            return
        items = {} if body.get("replace") is True else _translate["items"].get(song_id, {})
        todo = [l for l in doc["lines"] if " ".join(l["text"].lower().split()) not in items]
        _translate["log"].append({"song": song_id, "todo": len(todo), "replace": body.get("replace") is True})
        if not todo and body.get("replace") is not True:
            self._json(200, {"id": song_id, "state": "done", "existing": True, "missing": 0})
            return
        _translate["state"][song_id] = {"state": "running", "started": int(time.time()), "lang": doc["language"], "todo": len(todo),
                                        "version": current.get("version")}
        _translate["left"][song_id] = _translate["polls"]
        self._json(200, {"id": song_id, "state": "running", "lang": doc["language"], "todo": len(todo)})

    def _finish_translate(self, song_id, song):
        record = song["status"].get("translation") or {}
        if record.get("state") != "running":
            return
        left = _translate["left"].get(song_id, 0)
        if left > 0:
            _translate["left"][song_id] = left - 1
            return
        mode = _translate["mode"]
        if mode in ("busy", "error", "refused"):
            code = {"busy": "busy", "error": "error", "refused": "refused"}[mode]
            message = {"busy": "Çeviri servisi şu an meşgul, biraz sonra tekrar dene.", "error": "sahte hata",
                       "refused": "Model bu şarkıyı çevirmeyi reddetti."}[mode]
            _translate["state"][song_id] = {"state": "error", "code": code, "message": message}
            return
        doc = _lyrics["docs"][song_id]
        items = _translate["items"].setdefault(song_id, {})
        for line in doc["lines"]:
            key = " ".join(line["text"].lower().split())
            if key not in items or record.get("todo") is None:
                entry = {"tr": f"Çeviri: {line['text']}"}
                if doc["language"] == "ja":
                    entry["ro"] = f"romaji: {line['text']}"
                items[key] = entry
        _translate["version"] += 1
        _translate["state"][song_id] = {"state": "done", "lang": doc["language"], "version": _translate["version"],
                                        "lines": len(doc["lines"]), "missing": 0}

    def _finish_sub(self, song_id, song):
        """Calisan sahte alt ayrimlari, bekleme sorgulari bitince sonuclandirir."""
        for group, key in (("vocals", "sub"), ("drums", "sub_drums")):
            sub = song["status"].get(key) or {}
            if sub.get("state") != "running":
                continue
            left = _sub["left"].get((song_id, group), 0)
            if left > 0:
                _sub["left"][(song_id, group)] = left - 1
                continue
            mode = _sub["mode"]
            parts = {"vocals": ["lead", "backing"],
                     "drums": ["kick", "snare", "toms", "hihat", "cymbals"]}[group]
            base = {"version": int(time.time()), "lead_share": 0.9, "parts": {group: parts}}
            if mode == "error":
                new = {"state": "error", "error": "sahte hata"}
            elif mode == "unreliable" and group == "vocals":
                new = {"state": "unreliable", "lead_share": 0.02}
            elif mode == "warn":
                new = {**base, "state": "done", "reliability": "warn"}
            else:
                new = {**base, "state": "done", "reliability": "ok"}
            _sub["state"][(song_id, group)] = new

    def _serve_file(self, song_id, folder, filename, media, ranges=False, extra=None):
        song = self._song(song_id)
        if not song:
            self._json(404, {"detail": "Sarki bulunamadi"})
            return
        path = song["dir"] / folder / filename
        if not path.is_file():
            self._json(404, {"detail": f"{filename} yok"})
            return

        if STEM_DELAY and folder == "stems":
            time.sleep(STEM_DELAY)
        data = path.read_bytes()
        size = len(data)
        header = self.headers.get("Range", "")
        if ranges and header.lower().startswith("bytes="):
            spec = header.split("=", 1)[1].split(",")[0].strip()
            start_text, _, end_text = spec.partition("-")
            try:
                if not start_text:
                    start = max(size - int(end_text), 0)
                    end = size - 1
                else:
                    start = int(start_text)
                    end = int(end_text) if end_text else size - 1
            except ValueError:
                start, end = 0, size - 1
            if start >= size:
                self._send(416, b"", media, {"Content-Range": f"bytes */{size}"})
                return
            end = min(end, size - 1)
            self._send(206, data[start:end + 1], media, {
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Accept-Ranges": "bytes",
            })
            return

        headers = {"Accept-Ranges": "bytes"}
        headers.update(extra or {})
        self._send(200, data, media, headers)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--cold", type=float, default=0.0,
                        help="ilk istegi bu kadar saniye beklet (soguk baslangic taklidi)")
    parser.add_argument("--pending", type=int, default=0,
                        help="ilk sarki bu kadar listelemede 'isleniyor' gorunsun")
    parser.add_argument("--sub-mode", default="done",
                        choices=["done", "warn", "unreliable", "no_vocals", "error"],
                        help="POST /sub sonucu (Asama 10 taklidi)")
    parser.add_argument("--sub-polls", type=int, default=0,
                        help="POST /sub sonrasi kac durum sorgusu 'running' kalsin")
    parser.add_argument("--lyrics-mode", default="done",
                        choices=["done", "warn", "no_vocals", "error", "no_lyrics"],
                        help="POST /lyrics sonucu (Asama 11 taklidi)")
    parser.add_argument("--lyrics-polls", type=int, default=0,
                        help="POST /lyrics sonrasi kac durum sorgusu 'running' kalsin")
    parser.add_argument("--lyrics-stale", action="store_true",
                        help="sonuc 'eski ayristirmadan' (parent_stems_version farkli)")
    parser.add_argument("--export-mode", default="done",
                        choices=["done", "error", "busy", "notready"],
                        help="POST /export sonucu (Asama 12 taklidi)")
    parser.add_argument("--export-polls", type=int, default=0,
                        help="POST /export sonrasi kac durum sorgusu 'running' kalsin")
    parser.add_argument("--translate-mode", default="done", choices=["done", "busy", "error", "refused"],
                        help="POST /translate sonucu (Asama 14 taklidi)")
    parser.add_argument("--translate-polls", type=int, default=0,
                        help="POST /translate sonrasi kac durum sorgusu 'running' kalsin")
    parser.add_argument("--lyrics-lang", default="tr", choices=["tr", "en", "ja"],
                        help="otomatik soz cikarmada dil (cevirinin denenebilmesi icin)")
    parser.add_argument("--stem-delay", type=float, default=0.0,
                        help="her stem istegini bu kadar saniye beklet (yavas ag taklidi)")
    args = parser.parse_args()

    global COLD_DELAY
    _sub["mode"] = args.sub_mode
    _sub["polls"] = args.sub_polls
    _lyrics["mode"] = args.lyrics_mode
    _lyrics["polls"] = args.lyrics_polls
    _lyrics["stale"] = args.lyrics_stale
    _lyrics["auto_lang"] = args.lyrics_lang
    _translate["mode"] = args.translate_mode
    _translate["polls"] = args.translate_polls
    _export["mode"] = args.export_mode
    _export["polls"] = args.export_polls
    COLD_DELAY = args.cold
    _pending["left"] = args.pending
    global STEM_DELAY
    STEM_DELAY = args.stem_delay
    if COLD_DELAY:
        print(f"Soguk baslangic taklidi: ilk istek {COLD_DELAY} sn gec")

    songs = find_songs()
    print(f"Sahte API: http://{args.host}:{args.port}")
    print(f"Token    : {TOKEN}")
    print(f"Sarki    : {len(songs)} adet")
    for song in songs:
        chords = song["chords"]
        print(f"  - {song['status'].get('title')}  "
              f"({len(song['status']['stems'])} stem, "
              f"{len(chords['chords']) if chords else 0} akor)")
    if not songs:
        print("  UYARI: out/<sha>/stems altinda m4a bulunamadi.")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nkapatiliyor")


if __name__ == "__main__":
    main()
