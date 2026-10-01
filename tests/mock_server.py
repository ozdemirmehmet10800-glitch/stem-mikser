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

# Stem servisini yavaslatma: telefondaki ~0.6-1.2 MB/sn'yi taklit etmek ve
# ilerleme/duraklatma davranisini gorebilmek icin.
STEM_DELAY = 0.0


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

        match = re.fullmatch(r"/songs/([^/]+)/sub", path)
        if match:
            # Sahte alt ayrim (Asama 10): vokal m4a'si hem lead hem backing olarak
            # servis edilir; durum "done" doner. Gercek API'de state running/
            # no_vocals/unreliable da olabilir.
            if not self._authorized():
                return
            song = self._song(match.group(1))
            if not song:
                self._json(404, {"detail": "Sarki bulunamadi"})
                return
            song["status"]["sub"] = {"state": "done", "version": int(time.time()),
                                      "reliability": "ok", "lead_share": 0.9,
                                      "parts": {"vocals": ["lead", "backing"]}}
            self._json(200, {"id": match.group(1), "state": "done", "existing": False})
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
                }
                for index, song in enumerate(find_songs())
            ]
            self._json(200, {"songs": songs})
            return

        match = re.fullmatch(r"/songs/([^/]+)", path)
        if match:
            if not self._authorized():
                return
            song = self._song(match.group(1))
            if not song:
                self._json(404, {"detail": "Sarki bulunamadi"})
                return
            self._json(200, {"status": song["status"], "chords": song["chords"]})
            return

        match = re.fullmatch(r"/songs/([^/]+)/substems/(lead|backing)\.m4a", path)
        if match:
            if not self._authorized():
                return
            self._serve_file(match.group(1), "stems", "vocals.m4a", "audio/mp4",
                             ranges=True)
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
    parser.add_argument("--stem-delay", type=float, default=0.0,
                        help="her stem istegini bu kadar saniye beklet (yavas ag taklidi)")
    args = parser.parse_args()

    global COLD_DELAY
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
